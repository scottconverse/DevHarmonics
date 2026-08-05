import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { integrateWorkerBranch } from "../scripts/integrate.mjs";

/**
 * Real git repos in temp dirs — the thing under test IS git plumbing
 * (empty-diff, merge, conflict, branch-serialization), so faking it would
 * test nothing (precedent: test/local-patch.test.mjs). The tampercheck gate
 * itself is always a fake executable fixture: CI runners have no real
 * tampercheck installed, and the whole point of these tests is to prove the
 * INTEGRATION ENGINE's fail-closed behavior against a seeded/weakened/absent
 * gate, not to test tampercheck itself.
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
  const dir = tempDir("dh-int-repo-");
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
  const wt = tempDir("dh-int-authorwt-");
  git(dir, ["worktree", "add", "-q", wt, branchName]);
  writeFileSync(path.join(wt, "file.txt"), fileContent);
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `advance ${branchName}`]);
  git(dir, ["worktree", "remove", "--force", wt]);
  return git(dir, ["rev-parse", branchName]).trim();
}

/** Emptybranch: a branch pointing at the exact same tree as base (no commit
 * at all) — a genuinely empty diff against merge-base. */
function branchNoChange(dir, branchName, base) {
  git(dir, ["branch", branchName, base]);
}

/** A branch that adds a brand-new file rather than touching file.txt, so it
 * can be merged alongside another branch with zero risk of an add/add
 * conflict on the same hunk (used for the true non-conflicting scenarios;
 * two branches that both append a line to the SAME file's SAME position are
 * a genuine add/add conflict in git, not a safe "non-conflicting" case). */
function branchFromNewFile(dir, branchName, base, filename, content) {
  git(dir, ["branch", branchName, base]);
  const wt = tempDir("dh-int-authorwt-");
  git(dir, ["worktree", "add", "-q", wt, branchName]);
  writeFileSync(path.join(wt, filename), content);
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `advance ${branchName}`]);
  git(dir, ["worktree", "remove", "--force", wt]);
  return git(dir, ["rev-parse", branchName]).trim();
}

// --- fake tampercheck fixtures -------------------------------------------
// Cross-platform pattern ported from test/probes.test.mjs's fakeVersionTool:
// a .cmd on win32 (real Windows executables must carry a PATHEXT suffix),
// a chmod +x shell script elsewhere.

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

function fakeFindings(dir) {
  return writeFakeTampercheck(dir, {
    win: "echo TAMPERCHECK FINDINGS: seeded gate weakening detected\r\nexit /b 1",
    posix: "echo TAMPERCHECK FINDINGS: seeded gate weakening detected\nexit 1",
  });
}

function fakeCrash(dir) {
  return writeFakeTampercheck(dir, {
    win: "echo TAMPERCHECK CRASHED\r\nexit /b 2",
    posix: "echo TAMPERCHECK CRASHED\nexit 2",
  });
}

function fakeSleeper(dir) {
  return writeFakeTampercheck(dir, {
    // ping trick for a dependency-free Windows sleep; `sleep` on POSIX.
    win: "ping -n 6 127.0.0.1 >nul\r\necho SHOULD_NOT_APPEAR",
    posix: "sleep 5\necho SHOULD_NOT_APPEAR",
  });
}

/** A fake that proves it was (or was not) invoked by writing a marker file
 * into `markerDir`, in addition to behaving like a clean pass. */
function fakeMarker(dir, markerPath) {
  const escaped = markerPath.replace(/\\/g, "\\\\");
  return writeFakeTampercheck(dir, {
    win: `echo ran > "${markerPath}"\r\necho TAMPERCHECK CLEAN\r\nexit /b 0`,
    posix: `echo ran > "${escaped}"\necho TAMPERCHECK CLEAN\nexit 0`,
  });
}

function pathOnlyEnv(dir) {
  // The fixture directory goes FIRST on PATH, so resolvePathCommand always
  // picks our fake over any real tampercheck that might also be installed
  // on this machine's ambient PATH (earlier PATH directory wins — see
  // path-resolve.mjs). The rest of the real PATH stays behind it: the fake
  // fixtures are .cmd/shell scripts that themselves shell out to real OS
  // commands (ping, echo redirection), which on Windows requires System32
  // still being reachable — replacing PATH entirely breaks that and makes a
  // "hang" fixture fail instantly instead of hanging.
  const separator = process.platform === "win32" ? ";" : ":";
  const existing = process.env.PATH ?? process.env.Path ?? "";
  const merged = `${dir}${separator}${existing}`;
  return { ...process.env, PATH: merged, Path: merged, PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" };
}

/** A PATH containing ONLY the (empty, no-fixture) fixture directory — no
 * fallback to the real ambient PATH. Used exclusively for the "tool absent"
 * scenario: this dev machine may have a REAL tampercheck installed, and if
 * the ambient PATH were merged in (as pathOnlyEnv does for every other
 * test), resolvePathCommand would find that real tool instead of genuinely
 * finding nothing — defeating the point of the scenario. Safe to restrict
 * this hard because nothing is ever spawned when resolution returns null. */
function noToolEnv(dir) {
  return { ...process.env, PATH: dir, Path: dir, PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" };
}

function withTemps(fn) {
  const repo = initRepo();
  const evidenceRoot = tempDir("dh-int-evidence-");
  const fixtureDir = tempDir("dh-int-fixtures-");
  return (async () => {
    try {
      await fn({ repo, evidenceRoot, fixtureDir });
    } finally {
      for (const d of [repo, evidenceRoot, fixtureDir]) rmSync(d, { recursive: true, force: true });
    }
  })();
}

function readEvidence(evidencePath) {
  return JSON.parse(readFileSync(evidencePath, "utf8"));
}

test("happy path: real change + clean gate -> integrated, merge commit, evidence complete, user checkout untouched", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const originalHead = git(repo, ["rev-parse", "HEAD"]).trim();
  const originalStatus = git(repo, ["status", "--porcelain"]);
  branchFrom(repo, "worker-a", "main", "line1\nline2\nCHANGED\n");

  const result = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run1",
    workerBranch: "worker-a",
    baseRef: "main",
    taskId: "task-happy",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });

  assert.equal(result.integrated, true, JSON.stringify(result));
  assert.equal(result.reason, null);
  assert.ok(result.integrationHead);
  assert.equal(result.gates.emptyDiff.status, "pass");
  assert.equal(result.gates.tampercheck.status, "pass");
  assert.match(result.gates.tampercheck.stdout, /TAMPERCHECK CLEAN/);

  // The integration branch actually contains the merge commit.
  const log = git(repo, ["log", "--format=%H %P", "devharmonics/integration/run1"]);
  assert.match(log.split("\n")[0], new RegExp(result.integrationHead));

  // User's own checkout (repo HEAD/status) is completely untouched.
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), originalHead);
  assert.equal(git(repo, ["status", "--porcelain"]), originalStatus);

  // Evidence bundle.
  const bundle = readEvidence(result.evidencePath);
  assert.equal(bundle.taskId, "task-happy");
  assert.equal(bundle.reason, null);
  assert.equal(bundle.integrationHead, result.integrationHead);
  assert.ok(existsSync(path.join(path.dirname(result.evidencePath), "tampercheck-output.txt")));

  // No leftover worktrees registered against the repo.
  const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
  assert.equal(worktrees.length, 1);
}));

test("seeded gate-weakening: tampercheck exit 1 -> refused, findings preserved, no merge", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeFindings(fixtureDir);
  branchFrom(repo, "worker-b", "main", "line1\nCHANGED\nline3\n");

  const result = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run2",
    workerBranch: "worker-b",
    baseRef: "main",
    taskId: "task-findings",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });

  assert.equal(result.integrated, false);
  assert.equal(result.reason, "tampercheck-findings");
  assert.equal(result.integrationHead, null);
  assert.equal(result.gates.tampercheck.status, "refused");
  assert.match(result.gates.tampercheck.stdout, /seeded gate weakening detected/);

  const bundle = readEvidence(result.evidencePath);
  assert.equal(bundle.reason, "tampercheck-findings");
  const tcOutput = readFileSync(path.join(path.dirname(result.evidencePath), "tampercheck-output.txt"), "utf8");
  assert.match(tcOutput, /seeded gate weakening detected/);

  // Integration branch was never created (merge never attempted).
  const exists = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/devharmonics/integration/run2"]);
  assert.notEqual(exists.status, 0);
}));

// Independent audit 2026-08-05, reproduced: a worker branch that does not
// descend from the recorded base was accepted and merged, so the "pinned base"
// constrained nothing and the delivered merge combined ungated changes.
test("base ancestry: a worker branch that does not descend from the recorded base is refused before any gate or merge", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  const oldBase = git(repo, ["rev-parse", "HEAD"]).trim();
  branchFrom(repo, "worker-stale", oldBase, "worker change\n");
  // main advances independently, so the recorded base is no longer an ancestor
  writeFileSync(path.join(repo, "other.txt"), "main moved on\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "main advances"]);
  const newBase = git(repo, ["rev-parse", "HEAD"]).trim();

  const result = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/stale",
    workerBranch: "worker-stale",
    baseRef: newBase,
    taskId: "task-stale",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });

  assert.equal(result.integrated, false, JSON.stringify(result));
  assert.equal(result.reason, "stale-worker-base");
  assert.equal(result.gates.baseAncestry.status, "refused");
  assert.equal(result.gates.tampercheck.status, "skipped", "must refuse before tampercheck is even asked");
  const branchExists = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/devharmonics/integration/stale"]).status === 0;
  assert.equal(branchExists, false, "no integration branch may be created for a refused ancestry check");
}));

// The case that survives the ancestry fix: the worker legitimately descends from
// the base, but a REUSED integration branch sits ahead of it, so git's clean
// auto-merge yields a combined tree the worker-side scan never saw. The gate must
// scan the commit actually delivered, and must not advance the ref when it fails.
test("final-artifact gate: a reused integration branch ahead of base cannot deliver a tree the worker scan never saw", async () => {
  const repo = tempDir("dh-int-repo-");
  const evidenceRoot = tempDir("dh-int-evidence-");
  const fixtureDir = tempDir("dh-int-fixtures-");
  const INTEGRATION = "devharmonics/integration/reused";
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeFileSync(path.join(repo, "config.txt"), "api=v1\n");
    writeFileSync(path.join(repo, "client.txt"), "client=v1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const baseRef = git(repo, ["rev-parse", "HEAD"]).trim();

    // worker cut from the pinned base (ancestry VALID) — touches client only
    git(repo, ["branch", "worker-reused", baseRef]);
    let wt = tempDir("dh-int-wt-");
    git(repo, ["worktree", "add", "-q", wt, "worker-reused"]);
    writeFileSync(path.join(wt, "client.txt"), "client=v1-feature\n");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "worker feature"]);
    git(repo, ["worktree", "remove", "--force", wt]);

    // a reused integration branch already AHEAD of base — touches config only
    git(repo, ["branch", INTEGRATION, baseRef]);
    wt = tempDir("dh-int-wt-");
    git(repo, ["worktree", "add", "-q", wt, INTEGRATION]);
    writeFileSync(path.join(wt, "config.txt"), "api=v2\n");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "prior integration advanced the branch"]);
    git(repo, ["worktree", "remove", "--force", wt]);
    const preMergeHead = git(repo, ["rev-parse", INTEGRATION]).trim();

    // content-aware fake gate: CLEAN on the worker tree, FINDING on the combination
    writeFakeTampercheck(fixtureDir, {
      win: 'findstr /C:"api=v2" config.txt >nul 2>&1\r\nif errorlevel 1 goto clean\r\nfindstr /C:"client=v1-feature" client.txt >nul 2>&1\r\nif errorlevel 1 goto clean\r\necho TAMPERCHECK FINDINGS: forbidden combination\r\nexit /b 1\r\n:clean\r\necho TAMPERCHECK CLEAN\r\nexit /b 0',
      posix: 'if grep -q "api=v2" config.txt 2>/dev/null && grep -q "client=v1-feature" client.txt 2>/dev/null; then echo "TAMPERCHECK FINDINGS: forbidden combination"; exit 1; fi\necho TAMPERCHECK CLEAN\nexit 0',
    });

    const result = await integrateWorkerBranch({
      repository: repo,
      integrationBranch: INTEGRATION,
      workerBranch: "worker-reused",
      baseRef,
      taskId: "task-final-artifact",
      evidenceRoot,
      tampercheckCommand: "tampercheck",
      env: pathOnlyEnv(fixtureDir),
      timeoutMs: 20_000,
    });

    assert.equal(result.gates.baseAncestry.status, "pass", "ancestry is legitimately valid here");
    assert.equal(result.gates.tampercheck.status, "pass", "the worker's own tree really is clean");
    assert.equal(result.gates.finalArtifact.status, "refused", "the delivered merge commit must itself be scanned");
    assert.equal(result.reason, "final-artifact-findings");
    assert.equal(result.integrated, false);
    assert.equal(result.integrationHead, null);
    assert.equal(
      git(repo, ["rev-parse", INTEGRATION]).trim(),
      preMergeHead,
      "the integration ref must NOT advance when the delivered artifact is refused",
    );
  } finally {
    for (const d of [repo, evidenceRoot, fixtureDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("tampercheck version pin is EXACT, not substring: a superstring version is refused (GAUNTLET, Agent B)", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir); // fixture tampercheck answers --version with "0.1.1"
  branchFrom(repo, "worker-v", "main", "line1\nline2\nCHANGED\n");
  const call = (expected, suffix) => integrateWorkerBranch({
    repository: repo,
    integrationBranch: `devharmonics/integration/ver-${suffix}`,
    workerBranch: "worker-v",
    baseRef: "main",
    taskId: "task-ver",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    expectedTampercheckVersion: expected,
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });
  // "0.1.1" is reported; a substring pin of "1.1" must NOT satisfy it now.
  const bad = await call("1.1", "bad");
  assert.equal(bad.integrated, false);
  assert.equal(bad.reason, "tampercheck-unavailable", "a superstring version pin must be refused");
  // The exact version still passes.
  const good = await call("0.1.1", "good");
  assert.equal(good.integrated, true, JSON.stringify(good));
}));

test("tampercheck exit 2 -> refused tampercheck-unavailable, never a pass", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeCrash(fixtureDir);
  branchFrom(repo, "worker-c", "main", "line1\nline2\nline3\nCHANGED\n");

  const result = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run3",
    workerBranch: "worker-c",
    baseRef: "main",
    taskId: "task-crash",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });

  assert.equal(result.integrated, false);
  assert.equal(result.reason, "tampercheck-unavailable");
  assert.equal(result.gates.tampercheck.exitCode, 2);
  const bundle = readEvidence(result.evidencePath);
  assert.equal(bundle.reason, "tampercheck-unavailable");
}));

test("tampercheck absent from PATH -> refused tampercheck-unavailable, same reason", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  // fixtureDir deliberately left empty: no fake tampercheck placed in it.
  branchFrom(repo, "worker-d", "main", "line1\nline2\nline3\nline4\n");

  const result = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run4",
    workerBranch: "worker-d",
    baseRef: "main",
    taskId: "task-absent",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: noToolEnv(fixtureDir),
    timeoutMs: 20_000,
  });

  assert.equal(result.integrated, false);
  assert.equal(result.reason, "tampercheck-unavailable");
  assert.equal(result.gates.tampercheck.status, "refused");
  const bundle = readEvidence(result.evidencePath);
  assert.equal(bundle.reason, "tampercheck-unavailable");
}));

test("tampercheck hangs past timeout -> refused tampercheck-unavailable", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeSleeper(fixtureDir);
  branchFrom(repo, "worker-e", "main", "line1\nline2\nline3\nline4\nline5\n");

  const result = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run5",
    workerBranch: "worker-e",
    baseRef: "main",
    taskId: "task-timeout",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 500,
  });

  assert.equal(result.integrated, false);
  assert.equal(result.reason, "tampercheck-unavailable");
  assert.equal(result.gates.tampercheck.timedOut, true);
  assert.doesNotMatch(result.gates.tampercheck.stdout ?? "", /SHOULD_NOT_APPEAR/);
}));

test("empty diff -> refused empty-diff, tampercheck never invoked", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  const markerPath = path.join(fixtureDir, "marker-ran.txt");
  fakeMarker(fixtureDir, markerPath);
  branchNoChange(repo, "worker-empty", "main");

  const result = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run6",
    workerBranch: "worker-empty",
    baseRef: "main",
    taskId: "task-empty",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });

  assert.equal(result.integrated, false);
  assert.equal(result.reason, "empty-diff");
  assert.equal(result.gates.emptyDiff.status, "refused");
  assert.equal(result.gates.tampercheck.status, "skipped");
  assert.equal(existsSync(markerPath), false, "tampercheck fixture must never have run");

  const bundle = readEvidence(result.evidencePath);
  assert.equal(bundle.reason, "empty-diff");
}));

test("merge conflict: second overlapping branch is refused, first merge stays intact", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  branchFrom(repo, "worker-f1", "main", "CONFLICT-A\nline2\nline3\n");
  branchFrom(repo, "worker-f2", "main", "CONFLICT-B\nline2\nline3\n");

  const first = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run7",
    workerBranch: "worker-f1",
    baseRef: "main",
    taskId: "task-conflict-1",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });
  assert.equal(first.integrated, true, JSON.stringify(first));
  const firstIntegrationHead = git(repo, ["rev-parse", "devharmonics/integration/run7"]).trim();

  const second = await integrateWorkerBranch({
    repository: repo,
    integrationBranch: "devharmonics/integration/run7",
    workerBranch: "worker-f2",
    baseRef: "main",
    taskId: "task-conflict-2",
    evidenceRoot,
    tampercheckCommand: "tampercheck",
    env: pathOnlyEnv(fixtureDir),
    timeoutMs: 20_000,
  });

  assert.equal(second.integrated, false);
  assert.equal(second.reason, "merge-conflict");
  assert.equal(second.integrationHead, null);
  assert.ok(second.conflictingPaths.includes("file.txt"));

  const bundle = readEvidence(second.evidencePath);
  assert.equal(bundle.reason, "merge-conflict");
  assert.ok(bundle.conflictingPaths.includes("file.txt"));

  // Integration branch is still exactly at the first merge — refused merge
  // left no trace.
  assert.equal(git(repo, ["rev-parse", "devharmonics/integration/run7"]).trim(), firstIntegrationHead);

  // No leftover worktrees from the aborted merge.
  const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
  assert.equal(worktrees.length, 1);
}));

test("serialization: two concurrent non-conflicting integrations into one repo never interleave", () => withTemps(async ({ repo, evidenceRoot, fixtureDir }) => {
  fakeClean(fixtureDir);
  branchFrom(repo, "worker-g1", "main", "line1\nline2\nline3\nG1\n");
  branchFromNewFile(repo, "worker-g2", "main", "file2.txt", "brand new file from g2\n");

  const [r1, r2] = await Promise.all([
    integrateWorkerBranch({
      repository: repo,
      integrationBranch: "devharmonics/integration/run8",
      workerBranch: "worker-g1",
      baseRef: "main",
      taskId: "task-concurrent-1",
      evidenceRoot,
      tampercheckCommand: "tampercheck",
      env: pathOnlyEnv(fixtureDir),
      timeoutMs: 20_000,
    }),
    integrateWorkerBranch({
      repository: repo,
      integrationBranch: "devharmonics/integration/run8",
      workerBranch: "worker-g2",
      baseRef: "main",
      taskId: "task-concurrent-2",
      evidenceRoot,
      tampercheckCommand: "tampercheck",
      env: pathOnlyEnv(fixtureDir),
      timeoutMs: 20_000,
    }),
  ]);

  assert.equal(r1.integrated, true, JSON.stringify(r1));
  assert.equal(r2.integrated, true, JSON.stringify(r2));

  // Both merges landed, in some order, with no corruption: exactly two
  // merge commits (plus the two author commits and the init commit) reach
  // back to main.
  const log = git(repo, ["log", "--oneline", "devharmonics/integration/run8"]).trim().split("\n").filter(Boolean);
  assert.equal(log.length, 5, log.join("\n"));
  const messages = git(repo, ["log", "--format=%s", "devharmonics/integration/run8"]);
  assert.match(messages, /integrate task-concurrent-1/);
  assert.match(messages, /integrate task-concurrent-2/);

  // Only the main worktree remains registered.
  const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
  assert.equal(worktrees.length, 1);

  const b1 = readEvidence(r1.evidencePath);
  const b2 = readEvidence(r2.evidencePath);
  assert.equal(b1.reason, null);
  assert.equal(b2.reason, null);
}));
