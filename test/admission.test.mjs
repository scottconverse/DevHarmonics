// Ported from codex-factory test/factory-admission.test.mjs (same owner,
// Apache-2.0). The source file mixed pure ledger-logic tests with
// cross-OS-process spawn tests (child processes racing superviseProcess);
// only the pure ledger-logic tests are ported here — the process-spawn tests
// depend on factory-process.mjs, which has no DevHarmonics equivalent in
// scope for this port. Concurrent-process admission is still exercised
// in-process below (two logical reservations racing the same lock file),
// which covers the same acquireFileLock serialization without a fixture.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createInvocationId,
  reconcilePaidUsage,
  reserveUnpaidTaskUsage,
  reservePaidUsage,
  summarizeLedger,
  usageSpent,
} from "../scripts/admission.mjs";

function tempRoot(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("createInvocationId returns distinct real UUIDs", () => {
  const a = createInvocationId();
  const b = createInvocationId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("duplicate terminal reconciliation charges only the latest record for an invocation", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-one","taskId":"one","paid":true,"reservedTokens":60}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":25}}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":30}}',
  ].join("\n");
  assert.equal(summarizeLedger(ledger, true), 30);
});

test("a hand-forged ledger line with a NEGATIVE reservation fails closed, never subtracts from the running total (GAUNTLET)", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"a","taskId":"t","paid":true,"reservedTokens":900000}',
    '{"stage":"reserved","invocationId":"b","taskId":"t","paid":true,"reservedTokens":-500000}',
  ].join("\n");
  assert.throws(() => summarizeLedger(ledger, true), /invalid reservation/i);
});

test("latest duplicate terminal with unknown paid usage still fails closed", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-one","taskId":"one","paid":true,"reservedTokens":60}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":25}}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":null}',
  ].join("\n");
  assert.throws(() => summarizeLedger(ledger, true), /Paid usage ledger contains a run without trustworthy token usage/);
});

test("unpaid runs with unknown usage charge zero rather than throwing", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-one","taskId":"one","paid":false,"reservedTokens":null}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":false,"usage":null}',
  ].join("\n");
  assert.equal(summarizeLedger(ledger, false), 0);
});

test("legacy entries (no invocationId) pair a reservation to its terminal by taskId FIFO", () => {
  const ledger = [
    '{"stage":"reserved","taskId":"legacy-one","paid":true,"reservedTokens":50}',
    '{"stage":"reserved","taskId":"legacy-one","paid":true,"reservedTokens":40}',
    '{"stage":"terminal","taskId":"legacy-one","paid":true,"usage":{"total_tokens":10}}',
    '{"stage":"terminal","taskId":"legacy-one","paid":true,"usage":{"total_tokens":20}}',
  ].join("\n");
  // Each terminal record claims the oldest still-pending reservation's
  // identity in turn, so both attempts get closed out at their own charge.
  assert.equal(summarizeLedger(ledger, true), 30);
});

test("a bare one-shot legacy record (no stage at all) may appear once per taskId, a second is ambiguous", () => {
  const ledger = [
    '{"taskId":"orphan","paid":true,"usage":{"total_tokens":10}}',
    '{"taskId":"orphan","paid":true,"usage":{"total_tokens":20}}',
  ].join("\n");
  // The first bare record (no `stage` field, so never "reserved") claims a
  // standalone synthetic identity for "orphan"; the second has no pending
  // reservation and no standalone slot left, which is a genuinely ambiguous
  // ledger rather than a guessable one.
  assert.throws(() => summarizeLedger(ledger, true), /Ambiguous legacy usage ledger entry/);
});

test("reserveUnpaidTaskUsage refuses a second attempt at the same taskId", async (t) => {
  const root = tempRoot(t, "dh-admission-unpaid-");
  await reserveUnpaidTaskUsage({ stateRoot: root, taskId: "task-1" });
  await assert.rejects(
    reserveUnpaidTaskUsage({ stateRoot: root, taskId: "task-1" }),
    /already has an attempt/,
  );
});

test("reservePaidUsage refuses a reservation that would exceed the remaining aggregate budget", async (t) => {
  const root = tempRoot(t, "dh-admission-paid-");
  const first = await reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 60, taskId: "one" });
  assert.equal(first.remaining, 100);
  await assert.rejects(
    reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 50, taskId: "two" }),
    /Reservation 50 exceeds remaining budget 40/,
  );
  const second = await reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 40, taskId: "two" });
  assert.equal(second.remaining, 40);
});

test("reservePaidUsage requires a positive integer token reservation", async (t) => {
  const root = tempRoot(t, "dh-admission-badreserve-");
  await assert.rejects(
    reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 0, taskId: "one" }),
    /requires a positive token reservation/,
  );
  await assert.rejects(
    reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: -5, taskId: "one" }),
    /requires a positive token reservation/,
  );
});

test("reservePaidUsage with rejectTaskReuse refuses a second attempt at the same taskId", async (t) => {
  const root = tempRoot(t, "dh-admission-reuse-");
  await reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 10, taskId: "one", rejectTaskReuse: true });
  await assert.rejects(
    reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 10, taskId: "one", rejectTaskReuse: true }),
    /already has an attempt/,
  );
});

test("reconcilePaidUsage records real usage and usageSpent reflects it on replay", async (t) => {
  const root = tempRoot(t, "dh-admission-reconcile-");
  const reservation = await reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 60, taskId: "one" });
  await reconcilePaidUsage({
    stateRoot: root,
    invocationId: reservation.invocationId,
    taskId: "one",
    usage: { total_tokens: 45 },
  });
  assert.equal(usageSpent(reservation.ledgerPath, true), 45);
});

test("usageSpent on a ledger that does not exist yet is zero, not an error", () => {
  assert.equal(usageSpent(path.join(tmpdir(), "dh-admission-never-created", "usage.jsonl"), true), 0);
});

test("concurrent paid reservations against one shared ledger never both exceed budget", async (t) => {
  const root = tempRoot(t, "dh-admission-concurrent-");
  const attempt = (taskId, reservedTokens) =>
    reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens, taskId }).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );
  const [one, two] = await Promise.all([attempt("one", 60), attempt("two", 60)]);
  const outcomes = [one, two];
  assert.equal(outcomes.filter((o) => o.ok).length, 1, "only one of the two 60-token reservations can fit in a 100-token budget");
  assert.equal(outcomes.filter((o) => !o.ok).length, 1);
  const ledgerPath = path.join(root, "usage.jsonl");
  assert.equal(summarizeLedger(readFileSync(ledgerPath, "utf8"), true), 60);
  assert.ok(existsSync(ledgerPath));
});
