import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolvePathCommand } from "./path-resolve.mjs";
import { superviseProcess } from "./supervise.mjs";
import { workerEnv } from "./worker-env.mjs";
import { createReceipt, writeReceipt } from "./receipts.mjs";

/**
 * The HTTP lane's WRITE mode (spec §2.2, lane "http") for local models that
 * cannot do agentic tool use: the model only ever sees file text and returns
 * file text. It never picks a path or a command — every path the model can
 * possibly write to was already enumerated by the task, and the check that
 * decides pass/fail was already chosen by the task, not the model. This
 * module is the one place that turns that constrained round-trip into a real
 * git commit, and it does the whole thing inside an ISOLATED worktree so a
 * confused or hostile local model can never touch the caller's own checkout.
 *
 * Same fail-closed / every-attempt-leaves-a-receipt rule as run-worker.mjs.
 * The one deliberate exception: malformed task INPUT (bad taskId, a
 * traversal path, an absolute check.command, ...) throws synchronously
 * before anything is created — there is no worktree yet and no valid
 * receipt can be built without, at minimum, a valid taskId, so recording
 * "an attempt" would be recording something that never actually started.
 * Everything from worktree creation onward always ends in a receipt.
 */

// Duplicated from receipts.mjs on purpose: that module does not export its
// pattern, and this file is scoped to touch only scripts/local-patch.mjs and
// test/local-patch.test.mjs. Keep this in sync if receipts.mjs ever changes
// its pattern.
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MAX_READ_BYTES = 200_000;

function isAbsolutePath(value) {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function fail(message) {
  throw new Error(`runLocalPatch: ${message}`);
}

function assertRelativeRepoPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  if (isAbsolutePath(value) || /^[a-zA-Z]:/.test(value) || value.startsWith("\\\\") || value.startsWith("//")) {
    fail(`${label} must be a relative repo path, not an absolute/drive/UNC path: "${value}"`);
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    fail(`${label} must not contain "." or ".." traversal segments: "${value}"`);
  }
  if (segments.some((segment) => segment.length === 0)) {
    fail(`${label} must not contain empty path segments: "${value}"`);
  }
}

function assertNonEmptyPathArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  value.forEach((entry, index) => assertRelativeRepoPath(entry, `${label}[${index}]`));
}

function assertCommandSpec(command) {
  if (typeof command !== "string" || command.length === 0) {
    fail("check.command must be a non-empty string");
  }
  const isBareName = !command.includes("/") && !command.includes("\\");
  if (!isBareName && !isAbsolutePath(command)) {
    fail(`check.command must be a bare executable name or an absolute path, not: "${command}"`);
  }
}

function assertCommitMessage(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("commitMessage must be a non-empty, non-whitespace-only string");
  }
  if (/[\r\n]/.test(value)) {
    fail("commitMessage must be a single line (no newlines)");
  }
}

function assertGitRoot(repository) {
  if (typeof repository !== "string" || repository.length === 0 || !existsSync(repository)) {
    fail(`repository must be an existing directory: "${repository}"`);
  }
  const probe = spawnSync("git", ["-C", repository, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") {
    fail(`repository is not a git root: "${repository}"`);
  }
}

/**
 * Fail-closed precondition check for every field the model is never allowed
 * to influence: taskId shape, the repository itself, which paths exist to
 * read/write, and what command decides success. Throws (does not return a
 * receipt) on the first violation — see the file-level comment for why.
 */
function validateTask(task) {
  if (!task || typeof task !== "object") fail("task must be an object");
  if (!TASK_ID_PATTERN.test(task.taskId ?? "")) fail(`taskId must match ${TASK_ID_PATTERN}, got: ${JSON.stringify(task.taskId)}`);
  assertGitRoot(task.repository);
  assertNonEmptyPathArray(task.readPaths, "readPaths");
  assertNonEmptyPathArray(task.writePaths, "writePaths");
  if (!task.check || typeof task.check !== "object") fail("check must be an object");
  assertCommandSpec(task.check.command);
  if (task.check.args !== undefined && !Array.isArray(task.check.args)) fail("check.args must be an array when present");
  assertCommitMessage(task.commitMessage);
  if (typeof task.model !== "string" || task.model.length === 0) fail("model must be a non-empty string");
  if (typeof task.instructions !== "string" || task.instructions.length === 0) fail("instructions must be a non-empty string");
}

/**
 * Local models routinely wrap strict-JSON output in a fenced code block
 * despite being told not to. Tolerate it rather than fail every run on a
 * cosmetic formatting habit; `stripped !== raw.trim()` upstream records
 * that this happened instead of hiding it.
 */
function stripFences(text) {
  const trimmed = (text ?? "").trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

/**
 * Path comparison for "did the model write somewhere it wasn't told to".
 * Windows filesystems are case-insensitive, so a model that returns
 * "File.txt" against a declared "file.txt" is writing the SAME file there,
 * not a new one — reject only a genuinely different path. Elsewhere
 * (POSIX) case is significant and a case change is a different file.
 */
function pathsEqual(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveCheckCommand(command, env) {
  if (isAbsolutePath(command)) {
    return existsSync(command) ? command : null;
  }
  return resolvePathCommand(command, { env });
}

/**
 * String validation (assertRelativeRepoPath) proves a path LOOKS contained; it
 * cannot prove the real filesystem target is. A git-committed symlink (mode
 * 120000) is a legitimate repo object whose target may point anywhere, and
 * both readFileSync and writeFileSync follow it transparently — the read side
 * leaked outside content into the model prompt, the write side overwrote an
 * arbitrary host file while the receipt reported "empty diff / nothing
 * changed" (GAUNTLET-2026-08-05 B-2, both reproduced live). Resolve the real
 * location: realpath the deepest existing prefix (collapsing every symlink,
 * including an intermediate directory symlink) then re-append any not-yet-
 * created tail, and require the result to stay inside the worktree.
 */
function realPathInsideWorktree(worktreeReal, abs) {
  // lstat, NOT existsSync: existsSync FOLLOWS symlinks, so a committed symlink
  // whose target does not resolve (dangling, or a not-yet-created file in an
  // existing outside dir) reads as "absent" and is silently skipped — the walk
  // then lands on the worktree root and wrongly passes, and writeFileSync
  // follows the link OUTSIDE the worktree while the receipt reports "empty
  // diff" (GAUNTLET B-2, round 2 — reproduced: an out-of-repo file was created).
  // lstat sees the link ENTRY itself, so the walk stops at it and realpathSync
  // below throws on the broken target, failing closed.
  const entryExists = (p) => {
    try { lstatSync(p); return true; } catch { return false; }
  };
  let existing = abs;
  const tail = [];
  while (!entryExists(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realExisting;
  try {
    realExisting = realpathSync(existing);
  } catch {
    return false;
  }
  const finalReal = tail.length ? path.join(realExisting, ...tail) : realExisting;
  const rel = path.relative(worktreeReal, finalReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function runLocalPatch({ task, client, runsRoot, env = process.env }) {
  validateTask(task);

  const receiptId = randomUUID();
  const startedAt = new Date().toISOString();
  // Mirror run-worker.mjs: compute the run directory ourselves so an
  // artifact (diff.patch) can be written into it before the receipt is
  // written last-and-only, instead of racing writeReceipt's own mkdir.
  const stamp = startedAt.replaceAll(":", "-").replace(/\.\d+/, "");
  const runDir = path.join(runsRoot, `${stamp}-${receiptId}`);
  mkdirSync(runDir, { recursive: true });

  const base = task.base ?? "HEAD";
  const maxOutputTokens = task.maxOutputTokens ?? 4096;
  const timeoutMs = task.timeoutMs ?? 300_000;

  let worktreePath = null;
  let worktreeParent = null;
  let promptFull = null;

  const finish = ({ status, accepted, headCommit = null, detail, usage = null, resolvedModel = null }) => {
    const finishedAt = new Date().toISOString();
    const receipt = createReceipt({
      receiptId,
      taskId: task.taskId,
      lane: "http",
      provider: "local-patch",
      requestedModel: task.model,
      resolvedModel,
      // Never trust a requested model string as proof of what ran — only
      // true when the injected client itself reported a resolved identity.
      resolutionVerified: resolvedModel != null,
      endpoint: task.baseUrl ?? null,
      args: { checkCommand: task.check.command, checkArgs: task.check.args ?? [] },
      prompt: promptFull,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      status,
      usage,
      artifactPath: status === "completed" ? path.join(runDir, "diff.patch") : null,
    });
    writeReceipt(runsRoot, receipt);
    return { receipt, runDir, accepted, headCommit, worktreePath, detail };
  };

  // Step 2: isolated worktree. Never the caller's own checkout.
  const branch = `devharmonics/patch/${task.taskId}-${randomUUID().split("-")[0]}`;
  worktreeParent = mkdtempSync(path.join(os.tmpdir(), "dh-patch-"));
  const candidateWorktreePath = path.join(worktreeParent, "wt");
  const worktreeAdd = spawnSync(
    "git",
    ["-C", task.repository, "worktree", "add", "-b", branch, candidateWorktreePath, base],
    { encoding: "utf8" },
  );
  if (worktreeAdd.status !== 0 || worktreeAdd.error) {
    rmSync(worktreeParent, { recursive: true, force: true });
    return finish({
      status: "failed",
      accepted: false,
      detail: {
        message: "failed to create isolated worktree",
        stderr: (worktreeAdd.stderr ?? "").trim(),
        error: worktreeAdd.error ? String(worktreeAdd.error) : null,
      },
    });
  }
  worktreePath = candidateWorktreePath;
  // Canonical worktree root, resolved once, for the symlink-containment check
  // below (B-2). realpath here so the comparison is real-path vs real-path.
  const worktreeReal = realpathSync(worktreePath);

  // Only worth keeping a worktree around once real file content has been
  // written and staged into it (steps 6+) — before that, on any failure,
  // there is nothing to inspect and no reason to leave litter behind.
  const removeWorktree = () => {
    const removed = spawnSync("git", ["-C", task.repository, "worktree", "remove", "--force", worktreePath], { encoding: "utf8" });
    if (removed.status !== 0) {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* already gone — fine */ }
    }
    try { rmSync(worktreeParent, { recursive: true, force: true }); } catch { /* already gone — fine */ }
    worktreePath = null;
  };

  // Step 3: build the prompt from the WORKTREE's current file contents,
  // never the caller's live checkout — the model must only ever see what
  // it is actually patching.
  const system = 'Return ONLY a JSON object {"files":[{"path":"<one of the write paths>","content":"complete new file text"}]} — no markdown fences, no commentary.';
  const readSections = [];
  for (const readPath of task.readPaths) {
    const abs = path.join(worktreePath, readPath);
    // B-2: refuse a path whose real target escapes the worktree (a committed
    // symlink), BEFORE readFileSync would transparently follow it outside.
    if (!realPathInsideWorktree(worktreeReal, abs)) {
      removeWorktree();
      return finish({ status: "failed", accepted: false, detail: { message: `readPath escapes the worktree via a symlink or link: "${readPath}"` } });
    }
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      removeWorktree();
      return finish({ status: "failed", accepted: false, detail: { message: `readPath not found in worktree: "${readPath}"` } });
    }
    if (stat.size > MAX_READ_BYTES) {
      removeWorktree();
      return finish({
        status: "failed",
        accepted: false,
        detail: { message: `readPath exceeds ${MAX_READ_BYTES} byte limit: "${readPath}" (${stat.size} bytes)` },
      });
    }
    readSections.push(`--- ${readPath} ---\n${readFileSync(abs, "utf8")}`);
  }
  const userText = `${task.instructions}\n\n${readSections.join("\n\n")}`;
  promptFull = `${system}\n\n${userText}`;

  // Step 4: call the client (injected — never a real network call from here).
  let response;
  try {
    response = await client({
      baseUrl: task.baseUrl,
      model: task.model,
      system,
      messages: [{ role: "user", content: userText }],
      maxTokens: maxOutputTokens,
      timeoutMs,
      // Paid lane: threaded when the endpoint carries a credential; unset for
      // key-less local servers (the default), which stay unpaid and unmetered.
      apiKeyEnvVar: task.apiKeyEnvVar ?? null,
      paidBudget: task.paidBudget,
      env,
    });
  } catch (error) {
    removeWorktree();
    return finish({ status: "failed", accepted: false, detail: { message: `client threw: ${error.message}` } });
  }
  if (!response?.ok) {
    removeWorktree();
    return finish({
      status: "failed",
      accepted: false,
      detail: { message: "client reported failure", error: response?.error ?? null },
      usage: response?.usage ?? null,
      resolvedModel: response?.resolvedModel ?? null,
    });
  }

  // Step 5: parse and validate the model's JSON response. Every rejection
  // here is honest about which contract clause failed, never a bare throw.
  const parseNotes = [];
  const rawText = response.contentText ?? "";
  const stripped = stripFences(rawText);
  if (stripped !== rawText.trim()) parseNotes.push("stripped a fenced code block from the model response");

  let parsedBody;
  try {
    parsedBody = JSON.parse(stripped);
  } catch (error) {
    removeWorktree();
    return finish({
      status: "failed",
      accepted: false,
      detail: { message: `model response was not valid JSON: ${error.message}`, parseNotes },
      usage: response.usage ?? null,
      resolvedModel: response.resolvedModel ?? null,
    });
  }
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody) || !Array.isArray(parsedBody.files)) {
    removeWorktree();
    return finish({
      status: "failed",
      accepted: false,
      detail: { message: 'model response JSON must be an object with a "files" array', parseNotes },
      usage: response.usage ?? null,
      resolvedModel: response.resolvedModel ?? null,
    });
  }

  const writtenFiles = [];
  for (const [index, entry] of parsedBody.files.entries()) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.content !== "string") {
      removeWorktree();
      return finish({
        status: "failed",
        accepted: false,
        detail: { message: `files[${index}] must be {path: string, content: string}`, parseNotes },
        usage: response.usage ?? null,
        resolvedModel: response.resolvedModel ?? null,
      });
    }
    // found-bug guard: the model is never trusted to name a path outside
    // what the task already declared writable — this is the one place that
    // enforces it, matching "the model never picks paths or commands".
    const target = task.writePaths.find((candidate) => pathsEqual(candidate, entry.path));
    if (!target) {
      removeWorktree();
      return finish({
        status: "failed",
        accepted: false,
        detail: { message: `model returned a path not in writePaths: "${entry.path}"`, parseNotes },
        usage: response.usage ?? null,
        resolvedModel: response.resolvedModel ?? null,
      });
    }
    writtenFiles.push({ target, content: entry.content });
  }

  // Step 6: write the files and require a real, nonempty diff. A model
  // that echoes the file back unchanged is not a fix — the empty-diff
  // false-green rule from receipts.mjs's own house style.
  for (const { target, content } of writtenFiles) {
    const abs = path.join(worktreePath, target);
    // B-2: refuse a writePath whose real target escapes the worktree (a
    // committed symlink) BEFORE writeFileSync follows it and overwrites an
    // arbitrary out-of-repo host file — the escape the receipt then reported
    // as "empty diff / nothing changed".
    if (!realPathInsideWorktree(worktreeReal, abs)) {
      removeWorktree();
      return finish({
        status: "failed",
        accepted: false,
        detail: { message: `writePath escapes the worktree via a symlink or link: "${target}"`, parseNotes },
      });
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const addRes = spawnSync("git", ["-C", worktreePath, "add", "-A"], { encoding: "utf8" });
  if (addRes.status !== 0) {
    removeWorktree();
    return finish({
      status: "failed",
      accepted: false,
      detail: { message: `git add failed: ${(addRes.stderr ?? "").trim()}`, parseNotes },
    });
  }
  const diffStat = spawnSync("git", ["-C", worktreePath, "diff", "--cached", "--stat"], { encoding: "utf8" });
  if (!diffStat.stdout.trim()) {
    // Nothing to inspect in an unchanged worktree — remove it rather than leak
    // a temp dir on every empty-diff failure (the re-accumulating dh-* dirs).
    removeWorktree();
    return finish({
      status: "failed",
      accepted: false,
      detail: { message: "model returned unchanged content (empty diff)", parseNotes },
    });
  }
  // Captured before commit — "git diff --cached" is empty once committed.
  const diffFull = spawnSync("git", ["-C", worktreePath, "diff", "--cached"], { encoding: "utf8" });

  // Step 7: run the declared check inside the worktree. The command and its
  // args come only from the task, never the model.
  //
  // C-2 (GAUNTLET-2026-08-05): the check executes INSIDE the worktree the
  // untrusted model just wrote to, so it must not inherit the operator's
  // credentials — one planted line in a checked file (or a pretest hook) would
  // otherwise run with every API key on the box, and the leak then propagated
  // into the receipt. Strip credential-shaped vars exactly as the worker lane
  // does; PATH survives, so the command still resolves and runs.
  const { env: checkEnv } = workerEnv(env);
  const resolvedCommand = resolveCheckCommand(task.check.command, checkEnv);
  if (!resolvedCommand) {
    return finish({
      status: "failed",
      accepted: false,
      detail: { message: `check command not found: "${task.check.command}"`, parseNotes },
    });
  }
  const checked = await superviseProcess({
    command: resolvedCommand,
    args: task.check.args ?? [],
    cwd: worktreePath,
    timeoutMs,
    env: checkEnv,
  });
  if (checked.timedOut || checked.error || checked.exitCode !== 0) {
    return finish({
      status: "failed",
      accepted: false,
      detail: {
        message: "check failed",
        exitCode: checked.exitCode,
        timedOut: checked.timedOut,
        error: checked.error,
        stderrTail: (checked.stderr ?? "").slice(-2000),
        parseNotes,
      },
    });
  }

  // Step 8: green — commit only now, never before the check passed.
  const commitRes = spawnSync("git", ["-C", worktreePath, "commit", "-m", task.commitMessage], { encoding: "utf8" });
  if (commitRes.status !== 0) {
    return finish({
      status: "failed",
      accepted: false,
      detail: { message: `git commit failed: ${(commitRes.stderr ?? "").trim()}`, parseNotes },
    });
  }
  const revParse = spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" });
  const headCommit = revParse.stdout.trim();
  writeFileSync(path.join(runDir, "diff.patch"), diffFull.stdout ?? "");

  return finish({
    status: "completed",
    accepted: true,
    headCommit,
    detail: { message: "patch applied and committed", filesWritten: writtenFiles.map((f) => f.target), parseNotes },
    usage: response.usage ?? null,
    resolvedModel: response.resolvedModel ?? null,
  });
}
