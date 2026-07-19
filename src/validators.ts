import path from "node:path";
import { realpath } from "node:fs/promises";
import type { CheckResult, ValidatorConfig } from "./types.js";
import { runProcess } from "./process.js";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Expand the `${repoRoot}` token in validator commands and arguments.
 *
 * A validator that needs the repository's own toolchain — a venv interpreter, a
 * repo-local node_modules binary — cannot be written as a bare command (wrong or
 * missing on PATH) and must not be registered as an absolute machine path, which
 * breaks on every other machine. The token names the one thing every machine
 * agrees on: where the repository lives. It expands against the PRIMARY
 * repository root, never the task worktree, because per-machine toolchains are
 * gitignored and exist only in the primary checkout.
 *
 * A token with no root to expand against fails loudly: expanding to nothing or
 * to the worktree would silently run the wrong interpreter.
 */
export function expandValidatorTokens(
  validators: Record<string, ValidatorConfig>,
  repoRoot: string | null,
): Record<string, ValidatorConfig> {
  const expand = (value: string): string => {
    if (!value.includes("${repoRoot}")) return value;
    if (!repoRoot) throw new Error(`Validator references \${repoRoot} but no repository root is known: '${value}'`);
    return path.normalize(value.replaceAll("${repoRoot}", repoRoot));
  };
  return Object.fromEntries(
    Object.entries(validators).map(([name, config]) => [name, {
      ...config,
      command: expand(config.command),
      args: config.args.map(expand),
    }]),
  );
}

/**
 * The validator set for one repository in a multi-repository run: the project's
 * own (already-expanded) validators, overridden by the ledger's registered ones,
 * whose `${repoRoot}` means THAT repository's primary root. Extracted so the
 * override direction and expansion target are pinned by a test rather than
 * living inline in the run path.
 */
export function mergeRepositoryValidators(
  local: Record<string, ValidatorConfig>,
  registered: Record<string, ValidatorConfig>,
  repositoryLocalPath: string | null,
): Record<string, ValidatorConfig> {
  return { ...local, ...expandValidatorTokens(registered, repositoryLocalPath) };
}

export async function resolveValidatorCwd(config: ValidatorConfig, worktreePath: string): Promise<string> {
  const root = await realpath(worktreePath);
  const requested = path.resolve(root, config.cwd ?? ".");
  const cwd = await realpath(requested);
  if (!inside(root, cwd)) throw new Error("Validator working directory is outside the assigned worktree");
  return cwd;
}

export async function runValidator(
  name: string,
  config: ValidatorConfig,
  worktreePath: string,
): Promise<CheckResult> {
  const cwd = await resolveValidatorCwd(config, worktreePath);
  const result = await runProcess({
    command: config.command,
    args: config.args,
    cwd,
    timeoutMs: config.timeoutMs,
  });
  return {
    name,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}

export function unknownValidator(name: string): CheckResult {
  return {
    name,
    passed: false,
    exitCode: 2,
    stdout: "",
    stderr: `The architect requested unknown validator '${name}'. Add it to .devharmonics/config.json or revise the plan.`,
    durationMs: 0,
  };
}
