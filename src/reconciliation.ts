import { runProcess, type ProcessRequest, type ProcessResult } from "./process.js";
import type { DeliveryRepositoryRecord, DeliveryRepositoryStatus, RunSummary } from "./types.js";

type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/**
 * DH-645 S3. What kind of delivered artifact a finding is about. Only
 * artifacts that were actually delivered (see `deliveredArtifactKinds`
 * below) are ever checked — reconciliation never invents a claim about
 * something that was never pushed.
 */
export type ReconciliationArtifactKind = "branch" | "pull_request" | "checks" | "tag";

/**
 * The three honest states (locked decision 3, DESIGN-BRIEF-v1.0.md /
 * DH-645 IMPLEMENTATION_PLAN.md):
 *
 *  - matches: observed, and the remote agrees with the ledger record.
 *  - diverged: observed, and the remote DISAGREES — reported as a plain-
 *    English finding naming the ledger's claim and the observed reality.
 *  - unobserved: the check could not run (gh missing/signed out, network
 *    failure, timeout). NEVER rendered or reasoned about as confirmation.
 */
export type ReconciliationState = "matches" | "diverged" | "unobserved";

export interface ReconciliationFinding {
  artifact: ReconciliationArtifactKind;
  state: ReconciliationState;
  /** Plain English: what the ledger claims vs. what was observed, or why nothing could be observed. */
  message: string;
}

export interface RepositoryReconciliationResult {
  runId: string;
  repositoryId: string;
  checkedAt: string;
  findings: ReconciliationFinding[];
  /** Convenience for callers: true iff at least one finding diverged. */
  hasDivergence: boolean;
  /** Convenience for callers: true iff at least one finding could not be checked. */
  hasUnobserved: boolean;
}

/**
 * These statuses mean something was actually delivered to the remote as a
 * pull request / merge / tag — the artifacts that only make sense once we
 * know a PR or tag was created. `prepared` (nothing pushed yet) has nothing
 * to observe at all. `failed` is handled separately below: the push_branch
 * step itself threw, so no PR or tag was ever created, but the branch push
 * it attempted may or may not have reached the remote before the failure —
 * see OBSERVABLE_BRANCH_STATUSES.
 */
const DELIVERED_STATUSES: readonly DeliveryRepositoryStatus[] = ["branch_pushed", "draft_pr_created", "merged", "tagged"];

/**
 * minor-failed-push: a 'failed' record's branch state is unknown, not
 * absent — DeliveryService's failure fallback (src/delivery.ts's catch
 * block) can be reached after a push command reported failure but the
 * remote update still landed (a lost acknowledgement). Skipping the branch
 * check entirely, as if nothing was ever attempted, would silently hide
 * that possibility. So `failed` is observed too, just with wording that
 * makes clear the ledger's own record of this attempt was a failure.
 */
const OBSERVABLE_BRANCH_STATUSES: readonly DeliveryRepositoryStatus[] = [...DELIVERED_STATUSES, "failed"];

const DEFAULT_ARTIFACT_TIMEOUT_MS = 20_000;

/**
 * M-timeout-abort: how long a terminated process gets, after SIGTERM, before
 * process.ts escalates to SIGKILL. Reconciliation waits up to this long
 * (plus CONFIRM_KILL_MARGIN_MS) past its own timeout for the kill to be
 * confirmed before it reports "unobserved: timed out" — the artifact is
 * never settled while the external process might still be running.
 */
const DEFAULT_KILL_GRACE_MS = 2_000;

/** Extra slack on top of DEFAULT_KILL_GRACE_MS for the confirmed-close event to actually arrive. */
const CONFIRM_KILL_MARGIN_MS = 500;

/** M-fanout: no more than this many repositories are reconciled at once, across the whole run. */
const RECONCILIATION_CONCURRENCY = 3;

function short(commit: string): string {
  return commit.slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processFailureMessage(result: ProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exited with code ${result.exitCode}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every external read goes through this. Bounded independently of whatever
 * `timeoutMs` the request itself carries — a faked test tool (or a real `gh`
 * that ignores SIGTERM) must never be able to hang the route or the server.
 *
 * M-timeout-abort: on timeout this now actually aborts the underlying call
 * (via AbortSignal, threaded to process.ts's SIGTERM→SIGKILL escalation) and
 * waits for it to settle — confirming the external process is dead — before
 * reporting "timed out". A hard ceiling (killGraceMs + a small margin, on
 * top of timeoutMs) still applies underneath so a runner that ignores the
 * abort signal outright (e.g. a test double with no process behind it) can
 * never hang the caller forever; any real process is torn down for real by
 * process.ts well within that window.
 */
async function boundedRun(
  runner: ProcessRunner,
  request: ProcessRequest,
  timeoutMs: number,
  killGraceMs: number,
): Promise<ProcessResult | "timed_out"> {
  const controller = new AbortController();
  const runnerPromise = runner({ ...request, signal: controller.signal, killGraceMs });
  // Wrapped so a late rejection (e.g. after we've already moved on to the
  // timeout path) never becomes an unhandled rejection.
  const settled = runnerPromise.then(
    (result) => ({ ok: true as const, result }),
    (error) => ({ ok: false as const, error }),
  );

  const primary = await Promise.race([settled, delay(timeoutMs).then(() => "timed_out" as const)]);
  if (primary !== "timed_out") {
    if (primary.ok) return primary.result;
    throw primary.error;
  }

  // The bound elapsed: abort so process.ts tears the real child process down
  // for real, then wait for that to be confirmed (or give up, bounded).
  controller.abort();
  await Promise.race([settled, delay(killGraceMs + CONFIRM_KILL_MARGIN_MS)]);
  return "timed_out";
}

/** Run one external read and classify the outcome into an observed result or an "unobserved" finding — shared by every check below. */
async function observe(
  runner: ProcessRunner,
  request: ProcessRequest,
  timeoutMs: number,
  killGraceMs: number,
  unobservedContext: string,
): Promise<{ ok: true; result: ProcessResult } | { ok: false; finding: { state: "unobserved"; message: string } }> {
  let result: ProcessResult | "timed_out";
  try {
    result = await boundedRun(runner, request, timeoutMs, killGraceMs);
  } catch (error) {
    return { ok: false, finding: { state: "unobserved", message: `Could not check ${unobservedContext}: ${errorMessage(error)}` } };
  }
  if (result === "timed_out") {
    return { ok: false, finding: { state: "unobserved", message: `Could not check ${unobservedContext}: the check timed out` } };
  }
  if (result.exitCode !== 0) {
    return { ok: false, finding: { state: "unobserved", message: `Could not check ${unobservedContext}: ${processFailureMessage(result)}` } };
  }
  return { ok: true, result };
}

interface PullRequestView {
  state?: string;
  headRefOid?: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string | null }> | null;
  mergeCommit?: { oid?: string } | null;
}

/**
 * What the same repository's pull-request artifact tells us about a missing
 * head branch, so `checkBranch` can tell routine post-merge cleanup from a
 * real loss. `undefined` means no PR is recorded for this delivery at all
 * (the pre-existing, unaffected case: a missing branch always diverges).
 *
 * M-merged-head: "merged" is only ever reported when the observed merged
 * head equals the recorded reviewed commit — a merge whose head identity is
 * missing or mismatched can no longer be assumed routine.
 */
type PullRequestMergeSignal = "merged" | "not_merged" | "unobserved";

async function checkBranch(
  delivery: DeliveryRepositoryRecord,
  runner: ProcessRunner,
  timeoutMs: number,
  killGraceMs: number,
  prMergeSignal?: PullRequestMergeSignal,
  isFailedPush = false,
): Promise<ReconciliationFinding> {
  const remote = delivery.remoteUrl;
  if (!remote) {
    return {
      artifact: "branch",
      state: "unobserved",
      message: `Could not check whether branch '${delivery.branch}' still exists: no remote URL was recorded for this delivery.`,
    };
  }
  // M-origin: query the recorded remote URL directly — never the checkout's
  // mutable `origin`, which can be retargeted after delivery and would then
  // describe a different repository than the one actually delivered to.
  const context = `whether branch '${delivery.branch}' still exists at the reviewed commit`;
  const observed = await observe(runner, { command: "git", args: ["ls-remote", remote, `refs/heads/${delivery.branch}`], cwd: delivery.localPath, timeoutMs }, timeoutMs, killGraceMs, context);
  if (!observed.ok) return { artifact: "branch", ...observed.finding };

  const line = observed.result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";

  // minor-failed-push: the ledger recorded this push as FAILED — its own
  // claim is "we don't durably know what happened", not "nothing happened".
  // Report exactly what the remote shows, worded to make the failed attempt
  // explicit either way.
  if (isFailedPush) {
    if (!line) {
      return {
        artifact: "branch",
        state: "matches",
        message: `DevHarmonics recorded this push as failed, and GitHub confirms branch '${delivery.branch}' does not exist — consistent with the reported failure.`,
      };
    }
    const observedOid = line.split(/\s+/)[0] ?? "";
    if (observedOid === delivery.headCommit) {
      return {
        artifact: "branch",
        state: "diverged",
        message: `DevHarmonics recorded this push as failed, but GitHub shows branch '${delivery.branch}' present at the expected commit ${short(delivery.headCommit)} — the push may have actually succeeded despite the reported error.`,
      };
    }
    return {
      artifact: "branch",
      state: "diverged",
      message: `DevHarmonics recorded this push as failed, but GitHub shows branch '${delivery.branch}' present at ${short(observedOid)}, not the expected commit ${short(delivery.headCommit)} — unclear whether this relates to the failed push.`,
    };
  }

  if (!line) {
    // A missing head branch is routine GitHub hygiene once its pull request
    // merged (auto-delete or manual cleanup) — never an alarm. But we can
    // only tell that apart from a real loss by knowing the PR actually
    // merged AT the reviewed head, so an unobservable or head-mismatched PR
    // state must stay honestly unobserved/diverged rather than guessing.
    if (prMergeSignal === "merged") {
      return {
        artifact: "branch",
        state: "matches",
        message: `Branch deleted after merge — routine cleanup, nothing wrong.`,
      };
    }
    if (prMergeSignal === "unobserved") {
      return {
        artifact: "branch",
        state: "unobserved",
        message: `Could not check whether branch '${delivery.branch}' was deleted after a merge or actually lost: the pull request state could not be checked.`,
      };
    }
    return {
      artifact: "branch",
      state: "diverged",
      message: `The ledger records branch '${delivery.branch}' pushed at ${short(delivery.headCommit)}, but GitHub no longer has that branch — it was deleted or renamed.`,
    };
  }
  const observedOid = line.split(/\s+/)[0] ?? "";
  if (observedOid === delivery.headCommit) {
    return { artifact: "branch", state: "matches", message: `Branch '${delivery.branch}' is still at the reviewed commit ${short(delivery.headCommit)}, as the ledger records.` };
  }
  return {
    artifact: "branch",
    state: "diverged",
    message: `The ledger records branch '${delivery.branch}' at ${short(delivery.headCommit)}, but GitHub now shows it at ${short(observedOid)} — new commits landed after review.`,
  };
}

interface PullRequestAndChecksResult {
  findings: ReconciliationFinding[];
  /** What this PR read tells `checkBranch` about a missing head branch — see `PullRequestMergeSignal`. */
  mergeSignal: PullRequestMergeSignal;
  /** The live merge commit OID GitHub reports for this PR, if any — used by `checkTag` when the ledger's own cached `mergeCommitOid` is missing. */
  mergeCommitOid: string | null;
}

async function checkPullRequestAndChecks(
  delivery: DeliveryRepositoryRecord,
  expectMerged: boolean,
  runner: ProcessRunner,
  timeoutMs: number,
  killGraceMs: number,
): Promise<PullRequestAndChecksResult> {
  const context = `pull request ${delivery.pullRequestUrl}`;
  const observed = await observe(
    runner,
    { command: "gh", args: ["pr", "view", delivery.pullRequestUrl!, "--json", "state,headRefOid,statusCheckRollup,mergeCommit"], cwd: delivery.localPath, timeoutMs },
    timeoutMs,
    killGraceMs,
    context,
  );
  if (!observed.ok) {
    // A single failed read means BOTH the pull-request and checks artifacts
    // could not be observed — never invent one finding from the other.
    return {
      findings: [{ artifact: "pull_request", ...observed.finding }, { artifact: "checks", ...observed.finding }],
      mergeSignal: "unobserved",
      mergeCommitOid: null,
    };
  }

  let view: PullRequestView;
  try {
    view = JSON.parse(observed.result.stdout) as PullRequestView;
  } catch (error) {
    const message = `Could not check ${context}: GitHub returned an unreadable response (${errorMessage(error)})`;
    return {
      findings: [{ artifact: "pull_request", state: "unobserved", message }, { artifact: "checks", state: "unobserved", message }],
      mergeSignal: "unobserved",
      mergeCommitOid: null,
    };
  }

  const findings: ReconciliationFinding[] = [];
  const state = view.state ?? "";
  const headRefOid = view.headRefOid;
  // M-merged-head: computed once, for both branches below — a "merged"
  // signal (which lets checkBranch treat a missing head branch as routine
  // post-merge cleanup) requires the observed merged head to equal the
  // recorded reviewed commit. Missing head identity is unobserved, a
  // mismatch is not treated as a clean merge.
  const mergeSignal: PullRequestMergeSignal =
    state !== "MERGED" ? "not_merged" : !headRefOid ? "unobserved" : headRefOid === delivery.headCommit ? "merged" : "not_merged";

  if (expectMerged) {
    if (state === "MERGED") {
      if (!headRefOid) {
        findings.push({
          artifact: "pull_request",
          state: "unobserved",
          message: `Could not check ${context}: GitHub's merged pull request did not report the merged head commit.`,
        });
      } else if (headRefOid !== delivery.headCommit) {
        findings.push({
          artifact: "pull_request",
          state: "diverged",
          message: `The ledger records the reviewed commit as ${short(delivery.headCommit)}, but the merged pull request's head is ${short(headRefOid)} — a different commit was merged.`,
        });
      } else {
        findings.push({ artifact: "pull_request", state: "matches", message: `The pull request is still merged at the reviewed commit ${short(delivery.headCommit)}, as the ledger records.` });
      }
    } else {
      findings.push({
        artifact: "pull_request",
        state: "diverged",
        message: `The ledger records this pull request as merged, but GitHub now reports its state as ${state || "unknown"}.`,
      });
    }
  } else {
    if (state === "OPEN") {
      // minor-open-pr-head: an open PR without a non-empty head OID cannot
      // be confirmed at the reviewed commit — unobserved, never a match.
      if (!headRefOid) {
        findings.push({
          artifact: "pull_request",
          state: "unobserved",
          message: `Could not check ${context}: GitHub's response did not include the pull request's head commit.`,
        });
      } else if (headRefOid !== delivery.headCommit) {
        findings.push({
          artifact: "pull_request",
          state: "diverged",
          message: `The ledger records the reviewed head as ${short(delivery.headCommit)}, but the open pull request's head is now ${short(headRefOid)} — new commits landed after review.`,
        });
      } else {
        findings.push({ artifact: "pull_request", state: "matches", message: `The pull request is still open at the reviewed commit, as the ledger records.` });
      }
    } else if (state === "MERGED") {
      findings.push({
        artifact: "pull_request",
        state: "diverged",
        message: `The ledger records this pull request as still awaiting merge, but GitHub shows it was merged outside DevHarmonics.`,
      });
    } else {
      findings.push({
        artifact: "pull_request",
        state: "diverged",
        message: `The ledger records this pull request as open and awaiting your approval, but GitHub now shows it as ${state || "closed"} without merging.`,
      });
    }
  }

  // "recorded checks conclusion unchanged if recorded" (design brief): a
  // merge could only happen once DeliveryService itself confirmed no check
  // was failing (see the merge_pr preconditions in src/delivery.ts), so a
  // failing conclusion observed now — for either an open or a merged
  // delivery — is a genuine divergence from what the ledger's own history
  // implies, never silently reconciled.
  //
  // M-checks-pending: an empty rollup, a null conclusion, or a non-completed
  // status means the checks have not finished reporting — that is
  // 'unobserved' ("checks still running or not reported"), never 'matches'.
  // A positively observed failure still wins over other checks still
  // pending — it is stronger evidence than "not done yet".
  const checks = view.statusCheckRollup ?? [];
  const failed = checks.filter((check) => check.status === "COMPLETED" && check.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion));
  const pending = checks.filter((check) => check.status !== "COMPLETED" || !check.conclusion);
  if (failed.length) {
    findings.push({
      artifact: "checks",
      state: "diverged",
      message: `${failed.length} status check(s) now report a failing result on this pull request.`,
    });
  } else if (!checks.length || pending.length) {
    findings.push({
      artifact: "checks",
      state: "unobserved",
      message: `Could not check status checks: checks still running or not reported.`,
    });
  } else {
    findings.push({ artifact: "checks", state: "matches", message: `No status checks currently report a failing result.` });
  }

  return { findings, mergeSignal, mergeCommitOid: view.mergeCommit?.oid ?? null };
}

async function checkTag(
  delivery: DeliveryRepositoryRecord,
  runner: ProcessRunner,
  timeoutMs: number,
  killGraceMs: number,
  expectedCommit: string | null,
): Promise<ReconciliationFinding> {
  const tag = delivery.releaseTag!;
  const remote = delivery.remoteUrl;
  if (!remote) {
    return {
      artifact: "tag",
      state: "unobserved",
      message: `Could not check whether release tag '${tag}' still exists: no remote URL was recorded for this delivery.`,
    };
  }
  // M-origin: same rule as checkBranch — the recorded remote URL, never `origin`.
  const context = `whether release tag '${tag}' still points at the recorded merge commit`;
  const observed = await observe(runner, { command: "git", args: ["ls-remote", "--tags", remote, `refs/tags/${tag}`], cwd: delivery.localPath, timeoutMs }, timeoutMs, killGraceMs, context);
  if (!observed.ok) return { artifact: "tag", ...observed.finding };

  const lines = observed.result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    return { artifact: "tag", state: "diverged", message: `The ledger records release tag '${tag}' as pushed, but GitHub no longer has that tag.` };
  }

  // M-tag-oid: an annotated tag's ls-remote listing includes both the tag
  // object itself (refs/tags/x) and its peeled commit target
  // (refs/tags/x^{}) — the peeled line, when present, is the commit the tag
  // actually points at and always wins; a lightweight tag has only the first
  // form, which already names a commit directly.
  const peeled = lines.find((line) => line.endsWith("^{}"));
  const chosen = peeled ?? lines[0]!;
  const observedOid = chosen.split(/\s+/)[0] ?? "";

  if (!expectedCommit) {
    return {
      artifact: "tag",
      state: "unobserved",
      message: `Could not check whether release tag '${tag}' points at the recorded merge commit: no merge commit was recorded for this delivery.`,
    };
  }
  if (observedOid === expectedCommit) {
    return { artifact: "tag", state: "matches", message: `Release tag '${tag}' is still on the recorded merge commit ${short(expectedCommit)}, as the ledger records.` };
  }
  return {
    artifact: "tag",
    state: "diverged",
    message: `The ledger records release tag '${tag}' on merge commit ${short(expectedCommit)}, but GitHub now has '${tag}' pointing at ${short(observedOid)} — the tag was moved to a different commit.`,
  };
}

/**
 * Observe the remote for exactly the artifacts a single delivery repository
 * record claims were delivered, and classify each into matches/diverged/
 * unobserved. Read-only: `git ls-remote` and `gh pr view` only — never a
 * write, never a persisted result (locked decision 1: no schema change,
 * computed on request).
 */
export async function reconcileDeliveryRepository(
  delivery: DeliveryRepositoryRecord,
  runner: ProcessRunner = runProcess,
  timeoutMs: number = DEFAULT_ARTIFACT_TIMEOUT_MS,
  killGraceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<RepositoryReconciliationResult> {
  const findings: ReconciliationFinding[] = [];

  if (OBSERVABLE_BRANCH_STATUSES.includes(delivery.status)) {
    // The pull-request read runs first (when one is recorded) so its merge
    // state can inform the branch check: a missing head branch is routine
    // GitHub cleanup once the PR merged at the reviewed head, not a
    // divergence — see checkBranch. A 'failed' record never has a
    // pull-request or tag to check — see OBSERVABLE_BRANCH_STATUSES.
    let prResult: PullRequestAndChecksResult | null = null;
    if (DELIVERED_STATUSES.includes(delivery.status) && delivery.pullRequestUrl) {
      const expectMerged = delivery.status === "merged" || delivery.status === "tagged";
      prResult = await checkPullRequestAndChecks(delivery, expectMerged, runner, timeoutMs, killGraceMs);
    }

    findings.push(await checkBranch(delivery, runner, timeoutMs, killGraceMs, prResult?.mergeSignal, delivery.status === "failed"));

    if (prResult) {
      findings.push(...prResult.findings);
    }

    if (delivery.status === "tagged" && delivery.releaseTag) {
      // M-tag-oid: prefer the ledger's own recorded merge commit; when that
      // best-effort cache is empty, fall back to the merge commit the PR
      // read above just observed live — but never silently substitute the
      // reviewed head, which is not the commit that was actually tagged.
      const expectedCommit = delivery.mergeCommitOid ?? prResult?.mergeCommitOid ?? null;
      findings.push(await checkTag(delivery, runner, timeoutMs, killGraceMs, expectedCommit));
    }
  }
  // `prepared` has nothing delivered to the remote yet at all — STRICT: no
  // findings are invented for an artifact that was never sent.

  return {
    runId: delivery.runId,
    repositoryId: delivery.repositoryId,
    checkedAt: new Date().toISOString(),
    findings,
    hasDivergence: findings.some((finding) => finding.state === "diverged"),
    hasUnobserved: findings.some((finding) => finding.state === "unobserved"),
  };
}

/**
 * M-fanout: bounds how many repositories are reconciled concurrently — an
 * unbounded `Promise.all` over a large run's repositories can multiply
 * git/gh process spawns and exhaust rate limits or file descriptors.
 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * M-fanout: per-run in-flight deduplication — computed state only, never
 * persisted (locked decision 1). A repeated click (or a stale client retry)
 * while a run's reconciliation is already in flight reuses that same
 * in-flight promise instead of starting a second stack of git/gh processes
 * for the same run.
 */
const inFlightReconciliations = new Map<string, Promise<RepositoryReconciliationResult[]>>();

/** Reconcile every repository a run's delivery record names. Read-only; returns [] for a run with no delivery. */
export async function reconcileDelivery(
  run: Pick<RunSummary, "delivery">,
  runner: ProcessRunner = runProcess,
  timeoutMs: number = DEFAULT_ARTIFACT_TIMEOUT_MS,
  killGraceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<RepositoryReconciliationResult[]> {
  if (!run.delivery) return [];
  const runId = run.delivery.runId;
  const existing = inFlightReconciliations.get(runId);
  if (existing) return existing;

  const repositories = run.delivery.repositories;
  const promise = mapWithConcurrency(repositories, RECONCILIATION_CONCURRENCY, (repository) =>
    reconcileDeliveryRepository(repository, runner, timeoutMs, killGraceMs),
  ).finally(() => {
    inFlightReconciliations.delete(runId);
  });
  inFlightReconciliations.set(runId, promise);
  return promise;
}
