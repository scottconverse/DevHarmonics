import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ledgerCommand, ledgerStatus, rotateLedger } from "../scripts/ledger-command.mjs";
import { summarizeLedger } from "../scripts/admission.mjs";

function tempLedger(t, lines) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-ledger-cmd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.jsonl");
  if (lines) writeFileSync(file, `${lines.join("\n")}\n`);
  return { dir, file };
}

const HEALTHY = [
  '{"stage":"reserved","invocationId":"inv-1","taskId":"t1","paid":true,"reservedTokens":100,"startedAt":"2026-08-01T00:00:00.000Z"}',
  '{"stage":"terminal","invocationId":"inv-1","taskId":"t1","paid":true,"usage":{"total_tokens":420},"finishedAt":"2026-08-01T00:01:00.000Z"}',
];
// The exact shape the audit proved wedges every budget check.
const WEDGED = [...HEALTHY, '{"stage":"terminal","invocationId":"inv-1","taskId":"t1","paid":true,"usage":{"total_tokens":1}}'];

test("status reports recorded spend on a healthy ledger and exits 0", async (t) => {
  const { file } = tempLedger(t, HEALTHY);
  const status = ledgerStatus(file);
  assert.equal(status.healthy, true);
  assert.equal(status.paidTokens, 420);
  let out = "";
  assert.equal(await ledgerCommand(["status", "--state-root", path.dirname(file)], { write: (s) => { out += s; } }), 0);
  assert.match(out, /420 tokens recorded/);
  assert.match(out, /health:\s+OK/);
});

test("status on a WEDGED ledger says so plainly, names the remedy, and exits 1", async (t) => {
  const { file } = tempLedger(t, WEDGED);
  const status = ledgerStatus(file);
  assert.equal(status.healthy, false);
  assert.match(status.problem, /conflicting records/);
  let out = "";
  const code = await ledgerCommand(["status", "--state-root", path.dirname(file)], { write: (s) => { out += s; } });
  assert.equal(code, 1, "an unusable money ledger is not a success");
  assert.match(out, /REFUSING/);
  assert.match(out, /devharmonics ledger rotate/);
});

test("rotating a HEALTHY ledger carries the lifetime paid total forward — rotation is never a budget reset", (t) => {
  const { file } = tempLedger(t, HEALTHY);
  const before = summarizeLedger(readFileSync(file, "utf8"), true);
  const result = rotateLedger(file);
  assert.equal(result.rotated, true);
  assert.equal(result.carriedPaidTokens, before);
  assert.equal(summarizeLedger(readFileSync(file, "utf8"), true), before, "the ceiling must be unchanged after rotation");
  assert.ok(existsSync(result.archivePath), "the old ledger is renamed, never deleted");
  assert.match(readFileSync(result.archivePath, "utf8"), /inv-1/);
});

test("rotating a WEDGED ledger REFUSES until the owner accepts losing the total", (t) => {
  const { file } = tempLedger(t, WEDGED);
  assert.throws(() => rotateLedger(file), /true spend is unknown/);
  assert.throws(() => rotateLedger(file), /--reset-totals/);
  // The refusal must not have touched anything.
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 3);

  const forced = rotateLedger(file, { resetTotals: true });
  assert.equal(forced.rotated, true);
  assert.equal(forced.totalsReset, true);
  assert.equal(forced.carriedPaidTokens, 0);
  assert.ok(existsSync(forced.archivePath), "even a reset keeps the full history on disk");
  assert.equal(summarizeLedger(readFileSync(file, "utf8"), true), 0);
});

test("rotate is a no-op when there is nothing to rotate, and bad flags refuse", async (t) => {
  const { dir, file } = tempLedger(t, null);
  assert.deepEqual(rotateLedger(file).rotated, false);
  await assert.rejects(() => ledgerCommand(["status", "--nonsense"], { write: () => {} }), /Unknown ledger option/);
  await assert.rejects(() => ledgerCommand(["frobnicate", "--state-root", dir], { write: () => {} }), /Unknown ledger subcommand/);
});

// --- round-4 fixes -----------------------------------------------------------

test("round 4: the original ledger survives even if the replacement cannot be written", (t) => {
  const { file } = tempLedger(t, HEALTHY);
  const before = readFileSync(file, "utf8");
  // The archive is a COPY made before anything is replaced, so the live ledger
  // is only ever swapped at the very end, atomically.
  const result = rotateLedger(file);
  assert.equal(readFileSync(result.archivePath, "utf8"), before, "the archive is a faithful copy of what was there");
  assert.ok(existsSync(file), "a ledger always exists after rotation");
});

test("round 4: two rotations never overwrite each other's archive", (t) => {
  const { file } = tempLedger(t, HEALTHY);
  const first = rotateLedger(file, { now: 1_754_000_000_000 });
  writeFileSync(file, `${HEALTHY.join("\n")}\n`);
  const second = rotateLedger(file, { now: 1_754_000_000_000 });
  assert.notEqual(first.archivePath, second.archivePath, "same-millisecond rotations get distinct archives");
  assert.ok(existsSync(first.archivePath) && existsSync(second.archivePath), "both archives survive");
});
