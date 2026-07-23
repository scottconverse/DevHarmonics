import assert from "node:assert/strict";
import test from "node:test";
import { reconcileDeliveryRepository, reconcileDelivery, type ReconciliationFinding } from "../src/reconciliation.js";
import type { DeliveryRepositoryRecord, DeliveryRepositoryStatus, DeliveryHandoffRecord } from "../src/types.js";
import { runProcess } from "../src/process.js";
import type { ProcessRequest, ProcessResult } from "../src/process.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function fixtureDelivery(overrides: Partial<DeliveryRepositoryRecord> = {}): DeliveryRepositoryRecord {
  return {
    runId: "run-1",
    repositoryId: "repo:fixture",
    localPath: "/tmp/fixture",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    branch: "devharmonics/recon1",
    remoteUrl: "https://github.com/example/fixture",
    status: "branch_pushed",
    pullRequestUrl: null,
    approvalId: "approval-1",
    releaseTag: null,
    mergeCommitOid: null,
    error: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

function ok(stdout: string): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
}

function fail(stderr: string): ProcessResult {
  return { stdout: "", stderr, exitCode: 1, durationMs: 1, timedOut: false };
}

function findingFor(findings: ReconciliationFinding[], artifact: ReconciliationFinding["artifact"]): ReconciliationFinding | undefined {
  return findings.find((finding) => finding.artifact === artifact);
}

test("branch artifact: matches when the remote head equals the reviewed commit", async () => {
  const delivery = fixtureDelivery();
  const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
    if (request.command === "git" && request.args[0] === "ls-remote") {
      return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    }
    throw new Error(`unexpected call: ${request.command} ${request.args.join(" ")}`);
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "matches");
  assert.match(branch.message, /still at the reviewed commit/i);
  assert.equal(result.hasDivergence, false);
  assert.equal(result.hasUnobserved, false);
});

test("branch artifact: diverges when the branch was deleted on the remote", async () => {
  const delivery = fixtureDelivery();
  const runner = async () => ok(""); // empty ls-remote output: branch gone
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "diverged");
  // Plain-English finding naming ledger claim vs observed reality.
  assert.match(branch.message, new RegExp(delivery.branch));
  assert.match(branch.message, /no longer has that branch/i);
  assert.equal(result.hasDivergence, true);
});

test("branch artifact: diverges when the branch head moved off the reviewed commit", async () => {
  const delivery = fixtureDelivery();
  const movedOid = "c".repeat(40);
  const runner = async () => ok(`${movedOid}\trefs/heads/${delivery.branch}\n`);
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "diverged");
  assert.match(branch.message, /new commits landed after review/i);
});

test("branch artifact: unobserved when git ls-remote fails (network/auth), never reported as a confirmation", async () => {
  const delivery = fixtureDelivery();
  const runner = async () => fail("fatal: could not read from remote repository.");
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "unobserved");
  assert.match(branch.message, /could not check/i);
  assert.equal(result.hasDivergence, false, "an unobserved artifact is never counted as a divergence");
  assert.equal(result.hasUnobserved, true);
});

test("branch artifact: unobserved when the runner itself throws (e.g. git is not installed)", async () => {
  const delivery = fixtureDelivery();
  const runner = async () => { throw new Error("spawn git ENOENT"); };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "unobserved");
  assert.match(branch.message, /ENOENT/);
});

test("bounded timeout: a hanging tool is reported unobserved, not left to hang the caller forever", async () => {
  const delivery = fixtureDelivery();
  const hangingRunner = () => new Promise<ProcessResult>(() => {}); // never resolves
  const startedAt = Date.now();
  const result = await reconcileDeliveryRepository(delivery, hangingRunner, 200);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5_000, `reconciliation must resolve near the bounded timeout, took ${elapsedMs}ms`);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "unobserved");
  assert.match(branch.message, /timed out/i);
});

test("branch artifact: a missing branch on a MERGED pull request whose head matches the reviewed commit is not a divergence — routine cleanup", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(""); // branch deleted after merge
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "matches");
  assert.match(branch.message, /routine cleanup/i);
  assert.equal(result.hasDivergence, false);
});

// M-merged-head: "routine cleanup" now composes with the head-match rule — a
// merged PR whose head does not match (or was not reported) the reviewed
// commit can no longer be assumed a clean merge, so a missing branch under
// it must not be waved away either.
test("branch artifact: a missing branch on a MERGED pull request whose head does NOT match the reviewed commit is a real divergence, not routine cleanup", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const differentHead = "e".repeat(40);
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(""); // branch missing
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: differentHead, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "diverged");
  assert.match(branch.message, /no longer has that branch/i);
});

test("branch artifact: a missing branch on a MERGED pull request whose head commit was not reported stays unobserved, not routine cleanup", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(""); // branch missing
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", statusCheckRollup: [] })); // no headRefOid
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "unobserved");
  assert.equal(result.hasDivergence, false);
  assert.equal(result.hasUnobserved, true);
});

test("branch artifact: a missing branch on a NON-merged (open) pull request still diverges", async () => {
  const delivery = fixtureDelivery({ status: "draft_pr_created", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(""); // branch missing, PR never merged
    if (request.command === "gh") return ok(JSON.stringify({ state: "OPEN", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "diverged");
  assert.match(branch.message, /no longer has that branch/i);
});

test("branch artifact: a missing branch is unobserved (never matches, never diverged) when the PR state itself could not be checked", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(""); // branch missing
    if (request.command === "gh") return fail("gh: not logged in to any GitHub hosts. Run gh auth login");
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "unobserved");
  assert.match(branch.message, /could not check/i);
  assert.equal(result.hasDivergence, false);
  assert.equal(result.hasUnobserved, true);
});

test("branch artifact: a branch that exists but moved to a different commit still diverges even when the pull request is merged", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const movedOid = "c".repeat(40);
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${movedOid}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "diverged");
  assert.match(branch.message, /new commits landed after review/i);
});

test("pull_request artifact: an open draft PR at the reviewed head matches", async () => {
  const delivery = fixtureDelivery({ status: "draft_pr_created", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh" && request.args[1] === "view") {
      return ok(JSON.stringify({ state: "OPEN", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    }
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const pr = findingFor(result.findings, "pull_request")!;
  assert.equal(pr.state, "matches");
});

test("pull_request artifact: diverges when a draft PR was closed without merge", async () => {
  const delivery = fixtureDelivery({ status: "draft_pr_created", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "CLOSED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const pr = findingFor(result.findings, "pull_request")!;
  assert.equal(pr.state, "diverged");
  assert.match(pr.message, /closed without merging/i);
});

test("pull_request artifact: a merged delivery whose PR is still MERGED on GitHub matches", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  assert.equal(findingFor(result.findings, "pull_request")!.state, "matches");
  assert.equal(findingFor(result.findings, "checks")!.state, "matches");
});

test("pull_request artifact: diverges when a merged delivery's PR is no longer MERGED on GitHub", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "CLOSED", statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const pr = findingFor(result.findings, "pull_request")!;
  assert.equal(pr.state, "diverged");
  assert.match(pr.message, /records this pull request as merged/i);
});

// M-merged-head
test("pull_request artifact: a merged delivery whose merged head does not match the reviewed commit diverges, naming both commits", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const differentHead = "e".repeat(40);
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: differentHead, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const pr = findingFor(result.findings, "pull_request")!;
  assert.equal(pr.state, "diverged");
  assert.match(pr.message, new RegExp(delivery.headCommit.slice(0, 12)), "names the ledger's recorded commit");
  assert.match(pr.message, new RegExp(differentHead.slice(0, 12)), "names the actually-merged commit");
});

test("pull_request artifact: a merged delivery whose response omits the merged head commit is unobserved, never a match", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", statusCheckRollup: [] })); // no headRefOid
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const pr = findingFor(result.findings, "pull_request")!;
  assert.equal(pr.state, "unobserved");
  assert.match(pr.message, /could not check/i);
});

// minor-open-pr-head
test("pull_request artifact: an open pull request with no reported head commit is unobserved, never a match", async () => {
  const delivery = fixtureDelivery({ status: "draft_pr_created", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "OPEN", statusCheckRollup: [] })); // no headRefOid
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const pr = findingFor(result.findings, "pull_request")!;
  assert.equal(pr.state, "unobserved");
  assert.match(pr.message, /could not check/i);
});

// M-checks-pending
test("checks artifact: unobserved when no checks have been reported yet (empty rollup)", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const checks = findingFor(result.findings, "checks")!;
  assert.equal(checks.state, "unobserved");
  assert.match(checks.message, /still running or not reported/i);
  assert.equal(result.hasDivergence, false);
  assert.equal(result.hasUnobserved, true);
});

test("checks artifact: unobserved when a check is still running (non-completed status)", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const checks = findingFor(result.findings, "checks")!;
  assert.equal(checks.state, "unobserved");
});

test("checks artifact: unobserved when a completed check has a null conclusion", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [{ status: "COMPLETED", conclusion: null }] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const checks = findingFor(result.findings, "checks")!;
  assert.equal(checks.state, "unobserved");
});

test("checks artifact: a positively observed failure still diverges even while another check is still pending", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") {
      return ok(JSON.stringify({
        state: "MERGED",
        headRefOid: delivery.headCommit,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS", conclusion: null }],
      }));
    }
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const checks = findingFor(result.findings, "checks")!;
  assert.equal(checks.state, "diverged");
});

test("checks artifact: diverges when a check now reports a failing conclusion", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const checks = findingFor(result.findings, "checks")!;
  assert.equal(checks.state, "diverged");
  assert.match(checks.message, /failing result/i);
  assert.equal(result.hasDivergence, true);
});

test("pull_request and checks artifacts: a single failed gh read reports BOTH as unobserved, never one confirming the other", async () => {
  const delivery = fixtureDelivery({ status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return fail("gh: not logged in to any GitHub hosts. Run gh auth login");
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  assert.equal(findingFor(result.findings, "pull_request")!.state, "unobserved");
  assert.equal(findingFor(result.findings, "checks")!.state, "unobserved");
  assert.equal(result.hasDivergence, false);
  assert.equal(result.hasUnobserved, true);
});

test("tag artifact: matches when the release tag is still present on the remote and points at the recorded merge commit", async () => {
  const mergeCommit = "d".repeat(40);
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3", mergeCommitOid: mergeCommit });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) return ok(`${mergeCommit}\trefs/tags/v1.2.3\n`);
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "matches");
});

test("tag artifact: diverges when the release tag is missing on the remote", async () => {
  const mergeCommit = "d".repeat(40);
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3", mergeCommitOid: mergeCommit });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) return ok("");
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "diverged");
  assert.match(tag.message, /no longer has that tag/i);
});

// M-tag-oid
test("tag artifact: diverges when a same-named tag points at a different commit than the recorded merge commit, naming both", async () => {
  const mergeCommit = "d".repeat(40);
  const movedTagOid = "f".repeat(40);
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3", mergeCommitOid: mergeCommit });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) return ok(`${movedTagOid}\trefs/tags/v1.2.3\n`);
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "diverged");
  assert.match(tag.message, new RegExp(mergeCommit.slice(0, 12)), "names the recorded merge commit");
  assert.match(tag.message, new RegExp(movedTagOid.slice(0, 12)), "names where the tag actually points");
  assert.equal(result.hasDivergence, true);
});

test("tag artifact: peels an annotated tag to its target commit before comparing, rather than comparing the tag object's own oid", async () => {
  const mergeCommit = "d".repeat(40);
  const tagObjectOid = "a".repeat(40); // the annotated tag object itself — NOT the commit it points at
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3", mergeCommitOid: mergeCommit });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) {
      return ok(`${tagObjectOid}\trefs/tags/v1.2.3\n${mergeCommit}\trefs/tags/v1.2.3^{}\n`);
    }
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "matches", "the peeled commit target matches the recorded merge commit even though the tag object's own oid does not");
});

test("tag artifact: unobserved when no merge commit was recorded to compare against, even though the tag exists", async () => {
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3", mergeCommitOid: null });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) return ok(`${"d".repeat(40)}\trefs/tags/v1.2.3\n`);
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    // gh response also omits mergeCommit, so there is no live fallback either.
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "unobserved");
  assert.equal(result.hasDivergence, false);
  assert.equal(result.hasUnobserved, true);
});

test("tag artifact: falls back to the merge commit observed live from the pull request when the ledger's cached merge commit is missing", async () => {
  const liveMergeCommit = "d".repeat(40);
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3", mergeCommitOid: null });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) return ok(`${liveMergeCommit}\trefs/tags/v1.2.3\n`);
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [], mergeCommit: { oid: liveMergeCommit } }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "matches");
});

// M-origin
test("branch artifact: queries the recorded remote URL directly, never the checkout's mutable 'origin'", async () => {
  const delivery = fixtureDelivery({ remoteUrl: "https://github.com/example/fixture-real" });
  let seenArgs: string[] = [];
  const runner = async (request: ProcessRequest) => {
    seenArgs = request.args;
    return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
  };
  await reconcileDeliveryRepository(delivery, runner);
  assert.ok(seenArgs.includes(delivery.remoteUrl!), "the recorded remote URL is the query target");
  assert.ok(!seenArgs.includes("origin"), "the mutable checkout remote name is never used");
});

test("branch artifact: unobserved when no remote URL was recorded for this delivery", async () => {
  const delivery = fixtureDelivery({ remoteUrl: null });
  const runner = async () => { throw new Error("must not call any external tool with no remote URL to query"); };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "unobserved");
  assert.match(branch.message, /no remote url was recorded/i);
});

test("tag artifact: queries the recorded remote URL directly, never 'origin'", async () => {
  const mergeCommit = "d".repeat(40);
  const delivery = fixtureDelivery({
    status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3",
    mergeCommitOid: mergeCommit, remoteUrl: "https://github.com/example/fixture-real",
  });
  let seenTagArgs: string[] = [];
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) {
      seenTagArgs = request.args;
      return ok(`${mergeCommit}\trefs/tags/v1.2.3\n`);
    }
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", headRefOid: delivery.headCommit, statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  await reconcileDeliveryRepository(delivery, runner);
  assert.ok(seenTagArgs.includes(delivery.remoteUrl!), "the recorded remote URL is the query target");
  assert.ok(!seenTagArgs.includes("origin"), "the mutable checkout remote name is never used");
});

test("a 'prepared' delivery record has nothing delivered yet: reconciliation returns no findings, invents nothing", async () => {
  const delivery = fixtureDelivery({ status: "prepared" });
  const runner = async () => { throw new Error("must not call any external tool for a record with nothing delivered"); };
  const result = await reconcileDeliveryRepository(delivery, runner);
  assert.deepEqual(result.findings, []);
  assert.equal(result.hasDivergence, false);
  assert.equal(result.hasUnobserved, false);
});

// minor-failed-push: a 'failed' record's branch state is unknown, not
// absent — the push_branch step reported failure, but it may have reached
// the remote before that failure was reported (a lost acknowledgement), so
// reconciliation still observes the branch, worded to make the failed
// attempt explicit either way. There is never a pull request or tag to
// check for a genuinely 'failed' record (see OBSERVABLE_BRANCH_STATUSES).
test("a 'failed' delivery record: branch absent on the remote is consistent with the reported failure", async () => {
  const delivery = fixtureDelivery({ status: "failed", pullRequestUrl: null, releaseTag: null });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(""); // nothing on the remote
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  assert.equal(result.findings.length, 1, "only the branch is ever checked for a failed record");
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "matches");
  assert.match(branch.message, /recorded this push as failed/i);
  assert.match(branch.message, /does not exist/i);
  assert.equal(result.hasDivergence, false);
});

test("a 'failed' delivery record: branch present at the expected commit is reported as a possible actual success despite the recorded failure", async () => {
  const delivery = fixtureDelivery({ status: "failed", pullRequestUrl: null, releaseTag: null });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "diverged");
  assert.match(branch.message, /recorded this push as failed/i);
  assert.match(branch.message, /may have actually succeeded/i);
  assert.equal(result.hasDivergence, true);
});

test("a 'failed' delivery record: branch present at an unexpected commit is reported diverged, wording the failed attempt", async () => {
  const delivery = fixtureDelivery({ status: "failed", pullRequestUrl: null, releaseTag: null });
  const otherOid = "c".repeat(40);
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote") return ok(`${otherOid}\trefs/heads/${delivery.branch}\n`);
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const branch = findingFor(result.findings, "branch")!;
  assert.equal(branch.state, "diverged");
  assert.match(branch.message, /recorded this push as failed/i);
  assert.match(branch.message, new RegExp(otherOid.slice(0, 12)));
});

// M-fanout
test("reconcileDelivery bounds concurrency across a run's repositories instead of starting all of them at once", async () => {
  const repositories = Array.from({ length: 7 }, (_, index) => fixtureDelivery({ repositoryId: `repo:${index}`, branch: `devharmonics/recon-${index}` }));
  const run: DeliveryHandoffRecord = { runId: "fanout-run-1", status: "branch_pushed", repositories };
  let concurrent = 0;
  let maxConcurrent = 0;
  const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent -= 1;
    return ok(`${repositories[0]!.headCommit}\t${request.args[2]}\n`);
  };
  const results = await reconcileDelivery({ delivery: run }, runner);
  assert.equal(results.length, 7);
  assert.ok(maxConcurrent <= 3, `expected at most 3 concurrent checks, saw ${maxConcurrent}`);
  assert.ok(maxConcurrent >= 2, "the pool should still run more than one at a time");
});

test("reconcileDelivery reuses an in-flight reconciliation for the same run instead of stacking a second one", async () => {
  const repositories = [fixtureDelivery({ repositoryId: "repo:dedupe" })];
  const run: DeliveryHandoffRecord = { runId: "fanout-run-dedupe", status: "branch_pushed", repositories };
  let callCount = 0;
  const runner = async (request: ProcessRequest): Promise<ProcessResult> => {
    callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ok(`${repositories[0]!.headCommit}\trefs/heads/${repositories[0]!.branch}\n`);
  };
  const first = reconcileDelivery({ delivery: run }, runner);
  const second = reconcileDelivery({ delivery: run }, runner);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(callCount, 1, "the second call reused the first's in-flight reconciliation instead of starting a new one");
  assert.deepEqual(firstResult, secondResult);

  // Once settled, a later call starts a fresh reconciliation (never stuck forever) —
  // a genuinely new run, so only its non-timestamp shape is compared.
  const third = await reconcileDelivery({ delivery: run }, runner);
  assert.equal(callCount, 2);
  assert.equal(third.length, firstResult.length);
  assert.deepEqual(third[0]!.findings, firstResult[0]!.findings);
});

// M-timeout-abort: exercises the REAL runProcess (not a fake), proving the
// timeout / abort path actually terminates a genuinely long-running child
// process and only resolves once it is confirmed dead — a spawned process
// that sleeps 60s must not make this test wait anywhere near that long.
test("runProcess terminates a still-running process on timeout and resolves once it is confirmed dead", async () => {
  const startedAt = Date.now();
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: process.cwd(),
    timeoutMs: 300,
    killGraceMs: 300,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs < 5_000, `expected the process to be confirmed dead well before 60s, took ${elapsedMs}ms`);
});

test("runProcess honors an external AbortSignal: terminates the process and resolves once confirmed dead", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const resultPromise = runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: process.cwd(),
    timeoutMs: 60_000,
    killGraceMs: 300,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  const result = await resultPromise;
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs < 5_000, `expected the process to be confirmed dead shortly after abort, took ${elapsedMs}ms`);
});

// Windows-only regression: provider CLIs on Windows are cmd/shim processes
// whose real work happens in a GRANDCHILD that inherits the stdio pipes.
// child.kill() only kills the direct child (the .cmd's cmd.exe host); the
// orphaned grandchild keeps the inherited stdout/stderr pipe handles open,
// so 'close' never fires and runProcess never settles. This fixture is a
// .cmd wrapper that runs node directly (not backgrounded), inheriting
// stdio, so node.exe is a true grandchild of this test process — exactly
// the shape a real Windows provider CLI shim produces. Skipped on POSIX,
// where there is no cmd/shim indirection to reproduce.
if (process.platform === "win32") {
  test("runProcess on Windows kills the whole process tree, not just the direct .cmd child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-tree-kill-"));
    try {
      const pidfile = path.join(root, "grandchild.pid");
      const wrapper = path.join(root, "hanging-tree.cmd");
      // No `start /b`: cmd.exe runs node in the foreground as its own child,
      // inheriting cmd.exe's stdio (the pipes runProcess set up). That makes
      // node.exe a grandchild relative to runProcess's own child (cmd.exe).
      await writeFile(
        wrapper,
        `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000);" "${pidfile}"\r\n`,
        "utf8",
      );

      const startedAt = Date.now();
      const result = await runProcess({
        command: wrapper,
        args: [],
        cwd: root,
        timeoutMs: 2_000,
        killGraceMs: 300,
      });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.timedOut, true);
      assert.ok(elapsedMs < 15_000, `expected runProcess to settle well under 15s, took ${elapsedMs}ms`);

      assert.ok(existsSync(pidfile), "the grandchild node process should have written its pidfile before the 2s timeout");
      const grandchildPid = Number((await readFile(pidfile, "utf8")).trim());
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `expected a valid pid in the pidfile, got ${grandchildPid}`);

      const isAlive = (pid: number): boolean => {
        const check = spawnSync("tasklist", ["/fi", `PID eq ${pid}`, "/nh"], { encoding: "utf8" });
        return check.stdout.includes(String(pid));
      };

      // Give the tree-kill (and its drain-timer backstop) a little room to
      // finish reaping the grandchild beyond runProcess's own settlement.
      const deadline = Date.now() + 8_000;
      let alive = isAlive(grandchildPid);
      while (alive && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        alive = isAlive(grandchildPid);
      }
      assert.equal(alive, false, `expected the orphaned grandchild (pid ${grandchildPid}) to be dead, but it is still running`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
