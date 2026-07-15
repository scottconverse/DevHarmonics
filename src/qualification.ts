import { resolveProviderCommand } from "./config.js";
import { domainId } from "./domain.js";
import type { Ledger } from "./ledger.js";
import { classifyWorkload, inferModelProfile, reasoningEffortFitScore, tierFitScore } from "./model-intelligence.js";
import { modelQualificationFingerprint } from "./model-fingerprint.js";
import type { ConnectionRecord, ModelRecord } from "./registry.js";
import { qualifyOllamaModel, qualifyOllamaSpecialistModel, qualifyOllamaToolModel } from "./ollama.js";
import { createRuntimeAdapter } from "./providers.js";
import type { AgentRole, DevHarmonicsConfig, PlannedTask, ProviderName } from "./types.js";
import type { InvocationPermission, RuntimeAdapter } from "./runtime.js";
import { modelQuotaGroup } from "./antigravity.js";

export type QualificationRole = "general" | "architect" | "worker" | "reviewer" | "analysis" | "benchmark" | "local_tools";

export const QUALIFICATION_FINGERPRINT_FIXTURE = "model-qualification-suite-v2";
const qualificationFlights = new Map<string, Promise<QualificationOutcome>>();

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
  const currentQualification = hasCurrentRoleQualification(input.ledger, refreshed, qualificationRole, input.permission);
  const specialistBenchmarkRequired = inferModelProfile(refreshed, connection).family.startsWith("mellum2");
  const currentBenchmark = !specialistBenchmarkRequired || hasCurrentRoleQualification(input.ledger, refreshed, "benchmark", "read_only");
  if (refreshed.qualified && !refreshed.qualificationStale && currentQualification && currentBenchmark) {
    const activated = refreshed.active || connection.provider === "openrouter"
      ? refreshed.active
      : input.ledger.setModelPreference(refreshed.id, { active: true }).active;
    return { modelId: refreshed.id, connectionId: connection.id, provider: connection.provider, role: qualificationRole, attempted: false, passed: true, activated, reason };
  }

  const probe = async (role: QualificationRole): Promise<QualificationOutcome> => {
    const flightKey = `${refreshed.id}\u0000${fingerprint}\u0000${role}`;
    const existing = qualificationFlights.get(flightKey);
    if (existing) return existing;
    const flight = (async (): Promise<QualificationOutcome> => {
      try {
        const probed = await (input.qualify
          ? input.qualify({ model: refreshed, connection, role })
          : qualifyRuntimeModel({ model: refreshed, connection, config: input.config, cwd: input.cwd, role }));
        return { ...probed, role };
      } catch (error) {
        return {
          fixtureVersion: qualificationFixtureVersion(connection.transport, role),
          role,
          passed: false,
          score: 0,
          evidence: { connectionId: connection.id, requestedModelId: refreshed.id, error: error instanceof Error ? error.message : String(error) },
        };
      }
    })();
    qualificationFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (qualificationFlights.get(flightKey) === flight) qualificationFlights.delete(flightKey);
    }
  };

  let attempted = false;
  if (!(refreshed.qualified && !refreshed.qualificationStale && currentQualification)) {
    attempted = true;
    const outcome = await probe(qualificationRole);
    input.ledger.recordModelQualification({ modelId: refreshed.id, ...outcome, fingerprint });
    if (!outcome.passed) {
      input.ledger.recordModelOutcome(refreshed.id, { success: false, failureKind: "incompatible", detail: `Scheduler-time ${qualificationRole} qualification failed` });
      return { modelId: refreshed.id, connectionId: connection.id, provider: connection.provider, role: qualificationRole, attempted, passed: false, activated: false, reason };
    }
  }
  if (specialistBenchmarkRequired && !currentBenchmark) {
    attempted = true;
    const benchmark = await probe("benchmark");
    input.ledger.recordModelQualification({ modelId: refreshed.id, ...benchmark, fingerprint });
    if (!benchmark.passed) {
      input.ledger.recordModelOutcome(refreshed.id, { success: false, failureKind: "incompatible", detail: "Scheduler-time specialist benchmark failed" });
      return { modelId: refreshed.id, connectionId: connection.id, provider: connection.provider, role: qualificationRole, attempted, passed: false, activated: false, reason };
    }
  }
  input.ledger.recordModelOutcome(refreshed.id, { success: true, detail: specialistBenchmarkRequired ? `Scheduler-time ${qualificationRole} qualification and specialist benchmark passed` : `Scheduler-time ${qualificationRole} qualification passed` });
  const activated = connection.provider === "openrouter" ? false : input.ledger.setModelPreference(refreshed.id, { active: true }).active;
  return { modelId: refreshed.id, connectionId: connection.id, provider: connection.provider, role: qualificationRole, attempted, passed: true, activated, reason };
}

export async function ensureSchedulerProviderCandidateQualified(input: Parameters<typeof ensureSchedulerCandidateQualified>[0] & {
  excludedModelIds: Set<string>;
  onResult?: (result: SchedulerQualificationResult) => void;
}): Promise<SchedulerQualificationResult | null> {
  let lastFailure: SchedulerQualificationResult | null = null;
  while (true) {
    const result = await ensureSchedulerCandidateQualified(input);
    if (!result) return lastFailure;
    input.onResult?.(result);
    if (result.passed) return result;
    input.excludedModelIds.add(result.modelId);
    lastFailure = result;
  }
}

export async function ensureReviewerCandidateQualified(input: {
  ledger: Ledger;
  config: DevHarmonicsConfig;
  cwd: string;
  providers: readonly string[];
  excludedModelIds?: ReadonlySet<string>;
  excludedConnectionIds?: ReadonlySet<string>;
  qualify?: (input: { model: ModelRecord; connection: ConnectionRecord; role: QualificationRole }) => Promise<QualificationOutcome>;
  onResult?: (result: SchedulerQualificationResult) => void;
}): Promise<SchedulerQualificationResult | null> {
  for (const provider of input.providers) {
    const result = await ensureSchedulerCandidateQualified({
      ledger: input.ledger,
      config: input.config,
      cwd: input.cwd,
      role: "reviewer",
      preferredProvider: provider,
      permission: "read_only",
      ...(input.excludedModelIds ? { excludedModelIds: input.excludedModelIds } : {}),
      ...(input.excludedConnectionIds ? { excludedConnectionIds: input.excludedConnectionIds } : {}),
      ...(input.qualify ? { qualify: input.qualify } : {}),
    });
    if (!result) continue;
    input.onResult?.(result);
    if (result.passed) return result;
  }
  return null;
}

export function trackedFamilyQualificationRole(transport: ConnectionRecord["transport"], role: QualificationRole): QualificationRole {
  if (transport !== "local") return role;
  return role === "worker" ? "local_tools" : "analysis";
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
    const quotaGroup = modelQuotaGroup(model);
    if (!connection.available || !input.ledger.isConnectionEligible(connection.id) || !input.ledger.isModelEligible(model.id) || (quotaGroup && !input.ledger.isQuotaGroupEligible(connection.id, quotaGroup.id))) return [];
    if (connection.transport === "api") return []; // Paid probes always require an explicit user confirmation.
    const assigned = assignmentId === model.id;
    if (!assigned && connection.provider !== input.preferredProvider) return [];
    const profile = inferModelProfile(model, connection);
    const fit = tierFitScore(profile.tier, workload.requiredTier);
    if ((!assigned && fit === null) || !supportsQualificationTask(profile.capabilities, input.task, connection.transport, input.permission)) return [];
    const effectiveFit = fit ?? 0;
    const qualificationRole: QualificationRole = connection.transport === "local" ? input.permission === "workspace_write" ? "local_tools" : "analysis" : input.role;
    const current = model.qualificationFingerprint !== null
      && model.qualified
      && !model.qualificationStale
      && hasCurrentRoleQualification(input.ledger, model, qualificationRole, input.permission);
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

export function hasCurrentRoleQualification(ledger: Ledger, model: ModelRecord, role: QualificationRole, permission: InvocationPermission): boolean {
  return ledger.listModelQualifications(model.id).some((qualification) => {
    if (!qualification.passed || qualification.fingerprint !== model.qualificationFingerprint) return false;
    if (qualification.role === "general" || qualification.role === role) return true;
    return qualification.role === "analysis" && permission === "read_only" && role !== "architect";
  });
}

export function hasCurrentOperationalQualification(ledger: Ledger, model: ModelRecord): boolean {
  return ledger.listModelQualifications(model.id).some((qualification) => qualification.passed
    && qualification.fingerprint === model.qualificationFingerprint
    && qualification.role !== "benchmark");
}

function supportsQualificationTask(capabilities: readonly string[], task: PlannedTask | null | undefined, transport: ConnectionRecord["transport"], permission: InvocationPermission): boolean {
  if (capabilities.includes("embedding") && !capabilities.includes("text")) return false;
  const needs = (task?.capabilityNeeds ?? []).map((item) => item.toLowerCase());
  if (transport === "local" && permission === "read_only" && needs.includes("tools")) return false;
  if (needs.includes("vision") && !capabilities.includes("vision")) return false;
  if (needs.includes("code") && !capabilities.includes("code")) return false;
  if (needs.includes("tools") && !capabilities.includes("tools")) return false;
  if (needs.includes("structured-output") && !capabilities.includes("structured-output") && !capabilities.includes("tools")) return false;
  if (capabilities.includes("cyber-restricted") && needs.some((need) => need === "security" || need === "cybersecurity" || need === "authentication")) return false;
  return true;
}

export function qualificationFixtureVersion(transport: ConnectionRecord["transport"], role: QualificationRole): string {
  if (transport === "local") return role === "local_tools" ? "local-tools-v1" : role === "benchmark" ? "local-specialist-v2" : "local-analysis-v1";
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
    return role === "local_tools"
      ? qualifyOllamaToolModel(input.model.id, baseUrl, input.connection.id, input.model.canonicalName)
      : role === "benchmark"
        ? qualifyOllamaSpecialistModel(input.model.id, input.cwd, baseUrl, input.connection.id, input.model.canonicalName)
      : qualifyOllamaModel(input.model.id, input.cwd, baseUrl, input.connection.id, input.model.canonicalName);
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
    role: input.role === "general" || input.role === "analysis" || input.role === "benchmark" || input.role === "local_tools" ? "worker" : input.role,
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
