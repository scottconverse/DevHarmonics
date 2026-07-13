import type { ProviderName, RingerConfig } from "./types.js";
import { runProcess, subscriptionEnvironment } from "./process.js";

export interface ProviderStatus {
  name: ProviderName;
  installed: boolean;
  version: string;
  loginCommand: string;
  subscriptionOnly: true;
}

const loginCommands: Record<ProviderName, string> = {
  codex: "codex login",
  claude: "claude auth login",
  gemini: "gemini",
};

export async function inspectProviders(
  config: RingerConfig,
  cwd: string,
): Promise<ProviderStatus[]> {
  return Promise.all(
    (["codex", "claude", "gemini"] as ProviderName[]).map(async (name) => {
      try {
        const result = await runProcess({
          command: config.providers[name].command,
          args: ["--version"],
          cwd,
          timeoutMs: 10_000,
          env: subscriptionEnvironment(name),
        });
        return {
          name,
          installed: result.exitCode === 0,
          version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? "",
          loginCommand: loginCommands[name],
          subscriptionOnly: true as const,
        };
      } catch {
        return {
          name,
          installed: false,
          version: "",
          loginCommand: loginCommands[name],
          subscriptionOnly: true as const,
        };
      }
    }),
  );
}
