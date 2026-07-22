import type { Ledger } from "./ledger.js";
import { evaluateToolRequest, type ToolApprovalReceipt } from "./policy.js";
import { runProcess, type ProcessRequest, type ProcessResult } from "./process.js";
import type { DeliveryRepositoryRecord, DevHarmonicsConfig } from "./types.js";

export type DeliveryAction = "push_branch" | "create_draft_pr" | "merge_pr" | "tag_release";
type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export interface DeliveryExecutionInput {
  runId: string;
  repositoryId: string;
  action: DeliveryAction;
  config: DevHarmonicsConfig;
  approval: ToolApprovalReceipt;
  expectedHeadCommit?: string;
  /** Release tag name; required for tag_release. */
  tag?: string;
}

const RELEASE_TAG_PATTERN = /^v?[0-9A-Za-z][0-9A-Za-z_.-]{0,63}$/;

function githubRemote(value: string): { webUrl: string; repository: string } {
  const remote = value.trim();
  let repository: string | null = null;
  try {
    const parsed = new URL(remote);
    if (parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com") {
      repository = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    }
  } catch {
    const match = remote.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
    repository = match?.[1] ?? null;
  }
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("Approved delivery currently supports GitHub HTTPS or SSH origin URLs only");
  }
  return { repository, webUrl: `https://github.com/${repository}` };
}

function failureMessage(result: ProcessResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

export class DeliveryService {
  constructor(private readonly ledger: Ledger, private readonly runner: ProcessRunner = runProcess) {}

  async execute(input: DeliveryExecutionInput): Promise<DeliveryRepositoryRecord> {
    const run = this.ledger.getRun(input.runId);
    if (!run) throw new Error(`Run '${input.runId}' was not found`);
    if (run.status !== "ready") throw new Error("Only a READY run can be delivered");
    const delivery = run.delivery?.repositories.find((repository) => repository.repositoryId === input.repositoryId);
    if (!delivery) throw new Error(`Run '${input.runId}' has no reviewed delivery for '${input.repositoryId}'`);
    if (input.expectedHeadCommit && input.expectedHeadCommit !== delivery.headCommit) {
      throw new Error("The reviewed head changed; refresh the delivery evidence before approving");
    }
    // Idempotent reconciliation FIRST, preconditions second (panel finding:
    // guards that fire before the already-done returns break resuming a
    // partially-completed delivery with misleading errors).
    if (input.action === "push_branch" && ["branch_pushed", "draft_pr_created", "merged", "tagged"].includes(delivery.status)) return delivery;
    if (input.action === "create_draft_pr" && ["draft_pr_created", "merged", "tagged"].includes(delivery.status)) return delivery;
    if (input.action === "merge_pr" && ["merged", "tagged"].includes(delivery.status)) return delivery;
    if (input.action === "tag_release" && delivery.status === "tagged") {
      // Same tag: already done. A DIFFERENT tag on a tagged delivery must not
      // report success it did not perform.
      if (input.tag && delivery.releaseTag && input.tag !== delivery.releaseTag) {
        throw new Error(`This delivery is already tagged as '${delivery.releaseTag}'; it will not be re-tagged as '${input.tag}'`);
      }
      return delivery;
    }
    if (input.action === "create_draft_pr" && delivery.status !== "branch_pushed") {
      throw new Error("Push the reviewed branch first");
    }
    if (input.action === "merge_pr" && delivery.status !== "draft_pr_created") {
      throw new Error("Create the draft pull request first");
    }
    if (input.action === "tag_release") {
      if (delivery.status !== "merged") throw new Error("Merge the pull request before tagging the release");
      if (!input.tag || !RELEASE_TAG_PATTERN.test(input.tag)) throw new Error("Release tag names must be short version-like identifiers (letters, digits, dot, dash, underscore)");
    }

    const remoteResult = await this.runner({ command: "git", args: ["remote", "get-url", "origin"], cwd: delivery.localPath, timeoutMs: 30_000 });
    if (remoteResult.exitCode !== 0) throw new Error(failureMessage(remoteResult, "Could not resolve the Git origin"));
    const remote = githubRemote(remoteResult.stdout);
    if (delivery.remoteUrl && delivery.remoteUrl !== remote.webUrl) throw new Error("The live Git origin does not match the reviewed delivery remote");

    const toolId = input.action === "push_branch"
      ? "github.branch_push"
      : input.action === "create_draft_pr"
        ? "github.pull_request"
        : input.action === "merge_pr"
          ? "github.pr_merge"
          : "github.tag_push";
    const requestRecord = {
      repository: remote.repository,
      base: delivery.baseBranch,
      head: delivery.headCommit,
      branch: delivery.branch,
      action: input.action,
      ...(delivery.pullRequestUrl ? { pullRequestUrl: delivery.pullRequestUrl } : {}),
      ...(input.tag ? { tag: input.tag } : {}),
    };
    const decision = evaluateToolRequest({
      toolId,
      actorRole: "coordinator",
      stage: "release",
      taskPermission: "workspace_write",
      assignedWorktree: delivery.localPath,
      repositoryRoot: delivery.localPath,
      cwd: delivery.localPath,
      planApproved: true,
      approval: input.approval,
    }, input.config);
    this.ledger.recordToolPolicyReceipt({
      runId: input.runId,
      toolId,
      actorRole: "coordinator",
      stage: "release",
      sideEffect: decision.tool.sideEffect,
      outcome: decision.outcome,
      reason: decision.reason,
      request: requestRecord,
      lockKeys: decision.lockKeys,
      approvalId: decision.approvalId,
    });
    if (decision.outcome !== "allow") throw new Error(decision.reason);

    try {
      if (input.action === "push_branch") {
        const result = await this.runner({
          command: "git",
          args: ["push", "origin", `${delivery.headCommit}:refs/heads/${delivery.branch}`],
          cwd: delivery.localPath,
          timeoutMs: 120_000,
        });
        if (result.exitCode !== 0) throw new Error(failureMessage(result, "Git branch push failed"));
        const updated = this.ledger.updateDeliveryRepository(input.runId, input.repositoryId, {
          status: "branch_pushed", remoteUrl: remote.webUrl, approvalId: input.approval.id, error: null,
        });
        this.ledger.addEvent(input.runId, "delivery.branch_pushed", `${input.repositoryId}: pushed reviewed branch ${delivery.branch}`, requestRecord);
        return updated;
      }

      if (input.action === "create_draft_pr") {
        const title = run.goal.trim().slice(0, 120) || "DevHarmonics reviewed delivery";
        const body = [
          "DevHarmonics reviewed delivery",
          "",
          `Base: ${delivery.baseBranch} (${delivery.baseCommit})`,
          `Head: ${delivery.branch} (${delivery.headCommit})`,
          `Run: ${input.runId}`,
          "",
          "This pull request opens as a draft. DevHarmonics merges only with the owner's explicit approval.",
        ].join("\n");
        const result = await this.runner({
          command: "gh",
          args: ["pr", "create", "--repo", remote.repository, "--draft", "--head", delivery.branch, "--base", delivery.baseBranch, "--title", title, "--body", body],
          cwd: delivery.localPath,
          timeoutMs: 120_000,
        });
        if (result.exitCode !== 0) throw new Error(failureMessage(result, "Draft pull request creation failed"));
        const pullRequestUrl = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
        if (!pullRequestUrl) throw new Error("GitHub did not return a draft pull request URL");
        const updated = this.ledger.updateDeliveryRepository(input.runId, input.repositoryId, {
          status: "draft_pr_created", remoteUrl: remote.webUrl, pullRequestUrl, approvalId: input.approval.id, error: null,
        });
        this.ledger.addEvent(input.runId, "delivery.draft_pr_created", `${input.repositoryId}: created draft pull request`, { ...requestRecord, pullRequestUrl });
        return updated;
      }

      if (!delivery.pullRequestUrl) throw new Error("The delivery record has no pull request URL");

      if (input.action === "merge_pr") {
        // Never merge blind: read the LIVE pull-request state first. Three
        // refusals protect the owner's approval (panel findings):
        // conflicts, checks that are pending or failing, and a PR head that
        // is no longer the exact commit DevHarmonics reviewed.
        const view = await this.runner({ command: "gh", args: ["pr", "view", delivery.pullRequestUrl, "--json", "state,isDraft,mergeable,mergeStateStatus,headRefOid,statusCheckRollup"], cwd: delivery.localPath, timeoutMs: 60_000 });
        if (view.exitCode !== 0) throw new Error(failureMessage(view, "Could not read the live pull request state"));
        const state = JSON.parse(view.stdout) as { state: string; isDraft: boolean; mergeable: string; mergeStateStatus?: string; headRefOid?: string; statusCheckRollup?: Array<{ status?: string; conclusion?: string | null }> | null };
        if (state.state === "CLOSED") throw new Error("The pull request was closed on GitHub; nothing to merge");
        if (state.state !== "MERGED") {
          if (state.headRefOid && state.headRefOid !== delivery.headCommit) {
            throw new Error(`The pull request head (${state.headRefOid.slice(0, 12)}) is no longer the reviewed commit (${delivery.headCommit.slice(0, 12)}); new commits landed after review — re-run the review before approving a merge`);
          }
          if (state.mergeable === "CONFLICTING") throw new Error("The pull request is not mergeable (conflicts with its base); resolve before approving the merge");
          if (state.mergeStateStatus && ["DIRTY", "BLOCKED"].includes(state.mergeStateStatus)) {
            throw new Error(`GitHub reports the pull request as ${state.mergeStateStatus.toLowerCase()}; resolve the blocking condition before approving the merge`);
          }
          const checks = state.statusCheckRollup ?? [];
          const unfinished = checks.filter((check) => check.status && check.status !== "COMPLETED");
          const failed = checks.filter((check) => check.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion));
          if (unfinished.length) throw new Error(`${unfinished.length} status check(s) are still running; approve the merge again when they finish`);
          if (failed.length) throw new Error(`${failed.length} status check(s) failed; a red pull request is never merged`);
          if (state.isDraft) {
            const ready = await this.runner({ command: "gh", args: ["pr", "ready", delivery.pullRequestUrl], cwd: delivery.localPath, timeoutMs: 60_000 });
            if (ready.exitCode !== 0) throw new Error(failureMessage(ready, "Could not mark the pull request ready for review"));
          }
          const merge = await this.runner({ command: "gh", args: ["pr", "merge", delivery.pullRequestUrl, "--merge"], cwd: delivery.localPath, timeoutMs: 120_000 });
          if (merge.exitCode !== 0) throw new Error(failureMessage(merge, "Pull request merge failed"));
        }
        const updated = this.ledger.updateDeliveryRepository(input.runId, input.repositoryId, {
          status: "merged", remoteUrl: remote.webUrl, approvalId: input.approval.id, error: null,
        });
        this.ledger.addEvent(input.runId, "delivery.merged", `${input.repositoryId}: merged the reviewed pull request under owner approval`, requestRecord);
        return updated;
      }

      // tag_release: the tag lands on the ACTUAL merge commit GitHub reports,
      // never on an assumed head.
      const mergedView = await this.runner({ command: "gh", args: ["pr", "view", delivery.pullRequestUrl, "--json", "state,mergeCommit"], cwd: delivery.localPath, timeoutMs: 60_000 });
      if (mergedView.exitCode !== 0) throw new Error(failureMessage(mergedView, "Could not read the merged pull request"));
      const mergedState = JSON.parse(mergedView.stdout) as { state: string; mergeCommit: { oid: string } | null };
      if (mergedState.state !== "MERGED" || !mergedState.mergeCommit?.oid) throw new Error("The pull request has no merge commit to tag");
      const fetch = await this.runner({ command: "git", args: ["fetch", "origin", delivery.baseBranch], cwd: delivery.localPath, timeoutMs: 120_000 });
      if (fetch.exitCode !== 0) throw new Error(failureMessage(fetch, "Could not fetch the merged base branch"));
      // A prior attempt may have created the local tag and failed only the
      // push (panel finding): reuse a local tag that points at the exact merge
      // commit; refuse one that points anywhere else.
      const existingTag = await this.runner({ command: "git", args: ["rev-parse", "-q", "--verify", `refs/tags/${input.tag}^{commit}`], cwd: delivery.localPath, timeoutMs: 30_000 });
      const existingOid = existingTag.exitCode === 0 ? existingTag.stdout.trim() : null;
      if (existingOid && existingOid !== mergedState.mergeCommit.oid) {
        throw new Error(`A local tag '${input.tag}' already exists on a different commit (${existingOid.slice(0, 12)}); delete or rename it before tagging this release`);
      }
      if (!existingOid) {
        const tagResult = await this.runner({ command: "git", args: ["tag", "-a", input.tag!, mergedState.mergeCommit.oid, "-m", `DevHarmonics approved release ${input.tag} (run ${input.runId})`], cwd: delivery.localPath, timeoutMs: 60_000 });
        if (tagResult.exitCode !== 0) throw new Error(failureMessage(tagResult, "Release tag creation failed"));
      }
      const pushTag = await this.runner({ command: "git", args: ["push", "origin", `refs/tags/${input.tag}`], cwd: delivery.localPath, timeoutMs: 120_000 });
      if (pushTag.exitCode !== 0) throw new Error(failureMessage(pushTag, "Release tag push failed"));
      const updated = this.ledger.updateDeliveryRepository(input.runId, input.repositoryId, {
        status: "tagged", remoteUrl: remote.webUrl, approvalId: input.approval.id, error: null, releaseTag: input.tag!,
      });
      this.ledger.addEvent(input.runId, "delivery.tagged", `${input.repositoryId}: pushed release tag ${input.tag} on the merge commit under owner approval`, requestRecord);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed later step falls back to the last durable state it verifiably
      // reached, never to a state it lost.
      const fallback = input.action === "create_draft_pr"
        ? "branch_pushed" as const
        : input.action === "merge_pr"
          ? "draft_pr_created" as const
          : input.action === "tag_release"
            ? "merged" as const
            : "failed" as const;
      this.ledger.updateDeliveryRepository(input.runId, input.repositoryId, { status: fallback, remoteUrl: remote.webUrl, approvalId: input.approval.id, error: message });
      this.ledger.addEvent(input.runId, "delivery.failed", `${input.repositoryId}: ${message}`, requestRecord);
      throw error;
    }
  }
}
