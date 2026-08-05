import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendQualification, candidateFingerprint, readQualifications } from "../scripts/fleet.mjs";
import { qualifyCommand } from "../scripts/qualify-command.mjs";
import {
  benchmarkVerdict,
  executeQualification,
  parseBenchmarkResponse,
  planQualifications,
  verdictExactMarker,
} from "../scripts/qualify.mjs";

/**
 * Fixture-only — NO live models/CLIs (CI has none). planQualifications and
 * the small parse/verdict helpers are tested against plain data.
 * executeQualification is tested with injected fakes (deps) driving both
 * PASS and FAIL through analysis, benchmark, and tool_use without any
 * network call. qualifyCommand's dry-run is exercised against dead
 * endpoints/CLIs, proving it completes (never throws) even fully unreachable.
 */

const httpCandidate = {
  id: "http:ollama:test-model",
  lane: "http",
  provider: "ollama",
  model: "test-model",
  tier: "economy",
  runtimeVersion: "unknown",
  baseUrl: "http://127.0.0.1:9",
  paid: false,
};

const subprocessCandidate = {
  id: "subprocess:codex:test-model",
  lane: "subprocess",
  provider: "codex",
  model: "test-model",
  tier: "premium",
  runtimeVersion: "1.0.0",
  paid: true,
};

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * qualifyCommand takes an injectable `write` sink specifically so tests never
 * have to monkey-patch the process-global process.stdout.write — doing that
 * collides with node:test's own asynchronous TAP/spec reporter, which writes
 * to the same real stdout between awaits and would otherwise get its output
 * captured (or corrupted) by the patch.
 */
async function runQualifyCommand(argv) {
  let output = "";
  const result = await qualifyCommand(argv, { write: (text) => { output += text; } });
  return { result, output };
}

// --- planQualifications ------------------------------------------------------

test("planQualifications gives http candidates all 4 roles and subprocess candidates 3 (no tool_use)", () => {
  const dir = tmp("dh-qualify-plan-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const plan = planQualifications({ candidates: [httpCandidate, subprocessCandidate], qualificationsPath });
    const rolesFor = (id) => plan.filter((row) => row.candidate.id === id).map((row) => row.role);
    assert.deepEqual(rolesFor(httpCandidate.id), ["analysis", "tool_use", "benchmark", "structured_write"]);
    assert.deepEqual(rolesFor(subprocessCandidate.id), ["analysis", "benchmark", "structured_write"]);
    for (const row of plan) {
      assert.equal(row.alreadyCurrent, false, "no qualifications.jsonl exists yet");
      assert.ok(row.harness, "every row carries its harness id");
      assert.ok(row.fingerprint, "every row carries its fingerprint");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planQualifications restricts to the requested roles, intersected with lane-applicable roles", () => {
  const dir = tmp("dh-qualify-plan-roles-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const plan = planQualifications({
      candidates: [httpCandidate, subprocessCandidate],
      roles: ["tool_use", "analysis"],
      qualificationsPath,
    });
    assert.deepEqual(plan.filter((row) => row.candidate.id === httpCandidate.id).map((row) => row.role), ["analysis", "tool_use"]);
    // subprocess never gets tool_use even though it was requested.
    assert.deepEqual(plan.filter((row) => row.candidate.id === subprocessCandidate.id).map((row) => row.role), ["analysis"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planQualifications marks alreadyCurrent true only for an exact-fingerprint passing record", () => {
  const dir = tmp("dh-qualify-current-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    appendQualification(qualificationsPath, {
      candidateId: httpCandidate.id,
      role: "analysis",
      fingerprint: candidateFingerprint(httpCandidate, "analysis"),
      passed: true,
      finishedAt: "2026-08-01T00:00:00.000Z",
    });
    // A failed record for benchmark must not count as current.
    appendQualification(qualificationsPath, {
      candidateId: httpCandidate.id,
      role: "benchmark",
      fingerprint: candidateFingerprint(httpCandidate, "benchmark"),
      passed: false,
      finishedAt: "2026-08-01T00:00:00.000Z",
    });

    const plan = planQualifications({ candidates: [httpCandidate], qualificationsPath });
    assert.equal(plan.find((row) => row.role === "analysis").alreadyCurrent, true);
    assert.equal(plan.find((row) => row.role === "benchmark").alreadyCurrent, false);
    assert.equal(plan.find((row) => row.role === "tool_use").alreadyCurrent, false);

    // A runtime change produces a different fingerprint — the old PASS no longer applies.
    const staleCandidate = { ...httpCandidate, runtimeVersion: "different-runtime" };
    const stalePlan = planQualifications({ candidates: [staleCandidate], qualificationsPath });
    assert.equal(stalePlan.find((row) => row.role === "analysis").alreadyCurrent, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- benchmark parser / verdict ----------------------------------------------

test("parseBenchmarkResponse / benchmarkVerdict: plain JSON, fenced JSON, wrong answer, garbage", () => {
  assert.deepEqual(parseBenchmarkResponse('{"minimumHours":3}'), { ok: true, minimumHours: 3, error: null });
  assert.equal(benchmarkVerdict('{"minimumHours":3}').passed, true);

  const fenced = '```json\n{"minimumHours":3}\n```';
  assert.equal(parseBenchmarkResponse(fenced).ok, true);
  assert.equal(benchmarkVerdict(fenced).passed, true);

  assert.equal(benchmarkVerdict('{"minimumHours":4}').passed, false);
  assert.equal(parseBenchmarkResponse('{"minimumHours":4}').minimumHours, 4);

  const garbage = benchmarkVerdict("not json at all, sorry");
  assert.equal(garbage.passed, false);
  assert.match(garbage.parsed.error, /not valid JSON/);

  const wrongShape = benchmarkVerdict('{"answer":3}');
  assert.equal(wrongShape.passed, false);
  assert.match(wrongShape.parsed.error, /numeric "minimumHours"/);
});

// --- analysis exact-marker verdict -------------------------------------------

test("verdictExactMarker requires an exact (trimmed) match, nothing extra tolerated", () => {
  const marker = "DEVHARMONICS_ANALYSIS_QUALIFIED";
  assert.equal(verdictExactMarker(marker, marker), true);
  assert.equal(verdictExactMarker(`  ${marker}  `, marker), true, "surrounding whitespace is trimmed");
  assert.equal(verdictExactMarker(`Sure! ${marker}`, marker), false, "extra text fails");
  assert.equal(verdictExactMarker(`${marker}.`, marker), false, "trailing punctuation fails");
  assert.equal(verdictExactMarker(null, marker), false);
  assert.equal(verdictExactMarker(undefined, marker), false);
});

// --- executeQualification with injected fakes --------------------------------

test("executeQualification: analysis (http) — pass and fail both append a qualification record", async () => {
  const dir = tmp("dh-qualify-exec-analysis-http-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");

    const pass = await executeQualification({
      candidate: httpCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      deps: { sendMessages: async () => ({ ok: true, contentText: "DEVHARMONICS_ANALYSIS_QUALIFIED", usage: { inputTokens: 3, outputTokens: 2 } }) },
    });
    assert.equal(pass.passed, true);
    assert.equal(pass.receiptRef, null, "http-lane analysis makes no receipt of its own");

    const fail = await executeQualification({
      candidate: httpCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      deps: { sendMessages: async () => ({ ok: true, contentText: "Sure, DEVHARMONICS_ANALYSIS_QUALIFIED it is!", usage: null }) },
    });
    assert.equal(fail.passed, false);

    const { qualifications } = readQualifications(qualificationsPath);
    assert.equal(qualifications.length, 2);
    assert.equal(qualifications[0].passed, true);
    assert.equal(qualifications[1].passed, false);
    for (const record of qualifications) {
      assert.equal(record.candidateId, httpCandidate.id);
      assert.equal(record.role, "analysis");
      assert.equal(record.harness, "analysis-exact-artifact-v1");
      assert.ok(record.finishedAt);
      assert.equal(typeof record.durationMs, "number");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeQualification: analysis (subprocess) — pass and fail both append a qualification record", async () => {
  const dir = tmp("dh-qualify-exec-analysis-sub-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");
    const fakeRunWorker = (finalText) => async () => ({
      receipt: { status: "completed", usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }, receiptId: "fake-receipt-id" },
      runDir: path.join(dir, "fake-run-dir"),
      parsed: { finalText },
    });

    const pass = await executeQualification({
      candidate: subprocessCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      deps: { runWorker: fakeRunWorker("DEVHARMONICS_ANALYSIS_QUALIFIED") },
    });
    assert.equal(pass.passed, true);
    assert.deepEqual(pass.receiptRef, { receiptId: "fake-receipt-id", runDir: path.join(dir, "fake-run-dir") });

    const fail = await executeQualification({
      candidate: subprocessCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      deps: { runWorker: fakeRunWorker("not the marker") },
    });
    assert.equal(fail.passed, false);

    const { qualifications } = readQualifications(qualificationsPath);
    assert.equal(qualifications.length, 2);
    assert.equal(qualifications[0].passed, true);
    assert.equal(qualifications[1].passed, false);
    assert.equal(qualifications[0].lane, "subprocess");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeQualification: benchmark (http) — pass and fail both append a qualification record", async () => {
  const dir = tmp("dh-qualify-exec-benchmark-http-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");

    const pass = await executeQualification({
      candidate: httpCandidate,
      role: "benchmark",
      workRoot,
      qualificationsPath,
      deps: { sendMessages: async () => ({ ok: true, contentText: '{"minimumHours":3}', usage: { inputTokens: 20, outputTokens: 8 } }) },
    });
    assert.equal(pass.passed, true);

    const fail = await executeQualification({
      candidate: httpCandidate,
      role: "benchmark",
      workRoot,
      qualificationsPath,
      deps: { sendMessages: async () => ({ ok: true, contentText: '{"minimumHours":4}', usage: null }) },
    });
    assert.equal(fail.passed, false);

    const { qualifications } = readQualifications(qualificationsPath);
    assert.equal(qualifications.length, 2);
    assert.equal(qualifications[0].role, "benchmark");
    assert.equal(qualifications[0].harness, "structured-reasoning-v1");
    assert.equal(qualifications[0].passed, true);
    assert.equal(qualifications[1].passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeQualification: tool_use (http) — pass and fail both append a qualification record", async () => {
  const dir = tmp("dh-qualify-exec-tooluse-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");

    const pass = await executeQualification({
      candidate: httpCandidate,
      role: "tool_use",
      workRoot,
      qualificationsPath,
      deps: { probeToolUse: async () => ({ status: "PASS", detail: "get_weather called with city=\"Paris\"" }) },
    });
    assert.equal(pass.passed, true);

    const fail = await executeQualification({
      candidate: httpCandidate,
      role: "tool_use",
      workRoot,
      qualificationsPath,
      deps: { probeToolUse: async () => ({ status: "FAIL", detail: "no tool_use block in the response" }) },
    });
    assert.equal(fail.passed, false);

    const { qualifications } = readQualifications(qualificationsPath);
    assert.equal(qualifications.length, 2);
    assert.equal(qualifications[0].role, "tool_use");
    assert.equal(qualifications[0].harness, "messages-tool-use-v1");
    assert.equal(qualifications[0].passed, true);
    assert.equal(qualifications[1].passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeQualification: tool_use is refused for a subprocess candidate without ever calling deps.probeToolUse", async () => {
  const dir = tmp("dh-qualify-exec-tooluse-subprocess-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");
    let called = false;
    const result = await executeQualification({
      candidate: subprocessCandidate,
      role: "tool_use",
      workRoot,
      qualificationsPath,
      deps: { probeToolUse: async () => { called = true; return { status: "PASS", detail: "should never run" }; } },
    });
    assert.equal(result.passed, false);
    assert.equal(called, false);
    assert.match(result.detail, /http lane only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeQualification: a thrown harness error is recorded as a failed qualification, never an unhandled rejection", async () => {
  const dir = tmp("dh-qualify-exec-throws-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");
    const result = await executeQualification({
      candidate: httpCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      deps: { sendMessages: async () => { throw new Error("network exploded"); } },
    });
    assert.equal(result.passed, false);
    assert.match(result.detail, /network exploded/);
    const { qualifications } = readQualifications(qualificationsPath);
    assert.equal(qualifications.length, 1);
    assert.equal(qualifications[0].passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeQualification requires qualificationsPath", async () => {
  await assert.rejects(
    () => executeQualification({ candidate: httpCandidate, role: "analysis", workRoot: tmp("dh-qualify-noqp-") }),
    /qualificationsPath is required/,
  );
});

// --- qualifyCommand -----------------------------------------------------------

test("qualifyCommand dry-run against dead endpoints/CLIs prints a plan, exits 0, never throws", async () => {
  const dir = tmp("dh-qualify-cmd-dryrun-");
  try {
    const configFile = path.join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      endpoints: {
        ollama: { baseUrl: "http://127.0.0.1:1" },
        lmstudio: { baseUrl: "http://127.0.0.1:2" },
      },
      clis: {
        codex: { command: "definitely-not-installed-devharmonics-codex", workerModels: ["fake-model"] },
      },
    }));
    const stateRoot = path.join(dir, "state");

    const { result, output } = await runQualifyCommand(["--config", configFile, "--state-root", stateRoot]);

    assert.equal(result, 0);
    assert.match(output, /dry run/);
    assert.match(output, /planned/);
    assert.match(output, /subprocess:codex:fake-model/);
    // Dead http endpoints must be noted honestly, never silently ignored.
    assert.match(output, /note: ollama endpoint/);
    assert.match(output, /note: lmstudio endpoint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qualifyCommand dry-run --json emits parseable JSON with the plan and notes", async () => {
  const dir = tmp("dh-qualify-cmd-json-");
  try {
    const configFile = path.join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      endpoints: { ollama: { baseUrl: "http://127.0.0.1:1" }, lmstudio: { baseUrl: "http://127.0.0.1:2" } },
      clis: { codex: { command: "definitely-not-installed-devharmonics-codex", workerModels: ["fake-model"] } },
    }));
    const stateRoot = path.join(dir, "state");

    const { result, output } = await runQualifyCommand(
      ["--config", configFile, "--state-root", stateRoot, "--json", "--lane", "subprocess", "--role", "analysis"]);

    assert.equal(result, 0);
    const parsed = JSON.parse(output);
    assert.equal(parsed.mode, "dry-run");
    assert.ok(parsed.plan.every((row) => row.role === "analysis"));
    assert.ok(parsed.plan.every((row) => row.candidate.lane === "subprocess"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qualifyCommand rejects an unknown flag, an unknown --lane, and an unknown --role", async () => {
  await assert.rejects(() => qualifyCommand(["--nonsense"]), /Unknown qualify option/);
  await assert.rejects(() => qualifyCommand(["--lane", "acp"]), /--lane must be/);
  await assert.rejects(() => qualifyCommand(["--role", "not_a_role"]), /--role must be one of/);
});

// --- Audit fix-pass TEST-008: the sweep's admission threading is real --------

test("TEST-008: executeQualification threads admission (defaulting to the qualifications dir) into runWorker", async (t) => {
  const dir = tmp("dh-qualify-admission-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");
    let captured = null;
    const capturingRunWorker = async (args) => {
      captured = args.admission;
      return {
        receipt: { status: "completed", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, receiptId: "r" },
        runDir: path.join(dir, "rd"),
        parsed: { finalText: "DEVHARMONICS_ANALYSIS_QUALIFIED" },
      };
    };
    await executeQualification({
      candidate: subprocessCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      deps: { runWorker: capturingRunWorker },
    });
    assert.ok(captured, "runWorker must receive an admission argument");
    assert.equal(captured.stateRoot, path.dirname(qualificationsPath),
      "a sweep meters against ONE ledger — the qualifications dir — not per-fixture roots");

    // And an explicit admission (qualify-command threads config budgets) wins verbatim.
    const explicit = { stateRoot: path.join(dir, "custom"), budgets: { maxWorkers: 7, maxConcurrentWorkers: 2, maxTotalTokens: 9, windowHours: 1 } };
    await executeQualification({
      candidate: subprocessCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      admission: explicit,
      deps: { runWorker: capturingRunWorker },
    });
    assert.deepEqual(captured, explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ENG-004: an admission (fanout-*) refusal is an infrastructure outcome — never a capability verdict in the ledger", async () => {
  const dir = tmp("dh-qualify-fanout-");
  try {
    const qualificationsPath = path.join(dir, "qualifications.jsonl");
    const workRoot = path.join(dir, "work");
    const refusedRunWorker = async () => ({
      receipt: {
        status: "failed",
        exit: { code: null, timedOut: false, error: "fanout-workers-exceeded: 100 of 100 workers already admitted in the last 24h (ledger: x)" },
        usage: null,
        receiptId: "r-refused",
      },
      runDir: path.join(dir, "rd"),
      parsed: null,
    });
    const result = await executeQualification({
      candidate: subprocessCandidate,
      role: "analysis",
      workRoot,
      qualificationsPath,
      deps: { runWorker: refusedRunWorker },
    });
    assert.equal(result.passed, false);
    assert.match(result.infrastructureRefused, /^fanout-workers-exceeded/);
    assert.equal(existsSync(qualificationsPath), false,
      "an infrastructure refusal must append NOTHING — latest-record-wins would demote a passing candidate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
