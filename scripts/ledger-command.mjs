import { constants, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { summarizeFanout, summarizeLedger } from "./admission.mjs";

/**
 * `devharmonics ledger` — look at the spend ledger, and repair it safely.
 *
 * The ledger refuses to be trusted when its records disagree (an altered or
 * corrupted file), and the only sanctioned repair is rotation: archive what is
 * there and start fresh. That used to be a hand-edit against instructions in
 * the manual, which is a terrible remedy for a money file — so it is a command
 * now, and the command is safe by construction:
 *
 *   - a HEALTHY ledger rotates with its lifetime paid total carried forward,
 *     so rotation is never a budget reset;
 *   - an UNTRUSTWORTHY ledger refuses to rotate silently, because its true
 *     total is by definition unknown — the operator must say so out loud with
 *     --reset-totals, and is told exactly what that forgets;
 *   - nothing is ever deleted: the previous file is renamed, never removed.
 */

function ledgerPathFor(stateRoot) {
  return path.join(path.resolve(stateRoot), "usage.jsonl");
}

/** What the ledger currently says — including, honestly, "I can't be trusted". */
export function ledgerStatus(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return { path: ledgerPath, exists: false, healthy: true, records: 0, bytes: 0 };
  }
  const text = readFileSync(ledgerPath, "utf8");
  const records = text.split(/\r?\n/).filter(Boolean).length;
  const status = { path: ledgerPath, exists: true, records, bytes: statSync(ledgerPath).size, healthy: true };
  try {
    status.paidTokens = summarizeLedger(text, true);
  } catch (error) {
    status.healthy = false;
    status.problem = error.message;
  }
  try {
    const fanout = summarizeFanout(text, { since: 0 });
    status.workersAllTime = fanout.workers;
    status.workerTokensAllTime = fanout.tokens;
    status.reportedCostUsdAllTime = fanout.costUsd;
  } catch (error) {
    status.healthy = false;
    status.problem = status.problem ?? error.message;
  }
  return status;
}

/**
 * Archive the ledger and start a fresh one. Returns what happened; throws only
 * when the caller asked for something that would quietly lose money history.
 */
export function rotateLedger(ledgerPath, { now = Date.now(), resetTotals = false } = {}) {
  if (!existsSync(ledgerPath)) return { rotated: false, reason: "there is no ledger to rotate" };
  const status = ledgerStatus(ledgerPath);
  if (!status.healthy && !resetTotals) {
    throw new Error(
      `This ledger cannot be summarized, so its true spend is unknown: ${status.problem}\n`
      + "Rotating it therefore CANNOT carry a total forward — it would start your paid spending back at zero.\n"
      + "Read the archived records first, then re-run with --reset-totals to say so deliberately.",
    );
  }
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  // Never let one archive land on another: two rotations inside the same
  // millisecond, or a stale file with the same name, must not overwrite
  // evidence. A short suffix is added until the name is free.
  let archivePath = `${ledgerPath}.${stamp}.rotated`;
  const carried = status.healthy ? (status.paidTokens ?? 0) : 0;
  const fresh = carried > 0
    ? `${JSON.stringify({
        stage: "terminal",
        invocationId: `carry-forward-${randomUUID()}`,
        taskId: "devharmonics-carry-forward",
        paid: true,
        usage: { total_tokens: carried },
        finishedAt: new Date(now).toISOString(),
        note: `lifetime paid total carried forward at rotation — full history in ${path.basename(archivePath)}`,
      })}\n`
    : "";
  // Order matters (round-4 finding): the original ledger must survive every
  // failure. Copy it to the archive first, stage the replacement beside it,
  // and only then swap atomically — so a full disk or a permission error can
  // never leave the operator with NO ledger and a ceiling reset to zero.
  // Exclusive create, not "check then write": two rotations racing each other
  // must never land on the same archive name and overwrite evidence (round-5
  // finding — the previous existsSync probe left a window between the two).
  for (;;) {
    try {
      copyFileSync(ledgerPath, archivePath, constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      archivePath = `${ledgerPath}.${stamp}-${randomUUID().slice(0, 8)}.rotated`;
    }
  }
  const staged = `${ledgerPath}.rotating`;
  writeFileSync(staged, fresh);
  renameSync(staged, ledgerPath);
  return { rotated: true, archivePath, carriedPaidTokens: carried, totalsReset: !status.healthy };
}

export async function ledgerCommand(argv, { write = (t) => process.stdout.write(t) } = {}) {
  const [subcommand, ...rest] = argv;
  let stateRoot = path.join(process.cwd(), ".devharmonics");
  let resetTotals = false;
  let asJson = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--state-root") { stateRoot = rest[i + 1]; i += 1; }
    else if (rest[i] === "--reset-totals") resetTotals = true;
    else if (rest[i] === "--json") asJson = true;
    else throw new Error(`Unknown ledger option: ${rest[i]}`);
  }
  const ledgerPath = ledgerPathFor(stateRoot);

  if (subcommand === "status") {
    const status = ledgerStatus(ledgerPath);
    if (asJson) { write(`${JSON.stringify(status, null, 2)}\n`); return 0; }
    if (!status.exists) { write(`No ledger yet: ${status.path}\n(one is created the first time a worker or a paid call runs)\n`); return 0; }
    write(`ledger:   ${status.path}\n`);
    write(`size:     ${(status.bytes / 1024).toFixed(1)} KB across ${status.records} records\n`);
    if (status.healthy) {
      write(`paid:     ${(status.paidTokens ?? 0).toLocaleString("en-US")} tokens recorded (lifetime)\n`);
      write(`workers:  ${status.workersAllTime ?? 0} recorded, ${(status.workerTokensAllTime ?? 0).toLocaleString("en-US")} tokens, $${(status.reportedCostUsdAllTime ?? 0).toFixed(2)} reported cost (all time)\n`);
      write("health:   OK — every record agrees with itself\n");
      return 0;
    }
    write(`health:   REFUSING — ${status.problem}\n`);
    write("\nEvery budget check reads this file, so all of them refuse until it is repaired.\n");
    write("Repair it with:  devharmonics ledger rotate\n");
    return 1;
  }

  if (subcommand === "rotate") {
    const result = rotateLedger(ledgerPath, { resetTotals });
    if (!result.rotated) { write(`${result.reason}\n`); return 0; }
    write(`Rotated. Previous ledger kept at:\n  ${result.archivePath}\n`);
    if (result.totalsReset) {
      write("Its spend could not be summarized, so nothing was carried forward — paid totals now start at zero.\n");
    } else {
      write(`Carried forward: ${result.carriedPaidTokens.toLocaleString("en-US")} paid tokens, so your ceiling is unchanged.\n`);
    }
    return 0;
  }

  throw new Error(`Unknown ledger subcommand: ${subcommand ?? "(none)"} — use "status" or "rotate"`);
}
