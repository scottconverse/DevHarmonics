import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { acquireFileLock } from "./slots.mjs";

/**
 * Ported from codex-factory scripts/factory-admission.mjs (same owner,
 * Apache-2.0, live-fire-tested 2026-08). Append-only `usage.jsonl` money
 * guards, unchanged in behavior. Every write goes through `acquireFileLock`
 * so two concurrent invocations can never both reserve against the same
 * remaining budget. Reads never trust a single record: the ledger is
 * replayed end-to-end and only the LATEST record per invocation counts,
 * so a duplicate/replayed terminal write can never double- or under-charge.
 */

export function createInvocationId() {
  return randomUUID();
}

/**
 * Replay a `usage.jsonl` ledger and return the total tokens charged for
 * `paid` runs (or unpaid runs, when `paid` is false).
 *
 * Legacy-entry disambiguation: older ledger lines have no `invocationId`.
 * A legacy "reserved" line mints a synthetic `legacy:<taskId>:<n>` identity
 * and queues it; a legacy terminal line for the same taskId claims the
 * oldest still-pending synthetic identity (FIFO), so repeated attempts at
 * the same taskId still pair reservation-to-terminal correctly. A legacy
 * line with no `stage` at all (a one-shot completed record, never reserved)
 * gets its own synthetic identity, once per taskId. Any terminal line for a
 * taskId that already exhausted its pending reservations AND already has a
 * standalone identity is genuinely unpairable — that is an ambiguous ledger,
 * and this throws rather than guessing which run it belongs to.
 *
 * Fail-closed money rule: a paid run's terminal record MUST carry a
 * trustworthy `usage.total_tokens`. A paid record without one is a "we
 * don't actually know what this cost" — it throws rather than charging
 * zero, because charging zero would silently under-count real spend.
 * Unpaid (free/local) runs have no budget to protect, so the same
 * situation charges zero for them instead of throwing.
 */
export function summarizeLedger(ledgerText, paid) {
  const latestByInvocation = new Map();
  const legacyPending = new Map();
  let legacySequence = 0;

  const standaloneLegacy = new Set();
  for (const [index, line] of ledgerText.split(/\r?\n/).entries()) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.paid !== paid) continue;
    let identity = entry.invocationId;
    if (!identity) {
      const key = String(entry.taskId ?? "");
      if (entry.stage === "reserved") {
        identity = `legacy:${key}:${legacySequence += 1}`;
        const pending = legacyPending.get(key) ?? [];
        pending.push(identity);
        legacyPending.set(key, pending);
      } else {
        const pending = legacyPending.get(key) ?? [];
        if (pending.length) {
          identity = pending.shift();
        } else if (!entry.stage && !standaloneLegacy.has(key)) {
          identity = `legacy:${key}:${legacySequence += 1}`;
          standaloneLegacy.add(key);
        } else {
          throw new Error(`Ambiguous legacy usage ledger entry for task ${key || "<missing>"} at line ${index + 1}: terminal record has no matching reservation`);
        }
      }
    }
    latestByInvocation.set(identity, entry);
  }

  const charge = (entry) => {
    if (entry.stage === "reserved") {
      // Reject a NEGATIVE reserved amount too (GAUNTLET, Agent B): a hand-forged
      // ledger line with a negative reservation would otherwise subtract from the
      // running total and mask real spend, defeating the budget cap. The write
      // path (reservePaidUsage) already refuses <= 0; the read/sum path must too.
      if (!Number.isSafeInteger(entry.reservedTokens) || entry.reservedTokens < 0) {
        throw new Error("Usage ledger contains an invalid reservation");
      }
      return entry.reservedTokens;
    }
    if (!Number.isSafeInteger(entry.usage?.total_tokens)) {
      if (paid) throw new Error("Paid usage ledger contains a run without trustworthy token usage");
      return 0;
    }
    return entry.usage.total_tokens;
  };
  return [...latestByInvocation.values()].reduce((total, entry) => total + charge(entry), 0);
}

/**
 * Reserve an unpaid (free/local) task attempt. No aggregate budget applies —
 * unpaid capacity has no spend to protect — but a given taskId still may not
 * be reserved twice, so a crashed/duplicate dispatch cannot silently attempt
 * the same task concurrently.
 */
export async function reserveUnpaidTaskUsage({ stateRoot, taskId, metadata = {} }) {
  const ledgerPath = path.join(stateRoot, "usage.jsonl");
  const lock = await acquireFileLock(path.join(stateRoot, "usage.lock"), { taskId, stage: "reserved", paid: false });
  try {
    const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    if (ledgerText.split(/\r?\n/).filter(Boolean).some((line) => JSON.parse(line).taskId === taskId)) {
      throw new Error(`Task ${taskId} already has an attempt`);
    }
    const invocationId = createInvocationId();
    const record = {
      stage: "reserved",
      invocationId,
      taskId,
      paid: false,
      reservedTokens: null,
      startedAt: new Date().toISOString(),
      ...metadata,
    };
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    return { invocationId, ledgerPath, record };
  } finally {
    lock.release();
  }
}

export function usageSpent(ledgerPath, paid = true) {
  return existsSync(ledgerPath) ? summarizeLedger(readFileSync(ledgerPath, "utf8"), paid) : 0;
}

/**
 * Reserve a paid attempt against `aggregateLimit` total tokens. Fails closed:
 * the reservation is refused whenever it would push spend past the
 * remaining budget, computed from a fresh replay of the ledger taken under
 * the same exclusive lock as the write — no other process can slip a
 * reservation in between the read and the append.
 */
export async function reservePaidUsage({
  stateRoot,
  aggregateLimit,
  reservedTokens,
  taskId,
  metadata = {},
  rejectTaskReuse = false,
}) {
  if (!Number.isSafeInteger(reservedTokens) || reservedTokens <= 0) {
    throw new Error("Paid invocation requires a positive token reservation");
  }
  const ledgerPath = path.join(stateRoot, "usage.jsonl");
  const lock = await acquireFileLock(path.join(stateRoot, "usage.lock"), { taskId, stage: "reserved" });
  try {
    const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    if (rejectTaskReuse && ledgerText.split(/\r?\n/).filter(Boolean)
      .some((line) => JSON.parse(line).taskId === taskId)) {
      throw new Error(`Task ${taskId} already has an attempt`);
    }
    const spent = summarizeLedger(ledgerText, true);
    const remaining = aggregateLimit - spent;
    if (reservedTokens > remaining) {
      throw new Error(`Reservation ${reservedTokens} exceeds remaining budget ${remaining}`);
    }
    const invocationId = createInvocationId();
    const record = {
      stage: "reserved",
      invocationId,
      taskId,
      paid: true,
      reservedTokens,
      startedAt: new Date().toISOString(),
      ...metadata,
    };
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    return { invocationId, ledgerPath, spent, remaining, record };
  } finally {
    lock.release();
  }
}

/** Close out a paid reservation with the run's real (reported) usage. */
export async function reconcilePaidUsage({ stateRoot, invocationId, taskId, usage, metadata = {} }) {
  const ledgerPath = path.join(stateRoot, "usage.jsonl");
  const lock = await acquireFileLock(path.join(stateRoot, "usage.lock"), { taskId, invocationId, stage: "terminal" });
  try {
    const record = {
      stage: "terminal",
      invocationId,
      taskId,
      paid: true,
      usage,
      finishedAt: new Date().toISOString(),
      ...metadata,
    };
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    return record;
  } finally {
    lock.release();
  }
}
