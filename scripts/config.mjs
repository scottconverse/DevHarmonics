import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    // Fan-out ceilings (owner decision D1): hard, fail-closed caps on worker
    // spawning per state root, within a rolling window. maxWorkerMinutes was
    // deleted (validated-but-never-read; --timeout-minutes is the real bound).
    budgets: {
      maxWorkers: 100,          // total workers admitted per window
      maxConcurrentWorkers: 3,  // live at once (slots.mjs allows 1..4)
      maxTotalTokens: 50_000_000, // cumulative reported tokens per window
      windowHours: 24,
      // PAID lane (v1 port (b), owner decision): double opt-in like v1 —
      // a credentialed endpoint AND allowPaidApi must both be deliberate.
      // USD ceilings are optional but PAIRED (v1 rule: both positive or
      // neither); dollars are enforced where cost is genuinely reported.
      allowPaidApi: false,
    },
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
      } else if ("apiKeyEnvVar" in endpoint && (typeof endpoint.apiKeyEnvVar !== "string" || !endpoint.apiKeyEnvVar.trim())) {
        errors.push(`endpoints.${name}.apiKeyEnvVar must be a nonempty environment-variable name when present`);
      } else if ("credential" in endpoint && (typeof endpoint.credential !== "string" || !/^[a-z0-9_-]+$/i.test(endpoint.credential))) {
        errors.push(`endpoints.${name}.credential must be a stored-credential name (letters, digits, "_", "-") when present`);
      } else if ("credential" in endpoint && "apiKeyEnvVar" in endpoint) {
        // Two credential sources on one endpoint is an ambiguity, and money
        // guards refuse ambiguity — pick the store or the env var, not both.
        errors.push(`endpoints.${name} names BOTH credential and apiKeyEnvVar — configure exactly one`);
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
  if (!isPlainObject(config.budgets)) {
    errors.push("budgets must be an object");
  } else {
    const b = config.budgets;
    if (!Number.isSafeInteger(b.maxWorkers) || b.maxWorkers <= 0) errors.push("budgets.maxWorkers must be a positive integer");
    if (!Number.isSafeInteger(b.maxConcurrentWorkers) || b.maxConcurrentWorkers < 1 || b.maxConcurrentWorkers > 4) {
      errors.push("budgets.maxConcurrentWorkers must be an integer between 1 and 4");
    }
    if (!Number.isSafeInteger(b.maxTotalTokens) || b.maxTotalTokens <= 0) errors.push("budgets.maxTotalTokens must be a positive integer");
    if (!Number.isFinite(b.windowHours) || b.windowHours <= 0) errors.push("budgets.windowHours must be a positive number");
    // PAID lane (owner decision, 2026-08-05 night): optional because the paid
    // lane itself is opt-in — but once any endpoint carries a credential, a
    // missing maxPaidTokens refuses the call (fail closed in sendMessages).
    if ("maxPaidTokens" in b && (!Number.isSafeInteger(b.maxPaidTokens) || b.maxPaidTokens <= 0)) {
      errors.push("budgets.maxPaidTokens must be a positive integer when present");
    }
    if ("allowPaidApi" in b && typeof b.allowPaidApi !== "boolean") {
      errors.push("budgets.allowPaidApi must be true or false");
    }
    // v1 rule, ported verbatim in spirit: USD spending limits come as a PAIR,
    // both positive — a per-run cap with no monthly cap (or vice versa) is a
    // half-configured money guard and refuses at validation time.
    const hasPerRun = "perRunLimitUsd" in b;
    const hasMonthly = "monthlyLimitUsd" in b;
    if (hasPerRun !== hasMonthly) {
      errors.push("budgets.perRunLimitUsd and budgets.monthlyLimitUsd must be configured TOGETHER (v1 rule: paid spending limits come as a pair)");
    }
    if (hasPerRun && (!Number.isFinite(b.perRunLimitUsd) || b.perRunLimitUsd <= 0)) {
      errors.push("budgets.perRunLimitUsd must be a positive number when present");
    }
    if (hasMonthly && (!Number.isFinite(b.monthlyLimitUsd) || b.monthlyLimitUsd <= 0)) {
      errors.push("budgets.monthlyLimitUsd must be a positive number when present");
    }
    if ("maxWorkerMinutes" in b) errors.push("budgets.maxWorkerMinutes was removed — use --timeout-minutes on the command instead");
  }
  return { ok: errors.length === 0, errors };
}

/** The project-scoped config file's path (v1's `configPath` pattern). */
export function projectConfigPath(projectPath) {
  return path.join(path.resolve(projectPath), ".devharmonics", "config.json");
}

/**
 * Ported from devharmonics-v1's `initializeProject` (src/config.ts), per the
 * owner's direction: the audience is a technical product manager, not a
 * programmer, so the config file MATERIALIZES on first touch — pre-filled
 * with the defaults, in a well-known place inside the project — rather than
 * being hand-authored against a schema doc. Never overwrites an existing
 * file; keeps the state dir out of the project's shared .gitignore via the
 * private .git/info/exclude (silently skipped when the directory is not a
 * git repository, exactly as v1 tolerated it).
 */
export function initializeProjectConfig(projectPath) {
  const destination = projectConfigPath(projectPath);
  if (existsSync(destination)) return { path: destination, created: false };
  mkdirSync(path.dirname(destination), { recursive: true });
  const seeded = {
    _readme: [
      "DevHarmonics configuration — created automatically with the defaults on first use.",
      "Edit values and save; every command reads this file and announces it as its config source.",
      "A --config <file> flag overrides this file for one invocation.",
      "endpoints.<name>.apiKeyEnvVar names an environment variable holding a REAL credential; endpoints.<name>.credential names a key stored via `devharmonics credential set <name>` (pick one, not both). Either makes the endpoint PAID and requires budgets.allowPaidApi: true plus budgets.maxPaidTokens (optionally budgets.perRunLimitUsd + budgets.monthlyLimitUsd, always as a pair).",
      "See docs/USER_MANUAL.md for every field.",
    ],
    ...defaultConfig(),
  };
  writeFileSync(destination, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
  try {
    const exclude = path.join(path.resolve(projectPath), ".git", "info", "exclude");
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : null;
    if (current !== null && !current.includes(".devharmonics/")) {
      appendFileSync(exclude, "\n.devharmonics/\n");
    }
  } catch { /* not a git repository — fine, v1 tolerated exactly this */ }
  return { path: destination, created: true };
}

/**
 * Precedence (owner decision, 2026-08-05 night): an explicit --config file >
 * the project's own .devharmonics/config.json (auto-created on first touch
 * when `projectPath` is supplied) > built-in defaults. Whatever loads, the
 * SOURCE is returned so every command can announce it — implicit must never
 * mean invisible.
 */
export function loadConfig(configPath = null, { projectPath = null } = {}) {
  const base = defaultConfig();
  let resolved = null;
  let created = false;
  if (configPath) {
    resolved = path.resolve(configPath);
    if (!existsSync(resolved)) throw new Error(`Config file not found: ${resolved}`);
  } else if (projectPath && existsSync(path.resolve(projectPath))) {
    // Only an EXISTING directory materializes a config — a mistyped
    // --repository/--cwd must never conjure directories out of thin air.
    const initialized = initializeProjectConfig(projectPath);
    resolved = initialized.path;
    created = initialized.created;
  } else {
    return { config: base, source: "defaults", created: false };
  }
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
  return { config: merged, source: resolved, created };
}
