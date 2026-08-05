import process from "node:process";
import { loadConfig, projectConfigPath } from "./config.mjs";

/**
 * CLI surface for configuration itself (ported UX intent from
 * devharmonics-v1, per the owner's audience ruling: a technical product
 * manager, not a programmer). There is deliberately NO `init` subcommand —
 * the config file materializes by itself the first time any command touches
 * a project (v1's `initializeProject` pattern); this command exists so an
 * operator can SEE what is in effect and where it came from without reading
 * source code.
 *
 *   devharmonics config show [--config <file>] [--json]
 *   devharmonics config path
 *
 * `show` resolves exactly the way every other command does (explicit
 * --config > the current directory's .devharmonics/config.json, created now
 * if absent > built-in defaults) and prints the effective configuration
 * with its source. Safe to print in full: the config stores environment
 * VARIABLE NAMES for credentials, never credential values.
 */
export async function configCommand(argv, { write = (text) => { process.stdout.write(text); } } = {}) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "path") {
    write(`${projectConfigPath(process.cwd())}\n`);
    return 0;
  }
  if (subcommand !== "show") {
    throw new Error(`Unknown config subcommand: ${subcommand ?? "(none)"} — use "config show" or "config path"`);
  }
  let configPath = null;
  let asJson = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--json") asJson = true;
    else if (rest[i] === "--config") { configPath = rest[i + 1]; i += 1; }
    else throw new Error(`Unknown config show option: ${rest[i]}`);
  }
  const { config, source, created } = loadConfig(configPath, { projectPath: process.cwd() });
  if (asJson) {
    write(`${JSON.stringify({ configSource: source, created, config }, null, 2)}\n`);
    return 0;
  }
  write(`config source: ${source}${created ? " (created now with the defaults — edit it to change endpoints and budgets)" : ""}\n\n`);
  write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}
