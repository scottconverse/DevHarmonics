import type { ProviderName, RingerConfig } from "./types.js";
import { runProcess, subscriptionEnvironment } from "./process.js";

export interface ProviderStatus {
  name: ProviderName;
  installed: boolean;
  version: string;
  loginCommand: string;
  setupSteps: string[];
  subscriptionOnly: true;
}

const loginCommands: Record<ProviderName, string> = {
  codex: "codex login",
  claude: "claude auth login",
  gemini: "agy",
};

const setupSteps: Record<ProviderName, string[]> = {
  codex: [
    "Run codex login.",
    "Finish the ChatGPT sign-in in your browser.",
    "Return to the terminal and confirm Codex reports that you are logged in.",
  ],
  claude: [
    "Run claude auth login.",
    "Finish the Claude subscription sign-in in your browser.",
    "Run claude auth status --text to confirm the account.",
  ],
  gemini: [
    "Run agy and sign in with the Google account tied to your Gemini subscription.",
    "When the browser displays a one-time code, copy it, return to the Antigravity terminal, paste it at the authorization prompt, and press Enter. Never paste it into Ringer or chat.",
    "Complete the first-run screens: choose a color scheme with the arrow keys, press Enter, and continue through each Next screen.",
    "When the normal Antigravity prompt appears, exit with Ctrl+C. Run agy models to verify the cached subscription login.",
  ],
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
          setupSteps: setupSteps[name],
          subscriptionOnly: true as const,
        };
      } catch {
        return {
          name,
          installed: false,
          version: "",
          loginCommand: loginCommands[name],
          setupSteps: setupSteps[name],
          subscriptionOnly: true as const,
        };
      }
    }),
  );
}
