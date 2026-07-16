import { domainId } from "./domain.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLocalToolLoop } from "./local-tools.js";
import { VERSION } from "./product.js";
import { inferModelProfile, profileMetadata } from "./model-intelligence.js";
import type { ConnectionRegistryInput, ModelDiscoveryInput } from "./registry.js";
import type { OllamaRuntimeConfig } from "./types.js";
import {
  RuntimeInvocationError,
  type InvocationOptions,
  type InvocationRequest,
  type InvocationResult,
  type ProviderConnection,
  type RuntimeAdapter,
  type RuntimeMetadata,
} from "./runtime.js";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

interface OllamaRegistryWriter {
  upsertConnection(input: ConnectionRegistryInput): void;
  upsertDiscoveredModel(input: ModelDiscoveryInput): void;
  reconcileDiscoveredModels?(connectionId: string, source: "runtime_discovery", currentModelIds: readonly string[], retirementThreshold?: number): void;
}

interface OllamaTag {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: Record<string, unknown>;
  capabilities?: string[];
}

export interface OllamaDiscovery {
  available: boolean;
  version: string | null;
  baseUrl: string;
  models: OllamaTag[];
  error: string | null;
}

export async function discoverOllama(baseUrl = DEFAULT_OLLAMA_URL): Promise<OllamaDiscovery> {
  const normalized = normalizeLocalUrl(baseUrl);
  try {
    const signal = AbortSignal.timeout(3_000);
    const [versionResponse, tagsResponse] = await Promise.all([
      fetch(`${normalized}/api/version`, { signal }),
      fetch(`${normalized}/api/tags`, { signal }),
    ]);
    if (!versionResponse.ok || !tagsResponse.ok) {
      throw new Error(`Ollama returned HTTP ${!versionResponse.ok ? versionResponse.status : tagsResponse.status}`);
    }
    const version = await versionResponse.json() as { version?: string };
    const tags = await tagsResponse.json() as { models?: OllamaTag[] };
    const models = await Promise.all((tags.models ?? []).filter((model) => Boolean(model.name)).map(async (model) => {
      try {
        const response = await fetch(`${normalized}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.name }),
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return model;
        const details = await response.json() as { capabilities?: unknown };
        return {
          ...model,
          capabilities: Array.isArray(details.capabilities)
            ? details.capabilities.filter((item): item is string => typeof item === "string")
            : [],
        };
      } catch {
        return model;
      }
    }));
    return {
      available: true,
      version: version.version ?? null,
      baseUrl: normalized,
      models,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      baseUrl: normalized,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncOllamaRegistry(
  writer: OllamaRegistryWriter,
  baseUrl = DEFAULT_OLLAMA_URL,
): Promise<OllamaDiscovery> {
  return syncOneOllamaRuntime(writer, { id: "system", displayName: "Ollama", baseUrl, enabled: true });
}

export async function syncOllamaRuntimes(
  writer: OllamaRegistryWriter,
  runtimes: readonly OllamaRuntimeConfig[],
): Promise<OllamaDiscovery[]> {
  return Promise.all(runtimes.filter((runtime) => runtime.enabled).map((runtime) => syncOneOllamaRuntime(writer, runtime)));
}

async function syncOneOllamaRuntime(writer: OllamaRegistryWriter, runtime: OllamaRuntimeConfig): Promise<OllamaDiscovery> {
  const discovery = await discoverOllama(runtime.baseUrl);
  const connectionId = ollamaConnectionId(runtime.id);
  writer.upsertConnection({
    id: connectionId,
    provider: "ollama",
    transport: "local",
    authentication: "local_none",
    displayName: runtime.displayName,
    enabled: runtime.enabled,
    installed: discovery.available,
    authenticated: discovery.available,
    visible: discovery.available,
    healthy: discovery.available,
    available: discovery.available && discovery.models.length > 0,
    entitlement: "local",
    capacity: discovery.available ? "unmeasured" : "unavailable",
    adapterVersion: VERSION,
    runtimeVersion: discovery.version,
    metadata: {
      baseUrl: discovery.baseUrl,
      runtimeId: runtime.id,
      summary: discovery.available
        ? `${discovery.models.length} installed local model${discovery.models.length === 1 ? "" : "s"}`
        : "Ollama is not reachable",
      error: discovery.error,
      remoteAccessAllowed: false,
    },
  });
  for (const model of discovery.models) {
    const metadata = {
      model: model.model ?? model.name,
      digest: model.digest ?? null,
      sizeBytes: model.size ?? null,
      modifiedAt: model.modified_at ?? null,
      details: model.details ?? {},
      capabilities: model.capabilities ?? [],
      runtimeId: runtime.id,
      baseUrl: discovery.baseUrl,
    };
    const profile = inferModelProfile({ canonicalName: model.name, displayName: model.name, metadata }, { provider: "ollama", transport: "local" });
    writer.upsertDiscoveredModel({
      id: ollamaModelId(runtime.id, model.name),
      connectionId,
      canonicalName: model.name,
      displayName: model.name,
      source: "runtime_discovery",
      lifecycle: "visible",
      visible: true,
      verified: false,
      qualified: false,
      active: false,
      metadata: { ...metadata, ...profileMetadata(profile) },
    });
  }
  writer.reconcileDiscoveredModels?.(connectionId, "runtime_discovery", discovery.models.map((model) => ollamaModelId(runtime.id, model.name)), 3);
  return discovery;
}

export class OllamaAdapter implements RuntimeAdapter {
  readonly connection: ProviderConnection;

  constructor(
    private readonly baseUrl = DEFAULT_OLLAMA_URL,
    connectionId = "local:ollama",
    displayName = "Ollama",
  ) {
    this.connection = {
      id: domainId("ProviderConnection", connectionId),
      provider: "ollama",
      displayName,
      transport: "local",
      authentication: "local_none",
      capabilities: {
        structuredOutput: true,
        streaming: false,
        providerManagedTools: false,
        modelSelection: true,
        modelSettings: ["temperature", "num_ctx", "num_predict"],
        permissions: ["read_only"],
      },
    };
  }

  async metadata(): Promise<RuntimeMetadata> {
    const discovery = await discoverOllama(this.baseUrl);
    return { adapterVersion: VERSION, runtimeVersion: discovery.version };
  }

  async invoke(request: InvocationRequest, options: InvocationOptions = {}): Promise<InvocationResult> {
    if (request.permission !== "read_only") {
      throw new RuntimeInvocationError("Ollama write access requires the local tool policy engine", "incompatible", this.connection.id, 0, false);
    }
    if (!request.model.requestedModelId) {
      throw new RuntimeInvocationError("Ollama requires an explicit installed model", "incompatible", this.connection.id, 0, false);
    }
    const requested = String(request.model.requestedModelId);
    const model = request.model.alias ?? (requested.startsWith("ollama:") ? requested.slice("ollama:".length) : requested);
    const timeout = request.timeoutMs ?? 10 * 60_000;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const startedAt = Date.now();
    options.onEvent?.({ type: "started", connectionId: this.connection.id, at: new Date().toISOString() });
    let response: Response;
    try {
      response = await fetch(`${normalizeLocalUrl(this.baseUrl)}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: request.prompt }],
          options: request.model.settings,
        }),
      });
    } catch (error) {
      const cancelled = options.signal?.aborted ?? false;
      throw new RuntimeInvocationError(
        cancelled ? "Ollama invocation was cancelled" : `Ollama could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        cancelled ? "cancelled" : "process_failed",
        this.connection.id,
        -1,
        !cancelled,
      );
    }
    const raw = await response.text();
    if (!response.ok) {
      throw new RuntimeInvocationError(`Ollama returned HTTP ${response.status}: ${raw}`, response.status === 404 ? "incompatible" : "process_failed", this.connection.id, response.status, response.status !== 404);
    }
    const value = JSON.parse(raw) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = value.message?.content?.trim() ?? "";
    if (!text) throw new RuntimeInvocationError("Ollama returned no assistant content", "incompatible", this.connection.id, 0, false);
    const durationMs = Date.now() - startedAt;
    options.onEvent?.({ type: "stdout", text, at: new Date().toISOString() });
    options.onEvent?.({ type: "completed", exitCode: 0, durationMs, at: new Date().toISOString() });
    const metadata = await this.metadata();
    return {
      connectionId: this.connection.id,
      provider: "ollama",
      ...metadata,
      model: {
        ...request.model,
        requestedModelId: domainId("Model", requested),
        resolvedModelId: domainId("Model", requested),
        resolution: "concrete",
      },
      text,
      stdout: text,
      stderr: "",
      exitCode: 0,
      durationMs,
      usage: {
        inputTokens: value.prompt_eval_count ?? null,
        outputTokens: value.eval_count ?? null,
        costUsd: 0,
      },
      toolRequests: [],
    };
  }
}

export async function qualifyOllamaModel(
  modelId: string,
  cwd: string,
  baseUrl = DEFAULT_OLLAMA_URL,
  connectionId = "local:ollama",
  modelName?: string,
) {
  const adapter = new OllamaAdapter(baseUrl, connectionId);
  const result = await adapter.invoke({
    role: "worker",
    prompt: "DevHarmonics qualification fixture local-analysis-v1. Reply with exactly DEVHARMONICS_QUALIFIED and no other text. Do not use tools and do not modify files.",
    cwd,
    permission: "read_only",
    timeoutMs: 2 * 60_000,
    model: { requestedModelId: domainId("Model", modelId), alias: modelName ?? null, settings: { temperature: 0, num_predict: 16 } },
  });
  const passed = result.text.trim() === "DEVHARMONICS_QUALIFIED";
  return {
    fixtureVersion: "local-analysis-v1",
    role: "analysis",
    passed,
    score: passed ? 1 : 0,
    evidence: {
      resolvedModelId: result.model.resolvedModelId,
      durationMs: result.durationMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      outputTokensPerSecond: result.usage.outputTokens && result.durationMs
        ? Number((result.usage.outputTokens / (result.durationMs / 1_000)).toFixed(2))
        : null,
      responseMatched: passed,
    },
  };
}

export async function qualifyOllamaSpecialistModel(
  modelId: string,
  cwd: string,
  baseUrl = DEFAULT_OLLAMA_URL,
  connectionId = "local:ollama",
  modelName?: string,
) {
  const adapter = new OllamaAdapter(baseUrl, connectionId);
  const result = await adapter.invoke({
    role: "worker",
    prompt: [
      "DevHarmonics local specialist qualification local-specialist-v2.",
      "A proposed design has two legs and requires two M4 holes per leg.",
      "The complete design must fit inside a 40 mm bounding box, but the proposed legs are 60 mm long.",
      "Reply with only one JSON object having exactly these keys and types:",
      "valid: boolean indicating whether every stated constraint can be satisfied;",
      "reason: string formatted as '<larger dimension> exceeds <bounding dimension>';",
      "holeCount: integer giving the total number of required holes across all legs.",
      "Derive every value from the scenario. Do not copy an example answer because none is provided.",
      "Do not use tools and do not modify files.",
    ].join(" "),
    cwd,
    permission: "read_only",
    timeoutMs: 2 * 60_000,
    model: { requestedModelId: domainId("Model", modelId), alias: modelName ?? null, settings: { temperature: 0, num_predict: 128 } },
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(result.text.trim()) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const structuredOutput = parsed !== null && Object.keys(parsed).sort().join(",") === "holeCount,reason,valid";
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim().toLowerCase().replace(/\s+/g, " ") : "";
  const contradictionDetected = parsed?.valid === false && /^60(?:\s*mm)?\s+exceeds\s+40(?:\s*mm)?[.!]?$/.test(reason);
  const featureCountMatched = parsed?.holeCount === 4;
  const passed = structuredOutput && contradictionDetected && featureCountMatched;
  return {
    fixtureVersion: "local-specialist-v2",
    role: "benchmark" as const,
    passed,
    score: passed ? 1 : 0,
    evidence: {
      resolvedModelId: result.model.resolvedModelId,
      durationMs: result.durationMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      structuredOutput,
      contradictionDetected,
      featureCountMatched,
    },
  };
}

export async function qualifyOllamaToolModel(
  modelId: string,
  baseUrl = DEFAULT_OLLAMA_URL,
  connectionId = "local:ollama",
  modelName?: string,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-tool-qualification-"));
  const fixturePath = path.join(root, "fixture.txt");
  const initial = "DEVHARMONICS_LOCAL_TOOL_BEFORE\n";
  const expected = "DEVHARMONICS_LOCAL_TOOL_AFTER\n";
  await writeFile(fixturePath, initial, "utf8");
  const adapter = new OllamaAdapter(baseUrl, connectionId);
  try {
    const result = await runLocalToolLoop({
      adapter,
      request: {
        role: "worker",
        prompt: "DevHarmonics bounded local-tool qualification v1. Read fixture.txt, replace its complete content with exactly DEVHARMONICS_LOCAL_TOOL_AFTER followed by one newline using file.patch and the observed sha256, then return final. Use no other file.",
        cwd: root,
        permission: "workspace_write",
        timeoutMs: 2 * 60_000,
        model: { requestedModelId: domainId("Model", modelId), alias: modelName ?? null, settings: { temperature: 0, num_predict: 512 } },
      },
      worktreePath: root,
      repositoryScope: ["fixture.txt"],
      maxSteps: 6,
      authorize: (request) => ({ outcome: ["file.read", "file.patch"].includes(request.toolId) ? "allow" : "deny", reason: "bounded qualification fixture", lockKeys: request.targetPaths }),
    });
    const finalContent = await readFile(fixturePath, "utf8");
    const passed = finalContent === expected && result.toolExecutions.some((execution) => execution.toolId === "file.read") && result.toolExecutions.some((execution) => execution.toolId === "file.patch");
    return {
      fixtureVersion: "local-tools-v1",
      role: "local_tools" as const,
      passed,
      score: passed ? 1 : 0,
      evidence: { resolvedModelId: result.model.resolvedModelId, toolSequence: result.toolExecutions.map((execution) => execution.toolId), finalContentMatched: finalContent === expected, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: 0 },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function ollamaConnectionId(runtimeId: string): string {
  return runtimeId === "system" ? "local:ollama" : `local:ollama:${runtimeId}`;
}

export function ollamaModelId(runtimeId: string, modelName: string): string {
  return runtimeId === "system" ? `ollama:${modelName}` : `ollama:${runtimeId}:${modelName}`;
}

function normalizeLocalUrl(value: string): string {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Remote Ollama endpoints require an explicit future policy and are disabled");
  }
  return url.origin;
}
