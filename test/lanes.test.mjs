import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { runPipeline } from "../scripts/run-command.mjs";
import { acpCommand } from "../scripts/acp-command.mjs";
import { setCommand } from "../scripts/set-command.mjs";
import { createReceipt, writeReceipt } from "../scripts/receipts.mjs";

/**
 * Hermetic coverage for the http/acp lanes (scripts/run-command.mjs), the
 * new acp/set CLI commands, and the injectable `deps` option that makes all
 * of this testable without a real AI CLI, a real ACP adapter, or a real
 * network call. No real AI is ever involved:
 *   - the "AI" side of each lane (sendMessages / runWorker / runAcpWorker)
 *     is a plain injected stub function;
 *   - everything downstream of that (git worktrees, commits, the
 *     empty-diff + tampercheck gates, the merge) is REAL — faking it would
 *     test nothing (precedent: test/integrate.test.mjs, test/pipeline.test.mjs).
 * The fake-tampercheck-on-PATH pattern is ported from test/integrate.test.mjs
 * and test/integration-set.test.mjs (test files in this repo duplicate small
 * fixtures rather than share them — see test/local-patch.test.mjs vs
 * test/integrate.test.mjs for the same precedent).
 */

// --- generic git/repo helpers -----------------------------------------------

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
  const dir = tempDir("dh-lanes-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "file.txt"), "ORIGINAL\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function branchTrippingTampercheck(dir, branchName, base, fileContent) {
  git(dir, ["branch", branchName, base]);
  const wt = tempDir("dh-lanes-authorwt-");
  git(dir, ["worktree", "add", "-q", wt, branchName]);
  writeFileSync(path.join(wt, "file.txt"), fileContent);
  writeFileSync(path.join(wt, "TRIGGER_FINDINGS.txt"), "trip the fake tampercheck\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `advance ${branchName}`]);
  git(dir, ["worktree", "remove", "--force", wt]);
  return git(dir, ["rev-parse", branchName]).trim();
}

function branchFrom(dir, branchName, base, fileContent) {
  git(dir, ["branch", branchName, base]);
  const wt = tempDir("dh-lanes-authorwt-");
  git(dir, ["worktree", "add", "-q", wt, branchName]);
  writeFileSync(path.join(wt, "file.txt"), fileContent);
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", `advance ${branchName}`]);
  git(dir, ["worktree", "remove", "--force", wt]);
  return git(dir, ["rev-parse", branchName]).trim();
}

function worktreeCount(repo) {
  return git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;
}

// --- fake tampercheck fixtures (ported from test/integrate.test.mjs /
// test/integration-set.test.mjs) --------------------------------------------

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

/** Verdict depends on a TRIGGER_FINDINGS.txt marker in the worktree cwd
 * tampercheck runs in, not on which env/PATH is active — needed because a
 * whole integrateSet call shares ONE env/PATH across every member. */
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
  const separator = process.platform === "win32" ? ";" : ":";
  const existing = process.env.PATH ?? process.env.Path ?? "";
  const merged = `${dir}${separator}${existing}`;
  return { ...process.env, PATH: merged, Path: merged, PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" };
}

function withHarness(n, fn) {
  if (typeof n === "function") { fn = n; n = 1; }
  const repos = Array.from({ length: n }, () => initRepo());
  const fixtureDir = tempDir("dh-lanes-fixtures-");
  const env = pathOnlyEnv(fixtureDir);
  return (async () => {
    try {
      await fn({ repos, repo: repos[0], fixtureDir, env });
    } finally {
      for (const d of [...repos, fixtureDir]) rmSync(d, { recursive: true, force: true });
    }
  })();
}

// --- fake AI-side stubs ------------------------------------------------------

/** A fake for deps.sendMessages (the http lane's client): returns a valid
 * structured-patch response matching test/local-patch.test.mjs's own stub
 * shape ({ok, contentText, usage, resolvedModel}). */
const fakeSendMessages = async () => ({
  ok: true,
  contentText: JSON.stringify({ files: [{ path: "file.txt", content: "FIXED\n" }] }),
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  resolvedModel: "fake-http-model-resolved",
});

/** A fake for deps.runWorker / deps.runAcpWorker: optionally writes a real
 * file into cwd (like a real agent editing the worktree it was given), then
 * returns a real, schema-valid receipt via the real receipts.mjs helpers —
 * so "every attempt leaves a receipt" holds even for the fake. */
function fakeReceiptWorker({ lane, writeFile = null, status = "completed" }) {
  return async ({ cwd, runsRoot, taskId }) => {
    if (status === "completed" && writeFile) {
      writeFileSync(path.join(cwd, writeFile.name), writeFile.content);
    }
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const receipt = createReceipt({
      taskId,
      lane,
      provider: "fake-provider",
      requestedModel: "fake-model",
      resolvedModel: status === "completed" ? "fake-model-resolved" : null,
      resolutionVerified: status === "completed",
      prompt: "fake prompt",
      startedAt,
      finishedAt,
      durationMs: 5,
      status,
      exit: { code: status === "completed" ? 0 : 1, timedOut: false, error: status === "completed" ? null : "fake failure" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const runDir = writeReceipt(runsRoot, receipt);
    return { receipt, runDir, events: [], permissionRequests: [] };
  };
}

// ---------------------------------------------------------------------------
// 1. runPipeline: http lane
// ---------------------------------------------------------------------------

test("runPipeline http lane: injected sendMessages -> local-patch commit -> real integration", () => withHarness(async ({ repo, fixtureDir, env }) => {
  fakeClean(fixtureDir);

  const result = await runPipeline({
    repository: repo,
    prompt: "replace ORIGINAL with FIXED",
    provider: "ollama",
    model: "test-model",
    lane: "http",
    files: ["file.txt"],
    check: "node --version",
    baseUrl: "http://127.0.0.1:9",
    taskId: "http-happy-1",
    env,
    deps: { sendMessages: fakeSendMessages },
  });

  assert.equal(result.integrated, true, JSON.stringify(result));
  assert.equal(result.reason, "ready-for-owner-review");
  assert.equal(result.stages.worker.status, "completed");
  assert.ok(result.integrationHead, "expected an integration head commit");

  // Receipt/evidence chain: the local-patch receipt and the integration
  // evidence bundle both really exist on disk.
  assert.ok(existsSync(result.evidenceRoot), "evidenceRoot must exist");
  assert.ok(existsSync(path.join(result.stages.worker.receiptDir, "receipt.json")), "worker (local-patch) receipt must exist");
  assert.ok(existsSync(result.stages.integration.evidencePath), "integration evidence bundle must exist");

  // The fix really landed on the integration branch.
  const content = git(repo, ["show", `${result.integrationBranch}:file.txt`]);
  assert.equal(content, "FIXED\n");

  // local-patch's own leftover worktree was cleaned up by the pipeline.
  assert.equal(worktreeCount(repo), 1, "no leftover worktrees after an http-lane run");
}));

// ---------------------------------------------------------------------------
// 2. runPipeline: acp lane
// ---------------------------------------------------------------------------

test("runPipeline acp lane: injected runAcpWorker writes a file -> pipeline commits and integrates it", () => withHarness(async ({ repo, fixtureDir, env }) => {
  fakeClean(fixtureDir);
  const fakeRunAcpWorker = fakeReceiptWorker({
    lane: "acp",
    writeFile: { name: "acp-output.txt", content: "ACP WROTE THIS\n" },
  });

  const result = await runPipeline({
    repository: repo,
    prompt: "do it over ACP",
    provider: "claude",
    lane: "acp",
    adapterCommand: "unused-fake-adapter",
    taskId: "acp-happy-1",
    env,
    deps: { runAcpWorker: fakeRunAcpWorker },
  });

  assert.equal(result.integrated, true, JSON.stringify(result));
  assert.equal(result.reason, "ready-for-owner-review");
  assert.equal(result.stages.worker.status, "completed");

  const content = git(repo, ["show", `${result.integrationBranch}:acp-output.txt`]);
  assert.equal(content, "ACP WROTE THIS\n");

  assert.equal(worktreeCount(repo), 1, "no leftover worktrees after an acp-lane run");
}));

// ---------------------------------------------------------------------------
// 3. Validation: unknown lane / http lane without --files
// ---------------------------------------------------------------------------

test("runPipeline: unknown lane -> named throw", () => withHarness(async ({ repo }) => {
  await assert.rejects(
    () => runPipeline({ repository: repo, prompt: "p", provider: "claude", lane: "carrier-pigeon" }),
    /lane must be one of/,
  );
}));

test("runPipeline: http lane without --files -> named throw", () => withHarness(async ({ repo }) => {
  await assert.rejects(
    () => runPipeline({ repository: repo, prompt: "p", provider: "ollama", lane: "http" }),
    /http lane requires a non-empty files list/,
  );
  await assert.rejects(
    () => runPipeline({ repository: repo, prompt: "p", provider: "ollama", lane: "http", files: [] }),
    /http lane requires a non-empty files list/,
  );
}));

// ---------------------------------------------------------------------------
// 4. acpCommand (CLI wrapper), injected fake runAcpWorker
// ---------------------------------------------------------------------------

test("acpCommand: injected fake runAcpWorker completes -> exit 0, prints status/events/permissions/receipt", async () => {
  const runsRoot = tempDir("dh-lanes-acpcmd-runs-");
  const cwd = tempDir("dh-lanes-acpcmd-cwd-");
  try {
    let output = "";
    const fakeRunAcpWorker = async ({ runsRoot: rr, taskId }) => {
      const receipt = createReceipt({
        taskId, lane: "acp", provider: "acp", requestedModel: "adapter-default",
        resolvedModel: "fake-model", resolutionVerified: true, prompt: "do it",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 5,
        status: "completed", exit: { code: 0, timedOut: false, error: null },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      const runDir = writeReceipt(rr, receipt);
      return { receipt, runDir, events: [{ type: "a" }, { type: "b" }], permissionRequests: [{ kind: "edit" }] };
    };

    const code = await acpCommand(
      ["--prompt", "do it", "--cwd", cwd, "--runs-root", runsRoot, "--task-id", "acp-fake-1"],
      { write: (t) => { output += t; }, deps: { runAcpWorker: fakeRunAcpWorker } },
    );

    assert.equal(code, 0);
    assert.match(output, /status:\s+completed/);
    assert.match(output, /events:\s+2/);
    assert.match(output, /permissions:\s+1 request/);
    assert.match(output, /receipt:\s+.*receipt\.json/);
  } finally {
    for (const d of [runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("acpCommand: injected fake runAcpWorker fails -> exit 1", async () => {
  const runsRoot = tempDir("dh-lanes-acpcmd-runs-");
  const cwd = tempDir("dh-lanes-acpcmd-cwd-");
  try {
    let output = "";
    const fakeRunAcpWorker = async ({ runsRoot: rr, taskId }) => {
      const receipt = createReceipt({
        taskId, lane: "acp", provider: "acp", requestedModel: "adapter-default",
        resolvedModel: null, resolutionVerified: false, prompt: "do it",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 5,
        status: "failed", exit: { code: null, timedOut: false, error: "fake adapter crashed" },
        usage: null,
      });
      const runDir = writeReceipt(rr, receipt);
      return { receipt, runDir, events: [], permissionRequests: [] };
    };

    const code = await acpCommand(
      ["--prompt", "do it", "--cwd", cwd, "--runs-root", runsRoot, "--task-id", "acp-fake-2"],
      { write: (t) => { output += t; }, deps: { runAcpWorker: fakeRunAcpWorker } },
    );

    assert.equal(code, 1);
    assert.match(output, /status:\s+failed/);
    assert.match(output, /error:\s+fake adapter crashed/);
  } finally {
    for (const d of [runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("acpCommand: bad flag / missing required flag -> throws (the exit-2 path is cli.mjs's job)", async () => {
  await assert.rejects(() => acpCommand(["--not-a-real-flag"]), /Unknown acp option/);
  await assert.rejects(() => acpCommand([]), /--prompt and --cwd are required/);
  await assert.rejects(
    () => acpCommand(["--prompt", "p", "--cwd", ".", "--permission-mode", "bogus"]),
    /--permission-mode must be/,
  );
});

// ---------------------------------------------------------------------------
// 5. setCommand (CLI wrapper), real integration-set + fake tampercheck
// ---------------------------------------------------------------------------

test("setCommand: two clean repos -> exit 0, setReady true printed", async () => {
  const fixtureDir = tempDir("dh-lanes-setcmd-fixtures-");
  const evidenceRoot = tempDir("dh-lanes-setcmd-evidence-");
  const repoA = initRepo();
  const repoB = initRepo();
  try {
    fakeClean(fixtureDir);
    branchFrom(repoA, "worker-a", "main", "line1\nCHANGED-A\n");
    branchFrom(repoB, "worker-b", "main", "line1\nCHANGED-B\n");

    let output = "";
    const code = await setCommand(
      [
        "--member", `repoA=${repoA}:worker-a`,
        "--member", `repoB=${repoB}:worker-b`,
        "--evidence-root", evidenceRoot,
      ],
      { write: (t) => { output += t; }, env: pathOnlyEnv(fixtureDir) },
    );

    assert.equal(code, 0, output);
    assert.match(output, /set:\s+READY/);
    assert.match(output, /repoA/);
    assert.match(output, /repoB/);
    assert.ok(existsSync(path.join(evidenceRoot, "set.json")));
  } finally {
    for (const d of [fixtureDir, evidenceRoot, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  }
});

test("setCommand: one member trips tampercheck -> exit 1, blockedBy printed", async () => {
  const fixtureDir = tempDir("dh-lanes-setcmd-fixtures-");
  const evidenceRoot = tempDir("dh-lanes-setcmd-evidence-");
  const repoA = initRepo();
  const repoB = initRepo();
  try {
    fakeConditional(fixtureDir);
    branchFrom(repoA, "worker-a", "main", "line1\nCHANGED-A\n"); // clean: no trigger file
    branchTrippingTampercheck(repoB, "worker-b", "main", "line1\nCHANGED-B\n"); // trips findings

    let output = "";
    const code = await setCommand(
      [
        "--member", `repoA=${repoA}:worker-a`,
        "--member", `repoB=${repoB}:worker-b`,
        "--evidence-root", evidenceRoot,
      ],
      { write: (t) => { output += t; }, env: pathOnlyEnv(fixtureDir) },
    );

    assert.equal(code, 1, output);
    assert.match(output, /set:\s+NOT READY/);
    assert.match(output, /blockedBy:\s+repoB/);
  } finally {
    for (const d of [fixtureDir, evidenceRoot, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  }
});

test("setCommand: fewer than 2 --member -> throws", async () => {
  await assert.rejects(
    () => setCommand(["--member", "repoA=/tmp/x:branch"]),
    /at least twice/,
  );
});

test("setCommand: malformed --member -> throws", async () => {
  await assert.rejects(
    () => setCommand(["--member", "no-equals-sign", "--member", "repoB=/tmp/y:branch"]),
    /--member must be/,
  );
});

// ---------------------------------------------------------------------------
// 6. Existing behavior unchanged: lane "subprocess" (default) with injected deps.runWorker
// ---------------------------------------------------------------------------

test("runPipeline: lane subprocess (default) with injected deps.runWorker still integrates exactly as before", () => withHarness(async ({ repo, fixtureDir, env }) => {
  fakeClean(fixtureDir);
  const fakeRunWorker = fakeReceiptWorker({
    lane: "subprocess",
    writeFile: { name: "subprocess-output.txt", content: "SUBPROCESS WROTE THIS\n" },
  });

  const result = await runPipeline({
    repository: repo,
    prompt: "do it over subprocess",
    provider: "codex",
    taskId: "subproc-regress-1",
    env,
    deps: { runWorker: fakeRunWorker },
  });

  assert.equal(result.integrated, true, JSON.stringify(result));
  assert.equal(result.reason, "ready-for-owner-review");
  assert.equal(result.stages.worker.status, "completed");

  const content = git(repo, ["show", `${result.integrationBranch}:subprocess-output.txt`]);
  assert.equal(content, "SUBPROCESS WROTE THIS\n");

  assert.equal(worktreeCount(repo), 1, "no leftover worktrees after a subprocess-lane run");
}));
