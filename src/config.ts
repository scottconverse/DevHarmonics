import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ringerConfigSchema } from "./schemas.js";
import type { RingerConfig } from "./types.js";

export const defaultConfig: RingerConfig = {
  version: 1,
  architect: "claude",
  reviewer: "codex",
  workers: ["codex", "claude", "gemini"],
  concurrency: {
    mode: "auto",
    agents: 8,
    ceiling: null,
  },
  retry: {
    maxAttempts: 3,
    backoffMs: 1_500,
  },
  providers: {
    codex: { enabled: true, command: "codex", timeoutMs: 30 * 60_000 },
    claude: { enabled: true, command: "claude", timeoutMs: 30 * 60_000 },
    gemini: { enabled: true, command: "agy", timeoutMs: 30 * 60_000 },
  },
  validators: {
    "diff-check": {
      command: "git",
      args: ["diff", "--check"],
      timeoutMs: 60_000,
    },
  },
};

export function ringerDirectory(projectPath: string): string {
  return path.join(projectPath, ".ringer");
}

export function configPath(projectPath: string): string {
  return path.join(ringerDirectory(projectPath), "config.json");
}

export async function initializeProject(projectPath: string): Promise<string> {
  const directory = ringerDirectory(projectPath);
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
          config.validators[name] = {
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
      `# Ringer constitution\n\n1. Preserve existing behavior unless the goal explicitly changes it.\n2. Never claim a check passed without an execution receipt.\n3. Add or update tests for new observable behavior.\n4. Do not weaken tests merely to make a task pass.\n5. Keep changes within the assigned task.\n6. Do not expose secrets or broaden permissions.\n7. Record assumptions and unresolved risks.\n8. A run is complete only after task checks and final integration checks pass.\n`,
      "utf8",
    );
  }

  return destination;
}

async function excludeRuntimeDirectory(projectPath: string): Promise<void> {
  const exclude = path.join(projectPath, ".git", "info", "exclude");
  try {
    const current = await readFile(exclude, "utf8");
    if (!current.split(/\r?\n/).includes(".ringer/")) {
      await writeFile(exclude, `${current.replace(/\s*$/, "")}\n.ringer/\n`, "utf8");
    }
  } catch {
    // The project may not be a Git repository yet. Worktree preflight reports that clearly.
  }
}

export async function loadConfig(projectPath: string): Promise<RingerConfig> {
  await initializeProject(projectPath);
  const contents = await readFile(configPath(projectPath), "utf8");
  return ringerConfigSchema.parse(JSON.parse(contents));
}

export async function loadConstitution(projectPath: string): Promise<string> {
  await initializeProject(projectPath);
  return readFile(path.join(ringerDirectory(projectPath), "constitution.md"), "utf8");
}
