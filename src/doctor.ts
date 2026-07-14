import type { ProviderName, DevHarmonicsConfig } from "./types.js";
import { runProcess, subscriptionEnvironment } from "./process.js";
import { resolveProviderCommand } from "./config.js";

export interface ProviderStatus {
  name: ProviderName;
  installed: boolean;
  authenticated: boolean;
  version: string;
  authStatus: string;
  loginCommand: string;
  setupSteps: string[];
  subscriptionOnly: true;
}

const loginCommands: Record<ProviderName, string> = {
  codex: "codex login",
  claude: "claude auth login",
  gemini: "agy",
};

const authChecks: Record<ProviderName, string[]> = {
  codex: ["login", "status"],
  claude: ["auth", "status", "--text"],
  gemini: ["models"],
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
    "When the browser displays a one-time code, copy it, return to the Antigravity terminal, paste it at the authorization prompt, and press Enter. Never paste it into DevHarmonics or chat.",
    "Complete the full first-run onboarding. After the color scheme, Antigravity 1.1.1 presents several additional preference screens; review each choice and navigate with the displayed arrow/Enter controls.",
    "Onboarding is finished only when the normal prompt shows your account, subscription tier, selected Gemini model, project path, and a > input line. Exit with Ctrl+C, then run agy models to verify the cached login.",
  ],
};

export async function inspectProviders(
  config: DevHarmonicsConfig,
  cwd: string,
): Promise<ProviderStatus[]> {
  return Promise.all(
    (["codex", "claude", "gemini"] as ProviderName[]).map(async (name) => {
      try {
        const command = resolveProviderCommand(name, config.providers[name].command);
        const result = await runProcess({
          command,
          args: ["--version"],
          cwd,
          timeoutMs: 10_000,
          env: subscriptionEnvironment(name),
        });
        const installed = result.exitCode === 0;
        let authenticated = false;
        let authStatus = installed ? "Sign-in required" : "Not installed";
        if (installed) {
          const auth = await runProcess({
            command,
            args: authChecks[name],
            cwd,
            timeoutMs: 15_000,
            env: subscriptionEnvironment(name),
          });
          authenticated = auth.exitCode === 0;
          authStatus = firstLine(auth.stdout || auth.stderr) ||
            (authenticated ? "Signed in" : "Sign-in required");
        }
        return {
          name,
          installed,
          authenticated,
          version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? "",
          authStatus,
          loginCommand: loginCommands[name],
          setupSteps: setupSteps[name],
          subscriptionOnly: true as const,
        };
      } catch {
        return {
          name,
          installed: false,
          authenticated: false,
          version: "",
          authStatus: "Not installed",
          loginCommand: loginCommands[name],
          setupSteps: setupSteps[name],
          subscriptionOnly: true as const,
        };
      }
    }),
  );
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}
