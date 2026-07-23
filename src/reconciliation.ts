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
 * Only these statuses mean something was actually delivered to the remote.
 * `prepared` (nothing pushed yet) and `failed` (DeliveryService's failure
 * fallback for a push_branch that never reached a durable remote state — see
 * src/delivery.ts's catch block) have nothing to observe: reconciling them
 * would mean inventing a claim about an artifact that was never sent.
 */
const DELIVERED_STATUSES: readonly DeliveryRepositoryStatus[] = ["branch_pushed", "draft_pr_created", "merged", "tagged"];

const DEFAULT_ARTIFACT_TIMEOUT_MS = 20_000;

function short(commit: string): string {
  return commit.slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processFailureMessage(result: ProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exited with code ${result.exitCode}`;
}

/**
 * Every external read goes through this. Bounded independently of whatever
 * `timeoutMs` the request itself carries — a faked test tool (or a real `gh`
 * that ignores SIGTERM) must never be able to hang the route or the server;
 * the race always settles within `timeoutMs` of being called. A rejection
 * (e.g. the command genuinely doesn't exist) is caught by the caller, not
 * here, so each artifact check can report its own honest "could not check"
 * message.
 */
async function boundedRun(runner: ProcessRunner, request: ProcessRequest, timeoutMs: number): Promise<ProcessResult | "timed_out"> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  try {
    return await Promise.race([runner(request), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Run one external read and classify the outcome into an observed result or an "unobserved" finding — shared by every check below. */
async function observe(
  runner: ProcessRunner,
  request: ProcessRequest,
  timeoutMs: number,
  unobservedContext: string,
): Promise<{ ok: true; result: ProcessResult } | { ok: false; finding: { state: "unobserved"; message: string } }> {
  let result: ProcessResult | "timed_out";
  try {
    result = await boundedRun(runner, request, timeoutMs);
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
}

async function checkBranch(delivery: DeliveryRepositoryRecord, runner: ProcessRunner, timeoutMs: number): Promise<ReconciliationFinding> {
  const context = `whether branch '${delivery.branch}' still exists at the reviewed commit`;
  const observed = await observe(runner, { command: "git", args: ["ls-remote", "origin", `refs/heads/${delivery.branch}`], cwd: delivery.localPath, timeoutMs }, timeoutMs, context);
  if (!observed.ok) return { artifact: "branch", ...observed.finding };

  const line = observed.result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!line) {
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

async function checkPullRequestAndChecks(
  delivery: DeliveryRepositoryRecord,
  expectMerged: boolean,
  runner: ProcessRunner,
  timeoutMs: number,
): Promise<ReconciliationFinding[]> {
  const context = `pull request ${delivery.pullRequestUrl}`;
  const observed = await observe(
    runner,
    { command: "gh", args: ["pr", "view", delivery.pullRequestUrl!, "--json", "state,headRefOid,statusCheckRollup"], cwd: delivery.localPath, timeoutMs },
    timeoutMs,
    context,
  );
  if (!observed.ok) {
    // A single failed read means BOTH the pull-request and checks artifacts
    // could not be observed — never invent one finding from the other.
    return [{ artifact: "pull_request", ...observed.finding }, { artifact: "checks", ...observed.finding }];
  }

  let view: PullRequestView;
  try {
    view = JSON.parse(observed.result.stdout) as PullRequestView;
  } catch (error) {
    const message = `Could not check ${context}: GitHub returned an unreadable response (${errorMessage(error)})`;
    return [{ artifact: "pull_request", state: "unobserved", message }, { artifact: "checks", state: "unobserved", message }];
  }

  const findings: ReconciliationFinding[] = [];
  const state = view.state ?? "";
  if (expectMerged) {
    if (state === "MERGED") {
      findings.push({ artifact: "pull_request", state: "matches", message: `The pull request is still merged, as the ledger records.` });
    } else {
      findings.push({
        artifact: "pull_request",
        state: "diverged",
        message: `The ledger records this pull request as merged, but GitHub now reports its state as ${state || "unknown"}.`,
      });
    }
  } else {
    if (state === "OPEN") {
      if (view.headRefOid && view.headRefOid !== delivery.headCommit) {
        findings.push({
          artifact: "pull_request",
          state: "diverged",
          message: `The ledger records the reviewed head as ${short(delivery.headCommit)}, but the open pull request's head is now ${short(view.headRefOid)} — new commits landed after review.`,
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
  const checks = view.statusCheckRollup ?? [];
  const failed = checks.filter((check) => check.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion));
  if (failed.length) {
    findings.push({
      artifact: "checks",
      state: "diverged",
      message: `${failed.length} status check(s) now report a failing result on this pull request.`,
    });
  } else {
    findings.push({ artifact: "checks", state: "matches", message: `No status checks currently report a failing result.` });
  }

  return findings;
}

async function checkTag(delivery: DeliveryRepositoryRecord, runner: ProcessRunner, timeoutMs: number): Promise<ReconciliationFinding> {
  const tag = delivery.releaseTag!;
  const context = `whether release tag '${tag}' still exists`;
  const observed = await observe(runner, { command: "git", args: ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], cwd: delivery.localPath, timeoutMs }, timeoutMs, context);
  if (!observed.ok) return { artifact: "tag", ...observed.finding };

  const present = observed.result.stdout.trim().length > 0;
  if (present) return { artifact: "tag", state: "matches", message: `Release tag '${tag}' is still present on GitHub, as the ledger records.` };
  return { artifact: "tag", state: "diverged", message: `The ledger records release tag '${tag}' as pushed, but GitHub no longer has that tag.` };
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
): Promise<RepositoryReconciliationResult> {
  const findings: ReconciliationFinding[] = [];

  if (DELIVERED_STATUSES.includes(delivery.status)) {
    findings.push(await checkBranch(delivery, runner, timeoutMs));

    if (delivery.pullRequestUrl) {
      const expectMerged = delivery.status === "merged" || delivery.status === "tagged";
      findings.push(...(await checkPullRequestAndChecks(delivery, expectMerged, runner, timeoutMs)));
    }

    if (delivery.status === "tagged" && delivery.releaseTag) {
      findings.push(await checkTag(delivery, runner, timeoutMs));
    }
  }
  // `prepared` and `failed` records have nothing delivered to the remote yet
  // (see DELIVERED_STATUSES above) — STRICT: no findings are invented for an
  // artifact that was never sent.

  return {
    runId: delivery.runId,
    repositoryId: delivery.repositoryId,
    checkedAt: new Date().toISOString(),
    findings,
    hasDivergence: findings.some((finding) => finding.state === "diverged"),
    hasUnobserved: findings.some((finding) => finding.state === "unobserved"),
  };
}

/** Reconcile every repository a run's delivery record names. Read-only; returns [] for a run with no delivery. */
export async function reconcileDelivery(
  run: Pick<RunSummary, "delivery">,
  runner: ProcessRunner = runProcess,
  timeoutMs: number = DEFAULT_ARTIFACT_TIMEOUT_MS,
): Promise<RepositoryReconciliationResult[]> {
  if (!run.delivery) return [];
  return Promise.all(run.delivery.repositories.map((repository) => reconcileDeliveryRepository(repository, runner, timeoutMs)));
}
