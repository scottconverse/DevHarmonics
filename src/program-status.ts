import type { ProductRecord } from "./ledger.js";
import type { ObjectiveRecord, RunSummary } from "./types.js";
import { projectInbox } from "./inbox.js";

/**
 * DH-645 S2. The program view is a PURE projection of existing ledger state
 * — same discipline as `projectInbox` (src/inbox.ts): no new schema, no
 * writes, nothing invented. It answers "how is the whole program doing?" by
 * sorting every run the ledger currently knows about (the caller — see
 * `GET /api/inbox` in src/server.ts — passes `Ledger.listAllRuns()`, which
 * genuinely returns every run on record, NOT the 50-most-recent-capped
 * `Ledger.listRuns()` that backs the `/api/runs` sidebar; see
 * `listAllRuns`'s doc comment in src/ledger.ts for why and at what query
 * cost) into exactly one of five buckets.
 *
 * BUCKET PRECEDENCE (a run is classified by the first rule it matches; a run
 * matches exactly one bucket):
 *
 *   1. waiting_on_you — the run has at least one item in the approval inbox
 *      (`projectInbox`): an awaiting-approval plan, a pending/failed
 *      delivery step, or a paused run. This bucket is DEFINED as "exactly
 *      the runs with inbox items" by construction (this module calls
 *      `projectInbox` itself rather than re-deriving the same predicates a
 *      second time) — the two views can never disagree about who is
 *      waiting on the owner.
 *   2. retrying — not already waiting_on_you, the run's own RunStatus is
 *      'planning' or 'running' (the two "live" statuses — see LIVE_RUN_STATUSES
 *      below), and at least one task on the run currently has TaskStatus
 *      'retry' (src/domain.ts). A task in retry is a live worker loop ONLY
 *      when the run itself is still live: the orchestrator's failure path
 *      can leave a task at 'retry' on a run that has already reached a
 *      terminal RunStatus (runTransitions in src/domain.ts permits
 *      'failed'/'cancelled' from 'running' independent of task state), and
 *      by then there is no worker left retrying anything — reporting
 *      "retrying" there would be an unobserved claim dressed up as a fact
 *      (this project's honesty standard: unobserved is never confirmation).
 *      A terminal run with a stale retry task instead falls through to
 *      bucket 5, finished.
 *   3. stalled — not already claimed above, run.status is 'running' or
 *      'planning' (RUN_STATUSES, src/domain.ts — the two "live" statuses),
 *      and the run's last ledger activity is at or past
 *      `PROGRAM_QUIET_THRESHOLD_MS` in the past.
 *   4. moving — not already claimed above, run.status is 'running' or
 *      'planning', and last activity is within the threshold.
 *   5. finished — everything else: 'ready' runs with no pending delivery
 *      step (a 'ready' run WITH a pending step is already waiting_on_you
 *      per rule 1), plus 'not_ready', 'failed', and 'cancelled'.
 *
 * The owner-actionable state always wins: a run that is both quiet AND
 * needs an approval is reported as waiting_on_you, never stalled, because
 * "stalled" would wrongly suggest nothing can be done about it right now.
 *
 * HEARTBEAT EVIDENCE (rules 3/4): DH-632's cockpit heartbeat
 * (`taskActivityTimes`/`quietMarkup` in src/ui/app.js) times a single
 * active task from its own events and treats "no active task" as "nothing
 * to report" (no warning shown at all). At PROGRAM scope a run can be
 * 'running' with every task between attempts (none currently 'working' or
 * 'verifying'), and staying silent there would hide a genuinely stuck
 * scheduler. This module instead takes the most recent `createdAt` across
 * ALL of the run's events (every run has at least a `run.created` event),
 * falling back to `run.updatedAt`/`run.createdAt` if the event list is
 * ever empty — still nothing but durable ledger timestamps, never a guess.
 * The threshold constant is the SAME `PROGRAM_QUIET_THRESHOLD_MS` as
 * app.js's `OPERATION_QUIET_WARNING_MS` (5 minutes) — no second threshold.
 *
 * GROUPING: a run groups under its product's name when it is linked to a
 * registered product in the `products` list passed in. The authoritative
 * link is `Objective.productId` (src/types.ts — set when the owner picks a
 * product for the objective, see the "objective-product" picker in
 * src/ui/index.html), reached via `run.objectiveId` and the `objectives`
 * list passed in. `run.integrationSet.productId` (a second, DERIVED copy of
 * the same id — see `Orchestrator.executeMultiRepository`,
 * src/orchestrator.ts, which reads `input.objective.productId` and hands it
 * straight to `Ledger.createIntegrationSet`) is checked as a fallback for
 * completeness but should never disagree with the objective in practice.
 * Using the objective as primary matters because `IntegrationSetRecord` is
 * ONLY ever created for MULTI-repository execution (orchestrator.ts:
 * "Multi-repository execution requires a registered product") — a run
 * against a single product-linked repository has no integration set at
 * all, and grouping by integration set alone would silently drop it into
 * the repository-path fallback instead of its product. A run with no
 * objective link and no integration set groups under its own `projectPath`,
 * per the design brief's "runs with no product group under their
 * repository path."
 */
export const PROGRAM_QUIET_THRESHOLD_MS = 5 * 60 * 1000;

export const PROGRAM_BUCKETS = ["waiting_on_you", "retrying", "stalled", "moving", "finished"] as const;
export type ProgramBucket = (typeof PROGRAM_BUCKETS)[number];

export interface ProgramRunEntry {
  runId: string;
  bucket: ProgramBucket;
  goalSummary: string;
  /** Plain-English reason this run is in this bucket, e.g. "2 of 5 tasks done". */
  reason: string;
  groupKey: string;
  groupLabel: string;
}

export type ProgramBucketCounts = Record<ProgramBucket, number>;

function emptyCounts(): ProgramBucketCounts {
  return { waiting_on_you: 0, retrying: 0, stalled: 0, moving: 0, finished: 0 };
}

export interface ProgramGroup {
  key: string;
  label: string;
  counts: ProgramBucketCounts;
  runs: ProgramRunEntry[];
}

export interface ProgramStatus {
  groups: ProgramGroup[];
  totals: ProgramBucketCounts;
}

const LIVE_RUN_STATUSES = new Set(["running", "planning"]);

/** Most recent ledger timestamp known for this run, or null if none can be parsed. */
function runLastActivityAt(run: Pick<RunSummary, "events" | "updatedAt" | "createdAt">): number | null {
  let latest: number | null = null;
  for (const event of run.events) {
    const at = Date.parse(event.createdAt);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  if (latest !== null) return latest;
  const updated = Date.parse(run.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(run.createdAt);
  return Number.isFinite(created) ? created : null;
}

function formatQuietDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function taskProgress(run: RunSummary): { passed: number; total: number } {
  const total = run.tasks.length;
  const passed = run.tasks.filter((task) => task.status === "passed").length;
  return { passed, total };
}

function progressReason(run: RunSummary): string {
  const { passed, total } = taskProgress(run);
  if (total === 0) return "planning the work";
  return `${passed} of ${total} task${total === 1 ? "" : "s"} done`;
}

function waitingReason(items: readonly { plainSummary: string }[]): string {
  if (items.length === 1) return items[0]!.plainSummary;
  return `${items.length} decisions need your attention`;
}

function retryingReason(run: RunSummary, retryTask: RunSummary["tasks"][number]): string {
  return `"${retryTask.title}" is retrying (attempt ${retryTask.attemptCount})`;
}

function stalledReason(quietMs: number): string {
  return `quiet for ${formatQuietDuration(quietMs)} — the provider call may still be running`;
}

function finishedReason(run: RunSummary): string {
  if (run.status === "ready") {
    const { passed, total } = taskProgress(run);
    return total > 0 ? `${passed} of ${total} task${total === 1 ? "" : "s"} done` : "ready — nothing pending";
  }
  if (run.status === "not_ready") return "not ready — see the run for what didn't pass";
  if (run.status === "failed") return "failed — see the run for details";
  return "cancelled";
}

function groupFor(
  run: RunSummary,
  productsById: Map<string, ProductRecord>,
  objectivesById: Map<string, ObjectiveRecord>,
): { key: string; label: string } {
  const objectiveProductId = run.objectiveId ? objectivesById.get(run.objectiveId)?.productId : undefined;
  const productId = objectiveProductId ?? run.integrationSet?.productId ?? null;
  const product = productId ? productsById.get(productId) : undefined;
  if (product) return { key: `product:${product.id}`, label: product.name };
  return { key: `path:${run.projectPath}`, label: run.projectPath };
}

/**
 * Pure projection of ledger-shaped runs (as returned by `Ledger.listRuns`)
 * into the program view: every run classified into exactly one bucket
 * (see module JSDoc for the precedence order), grouped by product where a
 * run is linked to one, otherwise by repository path. Read-only; derives no
 * new persisted state.
 */
export function projectProgramStatus(
  runs: readonly RunSummary[],
  products: readonly ProductRecord[] = [],
  objectives: readonly ObjectiveRecord[] = [],
  now: number = Date.now(),
): ProgramStatus {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const objectivesById = new Map(objectives.map((objective) => [objective.id, objective]));

  const waitingItemsByRun = new Map<string, { plainSummary: string }[]>();
  for (const item of projectInbox(runs)) {
    const list = waitingItemsByRun.get(item.runId) ?? [];
    list.push({ plainSummary: item.plainSummary });
    waitingItemsByRun.set(item.runId, list);
  }

  const groups = new Map<string, ProgramGroup>();
  const totals = emptyCounts();

  for (const run of runs) {
    const waitingItems = waitingItemsByRun.get(run.id);
    // A retry task only reflects a LIVE worker loop when the run itself is
    // still 'planning'/'running' — a terminal run (ready/not_ready/failed/
    // cancelled) can retain a stale 'retry' task from before it terminated,
    // and nothing is actively retrying it anymore (M-terminal-retry).
    const retryTask = LIVE_RUN_STATUSES.has(run.status)
      ? run.tasks.find((task) => task.status === "retry")
      : undefined;

    let bucket: ProgramBucket;
    let reason: string;
    if (waitingItems) {
      bucket = "waiting_on_you";
      reason = waitingReason(waitingItems);
    } else if (retryTask) {
      bucket = "retrying";
      reason = retryingReason(run, retryTask);
    } else if (LIVE_RUN_STATUSES.has(run.status)) {
      const lastActivityAt = runLastActivityAt(run);
      const quietMs = lastActivityAt === null ? 0 : now - lastActivityAt;
      if (lastActivityAt !== null && quietMs >= PROGRAM_QUIET_THRESHOLD_MS) {
        bucket = "stalled";
        reason = stalledReason(quietMs);
      } else {
        bucket = "moving";
        reason = progressReason(run);
      }
    } else {
      bucket = "finished";
      reason = finishedReason(run);
    }

    const { key, label } = groupFor(run, productsById, objectivesById);
    let group = groups.get(key);
    if (!group) {
      group = { key, label, counts: emptyCounts(), runs: [] };
      groups.set(key, group);
    }
    group.counts[bucket] += 1;
    totals[bucket] += 1;
    group.runs.push({
      runId: run.id,
      bucket,
      goalSummary: run.goalSummary || run.goal,
      reason,
      groupKey: key,
      groupLabel: label,
    });
  }

  const bucketOrder = new Map(PROGRAM_BUCKETS.map((bucket, index) => [bucket, index]));
  for (const group of groups.values()) {
    group.runs.sort((a, b) => {
      const byBucket = bucketOrder.get(a.bucket)! - bucketOrder.get(b.bucket)!;
      if (byBucket !== 0) return byBucket;
      return a.goalSummary.localeCompare(b.goalSummary);
    });
  }

  return {
    groups: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)),
    totals,
  };
}
