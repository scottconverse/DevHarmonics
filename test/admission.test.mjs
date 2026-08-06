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

test("terminal records that DISAGREE for one invocation refuse — the ledger was altered, and a money meter never guesses", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-one","taskId":"one","paid":true,"reservedTokens":60}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":25}}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":30}}',
  ].join("\n");
  assert.throws(() => summarizeLedger(ledger, true), /conflicting records/);
});

test("an IDENTICAL duplicate terminal is still harmless — charged once, never twice (replay safety)", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-one","taskId":"one","paid":true,"reservedTokens":60}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":25}}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":25}}',
  ].join("\n");
  assert.equal(summarizeLedger(ledger, true), 25);
});

test("a hand-forged ledger line with a NEGATIVE reservation fails closed, never subtracts from the running total (GAUNTLET)", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"a","taskId":"t","paid":true,"reservedTokens":900000}',
    '{"stage":"reserved","invocationId":"b","taskId":"t","paid":true,"reservedTokens":-500000}',
  ].join("\n");
  assert.throws(() => summarizeLedger(ledger, true), /invalid reservation/i);
});

test("a duplicate terminal with unknown paid usage still fails closed", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-one","taskId":"one","paid":true,"reservedTokens":60}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":{"total_tokens":25}}',
    '{"stage":"terminal","invocationId":"inv-one","taskId":"one","paid":true,"usage":null}',
  ].join("\n");
  assert.throws(() => summarizeLedger(ledger, true), /conflicting records|without trustworthy token usage/);
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

// --- D1 fan-out ceilings (owner decision 2026-08-05) ------------------------

import { admitWorker, reconcileWorker, summarizeFanout, deriveStateRoot } from "../scripts/admission.mjs";

const FANOUT_BUDGETS = { maxWorkers: 2, maxTotalTokens: 1000, windowHours: 24 };

test("admitWorker refuses fail-closed at the total-worker ceiling", async (t) => {
  const root = tempRoot(t, "dh-fanout-workers-");
  const one = await admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets: FANOUT_BUDGETS });
  const two = await admitWorker({ stateRoot: root, taskId: "w2", lane: "subprocess", budgets: FANOUT_BUDGETS });
  assert.equal(one.admitted, true);
  assert.equal(two.admitted, true);
  const three = await admitWorker({ stateRoot: root, taskId: "w3", lane: "subprocess", budgets: FANOUT_BUDGETS });
  assert.equal(three.admitted, false);
  assert.match(three.reason, /fanout-workers-exceeded: 2 of 2/);
});

test("an in-flight (unreconciled) reservation counts toward the worker ceiling — concurrency is spend", async (t) => {
  const root = tempRoot(t, "dh-fanout-inflight-");
  const budgets = { ...FANOUT_BUDGETS, maxWorkers: 1 };
  const first = await admitWorker({ stateRoot: root, taskId: "w1", lane: "acp", budgets });
  assert.equal(first.admitted, true);
  // No terminal record yet: the second admit must still see the first.
  const second = await admitWorker({ stateRoot: root, taskId: "w2", lane: "acp", budgets });
  assert.equal(second.admitted, false);
  assert.match(second.reason, /fanout-workers-exceeded/);
});

test("admitWorker refuses at the cumulative token ceiling after reconciliation", async (t) => {
  const root = tempRoot(t, "dh-fanout-tokens-");
  const budgets = { ...FANOUT_BUDGETS, maxWorkers: 10 };
  const one = await admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets });
  await reconcileWorker({ stateRoot: root, invocationId: one.invocationId, taskId: "w1", status: "completed", totalTokens: 1000 });
  const two = await admitWorker({ stateRoot: root, taskId: "w2", lane: "subprocess", budgets });
  assert.equal(two.admitted, false);
  assert.match(two.reason, /fanout-tokens-exceeded: 1000 of 1000/);
});

test("workers admitted before the rolling window no longer count", async (t) => {
  const root = tempRoot(t, "dh-fanout-window-");
  // Hand-write an old reservation+terminal pair (2 days ago) plus nothing else.
  const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const ledger = [
    `{"stage":"reserved","kind":"worker","invocationId":"inv-old","taskId":"old","paid":false,"reservedTokens":0,"startedAt":"${old}"}`,
    `{"stage":"terminal","kind":"worker","invocationId":"inv-old","taskId":"old","paid":false,"usage":{"total_tokens":999},"finishedAt":"${old}"}`,
  ].join("\n");
  const inWindow = summarizeFanout(ledger, { since: Date.now() - 24 * 3_600_000 });
  assert.deepEqual(inWindow, { workers: 0, tokens: 0, costUsd: 0 });
  const allTime = summarizeFanout(ledger, { since: 0 });
  assert.deepEqual(allTime, { workers: 1, tokens: 999, costUsd: 0 });
});

test("a corrupt fan-out ledger refuses admission rather than waving the worker through", async (t) => {
  const root = tempRoot(t, "dh-fanout-corrupt-");
  const first = await admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets: FANOUT_BUDGETS });
  assert.equal(first.admitted, true);
  const { appendFileSync } = await import("node:fs");
  appendFileSync(path.join(root, "usage.jsonl"), "{ not json\n");
  await assert.rejects(
    () => admitWorker({ stateRoot: root, taskId: "w2", lane: "subprocess", budgets: FANOUT_BUDGETS }),
    /not valid JSON/,
  );
});

test("fan-out records coexist with the money ledger without corrupting either summary", async (t) => {
  const root = tempRoot(t, "dh-fanout-coexist-");
  await reservePaidUsage({ stateRoot: root, aggregateLimit: 100, reservedTokens: 40, taskId: "paid1" });
  const worker = await admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets: FANOUT_BUDGETS });
  await reconcileWorker({ stateRoot: root, invocationId: worker.invocationId, taskId: "w1", status: "completed", totalTokens: 7 });
  const ledgerPath = path.join(root, "usage.jsonl");
  assert.equal(usageSpent(ledgerPath, true), 40, "paid summary must only see paid records");
  const fanout = summarizeFanout(readFileSync(ledgerPath, "utf8"), { since: 0 });
  assert.deepEqual(fanout, { workers: 1, tokens: 7, costUsd: 0 }, "fan-out summary must only see kind:worker records");
});

test("deriveStateRoot finds the enclosing .devharmonics, else meters in a .fanout dir inside the runsRoot", () => {
  const inside = path.join("C:", "repo", ".devharmonics", "runs", "run-1");
  assert.equal(deriveStateRoot(inside), path.resolve(path.join("C:", "repo", ".devharmonics")));
  const outside = path.join(tmpdir(), "loose-runs");
  assert.equal(deriveStateRoot(outside), path.join(path.resolve(outside), ".fanout"));
});

test("TEST-004: a reservation the meter cannot date counts toward the cap, never out of it", async (t) => {
  // Missing and malformed startedAt both count as always-in-window.
  const missing = '{"stage":"reserved","kind":"worker","invocationId":"inv-m","taskId":"m","paid":false,"reservedTokens":0}';
  const malformed = '{"stage":"reserved","kind":"worker","invocationId":"inv-g","taskId":"g","paid":false,"reservedTokens":0,"startedAt":"not-a-date"}';
  const summary = summarizeFanout([missing, malformed].join("\n"), { since: Date.now() });
  assert.deepEqual(summary, { workers: 2, tokens: 0, costUsd: 0 }, "undateable reservations must fail toward the cap");
});

test("TEST-005: concurrent admits race the same lock and never oversubscribe the worker ceiling", async (t) => {
  const root = tempRoot(t, "dh-fanout-race-");
  const budgets = { maxWorkers: 2, maxTotalTokens: 1_000_000, windowHours: 24 };
  const verdicts = await Promise.all(
    ["r1", "r2", "r3", "r4", "r5"].map((id) => admitWorker({ stateRoot: root, taskId: id, lane: "subprocess", budgets })),
  );
  const admitted = verdicts.filter((v) => v.admitted);
  const refused = verdicts.filter((v) => !v.admitted);
  assert.equal(admitted.length, 2, JSON.stringify(verdicts));
  assert.equal(refused.length, 3);
  for (const r of refused) assert.match(r.reason, /fanout-workers-exceeded/);
});

test("TEST-009: the window boundary is inclusive — a reservation at exactly `since` counts", () => {
  const at = Date.now() - 1000;
  const ledger = `{"stage":"reserved","kind":"worker","invocationId":"inv-b","taskId":"b","paid":false,"reservedTokens":0,"startedAt":"${new Date(at).toISOString()}"}`;
  assert.deepEqual(summarizeFanout(ledger, { since: at }), { workers: 1, tokens: 0, costUsd: 0 });
  assert.deepEqual(summarizeFanout(ledger, { since: at + 1 }), { workers: 0, tokens: 0, costUsd: 0 });
});

// --- v1 port (b): USD ceilings — reported dollars on the same worker ledger --

test("reconcileWorker records reported cost, and summarizeFanout sums it alongside tokens", async (t) => {
  const root = tempRoot(t, "dh-usd-record-");
  const one = await admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets: FANOUT_BUDGETS });
  await reconcileWorker({ stateRoot: root, invocationId: one.invocationId, taskId: "w1", status: "completed", totalTokens: 500, costUsd: 1.25 });
  const two = await admitWorker({ stateRoot: root, taskId: "w2", lane: "subprocess", budgets: FANOUT_BUDGETS });
  // A run that reports NO cost contributes $0 — honestly, never estimated.
  await reconcileWorker({ stateRoot: root, invocationId: two.invocationId, taskId: "w2", status: "completed", totalTokens: 300 });
  const summary = summarizeFanout(readFileSync(path.join(root, "usage.jsonl"), "utf8"), { since: 0 });
  assert.deepEqual(summary, { workers: 2, tokens: 800, costUsd: 1.25 });
});

test("admitWorker refuses at the monthly USD ceiling once reported spend reaches it", async (t) => {
  const root = tempRoot(t, "dh-usd-monthly-");
  const budgets = { ...FANOUT_BUDGETS, maxWorkers: 10, monthlyLimitUsd: 2 };
  const one = await admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets });
  await reconcileWorker({ stateRoot: root, invocationId: one.invocationId, taskId: "w1", status: "completed", totalTokens: 10, costUsd: 2.0 });
  const two = await admitWorker({ stateRoot: root, taskId: "w2", lane: "subprocess", budgets });
  assert.equal(two.admitted, false);
  assert.match(two.reason, /paid-monthly-usd-exceeded: \$2\.00 of the \$2/);
  assert.match(two.reason, /devharmonics config show/);
});

test("the monthly USD window is 30 days — old spend ages out even inside a long fan-out window", async (t) => {
  const root = tempRoot(t, "dh-usd-aged-");
  const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
  const { appendFileSync: append } = await import("node:fs");
  append(path.join(root, "usage.jsonl"), [
    `{"stage":"reserved","kind":"worker","invocationId":"inv-old","taskId":"old","paid":false,"reservedTokens":0,"startedAt":"${old}"}`,
    `{"stage":"terminal","kind":"worker","invocationId":"inv-old","taskId":"old","paid":false,"usage":{"total_tokens":10,"cost_usd":99},"finishedAt":"${old}"}`,
    "",
  ].join("\n"));
  const budgets = { ...FANOUT_BUDGETS, maxWorkers: 10, windowHours: 24 * 365, monthlyLimitUsd: 2 };
  const next = await admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets });
  assert.equal(next.admitted, true, next.reason);
});

test("a garbage monthlyLimitUsd throws rather than silently unguarding the money", async (t) => {
  const root = tempRoot(t, "dh-usd-garbage-");
  await assert.rejects(
    () => admitWorker({ stateRoot: root, taskId: "w1", lane: "subprocess", budgets: { ...FANOUT_BUDGETS, monthlyLimitUsd: "5" } }),
    /monthlyLimitUsd must be a positive number/,
  );
});

// --- MONEY-001 (audit 2026-08-06): appended records can never LOWER recorded spend

test("MONEY-001: a later terminal record cannot lower a paid charge — the forgery is DETECTED", () => {
  const honest = [
    '{"stage":"reserved","invocationId":"inv-1","taskId":"t1","paid":true,"reservedTokens":100}',
    '{"stage":"terminal","invocationId":"inv-1","taskId":"t1","paid":true,"usage":{"total_tokens":900000}}',
  ].join("\n");
  assert.equal(summarizeLedger(honest, true), 900000);
  // The exact forgery the audit proved: one appended line used to erase 900,000
  // tokens. It is now DETECTED and refused, not merely out-voted.
  const forged = `${honest}\n{"stage":"terminal","invocationId":"inv-1","taskId":"t1","paid":true,"usage":{"total_tokens":1}}`;
  assert.throws(() => summarizeLedger(forged, true), /conflicting records/, "an appended lower terminal must refuse, never reduce recorded spend");
});

test("MONEY-001 round 2: a duplicate RESERVATION cannot lower a not-yet-reconciled charge", () => {
  // Proven live by the round-2 adversarial pass: 900 then 100 used to charge 100.
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-r","taskId":"t","paid":true,"reservedTokens":900}',
    '{"stage":"reserved","invocationId":"inv-r","taskId":"t","paid":true,"reservedTokens":100}',
  ].join("\n");
  assert.throws(() => summarizeLedger(ledger, true), /conflicting records/);
});

test("MONEY-001: the same rule protects the fan-out and monthly-dollar meters", () => {
  const honest = [
    '{"stage":"reserved","kind":"worker","invocationId":"w1","taskId":"w1","paid":false,"reservedTokens":0,"startedAt":"2026-08-06T00:00:00.000Z"}',
    '{"stage":"terminal","kind":"worker","invocationId":"w1","taskId":"w1","paid":false,"usage":{"total_tokens":5000,"cost_usd":250}}',
  ].join("\n");
  assert.deepEqual(summarizeFanout(honest, { since: 0 }), { workers: 1, tokens: 5000, costUsd: 250 });
  const forged = `${honest}\n{"stage":"terminal","kind":"worker","invocationId":"w1","taskId":"w1","paid":false,"usage":{"total_tokens":0,"cost_usd":0}}`;
  assert.throws(() => summarizeFanout(forged, { since: 0 }), /conflicting records/, "an appended zero must refuse, never erase a worker's recorded tokens or dollars");
});

test("MONEY-001: a reconciled terminal still supersedes its own reservation estimate (no over-charging)", () => {
  const ledger = [
    '{"stage":"reserved","invocationId":"inv-2","taskId":"t2","paid":true,"reservedTokens":5000}',
    '{"stage":"terminal","invocationId":"inv-2","taskId":"t2","paid":true,"usage":{"total_tokens":100}}',
  ].join("\n");
  assert.equal(summarizeLedger(ledger, true), 100, "the estimate is replaced by real usage, not maxed against it");
});

// --- Automatic compaction (owner request 2026-08-06): the ledger stops growing
// forever, WITHOUT ever silently resetting a ceiling -------------------------

import { compactLedgerText, maybeCompactLedger, LEDGER_MONEY_RETENTION_MS } from "../scripts/admission.mjs";
import { statSync, writeFileSync as write } from "node:fs";

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3_600_000).toISOString();

test("compaction preserves the LIFETIME paid total exactly — a carry-forward record, never a reset", () => {
  const old = daysAgo(90);
  const lines = [];
  for (let i = 0; i < 50; i += 1) {
    lines.push(`{"stage":"reserved","invocationId":"old-${i}","taskId":"o${i}","paid":true,"reservedTokens":100,"startedAt":"${old}"}`);
    lines.push(`{"stage":"terminal","invocationId":"old-${i}","taskId":"o${i}","paid":true,"usage":{"total_tokens":${20 + i}},"finishedAt":"${old}"}`);
  }
  lines.push(`{"stage":"reserved","invocationId":"new-1","taskId":"n1","paid":true,"reservedTokens":50,"startedAt":"${daysAgo(1)}"}`);
  lines.push(`{"stage":"terminal","invocationId":"new-1","taskId":"n1","paid":true,"usage":{"total_tokens":25},"finishedAt":"${daysAgo(1)}"}`);
  const ledger = lines.join("\n");

  const before = summarizeLedger(ledger, true);
  const result = compactLedgerText(ledger);
  assert.equal(result.compacted, true, result.reason);
  assert.equal(summarizeLedger(result.text, true), before, "the paid total must be identical after compaction");
  assert.ok(result.text.length < ledger.length, "the live ledger actually got smaller");
  assert.match(result.archiveText, /old-1/, "archived detail is preserved, not deleted");
  assert.ok(!result.text.includes('"total_tokens":69'), "the archived detail left the live ledger");
  assert.match(result.text, /"total_tokens":25/, "the recent run stays verbatim");
});

test("compaction that would not reclaim space doesn't happen at all — no churn on the money file", () => {
  const old = daysAgo(90);
  const ledger = [
    `{"stage":"reserved","invocationId":"old-1","taskId":"o1","paid":true,"reservedTokens":100,"startedAt":"${old}"}`,
    `{"stage":"terminal","invocationId":"old-1","taskId":"o1","paid":true,"usage":{"total_tokens":700},"finishedAt":"${old}"}`,
  ].join("\n");
  const result = compactLedgerText(ledger);
  assert.equal(result.compacted, false);
  assert.match(result.reason, /not reclaim any space/);
});

test("compaction keeps single-use task IDs single-use — a tombstone survives for every archived run", () => {
  const ledger = [
    `{"stage":"reserved","invocationId":"old-1","taskId":"important-task","paid":false,"reservedTokens":null,"startedAt":"${daysAgo(90)}"}`,
    `{"stage":"terminal","invocationId":"old-1","taskId":"important-task","paid":false,"usage":null,"finishedAt":"${daysAgo(90)}"}`,
  ].join("\n");
  const result = compactLedgerText(ledger);
  assert.equal(result.compacted, true, result.reason);
  assert.match(result.text, /"taskId":"important-task"/, "the task ID must still be findable so it can never be reused");
  assert.match(result.text, /"stage":"archived"/);
});

test("compaction NEVER archives a worker still inside the operator's rolling window", () => {
  const ledger = [
    `{"stage":"reserved","kind":"worker","invocationId":"w-old","taskId":"w1","paid":false,"reservedTokens":0,"startedAt":"${daysAgo(60)}"}`,
    `{"stage":"terminal","kind":"worker","invocationId":"w-old","taskId":"w1","paid":false,"usage":{"total_tokens":10,"cost_usd":5},"finishedAt":"${daysAgo(60)}"}`,
  ].join("\n");
  // A 90-day fan-out window means this 60-day-old worker still counts.
  const held = compactLedgerText(ledger, { workerRetentionMs: 90 * 24 * 3_600_000 });
  assert.equal(held.compacted, false, "a worker inside the window must never be archived");
  // With the default retention it is genuinely past every window, so it may go.
  const done = compactLedgerText(ledger, { workerRetentionMs: LEDGER_MONEY_RETENTION_MS });
  assert.equal(done.compacted, true, done.reason);
  // And the tombstone must not read as a live worker holding fan-out headroom.
  assert.deepEqual(summarizeFanout(done.text, { since: 0 }), { workers: 0, tokens: 0, costUsd: 0 });
});

test("compaction refuses outright when what it would archive is untrustworthy", () => {
  const ledger = [
    `{"stage":"reserved","invocationId":"bad-1","taskId":"b1","paid":true,"reservedTokens":100,"startedAt":"${daysAgo(90)}"}`,
    `{"stage":"terminal","invocationId":"bad-1","taskId":"b1","paid":true,"usage":null,"finishedAt":"${daysAgo(90)}"}`,
  ].join("\n");
  const result = compactLedgerText(ledger);
  assert.equal(result.compacted, false);
  assert.match(result.reason, /untrustworthy/);
});

test("maybeCompactLedger leaves a small ledger completely alone, and only fires past the threshold", (t) => {
  const root = tempRoot(t, "dh-compact-");
  const ledgerPath = path.join(root, "usage.jsonl");
  const old = daysAgo(90);
  const lines = [];
  for (let i = 0; i < 400; i += 1) {
    lines.push(`{"stage":"reserved","invocationId":"old-${i}","taskId":"t${i}","paid":true,"reservedTokens":10,"startedAt":"${old}"}`);
    lines.push(`{"stage":"terminal","invocationId":"old-${i}","taskId":"t${i}","paid":true,"usage":{"total_tokens":5},"finishedAt":"${old}"}`);
  }
  write(ledgerPath, `${lines.join("\n")}\n`);
  const total = summarizeLedger(readFileSync(ledgerPath, "utf8"), true);
  const sizeBefore = statSync(ledgerPath).size;

  assert.equal(maybeCompactLedger(ledgerPath).compacted, false, "under the threshold: untouched");
  assert.equal(statSync(ledgerPath).size, sizeBefore);

  const fired = maybeCompactLedger(ledgerPath, { thresholdBytes: 1024 });
  assert.equal(fired.compacted, true, fired.reason);
  assert.ok(statSync(ledgerPath).size < sizeBefore, "the ledger shrank");
  assert.equal(summarizeLedger(readFileSync(ledgerPath, "utf8"), true), total, "the recorded paid total is unchanged");
  assert.ok(existsSync(fired.archivePath), "the archived history is on disk, not deleted");
});

test("round 4: a worker record with an IMPOSSIBLE usage figure refuses instead of counting as zero", () => {
  const base = '{"stage":"reserved","kind":"worker","invocationId":"w9","taskId":"w9","paid":false,"reservedTokens":0,"startedAt":"2026-08-06T00:00:00.000Z"}';
  const negative = `${base}\n{"stage":"terminal","kind":"worker","invocationId":"w9","taskId":"w9","paid":false,"usage":{"total_tokens":-5000}}`;
  assert.throws(() => summarizeFanout(negative, { since: 0 }), /impossible usage figure/);
  const nonsenseCost = `${base}\n{"stage":"terminal","kind":"worker","invocationId":"w9","taskId":"w9","paid":false,"usage":{"total_tokens":10,"cost_usd":"free"}}`;
  assert.throws(() => summarizeFanout(nonsenseCost, { since: 0 }), /impossible usage figure/);
  // Honestly-unknown usage is still fine: absent means "we don't know", charged 0.
  const unknown = `${base}\n{"stage":"terminal","kind":"worker","invocationId":"w9","taskId":"w9","paid":false,"usage":null}`;
  assert.deepEqual(summarizeFanout(unknown, { since: 0 }), { workers: 1, tokens: 0, costUsd: 0 });
});

test("round 5: a FRACTIONAL worker token count refuses too — counts cannot be fractional", () => {
  const base = '{"stage":"reserved","kind":"worker","invocationId":"w10","taskId":"w10","paid":false,"reservedTokens":0,"startedAt":"2026-08-06T00:00:00.000Z"}';
  const fractional = `${base}\n{"stage":"terminal","kind":"worker","invocationId":"w10","taskId":"w10","paid":false,"usage":{"total_tokens":5000.5}}`;
  assert.throws(() => summarizeFanout(fractional, { since: 0 }), /impossible usage figure/);
  // Fractional DOLLARS remain perfectly normal.
  const cents = `${base}\n{"stage":"terminal","kind":"worker","invocationId":"w10","taskId":"w10","paid":false,"usage":{"total_tokens":10,"cost_usd":0.37}}`;
  assert.deepEqual(summarizeFanout(cents, { since: 0 }), { workers: 1, tokens: 10, costUsd: 0.37 });
});
