#!/usr/bin/env node
import process from "node:process";
import { doctorCommand } from "./doctor.mjs";

const USAGE = `Usage:
  devharmonics doctor [--json] [--config <file>]
  devharmonics qualify [--execute] [--json] [--lane L] [--role R] [--skip-current]
  devharmonics onboard <repo> [--apply] [--force] [--json]
  devharmonics run --repository <repo> --prompt <text> --provider <p>
                   [--model m] [--check "cmd args"] [--task-id t]
                   [--lane subprocess|http|acp] [--files a,b,c]
                   [--adapter <cmd>] [--base-url <url>] [--json]
  devharmonics worker --provider <codex|claude|agy> --prompt <text> --cwd <dir>
                      [--model <id>] [--task-id <id>] [--runs-root <dir>]
                      [--sandbox read-only|workspace-write]
                      [--permission-mode <mode>] [--allowed-tools a,b,c]
                      [--timeout-minutes <n>] [--json]
  devharmonics acp --prompt <text> --cwd <dir> [--adapter <cmd>]
                   [--task-id <id>] [--runs-root <dir>]
                   [--permission-mode deny|allow-edits]
                   [--timeout-minutes <n>] [--json]
  devharmonics set --member "<repositoryId>=<repoPath>:<workerBranch>" (2+)
                   [--base "<repositoryId>=<ref>"] [--evidence-root <dir>]
                   [--json]

Commands:
  doctor   Probe every capability the factory depends on and report
           PASS/FAIL/SKIPPED per check. Exit 0 = assessment completed
           (FAILs included); exit 2 = doctor itself could not run.
  worker   Run ONE bounded subprocess-lane worker and leave a receipt.
           Exit 0 = completed; 1 = failed or timeout; 2 = runner error.
  acp      Run ONE bounded ACP-lane worker (Agent Client Protocol over
           stdio) and leave a receipt. Exit 0 = completed; 1 = failed or
           timeout; 2 = runner error.
  qualify  Plan (default) or --execute the qualification sweep: every
           discovered candidate x applicable role, real harnesses, every
           result appended to qualifications.jsonl pass or fail.
  onboard  Make a repository governed: install the pinned tampercheck CI
           workflow and the private state exclude. Dry run by default;
           --apply writes. Idempotent; --force rewrites a differing pin.
  run      One bounded task through the full pipeline: clean-tree intake,
           isolated worker (subprocess, http, or acp lane), optional
           --check validator, empty-diff + tampercheck gates, serial
           integration — then STOP at the owner approval boundary.
           Exit 0 = integrated; 1 = refused; 2 = error.
  set      Plan and integrate a cross-repo integration SET: one worker
           branch per repository, judged all-or-nothing. Exit 0 = every
           member integrated; 1 = the set was blocked; 2 = runner error.`;

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
  if (command === "acp") {
    const { acpCommand } = await import("./acp-command.mjs");
    return acpCommand(rest);
  }
  if (command === "set") {
    const { setCommand } = await import("./set-command.mjs");
    return setCommand(rest);
  }
  if (command === "qualify") {
    const { qualifyCommand } = await import("./qualify-command.mjs");
    return qualifyCommand(rest);
  }
  if (command === "run") {
    const { runCommandCli } = await import("./run-command.mjs");
    return runCommandCli(rest);
  }
  if (command === "onboard") {
    const { onboardCommand } = await import("./onboard-command.mjs");
    return onboardCommand(rest);
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
