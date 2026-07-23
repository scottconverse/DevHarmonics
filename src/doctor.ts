import type { ProviderName, DevHarmonicsConfig } from "./types.js";
import { runProcess, subscriptionEnvironment } from "./process.js";
import { resolveProviderCommand } from "./config.js";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ProviderStatus {
  name: ProviderName;
  enabled: boolean;
  installed: boolean;
  authenticated: boolean;
  visible: boolean;
  healthy: boolean;
  available: boolean;
  entitlement: "unknown";
  capacity: "unknown";
  version: string;
  authStatus: string;
  summary: string;
  diagnostics: ConnectionDiagnostic[];
  loginCommand: string;
  setupSteps: string[];
  visibleModels: string[];
  subscriptionOnly: true;
}

export type ConnectionDiagnosticLayer =
  | "configuration"
  | "installation"
  | "authentication"
  | "visibility"
  | "entitlement"
  | "health"
  | "capacity"
  | "availability";

export interface ConnectionDiagnostic {
  layer: ConnectionDiagnosticLayer;
  state: "pass" | "fail" | "unknown" | "disabled";
  detail: string;
  action: string | null;
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
    "Complete the full first-run onboarding. After the color scheme, recent Antigravity versions present several additional preference screens; review each choice and navigate with the displayed arrow/Enter controls.",
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
        const command = resolveProviderCommand(name, config.connections[name].command);
        const result = await runProcess({
          command,
          args: ["--version"],
          cwd,
          timeoutMs: 10_000,
          env: subscriptionEnvironment(name),
        });
        const installed = result.exitCode === 0;
        let authenticated = false;
        let visibleModels: string[] = [];
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
          if (authenticated && name === "gemini") {
            visibleModels = auth.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          } else if (authenticated && name === "codex" && /^codex(?:\.cmd|\.exe)?$/i.test(path.basename(command))) {
            visibleModels = await discoverCodexModels();
          }
          authStatus = firstLine(auth.stdout || auth.stderr) ||
            (authenticated ? "Signed in" : "Sign-in required");
        }
        return providerStatus({
          name,
          enabled: config.connections[name].enabled,
          installed,
          authenticated,
          version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? "",
          authStatus,
          visibleModels,
        });
      } catch {
        return providerStatus({
          name,
          enabled: config.connections[name].enabled,
          installed: false,
          authenticated: false,
          version: "",
          authStatus: "Not installed",
          visibleModels: [],
        });
      }
    }),
  );
}

async function discoverCodexModels(): Promise<string[]> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const value = JSON.parse(await readFile(path.join(codexHome, "models_cache.json"), "utf8")) as {
      models?: Array<{ slug?: unknown; visibility?: unknown }>;
    };
    return (value.models ?? [])
      .filter((model) => model.visibility !== "hide" && typeof model.slug === "string")
      .map((model) => String(model.slug));
  } catch {
    return [];
  }
}

function providerStatus(input: {
  name: ProviderName;
  enabled: boolean;
  installed: boolean;
  authenticated: boolean;
  version: string;
  authStatus: string;
  visibleModels: string[];
}): ProviderStatus {
  const visible = input.authenticated && Boolean(input.authStatus.trim());
  // This is deliberately a control-plane health signal. A successful version
  // and auth probe does not spend tokens or pretend a specific model has been
  // invoked successfully.
  const healthy = input.installed && input.authenticated;
  const available = input.enabled && healthy;
  const diagnostics: ConnectionDiagnostic[] = [
    {
      layer: "configuration",
      state: input.enabled ? "pass" : "disabled",
      detail: input.enabled ? "Enabled in project configuration" : "Disabled in project configuration",
      action: input.enabled ? null : "Enable this provider in .devharmonics/config.json to use it.",
    },
    {
      layer: "installation",
      state: input.installed ? "pass" : "fail",
      detail: input.installed ? input.version || "CLI responded" : "CLI not found or did not start",
      action: input.installed ? null : `Install the ${input.name} CLI and ensure it is on PATH.`,
    },
    {
      layer: "authentication",
      state: input.authenticated ? "pass" : "fail",
      detail: input.authStatus,
      action: input.authenticated ? null : `Run '${loginCommands[input.name]}' and finish every provider-owned sign-in step.`,
    },
    {
      layer: "visibility",
      state: visible ? "pass" : "unknown",
      detail: visible ? "The CLI exposes a signed-in account/session" : "Account visibility is unavailable until sign-in succeeds",
      action: visible ? null : `Complete '${loginCommands[input.name]}' and refresh status.`,
    },
    {
      layer: "entitlement",
      state: "unknown",
      detail: "Specific model entitlement has not been verified",
      action: "Model visibility and compatibility probes will populate this without requesting your password.",
    },
    {
      layer: "health",
      state: healthy ? "pass" : "unknown",
      detail: healthy ? "Installation and authentication control-plane probes passed" : "Control-plane health is not established",
      action: healthy ? null : "Resolve installation and authentication first.",
    },
    {
      layer: "capacity",
      state: "unknown",
      detail: "Remaining subscription quota is not exposed reliably by this CLI",
      action: "DevHarmonics will learn capacity from classified run outcomes without probe storms.",
    },
    {
      layer: "availability",
      state: available ? "pass" : input.enabled ? "fail" : "disabled",
      detail: available
        ? "Available for subscription-backed assignments"
        : input.enabled
          ? "Unavailable until required setup layers pass"
          : "Not eligible for assignment while disabled",
      action: available ? null : input.enabled ? "Resolve the first failed layer above." : "Enable the provider when you want to use it.",
    },
  ];
  return {
    ...input,
    visible,
    healthy,
    available,
    entitlement: "unknown",
    capacity: "unknown",
    summary: available
      ? "Ready; model entitlement and capacity remain unverified"
      : diagnostics.find((diagnostic) => diagnostic.state === "fail")?.detail ?? "Disabled",
    diagnostics,
    loginCommand: loginCommands[input.name],
    setupSteps: setupSteps[input.name],
    visibleModels: input.visibleModels,
    subscriptionOnly: true,
  };
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}
