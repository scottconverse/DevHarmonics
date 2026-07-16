import type { Ledger } from "./ledger.js";
import { evaluateToolRequest, type ToolApprovalReceipt } from "./policy.js";
import { runProcess, type ProcessRequest, type ProcessResult } from "./process.js";
import type { DeliveryRepositoryRecord, DevHarmonicsConfig } from "./types.js";

export type DeliveryAction = "push_branch" | "create_draft_pr";
type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export interface DeliveryExecutionInput {
  runId: string;
  repositoryId: string;
  action: DeliveryAction;
  config: DevHarmonicsConfig;
  approval: ToolApprovalReceipt;
  expectedHeadCommit?: string;
}

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
    if (input.action === "create_draft_pr" && !["branch_pushed", "draft_pr_created"].includes(delivery.status)) {
      throw new Error("Push the reviewed branch first");
    }
    if (input.action === "push_branch" && ["branch_pushed", "draft_pr_created"].includes(delivery.status)) return delivery;
    if (input.action === "create_draft_pr" && delivery.status === "draft_pr_created") return delivery;

    const remoteResult = await this.runner({ command: "git", args: ["remote", "get-url", "origin"], cwd: delivery.localPath, timeoutMs: 30_000 });
    if (remoteResult.exitCode !== 0) throw new Error(failureMessage(remoteResult, "Could not resolve the Git origin"));
    const remote = githubRemote(remoteResult.stdout);
    if (delivery.remoteUrl && delivery.remoteUrl !== remote.webUrl) throw new Error("The live Git origin does not match the reviewed delivery remote");

    const toolId = input.action === "push_branch" ? "github.branch_push" : "github.pull_request";
    const requestRecord = {
      repository: remote.repository,
      base: delivery.baseBranch,
      head: delivery.headCommit,
      branch: delivery.branch,
      action: input.action,
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

      const title = run.goal.trim().slice(0, 120) || "DevHarmonics reviewed delivery";
      const body = [
        "DevHarmonics reviewed delivery",
        "",
        `Base: ${delivery.baseBranch} (${delivery.baseCommit})`,
        `Head: ${delivery.branch} (${delivery.headCommit})`,
        `Run: ${input.runId}`,
        "",
        "This pull request is intentionally draft. DevHarmonics does not merge automatically.",
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ledger.updateDeliveryRepository(input.runId, input.repositoryId, { status: input.action === "create_draft_pr" ? "branch_pushed" : "failed", remoteUrl: remote.webUrl, approvalId: input.approval.id, error: message });
      this.ledger.addEvent(input.runId, "delivery.failed", `${input.repositoryId}: ${message}`, requestRecord);
      throw error;
    }
  }
}
