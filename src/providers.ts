import type {
  ProviderConfig,
  ProviderName,
  ProviderRequest,
  ProviderResult,
} from "./types.js";
import { runProcess, subscriptionEnvironment } from "./process.js";

export interface ProviderAdapter {
  readonly name: ProviderName;
  run(request: ProviderRequest): Promise<ProviderResult>;
}

abstract class CliProvider implements ProviderAdapter {
  abstract readonly name: ProviderName;

  constructor(protected readonly config: ProviderConfig) {}

  protected abstract argumentsFor(request: ProviderRequest): string[];
  protected abstract extractText(stdout: string): string;
  protected stdinFor(request: ProviderRequest): string {
    return request.prompt;
  }

  async run(request: ProviderRequest): Promise<ProviderResult> {
    const result = await runProcess({
      command: this.config.command,
      args: this.argumentsFor(request),
      cwd: request.cwd,
      timeoutMs: request.timeoutMs ?? this.config.timeoutMs,
      stdin: this.stdinFor(request),
      env: subscriptionEnvironment(this.name),
    });

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "No diagnostic output";
      throw new Error(
        `${this.name} exited with code ${result.exitCode}${result.timedOut ? " after timing out" : ""}: ${detail}`,
      );
    }

    return {
      provider: this.name,
      text: this.extractText(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }
}

export class CodexProvider extends CliProvider {
  readonly name = "codex" as const;

  protected argumentsFor(request: ProviderRequest): string[] {
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      request.writeAccess ? "workspace-write" : "read-only",
      "-",
    ];
  }

  protected extractText(stdout: string): string {
    return extractCodexText(stdout);
  }
}

export class ClaudeProvider extends CliProvider {
  readonly name = "claude" as const;

  protected argumentsFor(request: ProviderRequest): string[] {
    return [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      request.writeAccess ? "acceptEdits" : "plan",
    ];
  }

  protected extractText(stdout: string): string {
    return extractClaudeText(stdout);
  }
}

export class GeminiProvider extends CliProvider {
  readonly name = "gemini" as const;

  protected argumentsFor(request: ProviderRequest): string[] {
    return [
      "--mode",
      request.writeAccess ? "accept-edits" : "plan",
      "--print-timeout",
      `${Math.ceil((request.timeoutMs ?? this.config.timeoutMs) / 1_000)}s`,
      "--print",
      request.prompt,
    ];
  }

  protected stdinFor(): string {
    return "";
  }

  protected extractText(stdout: string): string {
    return extractGeminiText(stdout);
  }
}

export function extractCodexText(stdout: string): string {
  let final = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        final = event.item.text;
      }
    } catch {
      // Preserve compatibility with future non-JSON diagnostic lines.
    }
  }
  if (!final) throw new Error("Codex completed without a final agent message");
  return final;
}

export function extractClaudeText(stdout: string): string {
  const value = parseSingleJson(stdout);
  if (typeof value === "object" && value !== null && "result" in value) {
    const result = (value as { result?: unknown }).result;
    if (typeof result === "string") return result;
  }
  throw new Error("Claude completed without a JSON result field");
}

export function extractGeminiText(stdout: string): string {
  const text = stdout.trim();
  if (text) return text;
  throw new Error("Gemini completed without a response");
}

function parseSingleJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("CLI returned invalid JSON output");
  }
}

export function createProvider(name: ProviderName, config: ProviderConfig): ProviderAdapter {
  if (name === "codex") return new CodexProvider(config);
  if (name === "claude") return new ClaudeProvider(config);
  return new GeminiProvider(config);
}
