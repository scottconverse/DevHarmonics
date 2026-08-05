import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  QUALIFICATION_HARNESSES,
  appendQualification,
  candidateFingerprint,
  readQualifications,
} from "./fleet.mjs";
import { resolvePathCommand } from "./path-resolve.mjs";
import { runLocalPatch } from "./local-patch.mjs";
import { probeToolUse, sendMessages } from "./messages-client.mjs";
import { runWorker } from "./run-worker.mjs";

/**
 * The qualification SWEEP runner: for each discovered candidate x applicable
 * role, run the REAL role harness (never a simulation) and record the result.
 * This module composes fleet.mjs (identity/fingerprint/ledger),
 * messages-client.mjs (http-lane transport), run-worker.mjs (subprocess-lane
 * transport), and local-patch.mjs (http-lane structured writes) — it never
 * reimplements any of that transport itself.
 *
 * Roles applicable per lane (spec: qualification is role-scoped):
 *   http       -> analysis, tool_use, benchmark, structured_write
 *   subprocess -> analysis, benchmark, structured_write (no tool_use: a
 *                 subprocess CLI's tool use is its own already-verified
 *                 adapter, not something this factory qualifies separately —
 *                 see fleet.mjs's qualificationPlan doc comment)
 */
const ROLES_BY_LANE = Object.freeze({
  http: ["analysis", "tool_use", "benchmark", "structured_write"],
  subprocess: ["analysis", "benchmark", "structured_write"],
});

/**
 * Mirrors fleet.mjs's private `currentQualification`: the latest (by
 * finishedAt) record matching this exact candidateId + role + fingerprint
 * must have passed. Not imported — fleet.mjs does not export it, and this
 * file's touch-scope is limited to qualify.mjs / qualify-command.mjs / its
 * test (same precedent as local-patch.mjs's TASK_ID_PATTERN duplication).
 */
function isCurrentlyQualified(candidate, role, fingerprint, qualifications) {
  const matching = qualifications.filter((item) =>
    item.candidateId === candidate.id && item.role === role && item.fingerprint === fingerprint);
  const latest = matching.reduce((selected, item) =>
    (!selected || String(item.finishedAt ?? "") >= String(selected.finishedAt ?? "")) ? item : selected, null);
  return latest?.passed === true;
}

/**
 * Plan the qualification sweep: every (candidate, applicable role) pair,
 * with its harness id, its exact fingerprint, and whether a passing current
 * qualification already covers it. Never executes anything.
 *
 * `roles`, when given, restricts the plan to that subset — intersected with
 * each candidate's lane-applicable roles, never added to them (a subprocess
 * candidate never gets `tool_use` just because it was named in `roles`).
 */
export function planQualifications({ candidates, roles = null, qualificationsPath }) {
  const { qualifications } = readQualifications(qualificationsPath);
  return candidates.flatMap((candidate) => {
    const applicable = ROLES_BY_LANE[candidate.lane] ?? [];
    const selected = roles === null ? applicable : applicable.filter((role) => roles.includes(role));
    return selected.map((role) => {
      const fingerprint = candidateFingerprint(candidate, role);
      return {
        candidate,
        role,
        harness: QUALIFICATION_HARNESSES[role],
        fingerprint,
        alreadyCurrent: isCurrentlyQualified(candidate, role, fingerprint, qualifications),
      };
    });
  });
}

// --- shared prompt/verdict helpers -----------------------------------------

const ANALYSIS_MARKER = "DEVHARMONICS_ANALYSIS_QUALIFIED";
const ANALYSIS_PROMPT = `Reply with exactly ${ANALYSIS_MARKER} and no other text. Do not call tools.`;

/** Exact-match verdict for the analysis harness: no trailing commentary tolerated. */
export function verdictExactMarker(text, marker) {
  return typeof text === "string" && text.trim() === marker;
}

const BENCHMARK_PROMPT = 'Three tasks depend on task A. Task A takes 2 hours; each dependent task takes 1 hour and they can run in parallel once A finishes. Reply with ONLY a JSON object {"minimumHours": <number>} and no other text.';

/** Local models routinely fence strict-JSON output despite being told not to — tolerate it. */
function stripFences(text) {
  const trimmed = (text ?? "").trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

/** Parse the structured-reasoning-v1 benchmark response. Never throws. */
export function parseBenchmarkResponse(text) {
  const stripped = stripFences(text);
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    return { ok: false, minimumHours: null, error: `not valid JSON: ${error.message}` };
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.minimumHours !== "number") {
    return { ok: false, minimumHours: null, error: 'response JSON must be an object with a numeric "minimumHours"' };
  }
  return { ok: true, minimumHours: parsed.minimumHours, error: null };
}

/** Pass iff the parsed response's minimumHours is exactly 3 (the correct answer). */
export function benchmarkVerdict(text) {
  const parsed = parseBenchmarkResponse(text);
  return { passed: parsed.ok && parsed.minimumHours === 3, parsed };
}

/** Build a valid receipt/worker taskId out of a candidate id + role (colons and dots are not legal task-id characters). */
function safeTaskId(candidate, role) {
  const slug = `q-${candidate.id}-${role}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return (/^[a-z0-9]/.test(slug) ? slug : `x${slug}`).slice(0, 64);
}

// --- http-lane / subprocess-lane text roundtrips ---------------------------

async function httpTextRoundtrip({ candidate, deps, timeoutMs, prompt, maxTokens }) {
  return deps.sendMessages({
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    messages: [{ role: "user", content: prompt }],
    maxTokens,
    timeoutMs,
  });
}

async function subprocessTextRoundtrip({ candidate, workRoot, env, timeoutMs, prompt, role, deps, admission }) {
  const cwd = path.join(workRoot, "cwd");
  mkdirSync(cwd, { recursive: true });
  const runsRoot = path.join(workRoot, "runs");
  return deps.runWorker({
    taskId: safeTaskId(candidate, role),
    provider: candidate.provider,
    model: candidate.model,
    prompt,
    cwd,
    runsRoot,
    admission,
    sandbox: "read-only",
    allowedTools: ["Read"],
    maxTurns: 3,
    timeoutMs,
    env,
  });
}

// --- analysis ---------------------------------------------------------------

/** ENG-004 (audit): an admission refusal (fanout-*) is an INFRASTRUCTURE
 * outcome, never evidence about model capability — it must not become a
 * `passed:false` verdict that de-qualifies a previously passing candidate. */
function infrastructureRefusal(receipt) {
  const error = receipt?.exit?.error;
  return typeof error === "string" && error.startsWith("fanout-") ? error : null;
}

async function runAnalysis({ candidate, workRoot, env, timeoutMs, deps, admission }) {
  if (candidate.lane === "http") {
    const result = await httpTextRoundtrip({ candidate, deps, timeoutMs, prompt: ANALYSIS_PROMPT, maxTokens: 32 });
    if (!result.ok) {
      return { passed: false, detail: `request failed: ${result.error}`, usage: result.usage, receiptRef: null };
    }
    const passed = verdictExactMarker(result.contentText, ANALYSIS_MARKER);
    return {
      passed,
      detail: passed ? "exact marker returned" : `expected exact marker, got: ${JSON.stringify(result.contentText)}`,
      usage: result.usage,
      receiptRef: null,
    };
  }
  const run = await subprocessTextRoundtrip({ candidate, workRoot, env, timeoutMs, prompt: ANALYSIS_PROMPT, role: "analysis", deps, admission });
  const infraAnalysis = infrastructureRefusal(run.receipt);
  if (infraAnalysis) return { passed: false, infrastructureRefused: infraAnalysis, detail: infraAnalysis, usage: null, receiptRef: null };
  const passed = run.receipt.status === "completed" && verdictExactMarker(run.parsed?.finalText, ANALYSIS_MARKER);
  return {
    passed,
    detail: passed
      ? "exact marker returned"
      : `status=${run.receipt.status}, finalText=${JSON.stringify(run.parsed?.finalText ?? null)}`,
    usage: run.receipt.usage,
    receiptRef: { receiptId: run.receipt.receiptId, runDir: run.runDir },
  };
}

// --- benchmark ---------------------------------------------------------------

function benchmarkDetail(passed, parsed) {
  return passed ? "minimumHours=3" : `benchmark verdict failed: ${parsed.error ?? `got minimumHours=${JSON.stringify(parsed.minimumHours)}`}`;
}

async function runBenchmark({ candidate, workRoot, env, timeoutMs, deps, admission }) {
  if (candidate.lane === "http") {
    const result = await httpTextRoundtrip({ candidate, deps, timeoutMs, prompt: BENCHMARK_PROMPT, maxTokens: 128 });
    if (!result.ok) {
      return { passed: false, detail: `request failed: ${result.error}`, usage: result.usage, receiptRef: null };
    }
    const { passed, parsed } = benchmarkVerdict(result.contentText);
    return { passed, detail: benchmarkDetail(passed, parsed), usage: result.usage, receiptRef: null };
  }
  const run = await subprocessTextRoundtrip({ candidate, workRoot, env, timeoutMs, prompt: BENCHMARK_PROMPT, role: "benchmark", deps, admission });
  const infraBenchmark = infrastructureRefusal(run.receipt);
  if (infraBenchmark) return { passed: false, infrastructureRefused: infraBenchmark, detail: infraBenchmark, usage: null, receiptRef: null };
  const { passed, parsed } = run.receipt.status === "completed"
    ? benchmarkVerdict(run.parsed?.finalText)
    : { passed: false, parsed: { error: `worker status=${run.receipt.status}`, minimumHours: null } };
  return {
    passed,
    detail: benchmarkDetail(passed, parsed),
    usage: run.receipt.usage,
    receiptRef: { receiptId: run.receipt.receiptId, runDir: run.runDir },
  };
}

// --- tool_use (http only) ---------------------------------------------------

async function runToolUse({ candidate, timeoutMs, deps }) {
  if (candidate.lane !== "http") {
    return { passed: false, detail: "tool_use qualification applies to the http lane only", usage: null, receiptRef: null };
  }
  const result = await deps.probeToolUse({ baseUrl: candidate.baseUrl, model: candidate.model, timeoutMs });
  return { passed: result.status === "PASS", detail: result.detail, usage: null, receiptRef: null };
}

// --- structured_write --------------------------------------------------------

// The repo's established fixture for a real, checkable code fix: a function
// that raises NotImplementedError and a test that will only pass once it is
// implemented correctly. Kept intentionally tiny — the point is a REAL green
// check, not a representative codebase.
const FIXTURE_ADD_PY = 'def add(a, b):\n    raise NotImplementedError("add is not implemented yet")\n';
const FIXTURE_TEST_ADD_PY = [
  "from add import add",
  "",
  "def test_add():",
  "    assert add(2, 3) == 5",
  "",
  'if __name__ == "__main__":',
  "    test_add()",
  '    print("OK")',
  "",
].join("\n");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

function createStructuredWriteFixture(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "qualify@devharmonics.local"]);
  git(dir, ["config", "user.name", "DevHarmonics Qualify"]);
  writeFileSync(path.join(dir, "add.py"), FIXTURE_ADD_PY);
  writeFileSync(path.join(dir, "test_add.py"), FIXTURE_TEST_ADD_PY);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init qualification fixture"]);
}

async function runStructuredWriteHttp({ candidate, workRoot, env, timeoutMs, deps }) {
  const repoDir = mkdtempSync(path.join(workRoot, "sw-http-"));
  createStructuredWriteFixture(repoDir);
  const runsRoot = path.join(workRoot, "runs");
  const task = {
    taskId: safeTaskId(candidate, "structured-write"),
    repository: repoDir,
    base: "HEAD",
    model: candidate.model,
    baseUrl: candidate.baseUrl,
    instructions: "Fix add.py so that add(a, b) returns a + b instead of raising NotImplementedError. Return the complete corrected file text.",
    readPaths: ["add.py"],
    writePaths: ["add.py"],
    check: { command: "python", args: ["test_add.py"] },
    commitMessage: "qualify: fix add.py",
    timeoutMs,
  };
  const result = await deps.runLocalPatch({ task, client: deps.sendMessages, runsRoot, env });

  // runLocalPatch deliberately leaves its worktree on disk for inspection and
  // makes cleanup the caller's contract (run-command.mjs honors it). This
  // caller did not — and because a qualification sweep runs one structured
  // write per http candidate into a FIXED work root, every sweep permanently
  // accumulated a full checkout per candidate, forever (GauntletGate, live,
  // 2026-08-05). A qualification fixture is throwaway by definition: the
  // receipt is the evidence, not the worktree.
  if (result.worktreePath) {
    const removed = spawnSync("git", ["-C", task.repository, "worktree", "remove", "--force", result.worktreePath], { encoding: "utf8" });
    if (removed.status !== 0) {
      try { rmSync(result.worktreePath, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }

  const passed = result.accepted === true;
  return {
    passed,
    detail: result.detail?.message ?? (passed ? "patch applied and check passed" : "patch rejected"),
    usage: result.receipt?.usage ?? null,
    receiptRef: { receiptId: result.receipt.receiptId, runDir: result.runDir },
  };
}

async function runStructuredWriteSubprocess({ candidate, workRoot, env, timeoutMs, deps, admission }) {
  const repoDir = mkdtempSync(path.join(workRoot, "sw-sub-"));
  createStructuredWriteFixture(repoDir);
  const runsRoot = path.join(workRoot, "runs");
  // The trailing "do not run any commands" clause is PER-PROVIDER, found
  // live 2026-08-04 by isolation (same dir + shorter prompt edited fine):
  // codex implements file edits through its command channel, so that clause
  // makes it conclude editing is forbidden and report "sandbox rejected the
  // file-edit operation" — while agy REQUIRES the clause (headless command
  // permission auto-denies without an owner settings rule, and an attempted
  // command aborts its run) and claude passes either way (kept for least
  // privilege).
  const base = "Edit add.py in this repository so that add(a, b) returns a + b instead of raising NotImplementedError. Only edit add.py - do not touch any other file.";
  const prompt = candidate.provider === "codex" ? base : `${base} Do not run any commands.`;
  const { receipt, runDir } = await deps.runWorker({
    taskId: safeTaskId(candidate, "structured-write"),
    provider: candidate.provider,
    model: candidate.model,
    prompt,
    cwd: repoDir,
    runsRoot,
    admission,
    sandbox: "workspace-write",
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Edit", "Write"],
    maxTurns: 30,
    timeoutMs,
    env,
  });
  const infraWrite = infrastructureRefusal(receipt);
  if (infraWrite) return { passed: false, infrastructureRefused: infraWrite, detail: infraWrite, usage: null, receiptRef: null };

  // The worker's own claim of success is never the evidence — verify
  // independently: a real, nonempty diff, and the real check green.
  const diff = spawnSync("git", ["-C", repoDir, "diff"], { encoding: "utf8" });
  const diffNonEmpty = Boolean(diff.stdout && diff.stdout.trim().length > 0);

  const resolvedPython = resolvePathCommand("python", { env });
  let checkPassed = false;
  let checkDetail;
  if (!resolvedPython) {
    checkDetail = '"python" not found on PATH';
  } else {
    const check = spawnSync(resolvedPython, ["test_add.py"], { cwd: repoDir, encoding: "utf8" });
    checkPassed = check.status === 0;
    checkDetail = checkPassed
      ? "test_add.py passed"
      : `test_add.py exited ${check.status ?? "null"}: ${(check.stderr || check.stdout || "").slice(0, 500)}`;
  }

  const passed = diffNonEmpty && checkPassed;
  return {
    passed,
    detail: `worker status=${receipt.status}; ${diffNonEmpty ? "git diff nonempty" : "git diff EMPTY"}; ${checkDetail}`,
    usage: receipt.usage,
    receiptRef: { receiptId: receipt.receiptId, runDir },
  };
}

// --- dispatcher + recording --------------------------------------------------

/**
 * Run ONE (candidate, role) harness for real and record the result — pass or
 * fail, ALWAYS — via fleet.appendQualification. Never reimplements transport:
 * dispatches to sendMessages/probeToolUse (http), runWorker (subprocess), or
 * runLocalPatch (http structured writes), all swappable via `deps` for
 * testing without any live model or CLI.
 */
export async function executeQualification({
  candidate,
  role,
  workRoot,
  qualificationsPath,
  env = process.env,
  timeoutMs = 180_000,
  // D1 fan-out ceilings: a sweep's subprocess harnesses all meter against ONE
  // state root — by default the directory qualifications.jsonl lives in — so
  // 65 candidate/role pairs count as 65 workers, not 65 fresh ledgers.
  admission = undefined,
  deps = {},
}) {
  if (typeof qualificationsPath !== "string" || !qualificationsPath) {
    throw new Error("executeQualification: qualificationsPath is required");
  }
  const harness = QUALIFICATION_HARNESSES[role];
  if (!harness) {
    throw new Error(`executeQualification: unknown qualification role: ${role}`);
  }
  const resolvedDeps = { sendMessages, runWorker, runLocalPatch, probeToolUse, ...deps };
  const resolvedAdmission = admission ?? { stateRoot: path.dirname(qualificationsPath) };

  const startedAt = Date.now();
  let outcome;
  try {
    mkdirSync(workRoot, { recursive: true });
    if (role === "analysis") {
      outcome = await runAnalysis({ candidate, workRoot, env, timeoutMs, deps: resolvedDeps, admission: resolvedAdmission });
    } else if (role === "benchmark") {
      outcome = await runBenchmark({ candidate, workRoot, env, timeoutMs, deps: resolvedDeps, admission: resolvedAdmission });
    } else if (role === "tool_use") {
      outcome = await runToolUse({ candidate, timeoutMs, deps: resolvedDeps });
    } else {
      // role === "structured_write" (the only remaining known harness)
      outcome = candidate.lane === "http"
        ? await runStructuredWriteHttp({ candidate, workRoot, env, timeoutMs, deps: resolvedDeps })
        : await runStructuredWriteSubprocess({ candidate, workRoot, env, timeoutMs, deps: resolvedDeps, admission: resolvedAdmission });
    }
  } catch (error) {
    outcome = { passed: false, detail: `harness threw: ${error.message}`, usage: null, receiptRef: null };
  }
  const durationMs = Date.now() - startedAt;

  // ENG-004: an infrastructure refusal is never appended to
  // qualifications.jsonl — that ledger is capability evidence, and a
  // budget-exhausted sweep must not demote candidates that passed yesterday
  // (the consumer is latest-record-wins).
  if (outcome.infrastructureRefused) {
    return {
      passed: false,
      infrastructureRefused: outcome.infrastructureRefused,
      detail: outcome.detail,
      durationMs,
      usage: null,
      receiptRef: null,
    };
  }

  const record = {
    candidateId: candidate.id,
    lane: candidate.lane,
    provider: candidate.provider,
    model: candidate.model,
    role,
    harness,
    fingerprint: candidateFingerprint(candidate, role),
    ...(candidate.digest ? { digest: candidate.digest } : {}),
    passed: outcome.passed === true,
    detail: outcome.detail,
    durationMs,
    finishedAt: new Date().toISOString(),
  };
  appendQualification(qualificationsPath, record);

  return {
    passed: record.passed,
    detail: outcome.detail,
    durationMs,
    usage: outcome.usage ?? null,
    receiptRef: outcome.receiptRef ?? null,
  };
}
