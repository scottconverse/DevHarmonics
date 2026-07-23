import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStatusExportRecords,
  classify,
  classifyBranch,
  classifyChecks,
  classifyPullRequest,
  classifyRepositoryVisible,
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
// C1: even OWNER-TYPED free text (a run goal, a product name) must never be
// embedded — a Workbench-converted objective's goal can itself be
// model-authored, so this module now reads NO free text at all, ever.
const OWNER_GOAL_TEXT_MARKER = "OWNER-TYPED-GOAL-TEXT-MARKER";
const OWNER_PRODUCT_NAME_MARKER = "OWNER-TYPED-PRODUCT-NAME-MARKER";

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
        exportFixtureRepository({ repositoryId: "repo:done", status: "tagged", releaseTag: "v1.2.0", mergeCommitOid: "d".repeat(40) }),
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

  // products/objectives are still accepted (server.ts calls with all three
  // arguments) but, per C1, no longer read for any free-text field.
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
  assert.equal(record.mergeCommitOid, "d".repeat(40), "the merge commit OID is an owner-held identifier DevHarmonics itself recorded when it merged");
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

test("buildStatusExportRecords never includes a runTitle or productTitle field on the record — no free text of any kind (C1)", () => {
  const run = exportFixtureRun({
    delivery: {
      runId: "run-fixture",
      status: "tagged",
      repositories: [exportFixtureRepository({ status: "tagged", releaseTag: "v1.0.0", mergeCommitOid: "c".repeat(40) })],
    },
  });
  const [record] = buildStatusExportRecords([run]);
  assert.ok(record);
  assert.equal(
    Object.prototype.hasOwnProperty.call(record, "runTitle"),
    false,
    "no runTitle (free text, even owner-typed) field on the export record",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(record, "productTitle"),
    false,
    "no productTitle (free text) field on the export record",
  );
  assert.equal(record!.mergeCommitOid, "c".repeat(40));
});

test("generateStatusExportHtml contains no agent-authored or owner-typed free text from a seeded ledger, only allowlisted identifiers (C1)", () => {
  const run = exportFixtureRun({
    goal: OWNER_GOAL_TEXT_MARKER, // even an OWNER-typed goal must never be embedded (a Workbench-converted objective's goal can be model-authored)
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
          mergeCommitOid: "e".repeat(40),
        }),
      ],
    },
  });
  const product: ProductRecord = {
    id: "product-1",
    name: OWNER_PRODUCT_NAME_MARKER,
    organizationUrl: "https://github.com/example-owner",
    description: "d",
    repositories: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };

  const html = generateStatusExportHtml([run], [product], [], new Date("2026-07-22T12:00:00.000Z"));

  assert.doesNotMatch(html, new RegExp(AGENT_FINAL_REVIEW_MARKER), "the run's final review (agent-written verdict) must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_PLAN_SUMMARY_MARKER), "the plan summary (agent-written) must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_TASK_DESCRIPTION_MARKER), "a task description (agent-written) must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_DELIVERY_ERROR_MARKER), "a delivery error message must never be embedded");
  assert.doesNotMatch(html, new RegExp(AGENT_PLAN_RATIONALE_MARKER), "a plan rationale must never be embedded (not present in fixture, asserted for completeness)");
  assert.doesNotMatch(html, new RegExp(OWNER_GOAL_TEXT_MARKER), "no free text field is embedded — not even the owner-typed run goal (C1)");
  assert.doesNotMatch(html, new RegExp(OWNER_PRODUCT_NAME_MARKER), "no free text field is embedded — not even the product name (C1)");

  // The allowlist DOES appear: repositoryId (+ run id short form and dates) — no goal, no product name.
  assert.match(html, /devharmonics\/fixture/, "the branch name is an identifier and must appear");
  assert.match(html, /b{12}/, "the reviewed commit sha (short form) is an identifier and must appear");
  assert.match(html, /example-owner\/example-repo/, "the repository is an identifier and must appear");
  assert.match(html, /repo:fixture/, "the card must be headed by repositoryId");
  assert.match(html, /run-fixture/, "the run id (short form) is an identifier and must appear");
  assert.match(html, /2026-07-20T10:05:00\.000Z/, "the delivery-recorded date is an identifier and must appear");
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

test("renderStatusExportHtml's purpose line credits the delivery ledger for identifiers and live GitHub only for status (minor-provenance-copy)", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(html, /delivery ledger/i, "purpose line must say identifiers came from the delivery ledger");
  assert.match(
    html,
    /only the status classifications?[^.]*fetched live/i,
    "purpose line must scope the live-fetch claim to status classifications only, not identifiers",
  );
});

test("renderStatusExportHtml documents the unauthenticated GitHub rate limit", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(html, /60\b.*(requests|per hour)|rate limit/i, "the page must tell the owner about the unauthenticated GitHub rate limit");
});

test("the shipped page checks repository visibility before treating any 404 as genuine absence (C2)", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(
    html,
    /classifyRepositoryVisible/,
    "checkRecord must gate every per-artifact check on a repository-visibility check first, both defined and called",
  );
});

test("the shipped page treats only 2xx and 404 responses as observable, and every other status as unobserved (M-export-http)", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(
    html,
    /res\.status\s*>=\s*200\s*&&\s*res\.status\s*<\s*300/,
    "fetchGitHub must gate 'ok' on a real 2xx range, not treat every received status as observable",
  );
  assert.match(
    html,
    /res\.status\s*===\s*404/,
    "404 is the one non-2xx status the page still treats as an observation (gated by repository-visibility per C2)",
  );
});

test("the shipped page gives every GitHub fetch an abort timeout and processes records through a bounded queue (M-export-unbounded)", () => {
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  assert.match(html, /AbortController/, "every fetch must carry an abort deadline so a stalled request cannot hang the page forever");
  assert.match(html, /runBoundedQueue/, "records must be processed through a bounded concurrency queue, not launched all at once");
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

test("classifyPullRequest: matches when open at the reviewed commit", () => {
  const open = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40) },
    { ok: true, status: 200, body: { state: "open", head: { sha: "b".repeat(40) } } },
  );
  assert.equal(open.state, "matches");
});

test("classifyPullRequest: a merged PR matches only when its merge commit can be compared against the recorded merge commit OID (M-merged-head)", () => {
  const noIdentityRecorded = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40) },
    { ok: true, status: 200, body: { state: "closed", merged_at: "2026-07-21T00:00:00.000Z", merge_commit_sha: "d".repeat(40) } },
  );
  assert.equal(
    noIdentityRecorded.state,
    "unobserved",
    "the ledger recorded no merge commit OID to compare against — missing identity is unobserved, never a silent match",
  );

  const noObservedSha = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40), mergeCommitOid: "d".repeat(40) },
    { ok: true, status: 200, body: { state: "closed", merged_at: "2026-07-21T00:00:00.000Z" } },
  );
  assert.equal(noObservedSha.state, "unobserved", "GitHub reported no merge commit to compare — unobserved, never a silent match");

  const mismatched = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40), mergeCommitOid: "d".repeat(40) },
    { ok: true, status: 200, body: { state: "closed", merged_at: "2026-07-21T00:00:00.000Z", merge_commit_sha: "e".repeat(40) } },
  );
  assert.equal(mismatched.state, "diverged", "the observed merge commit does not match the recorded merge commit OID");

  const matched = classifyPullRequest(
    { number: 42, reviewedCommitSha: "b".repeat(40), mergeCommitOid: "d".repeat(40) },
    { ok: true, status: 200, body: { state: "closed", merged_at: "2026-07-21T00:00:00.000Z", merge_commit_sha: "d".repeat(40) } },
  );
  assert.equal(matched.state, "matches");
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
  assert.equal(notFound.state, "diverged", "a 404 on a recorded PR number is a real divergence, not silence (repo visibility already confirmed by the caller)");
});

test("classifyChecks: diverged only on an actual failing conclusion among completed checks, matches otherwise", () => {
  const passing = classifyChecks(
    { sha: "b".repeat(40) },
    { ok: true, status: 200, body: { total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "neutral" }] } },
  );
  assert.equal(passing.state, "matches");

  const failing = classifyChecks(
    { sha: "b".repeat(40) },
    { ok: true, status: 200, body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] } },
  );
  assert.equal(failing.state, "diverged");

  const none = classifyChecks({ sha: "b".repeat(40) }, { ok: true, status: 200, body: { total_count: 0, check_runs: [] } });
  assert.equal(none.state, "unobserved", "no reported checks is honestly unobserved, never a false pass");
});

test("classifyChecks: pending/in-progress or null-conclusion checks are unobserved, never matches (M-export-checks)", () => {
  const pending = classifyChecks(
    { sha: "b".repeat(40) },
    { ok: true, status: 200, body: { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] } },
  );
  assert.equal(pending.state, "unobserved");
  assert.match(pending.message, /still running/i);

  const nullConclusion = classifyChecks(
    { sha: "b".repeat(40) },
    { ok: true, status: 200, body: { total_count: 1, check_runs: [{ status: "completed", conclusion: null }] } },
  );
  assert.equal(nullConclusion.state, "unobserved");
  assert.match(nullConclusion.message, /still running/i);

  const mixed = classifyChecks(
    { sha: "b".repeat(40) },
    { ok: true, status: 200, body: { total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }, { status: "queued", conclusion: null }] } },
  );
  assert.equal(mixed.state, "unobserved", "even one pending check among otherwise-passing checks must not be reported as a match");
});

test("classifyChecks: an incomplete (paginated) result set is unobserved, never matches or diverges (M-export-checks)", () => {
  const incomplete = classifyChecks(
    { sha: "b".repeat(40) },
    { ok: true, status: 200, body: { total_count: 5, check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "success" }] } },
  );
  assert.equal(incomplete.state, "unobserved");
  assert.match(incomplete.message, /incomplete|only.*could be read/i);
});

test("classifyTag: matches when present, diverged when gone, unobserved on fetch failure", () => {
  assert.equal(classifyTag({ tag: "v1.2.0" }, { ok: true, status: 200, body: {} }).state, "matches");
  assert.equal(classifyTag({ tag: "v1.2.0" }, { ok: true, status: 404 }).state, "diverged");
  assert.equal(classifyTag({ tag: "v1.2.0" }, { ok: false, reason: "offline" }).state, "unobserved");
});

test("classifyRepositoryVisible: matches when the repository responds 2xx, unobserved on a 404 or a failed fetch (C2)", () => {
  assert.equal(classifyRepositoryVisible({ ok: true, status: 200, body: {} }).state, "matches");

  const notFound = classifyRepositoryVisible({ ok: true, status: 404, body: null });
  assert.equal(notFound.state, "unobserved");
  assert.match(notFound.message, /not found, or not visible without signing in/i);

  const failed = classifyRepositoryVisible({ ok: false, reason: "network error" });
  assert.equal(failed.state, "unobserved");
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

test("parseGitHubRepo allows dots in the repository name and strips only a trailing .git suffix (minor-dots)", () => {
  assert.deepEqual(parseGitHubRepo("https://github.com/example-owner/example.repo"), { owner: "example-owner", repo: "example.repo" });
  assert.deepEqual(parseGitHubRepo("https://github.com/example-owner/example.repo.git"), { owner: "example-owner", repo: "example.repo" });
  assert.deepEqual(parseGitHubRepo("git@github.com:example-owner/example.repo.git"), { owner: "example-owner", repo: "example.repo" });
});

test("the classify functions embedded in the page are the SAME functions unit-tested here, not a hand-copied duplicate", () => {
  // DH-645 S4 TDD requirement: "unit-test the classifier in Node directly
  // (the same function string that ships in the page)". renderStatusExportHtml
  // builds the shipped <script> from these exact functions' .toString() —
  // assert the shipped text actually contains each function's real source,
  // so a future edit to one without the other fails HERE, not silently.
  const html = renderStatusExportHtml([], new Date("2026-07-22T12:00:00.000Z"));
  for (const fn of [classify, classifyBranch, classifyPullRequest, classifyChecks, classifyTag, classifyRepositoryVisible, parseGitHubRepo]) {
    const source = fn.toString();
    assert.ok(html.includes(source), `${fn.name} must be embedded in the shipped page verbatim`);
  }
});
