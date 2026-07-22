import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { devHarmonicsConfigSchema, legacyDevHarmonicsConfigSchema } from "./schemas.js";
import { expandValidatorTokens } from "./validators.js";
import type { ProviderName, DevHarmonicsConfig } from "./types.js";

export const defaultConfig: DevHarmonicsConfig = {
  version: 2,
  application: {
    concurrency: {
      mode: "auto",
      agents: 8,
      ceiling: null,
    },
    retry: {
      maxAttempts: 3,
      backoffMs: 1_500,
    },
  },
  connections: {
    codex: { enabled: true, command: "codex", timeoutMs: 30 * 60_000 },
    claude: { enabled: true, command: "claude", timeoutMs: 30 * 60_000 },
    gemini: { enabled: true, command: "agy", timeoutMs: 30 * 60_000 },
  },
  localRuntimes: {
    ollama: [
      { id: "system", displayName: "System Ollama", baseUrl: "http://127.0.0.1:11434", enabled: true },
    ],
  },
  openRouter: {
    enabled: false,
    allowPaidFallback: false,
    perRunLimitUsd: 0,
    monthlyLimitUsd: 0,
  },
  product: {
    architect: "claude",
    reviewer: "codex",
    workers: ["codex", "claude", "gemini"],
  },
  repository: {
    validators: {
      "diff-check": {
        command: "git",
        args: ["diff", "--check"],
        timeoutMs: 60_000,
      },
    },
  },
  runPolicy: {
    autonomy: "supervised",
    requirePlanApproval: false,
    allowPaidApi: false,
    allowExternalWrites: false,
  },
  reviewPolicy: {
    reviewerCountByRisk: { low: 1, medium: 1, high: 2 },
    minimumDistinctProvidersByRisk: { low: 1, medium: 1, high: 2 },
    requireImplementorIndependenceByRisk: { low: false, medium: true, high: true },
    requiredLensesByRisk: { low: ["artifact"], medium: ["artifact"], high: ["artifact", "claims"] },
    maxFixRounds: 2,
  },
  routing: {
    mode: "adaptive",
    architect: { modelId: null, effort: "high", preferredTier: "auto", upgradePolicy: "pinned" },
    worker: { modelId: null, effort: "high", preferredTier: "auto", upgradePolicy: "pinned" },
    reviewer: { modelId: null, effort: "high", preferredTier: "auto", upgradePolicy: "pinned" },
    allowFallback: true,
  },
};

export function devHarmonicsDirectory(projectPath: string): string {
  return path.join(projectPath, ".devharmonics");
}

export function configPath(projectPath: string): string {
  return path.join(devHarmonicsDirectory(projectPath), "config.json");
}

export async function initializeProject(projectPath: string): Promise<string> {
  const directory = devHarmonicsDirectory(projectPath);
  await mkdir(directory, { recursive: true });
  await excludeRuntimeDirectory(projectPath);
  const destination = configPath(projectPath);

  try {
    await readFile(destination, "utf8");
  } catch {
    const config = structuredClone(defaultConfig);
    try {
      const packageJson = JSON.parse(
        await readFile(path.join(projectPath, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };
      for (const name of ["test", "lint", "build", "typecheck"]) {
        if (packageJson.scripts?.[name]) {
          config.repository.validators[name] = {
            command: "npm",
            args: ["run", name],
            timeoutMs: 10 * 60_000,
          };
        }
      }
    } catch {
      // Non-Node projects can add their validators directly to config.json.
    }
    await writeFile(destination, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  const constitution = path.join(directory, "constitution.md");
  try {
    await readFile(constitution, "utf8");
  } catch {
    await writeFile(
      constitution,
      `# DevHarmonics constitution\n\n1. Preserve existing behavior unless the goal explicitly changes it.\n2. Never claim a check passed without an execution receipt.\n3. Add or update tests for new observable behavior.\n4. Do not weaken tests merely to make a task pass.\n5. Keep changes within the assigned task.\n6. Do not expose secrets or broaden permissions.\n7. Record assumptions and unresolved risks.\n8. A run is complete only after task checks and final integration checks pass.\n`,
      "utf8",
    );
  }

  return destination;
}

async function excludeRuntimeDirectory(projectPath: string): Promise<void> {
  const exclude = path.join(projectPath, ".git", "info", "exclude");
  try {
    const current = await readFile(exclude, "utf8");
    if (!current.split(/\r?\n/).includes(".devharmonics/")) {
      await writeFile(exclude, `${current.replace(/\s*$/, "")}\n.devharmonics/\n`, "utf8");
    }
  } catch {
    // The project may not be a Git repository yet. Worktree preflight reports that clearly.
  }
}

export async function loadConfig(projectPath: string): Promise<DevHarmonicsConfig> {
  await initializeProject(projectPath);
  const destination = configPath(projectPath);
  const contents = await readFile(destination, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid configuration JSON in ${destination}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const version = typeof raw === "object" && raw !== null && "version" in raw
    ? (raw as { version?: unknown }).version
    : undefined;
  if (version === 1) {
    const legacy = parseConfig(legacyDevHarmonicsConfigSchema, raw, destination);
    const migrated: DevHarmonicsConfig = {
      version: 2,
      application: { concurrency: legacy.concurrency, retry: legacy.retry },
      connections: legacy.providers,
      localRuntimes: structuredClone(defaultConfig.localRuntimes),
      openRouter: structuredClone(defaultConfig.openRouter),
      product: {
        architect: legacy.architect,
        reviewer: legacy.reviewer,
        workers: legacy.workers,
      },
      repository: { validators: legacy.validators },
      runPolicy: structuredClone(defaultConfig.runPolicy),
      reviewPolicy: structuredClone(defaultConfig.reviewPolicy),
      routing: structuredClone(defaultConfig.routing),
    };
    await persistMigration(destination, contents, migrated);
    return withExpandedValidators(migrated, projectPath);
  }
  return withExpandedValidators(parseConfig(devHarmonicsConfigSchema, raw, destination), projectPath);
}

/**
 * `${repoRoot}` in a project's own validator commands means this project's root.
 * Expanded here, at the one place every consumer loads configuration through, so
 * a validator that needs the repository's own toolchain can be written portably
 * in .devharmonics/config.json. Registered per-repository validators from the
 * ledger are expanded separately against that repository's local path.
 */
function withExpandedValidators(config: DevHarmonicsConfig, projectPath: string): DevHarmonicsConfig {
  return { ...config, repository: { validators: expandValidatorTokens(config.repository.validators, path.resolve(projectPath)) } };
}

export async function saveConfig(projectPath: string, value: unknown): Promise<DevHarmonicsConfig> {
  await initializeProject(projectPath);
  const destination = configPath(projectPath);
  const config = parseConfig(devHarmonicsConfigSchema, value, destination);
  const temporary = `${destination}.saving`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  return config;
}

function parseConfig<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, raw: unknown, destination: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "configuration"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid DevHarmonics configuration in ${destination}: ${details}`);
}

async function persistMigration(destination: string, original: string, migrated: DevHarmonicsConfig): Promise<void> {
  const backup = `${destination}.v1.backup`;
  try {
    await copyFile(destination, backup, 1);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EEXIST") throw error;
  }
  const temporary = `${destination}.migrating`;
  await writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, destination);
  } catch (error) {
    await writeFile(destination, original, "utf8");
    throw error;
  }
}

export function resolveProviderCommand(name: ProviderName, configuredCommand: string): string {
  if (process.platform !== "win32" || name !== "gemini" || configuredCommand !== "agy") {
    return configuredCommand;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return configuredCommand;
  const installedCommand = path.join(localAppData, "agy", "bin", "agy.exe");
  return existsSync(installedCommand) ? installedCommand : configuredCommand;
}

export async function loadConstitution(projectPath: string): Promise<string> {
  await initializeProject(projectPath);
  return readFile(path.join(devHarmonicsDirectory(projectPath), "constitution.md"), "utf8");
}
