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
