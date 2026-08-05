import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReview, reviewerPrompt, parseReviewerResponse, claimsArtifactDivergence } from "../scripts/review.mjs";

/**
 * Real git repos in temp dirs for the runReview tests — the thing under test
 * computes real `git diff`/`diff --stat`/`diff --name-only` and creates a
 * real detached worktree, so faking git would test nothing (precedent:
 * test/integrate.test.mjs, test/local-patch.test.mjs). The model reviewer
 * itself is always an injected fake via `deps.runWorker` — no real AI CLI
 * runs in this suite.
 */

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A real two-commit fixture repo: `main` has the init commit; `feature`
 * branches from main and adds one more commit that changes file.txt — a
 * genuine, nonempty diff for runReview to compute and hand to the reviewer. */
function initReviewRepo() {
  const dir = tempDir("dh-rev-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(dir, "file.txt"), "line1\nline2\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["branch", "feature", "main"]);
  const wt = tempDir("dh-rev-authorwt-");
  git(dir, ["worktree", "add", "-q", wt, "feature"]);
  writeFileSync(path.join(wt, "file.txt"), "line1\nline2\nCHANGED\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "advance feature"]);
  git(dir, ["worktree", "remove", "--force", wt]);
  return dir;
}

function withTemps(fn) {
  const repo = initReviewRepo();
  const evidenceRoot = tempDir("dh-rev-evidence-");
  return (async () => {
    try {
      await fn({ repo, evidenceRoot });
    } finally {
      for (const d of [repo, evidenceRoot]) rmSync(d, { recursive: true, force: true });
    }
  })();
}

function readReceipt(reviewReceiptPath) {
  return JSON.parse(readFileSync(reviewReceiptPath, "utf8"));
}

const BASE_REVIEWER = Object.freeze({ lane: "subprocess", provider: "claude", model: "fake-model" });

// --- reviewerPrompt -------------------------------------------------------

test("reviewerPrompt: embeds goal/diffStat/checkReceiptsSummary and demands the READY/NOT READY + fenced-json contract", () => {
  const prompt = reviewerPrompt({
    goal: "Ship the widget",
    diffStat: " file.txt | 1 +\n",
    checkReceiptsSummary: "unit-tests: pass",
  });
  assert.match(prompt, /Ship the widget/);
  assert.match(prompt, /file\.txt \| 1 \+/);
  assert.match(prompt, /unit-tests: pass/);
  assert.match(prompt, /READY or NOT READY/);
  assert.match(prompt, /```json/);
  assert.match(prompt, /"findings"/);
  assert.match(prompt, /Implementor task reports are deliberately withheld/);
});

// --- parseReviewerResponse -------------------------------------------------

test("parseReviewerResponse: READY happy path -> empty findings, verdict READY", () => {
  const text = 'READY\n\nAll good, no issues.\n\n```json\n{"findings":[]}\n```';
  const result = parseReviewerResponse(text, { provider: "claude", modelId: "claude-x" });
  assert.equal(result.verdict, "READY");
  assert.deepEqual(result.findings, []);
  assert.equal(result.provider, "claude");
  assert.equal(result.modelId, "claude-x");
  assert.equal(result.summary, "All good, no issues.");
  assert.equal(result.rawText, text);
});

test("parseReviewerResponse: NOT_READY with structured findings -> normalized and returned", () => {
  const text = 'NOT READY\n\nFound a bug.\n\n```json\n{"findings":[{"id":"f1","severity":"medium","location":"a.js:3","rationale":"bug","suggestedCorrection":"fix it","disposition":"open"}]}\n```';
  const result = parseReviewerResponse(text, { provider: "codex" });
  assert.equal(result.verdict, "NOT_READY");
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    id: "f1",
    severity: "medium",
    location: "a.js:3",
    rationale: "bug",
    suggestedCorrection: "fix it",
    disposition: "open",
  });
});

test("parseReviewerResponse: NOT_READY with no parseable JSON -> synthesizes one finding from the body", () => {
  const text = "NOT READY\n\nThe implementation lacks error handling for null inputs throughout the module.";
  const result = parseReviewerResponse(text, { provider: "claude" });
  assert.equal(result.verdict, "NOT_READY");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, "finding-1");
  assert.equal(result.findings[0].severity, "high");
  assert.equal(result.findings[0].disposition, "open");
  assert.match(result.findings[0].rationale, /lacks error handling for null inputs/);
});

test("parseReviewerResponse: garbage severity/disposition normalized, missing suggestedCorrection gets stock text", () => {
  const text = 'NOT READY\n\nBad severity given.\n\n```json\n{"findings":[{"rationale":"weird","severity":"apocalyptic"}]}\n```';
  const result = parseReviewerResponse(text, { provider: "claude" });
  assert.equal(result.verdict, "NOT_READY");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, "high", "invalid severity must normalize to high");
  assert.equal(result.findings[0].disposition, "open", "missing disposition must default to open");
  assert.equal(result.findings[0].id, "finding-1");
  assert.equal(result.findings[0].location, null);
  assert.equal(result.findings[0].suggestedCorrection, "Investigate and correct the reported condition before re-review.");
});

test("parseReviewerResponse: non-JSON tail after the fenced block is tolerated", () => {
  const text = 'READY\n\nLooks fine.\n\n```json\n{"findings":[]}\n```\n\nP.S. this trailing prose is not valid json {unterminated';
  const result = parseReviewerResponse(text, { provider: "claude" });
  assert.equal(result.verdict, "READY");
  assert.deepEqual(result.findings, []);
});

// --- claimsArtifactDivergence ----------------------------------------------

test("claimsArtifactDivergence: claimed exactly matches diff -> no findings", () => {
  const findings = claimsArtifactDivergence({ claimedPaths: ["a.js", "b.js"], diffPaths: ["a.js", "b.js"] });
  assert.deepEqual(findings, []);
});

test("claimsArtifactDivergence: claimed but not made -> a high-severity finding", () => {
  const findings = claimsArtifactDivergence({ claimedPaths: ["ghost.py"], diffPaths: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].location, "ghost.py");
  assert.equal(findings[0].disposition, "open");
  assert.match(findings[0].id, /^divergence-claimed-/);
});

test("claimsArtifactDivergence: made but not claimed -> a medium-severity finding", () => {
  const findings = claimsArtifactDivergence({ claimedPaths: [], diffPaths: ["new.js"] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[0].location, "new.js");
  assert.equal(findings[0].disposition, "open");
  assert.match(findings[0].id, /^divergence-unexplained-/);
});

test("claimsArtifactDivergence: path normalization (backslashes, leading ./) treats equivalent paths as matching", () => {
  const findings = claimsArtifactDivergence({
    claimedPaths: ["src\\a.js", "./b.js"],
    diffPaths: ["src/a.js", "b.js"],
  });
  assert.deepEqual(findings, []);
});

// --- runReview --------------------------------------------------------------

test("runReview: fake runWorker returns READY + empty findings -> READY, receipt written, worktree cleaned up", () => withTemps(async ({ repo, evidenceRoot }) => {
  let capturedCwd = null;
  const runWorkerFake = async ({ cwd, prompt }) => {
    capturedCwd = cwd;
    assert.ok(existsSync(cwd), "reviewer must receive a real checked-out worktree");
    assert.match(prompt, /Diff summary/);
    return {
      receipt: { status: "completed", resolvedModel: "fake-model-resolved" },
      parsed: { finalText: 'READY\n\nNo issues found.\n\n```json\n{"findings":[]}\n```' },
    };
  };

  const result = await runReview({
    repository: repo,
    integrationBranch: "feature",
    baseRef: "main",
    goal: "Make the change",
    reviewer: BASE_REVIEWER,
    evidenceRoot,
    deps: { runWorker: runWorkerFake },
  });

  assert.equal(result.verdict, "READY");
  assert.deepEqual(result.findings, []);
  assert.equal(result.divergence, null, "no claims manifest supplied -> divergence is 'not checked' (null), not an empty-array 0");
  assert.ok(existsSync(result.reviewReceiptPath));

  const bundle = readReceipt(result.reviewReceiptPath);
  assert.equal(bundle.verdict, "READY");
  assert.equal(bundle.modelVerdict, "READY");
  assert.match(bundle.diffStat, /file\.txt/);
  assert.equal(typeof bundle.promptSha256, "string");
  assert.equal(bundle.promptSha256.length, 64);

  // Worktree cleaned up: captured cwd no longer exists, and the repo has no
  // leftover worktrees registered against it.
  assert.equal(existsSync(capturedCwd), false);
  const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
  assert.equal(worktrees.length, 1);
}));

// GAUNTLET M-1 (Agent B): when NO claims manifest is supplied (claimedPaths:
// null, exactly what run-command.mjs passes), the gate was not run and must
// report as null ("not checked"), never [] — which had made the pipeline print
// a reassuring "0 divergence" (a false green). This pins the honest signal.
test("runReview: claimedPaths null -> divergence is null (not checked), never an empty-array '0'", () => withTemps(async ({ repo, evidenceRoot }) => {
  const runWorkerFake = async () => ({
    receipt: { status: "completed", resolvedModel: "fake-model-resolved" },
    parsed: { finalText: 'READY\n\nNo issues found.\n\n```json\n{"findings":[]}\n```' },
  });
  const result = await runReview({
    repository: repo,
    integrationBranch: "feature",
    baseRef: "main",
    goal: "Make the change",
    reviewer: BASE_REVIEWER,
    claimedPaths: null,
    evidenceRoot,
    deps: { runWorker: runWorkerFake },
  });
  assert.equal(result.divergence, null, "divergence must be null when no claims manifest was supplied");
  assert.equal(result.verdict, "READY", "a null (unchecked) divergence must not force NOT_READY");
  const bundle = readReceipt(result.reviewReceiptPath);
  assert.equal(bundle.divergence, null, "the review receipt must also record divergence as null");
}));

test("runReview: claimedPaths names an unmade change -> NOT_READY on divergence even when the model reviewer says READY", () => withTemps(async ({ repo, evidenceRoot }) => {
  const runWorkerFake = async () => ({
    receipt: { status: "completed" },
    parsed: { finalText: 'READY\n\nLooks fine.\n\n```json\n{"findings":[]}\n```' },
  });

  const result = await runReview({
    repository: repo,
    integrationBranch: "feature",
    baseRef: "main",
    goal: "Make the change",
    reviewer: BASE_REVIEWER,
    claimedPaths: ["ghost.py"],
    evidenceRoot,
    deps: { runWorker: runWorkerFake },
  });

  assert.equal(result.verdict, "NOT_READY", "the mechanical divergence gate must outrank a READY model verdict");
  assert.deepEqual(result.findings, [], "the model reviewer itself reported no findings");
  const claimedFinding = result.divergence.find((f) => f.location === "ghost.py");
  assert.ok(claimedFinding, "expected a divergence finding for the claimed-but-absent path");
  assert.equal(claimedFinding.severity, "high");
  assert.equal(claimedFinding.disposition, "open");

  const bundle = readReceipt(result.reviewReceiptPath);
  assert.equal(bundle.verdict, "NOT_READY");
  assert.equal(bundle.modelVerdict, "READY");
  assert.ok(bundle.divergence.some((f) => f.location === "ghost.py"));
}));

test("runReview: fake reviewer returns NOT_READY with a finding -> propagated, receipt has it", () => withTemps(async ({ repo, evidenceRoot }) => {
  const runWorkerFake = async () => ({
    receipt: { status: "completed" },
    parsed: {
      finalText: 'NOT READY\n\nMissing test coverage for the new line.\n\n```json\n{"findings":[{"id":"cov-1","severity":"high","location":"file.txt:3","rationale":"No test covers the new line.","suggestedCorrection":"Add a regression test.","disposition":"open"}]}\n```',
    },
  });

  const result = await runReview({
    repository: repo,
    integrationBranch: "feature",
    baseRef: "main",
    goal: "Make the change",
    reviewer: BASE_REVIEWER,
    evidenceRoot,
    deps: { runWorker: runWorkerFake },
  });

  assert.equal(result.verdict, "NOT_READY");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, "cov-1");
  assert.equal(result.findings[0].rationale, "No test covers the new line.");
  assert.equal(result.divergence, null, "no claims manifest supplied -> divergence is 'not checked' (null), not an empty-array 0");

  const bundle = readReceipt(result.reviewReceiptPath);
  assert.equal(bundle.verdict, "NOT_READY");
  assert.equal(bundle.findings.length, 1);
  assert.equal(bundle.findings[0].id, "cov-1");
}));

test("runReview: reviewer worker fails -> NOT_READY with a synthesized reviewer-unavailable finding, never a pass", () => withTemps(async ({ repo, evidenceRoot }) => {
  const runWorkerFake = async () => ({
    receipt: { status: "failed" },
    parsed: { finalText: null },
  });

  const result = await runReview({
    repository: repo,
    integrationBranch: "feature",
    baseRef: "main",
    goal: "Make the change",
    reviewer: BASE_REVIEWER,
    evidenceRoot,
    deps: { runWorker: runWorkerFake },
  });

  assert.equal(result.verdict, "NOT_READY");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, "reviewer-unavailable");
  assert.equal(result.findings[0].severity, "critical");
  assert.equal(result.findings[0].disposition, "open");

  const bundle = readReceipt(result.reviewReceiptPath);
  assert.equal(bundle.verdict, "NOT_READY");
  assert.equal(bundle.modelVerdict, "NOT_READY");
  assert.equal(bundle.findings[0].id, "reviewer-unavailable");
}));
