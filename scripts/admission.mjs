import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    const group = recordsByInvocation.get(identity) ?? { reservations: [], terminals: [] };
    if (entry.stage === "reserved") group.reservations.push(entry);
    else group.terminals.push(entry);
    recordsByInvocation.set(identity, group);
  }

  // MONEY-001 (audit 2026-08-06, round 2): every legitimate flow writes exactly
  // ONE reservation and at most ONE terminal per invocation — `reservePaidUsage`
  // and `admitWorker` mint a fresh UUID per attempt, and a crashed attempt never
  // reuses its identity. So DISAGREEING records for one invocation are not an
  // ambiguity to resolve by arithmetic; they are evidence the ledger was altered.
  // Round 1 took the highest figure, which quietly absorbed a forged line instead
  // of surfacing it — and still let a duplicate RESERVATION lower a not-yet-
  // reconciled charge (proven live: 900 then 100 charged 100). Any conflict now
  // refuses outright, the same fail-closed rule the rest of this file follows.
  // Identical duplicates stay harmless (charged once), preserving the replay
  // safety this design started with.
  const conflict = () => new Error(
    "Usage ledger contains conflicting records for one invocation — the ledger has been altered or corrupted. "
    + "Establish the true spend, then rotate usage.jsonl deliberately (see the manual); it is never repaired by appending.",
  );
  const reportedAmount = (entry) => {
    const total = entry.usage?.total_tokens;
    return Number.isSafeInteger(total) && total >= 0 ? total : null;
  };
  const charge = (group) => {
    if (group.terminals.length) {
      const amounts = group.terminals.map(reportedAmount);
      if (amounts.some((amount) => amount !== amounts[0])) throw conflict();
      // A terminal supersedes its own reservation's estimate: a 5,000-token
      // reservation reconciled to 100 real tokens charges 100, not 5,000.
      if (amounts[0] === null) {
        // Unknown spend is never charged as zero on a PAID run — that closes the
        // paid lane until the owner resolves it deliberately.
        if (paid) throw new Error("Paid usage ledger contains a run without trustworthy token usage");
        return 0;
      }
      return amounts[0];
    }
    if (group.reservations.length > 1
      && group.reservations.some((entry) => entry.reservedTokens !== group.reservations[0].reservedTokens)) {
      throw conflict();
    }
    const entry = group.reservations[0];
    // Reject a NEGATIVE reserved amount too (GAUNTLET, Agent B): a hand-forged
    // ledger line with a negative reservation would otherwise subtract from the
    // running total and mask real spend, defeating the budget cap. The write
    // path (reservePaidUsage) already refuses <= 0; the read/sum path must too.
    if (!Number.isSafeInteger(entry?.reservedTokens) || entry.reservedTokens < 0) {
      throw new Error("Usage ledger contains an invalid reservation");
    }
    return entry.reservedTokens;
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
    maybeCompactLedger(ledgerPath);
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

// ---------------------------------------------------------------------------
// Automatic compaction (owner: "it was supposed to be a silent clean-up as it
// grew beyond a certain size"). The ledger is append-only and replayed on every
// admission, so unbounded growth eventually costs real time on every run.
//
// The naive version of this feature — truncate the file when it gets big — is a
// FAIL-OPEN money bug: it would silently reset every ceiling. So compaction
// never simply drops history. It:
//   * keeps every record that can still affect a live decision,
//   * preserves the lifetime PAID total exactly, via one carry-forward record,
//   * preserves single-use task IDs, via one tiny tombstone per archived run,
//   * writes everything it removed to a dated archive file beside the ledger,
//   * and refuses to run at all if what it would archive is untrustworthy.
// ---------------------------------------------------------------------------

/** Compact when the ledger passes this size (bytes). */
export const LEDGER_COMPACT_BYTES = 5 * 1024 * 1024;
/** Money records older than this are archived (their totals are carried forward). */
export const LEDGER_MONEY_RETENTION_MS = 31 * 24 * 3_600_000;

/**
 * Pure core: given ledger text, return what the compacted ledger and its archive
 * should contain. Returns `{ compacted: false }` when there is nothing safe to
 * do — the caller then leaves the file exactly as it is.
 */
export function compactLedgerText(ledgerText, { now = Date.now(), moneyRetentionMs = LEDGER_MONEY_RETENTION_MS, workerRetentionMs = LEDGER_MONEY_RETENTION_MS } = {}) {
  const lines = ledgerText.split(/\r?\n/).filter(Boolean);
  const groups = new Map();
  const untouchable = []; // legacy records (no invocationId) and prior compaction markers
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return { compacted: false, reason: "ledger contains a line that is not valid JSON — refusing to compact an unreadable ledger" };
    }
    // Legacy records pair by taskId/FIFO and prior markers are history: never move them.
    if (!entry.invocationId || entry.stage === "compacted") { untouchable.push({ line, entry }); continue; }
    const group = groups.get(entry.invocationId) ?? { lines: [], entries: [], newest: -Infinity, undateable: false };
    const stamp = Date.parse(entry.startedAt ?? entry.finishedAt ?? "");
    if (Number.isFinite(stamp)) group.newest = Math.max(group.newest, stamp);
    else group.undateable = true;
    group.lines.push(line);
    group.entries.push(entry);
    groups.set(entry.invocationId, group);
  }

  const keptLines = [];
  const archivedLines = [];
  const tombstones = [];
  let carriedPaidTokens = 0;
  let archivedRuns = 0;

  for (const [invocationId, group] of groups) {
    const isWorker = group.entries.some((entry) => entry.kind === "worker");
    const retention = isWorker ? workerRetentionMs : moneyRetentionMs;
    // Undateable records err toward KEEPING — the same fail-closed instinct the
    // ceilings use. Anything inside its retention window stays verbatim.
    if (group.undateable || group.newest >= now - retention || group.entries.some((e) => e.stage === "archived")) {
      keptLines.push(...group.lines);
      continue;
    }
    // Old enough to archive. A paid run whose spend is untrustworthy or
    // self-contradictory must stay visible in the live ledger — compacting it
    // away would quietly un-poison a closed lane.
    const paidEntries = group.entries.filter((entry) => entry.paid === true);
    if (paidEntries.length) {
      let charge;
      try {
        charge = summarizeLedger(group.lines.join("\n"), true);
      } catch (error) {
        return { compacted: false, reason: `refusing to compact: an archivable paid run is untrustworthy (${error.message})` };
      }
      carriedPaidTokens += charge;
    }
    archivedLines.push(...group.lines);
    archivedRuns += 1;
    const sample = group.entries[0];
    // Tombstone: just enough to keep a task ID single-use forever. `stage:
    // "archived"` is ignored by every summary, so it can never be mistaken for
    // spend or for a live worker.
    tombstones.push(JSON.stringify({
      stage: "archived",
      invocationId,
      taskId: sample.taskId ?? null,
      ...(isWorker ? { kind: "worker" } : {}),
      archivedAt: new Date(now).toISOString(),
    }));
  }

  if (!archivedRuns) return { compacted: false, reason: "nothing is old enough to archive" };

  const marker = JSON.stringify({
    stage: "compacted",
    at: new Date(now).toISOString(),
    archivedRuns,
    carriedPaidTokens,
  });
  const carry = carriedPaidTokens > 0
    ? [JSON.stringify({
        stage: "terminal",
        invocationId: `carry-forward-${randomUUID()}`,
        taskId: "devharmonics-carry-forward",
        paid: true,
        usage: { total_tokens: carriedPaidTokens },
        finishedAt: new Date(now).toISOString(),
        note: "lifetime paid total preserved from archived records — see the archive file beside this ledger",
      })]
    : [];

  const text = `${[...untouchable.map((u) => u.line), ...keptLines, ...tombstones, ...carry, marker].join("\n")}\n`;
  // A tombstone plus a carry-forward record can cost more than the handful of
  // lines they replace. Rewriting the ledger to make it BIGGER would be pure
  // churn on the money file, so a compaction that doesn't pay for itself simply
  // doesn't happen.
  if (text.length >= ledgerText.length) {
    return { compacted: false, reason: "compaction would not reclaim any space yet" };
  }
  return { compacted: true, text, archiveText: `${archivedLines.join("\n")}\n`, archivedRuns, carriedPaidTokens };
}

/**
 * Compact `usage.jsonl` in place when it has grown past the threshold. MUST be
 * called with the ledger lock already held. Never throws: a compaction that
 * cannot be done safely simply doesn't happen, and the run continues against
 * the full ledger.
 */
export function maybeCompactLedger(ledgerPath, { now = Date.now(), thresholdBytes = LEDGER_COMPACT_BYTES, workerRetentionMs = LEDGER_MONEY_RETENTION_MS } = {}) {
  try {
    if (!existsSync(ledgerPath)) return { compacted: false };
    if (statSync(ledgerPath).size < thresholdBytes) return { compacted: false };
    const result = compactLedgerText(readFileSync(ledgerPath, "utf8"), { now, workerRetentionMs });
    if (!result.compacted) return result;
    const archivePath = `${ledgerPath}.${new Date(now).toISOString().slice(0, 10)}.archive`;
    // Archive FIRST: if this write fails, the live ledger is untouched.
    appendFileSync(archivePath, result.archiveText);
    writeFileSync(ledgerPath, result.text);
    return { compacted: true, archivePath, archivedRuns: result.archivedRuns, carriedPaidTokens: result.carriedPaidTokens };
  } catch (error) {
    return { compacted: false, reason: `compaction skipped: ${error.message}` };
  }
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
    maybeCompactLedger(ledgerPath);
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
    // Compaction tombstones carry the original kind so task-ID reuse detection
    // survives; they are history, never a live worker holding a slot.
    if (entry.stage === "archived") continue;
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
    // Same rule as the money summary: disagreeing terminal records for one
    // worker mean the ledger was altered, and a meter that cannot be trusted
    // refuses rather than picking a number. Identical duplicates are harmless.
    const terminals = group.records.filter((entry) => entry.stage !== "reserved");
    const reported = terminals.map((entry) => {
      const total = entry.usage?.total_tokens;
      // v1 port (b): real REPORTED dollars, where a run reported them (claude's
      // headless receipts carry total_cost_usd; local models report none and
      // honestly contribute $0 — the token ceilings remain their guard).
      const cost = entry.usage?.cost_usd;
      return {
        tokens: Number.isSafeInteger(total) && total > 0 ? total : 0,
        cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      };
    });
    if (reported.some((r) => r.tokens !== reported[0].tokens || r.cost !== reported[0].cost)) {
      throw new Error(
        "Fan-out ledger contains conflicting records for one worker — the ledger has been altered or corrupted. "
        + "Establish the true usage, then rotate usage.jsonl deliberately (see the manual); it is never repaired by appending.",
      );
    }
    tokens += reported[0]?.tokens ?? 0;
    costUsd += reported[0]?.cost ?? 0;
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
    // Worker records must survive at least the operator's own rolling window,
    // or compaction would quietly hand back fan-out headroom it never earned.
    maybeCompactLedger(ledgerPath, { workerRetentionMs: Math.max(LEDGER_MONEY_RETENTION_MS, windowHours * 3_600_000 * 1.1) });
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
