#!/usr/bin/env node
import process from "node:process";
import { doctorCommand } from "./doctor.mjs";

const USAGE = `Usage:
  devharmonics doctor [--json] [--config <file>]

Commands:
  doctor   Probe every capability the factory depends on and report
           PASS/FAIL/SKIPPED per check. Exit 0 = assessment completed
           (FAILs included); exit 2 = doctor itself could not run.`;

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
  throw new Error(`Unknown command: ${command}\n${USAGE}`);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`devharmonics error: ${error.message}\n`);
    process.exit(2);
  },
);
