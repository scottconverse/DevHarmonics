export interface ModelPerformanceObservation {
  id: number;
  runId: string;
  taskId: string;
  modelId: string;
  provider: string;
  status: string;
  failureKind: string | null;
  malformedSource: boolean;
  workloadClass: string;
  validatorFailureCount: number;
  integrationConflictCount: number;
  runNotReady: boolean;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ModelPerformanceSlice {
  sampleSize: number;
  successCount: number;
  successRate: number;
  firstAttemptCount: number;
  firstAttemptSuccessCount: number;
  firstAttemptSuccessRate: number;
  retryCount: number;
  averageLatencyMs: number | null;
  malformedEnvelopeCount: number;
  validatorFailureCount: number;
  integrationConflictCount: number;
  notReadyRunCount: number;
  billedSampleCount: number;
  totalCostUsd: number;
  averageCostUsd: number | null;
  failureKinds: Record<string, number>;
  uncertainty: "insufficient" | "emerging" | "established";
  eligibleForAdaptiveWeighting: boolean;
}

export interface ModelPerformanceProfile extends ModelPerformanceSlice {
  modelId: string;
  provider: string;
  observationsExcluded: boolean;
  workloads: Record<string, ModelPerformanceSlice>;
}

export interface CounterfactualComparisonModel {
  modelId: string;
  displayName: string;
  promptPriceUsdPerMTokens: number;
  completionPriceUsdPerMTokens: number;
}

export interface CounterfactualReceipt {
  role: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface RunCostCounterfactual {
  /** Always true: the counterfactual is a catalog-price projection, never a bill. */
  estimate: true;
  /** Actual spend over exactly the invocations the counterfactual projects — a like-for-like pair. */
  actualUsd: number;
  counterfactualUsd: number;
  byRole: Array<{ role: string; actualUsd: number; counterfactualUsd: number; comparisonModelId: string; comparisonDisplayName: string }>;
  /** Roles with receipts but no priced comparison model — excluded, never invented. */
  excludedRoles: string[];
  /** Known spend the pair could not cover: excluded roles plus receipts without token counts. Visible, never folded in. */
  unprojectedUsd: number;
  /** Receipts whose billed cost is unknown — counted, never presented as zero spend. */
  unknownCostReceipts: number;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * DH-650: what this run actually cost beside what the same token volume would
 * have cost on the priciest qualified candidate per role — the stratification
 * saving made visible. Honest-absent: a role without a priced comparator or a
 * receipt without token counts cannot be projected; when nothing at all can
 * be projected the answer is null, not zero.
 */
export function runCostCounterfactual(input: {
  receipts: ReadonlyArray<CounterfactualReceipt>;
  /** Every priced qualified candidate per role; the priciest is chosen per role FOR ITS OBSERVED TOKEN MIX (Codex F-003). */
  candidatesByRole: Readonly<Record<string, ReadonlyArray<CounterfactualComparisonModel> | undefined>>;
}): RunCostCounterfactual | null {
  const byRole = new Map<string, CounterfactualReceipt[]>();
  for (const receipt of input.receipts) {
    byRole.set(receipt.role, [...(byRole.get(receipt.role) ?? []), receipt]);
  }
  const entries: RunCostCounterfactual["byRole"] = [];
  const excludedRoles: string[] = [];
  // All accumulation is unrounded; only display fields round, so the parts can
  // never round their way into a negative remainder (Codex F-004b).
  let coveredUsd = 0;
  let coveredCounterfactualUsd = 0;
  const covered = new Set<CounterfactualReceipt>();
  for (const [role, receipts] of byRole) {
    const candidates = input.candidatesByRole[role] ?? [];
    // The pair is like-for-like: a receipt joins it only when BOTH sides are
    // knowable — token counts for the projection AND billed cost for the
    // actual. Unknown cost is counted, never invented as zero (Codex F-004a).
    const pairable = receipts.filter((receipt) => receipt.inputTokens !== null && receipt.outputTokens !== null && receipt.costUsd !== null);
    if (!candidates.length || !pairable.length) {
      excludedRoles.push(role);
      continue;
    }
    const inputTokens = pairable.reduce((sum, receipt) => sum + receipt.inputTokens!, 0);
    const outputTokens = pairable.reduce((sum, receipt) => sum + receipt.outputTokens!, 0);
    const actualUsd = pairable.reduce((sum, receipt) => sum + receipt.costUsd!, 0);
    // Priciest for THIS mix: project every candidate over the role's observed
    // token volume and take the maximum — a summed rate card is not that.
    const projected = candidates
      .map((candidate) => ({ candidate, usd: inputTokens * candidate.promptPriceUsdPerMTokens / 1_000_000 + outputTokens * candidate.completionPriceUsdPerMTokens / 1_000_000 }))
      .sort((left, right) => right.usd - left.usd || left.candidate.modelId.localeCompare(right.candidate.modelId))[0]!;
    const comparison = projected.candidate;
    const counterfactualUsd = projected.usd;
    coveredUsd += actualUsd;
    coveredCounterfactualUsd += counterfactualUsd;
    for (const receipt of pairable) covered.add(receipt);
    entries.push({
      role,
      actualUsd: roundUsd(actualUsd),
      counterfactualUsd: roundUsd(counterfactualUsd),
      comparisonModelId: comparison.modelId,
      comparisonDisplayName: comparison.displayName,
    });
  }
  if (!entries.length) return null;
  const uncoveredKnownUsd = input.receipts.reduce((sum, receipt) => sum + (covered.has(receipt) || receipt.costUsd === null ? 0 : receipt.costUsd), 0);
  return {
    estimate: true,
    actualUsd: roundUsd(coveredUsd),
    counterfactualUsd: roundUsd(coveredCounterfactualUsd),
    byRole: entries.sort((left, right) => left.role.localeCompare(right.role)),
    excludedRoles: excludedRoles.sort(),
    unprojectedUsd: roundUsd(uncoveredKnownUsd),
    unknownCostReceipts: input.receipts.filter((receipt) => receipt.costUsd === null).length,
  };
}

export function aggregateModelPerformance(
  observations: ReadonlyArray<ModelPerformanceObservation>,
): ModelPerformanceProfile[] {
  const byModel = new Map<string, ModelPerformanceObservation[]>();
  for (const observation of observations) {
    if (!observation.modelId) continue;
    const current = byModel.get(observation.modelId) ?? [];
    current.push(observation);
    byModel.set(observation.modelId, current);
  }

  return [...byModel.entries()].map(([modelId, modelObservations]) => {
    const ordered = [...modelObservations].sort((left, right) => left.id - right.id);
    const byWorkload = new Map<string, ModelPerformanceObservation[]>();
    for (const observation of ordered) {
      const current = byWorkload.get(observation.workloadClass) ?? [];
      current.push(observation);
      byWorkload.set(observation.workloadClass, current);
    }
    return {
      modelId,
      provider: ordered[0]?.provider ?? "unknown",
      ...aggregateSlice(ordered),
      observationsExcluded: false,
      workloads: Object.fromEntries([...byWorkload.entries()].map(([workload, values]) => [workload, aggregateSlice(values)])),
    } satisfies ModelPerformanceProfile;
  }).sort((left, right) => left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId));
}

function aggregateSlice(ordered: ReadonlyArray<ModelPerformanceObservation>): ModelPerformanceSlice {
  const firstAttemptIds = new Set<number>();
  const firstByTask = new Set<string>();
  for (const observation of ordered) {
    const taskKey = `${observation.runId}\u0000${observation.taskId}`;
    if (firstByTask.has(taskKey)) continue;
    firstByTask.add(taskKey);
    firstAttemptIds.add(observation.id);
  }
  const successful = ordered.filter((observation) => observation.status === "completed");
  const firstAttempts = ordered.filter((observation) => firstAttemptIds.has(observation.id));
  const firstAttemptSuccesses = firstAttempts.filter((observation) => observation.status === "completed");
  const latencies = ordered.flatMap((observation) => {
    if (!observation.finishedAt) return [];
    const duration = Date.parse(observation.finishedAt) - Date.parse(observation.startedAt);
    return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
  });
  const failureKinds: Record<string, number> = {};
  for (const observation of ordered) {
    if (!observation.failureKind) continue;
    failureKinds[observation.failureKind] = (failureKinds[observation.failureKind] ?? 0) + 1;
  }
  const sampleSize = ordered.length;
  const billedCosts = ordered.flatMap((observation) => observation.costUsd === null ? [] : [observation.costUsd]);
  const totalCostUsd = Number(billedCosts.reduce((sum, value) => sum + value, 0).toFixed(6));
  const uncertainty = sampleSize < 5 ? "insufficient" : sampleSize < 20 ? "emerging" : "established";
  return {
    sampleSize,
    successCount: successful.length,
    successRate: rate(successful.length, sampleSize),
    firstAttemptCount: firstAttempts.length,
    firstAttemptSuccessCount: firstAttemptSuccesses.length,
    firstAttemptSuccessRate: rate(firstAttemptSuccesses.length, firstAttempts.length),
    retryCount: Math.max(0, sampleSize - firstAttempts.length),
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
    malformedEnvelopeCount: ordered.filter((observation) => observation.malformedSource).length,
    validatorFailureCount: ordered.reduce((sum, observation) => sum + observation.validatorFailureCount, 0),
    integrationConflictCount: ordered.reduce((sum, observation) => sum + observation.integrationConflictCount, 0),
    notReadyRunCount: new Set(ordered.filter((observation) => observation.runNotReady).map((observation) => observation.runId)).size,
    billedSampleCount: billedCosts.length,
    totalCostUsd,
    averageCostUsd: billedCosts.length ? Number((totalCostUsd / billedCosts.length).toFixed(6)) : null,
    failureKinds,
    uncertainty,
    eligibleForAdaptiveWeighting: uncertainty === "established",
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}
