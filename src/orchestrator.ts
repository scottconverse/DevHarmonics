import path from "node:path";
import { projectLegacyProvider } from "./compatibility.js";
import { CapacityBroker } from "./capacity.js";
import { normalizeAgentResult, validateDiagnosticResult } from "./agents.js";
import { assembleContextPack } from "./context.js";
import { setTimeout as delay } from "node:timers/promises";
import { runPlanSchema } from "./schemas.js";
import { loadConfig, loadConstitution, resolveProviderCommand, devHarmonicsDirectory } from "./config.js";
import { inspectProviders } from "./doctor.js";
import { Ledger } from "./ledger.js";
import { OllamaAdapter, syncOllamaRuntimes } from "./ollama.js";
import { createRuntimeAdapter } from "./providers.js";
import {
  architectPrompt,
  formatFailures,
  localReviewerContextHeader,
  reviewerPrompt,
  workerPrompt,
} from "./prompts.js";
import { chunkDiffFiles, runContextOnlyReview, type ReviewChunk } from "./local-review.js";
import {
  PROVIDERS,
  type CheckResult,
  type PlannedTask,
  type ProviderName,
  type DevHarmonicsConfig,
  type RunPlan,
  type RunRequest,
  type TaskStatus,
} from "./types.js";
import { invocationFailureScope, RuntimeInvocationError, type InvocationPermission, type RuntimeAdapter } from "./runtime.js";
import { syncSubscriptionConnections } from "./registry.js";
import { ModelRouter } from "./routing.js";
import { observeLocalResources } from "./resources.js";
import { requireAllowedTool } from "./policy.js";
import { estimateInvocationCost, OpenRouterService } from "./openrouter.js";
import { ensureSchedulerCandidateQualified, type SchedulerQualificationResult } from "./qualification.js";
import { runValidator, unknownValidator } from "./validators.js";
import { WorktreeManager, WorkspaceIsolationError } from "./worktrees.js";

export class Orchestrator {
  private readonly backgroundRuns = new Map<string, Promise<void>>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly approvalResolvers = new Map<string, () => void>();

  constructor(private readonly ledger: Ledger) {}

  begin(request: RunRequest, resumedFrom: string | null = null): string {
    const runId = this.ledger.createRun(request.goal, request.projectPath, resumedFrom, request.autonomy ?? "supervised");
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
    if (!configuredProviders.length) throw new Error("No subscription-backed providers are enabled");

    const providerStatuses = await inspectProviders(config, projectPath);
    syncSubscriptionConnections(this.ledger, providerStatuses);
    await syncOllamaRuntimes(this.ledger, config.localRuntimes.ollama);
    const unavailable = providerStatuses.filter(
      (provider) => configuredProviders.includes(provider.name) && !provider.available,
    );
    if (unavailable.length) {
      const instructions = unavailable
        .map((provider) => `${provider.name}: ${provider.summary}${provider.authenticated ? "" : `; run '${provider.loginCommand}'`}`)
        .join("; ");
      throw new Error(`Provider sign-in required before this run (${instructions}), then refresh and retry.`);
    }
    const availableProviders = configuredProviders.filter((name) =>
      this.ledger.isConnectionEligible(projectLegacyProvider(name).connectionId),
    );
    if (!availableProviders.length) {
      const health = this.ledger.listConnectionHealth().filter((item) => configuredProviders.some((name) => projectLegacyProvider(name).connectionId === item.connectionId));
      throw new Error(`All enabled providers are unavailable or cooling down (${health.map((item) => `${item.connectionId}: ${item.state}${item.cooldownUntil ? ` until ${item.cooldownUntil}` : ""}`).join("; ")})`);
    }
    const workerProviders = config.product.workers.filter((name) => availableProviders.includes(name));
    if (!workerProviders.length) throw new Error("No healthy provider is configured in the worker pool");

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
    let plan: RunPlan | null = null;
    let lastArchitectError: Error | null = null;
    for (const candidate of architectCandidates) {
      const qualification = await ensureSchedulerCandidateQualified({ ledger: this.ledger, config, cwd: worktrees.integrationPath, role: "architect", preferredProvider: candidate, permission: "read_only" });
      this.recordSchedulerQualification(runId, qualification, "architect");
      if (qualification?.attempted && !qualification.passed) {
        lastArchitectError = new Error(`${qualification.provider} model '${qualification.modelId}' failed architect qualification`);
        continue;
      }
      const architectDecision = router.route({ role: "architect", config, fallbackProvider: candidate, allowedProviders: [candidate], permission: "read_only" });
      const architect = await this.provider(architectDecision.provider, config, architectDecision.connectionId);
      this.ledger.addEvent(runId, "architect.started", `${architectDecision.provider} is planning the run`, { routing: architectDecision });
      try {
        const architectResult = await architect.invoke(
          {
            role: "architect",
            prompt: architectPrompt({
              goal: request.goal,
              constitution,
              validators: Object.keys(config.repository.validators),
              providers: workerProviders,
              workspacePath: worktrees.integrationPath,
              autonomy,
            }),
            cwd: worktrees.integrationPath,
            permission: "read_only",
            timeoutMs: null,
            model: architectDecision.model,
          },
          { signal },
        );
        if (signal.aborted) return;
        this.recordInvocation(runId, null, "architect", architectDecision, architectResult);
        try {
          plan = this.parsePlan(architectResult.text, config, autonomy);
          this.recordConnectionOutcome(architect.connection.id, { success: true });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastArchitectError = new Error(`${architectDecision.provider} returned an invalid plan: ${message}`);
          this.recordConnectionOutcome(architect.connection.id, { success: false, failureKind: "incompatible", detail: message });
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
        this.recordConnectionOutcome(architect.connection.id, { success: false, failureKind, detail: message });
        this.ledger.addEvent(runId, "architect.failed", `${architectDecision.provider} could not produce a plan; trying the next eligible architect`, {
          provider: architectDecision.provider,
          failureKind,
          detail: message,
        });
      }
    }
    if (!plan) throw lastArchitectError ?? new Error("No eligible architect produced a valid plan");
    this.ledger.savePlan(runId, plan);
    if (config.runPolicy.requirePlanApproval) {
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

    while (pending.size || active.size) {
      // On cancel, stop scheduling. In-flight worker processes are aborted via
      // the shared signal and their tasks return 'cancelled'; ledger.cancelRun
      // owns the run/task status, so return without running integration/review.
      if (signal.aborted) return;

      for (const [taskId, task] of pending) {
        if (task.dependencies.some((dependency) => ["failed", "blocked"].includes(statuses.get(dependency) ?? ""))) {
          statuses.set(taskId, "blocked");
          pending.delete(taskId);
          this.ledger.setTaskStatus(runId, taskId, "blocked");
          this.ledger.addEvent(runId, "task.blocked", `${task.title} blocked by a failed dependency`);
        }
      }

      const ready = [...pending.values()].filter((task) =>
        task.dependencies.every((dependency) => statuses.get(dependency) === "passed"),
      );

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
      } else if (pending.size) {
        throw new Error("The task graph cannot make progress; check for cyclic dependencies");
      }
    }

    // A cancel that lands as the scheduler drains must still skip the final
    // integration + reviewer phase so it cannot overwrite the 'cancelled' run.
    if (signal.aborted) return;

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
    const checkSummary = this.checkSummary(runId);
    const taskReports = this.taskReportSummary(runId);
    const reviewerName = availableProviders.includes(config.product.reviewer)
      ? config.product.reviewer
      : availableProviders[0]!;
    const reviewerProviders = this.openRouterEligible(config) ? [...availableProviders, "openrouter"] : availableProviders;
    const implementationProviders = [...new Set(
      (this.ledger.getRun(runId)?.tasks ?? [])
        .filter((task) => task.id !== "__integration__" && task.provider)
        .map((task) => String(task.provider)),
    )];
    const excludedReviewerModels = new Set<string>();
    const excludedReviewerConnections = new Set<string>();
    let reviewText: string | null = null;
    let reviewerFallbackReason: string | null = null;
    let lastReviewerError: Error | null = null;
    for (let reviewAttempt = 1; reviewAttempt <= config.application.retry.maxAttempts; reviewAttempt++) {
      const reviewerStart = reviewerProviders.indexOf(reviewerName);
      const qualificationProviders = reviewerProviders.map((_, index) => reviewerProviders[(Math.max(0, reviewerStart) + reviewAttempt - 1 + index) % reviewerProviders.length]!);
      let reviewerFallbackProvider = qualificationProviders[0]!;
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
          reviewerFallbackProvider = qualification.provider;
          break;
        }
      }
      let reviewerDecision;
      try {
        reviewerDecision = router.route({
          role: "reviewer",
          config,
          fallbackProvider: reviewerFallbackProvider as ProviderName,
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
            model: reviewerDecision.model,
          }, { signal });
          this.recordInvocation(runId, null, "reviewer", reviewerDecision, review, reviewerFallbackReason);
          reviewText = review.text;
        } else {
          const diffFiles = await worktrees.integrationDiffFiles();
          const chunks = autonomy === "observe" ? this.diagnosticReportChunks(runId) : chunkDiffFiles(diffFiles);
          if (reviewerDecision.provider === "openrouter") {
            const selected = reviewerDecision.model.requestedModelId ? this.ledger.getModel(String(reviewerDecision.model.requestedModelId)) : null;
            const estimated = selected ? estimateInvocationCost(selected, chunks.map((chunk) => chunk.content).join("\n"), Math.max(500, chunks.length * 192)) ?? 0 : 0;
            await new OpenRouterService(this.ledger).assertPaidRoutingAllowed(config, runId, estimated);
          }
          const localTaskReports = autonomy === "observe" ? "Each accepted diagnostic report is supplied as an independent evidence chunk." : taskReports;
          const review = await runContextOnlyReview({
            adapter: reviewer,
            model: reviewerDecision.model,
            cwd: worktrees.integrationPath,
            contextHeader: localReviewerContextHeader({ goal: request.goal, constitution, plan, checkSummary, taskReports: localTaskReports, autonomy }),
            chunks,
            evidenceLabel: autonomy === "observe" ? "diagnostic report" : "diff chunk",
            signal,
            onChunk: (receipt, index, total) => {
              this.ledger.addEvent(runId, "review.chunk_completed", `${reviewerDecision.provider} reviewed chunk ${index + 1}/${total}: ${receipt.label} — ${receipt.verdict}`, { label: receipt.label, verdict: receipt.verdict, durationMs: receipt.durationMs, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costUsd: receipt.costUsd });
              this.ledger.recordInvocationReceipt({ runId, role: "reviewer", provider: receipt.provider, connectionId: receipt.connectionId, requestedModelId: reviewerDecision.model.requestedModelId ? String(reviewerDecision.model.requestedModelId) : null, resolvedModelId: receipt.resolvedModelId, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costUsd: receipt.costUsd, durationMs: receipt.durationMs, workloadClass: "complex:premium", fallbackReason: reviewerFallbackReason ?? (reviewerDecision.fallback ? reviewerDecision.factors.join("; ") : null) });
            },
          });
          reviewText = review.text;
        }
        this.recordConnectionOutcome(reviewer.connection.id, { success: true });
        if (reviewerDecision.model.requestedModelId) this.recordModelOutcome(String(reviewerDecision.model.requestedModelId), { success: true });
        break;
      } catch (error) {
        if (signal.aborted) return;
        const failureKind = error instanceof RuntimeInvocationError ? error.kind : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        lastReviewerError = error instanceof Error ? error : new Error(message);
        reviewerFallbackReason = `${reviewerDecision.provider} review failed (${failureKind}): ${message}`;
        const failureScope = invocationFailureScope(failureKind, Boolean(reviewerDecision.model.requestedModelId));
        if (failureScope === "model" && reviewerDecision.model.requestedModelId) {
          const modelId = String(reviewerDecision.model.requestedModelId);
          excludedReviewerModels.add(modelId);
          this.recordModelOutcome(modelId, { success: false, failureKind, detail: message });
        } else if (failureScope === "connection") {
          excludedReviewerConnections.add(String(reviewer.connection.id));
          this.recordConnectionOutcome(reviewer.connection.id, { success: false, failureKind, detail: message });
        }
        this.ledger.addEvent(runId, "review.failed", `${reviewerFallbackReason}; trying the next eligible reviewer`, { provider: reviewerDecision.provider, connectionId: reviewer.connection.id, modelId: reviewerDecision.model.requestedModelId, failureKind, reviewAttempt });
      }
    }
    if (reviewText === null) throw lastReviewerError ?? new Error("No eligible reviewer completed final review");
    const ready = !failed && reviewText.trimStart().startsWith("READY");
    this.ledger.setRunStatus(runId, ready ? "ready" : "not_ready", reviewText);
    this.ledger.addEvent(
      runId,
      ready ? "run.ready" : "run.not_ready",
      ready ? "Run passed final review" : "Run requires follow-up",
    );
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
  }): Promise<TaskStatus> {
    const taskWorktree = await input.worktrees.createTask(input.task.id);
    const taskPermission = input.task.permission ?? "workspace_write";
    let feedback = "";
    const excludedModelIds = new Set<string>();
    const excludedConnectionIds = new Set<string>();

    for (let attempt = 1; attempt <= input.config.application.retry.maxAttempts; attempt++) {
      // Do not start a new attempt once cancelled; leave the 'cancelled' status
      // for ledger.cancelRun to own rather than marking the task 'failed'.
      if (input.signal.aborted) return "cancelled";
      const eligibleProviders = input.providers.filter((name) => this.ledger.isConnectionEligible(projectLegacyProvider(name).connectionId));
      if (!eligibleProviders.length) {
        this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
        this.ledger.addEvent(input.runId, "task.failed", `${input.task.title}: all eligible providers are cooling down or unavailable`);
        return "failed";
      }
      const fallbackProvider = this.selectWorker(
        input.task,
        eligibleProviders,
        input.providerCursor + attempt - 1,
      );
      const qualification = await ensureSchedulerCandidateQualified({
        ledger: this.ledger,
        config: input.config,
        cwd: taskWorktree.path,
        role: "worker",
        preferredProvider: fallbackProvider,
        permission: taskPermission,
        task: input.task,
        excludedModelIds,
        excludedConnectionIds,
      });
      this.recordSchedulerQualification(input.runId, qualification, "worker", input.task.id);
      if (qualification?.attempted && !qualification.passed) {
        excludedModelIds.add(qualification.modelId);
        feedback = `Model qualification failed: ${qualification.provider} candidate '${qualification.modelId}' did not pass the ${qualification.role} fixture.`;
        this.ledger.addEvent(input.runId, "task.provider_failed", feedback, { taskId: input.task.id, modelId: qualification.modelId, failureKind: "incompatible" });
        if (attempt < input.config.application.retry.maxAttempts) {
          this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
          await delay(input.config.application.retry.backoffMs);
          continue;
        }
        this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
        return "failed";
      }
      const routing = new ModelRouter(this.ledger).route({
        role: "worker",
        config: input.config,
        fallbackProvider,
        allowedProviders: taskPermission === "read_only" && this.openRouterEligible(input.config) ? [...eligibleProviders, "openrouter"] : eligibleProviders,
        permission: taskPermission,
        task: input.task,
        excludedModelIds,
        excludedConnectionIds,
      });
      if (!(PROVIDERS as readonly string[]).includes(routing.provider) && taskPermission === "workspace_write") {
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

      try {
        if (providerName === "openrouter") {
          const selected = model.requestedModelId ? this.ledger.getModel(String(model.requestedModelId)) : null;
          const estimated = selected ? estimateInvocationCost(selected, prompt) ?? 0 : 0;
          await new OpenRouterService(this.ledger).assertPaidRoutingAllowed(input.config, input.runId, estimated);
        }
        await input.worktrees.assertPrimaryClean?.(`before ${input.task.id} attempt ${attempt}`);
        const result = await provider.invoke(
          {
            role: "worker",
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
            model,
          },
          { signal: input.signal },
        );
        await input.worktrees.assertPrimaryClean?.(`after ${input.task.id} attempt ${attempt}`);
        const fallbackReason = routing.fallback
          ? routing.factors.join("; ")
          : providerName === "openrouter" && feedback
            ? feedback
            : null;
        const normalizedResult = normalizeAgentResult("worker", result.text);
        const diagnosticIssue = taskPermission === "read_only" ? validateDiagnosticResult(input.task, result.text) : null;
        this.ledger.finishAttempt(attemptId, diagnosticIssue ? "rejected" : "completed", result.text, diagnosticIssue ?? "", {
          modelId: result.model.resolvedModelId,
          modelResolution: result.model.resolution,
          resultEnvelope: normalizedResult,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          fallbackReason,
        });
        this.recordInvocation(input.runId, input.task.id, "worker", routing, result, fallbackReason);
        this.recordConnectionOutcome(provider.connection.id, { success: true });
        if (model.requestedModelId) this.recordModelOutcome(String(model.requestedModelId), { success: true });
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
        // A cancel aborts the child process, surfacing here as a failure. Stop
        // without marking the task 'failed' or retrying; cancelRun owns status.
        if (input.signal.aborted) return "cancelled";
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
        const failureScope = invocationFailureScope(failureKind, Boolean(model.requestedModelId));
        if (failureScope === "model" && model.requestedModelId) {
          const modelId = String(model.requestedModelId);
          excludedModelIds.add(modelId);
          this.recordModelOutcome(modelId, { success: false, failureKind, detail: message });
        } else if (failureScope === "connection") {
          excludedConnectionIds.add(String(provider.connection.id));
          this.recordConnectionOutcome(provider.connection.id, { success: false, failureKind, detail: message });
        } else {
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
      }

      this.ledger.setTaskStatus(input.runId, input.task.id, "verifying");
      const checks = await this.verifyTask(input, taskWorktree.path);
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
          requireAllowedTool("git.commit", input.config);
          const committed = await input.worktrees.commitTask(taskWorktree.path, input.task.id);
          if (input.signal.aborted) return "cancelled";
          if (committed) {
            requireAllowedTool("git.merge", input.config);
            await input.worktrees.mergeTask(taskWorktree.branch, input.task.id);
          }
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
  ): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const name of input.task.checks) {
      requireAllowedTool(`validator:${name}`, input.config);
      const validator = input.config.repository.validators[name];
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

  private availableProviders(config: DevHarmonicsConfig, requested?: ProviderName[]): ProviderName[] {
    const allowed = requested ? new Set(requested) : null;
    return ([config.product.architect, config.product.reviewer, ...config.product.workers] as ProviderName[]).filter(
      (name, index, values) =>
        values.indexOf(name) === index && config.connections[name].enabled && (!allowed || allowed.has(name)),
    );
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

  private parsePlan(text: string, config: DevHarmonicsConfig, autonomy: DevHarmonicsConfig["runPolicy"]["autonomy"] = config.runPolicy.autonomy): RunPlan {
    const plan = runPlanSchema.parse(parseFirstJsonObject(text));
    for (const task of plan.tasks) {
      for (const check of task.checks) {
        if (!config.repository.validators[check]) {
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
    result: { provider?: string; durationMs?: number | null; model: { resolvedModelId: unknown }; usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } },
    fallbackReason?: string | null,
  ): void {
    this.ledger.recordInvocationReceipt({
      runId,
      taskId,
      role,
      provider: result.provider || routing.provider,
      connectionId: routing.connectionId,
      requestedModelId: routing.model.requestedModelId ? String(routing.model.requestedModelId) : null,
      resolvedModelId: String(result.model.resolvedModelId),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      durationMs: result.durationMs ?? null,
      workloadClass: role === "reviewer" ? "complex:premium" : null,
      fallbackReason: fallbackReason ?? (routing.fallback ? routing.factors.join("; ") : null),
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
