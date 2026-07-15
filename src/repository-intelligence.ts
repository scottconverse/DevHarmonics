import { stat } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessResult } from "./process.js";

export type RepositoryCompatibilityIssueCode =
  | "missing_directory"
  | "not_directory"
  | "not_git_repository"
  | "git_inspection_failed"
  | "remote_mismatch"
  | "current_branch_mismatch"
  | "default_branch_mismatch"
  | "merge_in_progress"
  | "rebase_in_progress";

export interface RepositoryCompatibilityIssue {
  code: RepositoryCompatibilityIssueCode;
  message: string;
}

export interface RepositoryStatusSummary {
  entries: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
}

export interface RepositoryInspectionOptions {
  expectedRemoteUrl?: string;
  expectedCurrentBranch?: string;
  expectedDefaultBranch?: string;
}

export interface RepositoryInspection {
  resolvedPath: string;
  isGitRepository: boolean;
  gitRoot: string | null;
  repositoryName: string | null;
  currentBranch: string | null;
  detached: boolean;
  headSha: string | null;
  originRemoteUrl: string | null;
  defaultBranch: string | null;
  dirty: boolean;
  status: RepositoryStatusSummary;
  issues: RepositoryCompatibilityIssue[];
}

const EMPTY_STATUS: RepositoryStatusSummary = {
  entries: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  added: 0,
  modified: 0,
  deleted: 0,
  renamed: 0,
  copied: 0,
};

export async function inspectLocalRepository(
  directory: string,
  options: RepositoryInspectionOptions = {},
): Promise<RepositoryInspection> {
  const resolvedPath = path.resolve(directory);
  const unavailable = (issue: RepositoryCompatibilityIssue): RepositoryInspection => ({
    resolvedPath,
    isGitRepository: false,
    gitRoot: null,
    repositoryName: null,
    currentBranch: null,
    detached: false,
    headSha: null,
    originRemoteUrl: null,
    defaultBranch: null,
    dirty: false,
    status: { ...EMPTY_STATUS },
    issues: [issue],
  });

  let directoryStats;
  try {
    directoryStats = await stat(resolvedPath);
  } catch (error) {
    const details = error instanceof Error ? ` (${error.message})` : "";
    return unavailable({
      code: "missing_directory",
      message: `Repository directory does not exist: ${resolvedPath}${details}`,
    });
  }
  if (!directoryStats.isDirectory()) {
    return unavailable({ code: "not_directory", message: `Repository path is not a directory: ${resolvedPath}` });
  }

  const rootResult = await git(resolvedPath, ["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) {
    return unavailable({
      code: "not_git_repository",
      message: `Directory is not inside a Git repository: ${resolvedPath}`,
    });
  }

  const gitRoot = path.resolve(rootResult.stdout.trim());
  const [head, branch, remote, defaultBranchResult, statusResult] = await Promise.all([
    git(gitRoot, ["rev-parse", "HEAD"]),
    git(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(gitRoot, ["remote", "get-url", "origin"]),
    git(gitRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    git(gitRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);

  if (head.exitCode !== 0 || !head.stdout.trim() || statusResult.exitCode !== 0) {
    const details = firstError(head, statusResult);
    return unavailable({
      code: "git_inspection_failed",
      message: `Could not read repository state at ${gitRoot}: ${details}`,
    });
  }

  const currentBranch = branch.exitCode === 0 ? branch.stdout.trim() || null : null;
  const originRemoteUrl = remote.exitCode === 0 ? remote.stdout.trim() || null : null;
  const remoteDefault = defaultBranchResult.exitCode === 0
    ? defaultBranchResult.stdout.trim().replace(/^origin\//, "") || null
    : null;
  const defaultBranch = remoteDefault ?? await inferLocalDefaultBranch(gitRoot);
  const status = parsePorcelainStatus(statusResult.stdout);
  const operationIssues = await inspectInterruptedOperations(gitRoot);
  const issues: RepositoryCompatibilityIssue[] = [];

  if (options.expectedRemoteUrl && !sameRemote(originRemoteUrl, options.expectedRemoteUrl)) {
    issues.push({
      code: "remote_mismatch",
      message: `Expected origin ${options.expectedRemoteUrl}, found ${originRemoteUrl ?? "no origin remote"}.`,
    });
  }
  if (options.expectedCurrentBranch && currentBranch !== options.expectedCurrentBranch) {
    issues.push({
      code: "current_branch_mismatch",
      message: `Expected current branch ${options.expectedCurrentBranch}, found ${currentBranch ?? "detached HEAD"}.`,
    });
  }
  if (options.expectedDefaultBranch && defaultBranch !== options.expectedDefaultBranch) {
    issues.push({
      code: "default_branch_mismatch",
      message: `Expected default branch ${options.expectedDefaultBranch}, found ${defaultBranch ?? "no inferred default"}.`,
    });
  }
  issues.push(...operationIssues);

  return {
    resolvedPath,
    isGitRepository: true,
    gitRoot,
    repositoryName: path.basename(gitRoot),
    currentBranch,
    detached: currentBranch === null,
    headSha: head.stdout.trim(),
    originRemoteUrl,
    defaultBranch,
    dirty: status.entries > 0,
    status,
    issues,
  };
}

async function git(cwd: string, args: string[]): Promise<ProcessResult> {
  return runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
}

function firstError(...results: ProcessResult[]): string {
  for (const result of results) {
    const detail = result.stderr.trim() || result.stdout.trim();
    if (result.exitCode !== 0 && detail) return detail;
  }
  return "Git returned an incomplete result";
}

async function inferLocalDefaultBranch(gitRoot: string): Promise<string | null> {
  for (const candidate of ["main", "master", "trunk"]) {
    const result = await git(gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (result.exitCode === 0) return candidate;
  }
  return null;
}

async function inspectInterruptedOperations(gitRoot: string): Promise<RepositoryCompatibilityIssue[]> {
  const candidates = [
    { path: "MERGE_HEAD", code: "merge_in_progress" as const, message: "Repository has an unresolved merge." },
    { path: "rebase-merge", code: "rebase_in_progress" as const, message: "Repository has an unresolved rebase." },
    { path: "rebase-apply", code: "rebase_in_progress" as const, message: "Repository has an unresolved rebase." },
  ];
  const issues: RepositoryCompatibilityIssue[] = [];
  for (const candidate of candidates) {
    const resolved = await git(gitRoot, ["rev-parse", "--git-path", candidate.path]);
    if (resolved.exitCode !== 0 || !resolved.stdout.trim()) continue;
    const operationPath = path.isAbsolute(resolved.stdout.trim())
      ? resolved.stdout.trim()
      : path.resolve(gitRoot, resolved.stdout.trim());
    try {
      await stat(operationPath);
      if (!issues.some((issue) => issue.code === candidate.code)) {
        issues.push({ code: candidate.code, message: candidate.message });
      }
    } catch {
      // An absent operation marker is the expected, clean state.
    }
  }
  return issues;
}

function sameRemote(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  return normalizeRemote(actual) === normalizeRemote(expected);
}

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1]?.toLowerCase()}/${scp[2]?.replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(trimmed);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+/, "")}`;
  } catch {
    return trimmed;
  }
}

function parsePorcelainStatus(output: string): RepositoryStatusSummary {
  const summary = { ...EMPTY_STATUS };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    summary.entries += 1;
    if (x === "?" && y === "?") {
      summary.untracked += 1;
      continue;
    }
    if (x !== " " && x !== "?") summary.staged += 1;
    if (y !== " " && y !== "?") summary.unstaged += 1;
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${x}${y}`)) summary.conflicted += 1;
    if (x === "A" || y === "A") summary.added += 1;
    if (x === "M" || y === "M") summary.modified += 1;
    if (x === "D" || y === "D") summary.deleted += 1;
    if (x === "R" || y === "R") summary.renamed += 1;
    if (x === "C" || y === "C") summary.copied += 1;
    if (["R", "C"].includes(x) || ["R", "C"].includes(y)) index += 1;
  }
  return summary;
}
