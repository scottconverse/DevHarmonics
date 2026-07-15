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
