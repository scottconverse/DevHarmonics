import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runPlanSchema } from "./schemas.js";
import { loadConfig, loadConstitution, ringerDirectory } from "./config.js";
import { Ledger } from "./ledger.js";
import { createProvider, type ProviderAdapter } from "./providers.js";
import {
  architectPrompt,
  formatFailures,
  reviewerPrompt,
  workerPrompt,
} from "./prompts.js";
import type {
  CheckResult,
  PlannedTask,
  ProviderName,
  RingerConfig,
  RunPlan,
  RunRequest,
  TaskStatus,
} from "./types.js";
import { runValidator, unknownValidator } from "./validators.js";
import { WorktreeManager } from "./worktrees.js";

export class Orchestrator {
  private readonly backgroundRuns = new Map<string, Promise<void>>();

  constructor(private readonly ledger: Ledger) {}

  begin(request: RunRequest): string {
    const runId = this.ledger.createRun(request.goal, request.projectPath);
    const execution = this.execute(runId, request)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.ledger.addEvent(runId, "run.failed", message);
        this.ledger.setRunStatus(runId, "failed", `NOT READY\n\n${message}`);
      })
      .finally(() => this.backgroundRuns.delete(runId));
    this.backgroundRuns.set(runId, execution);
    return runId;
  }

  async run(request: RunRequest): Promise<string> {
    const runId = this.begin(request);
    await this.backgroundRuns.get(runId);
    return runId;
  }

  private async execute(runId: string, request: RunRequest): Promise<void> {
    const projectPath = path.resolve(request.projectPath);
    const config = await loadConfig(projectPath);
    const constitution = await loadConstitution(projectPath);
    const availableProviders = this.availableProviders(config, request.enabledProviders);
    const workerProviders = config.workers.filter((name) => availableProviders.includes(name));
    if (!availableProviders.length) throw new Error("No subscription-backed providers are enabled");
    if (!workerProviders.length) throw new Error("No enabled provider is configured in the worker pool");

    const worktrees = new WorktreeManager(projectPath, runId);
    await worktrees.initialize();
    this.ledger.addEvent(runId, "worktree.created", `Integration branch ${worktrees.integrationBranch}`);

    const architectName = availableProviders.includes(config.architect)
      ? config.architect
      : availableProviders[0]!;
    const architect = this.provider(architectName, config);
    this.ledger.addEvent(runId, "architect.started", `${architectName} is planning the run`);
    const architectResult = await architect.run({
      role: "architect",
      prompt: architectPrompt({
        goal: request.goal,
        constitution,
        validators: Object.keys(config.validators),
        providers: workerProviders,
      }),
      cwd: worktrees.integrationPath,
      writeAccess: false,
    });
    const plan = this.parsePlan(architectResult.text, config);
    this.ledger.savePlan(runId, plan);

    const requestedAgents = request.agents ??
      (config.concurrency.mode === "auto" ? "auto" : config.concurrency.agents);
    let concurrency = requestedAgents === "auto" ? plan.recommendedConcurrency : requestedAgents;
    if (config.concurrency.ceiling !== null) {
      concurrency = Math.min(concurrency, config.concurrency.ceiling);
    }
    concurrency = Math.max(1, concurrency);
    this.ledger.addEvent(runId, "scheduler.started", `Scheduler using concurrency ${concurrency}`);

    const statuses = new Map<string, TaskStatus>(plan.tasks.map((task) => [task.id, "queued"]));
    const pending = new Map(plan.tasks.map((task) => [task.id, task]));
    const active = new Map<string, Promise<void>>();
    let providerCursor = 0;

    while (pending.size || active.size) {
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

    let failed = [...statuses.values()].some((status) => status !== "passed");
    const integrationChecks = [...new Set(plan.tasks.flatMap((task) => task.checks))];
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
    const reviewerName = availableProviders.includes(config.reviewer)
      ? config.reviewer
      : availableProviders[0]!;
    const reviewer = this.provider(reviewerName, config);
    this.ledger.addEvent(runId, "review.started", `${reviewerName} is reviewing the integration branch`);
    const review = await reviewer.run({
      role: "reviewer",
      prompt: reviewerPrompt({
        goal: request.goal,
        constitution,
        plan,
        checkSummary,
      }),
      cwd: worktrees.integrationPath,
      writeAccess: false,
    });
    const ready = !failed && review.text.trimStart().startsWith("READY");
    this.ledger.setRunStatus(runId, ready ? "ready" : "not_ready", review.text);
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
    config: RingerConfig;
    providers: ProviderName[];
    providerCursor: number;
    worktrees: WorktreeManager;
  }): Promise<TaskStatus> {
    const taskWorktree = await input.worktrees.createTask(input.task.id);
    let feedback = "";

    for (let attempt = 1; attempt <= input.config.retry.maxAttempts; attempt++) {
      const providerName = this.selectWorker(
        input.task,
        input.providers,
        input.providerCursor + attempt - 1,
      );
      const provider = this.provider(providerName, input.config);
      const prompt = workerPrompt({
        goal: input.goal,
        constitution: input.constitution,
        task: input.task,
        attempt,
        feedback,
      });
      this.ledger.setTaskStatus(input.runId, input.task.id, "working", providerName);
      this.ledger.addEvent(
        input.runId,
        "task.started",
        `${providerName} started ${input.task.title} (attempt ${attempt})`,
      );
      const attemptId = this.ledger.startAttempt(input.runId, input.task.id, providerName, prompt);

      try {
        const result = await provider.run({
          role: "worker",
          prompt,
          cwd: taskWorktree.path,
          writeAccess: true,
        });
        this.ledger.finishAttempt(attemptId, "completed", result.text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ledger.finishAttempt(attemptId, "failed", "", message);
        feedback = `Provider failure: ${message}`;
        this.ledger.addEvent(input.runId, "task.provider_failed", feedback);
        if (attempt < input.config.retry.maxAttempts) {
          this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
          await delay(input.config.retry.backoffMs);
          continue;
        }
        this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
        return "failed";
      }

      this.ledger.setTaskStatus(input.runId, input.task.id, "verifying");
      const checks = await this.verifyTask(input, taskWorktree.path);
      if (checks.every((check) => check.passed)) {
        try {
          const committed = await input.worktrees.commitTask(taskWorktree.path, input.task.id);
          if (committed) await input.worktrees.mergeTask(taskWorktree.branch, input.task.id);
          this.ledger.setTaskStatus(input.runId, input.task.id, "passed");
          this.ledger.addEvent(input.runId, "task.passed", `${input.task.title} passed verification`);
          return "passed";
        } catch (error) {
          feedback = error instanceof Error ? error.message : String(error);
        }
      } else {
        feedback = formatFailures(checks);
      }

      this.ledger.addEvent(input.runId, "task.retry", `${input.task.title}: ${feedback}`);
      if (attempt < input.config.retry.maxAttempts) {
        this.ledger.setTaskStatus(input.runId, input.task.id, "retry");
        await delay(input.config.retry.backoffMs);
      }
    }

    this.ledger.setTaskStatus(input.runId, input.task.id, "failed");
    this.ledger.addEvent(input.runId, "task.failed", `${input.task.title} exhausted its retries`);
    return "failed";
  }

  private async verifyTask(
    input: { runId: string; task: PlannedTask; config: RingerConfig },
    worktreePath: string,
  ): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const name of input.task.checks) {
      const validator = input.config.validators[name];
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

  private availableProviders(config: RingerConfig, requested?: ProviderName[]): ProviderName[] {
    const allowed = requested ? new Set(requested) : null;
    return ([config.architect, config.reviewer, ...config.workers] as ProviderName[]).filter(
      (name, index, values) =>
        values.indexOf(name) === index && config.providers[name].enabled && (!allowed || allowed.has(name)),
    );
  }

  private provider(name: ProviderName, config: RingerConfig): ProviderAdapter {
    return createProvider(name, config.providers[name]);
  }

  private selectWorker(task: PlannedTask, providers: ProviderName[], cursor: number): ProviderName {
    if (cursor === 0 && task.preferredProvider && providers.includes(task.preferredProvider)) {
      return task.preferredProvider;
    }
    return providers[cursor % providers.length]!;
  }

  private parsePlan(text: string, config: RingerConfig): RunPlan {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Architect did not return a JSON plan");
    const plan = runPlanSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
    for (const task of plan.tasks) {
      for (const check of task.checks) {
        if (!config.validators[check]) {
          throw new Error(`Architect selected unknown validator '${check}' for task '${task.id}'`);
        }
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
