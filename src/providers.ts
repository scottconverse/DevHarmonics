import type {
  ProviderConfig,
  ProviderName,
  ProviderRequest,
  ProviderResult,
} from "./types.js";
import { projectLegacyProvider } from "./compatibility.js";
import { runProcess, subscriptionEnvironment } from "./process.js";
import { VERSION } from "./product.js";
import {
  RuntimeInvocationError,
  classifyInvocationFailure,
  type InvocationEvent,
  type InvocationOptions,
  type InvocationRequest,
  type InvocationResult,
  type ProviderConnection,
  type RuntimeAdapter,
  type RuntimeMetadata,
  type ModelSelection,
} from "./runtime.js";

const runtimeVersionCache = new Map<string, Promise<string | null>>();

export interface SubscriptionCliConnection extends ProviderConnection {
  provider: ProviderName;
  transport: "subscription_cli";
  authentication: "subscription";
  cli: {
    command: string;
    outputFormat: "json_lines" | "json" | "text";
    promptTransport: "stdin" | "argument";
  };
}

export interface ProviderAdapter extends RuntimeAdapter {
  readonly name: ProviderName;
  readonly connection: SubscriptionCliConnection;
  run(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult>;
}

abstract class CliProvider implements ProviderAdapter {
  abstract readonly name: ProviderName;
  abstract readonly displayName: string;
  abstract readonly outputFormat: SubscriptionCliConnection["cli"]["outputFormat"];
  readonly promptTransport: SubscriptionCliConnection["cli"]["promptTransport"] = "stdin";

  constructor(protected readonly config: ProviderConfig) {}

  protected abstract argumentsFor(request: ProviderRequest): string[];
  protected abstract extractText(stdout: string): string;
  protected stdinFor(request: ProviderRequest): string {
    return request.prompt;
  }

  get connection(): SubscriptionCliConnection {
    const projection = projectLegacyProvider(this.name);
    return {
      id: projection.connectionId,
      provider: this.name,
      displayName: this.displayName,
      transport: "subscription_cli",
      authentication: "subscription",
      capabilities: {
        structuredOutput: this.name !== "gemini",
        streaming: false,
        providerManagedTools: true,
        modelSelection: true,
        modelSettings: this.name === "gemini" ? [] : ["effort"],
        permissions: ["read_only", "workspace_write"],
      },
      cli: {
        command: this.config.command,
        outputFormat: this.outputFormat,
        promptTransport: this.promptTransport,
      },
    };
  }

  async metadata(): Promise<RuntimeMetadata> {
    const key = `${this.name}\0${this.config.command}`;
    let pending = runtimeVersionCache.get(key);
    if (!pending) {
      pending = runProcess({
        command: this.config.command,
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        env: subscriptionEnvironment(this.name),
      })
        .then((result) => {
          if (result.exitCode !== 0) return null;
          return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
        })
        .catch(() => null);
      runtimeVersionCache.set(key, pending);
    }
    return { adapterVersion: VERSION, runtimeVersion: await pending };
  }

  async invoke(request: InvocationRequest, options: InvocationOptions = {}): Promise<InvocationResult> {
    const legacyRequest: ProviderRequest = {
      role: request.role,
      prompt: request.prompt,
      cwd: request.cwd,
      writeAccess: request.permission === "workspace_write",
      ...(request.timeoutMs === null ? {} : { timeoutMs: request.timeoutMs }),
    };
    const metadata = await this.metadata();
    const emit = (event: InvocationEvent) => options.onEvent?.(event);
    emit({ type: "started", connectionId: this.connection.id, at: new Date().toISOString() });
    const unsupportedSettings = Object.keys(request.model.settings).filter((setting) => !this.connection.capabilities.modelSettings.includes(setting));
    if (unsupportedSettings.length) {
      emit({
        type: "failed",
        kind: "incompatible",
        exitCode: 0,
        retryable: false,
        at: new Date().toISOString(),
      });
      throw new RuntimeInvocationError(
        `${this.name} does not support model settings: ${unsupportedSettings.join(", ")}`,
        "incompatible",
        this.connection.id,
        0,
        false,
      );
    }

    let result;
    try {
      result = await runProcess({
        command: this.config.command,
        args: [...this.modelArguments(request.model), ...this.argumentsFor(legacyRequest)],
        cwd: legacyRequest.cwd,
        timeoutMs: legacyRequest.timeoutMs ?? this.config.timeoutMs,
        stdin: this.stdinFor(legacyRequest),
        env: subscriptionEnvironment(this.name),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      const cancelled = options.signal?.aborted ?? false;
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "failed",
        kind: cancelled ? "cancelled" : "process_failed",
        exitCode: -1,
        retryable: !cancelled,
        at: new Date().toISOString(),
      });
      throw new RuntimeInvocationError(
        `${this.name} could not start: ${message}`,
        cancelled ? "cancelled" : "process_failed",
        this.connection.id,
        -1,
        !cancelled,
      );
    }

    if (result.stdout) emit({ type: "stdout", text: result.stdout, at: new Date().toISOString() });
    if (result.stderr) emit({ type: "stderr", text: result.stderr, at: new Date().toISOString() });
    if (result.exitCode !== 0 || result.timedOut) {
      const detail = result.stderr.trim() || result.stdout.trim() || "No diagnostic output";
      const failure = classifyInvocationFailure({
        detail,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: options.signal?.aborted ?? false,
      });
      emit({
        type: "failed",
        kind: failure.kind,
        exitCode: result.exitCode,
        retryable: failure.retryable,
        at: new Date().toISOString(),
      });
      throw new RuntimeInvocationError(
        `${this.name} exited with code ${result.exitCode}${result.timedOut ? " after timing out" : ""}: ${detail}`,
        failure.kind,
        this.connection.id,
        result.exitCode,
        failure.retryable,
      );
    }

    let text: string;
    try {
      text = this.extractText(result.stdout);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emit({
        type: "failed",
        kind: "incompatible",
        exitCode: result.exitCode,
        retryable: false,
        at: new Date().toISOString(),
      });
      throw new RuntimeInvocationError(
        `${this.name} returned an incompatible response: ${detail}`,
        "incompatible",
        this.connection.id,
        result.exitCode,
        false,
      );
    }

    emit({
      type: "completed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      at: new Date().toISOString(),
    });
    const projection = projectLegacyProvider(this.name);
    return {
      connectionId: projection.connectionId,
      provider: this.name,
      ...metadata,
      model: {
        ...request.model,
        resolvedModelId: request.model.requestedModelId ?? projection.modelId,
        resolution: request.model.requestedModelId === null
          ? "provider_default_unresolved"
          : "concrete",
      },
      text,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
      toolRequests: [],
    };
  }

  async run(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult> {
    const result = await this.invoke({
      role: request.role,
      prompt: request.prompt,
      cwd: request.cwd,
      permission: request.writeAccess ? "workspace_write" : "read_only",
      timeoutMs: request.timeoutMs ?? null,
      model: { requestedModelId: null, alias: null, settings: {} },
    }, signal ? { signal } : {});
    return {
      provider: this.name,
      text: result.text,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }

  protected modelArguments(selection: ModelSelection): string[] {
    const requested = selection.alias ?? (selection.requestedModelId ? String(selection.requestedModelId) : null);
    const model = requested?.replace(/^subscription-cli:[^:]+:model:/, "").replace(new RegExp(`^${this.name}:`), "") ?? null;
    if (this.name === "codex") {
      const args = model ? ["--model", model] : [];
      if (selection.settings.effort) args.push("--config", `model_reasoning_effort=${JSON.stringify(selection.settings.effort)}`);
      return args;
    }
    if (this.name === "claude") {
      const args = model ? ["--model", model] : [];
      if (selection.settings.effort) args.push("--effort", String(selection.settings.effort));
      return args;
    }
    return model ? ["--model", model] : [];
  }
}

export class CodexProvider extends CliProvider {
  readonly name = "codex" as const;
  readonly displayName = "OpenAI Codex";
  readonly outputFormat = "json_lines" as const;

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
  readonly displayName = "Claude Code";
  readonly outputFormat = "json" as const;

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
  readonly displayName = "Google Antigravity";
  readonly outputFormat = "text" as const;
  override readonly promptTransport = "argument" as const;

  protected argumentsFor(request: ProviderRequest): string[] {
    return [
      "--new-project",
      "--add-dir",
      request.cwd,
      "--sandbox",
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

export function createRuntimeAdapter(name: ProviderName, config: ProviderConfig): RuntimeAdapter {
  return createProvider(name, config);
}
