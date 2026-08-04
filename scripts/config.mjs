import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Factory configuration: operator-controlled endpoints, CLIs, and budgets.
 * Defaults describe this machine's known-good layout; a config file overrides
 * by deep merge. Validation fails closed — an invalid file is an error, never
 * a silent fallback to defaults.
 */
export function defaultConfig() {
  const home = os.homedir();
  return {
    version: 1,
    endpoints: {
      ollama: { baseUrl: "http://127.0.0.1:11434" },
      lmstudio: { baseUrl: "http://127.0.0.1:1234" },
      litellm: { baseUrl: "http://127.0.0.1:4000" },
    },
    clis: {
      codex: { command: "codex" },
      claude: { command: "claude" },
      agy: { command: "agy" },
    },
    rigor: {
      tampercheckCommand: "tampercheck",
      skillHosts: {
        claude: path.join(home, ".claude", "skills"),
        codex: path.join(home, ".codex", "skills"),
      },
      skillName: "dev-rigor-stack-lite",
    },
    budgets: { maxWorkerMinutes: 30 },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function validateConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ["config must be an object"] };
  if (config.version !== 1) errors.push("version must be 1");
  if (!isPlainObject(config.endpoints)) errors.push("endpoints must be an object");
  else {
    for (const [name, endpoint] of Object.entries(config.endpoints)) {
      if (!isPlainObject(endpoint) || typeof endpoint.baseUrl !== "string" || !/^https?:\/\//.test(endpoint.baseUrl)) {
        errors.push(`endpoints.${name}.baseUrl must be an http(s) URL`);
      }
    }
  }
  if (!isPlainObject(config.clis)) errors.push("clis must be an object");
  else {
    for (const [name, cli] of Object.entries(config.clis)) {
      if (!isPlainObject(cli) || typeof cli.command !== "string" || !cli.command.trim()) {
        errors.push(`clis.${name}.command must be a nonempty string`);
      }
    }
  }
  if (!isPlainObject(config.budgets) || !Number.isSafeInteger(config.budgets.maxWorkerMinutes) || config.budgets.maxWorkerMinutes <= 0) {
    errors.push("budgets.maxWorkerMinutes must be a positive integer");
  }
  return { ok: errors.length === 0, errors };
}

export function loadConfig(configPath = null) {
  const base = defaultConfig();
  if (!configPath) {
    return { config: base, source: "defaults" };
  }
  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) throw new Error(`Config file not found: ${resolved}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${resolved}: ${error.message}`);
  }
  const merged = deepMerge(base, parsed);
  const validation = validateConfig(merged);
  if (!validation.ok) {
    throw new Error(`Invalid config ${resolved}: ${validation.errors.join("; ")}`);
  }
  return { config: merged, source: resolved };
}
