import type { ModelId, ProviderConnectionId } from "./domain.js";
import type { AgentRole } from "./types.js";

export type RuntimeTransport = "subscription_cli" | "local" | "api" | "acp";
export type AuthenticationMode = "subscription" | "local_none" | "credential_reference";
export type InvocationPermission = "read_only" | "workspace_write";
export type ModelSettingValue = string | number | boolean;

export interface ProviderConnection {
  id: ProviderConnectionId;
  provider: string;
  displayName: string;
  transport: RuntimeTransport;
  authentication: AuthenticationMode;
  capabilities: {
    structuredOutput: boolean;
    streaming: boolean;
    providerManagedTools: boolean;
    modelSelection: boolean;
    modelSettings: readonly string[];
    permissions: readonly InvocationPermission[];
  };
}

export type ModelResolution =
  | "concrete"
  | "alias_resolved"
  | "provider_default_unresolved";

export interface ModelSelection {
  requestedModelId: ModelId | null;
  alias: string | null;
  settings: Readonly<Record<string, ModelSettingValue>>;
}

export interface ModelReceipt extends ModelSelection {
  resolvedModelId: ModelId;
  resolution: ModelResolution;
}

export interface InvocationRequest {
  role: AgentRole;
  prompt: string;
  cwd: string;
  permission: InvocationPermission;
  timeoutMs: number | null;
  model: ModelSelection;
}

export type InvocationEvent =
  | { type: "started"; connectionId: ProviderConnectionId; at: string }
  | { type: "stdout"; text: string; at: string }
  | { type: "stderr"; text: string; at: string }
  | { type: "completed"; exitCode: number; durationMs: number; at: string }
  | {
      type: "failed";
      kind: InvocationFailureKind;
      exitCode: number;
      retryable: boolean;
      at: string;
    };

export interface InvocationOptions {
  signal?: AbortSignal;
  onEvent?: (event: InvocationEvent) => void;
}

export interface InvocationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface RuntimeMetadata {
  adapterVersion: string;
  runtimeVersion: string | null;
}

export interface InvocationResult extends RuntimeMetadata {
  connectionId: ProviderConnectionId;
  provider: string;
  model: ModelReceipt;
  text: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  usage: InvocationUsage;
  toolRequests: readonly unknown[];
}

export type InvocationFailureKind =
  | "cancelled"
  | "timeout"
  | "authentication"
  | "quota_exhausted"
  | "model_quota_exhausted"
  | "rate_limited"
  | "context_overflow"
  | "resource_exhausted"
  | "incompatible"
  | "process_failed"
  | "unknown";

export class RuntimeInvocationError extends Error {
  constructor(
    message: string,
    readonly kind: InvocationFailureKind,
    readonly connectionId: ProviderConnectionId,
    readonly exitCode: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RuntimeInvocationError";
  }
}

export interface RuntimeAdapter {
  readonly connection: ProviderConnection;
  metadata(): Promise<RuntimeMetadata>;
  invoke(request: InvocationRequest, options?: InvocationOptions): Promise<InvocationResult>;
}

export function classifyInvocationFailure(input: {
  detail: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}): { kind: InvocationFailureKind; retryable: boolean } {
  const detail = input.detail.toLowerCase();
  if (input.aborted) return { kind: "cancelled", retryable: false };
  if (input.timedOut) return { kind: "timeout", retryable: true };
  if (/not (?:logged|signed) in|sign-in required|authentication|unauthorized|forbidden/.test(detail)) {
    return { kind: "authentication", retryable: false };
  }
  if (/maximum context|context (?:length|window).*(?:exceed|overflow|too (?:large|long))|input.*too (?:large|long)|too many tokens/.test(detail)) {
    return { kind: "context_overflow", retryable: true };
  }
  if (/model (?:allowance|quota).*(?:exhaust|exceed|limit)|(?:allowance|quota).*for (?:this |the )?model/.test(detail)) {
    return { kind: "model_quota_exhausted", retryable: true };
  }
  if (/weekly limit|usage limit|quota (?:exhausted|exceeded)|allowance/.test(detail)) {
    return { kind: "quota_exhausted", retryable: true };
  }
  if (/rate.?limit|too many requests|throttl/.test(detail)) {
    return { kind: "rate_limited", retryable: true };
  }
  if (/unknown (?:option|argument)|unsupported|incompatible|version mismatch/.test(detail)) {
    return { kind: "incompatible", retryable: false };
  }
  if (/out of memory|resource exhausted|insufficient (?:memory|vram)|cuda.*memory/.test(detail)) {
    return { kind: "resource_exhausted", retryable: true };
  }
  if (input.exitCode !== 0) return { kind: "process_failed", retryable: true };
  return { kind: "unknown", retryable: false };
}

export type InvocationFailureScope = "model" | "connection" | "task";

export function invocationFailureScope(kind: InvocationFailureKind, hasExactModel: boolean): InvocationFailureScope {
  if (kind === "cancelled") return "task";
  if (hasExactModel && ["model_quota_exhausted", "context_overflow", "resource_exhausted", "incompatible", "timeout"].includes(kind)) {
    return "model";
  }
  return "connection";
}
