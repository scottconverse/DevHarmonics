import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "../src/process.js";
import { inspectLocalRepository } from "../src/repository-intelligence.js";

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

test("inspects repository identity, state, expectations, and interrupted operations without modifying it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-repository-intelligence-"));
  const repository = path.join(root, "product");
  const nested = path.join(repository, "src");
  try {
    await mkdir(nested, { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await writeFile(path.join(repository, "README.md"), "# Product\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, [
      "-c",
      "user.name=DevHarmonics Tests",
      "-c",
      "user.email=devharmonics-tests@local",
      "commit",
      "-m",
      "fixture",
    ]);
    await git(repository, ["remote", "add", "origin", "git@github.com:example/product.git"]);
    await git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await writeFile(path.join(repository, "README.md"), "# Changed Product\n", "utf8");
    await writeFile(path.join(repository, "untracked.txt"), "new\n", "utf8");

    const before = await runProcess({
      command: "git",
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd: repository,
      timeoutMs: 30_000,
    });
    const result = await inspectLocalRepository(nested, {
      expectedRemoteUrl: "https://github.com/other/product.git",
      expectedCurrentBranch: "release",
      expectedDefaultBranch: "trunk",
    });
    const after = await runProcess({
      command: "git",
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd: repository,
      timeoutMs: 30_000,
    });

    assert.equal(result.resolvedPath, path.resolve(nested));
    assert.equal(result.isGitRepository, true);
    assert.equal(result.gitRoot, path.resolve(repository));
    assert.equal(result.repositoryName, "product");
    assert.equal(result.currentBranch, "main");
    assert.equal(result.detached, false);
    assert.match(result.headSha ?? "", /^[0-9a-f]{40}$/);
    assert.equal(result.originRemoteUrl, "git@github.com:example/product.git");
    assert.equal(result.defaultBranch, "main");
    assert.equal(result.dirty, true);
    assert.deepEqual(result.status, {
      entries: 2,
      staged: 0,
      unstaged: 1,
      untracked: 1,
      conflicted: 0,
      added: 0,
      modified: 1,
      deleted: 0,
      renamed: 0,
      copied: 0,
    });
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["remote_mismatch", "current_branch_mismatch", "default_branch_mismatch"],
    );
    assert.equal(after.stdout, before.stdout, "inspection must not change repository state");

    const compatible = await inspectLocalRepository(repository, {
      expectedRemoteUrl: "https://github.com/example/product.git",
      expectedCurrentBranch: "main",
      expectedDefaultBranch: "main",
    });
    assert.deepEqual(compatible.issues, [], "equivalent SSH and HTTPS remotes should match");

    await git(repository, ["checkout", "--detach"]);
    const detached = await inspectLocalRepository(repository);
    assert.equal(detached.currentBranch, null);
    assert.equal(detached.detached, true);

    await writeFile(path.join(repository, ".git", "MERGE_HEAD"), `${result.headSha}\n`, "utf8");
    await mkdir(path.join(repository, ".git", "rebase-merge"));
    const interrupted = await inspectLocalRepository(repository);
    assert.deepEqual(
      interrupted.issues.map((issue) => issue.code),
      ["merge_in_progress", "rebase_in_progress"],
    );

    const plainDirectory = path.join(root, "plain");
    await mkdir(plainDirectory);
    const notGit = await inspectLocalRepository(plainDirectory);
    assert.equal(notGit.isGitRepository, false);
    assert.equal(notGit.issues[0]?.code, "not_git_repository");

    const missing = await inspectLocalRepository(path.join(root, "missing"));
    assert.equal(missing.isGitRepository, false);
    assert.equal(missing.issues[0]?.code, "missing_directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
