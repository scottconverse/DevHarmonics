import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planIntegrationSet, integrateSet, scopeFinding } from "../scripts/integration-set.mjs";

/**
 * Real git repos in temp dirs — same rationale as test/integrate.test.mjs:
 * the thing under test IS git plumbing (base-commit pinning across several
 * real repositories, concurrent merges into distinct repos), so faking it
 * would test nothing. The fake-tampercheck pattern is copied from that file
 * (test files in this repo duplicate small fixtures rather than share them —
 * see test/local-patch.test.mjs vs test/integrate.test.mjs for the same
 * precedent) rather than imported.
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

function initRepo() {
  const dir = tempDir("dh-set-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(dir, "file.txt"), "line1\nline2\nline3\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function branchFrom(dir, branchName, base, fileContent) {
  git(dir, ["branch", branchName, base]);
  const wt = tempDir("dh-set-authorwt-");
  git(dir, ["worktree", "add", "-q", wt, branchName]);
  writeFileSync(path.join(wt, "file.txt"), fileContent);
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `advance ${branchName}`]);
  git(dir, ["worktree", "remove", "--force", wt]);
  return git(dir, ["rev-parse", branchName]).trim();
}

/** Same as branchFrom, but also drops a TRIGGER_FINDINGS.txt marker file so
 * the fakeConditional tampercheck fixture (below) reports findings for THIS
 * repo's worker branch specifically, while a sibling repo's clean branch
 * (no marker file) still passes — all under one shared env/PATH, matching
 * how integrateSet passes exactly one `env` across every member. */
function branchTrippingTampercheck(dir, branchName, base, fileContent) {
  git(dir, ["branch", branchName, base]);
  const wt = tempDir("dh-set-authorwt-");
  git(dir, ["worktree", "add", "-q", wt, branchName]);
  writeFileSync(path.join(wt, "file.txt"), fileContent);
  writeFileSync(path.join(wt, "TRIGGER_FINDINGS.txt"), "trip the fake tampercheck\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `advance ${branchName}`]);
  git(dir, ["worktree", "remove", "--force", wt]);
  return git(dir, ["rev-parse", branchName]).trim();
}

/** A branch pointing at the exact same tree as base (no commit at all) — a
 * genuinely empty diff against merge-base. */
function branchNoChange(dir, branchName, base) {
  git(dir, ["branch", branchName, base]);
}

// --- fake tampercheck fixtures (ported from test/integrate.test.mjs) -----

// A fake standing in for a real CLI must answer --version like one: the
// integration gate's identity check (falsification finding F-1) requires a
// bare semantic version before it will trust any verdict. A fixture that
// cannot answer --version is indistinguishable from the PATH-substituted
// stub that check exists to reject — so answering it makes these fixtures
// MORE realistic, not the assertions weaker.
function writeFakeTampercheck(dir, body) {
  if (process.platform === "win32") {
    const file = path.join(dir, "tampercheck.cmd");
    writeFileSync(file, `@echo off\r\nif /I "%~1"=="--version" (echo 0.1.1& exit /b 0)\r\n${body.win}\r\n`);
    return file;
  }
  const file = path.join(dir, "tampercheck");
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.1; exit 0; fi\n${body.posix}\n`);
  chmodSync(file, 0o755);
  return file;
}

function fakeClean(dir) {
  return writeFakeTampercheck(dir, {
    win: "echo TAMPERCHECK CLEAN\r\nexit /b 0",
    posix: "echo TAMPERCHECK CLEAN\nexit 0",
  });
}

/** Unlike integrate.test.mjs's fakeFindings (always exit 1), this fixture's
 * verdict depends on the CWD it runs in — integrate.mjs always runs
 * tampercheck inside that repo's own workerHead worktree — rather than on
 * which env/PATH is active. A whole integrateSet call shares ONE env across
 * every member, so per-member pass/fail has to be driven by repo content
 * (the TRIGGER_FINDINGS.txt marker), not by swapping fixtures per repo. */
function fakeConditional(dir) {
  return writeFakeTampercheck(dir, {
    win: [
      "if exist TRIGGER_FINDINGS.txt goto FINDINGS",
      "echo TAMPERCHECK CLEAN",
      "exit /b 0",
      ":FINDINGS",
      "echo TAMPERCHECK FINDINGS: seeded gate weakening detected",
      "exit /b 1",
    ].join("\r\n"),
    posix: [
      "if [ -f TRIGGER_FINDINGS.txt ]; then",
      '  echo "TAMPERCHECK FINDINGS: seeded gate weakening detected"',
      "  exit 1",
      "else",
      '  echo "TAMPERCHECK CLEAN"',
      "  exit 0",
      "fi",
    ].join("\n"),
  });
}

function pathOnlyEnv(dir) {
  // Fixture directory first on PATH so resolvePathCommand always picks our
  // fake over any real tampercheck on the machine's ambient PATH (see the
  // identical helper in test/integrate.test.mjs for the full rationale).
  const separator = process.platform === "win32" ? ";" : ":";
  const existing = process.env.PATH ?? process.env.Path ?? "";
  const merged = `${dir}${separator}${existing}`;
  return { ...process.env, PATH: merged, Path: merged, PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" };
}

function withTemps(n, fn) {
  const repos = Array.from({ length: n }, () => initRepo());
  const evidenceRoot = tempDir("dh-set-evidence-");
  const fixtureDir = tempDir("dh-set-fixtures-");
  return (async () => {
    try {
      await fn({ repos, evidenceRoot, fixtureDir });
    } finally {
      for (const d of [...repos, evidenceRoot, fixtureDir]) rmSync(d, { recursive: true, force: true });
    }
  })();
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// --- planIntegrationSet ----------------------------------------------------

test("planIntegrationSet: happy 2-repo plan pins each baseCommit to real HEAD and defaults integrationBranch", () => withTemps(2, async ({ repos }) => {
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n");
  branchFrom(repoB, "worker-b", "main", "line1\nline2\nCHANGED-B\n");
  const headA = git(repoA, ["rev-parse", "HEAD"]).trim();
  const headB = git(repoB, ["rev-parse", "HEAD"]).trim();

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a" },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b" },
    ],
  });

  assert.ok(plan.setId && plan.setId.startsWith("set-"));
  assert.equal(plan.members.length, 2);
  const [mA, mB] = plan.members;
  assert.equal(mA.repositoryId, "repoA");
  assert.equal(mA.baseCommit, headA);
  assert.equal(mB.repositoryId, "repoB");
  assert.equal(mB.baseCommit, headB);
  // Both members default to the SAME branch NAME — harmless, since they are
  // separate repositories with independent branch namespaces.
  assert.equal(mA.integrationBranch, `devharmonics/integration/${plan.setId}`);
  assert.equal(mB.integrationBranch, `devharmonics/integration/${plan.setId}`);
}));

test("planIntegrationSet: duplicate repositoryId throws", () => withTemps(2, async ({ repos }) => {
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n");
  branchFrom(repoB, "worker-b", "main", "line1\nline2\nCHANGED-B\n");

  assert.throws(
    () => planIntegrationSet({
      members: [
        { repositoryId: "dup", repository: repoA, workerBranch: "worker-a" },
        { repositoryId: "dup", repository: repoB, workerBranch: "worker-b" },
      ],
    }),
    /duplicate repositoryId "dup"/,
  );
}));

test("planIntegrationSet: missing workerBranch throws", () => withTemps(1, async ({ repos }) => {
  const [repo] = repos;

  assert.throws(
    () => planIntegrationSet({
      members: [{ repositoryId: "repoA", repository: repo, workerBranch: "does-not-exist" }],
    }),
    /workerBranch "does-not-exist" does not resolve to a commit/,
  );
}));

test("planIntegrationSet: non-git repository path throws", () => {
  const notARepo = tempDir("dh-set-notgit-");
  try {
    assert.throws(
      () => planIntegrationSet({
        members: [{ repositoryId: "repoA", repository: notARepo, workerBranch: "main" }],
      }),
      /repository is not a git root/,
    );
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("planIntegrationSet: two repositoryIds resolving to the same repository root throws", () => withTemps(1, async ({ repos }) => {
  const [repo] = repos;
  branchFrom(repo, "worker-a", "main", "line1\nline2\nCHANGED\n");

  assert.throws(
    () => planIntegrationSet({
      members: [
        { repositoryId: "repoA", repository: repo, workerBranch: "worker-a" },
        { repositoryId: "repoA-again", repository: repo, workerBranch: "worker-a" },
      ],
    }),
    /resolve to the same repository root/,
  );
}));

test("planIntegrationSet: empty members array throws", () => {
  assert.throws(() => planIntegrationSet({ members: [] }), /members must be a non-empty array/);
});

// --- integrateSet -----------------------------------------------------------

test("integrateSet: two-repo set, both clean -> setReady true, both real merge commits, set.json complete", () => withTemps(2, async ({ repos, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n");
  branchFrom(repoB, "worker-b", "main", "line1\nline2\nCHANGED-B\n");

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a" },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b" },
    ],
  });

  const result = await integrateSet({ set: plan, evidenceRoot, env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000 });

  assert.equal(result.setReady, true, JSON.stringify(result));
  assert.deepEqual(result.blockedBy, []);
  assert.equal(result.members.length, 2);
  for (const m of result.members) {
    assert.equal(m.integrated, true);
    assert.equal(m.reason, null);
    assert.ok(m.integrationHead);
    assert.ok(existsSync(m.evidencePath));
  }

  assert.ok(existsSync(result.evidencePath));
  const bundle = readJson(result.evidencePath);
  assert.equal(bundle.setId, plan.setId);
  assert.equal(bundle.setReady, true);
  assert.equal(bundle.members.length, 2);

  // Both integration branches carry a real merge commit reachable in their
  // OWN repository.
  const logA = git(repoA, ["log", "--format=%H", "devharmonics/integration/" + plan.setId]).trim().split("\n");
  const logB = git(repoB, ["log", "--format=%H", "devharmonics/integration/" + plan.setId]).trim().split("\n");
  assert.ok(logA.includes(result.members[0].integrationHead));
  assert.ok(logB.includes(result.members[1].integrationHead));
}));

test("integrateSet: repo B trips tampercheck -> ATOMIC: setReady false, blockedBy [repoB], and repoA is gated but NOT advanced (nothing half-applied)", () => withTemps(2, async ({ repos, evidenceRoot, fixtureDir }) => {
  fakeConditional(fixtureDir);
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n"); // clean: no trigger file
  branchTrippingTampercheck(repoB, "worker-b", "main", "line1\nline2\nCHANGED-B\n"); // trips findings

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a" },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b" },
    ],
  });

  const result = await integrateSet({ set: plan, evidenceRoot, env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000 });

  assert.equal(result.setReady, false, JSON.stringify(result));
  assert.deepEqual(result.blockedBy, ["repoB"]);

  const [mA, mB] = result.members;
  // TWO-PHASE ATOMICITY (audit 2026-08-05): repoA passed every gate, but because
  // the SET was blocked its integration ref was deliberately never advanced. The
  // old behavior advanced it and relabelled it "advanced-but-set-blocked", leaving
  // a half-applied cross-repo change on disk that a consumer could pick up.
  assert.equal(mA.repositoryId, "repoA");
  assert.equal(mA.prepared, true, "repoA's own gates passed");
  assert.equal(mA.integrated, false, "no member is integrated unless the whole set is");
  assert.equal(mA.reason, "set-blocked-not-advanced");
  assert.equal(mA.integrationHead, null);

  assert.equal(mB.repositoryId, "repoB");
  assert.equal(mB.prepared, false);
  assert.equal(mB.integrated, false);
  assert.equal(mB.reason, "tampercheck-findings");
  assert.equal(mB.integrationHead, null);

  // repoA's integration branch exists (prepare creates it at the pinned base) but
  // must still point AT THAT BASE — no merge was delivered anywhere.
  const headA = git(repoA, ["rev-parse", "devharmonics/integration/" + plan.setId]).trim();
  assert.equal(headA, plan.members[0].baseCommit, "repoA must NOT be advanced when the set is blocked");
  // The parked candidate was abandoned, not left lying around.
  const candidateA = spawnSync("git", ["-C", repoA, "rev-parse", "--verify", "--quiet", `refs/devharmonics/candidate/${plan.setId}-repoA`]);
  assert.notEqual(candidateA.status, 0, "an abandoned set must not leave candidate refs behind");
  // repoB's integration branch was never created (merge never attempted).
  const existsB = spawnSync("git", ["-C", repoB, "rev-parse", "--verify", "--quiet", `refs/heads/devharmonics/integration/${plan.setId}`]);
  assert.notEqual(existsB.status, 0);

  const bundle = readJson(result.evidencePath);
  assert.equal(bundle.setReady, false);
  assert.deepEqual(bundle.blockedBy, ["repoB"]);
  assert.equal(bundle.members.length, 2);
  assert.equal(bundle.members[0].reason, "set-blocked-not-advanced");
  assert.equal(bundle.members[1].reason, "tampercheck-findings");
}));

// A2-6 / A4-6: `set` had no validator at all, so a cross-repo change got LESS
// scrutiny than a single-repo one. The validator runs against each member's MERGED
// candidate, and a failure blocks the whole set without advancing anything.
test("integrateSet: --check runs per member against the merged candidate; a failure blocks the set and advances nothing", () => withTemps(2, async ({ repos, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n");
  branchFrom(repoB, "worker-b", "main", "line1\nline2\nCHANGED-B\n");

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a" },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b" },
    ],
  });

  // A validator that always fails, so both members are refused at the check.
  const failing = await integrateSet({
    set: plan,
    evidenceRoot,
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
    check: { command: "node", args: ["-e", "process.exit(1)"] },
    checkTimeoutMs: 30_000,
  });

  assert.equal(failing.setReady, false, JSON.stringify(failing));
  for (const m of failing.members) {
    assert.equal(m.integrated, false);
    assert.equal(m.prepared, false, "a member whose validator failed did not prepare");
    assert.equal(m.reason, "validator-failed");
    assert.equal(m.gates.validator.status, "refused");
    assert.ok(m.gates.validator.candidateHead, "the validator ran against a real merged candidate");
    // Nothing advanced: the integration branch is still at the pinned base.
    const head = git(m.repositoryId === "repoA" ? repoA : repoB, ["rev-parse", m.integrationBranch]).trim();
    assert.equal(head, m.baseCommit, "a failed validator must leave the integration ref at its base");
  }

  // And a passing validator still integrates the whole set.
  const plan2 = planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a", integrationBranch: "devharmonics/integration/pass-a" },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b", integrationBranch: "devharmonics/integration/pass-b" },
    ],
  });
  const passing = await integrateSet({
    set: plan2,
    evidenceRoot: path.join(evidenceRoot, "pass"),
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
    check: { command: "node", args: ["-e", "process.exit(0)"] },
    checkTimeoutMs: 30_000,
  });
  assert.equal(passing.setReady, true, JSON.stringify(passing));
  for (const m of passing.members) {
    assert.equal(m.gates.validator.status, "pass");
    assert.ok(m.integrationHead);
  }
}));

// A2-6 / A4-6, review half: a NOT_READY review on ANY member blocks the whole set,
// and because review happens on the gated CANDIDATE during the prepare phase,
// nothing has advanced anywhere when it does.
test("integrateSet: --reviewer reviews each candidate; one NOT_READY blocks the set and advances nothing", () => withTemps(2, async ({ repos, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n");
  branchFrom(repoB, "worker-b", "main", "line1\nline2\nCHANGED-B\n");

  const mkPlan = (suffix) => planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a", integrationBranch: `devharmonics/integration/rev-a-${suffix}` },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b", integrationBranch: `devharmonics/integration/rev-b-${suffix}` },
    ],
  });
  const reviewer = { lane: "subprocess", provider: "claude", model: "fake" };

  // repoB's reviewer says NOT READY. The reviewed ref must be the parked candidate.
  const reviewedRefs = [];
  const blockingReview = async ({ repository, integrationBranch }) => {
    reviewedRefs.push(integrationBranch);
    const isB = path.resolve(repository) === path.resolve(repoB);
    return {
      verdict: isB ? "NOT_READY" : "READY",
      findings: isB ? [{ id: "f1", severity: "high", disposition: "open" }] : [],
      divergence: null,
      reviewReceiptPath: null,
    };
  };

  const blocked = await integrateSet({
    set: mkPlan("block"), evidenceRoot, env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000,
    reviewer, goal: "coordinated change", deps: { runReview: blockingReview },
  });

  assert.equal(blocked.setReady, false, JSON.stringify(blocked));
  assert.deepEqual(blocked.blockedBy, ["repoB"]);
  const [bA, bB] = blocked.members;
  assert.equal(bA.prepared, true, "repoA's gates and review both passed");
  assert.equal(bA.review.verdict, "READY");
  assert.equal(bA.reason, "set-blocked-not-advanced");
  assert.equal(bA.integrated, false);
  assert.equal(bB.review.verdict, "NOT_READY");
  assert.equal(bB.reason, "review-not-ready");
  // Reviews ran against the parked CANDIDATE refs, not the branches.
  assert.ok(reviewedRefs.every((r) => String(r).startsWith("refs/devharmonics/candidate/")), `reviewed refs: ${reviewedRefs}`);
  // Nothing advanced anywhere.
  assert.equal(git(repoA, ["rev-parse", bA.integrationBranch]).trim(), bA.baseCommit);
  assert.equal(git(repoB, ["rev-parse", bB.integrationBranch]).trim(), bB.baseCommit);

  // A crashed reviewer is never a pass.
  const crashed = await integrateSet({
    set: mkPlan("crash"), evidenceRoot: path.join(evidenceRoot, "crash"), env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000,
    reviewer, deps: { runReview: async () => { throw new Error("reviewer exploded"); } },
  });
  assert.equal(crashed.setReady, false);
  assert.equal(crashed.members[0].review.verdict, "NOT_READY");
  assert.match(crashed.members[0].review.threw, /exploded/);

  // All-READY integrates the whole set.
  const ready = await integrateSet({
    set: mkPlan("ready"), evidenceRoot: path.join(evidenceRoot, "ready"), env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000,
    reviewer, deps: { runReview: async () => ({ verdict: "READY", findings: [], divergence: null, reviewReceiptPath: null }) },
  });
  assert.equal(ready.setReady, true, JSON.stringify(ready));
  for (const m of ready.members) {
    assert.equal(m.review.verdict, "READY");
    assert.ok(m.integrationHead);
  }
}));

// A4-6 / decision C: readiness is always qualified by the evidence that actually
// ran, and a demanded floor refuses it outright when that evidence is absent.
test("integrateSet: assurance is reported, and --require-evidence refuses a set that lacks it", () => withTemps(2, async ({ repos, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n");
  branchFrom(repoB, "worker-b", "main", "line1\nline2\nCHANGED-B\n");
  const mkPlan = (s) => planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a", integrationBranch: `devharmonics/integration/ev-a-${s}` },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b", integrationBranch: `devharmonics/integration/ev-b-${s}` },
    ],
  });
  const base = { env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000 };

  // Gates only: integrates, but says so honestly.
  const gatesOnly = await integrateSet({ set: mkPlan("g"), evidenceRoot: path.join(evidenceRoot, "g"), ...base });
  assert.equal(gatesOnly.setReady, true);
  for (const m of gatesOnly.members) assert.equal(m.assurance, "gates-only");

  // Same run, but the operator demands a validator that never ran -> refused,
  // and because it fails during prepare, nothing advances anywhere.
  const floored = await integrateSet({
    set: mkPlan("f"), evidenceRoot: path.join(evidenceRoot, "f"), ...base,
    requireEvidence: ["validator"],
  });
  assert.equal(floored.setReady, false, JSON.stringify(floored));
  assert.deepEqual(floored.blockedBy.sort(), ["repoA", "repoB"]);
  for (const m of floored.members) {
    assert.equal(m.assurance, "gates-only");
    assert.deepEqual(m.missingEvidence, ["validator"]);
    assert.match(m.reason, /insufficient-evidence \(missing: validator\)/);
    const dir = m.repositoryId === "repoA" ? repoA : repoB;
    assert.equal(git(dir, ["rev-parse", m.integrationBranch]).trim(), m.baseCommit, "an unmet evidence floor must advance nothing");
  }

  // Supply the validator and the same floor is satisfied.
  const satisfied = await integrateSet({
    set: mkPlan("s"), evidenceRoot: path.join(evidenceRoot, "s"), ...base,
    check: { command: "node", args: ["-e", "process.exit(0)"] }, checkTimeoutMs: 30_000,
    requireEvidence: ["validator"],
  });
  assert.equal(satisfied.setReady, true, JSON.stringify(satisfied));
  for (const m of satisfied.members) {
    assert.equal(m.assurance, "validated");
    assert.deepEqual(m.missingEvidence, []);
    assert.ok(m.integrationHead);
  }

  // Demanding a review that never ran also refuses, even with a passing validator.
  const needsReview = await integrateSet({
    set: mkPlan("r"), evidenceRoot: path.join(evidenceRoot, "r"), ...base,
    check: { command: "node", args: ["-e", "process.exit(0)"] }, checkTimeoutMs: 30_000,
    requireEvidence: ["validator", "review"],
  });
  assert.equal(needsReview.setReady, false);
  for (const m of needsReview.members) {
    assert.equal(m.assurance, "validated");
    assert.deepEqual(m.missingEvidence, ["review"]);
  }
}));

test("integrateSet: empty-diff member -> refused empty-diff, set not ready, set.json written", () => withTemps(2, async ({ repos, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const [repoA, repoB] = repos;
  branchFrom(repoA, "worker-a", "main", "line1\nline2\nCHANGED-A\n");
  branchNoChange(repoB, "worker-b", "main"); // genuinely empty diff

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "repoA", repository: repoA, workerBranch: "worker-a" },
      { repositoryId: "repoB", repository: repoB, workerBranch: "worker-b" },
    ],
  });

  const result = await integrateSet({ set: plan, evidenceRoot, env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000 });

  assert.equal(result.setReady, false);
  assert.deepEqual(result.blockedBy, ["repoB"]);
  const mB = result.members.find((m) => m.repositoryId === "repoB");
  assert.equal(mB.integrated, false);
  assert.equal(mB.reason, "empty-diff");

  assert.ok(existsSync(result.evidencePath));
  const bundle = readJson(result.evidencePath);
  assert.equal(bundle.setReady, false);
}));

test("integrateSet: 3-repo concurrency -> each repo's integration branch has exactly its own merge, no cross-contamination", () => withTemps(3, async ({ repos, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const [repo1, repo2, repo3] = repos;
  branchFrom(repo1, "worker-1", "main", "line1\nline2\nONLY-REPO-1\n");
  branchFrom(repo2, "worker-2", "main", "line1\nline2\nONLY-REPO-2\n");
  branchFrom(repo3, "worker-3", "main", "line1\nline2\nONLY-REPO-3\n");

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "repo1", repository: repo1, workerBranch: "worker-1" },
      { repositoryId: "repo2", repository: repo2, workerBranch: "worker-2" },
      { repositoryId: "repo3", repository: repo3, workerBranch: "worker-3" },
    ],
  });

  const result = await integrateSet({ set: plan, evidenceRoot, env: pathOnlyEnv(fixtureDir), timeoutMs: 20_000 });

  assert.equal(result.setReady, true, JSON.stringify(result));
  assert.equal(result.members.length, 3);

  const reposById = { repo1, repo2, repo3 };
  for (const m of result.members) {
    const repo = reposById[m.repositoryId];
    const log = git(repo, ["log", "--oneline", `devharmonics/integration/${plan.setId}`]).trim().split("\n").filter(Boolean);
    // init + advance + merge = exactly 3 commits, and ONLY for this repo.
    assert.equal(log.length, 3, `${m.repositoryId}: ${log.join("\n")}`);
    const messages = git(repo, ["log", "--format=%s", `devharmonics/integration/${plan.setId}`]);
    assert.match(messages, new RegExp(`integrate ${plan.setId}-${m.repositoryId}$`, "m"));
    // No commit message naming a SIBLING repositoryId leaked in.
    for (const otherId of Object.keys(reposById)) {
      if (otherId === m.repositoryId) continue;
      assert.doesNotMatch(messages, new RegExp(`integrate ${plan.setId}-${otherId}$`, "m"));
    }
    // Only the main worktree remains registered against this repo.
    const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
    assert.equal(worktrees.length, 1);
  }
}));

// --- scopeFinding -----------------------------------------------------------

const KNOWN = ["repoA", "repoB"];

test("scopeFinding: explicit repositoryId scopes", () => {
  const result = scopeFinding({ repositoryId: "repoA", location: null, rationale: "x" }, KNOWN);
  assert.deepEqual(result, { scoped: true, repositoryId: "repoA", reason: null });
});

test('scopeFinding: "<repositoryId>:path/file.py:12" location scopes', () => {
  const result = scopeFinding({ location: "repoA:path/file.py:12", rationale: "x" }, KNOWN);
  assert.deepEqual(result, { scoped: true, repositoryId: "repoA", reason: null });
});

test("scopeFinding: unknown repositoryId -> scoped false", () => {
  const result = scopeFinding({ repositoryId: "repoZ", rationale: "x" }, KNOWN);
  assert.equal(result.scoped, false);
  assert.equal(result.repositoryId, null);
  assert.match(result.reason, /unknown repositoryId/);
});

test("scopeFinding: a finding matching two ids -> scoped false", () => {
  // Explicit repositoryId disagrees with the location's repository prefix —
  // two distinct signals must never be resolved by guessing which wins.
  const result = scopeFinding({ repositoryId: "repoA", location: "repoB:path/file.py:3", rationale: "x" }, KNOWN);
  assert.equal(result.scoped, false);
  assert.equal(result.repositoryId, null);
  assert.match(result.reason, /multiple repositories/);
  assert.match(result.reason, /repoA/);
  assert.match(result.reason, /repoB/);
});

test("scopeFinding: no repositoryId at all -> scoped false", () => {
  const result = scopeFinding({ location: "path/to/file.py:12", rationale: "x" }, KNOWN);
  assert.equal(result.scoped, false);
  assert.equal(result.repositoryId, null);
  assert.match(result.reason, /names no repositoryId/);
});
