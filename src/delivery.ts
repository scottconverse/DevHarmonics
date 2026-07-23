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
  /**
   * Owner acknowledgement that the requested tag deliberately differs from the
   * version the repository's own files declare (tag-truth gate). Absent, a
   * mismatch refuses with both values so the owner decides with evidence.
   */
  confirmVersionMismatch?: boolean;
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
    throw new DeliveryRefusal("Approved delivery currently supports GitHub HTTPS or SSH origin URLs only");
  }
  return { repository, webUrl: `https://github.com/${repository}` };
}

function failureMessage(result: ProcessResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

/**
 * A refusal grounded in delivery STATE — wrong order, live pull-request
 * conditions, an already-applied different tag, policy denial. The HTTP route
 * reports these as client-visible conflicts (404/409), never as a server
 * fault; a genuine execution failure (git/gh exiting non-zero) stays a plain
 * Error. (Gate finding ENG-1, 2026-07-22.)
 */
export class DeliveryRefusal extends Error {}

/**
 * Tag-truth gate (owner-reported, 2026-07-22): a release tag the repository's
 * own files contradict is a standing public lie — a real dev team would say
 * "hold on, the repo says 1.2.1" before tagging v1.0.0. The refusal carries
 * both values so the cockpit can show the evidence and take an explicit
 * owner confirmation; DevHarmonics never tags blind, and never decides alone.
 */
export class VersionMismatchRefusal extends DeliveryRefusal {
  constructor(public readonly declaredVersion: string, public readonly requestedTag: string) {
    super(`This repository's own files declare version ${declaredVersion}, but the requested tag is ${requestedTag}; confirm the mismatch to tag anyway`);
  }
}

/**
 * Read ONLY the PEP 621 `[project].version` from pyproject text. A section-
 * scoped scan (gate finding, 2026-07-22): the previous whole-file regex took
 * the FIRST `version = "..."` anywhere, so a `[tool.something] version` before
 * `[project]` masqueraded as the project's own version. We walk table headers
 * and read `version` only while inside the exact `[project]` table, stopping at
 * the next table header. Hand-rolled — no TOML dependency.
 */
function pyprojectProjectVersion(text: string): string | null {
  let inProject = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (line.startsWith("[")) {
      // A table header. Only the exact `[project]` table carries the canonical
      // version; `[project.scripts]`, `[tool.x]`, etc. do not.
      inProject = /^\[project\]\s*(#.*)?$/.test(line);
      continue;
    }
    if (!inProject) continue;
    const match = line.match(/^version\s*=\s*["']([^"']+)["']/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Resolve the version a manifest declares, from its raw text: package.json
 * wins; pyproject only when package.json makes no usable claim. Pure so both
 * the immutable-commit lookup and its tests share one parser.
 */
export function parseDeclaredVersion(packageJson: string | null, pyproject: string | null): string | null {
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // package.json present but unparsable — fall through to pyproject
    }
  }
  if (pyproject) {
    const version = pyprojectProjectVersion(pyproject);
    if (version) return version;
  }
  return null;
}

/** "v1.2.1" and "1.2.1" are the same claim; case and a leading v are presentation, not identity. */
function versionsAgree(tag: string, declared: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^v/i, "").toLowerCase();
  return normalize(tag) === normalize(declared);
}

export class DeliveryService {
  constructor(private readonly ledger: Ledger, private readonly runner: ProcessRunner = runProcess) {}

  /**
   * The version an IMMUTABLE commit declares about itself, read from that
   * commit's own blobs via `git show <commitish>:<manifest>` — never from the
   * mutable working tree (CRITICAL gate finding, 2026-07-22). A stale or
   * locally edited checkout must not be able to falsely refuse a correct tag or
   * authorize a tag the merged artifact contradicts. Bounded and read-only.
   */
  async declaredVersionAtCommit(localPath: string, commitish: string): Promise<string | null> {
    const show = async (file: string): Promise<string | null> => {
      const result = await this.runner({ command: "git", args: ["show", `${commitish}:${file}`], cwd: localPath, timeoutMs: 30_000 });
      return result.exitCode === 0 ? result.stdout : null;
    };
    const packageJson = await show("package.json");
    const pyproject = await show("pyproject.toml");
    return parseDeclaredVersion(packageJson, pyproject);
  }

  /** Is the object for `oid` present in the local object store? Bounded, read-only. */
  private async commitObjectPresent(localPath: string, oid: string): Promise<boolean> {
    const result = await this.runner({ command: "git", args: ["cat-file", "-e", `${oid}^{commit}`], cwd: localPath, timeoutMs: 30_000 });
    return result.exitCode === 0;
  }

  /** Resolve a merged PR's immutable merge-commit OID from the LIVE pull request, or null. */
  private async resolveMergeCommitOid(delivery: DeliveryRepositoryRecord): Promise<string | null> {
    if (!delivery.pullRequestUrl) return null;
    const view = await this.runner({ command: "gh", args: ["pr", "view", delivery.pullRequestUrl, "--json", "state,mergeCommit"], cwd: delivery.localPath, timeoutMs: 60_000 });
    if (view.exitCode !== 0 || !view.stdout.trim()) return null;
    try {
      const state = JSON.parse(view.stdout) as { state?: string; mergeCommit?: { oid?: string } | null };
      if (state.state === "MERGED" && state.mergeCommit?.oid) return state.mergeCommit.oid;
    } catch {
      // A malformed live read cannot resolve the OID right now; the caller
      // reports "temporarily unavailable" rather than substituting a wrong one.
    }
    return null;
  }

  /**
   * The declared version to prefill for a delivery's tag field, resolved LAZILY
   * and AUTHORITATIVELY at read time (ROUND3-001, 2026-07-22). Before a merge
   * commit exists, the reviewed head is the only truth. Once the repository is
   * merged or tagged, the version MUST come from the immutable merge commit the
   * tag gate judges — NEVER the reviewed head, which can declare a stale version
   * and provoke a tag the gate would reject, or no version at all. Post-merge
   * enrichment in `merge_pr` is a mere cache: this method is the authority and
   * self-heals the two transient failure paths that cache can leave behind —
   *   1. the merge-commit OID was never persisted (a `gh pr view` failure at
   *      merge time): it is re-resolved from the live PR and persisted
   *      opportunistically, so the repair is durable;
   *   2. the OID is known but its object is not yet local (a failed or skipped
   *      fetch at merge time): the merge commit is fetched once, bounded, then
   *      the manifest is read from it.
   * If the merge OID genuinely cannot be resolved right now (no PR reachable) or
   * the object cannot be fetched, it returns `declaredVersion: null` with
   * `mergeVersionUnavailable: true` — an explicit, honest signal the caller can
   * render as "merge version temporarily unavailable — retry". It never
   * substitutes the reviewed head for a merged repository.
   */
  async resolveDeliveryVersion(delivery: DeliveryRepositoryRecord): Promise<{ declaredVersion: string | null; mergeVersionUnavailable: boolean; mergeCommitOid: string | null }> {
    const merged = delivery.status === "merged" || delivery.status === "tagged";
    if (!merged) {
      // Before a merge commit exists, the reviewed head is the only truth.
      return { declaredVersion: await this.declaredVersionAtCommit(delivery.localPath, delivery.headCommit), mergeVersionUnavailable: false, mergeCommitOid: delivery.mergeCommitOid };
    }
    let mergeOid = delivery.mergeCommitOid;
    if (!mergeOid) {
      // Failure path 1: the OID was never persisted. Re-resolve it from the live
      // PR and persist so the repair survives the next read.
      mergeOid = await this.resolveMergeCommitOid(delivery);
      if (mergeOid) {
        this.ledger.updateDeliveryRepository(delivery.runId, delivery.repositoryId, { status: delivery.status, mergeCommitOid: mergeOid });
      }
    }
    if (!mergeOid) {
      return { declaredVersion: null, mergeVersionUnavailable: true, mergeCommitOid: null };
    }
    // Failure path 2: ensure the merge commit's object is local, fetching once.
    if (!(await this.commitObjectPresent(delivery.localPath, mergeOid))) {
      await this.runner({ command: "git", args: ["fetch", "origin", delivery.baseBranch], cwd: delivery.localPath, timeoutMs: 120_000 });
      if (!(await this.commitObjectPresent(delivery.localPath, mergeOid))) {
        return { declaredVersion: null, mergeVersionUnavailable: true, mergeCommitOid: mergeOid };
      }
    }
    return { declaredVersion: await this.declaredVersionAtCommit(delivery.localPath, mergeOid), mergeVersionUnavailable: false, mergeCommitOid: mergeOid };
  }

  async execute(input: DeliveryExecutionInput): Promise<DeliveryRepositoryRecord> {
    const run = this.ledger.getRun(input.runId);
    if (!run) throw new DeliveryRefusal(`Run '${input.runId}' was not found`);
    if (run.status !== "ready") throw new DeliveryRefusal("Only a READY run can be delivered");
    const delivery = run.delivery?.repositories.find((repository) => repository.repositoryId === input.repositoryId);
    if (!delivery) throw new DeliveryRefusal(`Run '${input.runId}' has no reviewed delivery for '${input.repositoryId}'`);
    if (input.expectedHeadCommit && input.expectedHeadCommit !== delivery.headCommit) {
      throw new DeliveryRefusal("The reviewed head changed; refresh the delivery evidence before approving");
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
        throw new DeliveryRefusal(`This delivery is already tagged as '${delivery.releaseTag}'; it will not be re-tagged as '${input.tag}'`);
      }
      return delivery;
    }
    if (input.action === "create_draft_pr" && delivery.status !== "branch_pushed") {
      throw new DeliveryRefusal("Push the reviewed branch first");
    }
    if (input.action === "merge_pr" && delivery.status !== "draft_pr_created") {
      throw new DeliveryRefusal("Create the draft pull request first");
    }
    if (input.action === "tag_release") {
      if (delivery.status !== "merged") throw new DeliveryRefusal("Merge the pull request before tagging the release");
      if (!input.tag || !RELEASE_TAG_PATTERN.test(input.tag)) throw new DeliveryRefusal("Release tag names must be short version-like identifiers (letters, digits, dot, dash, underscore)");
      // The tag-truth gate runs INSIDE tag execution, after the immutable merge
      // commit OID is known, so it judges the artifact that will actually be
      // tagged rather than the mutable checkout (see declaredVersionAtCommit).
    }

    const remoteResult = await this.runner({ command: "git", args: ["remote", "get-url", "origin"], cwd: delivery.localPath, timeoutMs: 30_000 });
    if (remoteResult.exitCode !== 0) throw new Error(failureMessage(remoteResult, "Could not resolve the Git origin"));
    const remote = githubRemote(remoteResult.stdout);
    if (delivery.remoteUrl && delivery.remoteUrl !== remote.webUrl) throw new DeliveryRefusal("The live Git origin does not match the reviewed delivery remote");

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
    if (decision.outcome !== "allow") throw new DeliveryRefusal(decision.reason);

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

      if (!delivery.pullRequestUrl) throw new DeliveryRefusal("The delivery record has no pull request URL");

      if (input.action === "merge_pr") {
        // Never merge blind: read the LIVE pull-request state first. Three
        // refusals protect the owner's approval (panel findings):
        // conflicts, checks that are pending or failing, and a PR head that
        // is no longer the exact commit DevHarmonics reviewed.
        const view = await this.runner({ command: "gh", args: ["pr", "view", delivery.pullRequestUrl, "--json", "state,isDraft,mergeable,mergeStateStatus,headRefOid,statusCheckRollup"], cwd: delivery.localPath, timeoutMs: 60_000 });
        if (view.exitCode !== 0) throw new Error(failureMessage(view, "Could not read the live pull request state"));
        const state = JSON.parse(view.stdout) as { state: string; isDraft: boolean; mergeable: string; mergeStateStatus?: string; headRefOid?: string; statusCheckRollup?: Array<{ status?: string; conclusion?: string | null }> | null };
        if (state.state === "CLOSED") throw new DeliveryRefusal("The pull request was closed on GitHub; nothing to merge");
        if (state.state !== "MERGED") {
          if (state.headRefOid && state.headRefOid !== delivery.headCommit) {
            throw new DeliveryRefusal(`The pull request head (${state.headRefOid.slice(0, 12)}) is no longer the reviewed commit (${delivery.headCommit.slice(0, 12)}); new commits landed after review — re-run the review before approving a merge`);
          }
          if (state.mergeable === "CONFLICTING") throw new DeliveryRefusal("The pull request is not mergeable (conflicts with its base); resolve before approving the merge");
          if (state.mergeStateStatus && ["DIRTY", "BLOCKED"].includes(state.mergeStateStatus)) {
            throw new DeliveryRefusal(`GitHub reports the pull request as ${state.mergeStateStatus.toLowerCase()}; resolve the blocking condition before approving the merge`);
          }
          const checks = state.statusCheckRollup ?? [];
          const unfinished = checks.filter((check) => check.status && check.status !== "COMPLETED");
          const failed = checks.filter((check) => check.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion));
          if (unfinished.length) throw new DeliveryRefusal(`${unfinished.length} status check(s) are still running; approve the merge again when they finish`);
          if (failed.length) throw new DeliveryRefusal(`${failed.length} status check(s) failed; a red pull request is never merged`);
          if (state.isDraft) {
            const ready = await this.runner({ command: "gh", args: ["pr", "ready", delivery.pullRequestUrl], cwd: delivery.localPath, timeoutMs: 60_000 });
            if (ready.exitCode !== 0) throw new Error(failureMessage(ready, "Could not mark the pull request ready for review"));
          }
          const merge = await this.runner({ command: "gh", args: ["pr", "merge", delivery.pullRequestUrl, "--merge"], cwd: delivery.localPath, timeoutMs: 120_000 });
          if (merge.exitCode !== 0) throw new Error(failureMessage(merge, "Pull request merge failed"));
        }
        // ROUND2-002: capture the immutable merge commit OID now, and fetch its
        // object, as a CACHE that saves the GET path a round-trip on the happy
        // path. This persistence is deliberately best-effort — the merge is
        // already durable, so a missing OID or a failed fetch must never fail an
        // accomplished merge. It is NOT the source of truth: after ROUND3-001 the
        // GET path (resolveDeliveryVersion) is authoritative and self-heals both
        // transient failures here — a never-persisted OID is re-resolved from the
        // live PR at read time, and an unfetched object is fetched then — so a
        // merged repository's prefill always follows the merge commit and NEVER
        // degrades to the reviewed head.
        let mergeCommitOid: string | null = null;
        const mergeCommitView = await this.runner({ command: "gh", args: ["pr", "view", delivery.pullRequestUrl, "--json", "state,mergeCommit"], cwd: delivery.localPath, timeoutMs: 60_000 });
        if (mergeCommitView.exitCode === 0 && mergeCommitView.stdout.trim()) {
          try {
            const mergeCommitState = JSON.parse(mergeCommitView.stdout) as { state?: string; mergeCommit?: { oid?: string } | null };
            if (mergeCommitState.state === "MERGED" && mergeCommitState.mergeCommit?.oid) {
              mergeCommitOid = mergeCommitState.mergeCommit.oid;
              await this.runner({ command: "git", args: ["fetch", "origin", delivery.baseBranch], cwd: delivery.localPath, timeoutMs: 120_000 });
            }
          } catch {
            // A malformed merge-commit read is best-effort enrichment only; the
            // merge stands and the tag step re-resolves the OID authoritatively.
          }
        }
        const updated = this.ledger.updateDeliveryRepository(input.runId, input.repositoryId, {
          status: "merged", remoteUrl: remote.webUrl, approvalId: input.approval.id, error: null, mergeCommitOid,
        });
        this.ledger.addEvent(input.runId, "delivery.merged", `${input.repositoryId}: merged the reviewed pull request under owner approval`, requestRecord);
        return updated;
      }

      // tag_release: the tag lands on the ACTUAL merge commit GitHub reports,
      // never on an assumed head.
      const mergedView = await this.runner({ command: "gh", args: ["pr", "view", delivery.pullRequestUrl, "--json", "state,mergeCommit"], cwd: delivery.localPath, timeoutMs: 60_000 });
      if (mergedView.exitCode !== 0) throw new Error(failureMessage(mergedView, "Could not read the merged pull request"));
      const mergedState = JSON.parse(mergedView.stdout) as { state: string; mergeCommit: { oid: string } | null };
      if (mergedState.state !== "MERGED" || !mergedState.mergeCommit?.oid) throw new DeliveryRefusal("The pull request has no merge commit to tag");
      const fetch = await this.runner({ command: "git", args: ["fetch", "origin", delivery.baseBranch], cwd: delivery.localPath, timeoutMs: 120_000 });
      if (fetch.exitCode !== 0) throw new Error(failureMessage(fetch, "Could not fetch the merged base branch"));
      // Tag-truth gate: resolve the declared version from the exact merge commit
      // that will be tagged, not the checkout. This MUST run after the fetch —
      // the merge commit was just created on GitHub, and before the fetch it
      // does not exist locally, so `git show` would fail and the gate would
      // silently no-op on the most common real path (boss-review finding on
      // the audit fix, 2026-07-22). When the merged artifact's own files
      // contradict the requested tag, refuse with both values unless the owner
      // explicitly confirmed the mismatch.
      const declaredVersion = await this.declaredVersionAtCommit(delivery.localPath, mergedState.mergeCommit.oid);
      if (declaredVersion && !versionsAgree(input.tag!, declaredVersion) && !input.confirmVersionMismatch) {
        throw new VersionMismatchRefusal(declaredVersion, input.tag!);
      }
      // A prior attempt may have created the local tag and failed only the
      // push (panel finding): reuse a local tag that points at the exact merge
      // commit; refuse one that points anywhere else.
      const existingTag = await this.runner({ command: "git", args: ["rev-parse", "-q", "--verify", `refs/tags/${input.tag}^{commit}`], cwd: delivery.localPath, timeoutMs: 30_000 });
      const existingOid = existingTag.exitCode === 0 ? existingTag.stdout.trim() : null;
      if (existingOid && existingOid !== mergedState.mergeCommit.oid) {
        throw new DeliveryRefusal(`A local tag '${input.tag}' already exists on a different commit (${existingOid.slice(0, 12)}); delete or rename it before tagging this release`);
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
