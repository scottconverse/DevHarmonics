import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalPatch } from "../scripts/local-patch.mjs";

/**
 * Real git repos in temp dirs (like test/run-worker.test.mjs's real fake
 * codex — here the thing under test IS git plumbing, so faking it would
 * test nothing). No real model is ever involved: `client` is a plain stub
 * function per test, matching the injected sendMessages shape
 * ({baseUrl, model, system, messages, maxTokens, timeoutMs}) -> {ok, ...}.
 */

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

function initRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-lp-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(dir, "file.txt"), "ORIGINAL\n");
  writeFileSync(path.join(dir, "other.txt"), "unrelated\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function headOf(dir) {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function baseTask(repository, overrides = {}) {
  return {
    taskId: "fix-file",
    repository,
    base: "HEAD",
    model: "stub-model-1",
    baseUrl: "http://127.0.0.1:9",
    instructions: "Replace the marker text with FIXED.",
    readPaths: ["file.txt"],
    writePaths: ["file.txt"],
    check: {
      command: "node",
      args: ["-e", "if (!require('fs').readFileSync('file.txt','utf8').includes('FIXED')) process.exit(1)"],
    },
    commitMessage: "apply local patch",
    ...overrides,
  };
}

function withTemps(fn) {
  const repo = initRepo();
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-lp-runs-"));
  return (async () => {
    try {
      await fn({ repo, runsRoot });
    } finally {
      for (const d of [repo, runsRoot]) rmSync(d, { recursive: true, force: true });
    }
  })();
}

function readReceipt(runDir) {
  return JSON.parse(readFileSync(path.join(runDir, "receipt.json"), "utf8"));
}

test("happy path: valid JSON fix, check passes, committed, user checkout untouched", () => withTemps(async ({ repo, runsRoot }) => {
  const originalHead = headOf(repo);
  const client = async () => ({
    ok: true,
    contentText: JSON.stringify({ files: [{ path: "file.txt", content: "FIXED\n" }] }),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    resolvedModel: "stub-model-1-resolved",
  });

  const result = await runLocalPatch({ task: baseTask(repo), client, runsRoot });

  assert.equal(result.accepted, true);
  assert.equal(result.receipt.status, "completed");
  assert.ok(result.headCommit);
  assert.ok(result.worktreePath && existsSync(result.worktreePath));
  assert.equal(readFileSync(path.join(result.worktreePath, "file.txt"), "utf8"), "FIXED\n");
  assert.equal(git(result.worktreePath, ["rev-parse", "HEAD"]).trim(), result.headCommit);
  assert.ok(existsSync(path.join(result.runDir, "diff.patch")));
  assert.match(readFileSync(path.join(result.runDir, "diff.patch"), "utf8"), /FIXED/);
  const onDisk = readReceipt(result.runDir);
  assert.equal(onDisk.status, "completed");
  assert.equal(onDisk.resolvedModel, "stub-model-1-resolved");
  assert.equal(onDisk.resolutionVerified, true);
  assert.deepEqual(onDisk.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  // The user's own checkout (repo, not the worktree) must be untouched.
  assert.equal(headOf(repo), originalHead);
}));

test("model writes a path not in writePaths -> rejected, nothing committed", () => withTemps(async ({ repo, runsRoot }) => {
  const client = async () => ({
    ok: true,
    contentText: JSON.stringify({ files: [{ path: "not-allowed.txt", content: "sneaky\n" }] }),
  });

  const result = await runLocalPatch({ task: baseTask(repo), client, runsRoot });

  assert.equal(result.accepted, false);
  assert.equal(result.receipt.status, "failed");
  assert.match(result.detail.message, /not in writePaths/);
  assert.equal(result.headCommit, null);
  const onDisk = readReceipt(result.runDir);
  assert.equal(onDisk.status, "failed");
}));

test("path traversal in writePaths throws at validation, no worktree left behind", async () => {
  const repo = initRepo();
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-lp-runs-"));
  try {
    const client = async () => { throw new Error("must never be called"); };
    await assert.rejects(
      () => runLocalPatch({ task: baseTask(repo, { writePaths: ["../evil.txt"] }), client, runsRoot }),
      /traversal/,
    );
    // Only the main worktree should be registered — validation failed
    // before any `git worktree add` ever ran.
    const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
    assert.equal(worktrees.length, 1);
    assert.equal(readdirSync(runsRoot).length, 0, "no receipt should exist for a rejected task");
  } finally {
    for (const d of [repo, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test("model returns unchanged content -> empty-diff failure", () => withTemps(async ({ repo, runsRoot }) => {
  const client = async () => ({
    ok: true,
    contentText: JSON.stringify({ files: [{ path: "file.txt", content: "ORIGINAL\n" }] }),
  });

  const result = await runLocalPatch({ task: baseTask(repo), client, runsRoot });

  assert.equal(result.accepted, false);
  assert.equal(result.receipt.status, "failed");
  assert.match(result.detail.message, /unchanged content/);
  const onDisk = readReceipt(result.runDir);
  assert.equal(onDisk.status, "failed");
}));

test("check fails -> no commit, worktree retained, detail carries the exit code", () => withTemps(async ({ repo, runsRoot }) => {
  const client = async () => ({
    ok: true,
    contentText: JSON.stringify({ files: [{ path: "file.txt", content: "FIXED\n" }] }),
  });
  const task = baseTask(repo, { check: { command: "node", args: ["-e", "process.exit(1)"] } });

  const result = await runLocalPatch({ task, client, runsRoot });

  assert.equal(result.accepted, false);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.detail.exitCode, 1);
  assert.equal(result.headCommit, null);
  assert.ok(result.worktreePath && existsSync(result.worktreePath), "worktree kept for inspection");
  // No commit beyond the initial one made it into the worktree branch.
  assert.equal(git(result.worktreePath, ["log", "--oneline"]).trim().split("\n").length, 1);
  const onDisk = readReceipt(result.runDir);
  assert.equal(onDisk.status, "failed");
}));

test("client ok:false -> failed receipt, worktree cleaned up (no leftover ops)", () => withTemps(async ({ repo, runsRoot }) => {
  const client = async () => ({ ok: false, contentText: null, error: "upstream 500", usage: null, resolvedModel: null });

  const result = await runLocalPatch({ task: baseTask(repo), client, runsRoot });

  assert.equal(result.accepted, false);
  assert.equal(result.receipt.status, "failed");
  assert.match(result.detail.message, /client reported failure/);
  assert.equal(result.worktreePath, null, "worktree removed since nothing was ever written");
  // Only the main worktree should remain registered in the repo.
  const worktrees = git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean);
  assert.equal(worktrees.length, 1);
  const onDisk = readReceipt(result.runDir);
  assert.equal(onDisk.status, "failed");
}));

test("fenced ```json response is tolerated and parsed", () => withTemps(async ({ repo, runsRoot }) => {
  const body = JSON.stringify({ files: [{ path: "file.txt", content: "FIXED\n" }] });
  const client = async () => ({ ok: true, contentText: "```json\n" + body + "\n```" });

  const result = await runLocalPatch({ task: baseTask(repo), client, runsRoot });

  assert.equal(result.accepted, true);
  assert.equal(result.receipt.status, "completed");
  assert.ok(result.detail.parseNotes.some((note) => /fenced/.test(note)));
  const onDisk = readReceipt(result.runDir);
  assert.equal(onDisk.status, "completed");
}));

test("client throws -> failed receipt, not an unhandled rejection", () => withTemps(async ({ repo, runsRoot }) => {
  const client = async () => { throw new Error("network exploded"); };

  const result = await runLocalPatch({ task: baseTask(repo), client, runsRoot });

  assert.equal(result.accepted, false);
  assert.equal(result.receipt.status, "failed");
  assert.match(result.detail.message, /network exploded/);
  const onDisk = readReceipt(result.runDir);
  assert.equal(onDisk.status, "failed");
}));

test("model response is not valid JSON -> failed receipt, honest detail", () => withTemps(async ({ repo, runsRoot }) => {
  const client = async () => ({ ok: true, contentText: "not json at all" });

  const result = await runLocalPatch({ task: baseTask(repo), client, runsRoot });

  assert.equal(result.accepted, false);
  assert.equal(result.receipt.status, "failed");
  assert.match(result.detail.message, /not valid JSON/);
}));

test("absolute path in readPaths throws a named validation error", async () => {
  const repo = initRepo();
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-lp-runs-"));
  try {
    const client = async () => { throw new Error("must never be called"); };
    await assert.rejects(
      () => runLocalPatch({ task: baseTask(repo, { readPaths: ["C:\\Windows\\win.ini"] }), client, runsRoot }),
      /absolute/,
    );
  } finally {
    for (const d of [repo, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

test("check.command with a path separator is rejected at validation", async () => {
  const repo = initRepo();
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-lp-runs-"));
  try {
    const client = async () => { throw new Error("must never be called"); };
    await assert.rejects(
      () => runLocalPatch({ task: baseTask(repo, { check: { command: "sub/node", args: [] } }), client, runsRoot }),
      /bare executable name or an absolute path/,
    );
  } finally {
    for (const d of [repo, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});
