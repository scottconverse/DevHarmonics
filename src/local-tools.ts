import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InvocationRequest, InvocationResult, RuntimeAdapter } from "./runtime.js";

export interface LocalToolAuthorization {
  outcome: "allow" | "deny" | "require_approval";
  reason: string;
  lockKeys: readonly string[];
}

export interface LocalToolExecution {
  requestId: string;
  toolId: "file.read" | "file.search" | "file.patch";
  targetPaths: string[];
  result: Readonly<Record<string, unknown>>;
}

interface LocalToolRequest {
  id: string;
  toolId: LocalToolExecution["toolId"];
  arguments: Record<string, unknown>;
}

const ignoredDirectories = new Set([".git", ".devharmonics", "node_modules", "dist", "build", ".next"]);

export async function runLocalToolLoop(input: {
  adapter: RuntimeAdapter;
  request: InvocationRequest;
  worktreePath: string;
  repositoryScope: readonly string[];
  authorize: (request: { toolId: LocalToolRequest["toolId"]; targetPaths: string[]; arguments: Readonly<Record<string, unknown>> }) => LocalToolAuthorization;
  maxSteps?: number;
  /** Aborts the loop between steps and the model call within a step. */
  signal?: AbortSignal | undefined;
}): Promise<InvocationResult & { toolExecutions: LocalToolExecution[] }> {
  const maxSteps = Math.max(1, Math.min(input.maxSteps ?? 12, 24));
  const executions: LocalToolExecution[] = [];
  let transcript = `${input.request.prompt}\n\n${toolProtocol(input.repositoryScope)}`;
  let lastResult: InvocationResult | null = null;
  for (let step = 1; step <= maxSteps; step++) {
    input.signal?.throwIfAborted();
    const result = await input.adapter.invoke({ ...input.request, permission: "read_only", prompt: transcript }, input.signal ? { signal: input.signal } : undefined);
    lastResult = result;
    const envelope = parseEnvelope(result.text);
    if (typeof envelope.final === "string" && envelope.final.trim()) {
      if (Array.isArray(envelope.toolRequests) && envelope.toolRequests.length) throw new Error("Local tool response cannot contain final text and tool requests together");
      return { ...result, text: envelope.final.trim(), stdout: envelope.final.trim(), toolRequests: [], toolExecutions: executions };
    }
    if (!Array.isArray(envelope.toolRequests) || envelope.toolRequests.length === 0 || envelope.toolRequests.length > 4) {
      throw new Error("Local model must return one to four typed tool requests or a non-empty final response");
    }
    const stepResults: Array<{ id: string; toolId: string; result: Readonly<Record<string, unknown>> }> = [];
    for (const rawRequest of envelope.toolRequests) {
      const request = normalizeRequest(rawRequest);
      const targetPaths = toolTargetPaths(request);
      for (const targetPath of targetPaths) await assertScopedPath(input.worktreePath, input.repositoryScope, targetPath, request.toolId === "file.patch");
      const authorization = input.authorize({ toolId: request.toolId, targetPaths, arguments: request.arguments });
      if (authorization.outcome !== "allow") throw new Error(`${request.toolId} ${authorization.outcome.replace("_", " ")}: ${authorization.reason}`);
      const toolResult = await executeTool(input.worktreePath, input.repositoryScope, request);
      const execution = { requestId: request.id, toolId: request.toolId, targetPaths, result: toolResult } satisfies LocalToolExecution;
      executions.push(execution);
      stepResults.push({ id: request.id, toolId: request.toolId, result: toolResult });
    }
    transcript = `${transcript}\n\nTOOL RESULTS FOR STEP ${step}:\n${JSON.stringify(stepResults)}\n\nContinue using only the protocol. Do not repeat a completed write. Return final when the assigned task is complete.`;
    if (transcript.length > 120_000) transcript = `${input.request.prompt}\n\n${toolProtocol(input.repositoryScope)}\n\nRECENT TOOL RESULTS:\n${JSON.stringify(stepResults)}`;
  }
  throw new Error(`Local model did not complete within ${maxSteps} bounded tool steps${lastResult ? `; last response: ${lastResult.text.slice(0, 240)}` : ""}`);
}

function toolProtocol(scope: readonly string[]): string {
  return `You do not have direct filesystem or shell access. DevHarmonics may execute only these typed tools inside the isolated worktree and repository scope ${JSON.stringify(scope)}:
- file.read {"path":"relative/path"}
- file.search {"query":"literal text","path":"optional relative directory"}
- file.patch {"path":"relative/path","expectedSha256":"hash from file.read, or null only for a new file","content":"complete replacement content"}
Return exactly one JSON object and no markdown. To request tools: {"toolRequests":[{"id":"unique-id","toolId":"file.read|file.search|file.patch","arguments":{...}}]}. When complete: {"final":"concise evidence-backed completion report"}. No shell, Git, network, process, install, delete, rename, or external-write tool exists.`;
}

function parseEnvelope(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error("Local model returned no JSON tool envelope");
  try {
    const value = JSON.parse(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Local model returned an invalid JSON tool envelope: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeRequest(value: unknown): LocalToolRequest {
  if (!value || typeof value !== "object") throw new Error("Local tool request must be an object");
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || !request.id.trim()) throw new Error("Local tool request requires a non-empty id");
  if (!(["file.read", "file.search", "file.patch"] as const).includes(request.toolId as LocalToolRequest["toolId"])) throw new Error(`Local tool '${String(request.toolId)}' is not registered`);
  if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) throw new Error("Local tool request requires an arguments object");
  return { id: request.id, toolId: request.toolId as LocalToolRequest["toolId"], arguments: request.arguments as Record<string, unknown> };
}

function requiredRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("File tool requires a non-empty relative path");
  if (path.isAbsolute(value)) throw new Error("File tool paths must be relative to the assigned worktree");
  return value.replaceAll("\\", "/");
}

function toolTargetPaths(request: LocalToolRequest): string[] {
  if (request.toolId === "file.search") return [requiredRelativePath(request.arguments.path ?? ".")];
  return [requiredRelativePath(request.arguments.path)];
}

async function assertScopedPath(worktreePath: string, scopes: readonly string[], relativePath: string, allowNew: boolean): Promise<void> {
  const root = path.resolve(worktreePath);
  const target = path.resolve(root, relativePath);
  if (!isWithin(root, target)) throw new Error(`Path '${relativePath}' is outside the assigned worktree`);
  const normalizedTarget = path.relative(root, target).replaceAll("\\", "/") || ".";
  const allowed = scopes.some((scope) => {
    const normalizedScope = path.normalize(scope || ".").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    return normalizedScope === "." || normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
  });
  if (!allowed) throw new Error(`Path '${relativePath}' is outside repository scope ${JSON.stringify(scopes)}`);
  const realRoot = await realpath(root);
  try {
    const realTarget = await realpath(target);
    if (!isWithin(realRoot, realTarget)) throw new Error(`Path '${relativePath}' resolves outside the assigned worktree`);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;
    if (!allowNew || code !== "ENOENT") throw error;
    const realParent = await realpath(path.dirname(target));
    if (!isWithin(realRoot, realParent)) throw new Error(`Path '${relativePath}' resolves outside the assigned worktree`);
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function executeTool(worktreePath: string, scopes: readonly string[], request: LocalToolRequest): Promise<Readonly<Record<string, unknown>>> {
  if (request.toolId === "file.read") {
    const relativePath = requiredRelativePath(request.arguments.path);
    const content = await readFile(path.resolve(worktreePath, relativePath), "utf8");
    if (Buffer.byteLength(content, "utf8") > 256_000) throw new Error(`file.read '${relativePath}' exceeds the 256 KB bounded read limit`);
    return { path: relativePath, content, sha256: createHash("sha256").update(content).digest("hex") };
  }
  if (request.toolId === "file.search") {
    const query = typeof request.arguments.query === "string" ? request.arguments.query : "";
    if (!query || query.length > 500) throw new Error("file.search requires a literal query of 1 to 500 characters");
    const searchRoot = requiredRelativePath(request.arguments.path ?? ".");
    const matches: Array<{ path: string; line: number; text: string }> = [];
    await searchDirectory(path.resolve(worktreePath, searchRoot), worktreePath, query, matches);
    return { query, path: searchRoot, matches, truncated: matches.length >= 100 };
  }
  const relativePath = requiredRelativePath(request.arguments.path);
  const content = typeof request.arguments.content === "string" ? request.arguments.content : null;
  if (content === null) throw new Error("file.patch requires complete replacement content");
  if (Buffer.byteLength(content, "utf8") > 1_000_000) throw new Error("file.patch content exceeds the 1 MB write limit");
  const target = path.resolve(worktreePath, relativePath);
  let existing: string | null = null;
  try { existing = await readFile(target, "utf8"); } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;
    if (code !== "ENOENT") throw error;
  }
  const expected = request.arguments.expectedSha256;
  if (existing === null && expected !== null) throw new Error(`file.patch '${relativePath}' is new and requires expectedSha256 null`);
  if (existing !== null) {
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`file.patch '${relativePath}' requires the sha256 returned by file.read`);
    const actual = createHash("sha256").update(existing).digest("hex");
    if (actual !== expected.toLowerCase()) throw new Error(`file.patch '${relativePath}' rejected a stale expectedSha256`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return { path: relativePath, previousSha256: existing === null ? null : createHash("sha256").update(existing).digest("hex"), sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content, "utf8") };
}

async function searchDirectory(directory: string, worktreePath: string, query: string, matches: Array<{ path: string; line: number; text: string }>): Promise<void> {
  if (matches.length >= 100) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (matches.length >= 100) return;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await searchDirectory(absolute, worktreePath, query, matches);
      continue;
    }
    if (!entry.isFile()) continue;
    const details = await stat(absolute);
    if (details.size > 256_000) continue;
    let content: string;
    try { content = await readFile(absolute, "utf8"); } catch { continue; }
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.includes(query)) matches.push({ path: path.relative(worktreePath, absolute).replaceAll("\\", "/"), line: index + 1, text: line.slice(0, 500) });
      if (matches.length >= 100) return;
    }
  }
}
