import { domainId } from "./domain.js";
import type { Ledger } from "./ledger.js";
import { classifyWorkload, effortForTier, inferModelProfile, reasoningEffortFitScore, tierFitScore, type ModelProfile, type WorkloadClassification } from "./model-intelligence.js";
import type { ConnectionRecord, ModelRecord } from "./registry.js";
import type { InvocationPermission, ModelSelection, RuntimeTransport } from "./runtime.js";
import type { ModelPerformanceSlice } from "./model-performance.js";
import type { AgentRole, DevHarmonicsConfig, PlannedTask, ProviderName } from "./types.js";
import { modelQuotaGroup } from "./antigravity.js";

export interface RoutingDecision {
  role: AgentRole;
  provider: string;
  connectionId: string;
  transport: RuntimeTransport;
  model: ModelSelection;
  score: number;
  scoreBreakdown: RoutingScoreBreakdown;
  factors: string[];
  fallback: boolean;
  workload: WorkloadClassification;
}

export interface RoutingScoreBreakdown {
  manualAssignment: number;
  baseEligibility: number;
  tierFit: number;
  reasoningFit: number;
  userPin: number;
  preferredProvider: number;
  fallbackProvider: number;
  empiricalReliability: number;
  empiricalLatency: number;
  providerDiversity: number;
  costAwareness: number;
}

/**
 * No model can take this work — a routine, expected answer, not a defect.
 *
 * Distinguished from every other error `route` can raise so that a caller
 * asking "can anything run this?" can answer it without swallowing a genuine
 * bug as a negative.
 */
export class RoutingUnavailableError extends Error {}

export interface RouteInput {
  role: AgentRole;
  config: DevHarmonicsConfig;
  /**
   * Preferred subscription provider, or null when no subscription connection is
   * usable and only local runtimes remain. Null is a legitimate state, not an
   * error: local models carry no subscription quota and are selected on their
   * own qualification.
   */
  fallbackProvider: ProviderName | null;
  allowedProviders: readonly string[];
  permission: InvocationPermission;
  task?: PlannedTask | null;
  excludedModelIds?: ReadonlySet<string>;
  excludedConnectionIds?: ReadonlySet<string>;
  avoidProviders?: readonly string[];
}

export class ModelRouter {
  constructor(private readonly ledger: Ledger) {}

  /**
   * The decision this exact input would produce, or the reason nothing can take
   * it. Callers that need to know whether work is runnable ask this rather than
   * approximating routing with a looser predicate: a proxy that checks generic
   * lifecycle flags answers both true and false incorrectly, because it cannot
   * see role qualification, permission, capability needs, tier fit, manual
   * assignment, or benchmark requirements. Sharing the real implementation is
   * the only way the answer stays equivalent to what execution will do.
   */
  tryRoute(input: RouteInput): { decision: RoutingDecision } | { reason: string } {
    try {
      return { decision: this.route(input) };
    } catch (error) {
      if (error instanceof RoutingUnavailableError) return { reason: error.message };
      throw error;
    }
  }

  route(input: RouteInput): RoutingDecision {
    const assignment = input.config.routing[input.role];
    const workload = classifyWorkload(input.role, input.task, assignment.preferredTier);
    if (assignment.modelId) {
      const assigned = this.ledger.getModel(assignment.modelId);
      const model = assigned && assignment.upgradePolicy === "track_family"
        ? this.trackedFamilyCandidate(assigned, input) ?? assigned
        : assigned;
      if (model && this.acceptModel(model, input, true)) {
        const connection = this.connection(model.connectionId)!;
        const profile = inferModelProfile(model, connection);
        const manualTierOverride = tierFitScore(profile.tier, workload.requiredTier) === null
          ? [`manual tier override: ${profile.tier} model assigned to ${workload.requiredTier} workload`]
          : [];
        const breakdown = routingScore({ manualAssignment: 110, userPin: model.pinned ? 10 : 0 });
        return this.decisionForModel(input, workload, model, connection, breakdown, [
          assignment.upgradePolicy === "track_family" && model.id !== assignment.modelId ? "newest qualified and benchmarked family member" : "manual role assignment",
          ...manualTierOverride,
          "role qualification passed",
          ...(profile.family.startsWith("mellum2") ? ["local specialist benchmark passed"] : []),
          ...(model.pinned ? ["user pin"] : []),
          "connection and model eligible",
        ], false);
      }
      if (!input.config.routing.allowFallback) {
        throw new RoutingUnavailableError(`Assigned ${input.role} model '${assignment.modelId}' is missing, excluded, unqualified for the role, cooling, or incompatible with ${input.permission}`);
      }
    }

    if (input.config.routing.mode === "adaptive") {
      const comparable = this.ledger.listModels()
        .flatMap((model) => {
          if (!this.acceptModel(model, input, false)) return [];
          const connection = this.connection(model.connectionId)!;
          const profile = inferModelProfile(model, connection);
          const empirical = this.ledger.listModelPerformanceProfiles(model.id)[0];
          const empiricalWorkload = empirical?.workloads[`${workload.complexity}:${workload.requiredTier}`];
          const fit = tierFitScore(profile.tier, workload.requiredTier);
          if (fit === null || !supportsTask(profile, input.task)) return [];
          return [{ model, connection, profile, empiricalWorkload, fit }];
        });
      const costScores = relativeCatalogCostScores(comparable.map(({ model }) => ({ id: model.id, unitCostUsd: catalogUnitCost(model) })));
      const candidates = comparable
        .map(({ model, connection, profile, empiricalWorkload, fit }) => {
          const breakdown = routingScore({
            baseEligibility: 20,
            tierFit: fit,
            reasoningFit: reasoningEffortFitScore(profile.reasoningEffort, workload.requiredTier),
            userPin: model.pinned ? 10 : 0,
            preferredProvider: connection.provider === input.task?.preferredProvider ? 8 : 0,
            fallbackProvider: connection.provider === input.fallbackProvider ? 4 : 0,
            empiricalReliability: empiricalReliabilityScore(empiricalWorkload),
            empiricalLatency: empiricalLatencyScore(empiricalWorkload),
            providerDiversity: input.avoidProviders?.length && !input.avoidProviders.includes(connection.provider) ? 8 : 0,
            costAwareness: costScores.get(model.id) ?? 0,
          });
          return [{ model, connection, profile, score: scoreTotal(breakdown), breakdown }];
        })
        .flat()
        .sort((left, right) => right.score - left.score || left.model.id.localeCompare(right.model.id));
      const selected = candidates[0];
      if (selected) {
        return this.decisionForModel(input, workload, selected.model, selected.connection, selected.breakdown, [
          `adaptive ${workload.complexity} workload`,
          `${selected.profile.tier} model tier satisfies ${workload.requiredTier}`,
          ...(selected.profile.reasoningEffort ? [`${selected.profile.reasoningEffort} reasoning setting fits workload`] : []),
          ...workload.factors,
          ...(selected.model.pinned ? ["user pin"] : []),
          ...(selected.connection.provider === input.task?.preferredProvider ? ["architect preferred provider"] : []),
          ...(selected.breakdown.empiricalReliability !== 0 ? [`established empirical reliability ${selected.breakdown.empiricalReliability > 0 ? "boost" : "penalty"}`] : []),
          ...(selected.breakdown.empiricalLatency !== 0 ? [`established workload latency ${selected.breakdown.empiricalLatency > 0 ? "boost" : "penalty"}`] : []),
          ...(selected.breakdown.providerDiversity > 0 ? ["independent provider from implementation"] : []),
          ...(selected.breakdown.costAwareness > 0 ? ["lower relative catalog price among comparable paid candidates"] : selected.breakdown.costAwareness < 0 ? ["higher relative catalog price penalty"] : []),
          "role qualification and health passed",
          ...(selected.profile.family.startsWith("mellum2") ? ["local specialist benchmark passed"] : []),
        ], Boolean(assignment.modelId));
      }
    }

    const provider = this.defaultProvider(input);
    if (!provider) throw new RoutingUnavailableError(`No eligible model or provider default is available for ${input.role} (${workload.requiredTier} tier required)`);
    const connection = this.connection(`subscription-cli:${provider}`)!;
    const effort = input.config.routing.mode === "adaptive" ? effortForTier(workload.requiredTier) : assignment.effort;
    return {
      role: input.role,
      provider,
      connectionId: connection.id,
      transport: connection.transport,
      model: { requestedModelId: null, alias: null, settings: effortSettings(provider, effort) },
      score: 30,
      scoreBreakdown: routingScore({ baseEligibility: 30 }),
      factors: [
        assignment.modelId ? "assigned model unavailable; fallback allowed" : "no qualified active concrete model",
        "provider default",
        `adaptive ${workload.requiredTier} effort ${effort}`,
        ...workload.factors,
        "connection eligible",
      ],
      fallback: Boolean(assignment.modelId),
      workload,
    };
  }

  private decisionForModel(
    input: RouteInput,
    workload: WorkloadClassification,
    model: ModelRecord,
    connection: ConnectionRecord,
    scoreBreakdown: RoutingScoreBreakdown,
    factors: string[],
    fallback: boolean,
  ): RoutingDecision {
    const configuredEffort = input.config.routing[input.role].effort;
    const effort = input.config.routing.mode === "adaptive" ? effortForTier(workload.requiredTier) : configuredEffort;
    return {
      role: input.role,
      provider: connection.provider,
      connectionId: connection.id,
      transport: connection.transport,
      model: {
        requestedModelId: domainId("Model", model.id),
        alias: model.canonicalName,
        settings: effortSettings(connection.provider, effort),
      },
      score: scoreTotal(scoreBreakdown),
      scoreBreakdown,
      factors,
      fallback,
      workload,
    };
  }

  private acceptModel(model: ModelRecord, input: RouteInput, explicit: boolean): boolean {
    const connection = this.connection(model.connectionId);
    if (!connection || !model.qualified || model.qualificationStale || model.excluded || model.retired) return false;
    if (!explicit && !model.active) return false;
    if (input.excludedModelIds?.has(model.id) || input.excludedConnectionIds?.has(connection.id)) return false;
    if (!this.ledger.isConnectionEligible(connection.id) || !this.ledger.isModelEligible(model.id)) return false;
    const quotaGroup = modelQuotaGroup(model);
    if (quotaGroup && !this.ledger.isQuotaGroupEligible(connection.id, quotaGroup.id)) return false;
    if (connection.transport === "api" && input.permission === "workspace_write") return false;
    if (connection.transport !== "local" && !input.allowedProviders.includes(connection.provider)) return false;
    const roleQualified = this.qualifiedForRole(model, input.role, input.permission);
    // Manual assignments may override workload tier fit, but never the exact
    // current-fingerprint qualification required by the assigned role.
    if (!roleQualified) return false;
    const profile = inferModelProfile(model, connection);
    if (connection.transport === "local" && input.permission === "read_only" && (input.task?.capabilityNeeds ?? []).some((need) => need.toLowerCase() === "tools")) return false;
    if (!supportsTask(profile, input.task)) return false;
    if (profile.family.startsWith("mellum2") && !this.isBenchmarked(model)) return false;
    return true;
  }

  private qualifiedForRole(model: ModelRecord, role: AgentRole, permission: InvocationPermission): boolean {
    return this.ledger.listModelQualifications(model.id).some((qualification) => {
      if (!qualification.passed || qualification.fingerprint !== model.qualificationFingerprint) return false;
      if (qualification.role === "local_tools") return permission === "workspace_write" && role === "worker";
      if (qualification.role === "general" || qualification.role === role) return true;
      return qualification.role === "analysis" && permission === "read_only" && role !== "architect";
    });
  }

  private defaultProvider(input: RouteInput): ProviderName | null {
    const ordered = [input.fallbackProvider, ...input.allowedProviders.filter((provider) => provider !== input.fallbackProvider)];
    for (const provider of ordered) {
      if (provider !== "codex" && provider !== "claude" && provider !== "gemini") continue;
      const connection = this.connection(`subscription-cli:${provider}`);
      if (!connection || input.excludedConnectionIds?.has(connection.id) || !this.ledger.isConnectionEligible(connection.id)) continue;
      const managedFleet = this.ledger.listModels(connection.id).some((model) => model.active && model.qualified && !model.excluded);
      if (managedFleet) continue;
      return provider;
    }
    return null;
  }

  private connection(connectionId: string): ConnectionRecord | null {
    return this.ledger.listConnections().find((connection) => connection.id === connectionId) ?? null;
  }

  private trackedFamilyCandidate(assigned: ModelRecord, input: RouteInput): ModelRecord | null {
    const connection = this.connection(assigned.connectionId);
    if (!connection) return null;
    const family = inferModelProfile(assigned, connection).family;
    return this.ledger.listModels(assigned.connectionId)
      .filter((model) => inferModelProfile(model, connection).family === family)
      .filter((model) => this.acceptModel(model, input, true))
      .filter((model) => model.id === assigned.id || this.isBenchmarked(model))
      .sort((left, right) => compareModelIdentifiers(right.canonicalName, left.canonicalName))[0] ?? null;
  }

  private isBenchmarked(model: ModelRecord): boolean {
    return this.ledger.listModelQualifications(model.id).some((qualification) =>
      qualification.passed && qualification.role === "benchmark" && qualification.fingerprint === model.qualificationFingerprint,
    );
  }
}

function routingScore(input: Partial<RoutingScoreBreakdown>): RoutingScoreBreakdown {
  return {
    manualAssignment: input.manualAssignment ?? 0,
    baseEligibility: input.baseEligibility ?? 0,
    tierFit: input.tierFit ?? 0,
    reasoningFit: input.reasoningFit ?? 0,
    userPin: input.userPin ?? 0,
    preferredProvider: input.preferredProvider ?? 0,
    fallbackProvider: input.fallbackProvider ?? 0,
    empiricalReliability: input.empiricalReliability ?? 0,
    empiricalLatency: input.empiricalLatency ?? 0,
    providerDiversity: input.providerDiversity ?? 0,
    costAwareness: input.costAwareness ?? 0,
  };
}

export function empiricalReliabilityScore(profile?: ModelPerformanceSlice): number {
  if (!profile?.eligibleForAdaptiveWeighting) return 0;
  const reliability = (profile.firstAttemptSuccessRate - 0.5) * 8;
  const timeoutPenalty = Math.min(1, (profile.failureKinds.timeout ?? 0) / profile.sampleSize * 10);
  const malformedPenalty = Math.min(1, profile.malformedEnvelopeCount / profile.sampleSize * 10);
  const validatorPenalty = Math.min(2, profile.validatorFailureCount / profile.sampleSize * 2);
  const conflictPenalty = Math.min(1, profile.integrationConflictCount / profile.sampleSize * 4);
  return Math.max(-6, Math.min(4, Math.round(reliability - timeoutPenalty - malformedPenalty - validatorPenalty - conflictPenalty)));
}

export function empiricalLatencyScore(profile?: ModelPerformanceSlice): number {
  if (!profile?.eligibleForAdaptiveWeighting || profile.averageLatencyMs === null) return 0;
  if (profile.averageLatencyMs <= 30_000) return 2;
  if (profile.averageLatencyMs <= 120_000) return 1;
  if (profile.averageLatencyMs <= 300_000) return 0;
  if (profile.averageLatencyMs <= 600_000) return -1;
  return -2;
}

export function relativeCatalogCostScores(candidates: ReadonlyArray<{ id: string; unitCostUsd: number | null }>): Map<string, number> {
  const known = candidates.filter((candidate): candidate is { id: string; unitCostUsd: number } => candidate.unitCostUsd !== null && Number.isFinite(candidate.unitCostUsd) && candidate.unitCostUsd >= 0);
  if (known.length < 2) return new Map();
  const minimum = Math.min(...known.map((candidate) => candidate.unitCostUsd));
  const maximum = Math.max(...known.map((candidate) => candidate.unitCostUsd));
  if (minimum === maximum) return new Map(known.map((candidate) => [candidate.id, 0]));
  return new Map(known.map((candidate) => {
    const position = (candidate.unitCostUsd - minimum) / (maximum - minimum);
    return [candidate.id, Math.round(2 - position * 4)];
  }));
}

function catalogUnitCost(model: ModelRecord): number | null {
  const prompt = numericMetadata(model.metadata.promptPrice);
  const completion = numericMetadata(model.metadata.completionPrice);
  return prompt === null || completion === null ? null : prompt + completion;
}

function numericMetadata(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function scoreTotal(breakdown: RoutingScoreBreakdown): number {
  return Object.values(breakdown).reduce((sum, value) => sum + value, 0);
}

function compareModelIdentifiers(left: string, right: string): number {
  const leftNumbers = left.match(/\d+/g)?.map(Number) ?? [];
  const rightNumbers = right.match(/\d+/g)?.map(Number) ?? [];
  for (let index = 0; index < Math.max(leftNumbers.length, rightNumbers.length); index += 1) {
    const difference = (leftNumbers[index] ?? 0) - (rightNumbers[index] ?? 0);
    if (difference) return difference;
  }
  return left.localeCompare(right);
}

function effortSettings(provider: string, effort: string): Record<string, string> {
  return provider === "codex" || provider === "claude" ? { effort } : {};
}

function supportsTask(profile: ModelProfile, task?: PlannedTask | null): boolean {
  const capabilities = profile.capabilities;
  if (capabilities.includes("embedding") && !capabilities.includes("text")) return false;
  const needs = (task?.capabilityNeeds ?? []).map((item) => item.toLowerCase());
  if (needs.includes("vision") && !capabilities.includes("vision")) return false;
  if (needs.includes("code") && !capabilities.includes("code")) return false;
  if (needs.includes("tools") && !capabilities.includes("tools")) return false;
  if (needs.includes("structured-output") && !capabilities.includes("structured-output") && !capabilities.includes("tools")) return false;
  if (capabilities.includes("cyber-restricted") && needs.some((need) => need === "security" || need === "cybersecurity" || need === "authentication")) return false;
  return true;
}
