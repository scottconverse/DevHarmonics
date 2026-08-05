import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWorker } from "../scripts/run-worker.mjs";

// GAUNTLET (Agent B): a malformed taskId is refused UP FRONT, before any worker
// is spawned. Validating only at receipt-write time meant the worker ran real
// work and then threw with no evidence — breaking the always-leave-a-receipt rule.
test("runWorker refuses a malformed taskId before spawning, leaving no run behind", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-rw-cwd-"));
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-rw-runs-"));
  try {
    for (const bad of ["Task.With.Dots", "UPPER", "has space", "../evil", 'a"; & echo x']) {
      await assert.rejects(
        () => runWorker({ taskId: bad, provider: "codex", model: "x", prompt: "p", cwd, runsRoot }),
        /taskId must match/,
        `taskId ${JSON.stringify(bad)} must be rejected before spawning`,
      );
    }
    assert.equal(readdirSync(runsRoot).length, 0, "a rejected taskId must create no run dir at all");
  } finally {
    for (const d of [cwd, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Full-path tests through a FAKE codex on PATH: a .cmd/.sh shim delegating to
 * a Node script that honors the real contract (JSONL events on stdout, writes
 * --output-last-message, reads the prompt from stdin). No real AI CLI runs —
 * CI has none — but the whole runWorker pipeline (resolve → supervise →
 * parse → receipt) is exercised for real.
 */
function fakeCodexDir(behavior /* "ok" | "exit3" */) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-fakecodex-"));
  const impl = path.join(dir, "fake-codex-impl.mjs");
  writeFileSync(impl, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--output-last-message");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "turn.started", model: "fake-model-9b" }));
  console.log("this line is not json");
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 21, output_tokens: 8 } }));
  if (outPath) writeFileSync(outPath, "FAKE DONE: " + stdin.trim());
  process.exit(${behavior === "exit3" ? 3 : 0});
});
`);
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "codex.CMD"), `@echo off\r\nnode "${impl}" %*\r\n`);
  } else {
    const shim = path.join(dir, "codex");
    writeFileSync(shim, `#!/bin/sh\nexec node "${impl}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return dir;
}

function envWith(dir) {
  // Real system PATH must remain visible so the shim can find `node`.
  return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
}

test("runWorker end-to-end: resolve, supervise, parse, and a receipt on disk", async () => {
  const fixture = fakeCodexDir("ok");
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-runs-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-cwd-"));
  try {
    const { receipt, runDir, parsed } = await runWorker({
      taskId: "fake-task",
      provider: "codex",
      model: "fake-model-9b",
      prompt: "do the thing",
      cwd,
      runsRoot,
      timeoutMs: 30_000,
      env: envWith(fixture),
    });
    assert.equal(receipt.status, "completed");
    assert.equal(parsed.finalText, "FAKE DONE: do the thing", "stdin prompt must reach the fake tool");
    assert.deepEqual(receipt.usage, { inputTokens: 21, outputTokens: 8, totalTokens: 29 });
    assert.equal(receipt.resolvedModel, "fake-model-9b");
    assert.equal(receipt.resolutionVerified, true);
    const onDisk = JSON.parse(readFileSync(path.join(runDir, "receipt.json"), "utf8"));
    assert.equal(onDisk.receiptId, receipt.receiptId);
    assert.ok(existsSync(path.join(runDir, "stdout.log")));
    assert.equal(readFileSync(path.join(runDir, "final-text.txt"), "utf8"), "FAKE DONE: do the thing");
  } finally {
    for (const d of [fixture, runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("a nonzero worker exit is a failed receipt with the evidence retained", async () => {
  const fixture = fakeCodexDir("exit3");
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-runs-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-cwd-"));
  try {
    const { receipt } = await runWorker({
      taskId: "fake-task",
      provider: "codex",
      model: "fake-model-9b",
      prompt: "p",
      cwd,
      runsRoot,
      timeoutMs: 30_000,
      env: envWith(fixture),
    });
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.exit.code, 3);
    // Evidence still recorded: the fake wrote its artifact before exiting 3.
    assert.equal(receipt.usage.totalTokens, 29);
  } finally {
    for (const d of [fixture, runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("an attempt that cannot even spawn still leaves a failed receipt — never silence", async () => {
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), "dh-empty-"));
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-runs-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-cwd-"));
  try {
    const { receipt, runDir } = await runWorker({
      taskId: "fake-task",
      provider: "codex",
      model: "m",
      prompt: "p",
      cwd,
      runsRoot,
      env: { ...process.env, PATH: emptyDir },
    });
    assert.equal(receipt.status, "failed");
    assert.match(receipt.exit.error, /not found on PATH/);
    assert.ok(existsSync(path.join(runDir, "receipt.json")));
  } finally {
    for (const d of [emptyDir, runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("an invalid invocation (empty prompt) is a failed receipt, not a throw", async () => {
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-runs-"));
  try {
    const { receipt } = await runWorker({
      taskId: "fake-task",
      provider: "codex",
      model: "m",
      prompt: "",
      cwd: os.tmpdir(),
      runsRoot,
    });
    assert.equal(receipt.status, "failed");
    assert.match(receipt.exit.error, /invocation/);
    assert.equal(readdirSync(runsRoot).length, 1, "exactly one run dir with its receipt");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

// --- D1 fan-out ceilings: enforced at the ONE place every caller passes -----

test("D1: a worker over the fan-out ceiling is refused with an honest failed receipt, and never spawns", async () => {
  const fixture = fakeCodexDir("ok");
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-runs-fanout-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-cwd-fanout-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dh-state-fanout-"));
  const budgets = { maxWorkers: 1, maxConcurrentWorkers: 3, maxTotalTokens: 1_000_000, windowHours: 24 };
  try {
    const first = await runWorker({
      taskId: "fanout-one", provider: "codex", model: "fake-model-9b", prompt: "p",
      cwd, runsRoot, timeoutMs: 30_000, env: envWith(fixture),
      admission: { stateRoot, budgets },
    });
    assert.equal(first.receipt.status, "completed");

    const refused = await runWorker({
      taskId: "fanout-two", provider: "codex", model: "fake-model-9b", prompt: "p",
      cwd, runsRoot, timeoutMs: 30_000, env: envWith(fixture),
      admission: { stateRoot, budgets },
    });
    assert.equal(refused.receipt.status, "failed");
    assert.match(refused.receipt.exit.error, /fanout-workers-exceeded: 1 of 1/);
    // Never spawned: no stdout.log means superviseProcess never ran.
    assert.equal(existsSync(path.join(refused.runDir, "stdout.log")), false, "a refused worker must not have spawned");

    // The ledger holds the full audit trail: reservation + terminal with the
    // REAL token count the completed run reported (21 + 8 from the fake).
    const ledger = readFileSync(path.join(stateRoot, "usage.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(ledger.length, 2, "one reservation + one terminal — the refused attempt writes nothing");
    assert.equal(ledger[1].stage, "terminal");
    assert.deepEqual(ledger[1].usage, { total_tokens: 29 });

    // The worker slot was released — a fresh state root admits again.
    const slotFiles = existsSync(path.join(stateRoot, "worker-slots"))
      ? (await import("node:fs")).readdirSync(path.join(stateRoot, "worker-slots"))
      : [];
    assert.deepEqual(slotFiles, [], "the completed run must have released its slot");
  } finally {
    for (const d of [fixture, runsRoot, cwd, stateRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test("TEST-005: a full slot house refuses with fanout-concurrency after the bounded wait — never oversubscribes", async () => {
  const fixture = fakeCodexDir("ok");
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-runs-slots-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-cwd-slots-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dh-state-slots-"));
  const budgets = { maxWorkers: 10, maxConcurrentWorkers: 1, maxTotalTokens: 1_000_000, windowHours: 24 };
  const { acquireWorkerSlot } = await import("../scripts/slots.mjs");
  const held = acquireWorkerSlot(stateRoot, 1, { taskId: "squatter" });
  try {
    const refused = await runWorker({
      taskId: "slot-starved", provider: "codex", model: "fake-model-9b", prompt: "p",
      cwd, runsRoot, timeoutMs: 1_500, env: envWith(fixture),
      admission: { stateRoot, budgets },
    });
    assert.equal(refused.receipt.status, "failed");
    assert.match(refused.receipt.exit.error, /fanout-concurrency/);
    assert.equal(existsSync(path.join(refused.runDir, "stdout.log")), false, "a slot-starved worker must not have spawned");
    // The admitted-but-never-ran reservation reconciles as failed with 0 tokens.
    const ledger = readFileSync(path.join(stateRoot, "usage.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(ledger.length, 2);
    assert.equal(ledger[1].status, "failed");
  } finally {
    held.release();
    for (const d of [fixture, runsRoot, cwd, stateRoot]) rmSync(d, { recursive: true, force: true });
  }
});
