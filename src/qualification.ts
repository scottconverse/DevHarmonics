import { resolveProviderCommand } from "./config.js";
import { domainId } from "./domain.js";
import type { Ledger } from "./ledger.js";
import { classifyWorkload, inferModelProfile, reasoningEffortFitScore, tierFitScore } from "./model-intelligence.js";
import { modelQualificationFingerprint } from "./model-fingerprint.js";
import type { ConnectionRecord, ModelRecord } from "./registry.js";
import { qualifyOllamaModel } from "./ollama.js";
import { createRuntimeAdapter } from "./providers.js";
import type { AgentRole, DevHarmonicsConfig, PlannedTask, ProviderName } from "./types.js";
import type { InvocationPermission, RuntimeAdapter } from "./runtime.js";

export type QualificationRole = "general" | "architect" | "worker" | "reviewer" | "analysis" | "benchmark";

export const QUALIFICATION_FINGERPRINT_FIXTURE = "model-qualification-suite-v1";

export interface QualificationOutcome {
  fixtureVersion: string;
  role: QualificationRole;
  passed: boolean;
  score: number;
  evidence: Readonly<Record<string, unknown>>;
}

export interface SchedulerQualificationResult {
  modelId: string;
  connectionId: string;
  provider: string;
  role: QualificationRole;
  attempted: boolean;
  passed: boolean;
  activated: boolean;
  reason: string;
}

export async function ensureSchedulerCandidateQualified(input: {
  ledger: Ledger;
  config: DevHarmonicsConfig;
  cwd: string;
  role: AgentRole;
  preferredProvider: string;
  permission: InvocationPermission;
  task?: PlannedTask | null;
  excludedModelIds?: ReadonlySet<string>;
  excludedConnectionIds?: ReadonlySet<string>;
  qualify?: (input: { model: ModelRecord; connection: ConnectionRecord; role: QualificationRole }) => Promise<QualificationOutcome>;
}): Promise<SchedulerQualificationResult | null> {
  const selected = selectSchedulerQualificationCandidate(input);
  if (!selected) return null;
  const { model, connection, qualificationRole, reason } = selected;
  const fingerprint = modelQualificationFingerprint(model, connection, QUALIFICATION_FINGERPRINT_FIXTURE);
  input.ledger.applyModelFingerprint(model.id, fingerprint);
  const refreshed = input.ledger.getModel(model.id)!;
  const currentQualification = hasCurrentRoleQualification(input.ledger, refreshed, qualificationRole, input.permission, fingerprint);
  if (refreshed.qualified && !refreshed.qualificationStale && currentQualification) {
    const activated = refreshed.active || connection.provider === "openrouter"
      ? refreshed.active
      : input.ledger.setModelPreference(refreshed.id, { active: true }).active;
    return { modelId: refreshed.id, connectionId: connection.id, provider: connection.provider, role: qualificationRole, attempted: false, passed: true, activated, reason };
  }

  let outcome: QualificationOutcome;
  try {
    const probed = await (input.qualify
      ? input.qualify({ model: refreshed, connection, role: qualificationRole })
      : qualifyRuntimeModel({ model: refreshed, connection, config: input.config, cwd: input.cwd, role: qualificationRole }));
    outcome = { ...probed, role: qualificationRole };
  } catch (error) {
    outcome = {
      fixtureVersion: qualificationFixtureVersion(connection.transport, qualificationRole),
      role: qualificationRole,
      passed: false,
      score: 0,
      evidence: { connectionId: connection.id, requestedModelId: refreshed.id, error: error instanceof Error ? error.message : String(error) },
    };
  }
  input.ledger.recordModelQualification({ modelId: refreshed.id, ...outcome, fingerprint });
  if (!outcome.passed) {
    input.ledger.recordModelOutcome(refreshed.id, { success: false, failureKind: "incompatible", detail: `Scheduler-time ${qualificationRole} qualification failed` });
    return { modelId: refreshed.id, connectionId: connection.id, provider: connection.provider, role: qualificationRole, attempted: true, passed: false, activated: false, reason };
  }
  input.ledger.recordModelOutcome(refreshed.id, { success: true, detail: `Scheduler-time ${qualificationRole} qualification passed` });
  const activated = connection.provider === "openrouter" ? false : input.ledger.setModelPreference(refreshed.id, { active: true }).active;
  return { modelId: refreshed.id, connectionId: connection.id, provider: connection.provider, role: qualificationRole, attempted: true, passed: true, activated, reason };
}

function selectSchedulerQualificationCandidate(input: {
  ledger: Ledger;
  config: DevHarmonicsConfig;
  role: AgentRole;
  preferredProvider: string;
  permission: InvocationPermission;
  task?: PlannedTask | null;
  excludedModelIds?: ReadonlySet<string>;
  excludedConnectionIds?: ReadonlySet<string>;
}): { model: ModelRecord; connection: ConnectionRecord; qualificationRole: QualificationRole; reason: string } | null {
  const assignmentId = input.config.routing[input.role].modelId;
  const workload = classifyWorkload(input.role, input.task, input.config.routing[input.role].preferredTier);
  const connections = new Map(input.ledger.listConnections().map((connection) => [connection.id, connection]));
  const eligible = input.ledger.listModels().flatMap((model) => {
    const connection = connections.get(model.connectionId);
    if (!connection || model.retired || model.excluded || input.excludedModelIds?.has(model.id) || input.excludedConnectionIds?.has(connection.id)) return [];
    if (!connection.available || !input.ledger.isConnectionEligible(connection.id) || !input.ledger.isModelEligible(model.id)) return [];
    if (connection.transport === "api") return []; // Paid probes always require an explicit user confirmation.
    if (connection.transport === "local" && input.permission === "workspace_write") return [];
    const assigned = assignmentId === model.id;
    if (!assigned && connection.provider !== input.preferredProvider) return [];
    const profile = inferModelProfile(model, connection);
    const fit = tierFitScore(profile.tier, workload.requiredTier);
    if ((!assigned && fit === null) || !supportsQualificationTask(profile.capabilities, input.task)) return [];
    const effectiveFit = fit ?? 0;
    const qualificationRole: QualificationRole = connection.transport === "local" ? "analysis" : input.role;
    const current = model.qualificationFingerprint !== null
      && model.qualified
      && !model.qualificationStale
      && hasCurrentRoleQualification(input.ledger, model, qualificationRole, input.permission, model.qualificationFingerprint);
    const score = (assigned ? 1_000 : 0)
      + (model.pinned ? 200 : 0)
      + (model.active ? 20 : 0)
      + (current ? 20 : 0)
      + effectiveFit * 10
      + reasoningEffortFitScore(profile.reasoningEffort, workload.requiredTier);
    return [{ model, connection, qualificationRole, current, score, assigned }];
  }).sort((left, right) => right.score - left.score || left.model.id.localeCompare(right.model.id));
  const selected = eligible[0];
  if (!selected) return null;
  return {
    model: selected.model,
    connection: selected.connection,
    qualificationRole: selected.qualificationRole,
    reason: selected.assigned ? "configured role assignment selected for first-use qualification" : `best ${workload.requiredTier} candidate selected for ${input.preferredProvider}`,
  };
}

function hasCurrentRoleQualification(ledger: Ledger, model: ModelRecord, role: QualificationRole, permission: InvocationPermission, fingerprint: string): boolean {
  return ledger.listModelQualifications(model.id).some((qualification) => {
    if (!qualification.passed || qualification.fingerprint !== fingerprint) return false;
    if (qualification.role === "general" || qualification.role === role) return true;
    return qualification.role === "analysis" && permission === "read_only" && role !== "architect";
  });
}

function supportsQualificationTask(capabilities: readonly string[], task?: PlannedTask | null): boolean {
  if (capabilities.includes("embedding") && !capabilities.includes("text")) return false;
  const needs = (task?.capabilityNeeds ?? []).map((item) => item.toLowerCase());
  if (needs.includes("vision") && !capabilities.includes("vision")) return false;
  if (capabilities.includes("cyber-restricted") && needs.some((need) => need === "security" || need === "cybersecurity" || need === "authentication")) return false;
  return true;
}

export function qualificationFixtureVersion(transport: ConnectionRecord["transport"], role: QualificationRole): string {
  if (transport === "local") return "local-analysis-v1";
  return `${transport === "api" ? "api" : "subscription"}-${role}-v1`;
}

export async function qualifyRuntimeModel(input: {
  model: ModelRecord;
  connection: ConnectionRecord;
  config: DevHarmonicsConfig;
  cwd: string;
  role?: QualificationRole;
}) {
  const role = input.role ?? "general";
  if (input.connection.transport === "local") {
    if (input.connection.provider !== "ollama") throw new Error(`No qualification adapter exists for local provider '${input.connection.provider}'`);
    const baseUrl = typeof input.connection.metadata.baseUrl === "string" ? input.connection.metadata.baseUrl : undefined;
    return qualifyOllamaModel(input.model.id, input.cwd, baseUrl, input.connection.id, input.model.canonicalName);
  }

  if (!isSubscriptionProvider(input.connection.provider)) {
    throw new Error(`No subscription qualification adapter exists for '${input.connection.provider}'`);
  }
  const provider = input.connection.provider;
  const adapter = createRuntimeAdapter(provider, {
    ...input.config.connections[provider],
    command: resolveProviderCommand(provider, input.config.connections[provider].command),
  });
  return qualifyWithAdapter({ adapter, model: input.model, cwd: input.cwd, role, provider });
}

export async function qualifyWithAdapter(input: {
  adapter: RuntimeAdapter;
  model: ModelRecord;
  cwd: string;
  role: QualificationRole;
  provider: string;
}) {
  const fixture = qualificationFixture(input.role);
  const result = await input.adapter.invoke({
    role: input.role === "general" || input.role === "analysis" || input.role === "benchmark" ? "worker" : input.role,
    prompt: fixture.prompt,
    cwd: input.cwd,
    permission: "read_only",
    timeoutMs: 2 * 60_000,
    model: {
      requestedModelId: domainId("Model", input.model.id),
      alias: input.model.canonicalName,
      settings: input.provider === "gemini" ? {} : input.provider === "openrouter" ? {} : { effort: "low" },
    },
  });
  const passed = fixture.accept(result.text);
  return {
    fixtureVersion: qualificationFixtureVersion(input.adapter.connection.transport, input.role),
    role: input.role,
    passed,
    score: passed ? 1 : 0,
    evidence: {
      connectionId: result.connectionId,
      requestedModelId: input.model.id,
      resolvedModelId: result.model.resolvedModelId,
      modelResolution: result.model.resolution,
      durationMs: result.durationMs,
      responseMatched: passed,
      probeSpentApiDollars: input.adapter.connection.transport === "api",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
    },
  };
}

function qualificationFixture(role: QualificationRole): { prompt: string; accept(text: string): boolean } {
  if (role === "benchmark") {
    const marker = "DEVHARMONICS_BENCHMARK_QUALIFIED|17|BLUE";
    return {
      prompt: "DevHarmonics deterministic baseline benchmark v1. Do not use tools or modify files. Compute (6 * 3) - 1, uppercase the color of a clear daytime sky, and reply exactly as DEVHARMONICS_BENCHMARK_QUALIFIED|<number>|<color> with no other text.",
      accept: (text) => text.trim() === marker,
    };
  }
  const marker = `DEVHARMONICS_${role.toUpperCase()}_QUALIFIED`;
  return {
    prompt: `DevHarmonics non-destructive ${role} qualification fixture v1. Do not use tools or modify files. Reply with exactly ${marker} and no other text.`,
    accept: (text) => text.trim() === marker,
  };
}

function isSubscriptionProvider(value: string): value is ProviderName {
  return value === "codex" || value === "claude" || value === "gemini";
}
