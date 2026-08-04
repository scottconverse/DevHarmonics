#!/usr/bin/env node
import process from "node:process";
import { doctorCommand } from "./doctor.mjs";

const USAGE = `Usage:
  devharmonics doctor [--json] [--config <file>]
  devharmonics qualify [--execute] [--json] [--lane L] [--role R] [--skip-current]
  devharmonics run --repository <repo> --prompt <text> --provider <p>
                   [--model m] [--check "cmd args"] [--task-id t] [--json]
  devharmonics worker --provider <codex|claude|agy> --prompt <text> --cwd <dir>
                      [--model <id>] [--task-id <id>] [--runs-root <dir>]
                      [--sandbox read-only|workspace-write]
                      [--permission-mode <mode>] [--allowed-tools a,b,c]
                      [--timeout-minutes <n>] [--json]

Commands:
  doctor   Probe every capability the factory depends on and report
           PASS/FAIL/SKIPPED per check. Exit 0 = assessment completed
           (FAILs included); exit 2 = doctor itself could not run.
  worker   Run ONE bounded subprocess-lane worker and leave a receipt.
           Exit 0 = completed; 1 = failed or timeout; 2 = runner error.
  qualify  Plan (default) or --execute the qualification sweep: every
           discovered candidate x applicable role, real harnesses, every
           result appended to qualifications.jsonl pass or fail.
  run      One bounded task through the full pipeline: clean-tree intake,
           isolated worker, optional --check validator, empty-diff +
           tampercheck gates, serial integration — then STOP at the owner
           approval boundary. Exit 0 = integrated; 1 = refused; 2 = error.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    process.stdout.write(`devharmonics ${pkg.version}\n`);
    return 0;
  }
  if (command === "doctor") return doctorCommand(rest);
  if (command === "worker") {
    const { workerCommand } = await import("./worker-command.mjs");
    return workerCommand(rest);
  }
  if (command === "qualify") {
    const { qualifyCommand } = await import("./qualify-command.mjs");
    return qualifyCommand(rest);
  }
  if (command === "run") {
    const { runCommandCli } = await import("./run-command.mjs");
    return runCommandCli(rest);
  }
  throw new Error(`Unknown command: ${command}\n${USAGE}`);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`devharmonics error: ${error.message}\n`);
    process.exit(2);
  },
);
