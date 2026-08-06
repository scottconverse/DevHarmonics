import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { acquireFileLock } from "./slots.mjs";

/**
 * Ported from codex-factory scripts/factory-admission.mjs (same owner,
 * Apache-2.0, live-fire-tested 2026-08). Append-only `usage.jsonl` money
 * guards, unchanged in behavior. Every write goes through `acquireFileLock`
 * so two concurrent invocations can never both reserve against the same
 * remaining budget. Reads never trust a single record: the ledger is replayed
 * end-to-end and the HIGHEST amount any of an invocation's terminal records
 * reports is what counts (MONEY-001, audit 2026-08-06 — latest-wins let an
 * appended line silently LOWER recorded spend), so neither a duplicate write
 * nor a forged append can double- or under-charge.
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
  const recordsByInvocation = new Map();
  const legacyPending = new Map();
  let legacySequence = 0;

  const standaloneLegacy = new Set();
  for (const [index, line] of ledgerText.split(/\r?\n/).entries()) {
    if (!line) continue;
    const entry = JSON.parse(line);
    // ENG-010 (audit): fan-out worker records cohabit this ledger; the money
    // summaries must never count them (their unpaid reservations carry
    // reservedTokens 0 and would skew any future unpaid-path caller).
    if (entry.kind === "worker") continue;
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
    const group = recordsByInvocation.get(identity) ?? { reservation: null, terminals: [] };
    if (entry.stage === "reserved") group.reservation = entry;
    else group.terminals.push(entry);
    recordsByInvocation.set(identity, group);
  }

  // MONEY-001 (audit 2026-08-06): the charge for an invocation is the HIGHEST
  // amount any of its terminal records reports — not the latest one. Latest-wins
  // stopped a duplicate terminal from double-charging, but it also let ANY later
  // append silently LOWER recorded spend (proven: one line erased 900,000
  // tokens). Highest-wins keeps the duplicate protection, makes an undercount
  // impossible to append, and still lets `reconcilePaidUsage` correct a record
  // upward. Lowering a recorded charge now requires deliberate ledger rotation —
  // a visible act — exactly as the manual describes.
  const charge = (group) => {
    if (!group.terminals.length) {
      const entry = group.reservation;
      // Reject a NEGATIVE reserved amount too (GAUNTLET, Agent B): a hand-forged
      // ledger line with a negative reservation would otherwise subtract from the
      // running total and mask real spend, defeating the budget cap. The write
      // path (reservePaidUsage) already refuses <= 0; the read/sum path must too.
      if (!Number.isSafeInteger(entry?.reservedTokens) || entry.reservedTokens < 0) {
        throw new Error("Usage ledger contains an invalid reservation");
      }
      return entry.reservedTokens;
    }
    // A terminal supersedes the reservation's estimate. Among terminals: any
    // untrustworthy one still poisons a PAID invocation (unknown spend must
    // never be charged as zero), and otherwise the largest reported figure wins.
    let highest = null;
    for (const terminal of group.terminals) {
      const total = terminal.usage?.total_tokens;
      if (Number.isSafeInteger(total) && total >= 0) highest = Math.max(highest ?? 0, total);
      else if (paid) throw new Error("Paid usage ledger contains a run without trustworthy token usage");
    }
    return highest ?? 0;
  };
  return [...recordsByInvocation.values()].reduce((total, group) => total + charge(group), 0);
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
    if (ledgerText.split(/\r?\n/).filter(Boolean).some((line) => { const e = JSON.parse(line); return e.kind !== "worker" && e.taskId === taskId; })) {
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
      .some((line) => { const e = JSON.parse(line); return e.kind !== "worker" && e.taskId === taskId; })) {
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

// ---------------------------------------------------------------------------
// Fan-out ceilings (owner decision D1, 2026-08-05). The exposure this guards
// is runaway AGENT SPAWNING, not paid-API dollars — reference incident: 255
// agents and >300,000,000 tokens in ~45 minutes. Hard, fail-closed caps on
// the total number of workers admitted and the cumulative tokens they report,
// per state root, within a rolling window. Reservation happens BEFORE any
// spawn; reconciliation after; a ledger that cannot be read refuses admission
// rather than waving the worker through.
// ---------------------------------------------------------------------------

/**
 * Replay the ledger's `kind: "worker"` records (latest per invocation) and
 * report how many workers were admitted since `since` (ms epoch) and the
 * total tokens their terminal records carried. An in-flight reservation
 * counts as a worker (that is the point — concurrent admits are spend too);
 * its tokens count as 0 until reconciled. A malformed line throws: a budget
 * ledger that cannot be trusted refuses, never guesses.
 */
export function summarizeFanout(ledgerText, { since = 0 } = {}) {
  const groups = new Map();
  const admittedAt = new Map();
  // TEST-004/ENG-006 (audit): a record the meter cannot DATE counts as always
  // in-window — it errs toward the cap, never out of it. The old `|| 0` mapped
  // a garbage timestamp to the epoch, which every rolling window then excluded
  // as ancient: a fail-open hole in a fail-closed cap (and the old `?? 0`
  // after Date.parse was dead — NaN is not nullish).
  const dateOrInfinity = (value) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : Infinity;
  };
  for (const [index, line] of ledgerText.split(/\r?\n/).entries()) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`fan-out ledger line ${index + 1} is not valid JSON: ${error.message}`);
    }
    if (entry.kind !== "worker") continue;
    if (!entry.invocationId) throw new Error(`fan-out ledger line ${index + 1} has no invocationId`);
    if (entry.stage === "reserved") admittedAt.set(entry.invocationId, dateOrInfinity(entry.startedAt));
    const group = groups.get(entry.invocationId) ?? { records: [] };
    group.records.push(entry);
    groups.set(entry.invocationId, group);
  }
  let workers = 0;
  let tokens = 0;
  let costUsd = 0;
  for (const [invocationId, group] of groups) {
    const first = group.records[0];
    const startedAt = admittedAt.get(invocationId) ?? dateOrInfinity(first.startedAt ?? first.finishedAt);
    if (startedAt < since) continue;
    workers += 1;
    // MONEY-001 (audit 2026-08-06): highest-reported wins, same rule as the
    // money summary — a later appended record can no longer erase a worker's
    // recorded tokens or dollars (proven: one line zeroed 5,000 tokens and $250).
    let highestTokens = 0;
    let highestCost = 0;
    for (const entry of group.records) {
      const total = entry.usage?.total_tokens;
      if (Number.isSafeInteger(total) && total > 0) highestTokens = Math.max(highestTokens, total);
      // v1 port (b): real REPORTED dollars, where a run reported them (claude's
      // headless receipts carry total_cost_usd; local models report none and
      // honestly contribute $0 — the token ceilings remain their guard).
      const cost = entry.usage?.cost_usd;
      if (Number.isFinite(cost) && cost > 0) highestCost = Math.max(highestCost, cost);
    }
    tokens += highestTokens;
    costUsd += highestCost;
  }
  return { workers, tokens, costUsd };
}

/**
 * Admit one worker against the fan-out ceilings, appending its reservation
 * under the same exclusive lock the money paths use — two concurrent admits
 * can never both squeeze under the same remaining headroom. Refusals return
 * `{ admitted: false, reason }` rather than throwing: a refusal is a normal,
 * reportable outcome the caller turns into an honest failed receipt.
 */
export async function admitWorker({ stateRoot, taskId, lane, budgets, metadata = {} }) {
  const { maxWorkers, maxTotalTokens, windowHours, monthlyLimitUsd } = budgets ?? {};
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0) throw new Error("admitWorker: budgets.maxWorkers must be a positive integer");
  if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens <= 0) throw new Error("admitWorker: budgets.maxTotalTokens must be a positive integer");
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("admitWorker: budgets.windowHours must be a positive number");
  if (monthlyLimitUsd !== undefined && (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0)) {
    throw new Error("admitWorker: budgets.monthlyLimitUsd must be a positive number when present");
  }
  mkdirSync(stateRoot, { recursive: true });
  const ledgerPath = path.join(stateRoot, "usage.jsonl");
  const lock = await acquireFileLock(path.join(stateRoot, "usage.lock"), { taskId, stage: "reserved", kind: "worker" });
  try {
    const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    const since = Date.now() - windowHours * 3_600_000;
    const { workers, tokens } = summarizeFanout(ledgerText, { since });
    if (workers + 1 > maxWorkers) {
      return {
        admitted: false,
        workers,
        tokens,
        ledgerPath,
        reason: `fanout-workers-exceeded: ${workers} of ${maxWorkers} workers already admitted in the last ${windowHours}h (ledger: ${ledgerPath}). Raise budgets.maxWorkers in the project's .devharmonics/config.json (see: devharmonics config show), rotate the ledger file deliberately, or wait for the window to pass.`,
      };
    }
    if (tokens >= maxTotalTokens) {
      return {
        admitted: false,
        workers,
        tokens,
        ledgerPath,
        reason: `fanout-tokens-exceeded: ${tokens} of ${maxTotalTokens} tokens already spent in the last ${windowHours}h (ledger: ${ledgerPath}). Raise budgets.maxTotalTokens in the project's .devharmonics/config.json (see: devharmonics config show), rotate the ledger file deliberately, or wait for the window to pass.`,
      };
    }
    // v1 port (b): the monthly USD ceiling — a rolling 30 days, summed from
    // the REPORTED cost on this ledger's worker records. It stops the NEXT
    // worker once recorded spend reaches the limit; runs that report no cost
    // contribute $0 (the token ceilings above are their guard — stated
    // honestly, never estimated from a price table).
    if (Number.isFinite(monthlyLimitUsd)) {
      const monthly = summarizeFanout(ledgerText, { since: Date.now() - 30 * 24 * 3_600_000 });
      if (monthly.costUsd >= monthlyLimitUsd) {
        return {
          admitted: false,
          workers,
          tokens,
          costUsd: monthly.costUsd,
          ledgerPath,
          reason: `paid-monthly-usd-exceeded: $${monthly.costUsd.toFixed(2)} of the $${monthlyLimitUsd} budgets.monthlyLimitUsd already reported in the last 30 days (ledger: ${ledgerPath}). Raise the limit in the project's .devharmonics/config.json (see: devharmonics config show), rotate the ledger file deliberately, or wait for spend to age out of the window.`,
        };
      }
    }
    const invocationId = createInvocationId();
    const record = {
      stage: "reserved",
      kind: "worker",
      invocationId,
      taskId,
      lane: lane ?? null,
      paid: false,
      reservedTokens: 0,
      startedAt: new Date().toISOString(),
      ...metadata,
    };
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    return { admitted: true, invocationId, workers: workers + 1, tokens, ledgerPath, record };
  } finally {
    lock.release();
  }
}

/** Close out an admitted worker with its real reported usage (null = honestly unknown, charged 0). */
export async function reconcileWorker({ stateRoot, invocationId, taskId, status, totalTokens = null, costUsd = null, metadata = {} }) {
  const ledgerPath = path.join(stateRoot, "usage.jsonl");
  const lock = await acquireFileLock(path.join(stateRoot, "usage.lock"), { taskId, invocationId, stage: "terminal", kind: "worker" });
  try {
    const usage = {};
    if (Number.isSafeInteger(totalTokens) && totalTokens > 0) usage.total_tokens = totalTokens;
    if (Number.isFinite(costUsd) && costUsd > 0) usage.cost_usd = costUsd;
    const record = {
      stage: "terminal",
      kind: "worker",
      invocationId,
      taskId,
      paid: false,
      status: status ?? null,
      usage: Object.keys(usage).length ? usage : null,
      finishedAt: new Date().toISOString(),
      ...metadata,
    };
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    return record;
  } finally {
    lock.release();
  }
}

/**
 * Where a worker's fan-out ledger lives when the caller did not say: the
 * nearest enclosing `.devharmonics` state directory of its runsRoot (the
 * pipeline, the worker/acp commands, and reviewers all place runs under
 * one), else a `.fanout` directory inside the runsRoot — so even an
 * out-of-tree caller is metered SOMEWHERE rather than nowhere, without the
 * meter's files masquerading as run directories.
 */
export function deriveStateRoot(runsRoot) {
  const resolved = path.resolve(runsRoot);
  const segments = resolved.split(path.sep);
  // ENG-008 (audit): match case-insensitively where the filesystem does — a
  // differently-cased ".DevHarmonics" is the SAME directory on win32/darwin,
  // and an exact match silently forked the meter into a nested .fanout there.
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const matches = (segment) => (caseInsensitive ? segment.toLowerCase() === ".devharmonics" : segment === ".devharmonics");
  const index = segments.findLastIndex(matches);
  if (index >= 0) return segments.slice(0, index + 1).join(path.sep);
  return path.join(resolved, ".fanout");
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
