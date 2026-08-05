// Ported from codex-factory test/factory-slots.test.mjs (same owner,
// Apache-2.0). Cross-OS-process spawn tests from the source's sibling
// factory-admission.test.mjs are intentionally not ported here: they exercise
// factory-process.mjs's superviseProcess, which has no DevHarmonics
// equivalent in scope for this port (scripts/supervise.mjs is a distinct,
// already-tested module). isContendedClaim's Windows EPERM behavior below is
// ported as a pure synchronous check instead, with no child process involved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireFileLock, acquireWorkerSlot, isContendedClaim } from "../scripts/slots.mjs";

test("worker slots enforce the configured campaign-wide concurrency", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dh-slots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = acquireWorkerSlot(root, 2, { taskId: "one" });
  const second = acquireWorkerSlot(root, 2, { taskId: "two" });
  assert.notEqual(first.path, second.path);
  assert.throws(() => acquireWorkerSlot(root, 2, { taskId: "three" }), /worker slots are occupied/i);
  first.release();
  const third = acquireWorkerSlot(root, 2, { taskId: "three" });
  third.release();
  second.release();
});

test("exclusive ledger locks wait briefly instead of racing reservations", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dh-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "ledger.lock");
  const first = await acquireFileLock(lockPath, { taskId: "one" }, { timeoutMs: 100 });
  const waiting = acquireFileLock(lockPath, { taskId: "two" }, { timeoutMs: 200, retryMs: 5 });
  setTimeout(() => first.release(), 20);
  const second = await waiting;
  assert.equal(second.path, lockPath);
  second.release();
});

test("a lock that times out because the holder never releases throws", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dh-lock-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "ledger.lock");
  const held = await acquireFileLock(lockPath, { taskId: "holder" }, { timeoutMs: 100 });
  await assert.rejects(
    acquireFileLock(lockPath, { taskId: "waiter" }, { timeoutMs: 50, retryMs: 5 }),
    /Timed out waiting for lock/,
  );
  held.release();
});

test("worker slots reclaim a lock owned by a dead process, never a live one", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dh-stale-slot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slotRoot = path.join(root, "worker-slots");
  mkdirSync(slotRoot);
  // A PID far past any real process table entry: guaranteed dead.
  writeFileSync(path.join(slotRoot, "1.lock"), `${JSON.stringify({ pid: 2_147_483_647, taskId: "interrupted" })}\n`);
  const recovered = acquireWorkerSlot(root, 1, { taskId: "replacement" });
  recovered.release();
});

test("worker slots refuse to reclaim a lock owned by this still-live process", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dh-live-slot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slotRoot = path.join(root, "worker-slots");
  mkdirSync(slotRoot);
  writeFileSync(path.join(slotRoot, "1.lock"), `${JSON.stringify({ pid: process.pid, taskId: "still-running" })}\n`);
  assert.throws(() => acquireWorkerSlot(root, 1, { taskId: "blocked" }), /worker slots are occupied/i);
});

test("acquireWorkerSlot rejects an out-of-range maximum rather than silently clamping", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dh-slot-range-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => acquireWorkerSlot(root, 0, {}), /between 1 and 4/);
  assert.throws(() => acquireWorkerSlot(root, 5, {}), /between 1 and 4/);
});

test("Windows delete-pending EPERM remains lock contention", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dh-eperm-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "usage.lock");
  writeFileSync(lockPath, "{}");
  assert.equal(isContendedClaim({ code: "EPERM" }, lockPath, "win32"), true);
  assert.equal(
    isContendedClaim({ code: "EPERM" }, path.join(root, "missing.lock"), "win32", { boundedFileLock: true }),
    true,
    "a delete-pending Windows lock may be absent from existsSync while open still returns EPERM",
  );
  assert.equal(isContendedClaim({ code: "EPERM" }, path.join(root, "missing.lock"), "win32"), false);
  assert.equal(isContendedClaim({ code: "EPERM" }, lockPath, "linux"), false);
  assert.equal(isContendedClaim({ code: "EEXIST" }, lockPath, "linux"), true);
  assert.equal(isContendedClaim({ code: "EACCES" }, lockPath, "win32"), false);
});

// --- Audit fix-pass TEST-005: the dead-PID reclaim race, in-suite ------------
// The GauntletGate 25-thread proof lived outside the repo and could not re-run.
// This ports it as a repeatable cross-process race: N real node processes race
// to claim ONE slot whose current owner is provably dead. Exactly one may win;
// every loser must see the documented "occupied" refusal, never a raw
// EEXIST/EPERM escaping the reclaim path.
test("dead-PID reclaim race: N concurrent processes, exactly one winner, losers refuse cleanly", async (t) => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync: wf } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "dh-slots-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Seed slot 1 with a dead owner: PIDs are recycled, so find a definitely-dead
  // one by spawning and reaping a real child first.
  const probe = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = probe.pid;
  await new Promise((resolve) => probe.on("close", resolve));
  const slotDir = path.join(root, "worker-slots");
  const { mkdirSync: mk } = await import("node:fs");
  mk(slotDir, { recursive: true });
  wf(path.join(slotDir, "1.lock"), `${JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() })}\n`);

  const contender = `
    import { acquireWorkerSlot } from ${JSON.stringify(new URL("../scripts/slots.mjs", import.meta.url).href)};
    try {
      acquireWorkerSlot(${JSON.stringify(root)}, 1, { taskId: "racer-" + process.pid });
      console.log("WON");
      setTimeout(() => process.exit(0), 800); // hold the slot while siblings race
    } catch (error) {
      if (/worker slots are occupied/i.test(error.message)) { console.log("REFUSED"); process.exit(0); }
      console.log("RAW:" + error.message); process.exit(1);
    }
  `;
  const contenderFile = path.join(root, "contender.mjs");
  wf(contenderFile, contender);
  const N = 10;
  const results = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, [contenderFile], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  })));

  const winners = results.filter((r) => r.out === "WON");
  const refused = results.filter((r) => r.out === "REFUSED");
  const raw = results.filter((r) => r.out.startsWith("RAW:"));
  assert.equal(raw.length, 0, `raw fs errors escaped the reclaim path: ${raw.map((r) => r.out).join("; ")}`);
  assert.equal(winners.length, 1, `exactly one contender may reclaim the dead slot, got ${winners.length} (${results.map((r) => r.out).join(",")})`);
  assert.equal(winners.length + refused.length, N);
});
