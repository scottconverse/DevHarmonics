import { createHash, randomBytes } from "node:crypto";
import { domainId } from "./domain.js";
import type { Ledger } from "./ledger.js";
import { VERSION } from "./product.js";
import type { ConnectionRegistryInput, ModelRecord } from "./registry.js";
import { RuntimeInvocationError, type InvocationOptions, type InvocationRequest, type InvocationResult, type RuntimeAdapter, type RuntimeMetadata } from "./runtime.js";
import { CredentialStore } from "./credential-store.js";
import type { DevHarmonicsConfig } from "./types.js";

export const OPENROUTER_CONNECTION_ID = "api:openrouter";
export const OPENROUTER_MAX_OUTPUT_TOKENS = 2_000;
const OPENROUTER_API = "https://openrouter.ai/api/v1";
const OPENROUTER_AUTH = "https://openrouter.ai/auth";
const CREDENTIAL_NAME = "openrouter-oauth";

export interface OpenRouterCatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  modalities: string[];
  metadata: Readonly<Record<string, unknown>>;
}

export class OpenRouterService {
  private readonly pending = new Map<string, { verifier: string; createdAt: number }>();

  constructor(private readonly ledger: Ledger, private readonly credentials = new CredentialStore()) {}

  async syncConnection(enabled: boolean): Promise<void> {
    const connected = await this.credentials.has(CREDENTIAL_NAME);
    this.ledger.upsertConnection(openRouterConnection(enabled, connected));
  }

  async syncCatalog(): Promise<OpenRouterCatalogModel[]> {
    const response = await fetch(`${OPENROUTER_API}/models`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`OpenRouter models catalog returned HTTP ${response.status}`);
    const json = await response.json() as { data?: unknown[] };
    const models = (json.data ?? []).flatMap((raw) => parseCatalogModel(raw));
    this.ledger.upsertProviderCatalogModels("openrouter", models.map((model) => ({
      id: model.id,
      canonicalName: model.id,
      displayName: model.name,
      metadata: model.metadata,
    })), 3);
    this.ledger.recordCatalogRefresh({ provider: "openrouter", status: "success", source: `${OPENROUTER_API}/models`, modelCount: models.length, detail: "OpenRouter public model catalog refreshed; no models were activated or probed" });
    return models;
  }

  async status(): Promise<{ connected: boolean; key: Record<string, unknown> | null }> {
    const key = await this.credentials.get(CREDENTIAL_NAME);
    if (!key) return { connected: false, key: null };
    try {
      const response = await fetch(`${OPENROUTER_API}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return { connected: false, key: null };
      const body = await response.json() as { data?: Record<string, unknown> };
      return { connected: true, key: body.data ?? null };
    } catch {
      return { connected: true, key: null };
    }
  }

  beginOAuth(callbackUrl: string): string {
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.pending.set(state, { verifier, createdAt: Date.now() });
    const url = new URL(OPENROUTER_AUTH);
    url.searchParams.set("callback_url", callbackUrl);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async completeOAuth(code: string, state?: string | null): Promise<void> {
    const pendingEntry = state
      ? [state, this.pending.get(state)] as const
      : this.pending.size === 1
        ? [...this.pending.entries()][0]
        : undefined;
    const pending = pendingEntry?.[1];
    if (pendingEntry) this.pending.delete(pendingEntry[0]);
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error("OpenRouter OAuth state is missing or expired");
    const response = await fetch(`${OPENROUTER_API}/auth/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: "S256" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`OpenRouter OAuth key exchange failed with HTTP ${response.status}`);
    const body = await response.json() as { key?: unknown };
    if (typeof body.key !== "string" || !body.key) throw new Error("OpenRouter OAuth response did not contain a usable credential");
    await this.credentials.set(CREDENTIAL_NAME, body.key);
  }

  async disconnect(): Promise<void> {
    await this.credentials.delete(CREDENTIAL_NAME);
  }

  async adapter(): Promise<OpenRouterAdapter> {
    const key = await this.credentials.get(CREDENTIAL_NAME);
    if (!key) throw new Error("OpenRouter is not connected");
    return new OpenRouterAdapter(key);
  }

  async assertPaidRoutingAllowed(config: DevHarmonicsConfig, runId: string, estimatedCostUsd = 0): Promise<void> {
    const reservation = await this.acquirePaidRouting(config, runId, estimatedCostUsd);
    reservation.cancelBeforeInvocation();
  }

  async assertPaidWorkbenchAllowed(config: DevHarmonicsConfig, sessionId: string, estimatedCostUsd = 0): Promise<void> {
    const reservation = await this.acquirePaidWorkbench(config, sessionId, estimatedCostUsd);
    reservation.cancelBeforeInvocation();
  }

  async acquirePaidRouting(config: DevHarmonicsConfig, runId: string, estimatedCostUsd = 0): Promise<PaidSpendReservation> {
    return this.acquirePaidSpend(config, "run", runId, estimatedCostUsd);
  }

  async acquirePaidWorkbench(config: DevHarmonicsConfig, sessionId: string, estimatedCostUsd = 0): Promise<PaidSpendReservation> {
    return this.acquirePaidSpend(config, "workbench", sessionId, estimatedCostUsd);
  }

  async withPaidRoutingAllowed<T>(config: DevHarmonicsConfig, runId: string, estimatedCostUsd: number, action: () => Promise<T>): Promise<T> {
    const reservation = await this.acquirePaidRouting(config, runId, estimatedCostUsd);
    try {
      const result = await action();
      reservation.settleAfterDurableReceipt();
      return result;
    } catch (error) {
      // The provider may have accepted and charged a request before the failure
      // became visible. Keep the conservative reservation until reconciled.
      throw error;
    }
  }

  private async acquirePaidSpend(config: DevHarmonicsConfig, scopeType: "run" | "workbench", scopeId: string, estimatedCostUsd: number): Promise<PaidSpendReservation> {
    if (!config.openRouter.enabled || !config.openRouter.allowPaidFallback || !config.runPolicy.allowPaidApi) {
      throw new Error("OpenRouter paid routing is disabled by policy");
    }
    if (config.openRouter.perRunLimitUsd <= 0 || config.openRouter.monthlyLimitUsd <= 0) {
      throw new Error("OpenRouter requires positive per-run and monthly spending limits");
    }
    const reservationId = this.ledger.reservePaidSpend({
      scopeType,
      scopeId,
      estimatedCostUsd,
      perScopeLimitUsd: config.openRouter.perRunLimitUsd,
      monthlyLimitUsd: config.openRouter.monthlyLimitUsd,
    });
    try {
      const status = await this.status();
      if (!status.connected) throw new Error("OpenRouter OAuth connection is unavailable");
      if (!status.key) throw new Error("OpenRouter key limits and credits could not be verified; paid routing is stopped");
      const remaining = numeric(status.key?.limit_remaining);
      if (remaining !== null && remaining < estimatedCostUsd) throw new Error(`OpenRouter key has only $${remaining.toFixed(4)} remaining`);
    } catch (error) {
      this.ledger.releasePaidSpendReservation(reservationId);
      throw error;
    }
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.ledger.releasePaidSpendReservation(reservationId);
    };
    return { settleAfterDurableReceipt: close, cancelBeforeInvocation: close };
  }

  async assertQualificationCredit(estimatedCostUsd: number | null): Promise<void> {
    const status = await this.status();
    if (!status.connected || !status.key) throw new Error("OpenRouter key limits and credits could not be verified; the paid qualification was stopped");
    const remaining = numeric(status.key.limit_remaining);
    if (remaining !== null && estimatedCostUsd !== null && remaining < estimatedCostUsd) {
      throw new Error(`OpenRouter key has only $${remaining.toFixed(4)} remaining, below the estimated qualification cost`);
    }
  }

  activateCatalogModel(canonicalName: string): ModelRecord {
    if (!isExactOpenRouterModelId(canonicalName)) throw new Error("Moving OpenRouter aliases cannot be imported; choose an exact versioned model identifier");
    const catalog = this.ledger.listProviderCatalogModels("openrouter").find((model) => model.canonicalName === canonicalName && !model.retired);
    if (!catalog) throw new Error(`OpenRouter model '${canonicalName}' is not in the current catalog`);
    const id = `api:openrouter:model:${canonicalName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
    this.ledger.upsertDiscoveredModel({
      id,
      connectionId: OPENROUTER_CONNECTION_ID,
      canonicalName,
      displayName: catalog.displayName,
      source: "provider_catalog",
      lifecycle: "known",
      visible: true,
      verified: false,
      qualified: false,
      active: false,
      metadata: catalog.metadata,
    });
    return this.ledger.getModel(id)!;
  }
}

export function isExactOpenRouterModelId(modelId: string): boolean {
  return !modelId.startsWith("~") && !/(?:^|[-/:])(latest|auto)(?:$|[-/:])/i.test(modelId);
}

export class OpenRouterAdapter implements RuntimeAdapter {
  readonly connection = {
    id: domainId("ProviderConnection", OPENROUTER_CONNECTION_ID),
    provider: "openrouter",
    displayName: "OpenRouter",
    transport: "api" as const,
    authentication: "credential_reference" as const,
    capabilities: { structuredOutput: true, streaming: false, providerManagedTools: false, modelSelection: true, modelSettings: [] as string[], permissions: ["read_only"] as const },
  };

  constructor(private readonly key: string) {}

  async metadata(): Promise<RuntimeMetadata> {
    return { adapterVersion: VERSION, runtimeVersion: "OpenRouter API v1" };
  }

  async invoke(request: InvocationRequest, options: InvocationOptions = {}): Promise<InvocationResult> {
    if (request.permission !== "read_only") throw new RuntimeInvocationError("OpenRouter has no DevHarmonics workspace tool harness and is read-only", "incompatible", this.connection.id, 0, false);
    if (!request.model.alias) throw new RuntimeInvocationError("OpenRouter requires an exact selected model", "incompatible", this.connection.id, 0, false);
    if (!Number.isSafeInteger(request.maxOutputTokens) || Number(request.maxOutputTokens) <= 0) {
      throw new RuntimeInvocationError("OpenRouter requires a positive hard completion-token ceiling", "incompatible", this.connection.id, 0, false);
    }
    const started = Date.now();
    options.onEvent?.({ type: "started", connectionId: this.connection.id, at: new Date().toISOString() });
    const response = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/scottconverse/DevHarmonics", "X-Title": "DevHarmonics" },
      body: JSON.stringify({ model: request.model.alias, messages: [{ role: "user", content: request.prompt }], max_completion_tokens: request.maxOutputTokens, provider: { allow_fallbacks: false, require_parameters: true } }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(request.timeoutMs ?? 120_000)]) : AbortSignal.timeout(request.timeoutMs ?? 120_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      const kind = response.status === 401 || response.status === 403 ? "authentication" : response.status === 402 ? "quota_exhausted" : response.status === 429 ? "rate_limited" : "process_failed";
      throw new RuntimeInvocationError(`OpenRouter returned HTTP ${response.status}: ${raw}`, kind, this.connection.id, response.status, kind === "rate_limited" || kind === "process_failed");
    }
    const body = JSON.parse(raw) as { model?: string; provider?: string; choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
    const text = typeof body.choices?.[0]?.message?.content === "string" ? body.choices[0].message.content : "";
    if (!text) throw new RuntimeInvocationError("OpenRouter returned no text response", "incompatible", this.connection.id, 0, false);
    const durationMs = Date.now() - started;
    options.onEvent?.({ type: "completed", exitCode: 0, durationMs, at: new Date().toISOString() });
    return {
      connectionId: this.connection.id,
      provider: body.provider || "openrouter",
      ...(await this.metadata()),
      model: { ...request.model, resolvedModelId: domainId("Model", `api:openrouter:model:${body.model ?? request.model.alias}`), resolution: "concrete" },
      text,
      stdout: raw,
      stderr: "",
      exitCode: 0,
      durationMs,
      usage: { inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null, costUsd: body.usage?.cost ?? null },
      toolRequests: [],
    };
  }
}

export function estimateQualificationCost(model: { metadata: Readonly<Record<string, unknown>> }): number | null {
  const prompt = numeric(model.metadata.promptPrice);
  const completion = numeric(model.metadata.completionPrice);
  return prompt === null || completion === null ? null : prompt * 220 + completion * 12;
}

export function estimateInvocationCost(model: { metadata: Readonly<Record<string, unknown>> }, _prompt: string, outputTokenBudget = OPENROUTER_MAX_OUTPUT_TOKENS): number | null {
  const promptPrice = numeric(model.metadata.promptPrice);
  const completionPrice = numeric(model.metadata.completionPrice);
  const contextLength = numeric(model.metadata.contextLength);
  if (promptPrice === null || completionPrice === null || contextLength === null || contextLength < 1 || !Number.isSafeInteger(outputTokenBudget) || outputTokenBudget < 1) return null;
  const boundedOutput = Math.min(outputTokenBudget, contextLength);
  const requestPricing = model.metadata.pricing && typeof model.metadata.pricing === "object" ? model.metadata.pricing as Record<string, unknown> : {};
  const requestPrice = numeric(requestPricing.request) ?? 0;
  // Total native tokens cannot exceed the model context. Reserving prompt-price
  // across the entire context plus any higher completion-price delta is a hard
  // upper bound once max_completion_tokens is sent with the request.
  return requestPrice + promptPrice * contextLength + Math.max(0, completionPrice - promptPrice) * boundedOutput;
}

export function requireInvocationCostCeiling(model: { metadata: Readonly<Record<string, unknown>> }, prompt: string, outputTokenBudget = OPENROUTER_MAX_OUTPUT_TOKENS): number {
  const ceiling = estimateInvocationCost(model, prompt, outputTokenBudget);
  if (ceiling === null) throw new Error("OpenRouter paid routing requires current prompt price, completion price, and context length metadata");
  return ceiling;
}

export interface PaidSpendReservation {
  settleAfterDurableReceipt(): void;
  cancelBeforeInvocation(): void;
}

function openRouterConnection(enabled: boolean, connected: boolean): ConnectionRegistryInput {
  return {
    id: OPENROUTER_CONNECTION_ID,
    provider: "openrouter",
    transport: "api",
    authentication: "credential_reference",
    displayName: "OpenRouter",
    enabled,
    installed: true,
    authenticated: connected,
    visible: connected,
    healthy: connected,
    available: enabled && connected,
    entitlement: connected ? "connected" : "unknown",
    capacity: "unknown",
    adapterVersion: VERSION,
    runtimeVersion: "OpenRouter API v1",
    metadata: { summary: connected ? "OAuth connected; paid routing still requires separate policy and budget gates" : "OAuth is not connected; paid routing is impossible", oauth: true, paidRoutingRequiresSeparatePolicy: true, serverSideFallbackDisabled: true },
  };
}

function parseCatalogModel(raw: unknown): OpenRouterCatalogModel[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string") return [];
  const pricing = value.pricing && typeof value.pricing === "object" ? value.pricing as Record<string, unknown> : {};
  const architecture = value.architecture && typeof value.architecture === "object" ? value.architecture as Record<string, unknown> : {};
  const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.filter((item): item is string => typeof item === "string") : [];
  const outputModalities = Array.isArray(architecture.output_modalities) ? architecture.output_modalities.filter((item): item is string => typeof item === "string") : [];
  const promptPrice = numeric(pricing.prompt);
  const completionPrice = numeric(pricing.completion);
  const contextLength = numeric(value.context_length);
  return [{
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    contextLength,
    promptPrice,
    completionPrice,
    modalities: [...new Set([...inputModalities, ...outputModalities])],
    metadata: { contextLength, promptPrice, completionPrice, modalities: [...new Set([...inputModalities, ...outputModalities])], architecture, pricing, supportedParameters: value.supported_parameters ?? [] },
  }];
}

function numeric(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}
