import { lstat, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.js";
import type { DiffFileContext } from "./local-review.js";

export class WorkspaceIsolationError extends Error {
  constructor(message: string, readonly status: string) {
    super(message);
    this.name = "WorkspaceIsolationError";
  }
}

export class WorktreeManager {
  readonly root: string;
  readonly integrationPath: string;
  readonly integrationBranch: string;
  private mergeQueue: Promise<void> = Promise.resolve();
  private baseCommit: string | null = null;

  constructor(
    private readonly projectPath: string,
    private readonly runId: string,
  ) {
    const shortId = runId.slice(0, 8);
    this.root = path.join(os.tmpdir(), "devharmonics", runId);
    this.integrationPath = path.join(this.root, "integration");
    this.integrationBranch = `devharmonics/${shortId}`;
  }

  async initialize(): Promise<void> {
    const inside = await this.git(this.projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new Error("DevHarmonics requires the target project to be a Git repository");
    }
    const status = await this.git(this.projectPath, ["status", "--porcelain"]);
    if (status.stdout.trim()) {
      throw new Error("DevHarmonics requires a clean working tree before starting a parallel run");
    }
    const base = await this.git(this.projectPath, ["rev-parse", "HEAD"]);
    if (base.exitCode !== 0 || !base.stdout.trim()) {
      throw new Error(`Could not resolve the run base commit: ${base.stderr.trim() || "git rev-parse failed"}`);
    }
    this.baseCommit = base.stdout.trim();
    await mkdir(this.root, { recursive: true });
    const created = await this.git(this.projectPath, [
      "worktree",
      "add",
      "-b",
      this.integrationBranch,
      this.integrationPath,
      "HEAD",
    ]);
    if (created.exitCode !== 0) throw new Error(`Could not create integration worktree: ${created.stderr}`);
    await this.linkSharedDependencies(this.integrationPath);
  }

  async assertPrimaryClean(context: string): Promise<void> {
    const status = await this.git(this.projectPath, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.exitCode !== 0) {
      throw new WorkspaceIsolationError(
        `Could not verify the primary checkout ${context}: ${status.stderr.trim() || "git status failed"}`,
        status.stderr.trim(),
      );
    }
    const dirty = status.stdout.trim();
    if (dirty) {
      throw new WorkspaceIsolationError(
        `Workspace isolation breach ${context}: the primary checkout changed outside its isolated task worktree`,
        dirty,
      );
    }
  }

  async integrationDiffFiles(): Promise<DiffFileContext[]> {
    if (!this.baseCommit) throw new Error("Integration worktree has not been initialized");
    const range = `${this.baseCommit}..HEAD`;
    const names = await this.git(this.integrationPath, ["diff", "--name-only", range]);
    if (names.exitCode !== 0) {
      throw new Error(`Could not list integration changes: ${names.stderr.trim() || "git diff failed"}`);
    }
    const files = names.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const contexts: DiffFileContext[] = [];
    for (const file of files) {
      const diff = await this.git(this.integrationPath, ["diff", "--no-ext-diff", "--unified=2", range, "--", file]);
      if (diff.exitCode !== 0) {
        throw new Error(`Could not read integration diff for ${file}: ${diff.stderr.trim() || "git diff failed"}`);
      }
      contexts.push({ path: file, diff: diff.stdout });
    }
    return contexts;
  }

  async createTask(taskId: string): Promise<{ path: string; branch: string }> {
    const safeTaskId = taskId.replace(/[^a-z0-9_-]/gi, "-");
    const branch = `${this.integrationBranch}-task-${safeTaskId}`;
    const worktreePath = path.join(this.root, "tasks", safeTaskId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const created = await this.git(this.projectPath, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      this.integrationBranch,
    ]);
    if (created.exitCode !== 0) throw new Error(`Could not create task worktree: ${created.stderr}`);
    await this.linkSharedDependencies(worktreePath);
    return { path: worktreePath, branch };
  }

  async commitTask(worktreePath: string, taskId: string): Promise<boolean> {
    await this.git(worktreePath, ["add", "-A"]);
    const staged = await this.git(worktreePath, ["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 0) return false;
    const committed = await this.git(worktreePath, [
      "-c",
      "user.name=DevHarmonics",
      "-c",
      "user.email=devharmonics@local",
      "commit",
      "-m",
      `devharmonics: complete ${taskId}`,
    ]);
    if (committed.exitCode !== 0) throw new Error(`Could not commit task ${taskId}: ${committed.stderr}`);
    return true;
  }

  async mergeTask(branch: string, taskId: string): Promise<void> {
    const operation = this.mergeQueue.then(async () => {
      const merged = await this.git(this.integrationPath, [
        "-c",
        "user.name=DevHarmonics",
        "-c",
        "user.email=devharmonics@local",
        "merge",
        "--no-ff",
        branch,
        "-m",
        `devharmonics: merge ${taskId}`,
      ]);
      if (merged.exitCode !== 0) {
        await this.git(this.integrationPath, ["merge", "--abort"]);
        throw new Error(`Merge conflict for ${taskId}: ${merged.stderr || merged.stdout}`);
      }
    });
    this.mergeQueue = operation.catch(() => undefined);
    return operation;
  }

  private git(cwd: string, args: string[]) {
    return runProcess({ command: "git", args, cwd, timeoutMs: 120_000 });
  }

  private async linkSharedDependencies(worktreePath: string): Promise<void> {
    const source = path.join(this.projectPath, "node_modules");
    const destination = path.join(worktreePath, "node_modules");
    try {
      const sourceStats = await lstat(source);
      if (!sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) return;
    } catch {
      return;
    }
    try {
      await lstat(destination);
      return;
    } catch {
      await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
    }
  }
}
