import assert from "node:assert/strict";
import test from "node:test";
import { reconcileDeliveryRepository, type ReconciliationFinding } from "../src/reconciliation.js";
import type { DeliveryRepositoryRecord, DeliveryRepositoryStatus } from "../src/types.js";
import type { ProcessRequest, ProcessResult } from "../src/process.js";

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

test("tag artifact: matches when the release tag is still present on the remote", async () => {
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) return ok(`${"d".repeat(40)}\trefs/tags/v1.2.3\n`);
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "matches");
});

test("tag artifact: diverges when the release tag is missing on the remote", async () => {
  const delivery = fixtureDelivery({ status: "tagged", pullRequestUrl: "https://github.com/example/fixture/pull/1", releaseTag: "v1.2.3" });
  const runner = async (request: ProcessRequest) => {
    if (request.args[0] === "ls-remote" && request.args.includes("--tags")) return ok("");
    if (request.args[0] === "ls-remote") return ok(`${delivery.headCommit}\trefs/heads/${delivery.branch}\n`);
    if (request.command === "gh") return ok(JSON.stringify({ state: "MERGED", statusCheckRollup: [] }));
    throw new Error("unexpected call");
  };
  const result = await reconcileDeliveryRepository(delivery, runner);
  const tag = findingFor(result.findings, "tag")!;
  assert.equal(tag.state, "diverged");
  assert.match(tag.message, /no longer has that tag/i);
});

const NOTHING_DELIVERED_STATUSES: DeliveryRepositoryStatus[] = ["prepared", "failed"];
for (const status of NOTHING_DELIVERED_STATUSES) {
  test(`a '${status}' delivery record has nothing delivered yet: reconciliation returns no findings, invents nothing`, async () => {
    const delivery = fixtureDelivery({ status });
    const runner = async () => { throw new Error("must not call any external tool for a record with nothing delivered"); };
    const result = await reconcileDeliveryRepository(delivery, runner);
    assert.deepEqual(result.findings, []);
    assert.equal(result.hasDivergence, false);
    assert.equal(result.hasUnobserved, false);
  });
}
