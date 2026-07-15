import path from "node:path";
import { realpath } from "node:fs/promises";
import type { CheckResult, ValidatorConfig } from "./types.js";
import { runProcess } from "./process.js";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
