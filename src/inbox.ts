import type { DeliveryRepositoryRecord, DeliveryRepositoryStatus, RunStatus, RunSummary } from "./types.js";

/**
 * new-Major (scan cost). The exact, and only, run statuses `projectInbox`
 * below can ever turn into an `InboxItem` — kept next to the predicates
 * themselves so the two can never silently drift apart. `GET /api/inbox`
 * (src/server.ts) passes this list to `Ledger.listRunsByStatus()`
 * (src/ledger.ts) instead of scanning every run the ledger has ever
 * recorded: the query is complete for inbox items by construction, because
 * no run outside this set can produce one.
 */
export const INBOX_RELEVANT_RUN_STATUSES: readonly RunStatus[] = ["awaiting_approval", "ready", "paused"];

/**
 * DH-645 S1. The approval inbox is a PURE projection of existing ledger
 * state — no new schema, no new approval code path, no writes. Every item's
 * `actionTarget` names an EXISTING view+control (see src/ui/index.html /
 * src/ui/app.js); acting on an item is indistinguishable from acting on the
 * run surface directly, because it IS the run surface.
 */
export type InboxItemKind = "plan_approval" | "delivery_step_approval" | "paused_run";

export interface InboxActionTarget {
  /** The existing view that carries the control — the inbox never adds a second gate. */
  view: "runs";
  /** The id of the existing control inside that view. */
  control: "approve-run" | "delivery-panel" | "resume-run";
  /** What the routing button says; the projection owns the wording so the UI stays a thin renderer. */
  label: string;
}

export interface InboxItem {
  kind: InboxItemKind;
  runId: string;
  repositoryId?: string;
  title: string;
  plainSummary: string;
  waitingSinceIso: string;
  /** What this decision rests on — a plan revision, a reviewed commit, a pause reason. */
  evidence: string;
  actionTarget: InboxActionTarget;
}

/**
 * Delivery steps that still require the owner's approval to move the
 * delivery forward. `merged` and `tagged` are deliberately EXCLUDED:
 * tagging is optional (an empty tag field skips it — see
 * `deliveryTagCaption` in src/ui/app.js, and the "Merged under your
 * approval. Tag the release below when you are ready." copy in
 * `renderDelivery`), so a merged repository has no mandatory next action
 * outstanding, only an optional one — it is not genuinely waiting on the
 * owner. `failed` IS included: DeliveryService's failure fallback
 * (src/delivery.ts) leaves a failed `push_branch` at status 'failed' with
 * its push button still enabled in the cockpit, so it remains a real
 * pending decision, not a resolved one.
 */
const PENDING_DELIVERY_STATUSES: readonly DeliveryRepositoryStatus[] = [
  "prepared",
  "branch_pushed",
  "draft_pr_created",
  "failed",
];

const DELIVERY_NEXT_STEP: Partial<Record<DeliveryRepositoryStatus, string>> = {
  prepared: "push the reviewed branch",
  branch_pushed: "open a draft pull request",
  draft_pr_created: "merge the pull request",
};

function planApprovalItem(run: RunSummary): InboxItem {
  const revision = run.plan?.revision ?? 1;
  const taskCount = run.plan?.tasks.length ?? run.tasks.length;
  return {
    kind: "plan_approval",
    runId: run.id,
    title: run.goalSummary || run.goal,
    plainSummary: "The proposed plan is ready and needs your approval before any work begins.",
    waitingSinceIso: run.updatedAt,
    evidence: `Plan revision ${revision} — ${taskCount} task${taskCount === 1 ? "" : "s"} proposed`,
    actionTarget: { view: "runs", control: "approve-run", label: "Open this run to approve the plan" },
  };
}

function deliveryStepItem(run: RunSummary, repository: DeliveryRepositoryRecord): InboxItem {
  const nextStep = DELIVERY_NEXT_STEP[repository.status];
  const plainSummary = repository.status === "failed"
    ? `The last delivery step for ${repository.repositoryId} failed${repository.error ? `: ${repository.error}` : ""}; it needs your attention before delivery can continue.`
    : `${repository.repositoryId} is ready to ${nextStep ?? "continue delivery"}; nothing happens until you approve it.`;
  return {
    kind: "delivery_step_approval",
    runId: run.id,
    repositoryId: repository.repositoryId,
    title: `${run.goalSummary || run.goal} — ${repository.repositoryId}`,
    plainSummary,
    waitingSinceIso: repository.updatedAt,
    evidence: `Reviewed commit ${repository.headCommit.slice(0, 12)} on branch ${repository.branch}`,
    actionTarget: { view: "runs", control: "delivery-panel", label: "Open this run's delivery panel" },
  };
}

function pausedRunItem(run: RunSummary): InboxItem {
  // Most-recent-first (getRun orders events DESC), so the first match is the
  // pause that is CURRENTLY in effect, not whichever pause happened first.
  const reason = run.events.find((event) => event.kind === "run.paused")?.message ?? "Run paused";
  return {
    kind: "paused_run",
    runId: run.id,
    title: run.goalSummary || run.goal,
    plainSummary: "This run is paused and needs your direction: resume it as a new recovery run, or cancel it.",
    waitingSinceIso: run.updatedAt,
    evidence: reason,
    actionTarget: { view: "runs", control: "resume-run", label: "Open this run to resume or cancel it" },
  };
}

/**
 * Pure projection of existing ledger state (as already served by
 * `Ledger.listRuns()` / `Ledger.getRun()`) into the decisions genuinely
 * waiting on the owner right now. No new state is read or written — every
 * item is derived from a run or delivery-repository record the ledger
 * already persists, and the list is naturally correct on every call: a
 * resolved, superseded, or re-prepared decision simply stops matching the
 * predicates below, so nothing here can go stale between refreshes.
 *
 * Two kinds from the DH-645 design brief are NOT represented here — the
 * ledger genuinely cannot express them as a "still waiting" decision yet:
 *
 *  - paid-spend (OpenRouter) confirmations: `Ledger.reservePaidSpend` (see
 *    src/ledger.ts) reserves and enforces the per-run/monthly spend
 *    ceilings SYNCHRONOUSLY inside the paid invocation call
 *    (`OpenRouterService.withPaidRoutingAllowed`) — the reservation is
 *    created and either honored or refused before the invocation that
 *    needed it proceeds. There is no persisted row representing a spend
 *    decision that is still open: by the time any `paid_spend_reservations`
 *    record exists, the decision it represents has already been resolved
 *    (allowed and invoked, or refused). There is nothing pending to
 *    project.
 *  - a distinct "blocked run" state: `RUN_STATUSES` (src/domain.ts) has no
 *    run-level 'blocked' status. A blocked TASK — one whose dependency
 *    failed (see the scheduler's `task.blocked` handling in
 *    src/orchestrator.ts) — resolves automatically to a terminal run
 *    status (`ready`/`not_ready`/`failed`) without requiring owner
 *    direction; it is not a decision genuinely waiting on the owner at run
 *    granularity. Only `paused` runs — which the ledger's own comments
 *    describe as needing a NEW recovery run rather than resuming in place
 *    (see `STEERABLE_RUN_STATUSES` in src/ledger.ts) — are projected under
 *    the design brief's combined "paused or blocked" kind.
 */
export function projectInbox(runs: readonly RunSummary[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const run of runs) {
    if (run.status === "awaiting_approval") items.push(planApprovalItem(run));
    if (run.status === "ready" && run.delivery) {
      for (const repository of run.delivery.repositories) {
        if (PENDING_DELIVERY_STATUSES.includes(repository.status)) items.push(deliveryStepItem(run, repository));
      }
    }
    if (run.status === "paused") items.push(pausedRunItem(run));
  }
  // Oldest-waiting-first: the decision that has waited longest surfaces at
  // the top of the inbox. ISO 8601 timestamps sort correctly as strings.
  return items.sort((a, b) => a.waitingSinceIso.localeCompare(b.waitingSinceIso));
}
