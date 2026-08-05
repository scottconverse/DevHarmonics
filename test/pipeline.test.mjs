import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPipeline } from "../scripts/run-command.mjs";

/**
 * Hermetic coverage for the pipeline (scripts/run-command.mjs: runPipeline +
 * runCommandCli). Real git fixture repos in temp dirs — the thing under test
 * IS the intake/worker/gate/integration wiring, so faking git would test
 * nothing (precedent: test/integrate.test.mjs). A FAKE "codex" CLI on PATH
 * stands in for the AI worker (precedent: test/run-worker.test.mjs's
 * fakeCodexDir) and a FAKE "tampercheck" on PATH stands in for the integrity
 * gate (precedent: test/integrate.test.mjs). The `--check` validator is a
 * real `node check.mjs` run against a real (tiny, deterministic) fixture
 * function, so "the validator passed/failed" is a genuine functional result,
 * not an assumption. No real AI CLI and no network are ever involved.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");

// --- fixture repo: a deliberately buggy add(a,b) plus a real checker ------

const BUGGY_ADD = "export function add(a, b) {\n  return a + a;\n}\n";
const CHECK_SCRIPT = [
  'import { add } from "./add.mjs";',
  "const got = add(2, 3);",
  "if (got !== 5) {",
  '  console.error("FAIL: add(2,3) = " + got + ", expected 5");',
  "  process.exit(1);",
  "}",
  'console.log("PASS: add(2,3) = 5");',
  "process.exit(0);",
  "",
].join("\n");
const GITIGNORE_CONTENT = "node_modules/\ndist/\n";

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

function headOf(repo) {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function branchExists(repo, branch) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { encoding: "utf8" });
  return result.status === 0;
}

/** every test that reaches a repo-scoped runId must confirm: (a) the repo
 * has no leftover registered worktree beyond the user's own checkout, and
 * (b) run-command.mjs's own temp worktree dir (`dh-run-<runId>-*` under
 * os.tmpdir()) is gone. `runId` is null for scenarios that throw before a
 * runId is ever computed (nothing to check there beyond (a)). */
function assertWorktreeHygiene(repo, runId) {
  const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
  assert.equal(worktrees.length, 1, `leftover worktrees registered against the repo:\n${worktrees.join("\n")}`);
  if (runId) {
    const leftover = readdirSync(os.tmpdir()).filter((name) => name.startsWith(`dh-run-${runId}-`));
    assert.deepEqual(leftover, [], `leftover temp worktree dir(s) for run ${runId}: ${leftover.join(", ")}`);
  }
}

function initFixtureRepo({ withGitignore = false } = {}) {
  const dir = tempDir("dh-pipe-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  // Deterministic byte content regardless of the host's global autocrlf
  // setting — several assertions below compare exact file content/exit text.
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "add.mjs"), BUGGY_ADD);
  writeFileSync(path.join(dir, "check.mjs"), CHECK_SCRIPT);
  if (withGitignore) writeFileSync(path.join(dir, ".gitignore"), GITIGNORE_CONTENT);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

// --- env wiring: prepend fixture dirs to the REAL PATH --------------------
// (pattern ported from test/integrate.test.mjs's pathOnlyEnv: fixtures go
// first so they always win PATH resolution, the real PATH stays behind them
// so `git`/`node`/System32 utilities the fixtures themselves shell out to
// keep working).

function buildEnv(...fixtureDirs) {
  const existingPath = process.env.PATH ?? process.env.Path ?? "";
  const merged = [...fixtureDirs.filter(Boolean), existingPath].join(path.delimiter);
  return {
    ...process.env,
    PATH: merged,
    Path: merged,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  };
}

// --- fake "codex" worker on PATH -------------------------------------------
// Pattern ported from test/run-worker.test.mjs's fakeCodexDir: a .CMD shim
// on win32 delegating to a real Node script that honors the real contract
// (reads the prompt from stdin, optionally writes --output-last-message).
// The write action varies by mode so each pipeline scenario gets exactly the
// worker behavior it needs to exercise.

function providerImplSource({ writeFile, content, exitCode }) {
  const writeStatement = writeFile
    ? `writeFileSync(path.join(process.cwd(), ${JSON.stringify(writeFile)}), ${JSON.stringify(content)});`
    : "";
  return `import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--output-last-message");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  ${writeStatement}
  if (outPath) writeFileSync(outPath, "FAKE WORKER DONE");
  process.exit(${exitCode});
});
`;
}

const PROVIDER_MODES = Object.freeze({
  // Implements the fixture's failing function for real.
  fix: { writeFile: "add.mjs", content: "export function add(a, b) {\n  return a + b;\n}\n", exitCode: 0 },
  // Writes a real change, but not a correct one (for the validator-failure case).
  wrongfix: { writeFile: "add.mjs", content: "export function add(a, b) {\n  return a - b;\n}\n", exitCode: 0 },
  // Exits 0 having changed nothing (empty-diff case).
  noop: { writeFile: null, content: null, exitCode: 0 },
  // Exits nonzero, changes nothing (worker-failed case).
  fail: { writeFile: null, content: null, exitCode: 7 },
});

function fakeProviderDir(mode) {
  const spec = PROVIDER_MODES[mode];
  if (!spec) throw new Error(`fakeProviderDir: unknown mode "${mode}"`);
  const dir = mkdtempSync(path.join(os.tmpdir(), `dh-pipe-provider-${mode}-`));
  const impl = path.join(dir, "fake-codex-impl.mjs");
  writeFileSync(impl, providerImplSource(spec));
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "codex.CMD"), `@echo off\r\nnode "${impl}" %*\r\n`);
  } else {
    const shim = path.join(dir, "codex");
    writeFileSync(shim, `#!/bin/sh\nexec node "${impl}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return dir;
}

// --- fake "tampercheck" on PATH --------------------------------------------
// Pattern ported from test/integrate.test.mjs: a .cmd on win32 / chmod+x
// shell script elsewhere, exiting 0 (clean) or 1 (findings).

const TAMPERCHECK_MODES = Object.freeze({
  clean: { win: "echo TAMPERCHECK CLEAN\r\nexit /b 0", posix: "echo TAMPERCHECK CLEAN\nexit 0" },
  findings: { win: "echo TAMPERCHECK FINDINGS\r\nexit /b 1", posix: "echo TAMPERCHECK FINDINGS\nexit 1" },
});

function fakeTampercheckDir(mode) {
  const body = TAMPERCHECK_MODES[mode];
  if (!body) throw new Error(`fakeTampercheckDir: unknown mode "${mode}"`);
  const dir = mkdtempSync(path.join(os.tmpdir(), `dh-pipe-tamper-${mode}-`));
  // Answering --version with a bare semantic version is what a real CLI does,
  // and what the integration gate's identity check (falsification finding
  // F-1) requires before trusting a verdict. A fixture that cannot answer it
  // is indistinguishable from the PATH-substituted stub that check rejects.
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "tampercheck.cmd"), `@echo off\r\nif /I "%~1"=="--version" (echo 0.1.1& exit /b 0)\r\n${body.win}\r\n`);
  } else {
    const file = path.join(dir, "tampercheck");
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.1; exit 0; fi\n${body.posix}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

test("happy path: fake codex fixes the bug, check passes, both gates pass, integrated with a merge commit", async () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("fix");
  const tampercheckDir = fakeTampercheckDir("clean");
  try {
    const beforeHead = headOf(repo);
    const beforeStatus = git(repo, ["status", "--porcelain"]);

    const result = await runPipeline({
      repository: repo,
      prompt: "fix add() so it returns a + b",
      provider: "codex",
      model: "fake-model-9b",
      check: "node check.mjs",
      taskId: "happy1",
      env: buildEnv(providerDir, tampercheckDir),
      timeoutMs: 20_000,
    });

    assert.equal(result.integrated, true, JSON.stringify(result));
    assert.equal(result.reason, "ready-for-owner-review");
    assert.equal(result.integrationBranch, "devharmonics/integration/happy1");
    assert.ok(result.integrationHead, "expected an integration head commit");

    // The validator really ran and really passed — against the MERGED candidate
    // (R-5), the exact commit delivered on the integration branch, not the
    // worker's pre-merge tree.
    assert.equal(result.stages.validator.exitCode, 0, JSON.stringify(result.stages.validator));
    assert.match(result.stages.validator.stdoutTail, /PASS: add\(2,3\) = 5/);
    assert.equal(result.stages.validator.onMergedCandidate, true);
    assert.equal(result.stages.validator.candidateHead, result.integrationHead,
      "the validator must have executed against the exact commit that became the integration head");

    // Real merge commit on the integration branch — git plumbing, not a mock.
    const parents = git(repo, ["log", "-1", "--format=%P", result.integrationBranch]).trim();
    assert.equal(parents.split(/\s+/).filter(Boolean).length, 2, `expected a 2-parent merge commit, got parents: "${parents}"`);

    // Evidence bundle on disk.
    assert.ok(existsSync(result.evidenceRoot), "evidenceRoot must exist");
    assert.ok(existsSync(path.join(result.stages.worker.receiptDir, "receipt.json")), "worker receipt must exist");
    assert.ok(existsSync(result.stages.integration.evidencePath), "integration evidence bundle must exist");

    // The user's own checkout: HEAD and porcelain status identical before/after.
    assert.equal(headOf(repo), beforeHead, "HEAD must be untouched");
    assert.equal(git(repo, ["status", "--porcelain"]), beforeStatus, "porcelain status must be untouched");

    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir, tampercheckDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Clean-tree refusal
// ---------------------------------------------------------------------------

test("clean-tree refusal: tracked uncommitted change -> throws, nothing created", async () => {
  const repo = initFixtureRepo();
  try {
    const excludePath = path.join(repo, ".git", "info", "exclude");
    const beforeExclude = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";

    // Tracked-but-uncommitted change: add.mjs is already committed, so
    // modifying it in place leaves it dirty-and-tracked (never "??").
    writeFileSync(path.join(repo, "add.mjs"), `${BUGGY_ADD}// dirty edit, never committed\n`);

    await assert.rejects(
      () => runPipeline({ repository: repo, prompt: "p", provider: "codex", model: "fake-model-9b", timeoutMs: 20_000 }),
      /uncommitted changes/,
    );

    assert.equal(existsSync(path.join(repo, ".devharmonics")), false, "no .devharmonics state must be created");
    const branches = git(repo, ["branch", "--list", "devharmonics/*"]).trim();
    assert.equal(branches, "", "no devharmonics/* branch must be created");
    assertWorktreeHygiene(repo, null);

    const afterExclude = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    assert.equal(afterExclude, beforeExclude, ".git/info/exclude must be untouched on a rejected intake");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Worker produced nothing
// ---------------------------------------------------------------------------

test("worker produced nothing: fake CLI exits 0 with no file written -> worker-empty-diff, no commit", async () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("noop");
  try {
    const result = await runPipeline({
      repository: repo,
      prompt: "do nothing",
      provider: "codex",
      model: "fake-model-9b",
      taskId: "empty1",
      env: buildEnv(providerDir),
      timeoutMs: 20_000,
    });

    assert.equal(result.integrated, false, JSON.stringify(result));
    assert.equal(result.reason, "worker-empty-diff");
    assert.equal(result.stages.commit.committed, false);

    // Worker branch never advanced past baseRef: no commit landed.
    const workerHead = git(repo, ["rev-parse", `devharmonics/task/${result.runId}`]).trim();
    assert.equal(workerHead, result.baseRef);

    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Worker failed
// ---------------------------------------------------------------------------

test("worker failed: fake CLI exits nonzero -> reason starts with worker-, receipt still on disk", async () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("fail");
  try {
    const result = await runPipeline({
      repository: repo,
      prompt: "boom",
      provider: "codex",
      model: "fake-model-9b",
      taskId: "failed1",
      env: buildEnv(providerDir),
      timeoutMs: 20_000,
    });

    assert.equal(result.integrated, false, JSON.stringify(result));
    assert.match(result.reason, /^worker-/);
    assert.equal(result.reason, "worker-failed");

    assert.ok(result.stages.worker.receiptDir, "worker stage must record a receipt directory");
    assert.ok(existsSync(path.join(result.stages.worker.receiptDir, "receipt.json")), "every attempt leaves a receipt, including a failed one");

    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Validator failure
// ---------------------------------------------------------------------------

test("validator failure: worker writes a file but --check fails -> validator-failed, no integration branch", async () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("wrongfix");
  // R-5: the validator now runs inside integrateWorkerBranch, against the merged
  // candidate — which means tampercheck gates run first, so a hermetic fake
  // tampercheck is required for the pipeline to reach the validator at all.
  const tampercheckDir = fakeTampercheckDir("clean");
  try {
    const result = await runPipeline({
      repository: repo,
      prompt: "almost fix it",
      provider: "codex",
      model: "fake-model-9b",
      check: "node check.mjs",
      taskId: "valfail1",
      env: buildEnv(providerDir, tampercheckDir),
      timeoutMs: 20_000,
    });

    assert.equal(result.integrated, false, JSON.stringify(result));
    assert.match(result.reason, /^validator-failed/);
    assert.equal(result.stages.validator.exitCode, 1, JSON.stringify(result.stages.validator));
    // check.mjs writes its failure line via console.error -> stderr.
    assert.match(result.stages.validator.stderrTail, /FAIL: add\(2,3\)/);
    // The failing check provably ran on the merged candidate, not the worker tree.
    assert.equal(result.stages.validator.onMergedCandidate, true);
    assert.ok(result.stages.validator.candidateHead, "the refused validator run must name the candidate commit it tested");

    // The integration branch is created at the pinned base before the candidate
    // is built (candidate-first merge), but a validator refusal must never let
    // it ADVANCE: it stays exactly at the base, with no merge commit on it.
    const integrationRef = `devharmonics/integration/${result.runId}`;
    assert.equal(branchExists(repo, integrationRef), true);
    assert.equal(git(repo, ["rev-parse", integrationRef]).trim(), result.baseRef,
      "a validator refusal must leave the integration branch un-advanced at the pinned base");

    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir, tampercheckDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Validator unresolvable
// ---------------------------------------------------------------------------

test("validator unresolvable: --check names a tool that isn't on PATH -> validator-unresolvable", async () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("fix");
  // R-5: same as above — the validator lives inside the integration engine now,
  // so tampercheck must pass before the unresolvable check is even attempted.
  const tampercheckDir = fakeTampercheckDir("clean");
  try {
    const result = await runPipeline({
      repository: repo,
      prompt: "fix it",
      provider: "codex",
      model: "fake-model-9b",
      check: "definitely-not-a-real-tool arg",
      taskId: "unresolv1",
      env: buildEnv(providerDir, tampercheckDir),
      timeoutMs: 20_000,
    });

    assert.equal(result.integrated, false, JSON.stringify(result));
    // The engine's reason is the bare refusal; the command it could not resolve
    // is named in the integration evidence's validator gate detail.
    assert.equal(result.reason, "validator-unresolvable");
    assert.match(result.stages.integration.gates.validator.detail, /definitely-not-a-real-tool/);

    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir, tampercheckDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. tampercheck refusal
// ---------------------------------------------------------------------------

test("tampercheck refusal: real change + fake tampercheck exit 1 -> tampercheck-findings, integration branch not created", async () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("fix");
  const tampercheckDir = fakeTampercheckDir("findings");
  try {
    const result = await runPipeline({
      repository: repo,
      prompt: "fix it",
      provider: "codex",
      model: "fake-model-9b",
      taskId: "tamper1",
      env: buildEnv(providerDir, tampercheckDir),
      timeoutMs: 20_000,
    });

    assert.equal(result.integrated, false, JSON.stringify(result));
    assert.equal(result.reason, "tampercheck-findings");
    assert.equal(branchExists(repo, `devharmonics/integration/${result.runId}`), false, "integration branch must not be created on a tampercheck refusal");

    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir, tampercheckDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Private exclude
// ---------------------------------------------------------------------------

test("private exclude: .git/info/exclude gets .devharmonics/, tracked .gitignore is never touched", async () => {
  async function runCase(withGitignore, taskId) {
    const repo = initFixtureRepo({ withGitignore });
    const providerDir = fakeProviderDir("noop");
    try {
      const gitignorePath = path.join(repo, ".gitignore");
      const before = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null;

      const result = await runPipeline({
        repository: repo,
        prompt: "p",
        provider: "codex",
        model: "fake-model-9b",
        taskId,
        env: buildEnv(providerDir),
        timeoutMs: 20_000,
      });
      // Outcome is irrelevant to this scenario (noop -> worker-empty-diff);
      // ensureExcluded runs unconditionally before the worker ever starts.
      assert.equal(result.integrated, false);

      const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
      assert.match(exclude, /\.devharmonics\//);

      const after = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null;
      assert.equal(after, before, "tracked .gitignore content/absence must be unchanged");

      assertWorktreeHygiene(repo, result.runId);
    } finally {
      for (const d of [repo, providerDir]) rmSync(d, { recursive: true, force: true });
    }
  }

  await runCase(false, "excl-without");
  await runCase(true, "excl-with");
});

// ---------------------------------------------------------------------------
// 9. runCommandCli exit codes (real subprocess)
// ---------------------------------------------------------------------------

test("cli run: integrated pipeline exits 0", () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("fix");
  const tampercheckDir = fakeTampercheckDir("clean");
  try {
    const run = spawnSync(process.execPath, [
      CLI, "run",
      "--repository", repo,
      "--prompt", "fix add()",
      "--provider", "codex",
      "--model", "fake-model-9b",
      "--check", "node check.mjs",
      "--task-id", "cliok1",
      "--timeout-minutes", "0.5",
      "--json",
    ], { encoding: "utf8", timeout: 60_000, env: buildEnv(providerDir, tampercheckDir) });

    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.integrated, true, JSON.stringify(result));
    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir, tampercheckDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("cli run: refused pipeline exits 1", () => {
  const repo = initFixtureRepo();
  const providerDir = fakeProviderDir("noop");
  try {
    const run = spawnSync(process.execPath, [
      CLI, "run",
      "--repository", repo,
      "--prompt", "do nothing",
      "--provider", "codex",
      "--model", "fake-model-9b",
      "--task-id", "clirefuse1",
      "--timeout-minutes", "0.5",
      "--json",
    ], { encoding: "utf8", timeout: 60_000, env: buildEnv(providerDir) });

    assert.equal(run.status, 1, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.integrated, false, JSON.stringify(result));
    assert.equal(result.reason, "worker-empty-diff");
    assertWorktreeHygiene(repo, result.runId);
  } finally {
    for (const d of [repo, providerDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("cli run: missing required flag exits 2", () => {
  const run = spawnSync(process.execPath, [CLI, "run", "--provider", "codex"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 2, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /--repository and --prompt are required/);
});

test("cli run: bad provider exits 2", () => {
  const run = spawnSync(process.execPath, [
    CLI, "run",
    "--repository", "does/not/matter",
    "--prompt", "hello",
    "--provider", "not-a-real-provider",
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 2, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /--provider must be one of/);
});
