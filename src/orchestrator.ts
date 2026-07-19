import path from "node:path";
import { createHash } from "node:crypto";
import { projectLegacyProvider } from "./compatibility.js";
import { CapacityBroker } from "./capacity.js";
import { normalizeAgentResult, validateDiagnosticResult } from "./agents.js";
import { assembleContextPack } from "./context.js";
import { setTimeout as delay } from "node:timers/promises";
import { runPlanSchema } from "./schemas.js";
import { loadConfig, loadConstitution, resolveProviderCommand, devHarmonicsDirectory } from "./config.js";
import { inspectProviders } from "./doctor.js";
import { Ledger, type ReviewEvidenceBinding } from "./ledger.js";
import { OllamaAdapter, syncOllamaRuntimes } from "./ollama.js";
import { createRuntimeAdapter } from "./providers.js";
import {
  architectPrompt,
  formatFailures,
  localReviewerContextHeader,
  objectivePromptText,
  reviewerPrompt,
  workbenchConsultationPrompt,
  workerPrompt,
} from "./prompts.js";
import { chunkDiffFiles, runContextOnlyReview, type ReviewChunk } from "./local-review.js";
import { describeUnverifiableCitations, verifyReportCitations } from "./citations.js";
import {
  PROVIDERS,
  type CheckResult,
  type PlannedTask,
  type ProviderName,
  type DevHarmonicsConfig,
  type ObjectiveRecord,
  type PlanRevisionRecord,
  type RunPlan,
  type RunRequest,
  type RunAutonomy,
  type SteeringDirectiveRecord,
  type TaskStatus,
  type ValidatorConfig,
} from "./types.js";
import { invocationFailureScope, isAbortError, RuntimeInvocationError, type InvocationPermission, type RuntimeAdapter } from "./runtime.js";
import { syncSubscriptionConnections } from "./registry.js";
import { ModelRouter, type RouteInput } from "./routing.js";
import { observeLocalResources } from "./resources.js";
import { evaluateToolRequest, type ToolStage } from "./policy.js";
import { adjudicateReviewQuorum, parseReviewerResponse, reviewRequirement, type ReviewFinding, type ReviewQuorumDecision, type ReviewRequirement, type StructuredReview } from "./review.js";
import { OPENROUTER_MAX_OUTPUT_TOKENS, OpenRouterService, requireInvocationCostCeiling, type PaidSpendReservation } from "./openrouter.js";
import { ensureSchedulerCandidateQualified, ensureSchedulerProviderCandidateQualified, type SchedulerQualificationResult } from "./qualification.js";
import { mergeRepositoryValidators, resolveValidatorCwd, runValidator, unknownValidator } from "./validators.js";
import { analyzeVerificationIntegrity } from "./verification-integrity.js";
import { runLocalToolLoop } from "./local-tools.js";
import { WorktreeManager, WorkspaceIsolationError } from "./worktrees.js";
import { IntegrationSetManager } from "./integration-sets.js";
import { modelQuotaGroup, quotaResetAt } from "./antigravity.js";

export interface WorkbenchConsultationResult {
  requestedModelId: string;
  provider: string;
  connectionId: string | null;
  resolvedModelId: string | null;
  text: string | null;
  status: "complete" | "failed";
  error: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  paidSpendReservationId: string | null;
}

export class Orchestrator {
  private readonly backgroundRuns = new Map<string, Promise<void>>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly approvalResolvers = new Map<string, () => void>();

  constructor(private readonly ledger: Ledger) {}

  begin(request: RunRequest, resumedFrom: string | null = null): string {
    const runId = this.ledger.createRun(request.goal, request.projectPath, resumedFrom, request.autonomy ?? "supervised", request.objectiveLink ?? null);
    const controller = new AbortController();
    this.cancellations.set(runId, controller);
    const execution = this.execute(runId, request, controller.signal)
      .catch((error: unknown) => {
        if (["cancelled", "paused"].includes(this.ledger.getRun(runId)?.status ?? "")) return;
        const message = error instanceof Error ? error.message : String(error);
        this.ledger.addEvent(runId, "run.failed", message);
        this.ledger.setRunStatus(runId, "failed", `NOT READY\n\n${message}`);
      })
      .finally(() => {
        this.backgroundRuns.delete(runId);
        this.cancellations.delete(runId);
        this.approvalResolvers.delete(runId);
      });
    this.backgroundRuns.set(runId, execution);
    return runId;
  }

  cancel(runId: string): boolean {
    const controller = this.cancellations.get(runId);
    if (controller) controller.abort();
    // ledger.cancelRun marks the run and its live tasks 'cancelled' and adds
    // the 'run.cancelled' event, but only when it actually transitions the run.
    const transitioned = this.ledger.cancelRun(runId);
    return transitioned;
  }

  pause(runId: string): boolean {
    const controller = this.cancellations.get(runId);
    if (!controller) return false;
    controller.abort();
    return this.ledger.pauseRun(runId);
  }

  resume(runId: string): string | null {
    const previous = this.ledger.getRun(runId);
    if (!previous || previous.status !== "paused") return null;
    const nextRunId = this.begin({ goal: previous.goal, projectPath: previous.projectPath, autonomy: previous.autonomy }, runId);
    this.ledger.addEvent(runId, "run.resumed", `Recovery continued in run ${nextRunId}`, { nextRunId });
    this.ledger.addEvent(nextRunId, "run.resumed", `Recovering evidence from run ${runId}`, { previousRunId: runId });
    return nextRunId;
  }

  approve(runId: string): boolean {
    const resolve = this.approvalResolvers.get(runId);
    if (!resolve || !this.ledger.approvePlan(runId)) return false;
    resolve();
    this.approvalResolvers.delete(runId);
    return true;
  }

  async proposeObjectivePlan(input: {
    objective: ObjectiveRecord;
    enabledProviders?: ProviderName[];
    previous?: PlanRevisionRecord | null;
    revisionFeedback?: string;
  }): Promise<{
    plan: RunPlan;
    preview: {
      capacity: ReturnType<CapacityBroker["decide"]>;
      assignments: Array<{ taskId: string; provider: string; modelId: string | null; tier: string; factors: string[] }>;
      execution: { supported: boolean; reason: string };
    };
  }> {
    const projectPath = path.resolve(input.objective.projectPath);
    const config = await loadConfig(projectPath);
    const constitution = await loadConstitution(projectPath);
    const configuredProviders = this.availableProviders(config, input.enabledProviders);
    // DELIBERATE, NARROW EXCEPTION: planning is the one operation that genuinely
    // requires a subscription. No local model is architect-qualified, so without
    // a signed-in subscription there is nothing that can produce a plan, and
    // refusing here is honest rather than a subscription-only reflex. Everything
    // downstream — starting an approved run, executing its tasks, repairing, and
    // reviewing — is gated on an exact route instead, so a local fleet can carry
    // work a subscription planned. Do not copy these two refusals past planning.
    if (!configuredProviders.length) throw new Error("No subscription-backed providers are enabled");

    const providerStatuses = await inspectProviders(config, projectPath);
    syncSubscriptionConnections(this.ledger, providerStatuses);
    await syncOllamaRuntimes(this.ledger, config.localRuntimes.ollama);
    const unavailable = providerStatuses.filter((provider) => configuredProviders.includes(provider.name) && !provider.available);
    // A signed-out provider is removed from the pool, not treated as a reason to
    // refuse. Refusing whenever ANY enabled provider was signed out let one
    // unused signed-out subscription block planning that a different, healthy
    // architect could have done. The requirement is one healthy architect, so
    // that is what is checked — and the sign-in detail becomes the reason when
    // none remains, rather than a gate in front of the question.
    const availableProviders = configuredProviders.filter((name) =>
      !unavailable.some((provider) => provider.name === name)
      && this.ledger.isConnectionEligible(projectLegacyProvider(name).connectionId),
    );
    const workerProviders = config.product.workers.filter((name) => availableProviders.includes(name));
    // Planning itself needs a subscription architect — local models qualify for
    // analysis, never for the architect role. Execution does not: a qualified
    // local worker can carry the tasks, so a cooling subscription worker pool
    // must not refuse to plan work that local models can actually run.
    if (!availableProviders.length) {
      const instructions = unavailable.map((provider) => `${provider.name}: ${provider.summary}${provider.authenticated ? "" : `; run '${provider.loginCommand}'`}`).join("; ");
      throw new Error(
        instructions
          ? `No healthy provider is available to plan this objective (${instructions}), then refresh and retry.`
          : "No healthy provider is available to plan this objective",
      );
    }
    if (!canRoute(this.ledger, workerClassProbe(config, workerProviders))) {
      throw new Error("No subscription worker is available and no qualified local worker can run this objective");
    }

    const architectName = availableProviders.includes(config.product.architect) ? config.product.architect : availableProviders[0]!;
    const architectCandidates = config.routing.allowFallback
      ? [architectName, ...availableProviders.filter((provider) => provider !== architectName)]
      : [architectName];
    const router = new ModelRouter(this.ledger);
    const excludedArchitectModels = new Set<string>();
    const excludedArchitectConnections = new Set<string>();
    const repositoryContext = this.objectiveRepositoryContext(input.objective);
    // The architect may only name checks that exist where the work will run, so
    // the affected repositories' validators join the project's in its vocabulary.
    const impactedRepositories = repositoryContext
      ? (this.ledger.getProduct(input.objective.productId!)?.repositories ?? []).filter((repository) => repositoryContext.requiredImpactIds.includes(repository.id))
      : [];
    const architectValidators = architectValidatorNames(config.repository.validators, impactedRepositories);
    let plan: RunPlan | null = null;
    let lastArchitectError: Error | null = null;
    for (let candidateIndex = 0; candidateIndex < architectCandidates.length; candidateIndex++) {
      const candidate = architectCandidates[candidateIndex]!;
      const qualification = await ensureSchedulerProviderCandidateQualified({ ledger: this.ledger, config, cwd: projectPath, role: "architect", preferredProvider: candidate, permission: "read_only", excludedModelIds: excludedArchitectModels, excludedConnectionIds: excludedArchitectConnections });
      if (qualification?.attempted && !qualification.passed) {
        lastArchitectError = new Error(`${qualification.provider} model '${qualification.modelId}' failed architect qualification`);
        continue;
      }
      const decision = router.route({ role: "architect", config, fallbackProvider: candidate, allowedProviders: [candidate], permission: "read_only", excludedModelIds: excludedArchitectModels, excludedConnectionIds: excludedArchitectConnections });
      const architect = await this.provider(decision.provider, config, decision.connectionId);
      try {
        const result = await architect.invoke({
          role: "architect",
          prompt: architectPrompt({
            goal: objectivePromptText(input.objective),
            constitution,
            validators: architectValidators,
            providers: workerProviders,
            workspacePath: projectPath,
            autonomy: input.objective.autonomy,
            ...(repositoryContext ? { repositoryContext: repositoryContext.text } : {}),
            selectedRepositoryIds: input.objective.repositoryIds,
            previousPlan: input.previous?.plan ?? null,
            ...(input.revisionFeedback ? { revisionFeedback: input.revisionFeedback } : {}),
          }),
          cwd: projectPath,
          permission: "read_only",
          timeoutMs: null,
          maxOutputTokens: OPENROUTER_MAX_OUTPUT_TOKENS,
          model: decision.model,
        });
        const parsed = this.parsePlan(result.text, config, input.objective.autonomy, architectValidators);
        this.validateObjectiveRepositoryPlan(input.objective, parsed, repositoryContext?.requiredImpactIds ?? []);
        const previousRevision = input.previous?.revision ?? null;
        plan = { ...parsed, revision: previousRevision === null ? 1 : previousRevision + 1, previousRevision };
        this.recordConnectionOutcome(architect.connection.id, { success: true });
        if (decision.model.requestedModelId) {
          const quotaGroup = modelQuotaGroup(this.ledger.getModel(String(decision.model.requestedModelId)));
          if (quotaGroup) this.recordQuotaGroupOutcome(String(architect.connection.id), quotaGroup.id, quotaGroup.displayName, { success: true });
        }
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failureKind = error instanceof RuntimeInvocationError ? error.kind : "incompatible";
        lastArchitectError = new Error(`${decision.provider} could not produce a valid plan: ${message}`);
        const scope = this.recordScopedInvocationFailure({ connectionId: String(architect.connection.id), modelId: decision.model.requestedModelId ? String(decision.model.requestedModelId) : null, failureKind, detail: message, excludedModelIds: excludedArchitectModels, excludedConnectionIds: excludedArchitectConnections });
        if (scope === "quota_group" && this.hasEligibleModelOnConnection(String(architect.connection.id), excludedArchitectModels)) architectCandidates.splice(candidateIndex + 1, 0, candidate);
      }
    }
    if (!plan) throw lastArchitectError ?? new Error("No eligible architect produced a valid plan");

    const assignments = plan.tasks.map((task) => {
      // Null when only local workers remain; the router selects among qualified
      // local models rather than indexing an empty subscription pool.
      const fallbackProvider = task.preferredProvider && workerProviders.includes(task.preferredProvider)
        ? task.preferredProvider
        : workerProviders[0] ?? null;
      try {
        const decision = router.route({ role: "worker", config, fallbackProvider, allowedProviders: workerProviders, permission: task.permission ?? "workspace_write", task });
        return { taskId: task.id, provider: decision.provider, modelId: decision.model.requestedModelId ?? null, tier: decision.workload.requiredTier, factors: decision.factors };
      } catch (error) {
        // With no subscription worker left, the preview names the local pool
        // rather than a provider that does not exist.
        return { taskId: task.id, provider: fallbackProvider ?? "local", modelId: null, tier: "unavailable", factors: [error instanceof Error ? error.message : String(error)] };
      }
    });
    const capacity = new CapacityBroker().decide({
      requestedConcurrency: plan.recommendedConcurrency,
      userCeiling: config.application.concurrency.ceiling,
      resources: await observeLocalResources(),
    });
    return { plan, preview: { capacity, assignments, execution: this.objectiveExecutionReadiness(input.objective, plan) } };
  }

  objectiveExecutionReadiness(objective: ObjectiveRecord, plan: RunPlan): { supported: boolean; reason: string } {
    if (!objective.productId || !objective.repositoryIds.length) {
      return { supported: true, reason: "Single workspace execution is available." };
    }
    const product = this.ledger.getProduct(objective.productId);
    if (!product) return { supported: false, reason: "The selected product is no longer registered." };
    const affectedIds = (plan.repositoryImpact ?? []).filter((impact) => impact.disposition === "affected").map((impact) => impact.repositoryId);
    if (!affectedIds.length) return { supported: false, reason: "The approved plan does not identify an affected repository." };
    if (affectedIds.length > 1) {
      const affected = affectedIds.map((id) => product.repositories.find((repository) => repository.id === id));
      const missing = affectedIds.filter((_, index) => !affected[index]?.localPath);
      if (missing.length) return { supported: false, reason: `Register local checkouts for every affected repository: ${missing.join(", ")}` };
      const incompatible = affected.flatMap((repository) => repository?.inspection?.compatibilityIssues.map((issue) => `${repository.name}: ${issue}`) ?? []);
      if (incompatible.length) return { supported: false, reason: `Resolve repository compatibility issues before execution: ${incompatible.join("; ")}` };
      const invalidTasks = plan.tasks.filter((task) => (task.repositoryIds ?? []).length !== 1 || !affectedIds.includes((task.repositoryIds ?? [])[0]!));
      if (invalidTasks.length) return { supported: false, reason: `Each DH-720 task must target exactly one affected repository: ${invalidTasks.map((task) => task.id).join(", ")}` };
      if (!(plan.integrationConditions ?? []).length) return { supported: false, reason: "Multi-repository execution requires explicit integration conditions." };
      return { supported: true, reason: `Exact integration-set execution is available for ${affectedIds.length} compatible local repositories.` };
    }
    const repository = product.repositories.find((item) => item.id === affectedIds[0]);
    if (!repository?.localPath) return { supported: false, reason: "The single affected repository does not have a registered local checkout." };
    if (path.resolve(repository.localPath) !== path.resolve(objective.projectPath)) {
      return { supported: false, reason: "Set the objective project folder to the affected repository's registered local checkout before execution." };
    }
    if (repository.inspection?.compatibilityIssues.length) {
      return { supported: false, reason: `Resolve repository compatibility issues before execution: ${repository.inspection.compatibilityIssues.join("; ")}` };
    }
    return { supported: true, reason: "The plan affects one compatible registered local repository." };
  }

  async consultWorkbench(input: {
    sessionId: string;
    projectPath: string;
    question: string;
    discussionContext: string;
    modelIds: string[];
    persist?: (consultations: WorkbenchConsultationResult[]) => Promise<void> | void;
  }): Promise<WorkbenchConsultationResult[]> {
    const projectPath = path.resolve(input.projectPath);
    const config = await loadConfig(projectPath);
    if (!input.question.trim()) throw new Error("Workbench question is required");
    if (!input.modelIds.length) throw new Error("Select at least one qualified model to consult");

    const modelIds = [...new Set(input.modelIds)];
    const prompt = workbenchConsultationPrompt({
      projectPath,
      question: input.question,
      discussionContext: input.discussionContext,
    });
    const paidModels = modelIds.flatMap((modelId) => {
      const model = this.ledger.getModel(modelId);
      const connection = model ? this.ledger.listConnections().find((item) => item.id === model.connectionId) : null;
      return model && connection?.provider === "openrouter" && model.active && !model.excluded && !model.retired && !model.qualificationStale ? [model] : [];
    });
    let paidBudgetError: Error | null = null;
    let paidSpendReservation: PaidSpendReservation | null = null;
    if (paidModels.length) {
      try {
        const costCeiling = paidModels.reduce((sum, model) => sum + requireInvocationCostCeiling(model, prompt), 0);
        paidSpendReservation = await new OpenRouterService(this.ledger).acquirePaidWorkbench(config, input.sessionId, costCeiling, paidModels.length);
        if (!input.persist) {
          paidSpendReservation.cancelBeforeInvocation();
          paidSpendReservation = null;
          paidBudgetError = new Error("Paid Workbench consultations require a durable receipt before the spending gate can be released");
        }
      } catch (error) {
        paidBudgetError = error instanceof Error ? error : new Error(String(error));
      }
    }
    paidSpendReservation?.markInvoked();

    const consultations = await Promise.all(modelIds.map(async (modelId) => {
      const model = this.ledger.getModel(modelId);
      const connection = model ? this.ledger.listConnections().find((item) => item.id === model.connectionId) : null;
      const provider = connection?.provider ?? "unknown";
      const failed = (error: unknown) => ({
        requestedModelId: modelId,
        provider,
        connectionId: connection?.id ?? null,
        resolvedModelId: null,
        text: null,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        paidSpendReservationId: provider === "openrouter" ? paidSpendReservation?.id ?? null : null,
      });
      if (!model || !connection) return failed(new Error("Selected model is no longer in the current fleet"));
      if (!model.active || model.excluded || model.retired || model.qualificationStale) {
        return failed(new Error("Selected model is not active and currently qualified"));
      }
      if (provider === "openrouter" && !(config.openRouter.enabled && config.openRouter.allowPaidFallback && config.runPolicy.allowPaidApi)) {
        return failed(new Error("Paid API consultation is disabled by project policy"));
      }
      if (provider === "openrouter" && paidBudgetError) return failed(paidBudgetError);

      const consultationConfig: DevHarmonicsConfig = {
        ...config,
        routing: {
          ...config.routing,
          mode: "manual",
          allowFallback: false,
          reviewer: { ...config.routing.reviewer, modelId: model.id, upgradePolicy: "pinned" },
        },
      };
      try {
        const decision = new ModelRouter(this.ledger).route({
          role: "reviewer",
          config: consultationConfig,
          fallbackProvider: provider as ProviderName,
          allowedProviders: [provider],
          permission: "read_only",
        });
        if (String(decision.model.requestedModelId) !== model.id) {
          throw new Error("Workbench model selection did not resolve to the exact requested model");
        }
        const adapter = await this.provider(decision.provider, consultationConfig, decision.connectionId);
        const result = await adapter.invoke({
          role: "reviewer",
          prompt,
          cwd: projectPath,
          permission: "read_only",
          timeoutMs: null,
          maxOutputTokens: OPENROUTER_MAX_OUTPUT_TOKENS,
          model: decision.model,
        });
        this.recordConnectionOutcome(adapter.connection.id, { success: true });
        this.recordModelOutcome(model.id, { success: true });
        return {
          requestedModelId: model.id,
          provider: result.provider,
          connectionId: String(result.connectionId),
          resolvedModelId: String(result.model.resolvedModelId),
          text: result.text,
          status: "complete" as const,
          error: null,
          durationMs: result.durationMs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          paidSpendReservationId: provider === "openrouter" ? paidSpendReservation?.id ?? null : null,
        };
      } catch (error) {
        const failureKind = error instanceof RuntimeInvocationError ? error.kind : "incompatible";
        this.recordConnectionOutcome(connection.id, { success: false, failureKind, detail: error instanceof Error ? error.message : String(error) });
        this.recordModelOutcome(model.id, { success: false, failureKind, detail: error instanceof Error ? error.message : String(error) });
        return failed(error);
      }
    }));
    await input.persist?.(consultations);
    if (paidSpendReservation) {
      const paidModelIds = new Set(paidModels.map((model) => model.id));
      const paidConsultations = consultations.filter((consultation) => paidModelIds.has(consultation.requestedModelId));
      if (paidConsultations.length === paidModels.length && paidConsultations.every((consultation) => consultation.status === "complete" && consultation.costUsd !== null)) {
        paidSpendReservation.settleAfterDurableReceipt();
      }
    }
    return consultations;
  }

  beginApprovedObjective(input: {
    objective: ObjectiveRecord;
    revision: PlanRevisionRecord;
    agents?: number | "auto";
    enabledProviders?: ProviderName[];
  }): string {
    if (!input.revision.approved || input.revision.objectiveId !== input.objective.id) {
      throw new Error("Only the exact approved plan revision can start execution");
    }
    const readiness = this.objectiveExecutionReadiness(input.objective, input.revision.plan);
    if (!readiness.supported) throw new Error(readiness.reason);
    return this.begin({
      goal: objectivePromptText(input.objective),
      projectPath: input.objective.projectPath,
      autonomy: input.objective.autonomy,
      agents: input.agents,
      enabledProviders: input.enabledProviders,
      approvedPlan: input.revision.plan,
      objectiveLink: { objectiveId: input.objective.id, approvedPlanRevision: input.revision.revision },
    });
  }

  async run(request: RunRequest): Promise<string> {
    const runId = this.begin(request);
    await this.backgroundRuns.get(runId);
    return runId;
  }

  async shutdown(): Promise<void> {
    const activeRuns = [...this.backgroundRuns.entries()];
    for (const [runId] of activeRuns) this.pause(runId);
    await Promise.allSettled(activeRuns.map(([, execution]) => execution));
  }

  private async execute(runId: string, request: RunRequest, signal: AbortSignal): Promise<void> {
    const projectPath = path.resolve(request.projectPath);
    const config = await loadConfig(projectPath);
    const autonomy = request.autonomy ?? config.runPolicy.autonomy;
    config.runPolicy.autonomy = autonomy;
    this.ledger.setRunAutonomy(runId, autonomy);
    const constitution = await loadConstitution(projectPath);
    const configuredProviders = this.availableProviders(config, request.enabledProviders);

    const providerStatuses = await inspectProviders(config, projectPath);
    syncSubscriptionConnections(this.ledger, providerStatuses);
    await syncOllamaRuntimes(this.ledger, config.localRuntimes.ollama);
    const unavailable = providerStatuses.filter(
      (provider) => configuredProviders.includes(provider.name) && !provider.available,
    );
    // A signed-out subscription is not a usable provider, so it is removed from
    // the pool rather than being allowed to fail an invocation later. This is
    // the same fact the old gate refused on — it is now an input to routing
    // instead of a refusal in front of it.
    const availableProviders = configuredProviders.filter((name) =>
      !unavailable.some((provider) => provider.name === name)
      && this.ledger.isConnectionEligible(projectLegacyProvider(name).connectionId),
    );
    const workerProviders = config.product.workers.filter((name) => availableProviders.includes(name));
    // Planning requires a subscription architect, because no local model is
    // architect-qualified. Starting an ALREADY-APPROVED plan does not: the plan
    // exists, and qualified local models can carry the work and review it. So a
    // run is gated on whether its roles can actually be routed, and nothing
    // else. Refusing first on "no subscription configured" or "a configured
    // subscription is signed out" was a subscription-only refusal standing in
    // front of exactly the question the router can answer — an audit found
    // three of that class, and this was the last one.
    //
    // Both halves must route: work no reviewer can review is not a run that can
    // finish. Sign-in and health details are reported as the REASON when a role
    // cannot be routed, rather than as a gate before asking.
    const missingRole = !canRoute(this.ledger, workerClassProbe(config, workerProviders))
      ? "worker"
      : !canRoute(this.ledger, { role: "reviewer", config, fallbackProvider: availableProviders[0] ?? null, allowedProviders: availableProviders, permission: "read_only", task: null })
        ? "reviewer"
        : null;
    if (missingRole) {
      const health = this.ledger.listConnectionHealth().filter((item) => configuredProviders.some((name) => projectLegacyProvider(name).connectionId === item.connectionId));
      const signIn = unavailable
        .map((provider) => `${provider.name}: ${provider.summary}${provider.authenticated ? "" : `; run '${provider.loginCommand}'`}`)
        .join("; ");
      const detail = [
        ...(configuredProviders.length ? [] : ["no subscription-backed provider is enabled"]),
        ...(signIn ? [`sign-in required — ${signIn}`] : []),
        ...health.map((item) => `${item.connectionId}: ${item.state}${item.cooldownUntil ? ` until ${item.cooldownUntil}` : ""}`),
      ].join("; ");
      throw new Error(`No subscription or qualified local ${missingRole} is available for this run (${detail || "no eligible connection"})`);
    }

    const approvedObjective = request.objectiveLink ? this.ledger.getObjective(request.objectiveLink.objectiveId) : null;
    const affectedRepositoryIds = (request.approvedPlan?.repositoryImpact ?? [])
      .filter((impact) => impact.disposition === "affected")
      .map((impact) => impact.repositoryId);
    if (approvedObjective?.productId && request.approvedPlan && affectedRepositoryIds.length > 1) {
      await this.executeMultiRepository({
        runId,
        request,
        objective: approvedObjective,
        plan: request.approvedPlan,
        config,
        autonomy,
        availableProviders,
        workerProviders,
        signal,
      });
      return;
    }

    const worktrees = new WorktreeManager(projectPath, runId);
    await worktrees.initialize();
    this.ledger.addEvent(runId, "worktree.created", `Integration branch ${worktrees.integrationBranch}`);

    const architectName = availableProviders.includes(config.product.architect)
      ? config.product.architect
      : availableProviders[0]!;
    const router = new ModelRouter(this.ledger);
    const architectCandidates = config.routing.allowFallback
      ? [architectName, ...availableProviders.filter((provider) => provider !== architectName)]
      : [architectName];
    const excludedArchitectModels = new Set<string>();
    const excludedArchitectConnections = new Set<string>();
    let plan: RunPlan | null = request.approvedPlan ?? null;
    let lastArchitectError: Error | null = null;
    const planningCandidates = plan ? [] : architectCandidates;
    for (let candidateIndex = 0; candidateIndex < planningCandidates.length; candidateIndex++) {
      const candidate = planningCandidates[candidateIndex]!;
      const qualification = await ensureSchedulerProviderCandidateQualified({ ledger: this.ledger, config, cwd: worktrees.integrationPath, role: "architect", preferredProvider: candidate, permission: "read_only", excludedModelIds: excludedArchitectModels, excludedConnectionIds: excludedArchitectConnections, onResult: (result) => this.recordSchedulerQualification(runId, result, "architect") });
      if (qualification?.attempted && !qualification.passed) {
        lastArchitectError = new Error(`${qualification.provider} model '${qualification.modelId}' failed architect qualification`);
        continue;
      }
      const architectDecision = router.route({ role: "architect", config, fallbackProvider: candidate, allowedProviders: [candidate], permission: "read_only", excludedModelIds: excludedArchitectModels, excludedConnectionIds: excludedArchitectConnections });
      const architect = await this.provider(architectDecision.provider, config, architectDecision.connectionId);
      this.ledger.addEvent(runId, "architect.started", `${architectDecision.provider} is planning the run`, { routing: architectDecision });
      try {
        const prompt = architectPrompt({
          goal: request.goal,
          constitution,
          validators: Object.keys(config.repository.validators),
          providers: workerProviders,
          workspacePath: worktrees.integrationPath,
          autonomy,
        });
        const performArchitecture = async (paidSpendReservationId?: string) => {
          const result = await architect.invoke({
            role: "architect",
            prompt,
            cwd: worktrees.integrationPath,
            permission: "read_only",
            timeoutMs: null,
            maxOutputTokens: OPENROUTER_MAX_OUTPUT_TOKENS,
            model: architectDecision.model,
          }, { signal });
          this.recordInvocation(runId, null, "architect", architectDecision, result, null, paidSpendReservationId);
          return result;
        };
        const selected = architectDecision.model.requestedModelId ? this.ledger.getModel(String(architectDecision.model.requestedModelId)) : null;
        if (architectDecision.provider === "openrouter" && !selected) throw new Error("OpenRouter paid routing requires an exact selected model");
        const architectResult = architectDecision.provider === "openrouter"
          ? await new OpenRouterService(this.ledger).withPaidRoutingAllowed(config, runId, requireInvocationCostCeiling(selected!, prompt), (reservation) => performArchitecture(reservation.id))
          : await performArchitecture();
        if (signal.aborted) return;
        try {
          plan = this.parsePlan(architectResult.text, config, autonomy);
          this.recordConnectionOutcome(architect.connection.id, { success: true });
          if (architectDecision.model.requestedModelId) {
            const quotaGroup = modelQuotaGroup(this.ledger.getModel(String(architectDecision.model.requestedModelId)));
            if (quotaGroup) this.recordQuotaGroupOutcome(String(architect.connection.id), quotaGroup.id, quotaGroup.displayName, { success: true });
          }
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastArchitectError = new Error(`${architectDecision.provider} returned an invalid plan: ${message}`);
          this.recordScopedInvocationFailure({ connectionId: String(architect.connection.id), modelId: architectDecision.model.requestedModelId ? String(architectDecision.model.requestedModelId) : null, failureKind: "incompatible", detail: message, excludedModelIds: excludedArchitectModels, excludedConnectionIds: excludedArchitectConnections });
          this.ledger.addEvent(runId, "architect.failed", `${architectDecision.provider} returned an invalid plan; trying the next eligible architect`, {
            provider: architectDecision.provider,
            failureKind: "incompatible",
            result: normalizeAgentResult("architect", architectResult.text),
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        const failureKind = error instanceof RuntimeInvocationError ? error.kind : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        lastArchitectError = error instanceof Error ? error : new Error(message);
        const scope = this.recordScopedInvocationFailure({ connectionId: String(architect.connection.id), modelId: architectDecision.model.requestedModelId ? String(architectDecision.model.requestedModelId) : null, failureKind, detail: message, excludedModelIds: excludedArchitectModels, excludedConnectionIds: excludedArchitectConnections });
        if (scope === "quota_group" && this.hasEligibleModelOnConnection(String(architect.connection.id), excludedArchitectModels)) planningCandidates.splice(candidateIndex + 1, 0, candidate);
        this.ledger.addEvent(runId, "architect.failed", `${architectDecision.provider} could not produce a plan; trying the next eligible architect`, {
          provider: architectDecision.provider,
          failureKind,
          detail: message,
        });
      }
    }
    if (!plan) throw lastArchitectError ?? new Error("No eligible architect produced a valid plan");
    this.ledger.savePlan(runId, plan);
    if (request.approvedPlan) {
      this.ledger.addEvent(runId, "plan.approved", "Exact objective plan revision approved for execution", {
        objectiveId: request.objectiveLink?.objectiveId ?? null,
        approvedPlanRevision: request.objectiveLink?.approvedPlanRevision ?? plan.revision ?? 1,
      });
    }
    if (config.runPolicy.requirePlanApproval && !request.approvedPlan) {
      this.ledger.requestPlanApproval(runId);
      await new Promise<void>((resolve) => {
        const complete = () => resolve();
        this.approvalResolvers.set(runId, complete);
        signal.addEventListener("abort", complete, { once: true });
      });
      if (signal.aborted) return;
    }

    const requestedAgents = request.agents ??
      (config.application.concurrency.mode === "auto" ? "auto" : config.application.concurrency.agents);
    const requestedConcurrency = requestedAgents === "auto" ? plan.recommendedConcurrency : requestedAgents;
    const capacity = new CapacityBroker().decide({ requestedConcurrency, userCeiling: config.application.concurrency.ceiling, resources: await observeLocalResources() });
    const concurrency = capacity.effectiveConcurrency;
    this.ledger.addEvent(runId, "scheduler.started", `Scheduler using concurrency ${concurrency}`, { capacity });

    const statuses = new Map<string, TaskStatus>(plan.tasks.map((task) => [task.id, "queued"]));
    const pending = new Map(plan.tasks.map((task) => [task.id, task]));
    const active = new Map<string, Promise<void>>();
    let providerCursor = 0;
    let admissionHeld = false;

    while (pending.size || active.size) {
      // On cancel, stop scheduling. In-flight worker processes are aborted via
      // the shared signal and their tasks return 'cancelled'; ledger.cancelRun
      // owns the run/task status, so return without running integration/review.
      if (await settleActiveAttemptsIfAborted(signal, active.values())) return;

      for (const [taskId, task] of pending) {
        if (task.dependencies.some((dependency) => ["failed", "blocked"].includes(statuses.get(dependency) ?? ""))) {
          statuses.set(taskId, "blocked");
          pending.delete(taskId);
          this.ledger.setTaskStatus(runId, taskId, "blocked");
          this.ledger.addEvent(runId, "task.blocked", `${task.title} blocked by a failed dependency`);
          this.ledger.dispositionUnreachableSteering(runId, { taskId, reason: "The task was blocked by a failed dependency and will not run" });
        }
      }

      const readyTasks = [...pending.values()].filter((task) =>
        task.dependencies.every((dependency) => statuses.get(dependency) === "passed"),
      );

      // DH-635: the admission point is a safe boundary. Consume admission-scoped
      // steering here so a redirect never lands mid-attempt.
      const steered = planSteeredAdmission({
        pending: this.ledger.pendingSteeringDirectives(runId).filter((directive) => ADMISSION_STEERING_KINDS.includes(directive.kind)),
        ready: readyTasks,
        queued: [...pending.values()],
        admissionHeld,
        allowedProviders: workerProviders,
      });
      admissionHeld = steered.admissionHeld;
      for (const item of steered.applied) this.ledger.resolveSteeringDirective(item.id, { disposition: "applied", reason: item.reason });
      for (const item of steered.rejected) this.ledger.resolveSteeringDirective(item.id, { disposition: "rejected", reason: item.reason });
      const ready = steered.ordered;

      while (active.size < concurrency && ready.length) {
        const task = ready.shift()!;
        pending.delete(task.id);
        const startCursor = providerCursor++;
        const taskPromise = this.executeTask({
          runId,
          goal: request.goal,
          task,
          constitution,
          config,
          providers: workerProviders,
          providerCursor: startCursor,
          worktrees,
          signal,
        })
          .then((status) => {
            statuses.set(task.id, status);
          })
          .finally(() => {
            active.delete(task.id);
          });
        active.set(task.id, taskPromise);
      }

      if (active.size) {
        await Promise.race(active.values());
      } else if (admissionHeld && pending.size) {
        // Held on purpose: the queue is idle because the owner paused admission,
        // not because the graph is stuck. Wait for a resume directive.
        await delay(500);
      } else if (pending.size) {
        throw new Error("The task graph cannot make progress; check for cyclic dependencies");
      }
    }

    // A cancel that lands as the scheduler drains must still skip the final
    // integration + reviewer phase so it cannot overwrite the 'cancelled' run.
    if (await settleActiveAttemptsIfAborted(signal, active.values())) return;

    let failed = [...statuses.values()].some((status) => status !== "passed");
    const integrationChecks = autonomy === "observe" ? [] : [...new Set(plan.tasks.flatMap((task) => task.checks))];
    if (integrationChecks.length) {
      this.ledger.addIntegrationTask(runId, integrationChecks);
      this.ledger.setTaskStatus(runId, "__integration__", "verifying");
      const integrationTask: PlannedTask = {
        id: "__integration__",
        title: "Integration suite",
        description: "Validate the combined integration branch",
        dependencies: [],
        preferredProvider: null,
        checks: integrationChecks,
      };
      const results = await this.verifyTask(
        { runId, task: integrationTask, config },
        worktrees.integrationPath,
      );
      const integrationPassed = results.every((check) => check.passed);
      this.ledger.setTaskStatus(
        runId,
        "__integration__",
        integrationPassed ? "passed" : "failed",
      );
      this.ledger.addEvent(
        runId,
        integrationPassed ? "integration.passed" : "integration.failed",
        integrationPassed ? "Combined branch passed integration checks" : "Combined branch failed integration checks",
      );
      failed ||= !integrationPassed;
    }
    if (autonomy !== "observe") {
      const integrity = analyzeVerificationIntegrity(await worktrees.integrationDiffFiles());
      const integrityTaskId = integrationChecks.length ? "__integration__" : plan.tasks[0]!.id;
      this.ledger.recordCheck(runId, integrityTaskId, {
        name: "verification-integrity",
        passed: integrity.passed,
        exitCode: integrity.passed ? 0 : 1,
        stdout: JSON.stringify({ summary: integrity.summary, census: integrity.census, findings: integrity.findings }, null, 2),
        stderr: "",
        durationMs: 0,
      });
      if (!integrity.passed) {
        this.ledger.addBlackboardEntry({ runId, taskId: integrityTaskId, kind: "risk", content: integrity.summary, sourceAttemptId: null });
        failed = true;
      }
    }
    const checkSummary = this.checkSummary(runId);
    const taskReports = this.taskReportSummary(runId);
    const integrationStatus = await worktrees.status();
    const integrationReviewEvidence = this.reviewEvidence({
      runId,
      autonomy,
      plan,
      taskReports,
      diff: autonomy === "observe" ? [] : await worktrees.integrationDiffFiles(),
      repositories: [{ repositoryId: integrationStatus.repositoryRoot, baseCommit: integrationStatus.baseCommit, headCommit: integrationStatus.headCommit }],
    });
    const integrationReviewSha256 = integrationReviewEvidence.sha256;
    // Null when no subscription provider is available at all. Planning still
    // refuses an empty provider list, so this is defensive rather than a live
    // defect — but the previous `availableProviders[0]!` produced `undefined`
    // typed as a ProviderName, which is a lie the compiler cannot catch and the
    // exact hazard class an audit flagged elsewhere on this path.
    const reviewerName = availableProviders.includes(config.product.reviewer)
      ? config.product.reviewer
      : availableProviders[0] ?? null;
    const reviewerProviders = this.openRouterEligible(config) ? [...availableProviders, "openrouter"] : availableProviders;
    const implementationProviders = [...new Set(
      (this.ledger.getRun(runId)?.tasks ?? [])
        .filter((task) => task.id !== "__integration__" && task.provider)
        .map((task) => String(task.provider)),
    )];
    const reviewPolicy = reviewRequirement(plan.tasks, config.reviewPolicy);
    const excludedReviewerModels = new Set<string>();
    const excludedReviewerConnections = new Set<string>();
    if (reviewPolicy.requireImplementorIndependence) {
      for (const connection of this.ledger.listConnections()) {
        if (implementationProviders.includes(connection.provider)) excludedReviewerConnections.add(connection.id);
      }
    }
    let reviewText: string | null = null;
    let completedReviewerIdentity: { provider: string; modelId: string | null; connectionId: string } | null = null;
    let reviewerFallbackReason: string | null = null;
    let lastReviewerError: Error | null = null;
    for (let reviewAttempt = 1; reviewAttempt <= config.application.retry.maxAttempts; reviewAttempt++) {
      const reviewerStart = reviewerName ? reviewerProviders.indexOf(reviewerName) : -1;
      const qualificationProviders = reviewerProviders.map((_, index) => reviewerProviders[(Math.max(0, reviewerStart) + reviewAttempt - 1 + index) % reviewerProviders.length]!);
      // No subscription candidate to qualify leaves the router to choose among
      // already-qualified local reviewers, exactly as the worker path does.
      let reviewerFallbackProvider: ProviderName | null = (qualificationProviders[0] ?? null) as ProviderName | null;
      for (const qualificationProvider of qualificationProviders) {
        const qualification = await ensureSchedulerCandidateQualified({ ledger: this.ledger, config, cwd: worktrees.integrationPath, role: "reviewer", preferredProvider: qualificationProvider, permission: "read_only", excludedModelIds: excludedReviewerModels, excludedConnectionIds: excludedReviewerConnections });
        this.recordSchedulerQualification(runId, qualification, "reviewer");
        if (qualification?.attempted && !qualification.passed) {
          excludedReviewerModels.add(qualification.modelId);
          reviewerFallbackReason = `${qualification.provider} reviewer candidate failed scheduler-time qualification`;
          lastReviewerError = new Error(reviewerFallbackReason);
          continue;
        }
        if (qualification?.passed) {
          reviewerFallbackProvider = qualification.provider as ProviderName;
          break;
        }
      }
      let reviewerDecision;
      try {
        reviewerDecision = router.route({
          role: "reviewer",
          config,
          fallbackProvider: reviewerFallbackProvider,
          allowedProviders: reviewerProviders,
          permission: "read_only",
          excludedModelIds: excludedReviewerModels,
          excludedConnectionIds: excludedReviewerConnections,
          avoidProviders: implementationProviders,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastReviewerError = error instanceof Error ? error : new Error(message);
        reviewerFallbackReason = message;
        continue;
      }
      const reviewer = await this.provider(reviewerDecision.provider, config, reviewerDecision.connectionId);
      this.ledger.addEvent(runId, "review.started", `${reviewerDecision.provider} is reviewing the ${autonomy === "observe" ? "diagnostic reports" : "integration branch"}${reviewAttempt > 1 ? ` (fallback ${reviewAttempt})` : ""}`, { routing: reviewerDecision, reviewAttempt, fallbackReason: reviewerFallbackReason });
      try {
        if (reviewer.connection.capabilities.providerManagedTools) {
          const review = await reviewer.invoke({
            role: "reviewer",
            prompt: reviewerPrompt({ goal: request.goal, constitution, plan, checkSummary, taskReports, workspacePath: worktrees.integrationPath, autonomy }),
            cwd: worktrees.integrationPath,
            permission: "read_only",
            timeoutMs: null,
            maxOutputTokens: OPENROUTER_MAX_OUTPUT_TOKENS,
            model: reviewerDecision.model,
          }, { signal });
          this.recordInvocation(runId, null, "reviewer", reviewerDecision, review, reviewerFallbackReason);
          reviewText = review.text;
        } else {
          const diffFiles = await worktrees.integrationDiffFiles();
          const chunks = autonomy === "observe" ? this.diagnosticReportChunks(runId) : chunkDiffFiles(diffFiles);
          const localTaskReports = autonomy === "observe" ? "Each accepted diagnostic report is supplied as an independent evidence chunk." : taskReports;
          const performReview = (paidSpendReservationId?: string) => runContextOnlyReview({
            adapter: reviewer,
            model: reviewerDecision.model,
            cwd: worktrees.integrationPath,
            contextHeader: localReviewerContextHeader({ goal: request.goal, constitution, plan, checkSummary, taskReports: localTaskReports, autonomy }),
            chunks,
            evidenceLabel: autonomy === "observe" ? "diagnostic report" : "diff chunk",
            maxOutputTokens: 512,
            signal,
            onChunk: (receipt, index, total) => {
              this.ledger.addEvent(runId, "review.chunk_completed", `${reviewerDecision.provider} reviewed chunk ${index + 1}/${total}: ${receipt.label} — ${receipt.verdict}`, { label: receipt.label, verdict: receipt.verdict, durationMs: receipt.durationMs, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costUsd: receipt.costUsd });
              this.ledger.recordInvocationReceipt({ runId, role: "reviewer", provider: receipt.provider, connectionId: receipt.connectionId, requestedModelId: reviewerDecision.model.requestedModelId ? String(reviewerDecision.model.requestedModelId) : null, resolvedModelId: receipt.resolvedModelId, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costUsd: receipt.costUsd, durationMs: receipt.durationMs, workloadClass: "complex:premium", fallbackReason: reviewerFallbackReason ?? (reviewerDecision.fallback ? reviewerDecision.factors.join("; ") : null), ...(paidSpendReservationId ? { paidSpendReservationId } : {}) });
            },
          });
          const selected = reviewerDecision.model.requestedModelId ? this.ledger.getModel(String(reviewerDecision.model.requestedModelId)) : null;
          if (reviewerDecision.provider === "openrouter" && !selected) throw new Error("OpenRouter paid routing requires an exact selected model");
          const costCeiling = reviewerDecision.provider === "openrouter" ? requireInvocationCostCeiling(selected!, "", 512) * chunks.length : 0;
          const review = reviewerDecision.provider === "openrouter"
            ? await new OpenRouterService(this.ledger).withPaidRoutingAllowed(config, runId, costCeiling, (reservation) => performReview(reservation.id), chunks.length)
            : await performReview();
          reviewText = review.text;
        }
        completedReviewerIdentity = {
          provider: reviewerDecision.provider,
          modelId: reviewerDecision.model.requestedModelId ? String(reviewerDecision.model.requestedModelId) : null,
          connectionId: String(reviewer.connection.id),
        };
        this.recordConnectionOutcome(reviewer.connection.id, { success: true });
        if (reviewerDecision.model.requestedModelId) {
          const modelId = String(reviewerDecision.model.requestedModelId);
          this.recordModelOutcome(modelId, { success: true });
          const quotaGroup = modelQuotaGroup(this.ledger.getModel(modelId));
          if (quotaGroup) this.recordQuotaGroupOutcome(String(reviewer.connection.id), quotaGroup.id, quotaGroup.displayName, { success: true });
        }
        break;
      } catch (error) {
        if (signal.aborted) return;
        const failureKind = error instanceof RuntimeInvocationError ? error.kind : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        lastReviewerError = error instanceof Error ? error : new Error(message);
        reviewerFallbackReason = `${reviewerDecision.provider} review failed (${failureKind}): ${message}`;
        this.recordScopedInvocationFailure({
          connectionId: String(reviewer.connection.id),
          modelId: reviewerDecision.model.requestedModelId ? String(reviewerDecision.model.requestedModelId) : null,
          failureKind,
          detail: message,
          excludedModelIds: excludedReviewerModels,
          excludedConnectionIds: excludedReviewerConnections,
        });
        this.ledger.addEvent(runId, "review.failed", `${reviewerFallbackReason}; trying the next eligible reviewer`, { provider: reviewerDecision.provider, connectionId: reviewer.connection.id, modelId: reviewerDecision.model.requestedModelId, failureKind, reviewAttempt });
      }
    }
    if (reviewText === null) throw lastReviewerError ?? new Error("No eligible reviewer completed final review");
    if (!completedReviewerIdentity) throw new Error("Completed final review is missing its reviewer identity");
    const firstReview = parseReviewerResponse(reviewText, completedReviewerIdentity);
    const firstReceiptId = this.ledger.recordReviewReceipt({
      runId,
      round: 1,
      integrationSha256: integrationReviewSha256,
      evidenceBinding: integrationReviewEvidence.binding,
      review: firstReview,
    });
    this.ledger.addEvent(runId, "review.completed", `${firstReview.provider} completed quorum review 1/${reviewPolicy.requiredReviewers}: ${firstReview.verdict.replace("_", " ")}`, { receiptId: firstReceiptId, reviewSlot: 1, provider: firstReview.provider, modelId: firstReview.modelId, connectionId: firstReview.connectionId, verdict: firstReview.verdict, findingCount: firstReview.findings.length, integrationSha256: integrationReviewSha256 });
    const structuredReviews: StructuredReview[] = [firstReview];
    excludedReviewerConnections.add(firstReview.connectionId);
    if (firstReview.modelId) excludedReviewerModels.add(firstReview.modelId);
    if (reviewPolicy.minimumDistinctProviders > 1) {
      for (const connection of this.ledger.listConnections()) {
        if (connection.provider === firstReview.provider) excludedReviewerConnections.add(connection.id);
      }
    }
    for (let reviewSlot = 2; reviewSlot <= reviewPolicy.requiredReviewers; reviewSlot++) {
      const additional = await this.completeQuorumReview({
        runId,
        reviewSlot,
        requiredReviewers: reviewPolicy.requiredReviewers,
        reviewerName,
        reviewerProviders,
        implementationProviders,
        excludedReviewerModels,
        excludedReviewerConnections,
        config,
        worktrees,
        signal,
        goal: request.goal,
        constitution,
        plan,
        checkSummary,
        taskReports,
        autonomy,
      });
      const receiptId = this.ledger.recordReviewReceipt({ runId, round: 1, integrationSha256: integrationReviewSha256, evidenceBinding: integrationReviewEvidence.binding, review: additional });
      structuredReviews.push(additional);
      this.ledger.addEvent(runId, "review.completed", `${additional.provider} completed quorum review ${reviewSlot}/${reviewPolicy.requiredReviewers}: ${additional.verdict.replace("_", " ")}`, { receiptId, reviewSlot, provider: additional.provider, modelId: additional.modelId, connectionId: additional.connectionId, verdict: additional.verdict, findingCount: additional.findings.length, integrationSha256: integrationReviewSha256 });
      excludedReviewerConnections.add(additional.connectionId);
      if (additional.modelId) excludedReviewerModels.add(additional.modelId);
      if (new Set(structuredReviews.map((review) => review.provider)).size < reviewPolicy.minimumDistinctProviders) {
        for (const connection of this.ledger.listConnections()) {
          if (connection.provider === additional.provider) excludedReviewerConnections.add(connection.id);
        }
      }
    }
    let finalQuorum = adjudicateReviewQuorum({ requirement: reviewPolicy, implementationProviders, reviews: structuredReviews });
    let finalReviews = structuredReviews;
    let finalReviewSha256 = integrationReviewSha256;
    for (let fixRound = 1; !finalQuorum.passed && finalQuorum.openFindings.length && autonomy !== "observe" && fixRound <= config.reviewPolicy.maxFixRounds; fixRound++) {
      const reviewerSet = new Set(finalReviews.map((review) => review.provider));
      const fixerProviders = workerProviders.filter((provider) => !reviewerSet.has(provider));
      const reviewerConnectionIds = this.connectionIdsForProviders(reviewerSet);
      const repairTask: PlannedTask = {
        id: `__review_fix_${fixRound}`,
        title: `Resolve review findings (round ${fixRound})`,
        description: `Correct only these retained review findings:\n${finalQuorum.openFindings.map((finding) => `- ${finding.severity.toUpperCase()} ${finding.location ?? "location not supplied"}: ${finding.rationale}\n  Suggested correction: ${finding.suggestedCorrection}`).join("\n")}`,
        dependencies: [],
        preferredProvider: fixerProviders[0] ?? null,
        checks: integrationChecks.length ? integrationChecks : ["diff-check"],
        kind: "repair",
        repositoryScope: [...new Set(finalQuorum.openFindings.map((finding) => finding.location?.split(":")[0]).filter((value): value is string => Boolean(value)))].length
          ? [...new Set(finalQuorum.openFindings.map((finding) => finding.location?.split(":")[0]).filter((value): value is string => Boolean(value)))]
          : ["."],
        permission: "workspace_write",
        risk: reviewPolicy.risk,
        capabilityNeeds: ["implementation", "repair"],
        acceptanceCriteria: finalQuorum.openFindings.map((finding) => finding.suggestedCorrection),
        expectedArtifacts: ["committed repair diff", "passing validator receipts"],
      };
      // A repair needs an implementor independent of the quorum, not a
      // *subscription* one. This gate derived its candidates from the
      // subscription worker pool alone, so a run that had successfully fallen
      // back to local execution still stopped dead at its own fix round.
      // Connections belonging to a provider that reviewed are excluded by
      // identity, so independence is preserved for local models too.
      if (!fixerProviders.length && !canRoute(this.ledger, {
        role: "worker",
        config,
        fallbackProvider: null,
        allowedProviders: [],
        permission: "workspace_write",
        task: repairTask,
        excludedConnectionIds: reviewerConnectionIds,
      })) {
        this.ledger.addEvent(runId, "fixer.failed", "No implementor independent from the review quorum is available", { fixRound, reviewerProviders: [...reviewerSet] });
        break;
      }
      this.ledger.addTask(runId, repairTask);
      this.ledger.addEvent(runId, "fixer.started", `${repairTask.preferredProvider ?? "a qualified local implementor"} is addressing ${finalQuorum.openFindings.length} open review finding(s)`, { fixRound, taskId: repairTask.id, findings: finalQuorum.openFindings.map((finding) => finding.id), excludedReviewerProviders: [...reviewerSet] });
      const fixStatus = await this.executeTask({ runId, goal: request.goal, task: repairTask, constitution, config, providers: fixerProviders, providerCursor: providerCursor + fixRound, worktrees, signal, excludeConnectionIds: reviewerConnectionIds });
      if (fixStatus !== "passed") {
        this.ledger.addEvent(runId, "fixer.failed", `Review fixer round ${fixRound} did not pass its validators`, { fixRound, taskId: repairTask.id, status: fixStatus });
        break;
      }
      const postFixChecks = await this.verifyTask({ runId, task: repairTask, config }, worktrees.integrationPath);
      if (!postFixChecks.every((check) => check.passed)) {
        this.ledger.addEvent(runId, "fixer.failed", `Review fixer round ${fixRound} failed integration validation`, { fixRound, taskId: repairTask.id });
        break;
      }
      const refreshedTaskReports = this.taskReportSummary(runId);
      const refreshedCheckSummary = this.checkSummary(runId);
      const refreshedStatus = await worktrees.status();
      const refreshedEvidence = this.reviewEvidence({ runId, autonomy, plan, taskReports: refreshedTaskReports, diff: await worktrees.integrationDiffFiles(), repositories: [{ repositoryId: refreshedStatus.repositoryRoot, baseCommit: refreshedStatus.baseCommit, headCommit: refreshedStatus.headCommit }] });
      const refreshedSha256 = refreshedEvidence.sha256;
      if (refreshedSha256 === finalReviewSha256) {
        this.ledger.addEvent(runId, "fixer.failed", `Review fixer round ${fixRound} produced no change to the reviewed integration evidence`, { fixRound, taskId: repairTask.id, integrationSha256: refreshedSha256 });
        break;
      }
      const invalidated = this.ledger.invalidateReviewReceipts(runId, `Fixer round ${fixRound} changed integration evidence from ${finalReviewSha256} to ${refreshedSha256}`);
      this.ledger.addEvent(runId, "review.invalidated", `Fixer round ${fixRound} invalidated ${invalidated} prior review receipt(s)`, { fixRound, invalidated, previousIntegrationSha256: finalReviewSha256, integrationSha256: refreshedSha256 });
      this.ledger.addEvent(runId, "fixer.completed", `Review fixer round ${fixRound} passed integration validation; bounded re-review is required`, { fixRound, taskId: repairTask.id, integrationSha256: refreshedSha256 });
      const refreshedImplementors = [...new Set((this.ledger.getRun(runId)?.tasks ?? []).filter((task) => task.id !== "__integration__" && task.provider).map((task) => String(task.provider)))];
      const rereview = await this.completeReviewRound({ runId, round: fixRound + 1, integrationSha256: refreshedSha256, evidenceBinding: refreshedEvidence.binding, requirement: reviewPolicy, reviewerName, reviewerProviders, implementationProviders: refreshedImplementors, config, worktrees, signal, goal: request.goal, constitution, plan, checkSummary: refreshedCheckSummary, taskReports: refreshedTaskReports, autonomy });
      finalQuorum = rereview.decision;
      finalReviews = rereview.reviews;
      finalReviewSha256 = refreshedSha256;
    }
    const quorumText = `${finalQuorum.passed ? "READY" : "NOT READY"}\n\nReview quorum: ${finalQuorum.completedReviews}/${finalQuorum.requiredReviewers} completed across ${finalQuorum.distinctProviders} provider(s).${finalQuorum.reasons.length ? `\n${finalQuorum.reasons.join("\n")}` : "\nAll configured review gates passed."}\n\n${finalReviews.map((review, index) => `Reviewer ${index + 1} (${review.provider}${review.modelId ? ` / ${review.modelId}` : ""}): ${review.verdict.replace("_", " ")}\n${review.summary}`).join("\n\n")}`;
    this.ledger.addEvent(runId, finalQuorum.passed ? "review.quorum_passed" : "review.quorum_failed", finalQuorum.passed ? "Independent review quorum passed" : "Independent review quorum requires follow-up", { requirement: reviewPolicy, decision: finalQuorum, integrationSha256: finalReviewSha256 });
    const ready = !failed && finalQuorum.passed;
    if (ready && autonomy !== "observe") {
      const deliveryStatus = await worktrees.status();
      this.ledger.prepareDeliveryRepository({
        runId,
        repositoryId: deliveryStatus.repositoryRoot,
        localPath: deliveryStatus.repositoryRoot,
        baseBranch: deliveryStatus.baseBranch,
        baseCommit: deliveryStatus.baseCommit,
        headCommit: deliveryStatus.headCommit,
        branch: deliveryStatus.branch,
      });
    }
    this.ledger.setRunStatus(runId, ready ? "ready" : "not_ready", quorumText);
    this.ledger.addEvent(
      runId,
      ready ? "run.ready" : "run.not_ready",
      ready ? "Run passed final review" : "Run requires follow-up",
    );
  }

  private async executeMultiRepository(input: {
    runId: string;
    request: RunRequest;
    objective: ObjectiveRecord;
    plan: RunPlan;
    config: DevHarmonicsConfig;
    autonomy: RunAutonomy;
    availableProviders: ProviderName[];
    workerProviders: ProviderName[];
    signal: AbortSignal;
  }): Promise<void> {
    const productId = input.objective.productId;
    if (!productId) throw new Error("Multi-repository execution requires a registered product");
    const product = this.ledger.getProduct(productId);
    if (!product) throw new Error(`Product '${productId}' is no longer registered`);
    const affectedIds = (input.plan.repositoryImpact ?? []).filter((impact) => impact.disposition === "affected").map((impact) => impact.repositoryId);
    const integrationTaskIds = repositoryTaskIds("__integration__", affectedIds);
    const repositories = affectedIds.map((repositoryId) => {
      const repository = product.repositories.find((candidate) => candidate.id === repositoryId);
      if (!repository?.localPath) throw new Error(`Repository '${repositoryId}' does not have a registered local checkout`);
      if (repository.inspection?.compatibilityIssues.length) {
        throw new Error(`${repository.name} is not execution-compatible: ${repository.inspection.compatibilityIssues.join("; ")}`);
      }
      return repository;
    });
    for (const task of input.plan.tasks) {
      const repositoryIds = task.repositoryIds ?? [];
      if (repositoryIds.length !== 1 || !affectedIds.includes(repositoryIds[0]!)) {
        throw new Error(`Task '${task.id}' must target exactly one affected repository`);
      }
    }

    const integration = new IntegrationSetManager(input.runId, repositories.map((repository) => ({
      repositoryId: repository.id,
      projectPath: repository.localPath!,
    })));

    try {
      await integration.initialize();
      const initialStatus = await integration.status();
      this.ledger.createIntegrationSet({
        runId: input.runId,
        productId,
        integrationConditions: input.plan.integrationConditions ?? [],
        repositories: initialStatus.map((repository) => ({
          repositoryId: repository.repositoryId,
          localPath: repository.repositoryRoot,
          baseCommit: repository.baseCommit,
          integrationBranch: repository.branch,
          integrationWorktreePath: repository.path,
        })),
      });
      this.ledger.savePlan(input.runId, input.plan);
      this.ledger.addEvent(input.runId, "plan.approved", "Exact cross-repository objective plan revision approved for execution", {
        objectiveId: input.request.objectiveLink?.objectiveId ?? null,
        approvedPlanRevision: input.request.objectiveLink?.approvedPlanRevision ?? input.plan.revision ?? 1,
      });
      this.ledger.setIntegrationSetStatus(input.runId, "running");
      for (const repository of initialStatus) {
        this.ledger.updateIntegrationSetRepository(input.runId, repository.repositoryId, { status: "running", headCommit: repository.headCommit });
        this.ledger.addEvent(input.runId, "worktree.created", `${repository.repositoryId}: integration branch ${repository.branch}`, {
          repositoryId: repository.repositoryId,
          baseCommit: repository.baseCommit,
          integrationBranch: repository.branch,
          integrationWorktreePath: repository.path,
        });
      }

      const repositoryContexts = new Map<string, { config: DevHarmonicsConfig; constitution: string }>();
      for (const repository of repositories) {
        repositoryContexts.set(repository.id, await buildRepositoryContext(input.config, repository));
      }

      const requestedAgents = input.request.agents ??
        (input.config.application.concurrency.mode === "auto" ? "auto" : input.config.application.concurrency.agents);
      const requestedConcurrency = requestedAgents === "auto" ? input.plan.recommendedConcurrency : requestedAgents;
      const capacity = new CapacityBroker().decide({ requestedConcurrency, userCeiling: input.config.application.concurrency.ceiling, resources: await observeLocalResources() });
      const concurrency = capacity.effectiveConcurrency;
      this.ledger.addEvent(input.runId, "scheduler.started", `Cross-repository scheduler using concurrency ${concurrency}`, { capacity, repositoryCount: repositories.length });

      const statuses = new Map<string, TaskStatus>(input.plan.tasks.map((task) => [task.id, "queued"]));
      const pending = new Map(input.plan.tasks.map((task) => [task.id, task]));
      const active = new Map<string, Promise<void>>();
      let providerCursor = 0;
      let admissionHeld = false;
      while (pending.size || active.size) {
        if (await settleActiveAttemptsIfAborted(input.signal, active.values())) return;
        for (const [taskId, task] of pending) {
          if (task.dependencies.some((dependency) => ["failed", "blocked"].includes(statuses.get(dependency) ?? ""))) {
            statuses.set(taskId, "blocked");
            pending.delete(taskId);
            this.ledger.setTaskStatus(input.runId, taskId, "blocked");
            this.ledger.addEvent(input.runId, "task.blocked", `${task.title} blocked by a failed dependency`);
            this.ledger.dispositionUnreachableSteering(input.runId, { taskId, reason: "The task was blocked by a failed dependency and will not run" });
          }
        }
        const readyTasks = [...pending.values()].filter((task) => task.dependencies.every((dependency) => statuses.get(dependency) === "passed"));
        // DH-635: a multi-repository run honours admission steering exactly like a
        // single-repository one. Silently ignoring a directive here would be the
        // false steering claim the acceptance criteria prohibit.
        const steered = planSteeredAdmission({
          pending: this.ledger.pendingSteeringDirectives(input.runId).filter((directive) => ADMISSION_STEERING_KINDS.includes(directive.kind)),
          ready: readyTasks,
          queued: [...pending.values()],
          admissionHeld,
          allowedProviders: input.workerProviders,
        });
        admissionHeld = steered.admissionHeld;
        for (const item of steered.applied) this.ledger.resolveSteeringDirective(item.id, { disposition: "applied", reason: item.reason });
        for (const item of steered.rejected) this.ledger.resolveSteeringDirective(item.id, { disposition: "rejected", reason: item.reason });
        const ready = steered.ordered;
        while (active.size < concurrency && ready.length) {
          const task = ready.shift()!;
          pending.delete(task.id);
          const repositoryId = task.repositoryIds![0]!;
          const context = repositoryContexts.get(repositoryId)!;
          const manager = integration.manager(repositoryId);
          const taskPromise = this.executeTask({
            runId: input.runId,
            goal: input.request.goal,
            task,
            constitution: context.constitution,
            config: context.config,
            providers: input.workerProviders,
            providerCursor: providerCursor++,
            worktrees: manager,
            signal: input.signal,
          }).then(async (status) => {
            statuses.set(task.id, status);
            const headCommit = await manager.resolveIntegrationHead();
            this.ledger.updateIntegrationSetRepository(input.runId, repositoryId, {
              status: status === "passed" ? "running" : "failed",
              headCommit,
              ...(status === "passed" ? {} : { error: `Task '${task.id}' ended ${status}` }),
            });
          }).finally(() => active.delete(task.id));
          active.set(task.id, taskPromise);
        }
        if (active.size) await Promise.race(active.values());
        // Held on purpose: an idle queue under an owner hold is not a stuck graph.
        else if (admissionHeld && pending.size) await delay(500);
        else if (pending.size) throw new Error("The cross-repository task graph cannot make progress; check for cyclic dependencies");
      }
      if (await settleActiveAttemptsIfAborted(input.signal, active.values())) return;

      let aggregatedDiffs: Array<{ path: string; diff: string }> = [];
      for (const repository of repositories) {
        const repositoryId = repository.id;
        const context = repositoryContexts.get(repositoryId)!;
        const manager = integration.manager(repositoryId);
        let repositoryFailed = input.plan.tasks
          .filter((task) => task.repositoryIds?.[0] === repositoryId)
          .some((task) => statuses.get(task.id) !== "passed");
        const checks = input.autonomy === "observe" ? [] : [...new Set(input.plan.tasks.filter((task) => task.repositoryIds?.[0] === repositoryId).flatMap((task) => task.checks))];
        const integrationTaskId = integrationTaskIds.get(repositoryId)!;
        if (checks.length) {
          this.ledger.addIntegrationTask(input.runId, checks, integrationTaskId, `${repository.name} integration suite`);
          this.ledger.setTaskStatus(input.runId, integrationTaskId, "verifying");
          const integrationTask: PlannedTask = {
            id: integrationTaskId,
            title: `${repository.name} integration suite`,
            description: `Validate the ${repository.name} integration branch`,
            dependencies: [],
            repositoryIds: [repositoryId],
            preferredProvider: null,
            checks,
            permission: "workspace_write",
          };
          const results = await this.verifyTask({ runId: input.runId, task: integrationTask, config: context.config }, manager.integrationPath);
          const passed = results.every((check) => check.passed);
          this.ledger.setTaskStatus(input.runId, integrationTaskId, passed ? "passed" : "failed");
          this.ledger.addEvent(input.runId, passed ? "integration.passed" : "integration.failed", `${repository.name} integration checks ${passed ? "passed" : "failed"}`, { repositoryId });
          repositoryFailed ||= !passed;
        }
        const diffs = input.autonomy === "observe" ? [] : await manager.integrationDiffFiles();
        aggregatedDiffs.push(...diffs.map((diff) => ({ path: `${repositoryId}/${diff.path}`, diff: diff.diff })));
        if (input.autonomy !== "observe") {
          const integrity = analyzeVerificationIntegrity(diffs);
          this.ledger.recordCheck(input.runId, integrationTaskId, {
            name: "verification-integrity",
            passed: integrity.passed,
            exitCode: integrity.passed ? 0 : 1,
            stdout: JSON.stringify({ repositoryId, summary: integrity.summary, census: integrity.census, findings: integrity.findings }, null, 2),
            stderr: "",
            durationMs: 0,
          });
          repositoryFailed ||= !integrity.passed;
        }
        const headCommit = await manager.resolveIntegrationHead();
        this.ledger.updateIntegrationSetRepository(input.runId, repositoryId, { status: repositoryFailed ? "failed" : "ready", headCommit });
      }

      const checkSummary = this.checkSummary(input.runId);
      const taskReports = this.taskReportSummary(input.runId);
      const constitution = [...repositoryContexts.entries()].map(([repositoryId, context]) => `Repository ${repositoryId}:\n${context.constitution}`).join("\n\n");
      const requirement = reviewRequirement(input.plan.tasks, input.config.reviewPolicy);
      const reviewerName = input.availableProviders.includes(input.config.product.reviewer) ? input.config.product.reviewer : input.availableProviders[0]!;
      const reviewCwd = integration.manager(affectedIds[0]!).integrationPath;
      const implementationProviders = () => [...new Set((this.ledger.getRun(input.runId)?.tasks ?? [])
        .filter((task) => !task.id.startsWith("__integration__") && task.provider)
        .map((task) => String(task.provider)))];
      const integrationStatuses = await integration.status();
      let finalReviewEvidence = this.reviewEvidence({ runId: input.runId, autonomy: input.autonomy, plan: input.plan, taskReports, diff: aggregatedDiffs, repositories: integrationStatuses.map((status) => ({ repositoryId: status.repositoryId, baseCommit: status.baseCommit, headCommit: status.headCommit })) });
      let finalReviewSha256 = finalReviewEvidence.sha256;
      let reviewRound = await this.completeReviewRound({
        runId: input.runId,
        round: 1,
        integrationSha256: finalReviewSha256,
        evidenceBinding: finalReviewEvidence.binding,
        requirement,
        reviewerName,
        reviewerProviders: input.availableProviders,
        implementationProviders: implementationProviders(),
        config: input.config,
        reviewCwd,
        reviewChunks: input.autonomy === "observe" ? this.diagnosticReportChunks(input.runId) : chunkDiffFiles(aggregatedDiffs),
        reviewEvidenceLabel: input.autonomy === "observe" ? "diagnostic report" : "repository diff chunk",
        eventContext: { repositoryIds: affectedIds },
        signal: input.signal,
        goal: input.request.goal,
        constitution,
        plan: input.plan,
        checkSummary,
        taskReports,
        autonomy: input.autonomy,
      });

      for (let fixRound = 1; !reviewRound.decision.passed && reviewRound.decision.openFindings.length && input.autonomy !== "observe" && fixRound <= input.config.reviewPolicy.maxFixRounds; fixRound++) {
        const assignments = assignReviewFindings(reviewRound.decision.openFindings, affectedIds);
        if (assignments.unassigned.length) {
          this.ledger.addEvent(input.runId, "fixer.failed", `${assignments.unassigned.length} review finding(s) could not be assigned to exactly one repository`, {
            fixRound,
            findingIds: assignments.unassigned.map((finding) => finding.id),
            repositoryIds: affectedIds,
          });
          break;
        }
        const reviewerProviders = new Set(reviewRound.reviews.map((review) => review.provider));
        const fixerProviders = input.workerProviders.filter((provider) => !reviewerProviders.has(provider));
        const reviewerConnectionIds = this.connectionIdsForProviders(reviewerProviders);

        const repairTaskIds = repositoryTaskIds(`__review_fix_${fixRound}`, [...assignments.byRepository.keys()]);
        const repairs = [...assignments.byRepository.entries()].map(([repositoryId, findings], index) => {
          const repository = repositories.find((candidate) => candidate.id === repositoryId)!;
          const context = repositoryContexts.get(repositoryId)!;
          const checks = [...new Set(input.plan.tasks.filter((task) => task.repositoryIds?.[0] === repositoryId).flatMap((task) => task.checks))];
          const repositoryScope = findings.map((finding) => repositoryPathForFinding(finding.location, repositoryId)).filter((value): value is string => Boolean(value));
          const repairTask: PlannedTask = {
            id: repairTaskIds.get(repositoryId)!,
            title: `Resolve ${repository.name} review findings (round ${fixRound})`,
            description: `Correct only these retained review findings in repository ${repositoryId}:\n${findings.map((finding) => `- ${finding.severity.toUpperCase()} ${finding.location ?? "location not supplied"}: ${finding.rationale}\n  Suggested correction: ${finding.suggestedCorrection}`).join("\n")}`,
            dependencies: [],
            repositoryIds: [repositoryId],
            preferredProvider: fixerProviders.length ? fixerProviders[index % fixerProviders.length]! : null,
            checks: checks.length ? checks : ["diff-check"],
            kind: "repair",
            repositoryScope: repositoryScope.length ? repositoryScope : ["."],
            permission: "workspace_write",
            risk: requirement.risk,
            capabilityNeeds: ["implementation", "repair"],
            acceptanceCriteria: findings.map((finding) => finding.suggestedCorrection),
            expectedArtifacts: ["committed repair diff", "passing validator receipts"],
          };
          return { repositoryId, context, manager: integration.manager(repositoryId), repairTask };
        });
        // Same class as the single-repository gate: independence from the
        // quorum is the requirement, not a subscription implementor. Every
        // repository's repair must be routable, since they run together.
        if (!fixerProviders.length && !repairs.every((repair) => canRoute(this.ledger, {
          role: "worker",
          config: repair.context.config,
          fallbackProvider: null,
          allowedProviders: [],
          permission: "workspace_write",
          task: repair.repairTask,
          excludedConnectionIds: reviewerConnectionIds,
        }))) {
          this.ledger.addEvent(input.runId, "fixer.failed", "No implementor independent from the multi-repository review quorum is available", { fixRound, reviewerProviders: [...reviewerProviders] });
          break;
        }
        for (const repair of repairs) {
          this.ledger.addTask(input.runId, repair.repairTask);
          this.ledger.addEvent(input.runId, "fixer.started", `${repair.repairTask.preferredProvider} is addressing ${assignments.byRepository.get(repair.repositoryId)!.length} finding(s) in ${repair.repositoryId}`, { fixRound, taskId: repair.repairTask.id, repositoryId: repair.repositoryId });
        }
        const repairStatuses = await Promise.all(repairs.map(async (repair, index) => ({
          repair,
          status: await this.executeTask({
            runId: input.runId,
            goal: input.request.goal,
            task: repair.repairTask,
            constitution: repair.context.constitution,
            config: repair.context.config,
            providers: fixerProviders,
            providerCursor: providerCursor + fixRound + index,
            worktrees: repair.manager,
            signal: input.signal,
            excludeConnectionIds: reviewerConnectionIds,
          }),
        })));
        if (repairStatuses.some(({ status }) => status !== "passed")) {
          for (const { repair, status } of repairStatuses.filter(({ status }) => status !== "passed")) {
            this.ledger.addEvent(input.runId, "fixer.failed", `${repair.repositoryId} fixer ended ${status}`, { fixRound, taskId: repair.repairTask.id, repositoryId: repair.repositoryId, status });
          }
          break;
        }

        let repairsPassed = true;
        for (const { repair } of repairStatuses) {
          const postFixChecks = await this.verifyTask({ runId: input.runId, task: repair.repairTask, config: repair.context.config }, repair.manager.integrationPath);
          const integrity = analyzeVerificationIntegrity(await repair.manager.integrationDiffFiles());
          this.ledger.recordCheck(input.runId, repair.repairTask.id, {
            name: "verification-integrity",
            passed: integrity.passed,
            exitCode: integrity.passed ? 0 : 1,
            stdout: JSON.stringify({ repositoryId: repair.repositoryId, summary: integrity.summary, census: integrity.census, findings: integrity.findings }, null, 2),
            stderr: "",
            durationMs: 0,
          });
          const passed = postFixChecks.every((check) => check.passed) && integrity.passed;
          repairsPassed &&= passed;
          const headCommit = await repair.manager.resolveIntegrationHead();
          this.ledger.updateIntegrationSetRepository(input.runId, repair.repositoryId, { status: passed ? "ready" : "failed", headCommit, ...(passed ? {} : { error: `Fixer round ${fixRound} failed validation` }) });
          this.ledger.addEvent(input.runId, passed ? "fixer.completed" : "fixer.failed", passed ? `${repair.repositoryId} fixer passed integration validation; re-review is required` : `${repair.repositoryId} fixer failed integration validation`, { fixRound, taskId: repair.repairTask.id, repositoryId: repair.repositoryId, headCommit });
        }
        if (!repairsPassed) break;

        aggregatedDiffs = (await Promise.all(repositories.map(async (repository) => {
          const diffs = await integration.manager(repository.id).integrationDiffFiles();
          return diffs.map((diff) => ({ path: `${repository.id}/${diff.path}`, diff: diff.diff }));
        }))).flat();
        const refreshedTaskReports = this.taskReportSummary(input.runId);
        const refreshedCheckSummary = this.checkSummary(input.runId);
        const refreshedStatuses = await integration.status();
        const refreshedEvidence = this.reviewEvidence({ runId: input.runId, autonomy: input.autonomy, plan: input.plan, taskReports: refreshedTaskReports, diff: aggregatedDiffs, repositories: refreshedStatuses.map((status) => ({ repositoryId: status.repositoryId, baseCommit: status.baseCommit, headCommit: status.headCommit })) });
        const refreshedSha256 = refreshedEvidence.sha256;
        if (refreshedSha256 === finalReviewSha256) {
          this.ledger.addEvent(input.runId, "fixer.failed", `Multi-repository fixer round ${fixRound} produced no change to reviewed integration evidence`, { fixRound, integrationSha256: refreshedSha256 });
          break;
        }
        const invalidated = this.ledger.invalidateReviewReceipts(input.runId, `Multi-repository fixer round ${fixRound} changed integration evidence from ${finalReviewSha256} to ${refreshedSha256}`);
        this.ledger.addEvent(input.runId, "review.invalidated", `Multi-repository fixer round ${fixRound} invalidated ${invalidated} prior review receipt(s)`, { fixRound, invalidated, previousIntegrationSha256: finalReviewSha256, integrationSha256: refreshedSha256, repositoryIds: affectedIds });
        finalReviewSha256 = refreshedSha256;
        finalReviewEvidence = refreshedEvidence;
        reviewRound = await this.completeReviewRound({
          runId: input.runId,
          round: fixRound + 1,
          integrationSha256: finalReviewSha256,
          evidenceBinding: finalReviewEvidence.binding,
          requirement,
          reviewerName,
          reviewerProviders: input.availableProviders,
          implementationProviders: implementationProviders(),
          config: input.config,
          reviewCwd,
          reviewChunks: chunkDiffFiles(aggregatedDiffs),
          reviewEvidenceLabel: "repository diff chunk",
          eventContext: { repositoryIds: affectedIds },
          signal: input.signal,
          goal: input.request.goal,
          constitution,
          plan: input.plan,
          checkSummary: refreshedCheckSummary,
          taskReports: refreshedTaskReports,
          autonomy: input.autonomy,
        });
      }

      const repositoriesReady = this.ledger.getIntegrationSet(input.runId)?.repositories.every((repository) => repository.status === "ready") ?? false;
      const ready = repositoriesReady && reviewRound.decision.passed;
      const finalReview = `${ready ? "READY" : "NOT READY"}\n\nExact integration set: ${affectedIds.map((repositoryId) => {
        const repository = this.ledger.getIntegrationSet(input.runId)?.repositories.find((item) => item.repositoryId === repositoryId);
        return `${repositoryId} ${repository?.baseCommit ?? "unknown"} -> ${repository?.headCommit ?? "unknown"}`;
      }).join("; ")}\n\nReview quorum: ${reviewRound.decision.completedReviews}/${reviewRound.decision.requiredReviewers} completed across ${reviewRound.decision.distinctProviders} provider(s).${reviewRound.decision.reasons.length ? `\n${reviewRound.decision.reasons.join("\n")}` : "\nAll configured review gates passed."}\n\n${reviewRound.reviews.map((review, index) => `Reviewer ${index + 1} (${review.provider}${review.modelId ? ` / ${review.modelId}` : ""}): ${review.verdict.replace("_", " ")}\n${review.summary}`).join("\n\n")}`;
      this.ledger.addEvent(input.runId, reviewRound.decision.passed ? "review.quorum_passed" : "review.quorum_failed", reviewRound.decision.passed ? "Multi-repository review quorum passed" : "Multi-repository review quorum requires follow-up", { requirement, decision: reviewRound.decision, integrationSha256: finalReviewSha256, repositoryIds: affectedIds });
      this.ledger.setIntegrationSetStatus(input.runId, ready ? "ready" : "not_ready");
      if (ready && input.autonomy !== "observe") {
        const deliveryStatuses = await integration.status();
        for (const repository of deliveryStatuses) {
          this.ledger.prepareDeliveryRepository({
            runId: input.runId,
            repositoryId: repository.repositoryId,
            localPath: repository.repositoryRoot,
            baseBranch: repository.baseBranch,
            baseCommit: repository.baseCommit,
            headCommit: repository.headCommit,
            branch: repository.branch,
          });
        }
      }
      this.ledger.setRunStatus(input.runId, ready ? "ready" : "not_ready", finalReview);
      this.ledger.addEvent(input.runId, ready ? "run.ready" : "run.not_ready", ready ? "Multi-repository integration set passed final review" : "Multi-repository integration set requires follow-up", { repositoryIds: affectedIds, integrationSha256: finalReviewSha256 });
    } catch (error) {
      if (this.ledger.getIntegrationSet(input.runId)) this.ledger.setIntegrationSetStatus(input.runId, "failed");
      throw error;
    }
  }

  private async completeQuorumReview(input: {
    runId: string;
    reviewSlot: number;
    requiredReviewers: number;
    /** Null when only qualified local reviewers remain; the router then chooses among them. */
    reviewerName: ProviderName | null;
    reviewerProviders: readonly string[];
    implementationProviders: readonly string[];
    excludedReviewerModels: Set<string>;
    excludedReviewerConnections: Set<string>;
    config: DevHarmonicsConfig;
    worktrees?: WorktreeManager;
    reviewCwd?: string;
    reviewChunks?: readonly ReviewChunk[];
    reviewEvidenceLabel?: string;
    eventContext?: Record<string, unknown>;
    signal: AbortSignal;
    goal: string;
    constitution: string;
    plan: RunPlan;
    checkSummary: string;
    taskReports: string;
    autonomy: RunAutonomy;
  }): Promise<StructuredReview> {
    const reviewCwd = input.reviewCwd ?? input.worktrees?.integrationPath;
    if (!reviewCwd) throw new Error("Review execution requires a working directory");
    const router = new ModelRouter(this.ledger);
    let lastError: Error | null = null;
    let fallbackReason: string | null = null;
    for (let reviewAttempt = 1; reviewAttempt <= input.config.application.retry.maxAttempts; reviewAttempt++) {
      const start = input.reviewerName ? input.reviewerProviders.indexOf(input.reviewerName) : -1;
      const qualificationProviders = input.reviewerProviders.map((_, index) => input.reviewerProviders[(Math.max(0, start) + input.reviewSlot + reviewAttempt - 2 + index) % input.reviewerProviders.length]!);
      // Null with no subscription candidate left: the router chooses among the
      // already-qualified local reviewers instead of indexing an empty pool.
      let fallbackProvider: ProviderName | null = (qualificationProviders[0] ?? null) as ProviderName | null;
      for (const provider of qualificationProviders) {
        const qualification = await ensureSchedulerCandidateQualified({
          ledger: this.ledger,
          config: input.config,
          cwd: reviewCwd,
          role: "reviewer",
          preferredProvider: provider,
          permission: "read_only",
          excludedModelIds: input.excludedReviewerModels,
          excludedConnectionIds: input.excludedReviewerConnections,
        });
        this.recordSchedulerQualification(input.runId, qualification, "reviewer");
        if (qualification?.attempted && !qualification.passed) {
          input.excludedReviewerModels.add(qualification.modelId);
          fallbackReason = `${qualification.provider} reviewer candidate failed scheduler-time qualification`;
          lastError = new Error(fallbackReason);
          continue;
        }
        if (qualification?.passed) {
          fallbackProvider = qualification.provider as ProviderName;
          break;
        }
      }
      let decision;
      try {
        decision = router.route({
          role: "reviewer",
          config: input.config,
          fallbackProvider: fallbackProvider as ProviderName,
          allowedProviders: input.reviewerProviders,
          permission: "read_only",
          excludedModelIds: input.excludedReviewerModels,
          excludedConnectionIds: input.excludedReviewerConnections,
          avoidProviders: input.implementationProviders,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(message);
        fallbackReason = message;
        continue;
      }
      const reviewer = await this.provider(decision.provider, input.config, decision.connectionId);
      this.ledger.addEvent(input.runId, "review.started", `${decision.provider} is completing quorum review ${input.reviewSlot}/${input.requiredReviewers}${reviewAttempt > 1 ? ` (fallback ${reviewAttempt})` : ""}`, { routing: decision, reviewSlot: input.reviewSlot, requiredReviewers: input.requiredReviewers, reviewAttempt, fallbackReason });
      try {
        let text: string;
        if (!input.reviewChunks && reviewer.connection.capabilities.providerManagedTools) {
          const review = await reviewer.invoke({
            role: "reviewer",
            prompt: reviewerPrompt({ goal: input.goal, constitution: input.constitution, plan: input.plan, checkSummary: input.checkSummary, taskReports: input.taskReports, workspacePath: reviewCwd, autonomy: input.autonomy }),
            cwd: reviewCwd,
            permission: "read_only",
            timeoutMs: null,
            maxOutputTokens: OPENROUTER_MAX_OUTPUT_TOKENS,
            model: decision.model,
          }, { signal: input.signal });
          this.recordInvocation(input.runId, null, "reviewer", decision, review, fallbackReason);
          text = review.text;
        } else {
          const chunks = input.reviewChunks ?? (input.autonomy === "observe"
            ? this.diagnosticReportChunks(input.runId)
            : chunkDiffFiles(await input.worktrees!.integrationDiffFiles()));
          const localTaskReports = input.autonomy === "observe" ? "Each accepted diagnostic report is supplied as an independent evidence chunk." : input.taskReports;
          const performReview = (paidSpendReservationId?: string) => runContextOnlyReview({
            adapter: reviewer,
            model: decision.model,
            cwd: reviewCwd,
            contextHeader: localReviewerContextHeader({ goal: input.goal, constitution: input.constitution, plan: input.plan, checkSummary: input.checkSummary, taskReports: localTaskReports, autonomy: input.autonomy }),
            chunks,
            evidenceLabel: input.reviewEvidenceLabel ?? (input.autonomy === "observe" ? "diagnostic report" : "diff chunk"),
            maxOutputTokens: 512,
            signal: input.signal,
            onChunk: (receipt, index, total) => {
              this.ledger.addEvent(input.runId, "review.chunk_completed", `${decision.provider} reviewed chunk ${index + 1}/${total}: ${receipt.label} - ${receipt.verdict}`, { ...input.eventContext, reviewSlot: input.reviewSlot, label: receipt.label, verdict: receipt.verdict, durationMs: receipt.durationMs, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costUsd: receipt.costUsd });
              this.ledger.recordInvocationReceipt({ runId: input.runId, role: "reviewer", provider: receipt.provider, connectionId: receipt.connectionId, requestedModelId: decision.model.requestedModelId ? String(decision.model.requestedModelId) : null, resolvedModelId: receipt.resolvedModelId, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costUsd: receipt.costUsd, durationMs: receipt.durationMs, workloadClass: "complex:premium", fallbackReason: fallbackReason ?? (decision.fallback ? decision.factors.join("; ") : null), ...(paidSpendReservationId ? { paidSpendReservationId } : {}) });
            },
          });
          const selected = decision.model.requestedModelId ? this.ledger.getModel(String(decision.model.requestedModelId)) : null;
          if (decision.provider === "openrouter" && !selected) throw new Error("OpenRouter paid routing requires an exact selected model");
          const costCeiling = decision.provider === "openrouter" ? requireInvocationCostCeiling(selected!, "", 512) * chunks.length : 0;
          const review = decision.provider === "openrouter"
            ? await new OpenRouterService(this.ledger).withPaidRoutingAllowed(input.config, input.runId, costCeiling, (reservation) => performReview(reservation.id), chunks.length)
            : await performReview();
          text = review.text;
        }
        this.recordConnectionOutcome(reviewer.connection.id, { success: true });
        if (decision.model.requestedModelId) {
          const modelId = String(decision.model.requestedModelId);
          this.recordModelOutcome(modelId, { success: true });
          const quotaGroup = modelQuotaGroup(this.ledger.getModel(modelId));
          if (quotaGroup) this.recordQuotaGroupOutcome(String(reviewer.connection.id), quotaGroup.id, quotaGroup.displayName, { success: true });
        }
        return parseReviewerResponse(text, {
          provider: decision.provider,
          modelId: decision.model.requestedModelId ? String(decision.model.requestedModelId) : null,
          connectionId: String(reviewer.connection.id),
        });
      } catch (error) {
        if (input.signal.aborted) throw error;
        const failureKind = error instanceof RuntimeInvocationError ? error.kind : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(message);
        fallbackReason = `${decision.provider} review failed (${failureKind}): ${message}`;
        this.recordScopedInvocationFailure({
          connectionId: String(reviewer.connection.id),
          modelId: decision.model.requestedModelId ? String(decision.model.requestedModelId) : null,
          failureKind,
          detail: message,
          excludedModelIds: input.excludedReviewerModels,
          excludedConnectionIds: input.excludedReviewerConnections,
        });
        this.ledger.addEvent(input.runId, "review.failed", `${fallbackReason}; trying the next eligible reviewer`, { provider: decision.provider, connectionId: reviewer.connection.id, modelId: decision.model.requestedModelId, failureKind, reviewSlot: input.reviewSlot, reviewAttempt });
      }
    }
    throw lastError ?? new Error(`No eligible reviewer completed quorum slot ${input.reviewSlot}`);
  }

  private reviewEvidence(input: {
    runId: string;
    autonomy: RunAutonomy;
    plan: RunPlan;
    taskReports: string;
    diff: readonly unknown[];
    repositories: ReviewEvidenceBinding["repositories"];
  }): { binding: ReviewEvidenceBinding; sha256: string } {
    const checks = (this.ledger.getRun(input.runId)?.tasks ?? []).map((task) => ({ id: task.id, checks: task.checks }));
    const binding = createReviewEvidenceBinding({ ...input, checks });
    return { binding, sha256: reviewEvidenceBindingSha256(binding) };
  }

  private async completeReviewRound(input: {
    runId: string;
    round: number;
    integrationSha256: string;
    evidenceBinding: ReviewEvidenceBinding;
    requirement: ReviewRequirement;
    /** Null when only qualified local reviewers remain; the router then chooses among them. */
    reviewerName: ProviderName | null;
    reviewerProviders: readonly string[];
    implementationProviders: readonly string[];
    config: DevHarmonicsConfig;
    worktrees?: WorktreeManager;
    reviewCwd?: string;
    reviewChunks?: readonly ReviewChunk[];
    reviewEvidenceLabel?: string;
    eventContext?: Record<string, unknown>;
    signal: AbortSignal;
    goal: string;
    constitution: string;
    plan: RunPlan;
    checkSummary: string;
    taskReports: string;
    autonomy: RunAutonomy;
  }): Promise<{ reviews: StructuredReview[]; decision: ReviewQuorumDecision }> {
    const excludedModels = new Set<string>();
    const excludedConnections = new Set<string>();
    if (input.requirement.requireImplementorIndependence) {
      for (const connection of this.ledger.listConnections()) {
        if (input.implementationProviders.includes(connection.provider)) excludedConnections.add(connection.id);
      }
    }
    const reviews: StructuredReview[] = [];
    for (let reviewSlot = 1; reviewSlot <= input.requirement.requiredReviewers; reviewSlot++) {
      const review = await this.completeQuorumReview({
        ...input,
        reviewSlot,
        requiredReviewers: input.requirement.requiredReviewers,
        excludedReviewerModels: excludedModels,
        excludedReviewerConnections: excludedConnections,
      });
      const receiptId = this.ledger.recordReviewReceipt({ runId: input.runId, round: input.round, integrationSha256: input.integrationSha256, evidenceBinding: input.evidenceBinding, review });
      reviews.push(review);
      this.ledger.addEvent(input.runId, "review.completed", `${review.provider} completed round ${input.round} review ${reviewSlot}/${input.requirement.requiredReviewers}: ${review.verdict.replace("_", " ")}`, { receiptId, round: input.round, reviewSlot, provider: review.provider, modelId: review.modelId, connectionId: review.connectionId, verdict: review.verdict, findingCount: review.findings.length, integrationSha256: input.integrationSha256 });
      excludedConnections.add(review.connectionId);
      if (review.modelId) excludedModels.add(review.modelId);
      if (new Set(reviews.map((item) => item.provider)).size < input.requirement.minimumDistinctProviders) {
        for (const connection of this.ledger.listConnections()) {
          if (connection.provider === review.provider) excludedConnections.add(connection.id);
        }
      }
    }
    return {
      reviews,
      decision: adjudicateReviewQuorum({ requirement: input.requirement, implementationProviders: input.implementationProviders, reviews }),
    };
  }

  /** Every connection belonging to one of these providers, for identity-based exclusion. */
  private connectionIdsForProviders(providers: ReadonlySet<string>): Set<string> {
    return new Set(this.ledger.listConnections().filter((connection) => providers.has(connection.provider)).map((connection) => connection.id));
  }

  private async executeTask(input: {
    runId: string;
    goal: string;
    task: PlannedTask;
    constitution: string;
    config: DevHarmonicsConfig;
    providers: ProviderName[];
    providerCursor: number;
    worktrees: WorktreeManager;
    signal: AbortSignal;
    /** Connections this task must not use, e.g. the reviewers a repair must stay independent of. */
    excludeConnectionIds?: ReadonlySet<string>;
  }): Promise<TaskStatus> {
    try {
      return await this.runTaskAttempts(input);
    } finally {
      // DH-635: once a task stops running, any directive still waiting on it can
      // never be applied. Every directive must end with a disposition, so give
      // the leftovers an honest one rather than leaving them pending forever.
      for (const leftover of this.ledger.pendingSteeringDirectives(input.runId, input.task.id)) {
        this.ledger.resolveSteeringDirective(leftover.id, {
          disposition: "rejected",
          reason: leftover.kind === "interrupt"
            ? "No attempt was in flight to interrupt; the task had already finished its provider invocation"
            : "The task finished before this direction could be applied at an attempt boundary",
        });
      }
    }
  }

  private async runTaskAttempts(input: {
    runId: string;
    goal: string;
    task: PlannedTask;
    constitution: string;
    config: DevHarmonicsConfig;
    providers: ProviderName[];
    providerCursor: number;
    worktrees: WorktreeManager;
    signal: AbortSignal;
    excludeConnectionIds?: ReadonlySet<string>;
  }): Promise<TaskStatus> {
    const taskWorktree = await input.worktrees.createTask(input.task.id);
    const taskPermission = input.task.permission ?? "workspace_write";
    let feedback = "";
    const excludedModelIds = new Set<string>();
    const excludedConnectionIds = new Set<string>(input.excludeConnectionIds ?? []);

    // DH-635: an interrupted attempt consumes the approved retry budget exactly
    // like any other attempt. Granting extra attempts for interrupts would let
    // steering widen a task's invocation — and therefore paid-spend — authority,
    // which is precisely what steering must never do. Changing how many attempts
    // a task may spend is a plan decision, not a steering one.
    for (let attempt = 1; attempt <= input.config.application.retry.maxAttempts; attempt++) {
      // Do not start a new attempt once cancelled; leave the 'cancelled' status
      // for ledger.cancelRun to own rather than marking the task 'failed'.
      if (input.signal.aborted) return "cancelled";

      // The attempt boundary is the other safe boundary: consume clarifications
      // for this task so updated direction reaches the worker prompt as feedback
      // rather than being injected mid-response.
      const steeringForTask = this.ledger
        .pendingSteeringDirectives(input.runId, input.task.id)
        .filter((directive) => directive.kind === "clarify");
      const appliedClarifications: SteeringDirectiveRecord[] = [];
      for (const directive of steeringForTask) {
        const clarification = directive.payload.clarification?.trim();
        if (!clarification) {
          this.ledger.resolveSteeringDirective(directive.id, { disposition: "rejected", reason: "No clarification text supplied" });
          continue;
        }
        feedback = feedback ? `${feedback}\n\nOwner clarification: ${clarification}` : `Owner clarification: ${clarification}`;
        appliedClarifications.push(directive);
      }
      const eligibleProviders = input.providers.filter((name) => this.ledger.isConnectionEligible(projectLegacyProvider(name).connectionId));
      // Null when every subscription connection is cooling and only qualified
      // local workers remain; selectWorker cannot index an empty pool.
      const fallbackProvider = eligibleProviders.length
        ? this.selectWorker(input.task, eligibleProviders, input.providerCursor + attempt - 1)
        : null;
      // The attempt begins here, and scheduler-time qualification is part of it:
      // the task is genuinely being worked on before a model is finally chosen.
      // Saying so keeps the status honest and, because every failure path from
      // this point transitions to 'retry', keeps those transitions legal — a
      // qualification failure on the first attempt previously asked for
      // queued -> retry, which the state machine rejects, failing the whole run.
      // The provider is filled in below once routing resolves it.
      // DH-635 interrupt: a per-attempt controller chained to the run signal, so
      // an owner can stop THIS attempt without cancelling the run. Interruption
      // is an explicit stop-and-hand-off; DevHarmonics never claims to have
      // injected direction into a response already in flight.
      //
      // It is installed BEFORE the task is marked 'working', because that status
      // is exactly what makes the ledger accept an interrupt and the dashboard
      // offer the button. Installing it later left a window — first-use model
      // qualification, which can take as long as a real invocation — where the
      // product accepted an interrupt that nothing was watching for, and the
      // directive could only affect a later attempt.
      const attemptAbort = new AbortController();
      const propagateRunAbort = () => attemptAbort.abort();
      input.signal.addEventListener("abort", propagateRunAbort, { once: true });
      let interruptDirective: SteeringDirectiveRecord | null = null;
      const interruptWatch = setInterval(() => {
        const pendingInterrupt = this.ledger
          .pendingSteeringDirectives(input.runId, input.task.id)
          .find((directive) => directive.kind === "interrupt");
        if (pendingInterrupt) {
          interruptDirective = pendingInterrupt;
          attemptAbort.abort();
        }
      }, 500);
      // Idempotent, so every early exit between here and the attempt's own
      // try/finally can release the watcher without tracking which already did.
      const releaseAttemptWatch = (): void => {
        clearInterval(interruptWatch);
        input.signal.removeEventListener("abort", propagateRunAbort);
      };
      this.ledger.setTaskStatus(input.runId, input.task.id, "working");
      // Scheduler-time qualification checks a subscription candidate. With no
      // subscription connection left there is nothing for it to check, and the
      // router selects among already-qualified local models instead.
      // An aborted probe throws rather than returning a verdict, so that a
      // control action is never mistaken for evidence about the model. Whether
      // this attempt owns the abort is decided immediately below; either way the
      // model's health is left untouched.
      let qualification: Awaited<ReturnType<typeof ensureSchedulerCandidateQualified>> = null;
      try {
        qualification = fallbackProvider
          ? await ensureSchedulerCandidateQualified({
              ledger: this.ledger,
              config: input.config,
              cwd: taskWorktree.path,
              role: "worker",
              preferredProvider: fallbackProvider,
              permission: taskPermission,
              task: input.task,
              excludedModelIds,
              excludedConnectionIds,
              signal: attemptAbort.signal,
            })
          : null;
      } catch (error) {
        if (!isAbortError(error)) throw error;
        // Inconclusive, not failed. If this attempt was the one aborted, the
        // cancel/interrupt handling below owns it; if another attempt aborted a
        // probe this one had joined, this attempt simply has no qualification
        // result and lets the router choose among already-qualified models.
        qualification = null;
      }
      this.recordSchedulerQualification(input.runId, qualification, "worker", input.task.id);
      // A cancel raised during qualification must not be followed by a task
      // transition: the task is already 'cancelled', and asking it to go to
      // 'retry' or 'working' from there is an illegal transition that fails the
      // run. cancelRun owns the status from this point.
      if (input.signal.aborted) {
        releaseAttemptWatch();
        return "cancelled";
      }
      // An interrupt raised during qualification stopped the probe rather than a
      // provider invocation, so it is honoured at the attempt boundary and said
      // so plainly. No attempt record exists yet to attribute it to.
      if (interruptDirective) {
        const directive = interruptDirective as SteeringDirectiveRecord;
        const note = directive.payload.clarification?.trim();
        this.ledger.resolveSteeringDirective(directive.id, {
          disposition: "applied",
          reason: `Interrupted attempt ${attempt} during model qualification, before any provider invocation`,
        });
        this.ledger.addEvent(input.runId, "steering.interrupted", `${input.task.title}: attempt ${attempt} interrupted during model qualification`, {
          taskId: input.task.id,
          directiveId: directive.id,
        });
        feedback = note
          ? `The owner interrupted your previous attempt. New direction: ${note}`
          : "The owner interrupted your previous attempt. Re-read the task contract and continue.";
        interruptDirective = null;
        releaseAttemptWatch();
        if (attempt >= input.config.application.retry.maxAttempts) {
          this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
          this.ledger.addEvent(input.runId, "task.failed", `${input.task.title}: the owner's interruption used the task's last attempt`);
          return "failed";
        }
        this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
        await delay(input.config.application.retry.backoffMs);
        continue;
      }
      if (qualification?.attempted && !qualification.passed) {
        excludedModelIds.add(qualification.modelId);
        feedback = `Model qualification failed: ${qualification.provider} candidate '${qualification.modelId}' did not pass the ${qualification.role} fixture.`;
        this.ledger.addEvent(input.runId, "task.provider_failed", feedback, { taskId: input.task.id, modelId: qualification.modelId, failureKind: "incompatible" });
        releaseAttemptWatch();
        if (attempt < input.config.application.retry.maxAttempts) {
          this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
          await delay(input.config.application.retry.backoffMs);
          continue;
        }
        this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
        return "failed";
      }
      const routeAttempt = new ModelRouter(this.ledger).tryRoute({
        role: "worker",
        config: input.config,
        fallbackProvider,
        allowedProviders: taskPermission === "read_only" && this.openRouterEligible(input.config) ? [...eligibleProviders, "openrouter"] : eligibleProviders,
        permission: taskPermission,
        task: input.task,
        excludedModelIds,
        excludedConnectionIds,
      });
      // Nothing can take this task right now. That is a task-level outcome, not
      // a run-level crash: a cooling window can reopen, so it settles and
      // retries like any other provider failure. Routing used to sit outside
      // this handling behind a liveness predicate that only approximated it, so
      // a guess that disagreed with the router threw out of executeTask and
      // failed the entire run instead of settling one task.
      if ("reason" in routeAttempt) {
        this.ledger.addEvent(input.runId, "task.provider_failed", `${input.task.title}: ${routeAttempt.reason}`, { taskId: input.task.id });
        releaseAttemptWatch();
        if (attempt < input.config.application.retry.maxAttempts) {
          this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
          await delay(input.config.application.retry.backoffMs);
          continue;
        }
        this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
        // Say why routing actually refused rather than asserting a cause. An
        // exhausted subscription is the common case, not the only one: an
        // assigned model can be missing, or unqualified for the role.
        this.ledger.addEvent(input.runId, "task.failed", `${input.task.title}: no model could take this task (${routeAttempt.reason})`);
        return "failed";
      }
      const routing = routeAttempt.decision;
      if (!(PROVIDERS as readonly string[]).includes(routing.provider) && routing.provider !== "ollama" && taskPermission === "workspace_write") {
        throw new Error(`Worker model '${routing.model.requestedModelId}' cannot write until the local tool policy engine is enabled`);
      }
      const providerName = routing.provider;
      const provider = await this.provider(providerName, input.config, routing.connectionId);
      const model = routing.model;
      const handoffPack = assembleContextPack("worker", this.ledger.listBlackboardEntries(input.runId, input.task.id).slice(-20).map((entry, index) => ({ reference: `blackboard:${entry.id}:${entry.kind}`, priority: 100 - index, content: entry.content })), 12_000);
      const prompt = workerPrompt({
        goal: input.goal,
        constitution: input.constitution,
        task: input.task,
        attempt,
        feedback,
        workspacePath: taskWorktree.path,
        sharedContext: handoffPack.content,
      });
      this.ledger.setTaskStatus(input.runId, input.task.id, "working", providerName);
      this.ledger.addEvent(
        input.runId,
        "task.started",
        `${providerName} started ${input.task.title} (attempt ${attempt})`,
        { taskId: input.task.id, routing },
      );
      const runtimeMetadata = await provider.metadata();
      const attemptId = this.ledger.startAttempt(
        input.runId,
        input.task.id,
        providerName,
        prompt,
        {
          connectionId: provider.connection.id,
          requestedModelId: model.requestedModelId,
          modelSettings: model.settings,
          ...runtimeMetadata,
        },
      );
      // Applied clarifications link to the exact attempt they steered, so the
      // ledger can answer "which direction produced this work?".
      for (const directive of appliedClarifications) {
        this.ledger.resolveSteeringDirective(directive.id, {
          disposition: "applied",
          reason: `Delivered to ${providerName} at attempt ${attempt}`,
          attemptId,
        });
      }


      let paidSpendReservation: PaidSpendReservation | null = null;
      let paidInvocationStarted = false;

      try {
        if (providerName === "openrouter") {
          const selected = model.requestedModelId ? this.ledger.getModel(String(model.requestedModelId)) : null;
          if (!selected) throw new Error("OpenRouter paid routing requires an exact selected model");
          paidSpendReservation = await new OpenRouterService(this.ledger).acquirePaidRouting(input.config, input.runId, requireInvocationCostCeiling(selected, prompt));
        }
        await input.worktrees.assertPrimaryClean?.(`before ${input.task.id} attempt ${attempt}`);
        const invocationRequest = {
          role: "worker" as const,
          prompt,
          cwd: taskWorktree.path,
          permission: taskPermission,
          timeoutMs: taskAttemptTimeoutMs(
            routing.workload.complexity,
            taskPermission,
            (PROVIDERS as readonly string[]).includes(providerName)
              ? input.config.connections[providerName as ProviderName].timeoutMs
              : 15 * 60_000,
          ),
          maxOutputTokens: OPENROUTER_MAX_OUTPUT_TOKENS,
          model,
        };
        if (providerName === "openrouter") {
          paidSpendReservation!.markInvoked();
          paidInvocationStarted = true;
        }
        const result = providerName === "ollama" && taskPermission === "workspace_write"
          ? await runLocalToolLoop({
              adapter: provider,
              request: invocationRequest,
              worktreePath: taskWorktree.path,
              repositoryScope: input.task.repositoryScope ?? ["."],
              authorize: (toolRequest) => this.enforceToolPolicy({
                runId: input.runId,
                taskId: input.task.id,
                attemptId,
                toolId: toolRequest.toolId,
                actorRole: "worker",
                stage: input.task.kind === "repair" ? "repair" : "implementation",
                taskPermission,
                assignedWorktree: taskWorktree.path,
                repositoryRoot: input.worktrees.root,
                cwd: taskWorktree.path,
                targetPaths: toolRequest.targetPaths,
                config: input.config,
                request: sanitizeLocalToolRequest(toolRequest.arguments),
              }),
            })
          : await provider.invoke(invocationRequest, { signal: attemptAbort.signal });
        await input.worktrees.assertPrimaryClean?.(`after ${input.task.id} attempt ${attempt}`);
        const fallbackReason = routing.fallback
          ? routing.factors.join("; ")
          : providerName === "openrouter" && feedback
            ? feedback
            : null;
        const normalizedResult = normalizeAgentResult("worker", result.text);
        // A read-only task changes nothing, so validators have no repository
        // state to judge and the report's own citations are the evidence. Check
        // that they resolve to real lines in the assigned worktree: a worker
        // that invents well-formed citations otherwise passes on fabricated
        // findings, which a real run demonstrated. This verifies that cited
        // lines exist, not that they support the conclusion — that stays a
        // review question.
        const citationIssue = taskPermission === "read_only"
          ? await (async () => {
              const verification = await verifyReportCitations(taskWorktree.path, result.text);
              return verification.unverifiable.length
                ? `the diagnostic report cites evidence that does not exist: ${describeUnverifiableCitations(verification)}`
                : null;
            })()
          : null;
        const diagnosticIssue = taskPermission === "read_only"
          ? validateDiagnosticResult(input.task, result.text) ?? citationIssue
          : null;
        this.ledger.finishAttempt(attemptId, diagnosticIssue ? "rejected" : "completed", result.text, diagnosticIssue ?? "", {
          modelId: result.model.resolvedModelId,
          modelResolution: result.model.resolution,
          resultEnvelope: normalizedResult,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          fallbackReason,
        });
        this.recordInvocation(input.runId, input.task.id, "worker", routing, result, fallbackReason, paidSpendReservation?.id);
        if (result.usage.costUsd !== null) paidSpendReservation?.settleAfterDurableReceipt();
        paidSpendReservation = null;
        this.recordConnectionOutcome(provider.connection.id, { success: true });
        if (model.requestedModelId) {
          const modelId = String(model.requestedModelId);
          this.recordModelOutcome(modelId, { success: true });
          const quotaGroup = modelQuotaGroup(this.ledger.getModel(modelId));
          if (quotaGroup) this.recordQuotaGroupOutcome(String(provider.connection.id), quotaGroup.id, quotaGroup.displayName, { success: true });
        }
        if (diagnosticIssue) {
          feedback = `Diagnostic result rejected: ${diagnosticIssue}. The plan is already approved; execute the assigned task and return the required evidence.`;
          this.ledger.addBlackboardEntry({ runId: input.runId, taskId: input.task.id, kind: "risk", content: feedback, sourceAttemptId: attemptId });
          this.ledger.addEvent(input.runId, "task.retry", `${input.task.title}: ${feedback}`);
          if (attempt < input.config.application.retry.maxAttempts) {
            this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
            await delay(input.config.application.retry.backoffMs);
            continue;
          }
          this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
          this.ledger.addEvent(input.runId, "task.failed", `${input.task.title} did not produce an acceptable diagnostic report`);
          return "failed";
        }
        this.ledger.addBlackboardEntry({ runId: input.runId, taskId: input.task.id, kind: taskPermission === "read_only" ? "finding" : "handoff", content: normalizedResult.summary, sourceAttemptId: attemptId });
      } catch (error) {
        if (!paidInvocationStarted) paidSpendReservation?.cancelBeforeInvocation();
        paidSpendReservation = null;
        // A cancel aborts the child process, surfacing here as a failure. Stop
        // without marking the task 'failed' or retrying; cancelRun owns status.
        if (input.signal.aborted) return "cancelled";
        // An owner interrupt also surfaces here as an aborted invocation. It is
        // not a provider failure: retain the partial attempt as evidence, then
        // hand off to a fresh attempt carrying the new direction.
        if (interruptDirective) {
          const directive = interruptDirective as SteeringDirectiveRecord;
          const note = directive.payload.clarification?.trim();
          this.ledger.finishAttempt(attemptId, "failed", "", "Interrupted by owner steering", { failureKind: "interrupted" });
          this.ledger.resolveSteeringDirective(directive.id, {
            disposition: "applied",
            reason: `Interrupted attempt ${attempt}; continuing with a new attempt`,
            attemptId,
          });
          this.ledger.addEvent(input.runId, "steering.interrupted", `${input.task.title}: attempt ${attempt} interrupted by owner`, {
            taskId: input.task.id,
            directiveId: directive.id,
            attemptId,
          });
          this.ledger.addBlackboardEntry({
            runId: input.runId,
            taskId: input.task.id,
            kind: "handoff",
            content: `Owner interrupted attempt ${attempt}.${note ? ` New direction: ${note}` : ""} Prior evidence is retained; continue from the current worktree state.`,
            sourceAttemptId: attemptId,
          });
          feedback = note
            ? `The owner interrupted your previous attempt. New direction: ${note}`
            : "The owner interrupted your previous attempt. Re-read the task contract and continue.";
          interruptDirective = null;
          if (attempt >= input.config.application.retry.maxAttempts) {
            // The owner spent the task's remaining attempts on redirection. Say so
            // plainly rather than quietly buying more provider invocations.
            this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
            this.ledger.addEvent(input.runId, "task.failed", `${input.task.title}: the approved attempt budget was exhausted by owner interrupts`);
            return "failed";
          }
          this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.ledger.finishAttempt(attemptId, "failed", "", message, {
          failureKind: error instanceof RuntimeInvocationError ? error.kind : error instanceof WorkspaceIsolationError ? "policy_denied" : "unknown",
        });
        if (error instanceof WorkspaceIsolationError) {
          this.ledger.addBlackboardEntry({ runId: input.runId, taskId: input.task.id, kind: "risk", content: `${message}\n${error.status}`, sourceAttemptId: attemptId });
          this.ledger.addEvent(input.runId, "task.failed", `${input.task.title}: ${message}`, { primaryStatus: error.status });
          this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
          return "failed";
        }
        const failureKind = error instanceof RuntimeInvocationError ? error.kind : "unknown";
        const failureScope = this.recordScopedInvocationFailure({
          connectionId: String(provider.connection.id),
          modelId: model.requestedModelId ? String(model.requestedModelId) : null,
          failureKind,
          detail: message,
          excludedModelIds,
          excludedConnectionIds,
        });
        if (failureScope === "task") {
          this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
          this.ledger.addEvent(input.runId, "task.failed", `${input.task.title}: ${message}`);
          return "failed";
        }
        feedback = `Provider failure: ${message}`;
        this.ledger.addBlackboardEntry({ runId: input.runId, taskId: input.task.id, kind: "risk", content: feedback, sourceAttemptId: attemptId });
        this.ledger.addEvent(input.runId, "task.provider_failed", feedback);
        if (attempt < input.config.application.retry.maxAttempts) {
          this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
          await delay(input.config.application.retry.backoffMs);
          continue;
        }
        this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
        return "failed";
      } finally {
        // Every exit path — success, retry, interrupt, failure — must release the
        // interrupt watcher and the run-abort listener or each attempt leaks one.
        clearInterval(interruptWatch);
        input.signal.removeEventListener("abort", propagateRunAbort);
      }

      this.ledger.setTaskStatus(input.runId, input.task.id, "verifying");
      const checks = await this.verifyTask(input, taskWorktree.path, attemptId);
      await input.worktrees.assertPrimaryClean?.(`after ${input.task.id} validators`);
      // A cancel that landed during validator verification must not be overwritten
      // to passed/retry/failed, and the worktree must not be committed or merged.
      if (input.signal.aborted) return "cancelled";
      if (checks.every((check) => check.passed)) {
        if (taskPermission === "read_only") {
          this.ledger.setTaskStatus(input.runId, input.task.id, "passed");
          this.ledger.addEvent(input.runId, "task.passed", `${input.task.title} passed read-only verification`);
          return "passed";
        }
        try {
          this.enforceToolPolicy({
            runId: input.runId,
            taskId: input.task.id,
            attemptId,
            toolId: "git.commit",
            stage: input.task.kind === "repair" ? "repair" : "implementation",
            taskPermission,
            assignedWorktree: taskWorktree.path,
            repositoryRoot: input.worktrees.root,
            cwd: taskWorktree.path,
            config: input.config,
            request: { message: `devharmonics: complete ${input.task.id}` },
          });
          await input.worktrees.commitTask(taskWorktree.path, input.task.id);
          if (input.signal.aborted) return "cancelled";
          // A retry can reuse a task branch that already contains a commit from a
          // failed merge. Always attempt integration, even when this attempt made
          // no new commit, so unmerged work can never be reported as passed.
          this.enforceToolPolicy({
            runId: input.runId,
            taskId: input.task.id,
            attemptId,
            toolId: "git.merge",
            stage: "integration",
            taskPermission,
            assignedWorktree: input.worktrees.integrationPath,
            repositoryRoot: input.worktrees.root,
            cwd: input.worktrees.integrationPath,
            config: input.config,
            request: { branch: taskWorktree.branch },
          });
          await input.worktrees.mergeTask(taskWorktree.branch, input.task.id);
          // A cancel that landed during the commit/merge awaits must not overwrite
          // the cancelled status to passed.
          if (input.signal.aborted) return "cancelled";
          this.ledger.setTaskStatus(input.runId, input.task.id, "passed");
          this.ledger.addEvent(input.runId, "task.passed", `${input.task.title} passed verification`);
          return "passed";
        } catch (error) {
          // A cancel surfacing from commit/merge owns status through cancelRun.
          if (input.signal.aborted) return "cancelled";
          feedback = error instanceof Error ? error.message : String(error);
          if (/^Merge conflict for /i.test(feedback)) {
            this.ledger.addEvent(input.runId, "task.integration_conflict", `${input.task.title}: ${feedback}`, { taskId: input.task.id, attemptId, modelId: model.requestedModelId });
          }
        }
      } else {
        feedback = formatFailures(checks);
      }

      this.ledger.addEvent(input.runId, "task.retry", `${input.task.title}: ${feedback}`);
      if (attempt < input.config.application.retry.maxAttempts) {
        this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
        await delay(input.config.application.retry.backoffMs);
      }
    }

    this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
    this.ledger.addEvent(input.runId, "task.failed", `${input.task.title} exhausted its retries`);
    return "failed";
  }

  private async verifyTask(
    input: { runId: string; task: PlannedTask; config: DevHarmonicsConfig },
    worktreePath: string,
    attemptId: number | null = null,
  ): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const name of input.task.checks) {
      const validator = input.config.repository.validators[name];
      const validatorCwd = validator ? await resolveValidatorCwd(validator, worktreePath) : worktreePath;
      this.enforceToolPolicy({
        runId: input.runId,
        taskId: input.task.id,
        attemptId,
        toolId: `validator:${name}`,
        stage: input.task.id.startsWith("__integration__") ? "integration" : "verification",
        taskPermission: input.task.permission ?? "workspace_write",
        assignedWorktree: worktreePath,
        repositoryRoot: worktreePath,
        cwd: validatorCwd,
        config: input.config,
        request: validator ? { command: validator.command, args: validator.args, cwd: validatorCwd } : { validator: name },
      });
      const result = validator
        ? await runValidator(name, validator, worktreePath)
        : unknownValidator(name);
      results.push(result);
      this.ledger.recordCheck(input.runId, input.task.id, result);
      this.ledger.addEvent(
        input.runId,
        result.passed ? "check.passed" : "check.failed",
        `${input.task.title}: ${name} ${result.passed ? "passed" : `failed (${result.exitCode})`}`,
      );
    }
    return results;
  }

  private enforceToolPolicy(input: {
    runId: string;
    taskId: string | null;
    attemptId: number | null;
    toolId: string;
    stage: ToolStage;
    taskPermission: "read_only" | "workspace_write";
    assignedWorktree: string;
    repositoryRoot: string;
    cwd: string;
    config: DevHarmonicsConfig;
    request: Readonly<Record<string, unknown>>;
    actorRole?: "worker" | "coordinator";
    targetPaths?: readonly string[];
  }) {
    const planApproved = !input.config.runPolicy.requirePlanApproval
      || Boolean(this.ledger.getRun(input.runId)?.events.some((event) => event.kind === "plan.approved"));
    const result = evaluateToolRequest({
      toolId: input.toolId,
      actorRole: input.actorRole ?? "coordinator",
      stage: input.stage,
      taskPermission: input.taskPermission,
      assignedWorktree: input.assignedWorktree,
      repositoryRoot: input.repositoryRoot,
      cwd: input.cwd,
      targetPaths: input.targetPaths ?? [],
      planApproved,
      approval: null,
    }, input.config);
    this.ledger.recordToolPolicyReceipt({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      toolId: input.toolId,
      actorRole: input.actorRole ?? "coordinator",
      stage: input.stage,
      sideEffect: result.tool.sideEffect,
      outcome: result.outcome,
      reason: result.reason,
      request: input.request,
      lockKeys: result.lockKeys,
      approvalId: result.approvalId,
    });
    if (result.outcome !== "allow") {
      throw new Error(`${input.toolId} ${result.outcome.replace("_", " ")}: ${result.reason}`);
    }
    return result;
  }

  private availableProviders(config: DevHarmonicsConfig, requested?: ProviderName[]): ProviderName[] {
    const allowed = requested ? new Set(requested) : null;
    return ([config.product.architect, config.product.reviewer, ...config.product.workers] as ProviderName[]).filter(
      (name, index, values) =>
        values.indexOf(name) === index && config.connections[name].enabled && (!allowed || allowed.has(name)),
    );
  }

  private objectiveRepositoryContext(objective: ObjectiveRecord): { text: string; requiredImpactIds: string[] } | null {
    if (!objective.productId || !objective.repositoryIds.length) return null;
    const product = this.ledger.getProduct(objective.productId);
    if (!product) throw new Error(`Product '${objective.productId}' is no longer registered`);
    const byId = new Map(product.repositories.map((repository) => [repository.id, repository]));
    const selected = objective.repositoryIds.map((id) => byId.get(id)).filter((repository) => repository !== undefined);
    if (selected.length !== objective.repositoryIds.length) {
      const found = new Set(selected.map((repository) => repository.id));
      throw new Error(`Objective references repositories no longer registered in ${product.name}: ${objective.repositoryIds.filter((id) => !found.has(id)).join(", ")}`);
    }
    const required = new Set(objective.repositoryIds);
    for (const repository of selected) {
      repository.dependencyRepositoryIds.forEach((id) => { if (byId.has(id)) required.add(id); });
      for (const candidate of product.repositories) {
        if (candidate.dependencyRepositoryIds.includes(repository.id)) required.add(candidate.id);
      }
    }
    if (selected.some((repository) => ["umbrella", "shared_platform"].includes(repository.role))) {
      for (const candidate of product.repositories) {
        if (["documentation", "installer", "release_truth"].includes(candidate.role)) required.add(candidate.id);
      }
    }
    const requiredImpactIds = [...required];
    const lines = requiredImpactIds.map((id) => {
      const repository = byId.get(id)!;
      const relationships = [
        objective.repositoryIds.includes(id) ? "selected" : null,
        selected.some((item) => item.dependencyRepositoryIds.includes(id)) ? "dependency of selected repository" : null,
        selected.some((item) => repository.dependencyRepositoryIds.includes(item.id)) ? "depends on selected repository" : null,
        ["documentation", "installer", "release_truth"].includes(repository.role) && !objective.repositoryIds.includes(id) ? "delivery impact candidate" : null,
      ].filter(Boolean).join(", ");
      const inspection = repository.inspection;
      return [
        `Repository ${repository.id} (${repository.name})`,
        `role=${repository.role}`,
        `relationship=${relationships || "related"}`,
        `localPath=${repository.localPath ?? "not registered locally"}`,
        `branch=${inspection?.currentBranch ?? repository.defaultBranch}`,
        `dirty=${inspection?.dirty ?? "unknown"}`,
        `dependencies=${repository.dependencyRepositoryIds.join(",") || "none"}`,
        `owners=${repository.owners.join(",") || "unspecified"}`,
        `validators=${Object.keys(repository.validators).join(",") || "none mapped"}`,
        `governanceSources=${repository.governanceSources.join(",") || "none mapped"}`,
        `compatibilityIssues=${inspection?.compatibilityIssues.join(" | ") || "none observed"}`,
      ].join("; ");
    });
    const snapshot = this.ledger.latestProductIntelligenceSnapshot(product.id);
    const intelligenceContext = snapshot ? this.productIntelligenceContext(snapshot, new Set(requiredImpactIds)) : null;
    return {
      requiredImpactIds,
      text: [
        `Product ${product.name} (${product.id}). Repositories requiring an explicit impact decision:\n${lines.map((line) => `- ${line}`).join("\n")}`,
        intelligenceContext,
      ].filter(Boolean).join("\n\n"),
    };
  }

  private productIntelligenceContext(
    snapshot: import("./product-intelligence.js").ProductIntelligenceSnapshot,
    relevantRepositoryIds: Set<string>,
  ): string {
    const relevant = (repositoryId: string | null) => repositoryId === null || relevantRepositoryIds.has(repositoryId);
    const claims = snapshot.claims.filter((claim) => relevant(claim.repositoryId)).slice(0, 30);
    const findings = snapshot.findings.filter((finding) => relevant(finding.repositoryId)).slice(0, 30);
    const lines = [
      `Source-backed product intelligence snapshot ${snapshot.id} (${snapshot.createdAt}; ${snapshot.status}).`,
      ...findings.map((finding) => `Finding [${finding.severity}/${finding.kind}]: ${finding.message}${finding.citations.length ? ` Citations: ${finding.citations.join(", ")}` : ""}`),
      ...claims.map((claim) => `Claim ${claim.subject}.${claim.kind}=${claim.value}; citation=${claim.repositoryId}:${claim.sourcePath}:${claim.line}; revision=${claim.revision}; contentSha256=${claim.contentSha256}; workingTree=${claim.workingTree}`),
    ];
    return lines.join("\n");
  }

  private validateObjectiveRepositoryPlan(objective: ObjectiveRecord, plan: RunPlan, requiredImpactIds: string[]): void {
    if (!objective.productId || !objective.repositoryIds.length) return;
    const impacts = new Map((plan.repositoryImpact ?? []).map((impact) => [impact.repositoryId, impact]));
    const missing = requiredImpactIds.filter((id) => !impacts.has(id));
    if (missing.length) throw new Error(`Architect plan omitted repository impact decisions for: ${missing.join(", ")}`);
    const product = this.ledger.getProduct(objective.productId)!;
    const known = new Set(product.repositories.map((repository) => repository.id));
    const unknown = (plan.repositoryImpact ?? []).map((impact) => impact.repositoryId).filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Architect plan referenced repositories outside ${product.name}: ${unknown.join(", ")}`);
    const affected = new Set((plan.repositoryImpact ?? []).filter((impact) => impact.disposition === "affected").map((impact) => impact.repositoryId));
    if (![...affected].some((id) => objective.repositoryIds.includes(id))) {
      throw new Error("Architect plan excluded every repository explicitly selected by the user");
    }
    for (const task of plan.tasks) {
      if (!(task.repositoryIds ?? []).length) throw new Error(`Task '${task.id}' does not identify its repository IDs`);
      const invalid = (task.repositoryIds ?? []).filter((id) => !affected.has(id));
      if (invalid.length) throw new Error(`Task '${task.id}' targets repositories not marked affected: ${invalid.join(", ")}`);
    }
    const uncovered = [...affected].filter((id) => !plan.tasks.some((task) => (task.repositoryIds ?? []).includes(id)));
    if (uncovered.length) throw new Error(`Affected repositories have no planned task: ${uncovered.join(", ")}`);
    if (affected.size > 1 && !(plan.integrationConditions ?? []).length) {
      throw new Error("Multi-repository plans require explicit integration conditions");
    }
  }

  private async provider(name: string, config: DevHarmonicsConfig, connectionId?: string): Promise<RuntimeAdapter> {
    if (name === "ollama") {
      const connection = this.ledger.listConnections().find((item) => item.id === connectionId);
      const baseUrl = typeof connection?.metadata.baseUrl === "string" ? connection.metadata.baseUrl : undefined;
      return new OllamaAdapter(baseUrl, connection?.id ?? "local:ollama", connection?.displayName ?? "Ollama");
    }
    if (name === "openrouter") return new OpenRouterService(this.ledger).adapter();
    if (!(PROVIDERS as readonly string[]).includes(name)) throw new Error(`Unsupported runtime provider '${name}'`);
    const providerName = name as ProviderName;
    return createRuntimeAdapter(providerName, {
      ...config.connections[providerName],
      command: resolveProviderCommand(providerName, config.connections[providerName].command),
    });
  }

  private selectWorker(task: PlannedTask, providers: ProviderName[], cursor: number): ProviderName {
    if (cursor === 0 && task.preferredProvider && providers.includes(task.preferredProvider)) {
      return task.preferredProvider;
    }
    return providers[cursor % providers.length]!;
  }

  private parsePlan(
    text: string,
    config: DevHarmonicsConfig,
    autonomy: DevHarmonicsConfig["runPolicy"]["autonomy"] = config.runPolicy.autonomy,
    // The vocabulary the architect was offered. Accepting a plan against a
    // DIFFERENT list than the one the architect was given is the same contract
    // drift twice over: it was told to choose from the repositories' validators
    // and then refused for doing so. Defaults to the project's validators for
    // single-repository planning, where the two lists are identical.
    allowedValidators: readonly string[] = Object.keys(config.repository.validators),
  ): RunPlan {
    const plan = runPlanSchema.parse(parseFirstJsonObject(text));
    const allowed = new Set(allowedValidators);
    for (const task of plan.tasks) {
      for (const check of task.checks) {
        if (!allowed.has(check)) {
          throw new Error(`Architect selected unknown validator '${check}' for task '${task.id}'`);
        }
      }
    }
    if (autonomy === "observe") {
      const invalid = plan.tasks.filter((task) => task.kind !== "diagnostic" || task.permission !== "read_only" || task.risk !== "low");
      if (invalid.length) {
        throw new Error(`Observe runs require every task to use kind diagnostic, permission read_only, and risk low; invalid tasks: ${invalid.map((task) => task.id).join(", ")}`);
      }
    }
    assertAcyclic(plan);
    return plan;
  }

  private checkSummary(runId: string): string {
    const run = this.ledger.getRun(runId);
    if (!run) return "No run data available";
    return run.tasks
      .map((task) => {
        const checks = task.checks
          .map((check) => `${check.name}: ${check.passed ? "PASS" : `FAIL ${check.exitCode}`}`)
          .join(", ");
        return `${task.id} [${task.status}] via ${task.provider ?? "unassigned"}: ${checks || "no checks"}`;
      })
      .join("\n");
  }

  private recordSchedulerQualification(runId: string, result: SchedulerQualificationResult | null, role: "architect" | "worker" | "reviewer", taskId?: string): void {
    if (!result?.attempted) return;
    this.ledger.addEvent(
      runId,
      result.passed ? "model.qualification_passed" : "model.qualification_failed",
      `${result.provider} model '${result.modelId}' ${result.passed ? "passed" : "failed"} scheduler-time ${result.role} qualification`,
      { role, taskId: taskId ?? null, modelId: result.modelId, connectionId: result.connectionId, provider: result.provider, qualificationRole: result.role, activated: result.activated, reason: result.reason },
    );
  }

  private taskReportSummary(runId: string): string {
    const entries = this.ledger.listBlackboardEntries(runId).filter((entry) => entry.kind === "finding" || entry.kind === "handoff");
    if (!entries.length) return "No task reports were recorded.";
    return entries.map((entry) => `${entry.taskId ?? "run"} [${entry.kind}]: ${entry.content}`).join("\n\n");
  }

  private diagnosticReportChunks(runId: string): ReviewChunk[] {
    const findings = this.ledger.listBlackboardEntries(runId).filter((entry) => entry.kind === "finding");
    if (!findings.length) return [{ label: "missing-diagnostic-evidence", content: "No valid diagnostic task reports were recorded." }];
    return findings.map((entry) => ({ label: entry.taskId ?? `finding-${entry.id}`, content: entry.content }));
  }

  private openRouterEligible(config: DevHarmonicsConfig): boolean {
    return config.openRouter.enabled
      && config.openRouter.allowPaidFallback
      && config.runPolicy.allowPaidApi
      && config.openRouter.perRunLimitUsd > 0
      && config.openRouter.monthlyLimitUsd > 0
      && this.ledger.isConnectionEligible("api:openrouter");
  }

  private recordInvocation(
    runId: string,
    taskId: string | null,
    role: string,
    routing: { provider: string; connectionId: string; model: { requestedModelId: unknown }; fallback: boolean; factors: string[] },
    result: { provider?: string; durationMs?: number | null; model: { resolvedModelId: unknown; resolution?: string }; usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } },
    fallbackReason?: string | null,
    paidSpendReservationId?: string,
  ): void {
    this.ledger.recordInvocationReceipt({
      runId,
      taskId,
      role,
      provider: result.provider || routing.provider,
      connectionId: routing.connectionId,
      requestedModelId: routing.model.requestedModelId ? String(routing.model.requestedModelId) : null,
      resolvedModelId: String(result.model.resolvedModelId),
      modelResolution: result.model.resolution ?? null,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      durationMs: result.durationMs ?? null,
      workloadClass: role === "reviewer" ? "complex:premium" : null,
      fallbackReason: fallbackReason ?? (routing.fallback ? routing.factors.join("; ") : null),
      ...(paidSpendReservationId ? { paidSpendReservationId } : {}),
    });
  }

  private recordConnectionOutcome(connectionId: unknown, input: { success: boolean; failureKind?: string; detail?: string }): void {
    if (typeof connectionId !== "string" || !connectionId) return;
    try {
      this.ledger.recordConnectionOutcome(connectionId, input);
    } catch {
      // Runtime execution remains authoritative if an adapter fixture or a
      // newly added connection has not yet been reconciled into the registry.
    }
  }

  private recordModelOutcome(modelId: string, input: { success: boolean; failureKind?: string; detail?: string }): void {
    try {
      this.ledger.recordModelOutcome(modelId, input);
    } catch {
      // Compatibility/default model receipts may not have a concrete registry row.
    }
  }

  private recordQuotaGroupOutcome(connectionId: string, quotaGroupId: string, displayName: string, input: { success: boolean; failureKind?: string; detail?: string; cooldownUntil?: string | null }): void {
    try {
      this.ledger.recordQuotaGroupOutcome(connectionId, quotaGroupId, displayName, input);
    } catch {
      // Registry reconciliation may lag a just-discovered runtime connection.
    }
  }

  private recordScopedInvocationFailure(input: {
    connectionId: string;
    modelId: string | null;
    failureKind: Parameters<typeof invocationFailureScope>[0];
    detail: string;
    excludedModelIds: Set<string>;
    excludedConnectionIds: Set<string>;
  }): ReturnType<typeof invocationFailureScope> {
    const scope = invocationFailureScope(input.failureKind, Boolean(input.modelId));
    if (scope === "quota_group" && input.modelId) {
      const quotaGroup = modelQuotaGroup(this.ledger.getModel(input.modelId));
      if (quotaGroup) {
        for (const candidate of this.ledger.listModels(input.connectionId)) {
          if (modelQuotaGroup(candidate)?.id === quotaGroup.id) input.excludedModelIds.add(candidate.id);
        }
        this.recordQuotaGroupOutcome(input.connectionId, quotaGroup.id, quotaGroup.displayName, {
          success: false,
          failureKind: input.failureKind,
          detail: input.detail,
          cooldownUntil: quotaResetAt(input.detail),
        });
        return scope;
      }
    }
    if (scope === "model" && input.modelId) {
      input.excludedModelIds.add(input.modelId);
      this.recordModelOutcome(input.modelId, { success: false, failureKind: input.failureKind, detail: input.detail });
    } else if (scope === "connection" || scope === "quota_group") {
      input.excludedConnectionIds.add(input.connectionId);
      this.recordConnectionOutcome(input.connectionId, { success: false, failureKind: input.failureKind, detail: input.detail });
    }
    return scope;
  }

  private hasEligibleModelOnConnection(connectionId: string, excludedModelIds: ReadonlySet<string>): boolean {
    return this.ledger.listModels(connectionId).some((model) => {
      if (excludedModelIds.has(model.id) || !model.active || !model.qualified || model.qualificationStale || model.excluded || model.retired) return false;
      const quotaGroup = modelQuotaGroup(model);
      return !quotaGroup || this.ledger.isQuotaGroupEligible(connectionId, quotaGroup.id);
    });
  }
}

/**
 * Whether this exact shape of work can be routed to a model right now.
 *
 * Asks the router the question execution will ask, rather than approximating it.
 * The predicate this replaced checked generic lifecycle flags and answered both
 * true and false incorrectly: it kept a task alive for a local model qualified
 * only as an architect (routing then threw out of the attempt and failed the
 * run), and refused a manually assigned inactive local model that the router
 * would in fact have selected.
 */
/**
 * The execution context for one repository in a multi-repository run: its own
 * project configuration with the ledger's registered validators merged over it,
 * `${repoRoot}` expanded against THAT repository's primary root.
 *
 * Extracted so the production wiring is testable directly — an audit showed the
 * previous inline version could be reverted to an unexpanded spread with every
 * related test still green, because only the helpers underneath were covered.
 */
export async function buildRepositoryContext(
  baseConfig: DevHarmonicsConfig,
  repository: { localPath: string | null; validators: Record<string, ValidatorConfig> },
): Promise<{ config: DevHarmonicsConfig; constitution: string }> {
  const localConfig = await loadConfig(repository.localPath!);
  return {
    config: {
      ...baseConfig,
      repository: { validators: mergeRepositoryValidators(localConfig.repository.validators, repository.validators, repository.localPath) },
    },
    constitution: await loadConstitution(repository.localPath!),
  };
}

/**
 * The validator names an architect may choose from.
 *
 * The prompt tells it every check name must come from this list, so the list has
 * to contain names that exist where the work will run. Handing it only the
 * PROJECT's validators made every cross-repository plan name checks the affected
 * repositories do not have: the first real cross-repository run planned `test`
 * against repositories registering `tests`, and every task failed with "unknown
 * validator". The union is offered, and the per-repository context below tells
 * the architect which names belong to which repository.
 */
export function architectValidatorNames(
  projectValidators: Record<string, ValidatorConfig>,
  repositories: ReadonlyArray<{ validators: Record<string, ValidatorConfig> }>,
): string[] {
  const names = new Set(Object.keys(projectValidators));
  for (const repository of repositories) for (const name of Object.keys(repository.validators)) names.add(name);
  return [...names].sort();
}

export function canRoute(ledger: Ledger, input: RouteInput): boolean {
  return "decision" in new ModelRouter(ledger).tryRoute(input);
}

/**
 * "Some worker class can run something" — the only honest question at planning
 * and run start, where no specific task exists yet.
 *
 * Deliberately the most permissive worker shape. A plan that turns out to need
 * more than this settles at the task that needs it, which is where the
 * task-level answer lives. The weaker pre-plan answer must never be reused as a
 * task-level one: they are different questions.
 */
export function workerClassProbe(config: DevHarmonicsConfig, workerProviders: readonly ProviderName[]): RouteInput {
  return {
    role: "worker",
    config,
    fallbackProvider: workerProviders[0] ?? null,
    allowedProviders: workerProviders,
    permission: "read_only",
    // The most permissive worker shape there is. A low-risk read-only
    // diagnostic classifies to the lowest tier, so this asks "can anything take
    // worker work at all?". Passing no task instead classifies as standard
    // tier, which would refuse to plan or start work that small local models can
    // genuinely run — the same false-negative class this replaced.
    task: {
      id: "__worker_class_probe",
      title: "worker availability probe",
      description: "worker availability probe",
      dependencies: [],
      preferredProvider: null,
      checks: [],
      kind: "diagnostic",
      permission: "read_only",
      risk: "low",
    },
  };
}

/** Steering kinds the scheduler resolves at the task-admission boundary. */
export const ADMISSION_STEERING_KINDS: readonly SteeringDirectiveRecord["kind"][] = [
  "hold_admission",
  "resume_admission",
  "reprioritize",
  "reassign",
];

/**
 * DH-635. Resolves the admission-scoped steering directives against the queue the
 * scheduler is about to admit from.
 *
 * `ready` only ever contains dependency-satisfied tasks, so reordering here
 * physically cannot start blocked work — the dependency guarantee is structural
 * rather than a rule this function has to re-enforce. Directives that name
 * something inadmissible fail closed with a reason instead of being dropped.
 */
export function planSteeredAdmission(input: {
  pending: SteeringDirectiveRecord[];
  ready: PlannedTask[];
  admissionHeld: boolean;
  allowedProviders: readonly string[];
  /**
   * Every task still awaiting admission, including those whose dependencies are
   * not satisfied yet. Without it a directive aimed at a legitimately queued
   * task would be rejected merely for being early. Defaults to `ready` so
   * existing callers keep their behaviour.
   */
  queued?: PlannedTask[];
}): {
  admissionHeld: boolean;
  ordered: PlannedTask[];
  applied: Array<{ id: string; reason: string }>;
  rejected: Array<{ id: string; reason: string }>;
  deferred: Array<{ id: string; reason: string }>;
} {
  let admissionHeld = input.admissionHeld;
  let ordered = [...input.ready];
  const queuedIds = new Set((input.queued ?? input.ready).map((task) => task.id));
  const applied: Array<{ id: string; reason: string }> = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  // A directive aimed at a task that is queued but not yet admissible stays
  // pending: it is early, not wrong, and will apply when the task is admitted.
  const deferred: Array<{ id: string; reason: string }> = [];

  for (const directive of input.pending) {
    if (directive.kind === "hold_admission") {
      admissionHeld = true;
      applied.push({ id: directive.id, reason: "New task admission held; active work continues" });
      continue;
    }
    if (directive.kind === "resume_admission") {
      admissionHeld = false;
      applied.push({ id: directive.id, reason: "Task admission resumed" });
      continue;
    }
    if (directive.kind === "reprioritize") {
      const requested = directive.payload.taskOrder ?? [];
      const admissible = new Set(ordered.map((task) => task.id));
      const unknown = requested.filter((id) => !queuedIds.has(id));
      if (unknown.length) {
        rejected.push({
          id: directive.id,
          reason: `Cannot prioritise ${unknown.join(", ")}: not waiting for admission in this run`,
        });
        continue;
      }
      const notYetReady = requested.filter((id) => !admissible.has(id));
      if (notYetReady.length) {
        deferred.push({
          id: directive.id,
          reason: `Waiting for ${notYetReady.join(", ")} to become admissible`,
        });
        continue;
      }
      const rank = new Map(requested.map((id, index) => [id, index]));
      ordered = [...ordered].sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
      applied.push({ id: directive.id, reason: `Admission order set to ${requested.join(", ")}` });
      continue;
    }
    if (directive.kind === "reassign") {
      const provider = directive.payload.provider;
      if (!provider || !input.allowedProviders.includes(provider)) {
        rejected.push({ id: directive.id, reason: `Provider '${provider ?? "unset"}' is not an eligible worker for this run` });
        continue;
      }
      if (!queuedIds.has(directive.targetTaskId ?? "")) {
        rejected.push({ id: directive.id, reason: `Cannot reassign '${directive.targetTaskId}': it is not waiting for admission` });
        continue;
      }
      const target = ordered.find((task) => task.id === directive.targetTaskId);
      if (!target) {
        // Queued, but its dependencies have not finished. Hold the directive so
        // it lands when the task is actually admitted.
        deferred.push({ id: directive.id, reason: `Waiting for '${directive.targetTaskId}' dependencies before reassigning` });
        continue;
      }
      ordered = ordered.map((task) => (task.id === target.id ? { ...task, preferredProvider: provider as PlannedTask["preferredProvider"] } : task));
      applied.push({ id: directive.id, reason: `Reassigned ${target.id} to ${provider}` });
      continue;
    }
    // clarify and interrupt are attempt-scoped; the task loop consumes them.
  }

  return { admissionHeld, ordered: admissionHeld ? [] : ordered, applied, rejected, deferred };
}

export function assignReviewFindings(
  findings: readonly ReviewFinding[],
  repositoryIds: readonly string[],
): { byRepository: Map<string, ReviewFinding[]>; unassigned: ReviewFinding[] } {
  const byRepository = new Map<string, ReviewFinding[]>();
  const unassigned: ReviewFinding[] = [];
  for (const finding of findings) {
    const location = finding.location?.replace(/\\/g, "/").trim() ?? "";
    const matches = repositoryIds.filter((repositoryId) => location === repositoryId || location.startsWith(`${repositoryId}/`));
    if (matches.length !== 1) {
      unassigned.push(finding);
      continue;
    }
    const repositoryId = matches[0]!;
    const retained = byRepository.get(repositoryId) ?? [];
    retained.push(finding);
    byRepository.set(repositoryId, retained);
  }
  return { byRepository, unassigned };
}

function repositoryPathForFinding(location: string | null, repositoryId: string): string | null {
  if (!location) return null;
  const normalized = location.replace(/\\/g, "/").trim();
  if (!(normalized === repositoryId || normalized.startsWith(`${repositoryId}/`))) return null;
  const pathWithinRepository = normalized.slice(repositoryId.length).replace(/^\/+/, "").replace(/:\d+(?::\d+)?$/, "");
  return pathWithinRepository || null;
}

export function repositoryTaskIds(prefix: string, repositoryIds: string[]): Map<string, string> {
  const ids = new Map(repositoryIds.map((repositoryId) => {
    const slug = repositoryId.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "repository";
    const digest = createHash("sha256").update(repositoryId).digest("hex").slice(0, 12);
    return [repositoryId, `${prefix}-${slug}-${digest}`] as const;
  }));
  if (ids.size !== repositoryIds.length || new Set(ids.values()).size !== repositoryIds.length) {
    throw new Error("Repository identifiers must produce unique internal task identifiers");
  }
  return ids;
}

export async function settleActiveAttemptsIfAborted(
  signal: AbortSignal,
  attempts: Iterable<Promise<unknown>>,
): Promise<boolean> {
  if (!signal.aborted) return false;
  await Promise.allSettled([...attempts]);
  return true;
}

export function createReviewEvidenceBinding(input: {
  autonomy: RunAutonomy;
  plan: RunPlan;
  taskReports: string;
  diff: readonly unknown[];
  checks: readonly unknown[];
  repositories: ReviewEvidenceBinding["repositories"];
}): ReviewEvidenceBinding {
  const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    version: 1,
    autonomy: input.autonomy,
    planSha256: sha256(input.plan),
    taskReportsSha256: sha256(input.taskReports),
    diffSha256: sha256(input.diff),
    checksSha256: sha256(input.checks),
    repositories: [...input.repositories].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
  };
}

export function reviewEvidenceBindingSha256(binding: ReviewEvidenceBinding): string {
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

export function taskAttemptTimeoutMs(
  complexity: "simple" | "standard" | "complex",
  permission: InvocationPermission,
  configuredTimeoutMs: number,
): number | null {
  if (permission === "workspace_write") return null;
  const workloadLimitMs = complexity === "simple" ? 3 * 60_000 : complexity === "standard" ? 10 * 60_000 : 15 * 60_000;
  return Math.min(configuredTimeoutMs, workloadLimitMs);
}

function sanitizeLocalToolRequest(argumentsValue: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(argumentsValue).map(([key, value]) => [
    key,
    key === "content" && typeof value === "string" ? `[${Buffer.byteLength(value, "utf8")} bytes of bounded file content]` : value,
  ]));
}

export function parseFirstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("Architect did not return a valid JSON plan");
}

function assertAcyclic(plan: RunPlan): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));

  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Task plan contains a dependency cycle at '${id}'`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of plan.tasks) visit(task.id);
}
