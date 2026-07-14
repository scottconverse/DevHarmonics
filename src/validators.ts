import path from "node:path";
import type { CheckResult, ValidatorConfig } from "./types.js";
import { runProcess } from "./process.js";

export async function runValidator(
  name: string,
  config: ValidatorConfig,
  worktreePath: string,
): Promise<CheckResult> {
  const cwd = config.cwd ? path.resolve(worktreePath, config.cwd) : worktreePath;
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
