import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStatusExportRecords,
  classify,
  classifyBranch,
  classifyChecks,
  classifyPullRequest,
  classifyTag,
  generateStatusExportHtml,
  parseGitHubRepo,
  renderStatusExportHtml,
  type StatusExportRecord,
} from "../src/status-export.js";
import type { DeliveryRepositoryRecord, ObjectiveRecord, RunSummary } from "../src/types.js";
import type { ProductRecord } from "../src/ledger.js";

// DH-645 S4 fixtures. Same hand-built RunSummary discipline as the inbox
// fixtures in test/core.test.ts (inboxFixtureRun/inboxFixtureRepository):
// StatusExportRecord is a PURE projection of the exact shape Ledger.listRuns()
// already serves, so no DB is needed to test it.
const AGENT_FINAL_REVIEW_MARKER = "AGENT-WROTE-THIS-FINAL-REVIEW-VERDICT-MARKER";
const AGENT_PLAN_SUMMARY_MARKER = "AGENT-WROTE-THIS-PLAN-SUMMARY-MARKER";
const AGENT_TASK_DESCRIPTION_MARKER = "AGENT-WROTE-THIS-TASK-DESCRIPTION-MARKER";
const AGENT_DELIVERY_ERROR_MARKER = "AGENT-WROTE-THIS-DELIVERY-ERROR-MARKER";
const AGENT_PLAN_RATIONALE_MARKER = "AGENT-WROTE-THIS-PLAN-RATIONALE-MARKER";

function exportFixtureRepository(overrides: Partial<DeliveryRepositoryRecord> = {}): DeliveryRepositoryRecord {
  return {
    runId: "run-fixture",
    repositoryId: "repo:fixture",
    localPath: "/tmp/fixture",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    branch: "devharmonics/fixture",
    remoteUrl: "https://github.com/example-owner/example-repo",
    status: "draft_pr_created",
    pullRequestUrl: "https://github.com/example-owner/example-repo/pull/42",
    approvalId: "approval-1",
    releaseTag: null,
    mergeCommitOid: null,
    error: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:05:00.000Z",
    ...overrides,
  };
}

function exportFixtureRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-fixture",
    goal: "Ship the CSV export to the customer report",
    goalSummary: "Ship the CSV export to the customer report",
    projectPath: "/tmp/project",
    autonomy: "supervised",
    status: "ready",
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-20T10:05:00.000Z",
    finalReview: null,
    resumedFrom: null,
    objectiveId: null,
    approvedPlanRevision: null,
    workflowRevisionHash: null,
    plan: null,
    integrationSet: null,
    delivery: null,
    tasks: [],
    events: [],
    ...overrides,
  };
}

test("buildStatusExportRecords includes only owner-held identifiers from delivered repositories", () => {
  const run = exportFixtureRun({
    delivery: {
      runId: "run-fixture",
      status: "draft_pr_created",
      repositories: [
        exportFixtureRepository({ repositoryId: "repo:pending-push", status: "prepared" }), // nothing delivered yet: excluded
        exportFixtureRepository({ repositoryId: "repo:failed", status: "failed" }), // never reached the remote: excluded
        exportFixtureRepository({ repositoryId: "repo:done", status: "tagged", releaseTag: "v1.2.0" }),
      ],
    },
  });
  const product: ProductRecord = {
    id: "product-1",
    name: "CivicSuite",
    organizationUrl: "https://github.com/example-owner",
    description: "d",
    repositories: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
  const objective: ObjectiveRecord = {
    id: "objective-1",
    outcome: "o",
    acceptanceCriteria: [],
    constraints: [],
    projectPath: "/tmp/project",
    productId: "product-1",
    repositoryIds: ["repo:done"],
    risk: "low",
    autonomy: "supervised",
    priority: "normal",
    policyNotes: [],
    revision: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    workflowRevisionHash: null,
  };
  const linkedRun = { ...run, objectiveId: "objective-1" };

  const records = buildStatusExportRecords([linkedRun], [product], [objective]);

  assert.equal(records.length, 1, "only the delivered (tagged) repository produces a record; prepared and failed do not");
  const record = records[0]!;
  assert.equal(record.repositoryId, "repo:done");
  assert.equal(record.repositoryUrl, "https://github.com/example-owner/example-repo");
  assert.equal(record.branch, "devharmonics/fixture");
  assert.equal(record.reviewedCommitSha, "b".repeat(40));
  assert.equal(record.pullRequestUrl, "https://github.com/example-owner/example-repo/pull/42");
  assert.equal(record.pullRequestNumber, 42);
  assert.equal(record.tagName, "v1.2.0");
  assert.equal(record.runTitle, "Ship the CSV export to the customer report");
  assert.equal(record.productTitle, "CivicSuite");
  assert.equal(record.deliveredAt, "2026-07-20T10:05:00.000Z");
});

test("buildStatusExportRecords never surfaces a tag for an untagged delivery, even if releaseTag is stale on the record", () => {
  const run = exportFixtureRun({
    delivery: {
      runId: "run-fixture",
      status: "merged",
      repositories: [exportFixtureRepository({ status: "merged", releaseTag: "leftover-tag" })],
    },
  });
  const [record] = buildStatusExportRecords([run]);
  assert.equal(record!.tagName, null, "a merged (not tagged) repository must not claim a release tag");
});

test("generateStatusExportHtml contains no agent-authored value from a seeded ledger, only allowlisted identifiers", () => {
  const run = exportFixtureRun({
    finalReview: AGENT_FINAL_REVIEW_MARKER,
    plan: {
      summary: AGENT_PLAN_SUMMARY_MARKER,
      recommendedConcurrency: 1,
      tasks: [
        {
          id: "t1",
          title: "Implement export",
          description: AGENT_TASK_DESCRIPTION_MARKER,
          dependencies: [],
          preferredProvider: null,
          checks: [],
        },
      ],
    },
    tasks: [
      {
        id: "t1",
        title: "Implement export",
        description: AGENT_TASK_DESCRIPTION_MARKER,
        kind: "implementation",
        repositoryIds: ["repo:done"],
        repositoryScope: [],
        permission: "workspace_write",
        risk: "low",
        acceptanceCriteria: [],
        expectedArtifacts: [],
        status: "passed",
        provider: "claude",
        assignment: null,
        attemptCount: 1,
        checks: [],
      },
    ],
    delivery: {
      runId: "run-fixture",
      status: "merged",
      repositories: [
        exportFixtureRepository({
          status: "merged",
          error: AGENT_DELIVERY_ERROR_MARKER,
        }),
      ],
    },
  });

  const html = generateStatusExportHtml([run], [], [], new Date("2026-07-22T12:00:00.000Z"));

  assert.doesNotMatch(html, new RegExp(AGENT_FINAL_REVIEW_MARKER), "the run's final review (agent-written verdict) must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_PLAN_SUMMARY_MARKER), "the plan summary (agent-written) must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_TASK_DESCRIPTION_MARKER), "a task description (agent-written) must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_DELIVERY_ERROR_MARKER), "a delivery error message must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_PLAN_RATIONALE_MARKER), "a plan rationale must never be embedded (not present in fixture, asserted for completeness)");

  // The allowlisted identifiers DO appear.
  assert.match(html, /devharmonics\/fixture/, "the branch name is an identifier and must appear");
  assert.match(html, /b{12}/, "the reviewed commit sha (short form) is an identifier and must appear");
  assert.match(html, /example-owner\/example-repo/, "the repository is an identifier and must appear");
  assert.match(html, /Ship the CSV export to the customer report/, "the owner-typed run goal is an identifier and must appear");
});

test("renderStatusExportHtml shows the graceful empty state when there are no records", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(html, /no deliveries recorded yet/i);
});

test("renderStatusExportHtml opens with the purpose line, the three-state legend, and inline JS that fetches GitHub live", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(html, /Generated by DevHarmonics on/, "purpose line must state when it was generated");
  assert.match(html, /fetched live from GitHub when you open this page/i, "purpose line must state the live-fetch contract");
  assert.match(html, /matches/i);
  assert.match(html, /diverged/i);
  assert.match(html, /could not check/i);
  assert.match(html, /api\.github\.com/, "the page must call the real GitHub API, not a placeholder");
  assert.match(html, /<script/i, "the page must ship its own inline JS, no external assets");
  assert.doesNotMatch(html, /<script[^>]+src=/i, "no externally-hosted script — inline only");
  assert.doesNotMatch(html, /<link[^>]+href="https?:/i, "no externally-hosted stylesheet");
});

test("renderStatusExportHtml documents the unauthenticated GitHub rate limit", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(html, /60\b.*(requests|per hour)|rate limit/i, "the page must tell the owner about the unauthenticated GitHub rate limit");
});

// --- classify(): the pure view-time classifier, unit-tested directly in
// Node with FAKE fetch responses (never a real GitHub call), per DH-645 S4's
// TDD instruction. These are the exact functions whose .toString() is
// embedded verbatim into the shipped page by renderStatusExportHtml — see
// the identity assertion at the bottom of this block.

test("classifyBranch: matches when the observed sha equals the reviewed commit", () => {
  const result = classifyBranch(
    { branch: "devharmonics/fixture", sha: "b".repeat(40) },
    { ok: true, status: 200, body: { commit: { sha: "b".repeat(40) } } },
  );
  assert.equal(result.state, "matches");
});

test("classifyBranch: diverged when the observed sha differs from the reviewed commit", () => {
  const result = classifyBranch(
    { branch: "devharmonics/fixture", sha: "b".repeat(40) },
    { ok: true, status: 200, body: { commit: { sha: "c".repeat(40) } } },
  );
  assert.equal(result.state, "diverged");
  assert.match(result.message, /new commits landed after review/i);
});

test("classifyBranch: a missing branch diverges when no pull request merge signal is available", () => {
  const result = classifyBranch({ branch: "devharmonics/fixture", sha: "b".repeat(40) }, { ok: true, status: 404 });
  assert.equal(result.state, "diverged");
});

test("classifyBranch: a missing branch matches (routine cleanup) when the observed pull request merged", () => {
  const result = classifyBranch(
    { branch: "devharmonics/fixture", sha: "b".repeat(40), mergeSignal: "merged" },
    { ok: true, status: 404 },
  );
  assert.equal(result.state, "matches");
  assert.match(result.message, /routine cleanup/i);
});

test("classifyBranch: unobserved when the fetch failed (offline, rate-limited, etc.)", () => {
  const result = classifyBranch(
    { branch: "devharmonics/fixture", sha: "b".repeat(40) },
    { ok: false, reason: "network error" },
  );
  assert.equal(result.state, "unobserved");
  assert.match(result.message, /network error/);
});

test("classifyPullRequest: matches when open at the reviewed commit, or merged", () => {
  const open = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40) },
    { ok: true, status: 200, body: { state: "open", head: { sha: "b".repeat(40) } } },
  );
  assert.equal(open.state, "matches");

  const merged = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40) },
    { ok: true, status: 200, body: { state: "closed", merged_at: "2026-07-21T00:00:00.000Z" } },
  );
  assert.equal(merged.state, "matches");
});

test("classifyPullRequest: diverged when open with new commits, or closed without merging", () => {
  const movedHead = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40) },
    { ok: true, status: 200, body: { state: "open", head: { sha: "c".repeat(40) } } },
  );
  assert.equal(movedHead.state, "diverged");

  const closedWithoutMerge = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40) },
    { ok: true, status: 200, body: { state: "closed", merged_at: null } },
  );
  assert.equal(closedWithoutMerge.state, "diverged");
});

test("classifyPullRequest: unobserved when GitHub could not be reached or the PR is gone", () => {
  const unreachable = classifyPullRequest({ number: 42, reviewedCommitSha: "b".repeat(40) }, { ok: false, reason: "rate limited" });
  assert.equal(unreachable.state, "unobserved");

  const notFound = classifyPullRequest({ number: 42, reviewedCommitSha: "b".repeat(40) }, { ok: true, status: 404 });
  assert.equal(notFound.state, "diverged", "a 404 on a recorded PR number is a real divergence, not silence");
});

test("classifyChecks: diverged only on an actual failing conclusion, matches otherwise", () => {
  const passing = classifyChecks({ sha: "b".repeat(40) }, { ok: true, status: 200, body: { check_runs: [{ conclusion: "success" }, { conclusion: "neutral" }] } });
  assert.equal(passing.state, "matches");

  const failing = classifyChecks({ sha: "b".repeat(40) }, { ok: true, status: 200, body: { check_runs: [{ conclusion: "failure" }] } });
  assert.equal(failing.state, "diverged");

  const none = classifyChecks({ sha: "b".repeat(40) }, { ok: true, status: 200, body: { check_runs: [] } });
  assert.equal(none.state, "unobserved", "no reported checks is honestly unobserved, never a false pass");
});

test("classifyTag: matches when present, diverged when gone, unobserved on fetch failure", () => {
  assert.equal(classifyTag({ tag: "v1.2.0" }, { ok: true, status: 200, body: {} }).state, "matches");
  assert.equal(classifyTag({ tag: "v1.2.0" }, { ok: true, status: 404 }).state, "diverged");
  assert.equal(classifyTag({ tag: "v1.2.0" }, { ok: false, reason: "offline" }).state, "unobserved");
});

test("classify() dispatches to the same per-kind logic by kind string", () => {
  const viaDispatch = classify("branch", { branch: "b1", sha: "b".repeat(40) }, { ok: true, status: 200, body: { commit: { sha: "b".repeat(40) } } });
  assert.equal(viaDispatch.state, "matches");
  const unknown = classify("nonsense" as any, {}, { ok: true, status: 200 });
  assert.equal(unknown.state, "unobserved");
});

test("parseGitHubRepo extracts owner/repo from https and ssh remote URLs, and refuses non-GitHub URLs", () => {
  assert.deepEqual(parseGitHubRepo("https://github.com/example-owner/example-repo"), { owner: "example-owner", repo: "example-repo" });
  assert.deepEqual(parseGitHubRepo("https://github.com/example-owner/example-repo.git"), { owner: "example-owner", repo: "example-repo" });
  assert.deepEqual(parseGitHubRepo("git@github.com:example-owner/example-repo.git"), { owner: "example-owner", repo: "example-repo" });
  assert.equal(parseGitHubRepo(null), null);
  assert.equal(parseGitHubRepo("https://gitlab.com/example-owner/example-repo"), null);
});

test("the classify functions embedded in the page are the SAME functions unit-tested here, not a hand-copied duplicate", () => {
  // DH-645 S4 TDD requirement: "unit-test the classifier in Node directly
  // (the same function string that ships in the page)". renderStatusExportHtml
  // builds the shipped <script> from these exact functions' .toString() —
  // assert the shipped text actually contains each function's real source,
  // so a future edit to one without the other fails HERE, not silently.
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  for (const fn of [classify, classifyBranch, classifyPullRequest, classifyChecks, classifyTag, parseGitHubRepo]) {
    const source = fn.toString();
    assert.ok(html.includes(source), `${fn.name} must be embedded in the shipped page verbatim`);
  }
});
