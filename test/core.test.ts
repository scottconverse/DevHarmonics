import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import test from "node:test";
import { defaultConfig, initializeProject, loadConfig, resolveProviderCommand } from "../src/config.js";
import { projectLegacyProvider } from "../src/compatibility.js";
import { assertRunTransition, assertTaskTransition, domainId } from "../src/domain.js";
import { LEDGER_SCHEMA_VERSION, Ledger } from "../src/ledger.js";
import { assignReviewFindings, createReviewEvidenceBinding, Orchestrator, parseFirstJsonObject, repositoryTaskIds, reviewEvidenceBindingSha256, settleActiveAttemptsIfAborted, taskAttemptTimeoutMs } from "../src/orchestrator.js";
import { discoverOllama, OllamaAdapter, syncOllamaRegistry, syncOllamaRuntimes } from "../src/ollama.js";
import {
  createProvider,
  extractClaudeText,
  extractCodexText,
  extractGeminiText,
} from "../src/providers.js";
import {
  RuntimeInvocationError,
  classifyInvocationFailure,
  invocationFailureScope,
  type InvocationEvent,
} from "../src/runtime.js";
import type { DevHarmonicsConfig } from "../src/types.js";
import { manualModelSchema, objectiveInputSchema, runPlanSchema } from "../src/schemas.js";
import { runProcess, subscriptionEnvironment } from "../src/process.js";
import { REDACTED, redactText } from "../src/redaction.js";
import { parseNvidiaSmi } from "../src/resources.js";
import { empiricalLatencyScore, empiricalReliabilityScore, ModelRouter } from "../src/routing.js";
import { CapacityBroker } from "../src/capacity.js";
import { normalizeAgentResult, validateDiagnosticResult } from "../src/agents.js";
import { assembleContextPack } from "../src/context.js";
import { evaluateToolPolicy } from "../src/policy.js";
import { WorkspaceIsolationError, WorktreeManager } from "../src/worktrees.js";
import { chunkDiffFiles, classifyVerdict, runContextOnlyReview } from "../src/local-review.js";
import { classifyWorkload, inferModelProfile, profileMetadata, SUBSCRIPTION_COMPATIBILITY_MODELS } from "../src/model-intelligence.js";
import { parseCurrentClaudeModels } from "../src/catalog.js";
import { estimateInvocationCost, estimateQualificationCost, isExactOpenRouterModelId, OpenRouterAdapter, OpenRouterService } from "../src/openrouter.js";
import { architectPrompt, localReviewerContextHeader, reviewerPrompt, workerPrompt } from "../src/prompts.js";
import { QUALIFICATION_FINGERPRINT_FIXTURE, ensureReviewerCandidateQualified, ensureSchedulerCandidateQualified, ensureSchedulerProviderCandidateQualified, hasCurrentOperationalQualification, qualifyRuntimeModel, trackedFamilyQualificationRole } from "../src/qualification.js";
import { modelQualificationFingerprint } from "../src/model-fingerprint.js";
import { aggregateModelPerformance } from "../src/model-performance.js";
import { quotaResetAt } from "../src/antigravity.js";
import { runValidator } from "../src/validators.js";
import { parseReviewerResponse } from "../src/review.js";

test("provider output parsers extract each CLI's final response", () => {
  const codex = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
  ].join("\n");
  assert.equal(extractCodexText(codex), "final");
  assert.equal(extractClaudeText(JSON.stringify({ result: "claude result" })), "claude result");
  assert.equal(extractGeminiText("gemini result\n"), "gemini result");
});

test("architect JSON parser ignores fences and trailing prose", () => {
  const value = parseFirstJsonObject(
    '```json\n{"summary":"brace } inside string","tasks":[]}\n```\nI also considered {not JSON}.',
  );
  assert.deepEqual(value, { summary: "brace } inside string", tasks: [] });
});

test("empirical model profiles expose first-pass reliability, failure modes, latency, and low-sample uncertainty", () => {
  const observations = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    runId: `run-${Math.floor(index / 2)}`,
    taskId: `task-${Math.floor(index / 2)}`,
    modelId: "subscription-cli:codex:model:gpt-5-6-terra",
    provider: "codex",
    status: index === 2 ? "failed" : "completed",
    failureKind: index === 2 ? "timeout" : null,
    malformedSource: index === 5,
    workloadClass: index < 10 ? "simple:luna" : "standard:terra",
    validatorFailureCount: index === 2 ? 2 : 0,
    integrationConflictCount: index === 2 ? 1 : 0,
    runNotReady: index < 2,
    costUsd: 0.01,
    startedAt: new Date(index * 1_000).toISOString(),
    finishedAt: new Date(index * 1_000 + 500).toISOString(),
  }));
  const [profile] = aggregateModelPerformance(observations);
  assert.ok(profile);
  assert.equal(profile.sampleSize, 20);
  assert.equal(profile.successCount, 19);
  assert.equal(profile.firstAttemptCount, 10);
  assert.equal(profile.firstAttemptSuccessCount, 9);
  assert.equal(profile.retryCount, 10);
  assert.equal(profile.averageLatencyMs, 500);
  assert.equal(profile.failureKinds.timeout, 1);
  assert.equal(profile.malformedEnvelopeCount, 1);
  assert.equal(profile.validatorFailureCount, 2);
  assert.equal(profile.integrationConflictCount, 1);
  assert.equal(profile.notReadyRunCount, 1);
  assert.equal(profile.billedSampleCount, 20);
  assert.equal(profile.totalCostUsd, 0.2);
  assert.equal(profile.averageCostUsd, 0.01);
  assert.equal(profile.workloads["simple:luna"]?.validatorFailureCount, 2);
  assert.equal(profile.uncertainty, "established");
  assert.equal(profile.eligibleForAdaptiveWeighting, true);
  assert.equal(profile.workloads["simple:luna"]?.sampleSize, 10);
  assert.equal(profile.workloads["standard:terra"]?.sampleSize, 10);
  assert.equal(profile.workloads["simple:luna"]?.uncertainty, "emerging");
  assert.equal(empiricalReliabilityScore(profile.workloads["simple:luna"]), 0);

  const [small] = aggregateModelPerformance(observations.slice(0, 2));
  assert.ok(small);
  assert.equal(small.uncertainty, "insufficient");
  assert.equal(small.eligibleForAdaptiveWeighting, false);
  assert.equal(empiricalReliabilityScore(small), 0);
  assert.equal(empiricalReliabilityScore({ ...profile, successRate: 1, firstAttemptSuccessRate: 1, malformedEnvelopeCount: 0, failureKinds: {} }), 4);
  assert.equal(empiricalReliabilityScore({ ...profile, successRate: 1, firstAttemptSuccessRate: 1, malformedEnvelopeCount: 0, validatorFailureCount: 20, failureKinds: {} }), 2);
  assert.equal(empiricalLatencyScore({ ...profile, averageLatencyMs: 20_000 }), 2);
  assert.equal(empiricalLatencyScore({ ...profile, averageLatencyMs: 700_000 }), -2);
  assert.equal(empiricalLatencyScore({ ...profile.workloads["simple:luna"]!, averageLatencyMs: 20_000 }), 0);
});

test("reviewer invocation receipts contribute empirical model observations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-reviewer-performance-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Review the accepted evidence", root, null, "observe");
    const receipt = {
      runId,
      role: "reviewer",
      provider: "ollama",
      connectionId: "local:ollama",
      requestedModelId: "ollama:qwen2.5:7b",
      resolvedModelId: "ollama:qwen2.5:7b",
      inputTokens: 1_200,
      outputTokens: 120,
      costUsd: 0,
      durationMs: 3_000,
    };
    ledger.recordInvocationReceipt(receipt);

    const profile = ledger.listModelPerformanceProfiles("ollama:qwen2.5:7b")[0];
    assert.ok(profile);
    assert.equal(profile.provider, "ollama");
    assert.equal(profile.sampleSize, 1);
    assert.equal(profile.successRate, 1);
    assert.equal(profile.averageLatencyMs, 3_000);
    assert.equal(profile.billedSampleCount, 1);
    assert.equal(profile.averageCostUsd, 0);
    assert.equal(profile.workloads["complex:premium"]?.sampleSize, 1);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("observe run prompts require diagnostic evidence without repository changes", () => {
  const task = {
    id: "observe-release",
    title: "Observe release truth",
    description: "Compare release claims",
    dependencies: [],
    preferredProvider: "codex" as const,
    checks: ["test"],
    kind: "diagnostic" as const,
    repositoryScope: ["README.md"],
    permission: "read_only" as const,
    risk: "low" as const,
    capabilityNeeds: ["analysis"],
    acceptanceCriteria: ["Cite contradictory claims"],
    expectedArtifacts: ["evidence report"],
  };
  const plan = { summary: "Observe", recommendedConcurrency: 1, tasks: [task] };
  const architect = architectPrompt({ goal: "Audit release truth", constitution: "Evidence first", validators: ["test"], providers: ["codex"], workspacePath: "C:/fixture", autonomy: "observe" });
  assert.match(architect, /every task must use kind "diagnostic"/i);
  assert.match(architect, /permission "read_only"/i);
  assert.match(architect, /risk "low"/i);
  assert.doesNotMatch(architect, /tasks must produce repository changes/i);

  const worker = workerPrompt({ goal: "Audit release truth", constitution: "Evidence first", task, attempt: 1, feedback: "", workspacePath: "C:/fixture" });
  assert.match(worker, /plan approval has already been granted/i);
  assert.match(worker, /execute the assigned diagnostic now/i);
  assert.match(worker, /do not modify/i);
  assert.match(worker, /evidence report/i);
  assert.doesNotMatch(worker, /make the necessary edits/i);

  const reports = "observe-release: package.json says 1.0.4 while README says 1.0.3";
  const reviewer = reviewerPrompt({ goal: "Audit release truth", constitution: "Evidence first", plan, checkSummary: "test: PASS", taskReports: reports, workspacePath: "C:/fixture", autonomy: "observe" });
  assert.match(reviewer, /diagnostic task reports/i);
  assert.match(reviewer, /package\.json says 1\.0\.4/);
  assert.doesNotMatch(reviewer, /review the combined diff/i);
  assert.match(localReviewerContextHeader({ goal: "Audit release truth", constitution: "Evidence first", plan, checkSummary: "test: PASS", taskReports: reports, autonomy: "observe" }), /package\.json says 1\.0\.4/);
});

test("diagnostic result validation rejects deferrals and missing path-line evidence", () => {
  const task = {
    id: "audit",
    title: "Audit",
    description: "Inspect evidence",
    dependencies: [],
    preferredProvider: null,
    checks: ["test"],
    kind: "diagnostic" as const,
    permission: "read_only" as const,
    risk: "low" as const,
    acceptanceCriteria: ["Every finding cites a repository-relative file path and line number"],
  };
  assert.match(validateDiagnosticResult(task, "Please approve the plan so I can begin.") ?? "", /asked for approval/i);
  assert.match(validateDiagnosticResult(task, "The version claims conflict, but no source locations are included in this otherwise sufficiently long report.") ?? "", /path:line/i);
  assert.equal(validateDiagnosticResult(task, "[README.md](C:/workspace/README.md:1) identifies CivicSuite version 1.0.4, while [STATUS.md](C:\\workspace\\STATUS.md:7) still identifies 1.0.3. This is a concrete release-readiness contradiction."), null);
  assert.equal(validateDiagnosticResult(task, "The target file is [SECURITY.md](file:///C:/workspace/SECURITY.md). Line 45 requires dependency issues to be reported upstream and patched or pinned. This is a substantive release-safety control with an explicit file and line citation."), null);
});

test("observe plan validation rejects implementation or writable task contracts", () => {
  const orchestrator = new Orchestrator({} as Ledger);
  const config = structuredClone(defaultConfig);
  config.repository.validators = { test: { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 } };
  const invalid = JSON.stringify({
    summary: "Unsafe observe plan",
    recommendedConcurrency: 1,
    tasks: [{ id: "one", title: "Change it", description: "Edit a file", dependencies: [], preferredProvider: "codex", checks: ["test"], kind: "implementation", repositoryScope: ["."], permission: "workspace_write", risk: "medium", capabilityNeeds: ["code"], acceptanceCriteria: ["Changed"], expectedArtifacts: ["commit"] }],
  });
  assert.throws(() => (orchestrator as any).parsePlan(invalid, config, "observe"), /observe.*diagnostic.*read_only.*low/i);
});

test("subscription environment strips API and cloud credentials", () => {
  process.env.OPENAI_API_KEY = "secret";
  process.env.ANTHROPIC_API_KEY = "secret";
  process.env.GEMINI_API_KEY = "secret";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "secret";
  assert.equal(subscriptionEnvironment("codex").OPENAI_API_KEY, undefined);
  assert.equal(subscriptionEnvironment("claude").ANTHROPIC_API_KEY, undefined);
  assert.equal(subscriptionEnvironment("gemini").GEMINI_API_KEY, undefined);
  assert.equal(subscriptionEnvironment("gemini").GOOGLE_APPLICATION_CREDENTIALS, undefined);
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

test(
  "Windows bare command resolution prefers cmd wrappers over PowerShell wrappers",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-command-"));
    const previousPath = process.env.PATH;
    try {
      await writeFile(path.join(root, "devharmonics-resolver-probe.ps1"), "throw 'wrong wrapper'\n");
      await writeFile(path.join(root, "devharmonics-resolver-probe.cmd"), "@echo chosen %*\r\n");
      process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
      const result = await runProcess({
        command: "devharmonics-resolver-probe",
        args: ["-"],
        cwd: root,
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /chosen -/);
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows Antigravity discovery finds the standard installer location",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-agy-command-"));
    const previousLocalAppData = process.env.LOCALAPPDATA;
    try {
      const command = path.join(root, "agy", "bin", "agy.exe");
      await mkdir(path.dirname(command), { recursive: true });
      await writeFile(command, "fixture", "utf8");
      process.env.LOCALAPPDATA = root;
      assert.equal(resolveProviderCommand("gemini", "agy"), command);
      assert.equal(resolveProviderCommand("codex", "codex"), "codex");
    } finally {
      process.env.LOCALAPPDATA = previousLocalAppData;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("project initialization detects Node validators and writes constitution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-config-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }),
    );
    await initializeProject(root);
    const config = await loadConfig(root);
    assert.equal(config.version, 2);
    assert.equal(config.connections.gemini.command, "agy");
    assert.deepEqual(config.repository.validators.test?.args, ["run", "test"]);
    assert.deepEqual(config.repository.validators.build?.args, ["run", "build"]);
    assert.ok(config.repository.validators["diff-check"]);
    assert.match(await readFile(path.join(root, ".devharmonics", "constitution.md"), "utf8"), /execution receipt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan schema rejects missing dependencies", () => {
  const result = runPlanSchema.safeParse({
    summary: "bad plan",
    recommendedConcurrency: 2,
    tasks: [
      {
        id: "one",
        title: "One",
        description: "Do one",
        dependencies: ["missing"],
        preferredProvider: null,
        checks: ["diff-check"],
      },
    ],
  });
  assert.equal(result.success, false);
});

test("internal repository task identifiers remain distinct when readable slugs collide", () => {
  const repositoryIds = ["github:org/foo.bar", "github:org/foo-bar"];
  const taskIds = repositoryTaskIds("__integration__", repositoryIds);
  assert.notEqual(taskIds.get(repositoryIds[0]!), taskIds.get(repositoryIds[1]!));
  assert.match(taskIds.get(repositoryIds[0]!)!, /^__integration__-github-org-foo-bar-[a-f0-9]{12}$/);
});

test("review evidence hashes change with repository heads and check evidence", () => {
  const base = { autonomy: "bounded" as const, plan: { summary: "bounded", recommendedConcurrency: 1, tasks: [] }, taskReports: "done", diff: [{ path: "a.ts", diff: "+safe" }], checks: [{ id: "one", checks: [{ name: "test", passed: true }] }], repositories: [{ repositoryId: "repo:core", baseCommit: "base", headCommit: "head-1" }] };
  const original = createReviewEvidenceBinding(base);
  const changedHead = createReviewEvidenceBinding({ ...base, repositories: [{ ...base.repositories[0]!, headCommit: "head-2" }] });
  const changedChecks = createReviewEvidenceBinding({ ...base, checks: [{ id: "one", checks: [{ name: "test", passed: false }] }] });
  assert.notEqual(reviewEvidenceBindingSha256(original), reviewEvidenceBindingSha256(changedHead));
  assert.notEqual(reviewEvidenceBindingSha256(original), reviewEvidenceBindingSha256(changedChecks));
});

test("aborted schedulers settle every active attempt before returning", async () => {
  const controller = new AbortController();
  controller.abort();
  let resolveFirst!: () => void;
  let resolveSecond!: () => void;
  const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
  let returned = false;
  const settling = settleActiveAttemptsIfAborted(controller.signal, [first, second]).then((value) => {
    returned = value;
  });
  resolveFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  resolveSecond();
  await settling;
  assert.equal(returned, true);
});

test("plan schema defaults and validates the cross-repository contract", () => {
  const legacy = runPlanSchema.parse({
    summary: "legacy plan",
    recommendedConcurrency: 1,
    tasks: [{
      id: "one",
      title: "One",
      description: "Do one",
      dependencies: [],
      preferredProvider: null,
      checks: ["diff-check"],
    }],
  });
  assert.deepEqual(legacy.tasks[0]?.repositoryIds, []);
  assert.deepEqual(legacy.repositoryImpact, []);
  assert.deepEqual(legacy.integrationConditions, []);

  const valid = runPlanSchema.safeParse({
    summary: "cross-repository plan",
    recommendedConcurrency: 2,
    repositoryImpact: [
      { repositoryId: "github:civicsuite/core", disposition: "affected", rationale: "Owns the contract" },
      { repositoryId: "github:civicsuite/docs", disposition: "excluded", rationale: "No public behavior changes" },
    ],
    integrationConditions: ["Core contract tests pass before dependent work starts"],
    tasks: [{
      id: "core",
      title: "Update core",
      description: "Change the shared contract",
      dependencies: [],
      preferredProvider: null,
      checks: ["contract tests"],
      repositoryIds: ["github:civicsuite/core"],
    }],
  });
  assert.equal(valid.success, true);

  const duplicateImpact = runPlanSchema.safeParse({
    summary: "duplicate impact",
    recommendedConcurrency: 1,
    repositoryImpact: [
      { repositoryId: "github:civicsuite/core", disposition: "affected", rationale: "First" },
      { repositoryId: "github:civicsuite/core", disposition: "excluded", rationale: "Second" },
    ],
    tasks: [{
      id: "one",
      title: "One",
      description: "Do one",
      dependencies: [],
      preferredProvider: null,
      checks: ["diff-check"],
    }],
  });
  assert.equal(duplicateImpact.success, false);

  const explicitEmptyImpact = runPlanSchema.safeParse({
    summary: "empty impact map",
    recommendedConcurrency: 1,
    repositoryImpact: [],
    tasks: [{
      id: "core",
      title: "Update core",
      description: "Change core",
      dependencies: [],
      preferredProvider: null,
      checks: ["contract tests"],
      repositoryIds: ["github:civicsuite/core"],
    }],
  });
  assert.equal(explicitEmptyImpact.success, false);

  const missingAffectedImpact = runPlanSchema.safeParse({
    summary: "incomplete impact",
    recommendedConcurrency: 1,
    repositoryImpact: [
      { repositoryId: "github:civicsuite/core", disposition: "excluded", rationale: "Incorrectly excluded" },
    ],
    tasks: [{
      id: "core",
      title: "Update core",
      description: "Change core",
      dependencies: [],
      preferredProvider: null,
      checks: ["contract tests"],
      repositoryIds: ["github:civicsuite/core"],
    }],
  });
  assert.equal(missingAffectedImpact.success, false);
});

test("Claude official catalog watcher selects the newest exact model in each tracked family", () => {
  const models = parseCurrentClaudeModels(`claude-opus-47 claude-opus-4-7 claude-opus-4-8 claude-fable-5 claude-sonnet-5 claude-haiku-4-5-20251001`);
  assert.deepEqual(models, ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
});

test("OpenRouter cost ceilings use catalog pricing and context without activating catalog models", () => {
  const model = { metadata: { promptPrice: 0.000001, completionPrice: 0.000002, contextLength: 100 } };
  assert.ok(Math.abs((estimateQualificationCost(model) ?? 0) - 0.000244) < 1e-12);
  assert.ok(Math.abs((estimateInvocationCost(model, "12345678", 10) ?? 0) - 0.00011) < 1e-12);
  assert.equal(estimateInvocationCost({ metadata: { promptPrice: 0.000001, completionPrice: 0.000002 } }, "prompt", 10), null);
  assert.equal(defaultConfig.openRouter.enabled, false);
  assert.equal(defaultConfig.openRouter.allowPaidFallback, false);
  assert.equal(defaultConfig.runPolicy.allowPaidApi, false);
  assert.equal(isExactOpenRouterModelId("anthropic/claude-fable-5"), true);
  assert.equal(isExactOpenRouterModelId("~anthropic/claude-fable-latest"), false);
});

test("local resource parsing preserves GPU capacity signals", () => {
  assert.deepEqual(parseNvidiaSmi("RTX Fixture, 24576, 4096, 20480, 17\n"), [{ name: "RTX Fixture", totalMiB: 24576, usedMiB: 4096, freeMiB: 20480, utilizationPercent: 17 }]);
});

test("capacity broker has no built-in agent ceiling and preserves explicit user ceilings", () => {
  const resources = { observedAt: new Date().toISOString(), ram: { totalBytes: 1, freeBytes: 1, usedPercent: 0 }, gpu: [], ollamaLoadedModels: [], advisoryLocalSlots: 2 };
  const broker = new CapacityBroker();
  assert.equal(broker.decide({ requestedConcurrency: 73, userCeiling: null, resources }).effectiveConcurrency, 73);
  assert.equal(broker.decide({ requestedConcurrency: 73, userCeiling: 12, resources }).effectiveConcurrency, 12);
  assert.equal(broker.decide({ requestedConcurrency: 73, userCeiling: null, resources }).productAgentCeiling, null);
});

test("workload classification maps architecture, routine work, and low-risk bulk analysis to independent tiers", () => {
  assert.equal(classifyWorkload("architect").requiredTier, "premium");
  assert.equal(classifyWorkload("worker", {
    id: "routine", title: "Routine", description: "Implement", dependencies: [], preferredProvider: null,
    checks: ["test"], kind: "implementation", permission: "workspace_write", risk: "medium",
    repositoryScope: ["."], capabilityNeeds: ["code"], acceptanceCriteria: ["passes"], expectedArtifacts: [],
  }).requiredTier, "standard");
  assert.equal(classifyWorkload("worker", {
    id: "bulk", title: "Bulk", description: "Classify", dependencies: [], preferredProvider: null,
    checks: ["test"], kind: "diagnostic", permission: "read_only", risk: "low",
    repositoryScope: ["."], capabilityNeeds: ["analysis"], acceptanceCriteria: [], expectedArtifacts: [],
  }).requiredTier, "economy");
  assert.equal(classifyWorkload("worker", {
    id: "migration", title: "Migration", description: "Migrate auth", dependencies: [], preferredProvider: null,
    checks: ["test"], kind: "implementation", permission: "workspace_write", risk: "high",
    repositoryScope: ["."], capabilityNeeds: ["authentication", "migration"], acceptanceCriteria: [], expectedArtifacts: [],
  }).requiredTier, "premium");
});

test("OpenRouter adapter sends the hard completion ceiling", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ model: "openai/test-20260715", provider: "fixture", choices: [{ message: { content: "bounded" } }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.001 } }), { status: 200 });
  };
  try {
    const adapter = new OpenRouterAdapter("fixture-secret");
    const baseRequest = { role: "reviewer" as const, prompt: "bounded prompt", cwd: process.cwd(), permission: "read_only" as const, timeoutMs: 1_000, model: { requestedModelId: domainId("Model", "api:openrouter:model:test"), alias: "openai/test-20260715", settings: {} } };
    await assert.rejects(() => adapter.invoke(baseRequest), /hard completion-token ceiling/i);
    await adapter.invoke({ ...baseRequest, maxOutputTokens: 7 });
    assert.ok(requestBody);
    const capturedBody = requestBody as unknown as Record<string, unknown>;
    assert.equal(capturedBody.max_completion_tokens, 7);
    assert.deepEqual(capturedBody.provider, { allow_fallbacks: false, require_parameters: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ambiguous paid failures retain their durable reservation without expiry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-openrouter-ambiguous-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const config = structuredClone(defaultConfig);
    config.openRouter = { enabled: true, allowPaidFallback: true, perRunLimitUsd: 0.005, monthlyLimitUsd: 0.005 };
    config.runPolicy.allowPaidApi = true;
    const service = new OpenRouterService(ledger, {} as any);
    (service as any).status = async () => ({ connected: true, key: { limit_remaining: 10 } });
    let invoked = 0;
    await assert.rejects(() => service.withPaidRoutingAllowed(config, "same-run", 0.004, async () => {
      invoked += 1;
      throw new Error("response lost after provider acceptance");
    }), /response lost/i);
    assert.equal(invoked, 1);
    assert.equal(Number((ledger as any).database.prepare("SELECT COUNT(*) AS count FROM paid_spend_reservations").get().count), 1);
    (ledger as any).database.prepare("UPDATE paid_spend_reservations SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    await assert.rejects(() => service.withPaidRoutingAllowed(config, "same-run", 0.004, async () => { invoked += 1; }), /per-run limit would be exceeded/i);
    assert.equal(invoked, 1);
    assert.equal(ledger.getRunSpendUsd("same-run"), 0);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenRouter Workbench consultation enforces budgets and contributes to monthly spend", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-openrouter-workbench-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    await initializeProject(root);
    const config = await loadConfig(root);
    config.openRouter.enabled = true;
    config.openRouter.allowPaidFallback = true;
    config.openRouter.perRunLimitUsd = 0;
    config.openRouter.monthlyLimitUsd = 0;
    config.runPolicy.allowPaidApi = true;
    await writeFile(path.join(root, ".devharmonics", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    ledger.upsertConnection({ id: "api:openrouter", provider: "openrouter", transport: "api", authentication: "credential_reference", displayName: "OpenRouter", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "paid", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "api:openrouter:model:anthropic-claude-test";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "api:openrouter", canonicalName: "anthropic/claude-test-20260715", displayName: "Claude Test", source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { ...profileMetadata({ tier: "premium", family: "claude-test", capabilities: ["text", "analysis"], source: "catalog" }), promptPrice: 0.000001, completionPrice: 0.000002, contextLength: 2_000 } });
    ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "reviewer", passed: true, score: 1, evidence: {} });
    ledger.setModelPreference(modelId, { active: true });
    const session = ledger.createWorkbenchSession({ projectPath: root, title: "Paid consultation" });

    let invoked = false;
    const orchestrator = new Orchestrator(ledger);
    (orchestrator as any).provider = async () => ({
      connection: { id: domainId("ProviderConnection", "api:openrouter"), provider: "openrouter", displayName: "OpenRouter", transport: "api", authentication: "credential_reference", capabilities: { structuredOutput: true, streaming: false, providerManagedTools: false, modelSelection: true, modelSettings: [], permissions: ["read_only"] } },
      metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
      invoke: async (request: any) => { invoked = true; return { connectionId: "api:openrouter", provider: "openrouter", adapterVersion: "test", runtimeVersion: "test", model: { ...request.model, resolvedModelId: modelId, resolution: "concrete" }, text: "paid result", stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.25 }, toolRequests: [] }; },
    });
    const results = await (orchestrator as any).consultWorkbench({ projectPath: root, sessionId: session.id, question: "Compare approaches", discussionContext: "", modelIds: [modelId] }) as Array<{ status: string; error: string | null }>;
    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.error ?? "", /positive per-run and monthly spending limits/i);
    assert.equal(invoked, false);

    ledger.appendWorkbenchMessage({ sessionId: session.id, role: "assistant", content: "prior paid result", provider: "openrouter", connectionId: "api:openrouter", requestedModelId: modelId, resolvedModelId: modelId, status: "complete", costUsd: 1.25 });
    assert.equal((ledger as any).getWorkbenchSpendUsd?.(session.id), 1.25);
    assert.equal(ledger.getMonthlySpendUsd(), 1.25);

    const service = new OpenRouterService(ledger, {} as any);
    (service as any).status = async () => ({ connected: true, key: { limit_remaining: 0.01 } });
    config.openRouter.perRunLimitUsd = 2;
    config.openRouter.monthlyLimitUsd = 2;
    await assert.rejects(() => (service as any).assertPaidWorkbenchAllowed(config, session.id, 1), /per-run limit would be exceeded/i);

    const secondModelId = "api:openrouter:model:openai-gpt-test";
    ledger.upsertDiscoveredModel({ id: secondModelId, connectionId: "api:openrouter", canonicalName: "openai/gpt-test-20260715", displayName: "GPT Test", source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { ...profileMetadata({ tier: "premium", family: "gpt-test", capabilities: ["text", "analysis"], source: "catalog" }), promptPrice: 0.000001, completionPrice: 0.000002, contextLength: 2_000 } });
    ledger.recordModelQualification({ modelId: secondModelId, fixtureVersion: "test", role: "reviewer", passed: true, score: 1, evidence: {} });
    ledger.setModelPreference(secondModelId, { active: true });
    const aggregateSession = ledger.createWorkbenchSession({ projectPath: root, title: "Aggregate paid consultation" });
    config.openRouter.perRunLimitUsd = 0.005;
    config.openRouter.monthlyLimitUsd = 10;
    await writeFile(path.join(root, ".devharmonics", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const originalStatus = OpenRouterService.prototype.status;
    OpenRouterService.prototype.status = async () => ({ connected: true, key: { limit_remaining: 10 } });
    try {
      invoked = false;
      const aggregate = await (orchestrator as any).consultWorkbench({ projectPath: root, sessionId: aggregateSession.id, question: "Compare both paid models", discussionContext: "", modelIds: [modelId, secondModelId] }) as Array<{ status: string; error: string | null }>;
      assert.deepEqual(aggregate.map((result) => result.status), ["failed", "failed"]);
      assert.ok(aggregate.every((result) => /per-run limit would be exceeded/i.test(result.error ?? "")));
      assert.equal(invoked, false, "aggregate paid estimates must be checked before concurrent invocation fan-out");
    } finally {
      OpenRouterService.prototype.status = originalStatus;
    }
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent OpenRouter Workbench consultations cannot oversubscribe the same paid budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-openrouter-budget-race-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  let secondLedger: Ledger | null = null;
  const originalStatus = OpenRouterService.prototype.status;
  try {
    await initializeProject(root);
    const config = await loadConfig(root);
    config.openRouter.enabled = true;
    config.openRouter.allowPaidFallback = true;
    config.openRouter.perRunLimitUsd = 0.005;
    config.openRouter.monthlyLimitUsd = 0.005;
    config.runPolicy.allowPaidApi = true;
    await writeFile(path.join(root, ".devharmonics", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    ledger.upsertConnection({ id: "api:openrouter", provider: "openrouter", transport: "api", authentication: "credential_reference", displayName: "OpenRouter", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "paid", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "api:openrouter:model:concurrent-paid-test";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "api:openrouter", canonicalName: "openai/concurrent-paid-test-20260715", displayName: "Concurrent Paid Test", source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { ...profileMetadata({ tier: "premium", family: "paid-fixture", capabilities: ["text", "analysis"], source: "catalog" }), promptPrice: 0, completionPrice: 0.000002, contextLength: 2_000 } });
    ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "reviewer", passed: true, score: 1, evidence: {} });
    ledger.setModelPreference(modelId, { active: true });
    const session = ledger.createWorkbenchSession({ projectPath: root, title: "Concurrent paid consultation" });

    let activeInvocations = 0;
    let maximumConcurrentInvocations = 0;
    let invocationCount = 0;
    const provider = async () => ({
      connection: { id: domainId("ProviderConnection", "api:openrouter"), provider: "openrouter", displayName: "OpenRouter", transport: "api", authentication: "credential_reference", capabilities: { structuredOutput: true, streaming: false, providerManagedTools: false, modelSelection: true, modelSettings: [], permissions: ["read_only"] } },
      metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
      invoke: async (request: any) => {
        invocationCount += 1;
        activeInvocations += 1;
        maximumConcurrentInvocations = Math.max(maximumConcurrentInvocations, activeInvocations);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeInvocations -= 1;
        return { connectionId: "api:openrouter", provider: "openrouter", adapterVersion: "test", runtimeVersion: "test", model: { ...request.model, resolvedModelId: modelId, resolution: "concrete" }, text: "paid result", stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.004 }, toolRequests: [] };
      },
    });
    secondLedger = new Ledger(path.join(root, "devharmonics.db"));
    const firstOrchestrator = new Orchestrator(ledger);
    const secondOrchestrator = new Orchestrator(secondLedger);
    (firstOrchestrator as any).provider = provider;
    (secondOrchestrator as any).provider = provider;
    OpenRouterService.prototype.status = async () => ({ connected: true, key: { limit_remaining: 10 } });

    const persistWith = (targetLedger: Ledger) => async (consultations: Array<any>) => {
      for (const consultation of consultations) {
        targetLedger.appendWorkbenchMessage({
          sessionId: session.id,
          role: "assistant",
          content: consultation.text ?? "",
          provider: consultation.provider,
          connectionId: consultation.connectionId,
          requestedModelId: consultation.requestedModelId,
          resolvedModelId: consultation.resolvedModelId,
          status: consultation.status,
          error: consultation.error,
          inputTokens: consultation.inputTokens,
          outputTokens: consultation.outputTokens,
          costUsd: consultation.costUsd,
          durationMs: consultation.durationMs,
        });
      }
    };
    const outcomes = await Promise.all([
      (firstOrchestrator as any).consultWorkbench({ projectPath: root, sessionId: session.id, question: "Compare approaches", discussionContext: "", modelIds: [modelId], persist: persistWith(ledger) }),
      (secondOrchestrator as any).consultWorkbench({ projectPath: root, sessionId: session.id, question: "Compare approaches", discussionContext: "", modelIds: [modelId], persist: persistWith(secondLedger) }),
    ]) as Array<Array<{ status: string; error: string | null }>>;

    assert.deepEqual(outcomes.flat().map((result) => result.status).sort(), ["complete", "failed"]);
    assert.equal(invocationCount, 1);
    assert.equal(maximumConcurrentInvocations, 1);
    assert.equal(ledger.getWorkbenchSpendUsd(session.id), 0.004);
    assert.equal(ledger.getMonthlySpendUsd(), 0.004);
  } finally {
    OpenRouterService.prototype.status = originalStatus;
    secondLedger?.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workload classification gives narrow low-risk bounded implementation to the economy specialist lane", () => {
  const classification = classifyWorkload("worker", {
    id: "small-fix", title: "Small fix", description: "Patch one bounded file", dependencies: [], preferredProvider: null,
    checks: ["test"], kind: "implementation", permission: "workspace_write", risk: "low",
    repositoryScope: ["src/value.ts"], capabilityNeeds: ["code"], acceptanceCriteria: ["targeted test passes"], expectedArtifacts: ["src/value.ts"],
  });
  assert.equal(classification.complexity, "simple");
  assert.equal(classification.requiredTier, "economy");
  assert.ok(classification.factors.includes("narrow bounded implementation"));
});

test("workload classification keeps repository-wide writes out of the economy specialist lane", () => {
  const classification = classifyWorkload("worker", {
    id: "wide-fix", title: "Wide fix", description: "Change whichever repository files are needed", dependencies: [], preferredProvider: null,
    checks: ["test"], kind: "implementation", permission: "workspace_write", risk: "low",
    repositoryScope: ["."], capabilityNeeds: ["code"], acceptanceCriteria: ["tests pass"], expectedArtifacts: [],
  });
  assert.equal(classification.complexity, "standard");
  assert.equal(classification.requiredTier, "standard");
});

test("read-only task watchdogs bound simple stalls without shortening workspace-write attempts", () => {
  assert.equal(taskAttemptTimeoutMs("simple", "read_only", 30 * 60_000), 3 * 60_000);
  assert.equal(taskAttemptTimeoutMs("standard", "read_only", 30 * 60_000), 10 * 60_000);
  assert.equal(taskAttemptTimeoutMs("complex", "read_only", 30 * 60_000), 15 * 60_000);
  assert.equal(taskAttemptTimeoutMs("simple", "read_only", 90_000), 90_000);
  assert.equal(taskAttemptTimeoutMs("standard", "workspace_write", 30 * 60_000), null);
});

test("verified model profiles keep family tier separate from reasoning effort and local parameter size", () => {
  const flashLow = inferModelProfile({ canonicalName: "Gemini 3.5 Flash (Low)", displayName: "Gemini 3.5 Flash (Low)", metadata: {} });
  const flashHigh = inferModelProfile({ canonicalName: "Gemini 3.5 Flash (High)", displayName: "Gemini 3.5 Flash (High)", metadata: {} });
  assert.equal(flashLow.tier, "standard");
  assert.equal(flashHigh.tier, "standard");
  assert.equal(flashLow.reasoningEffort, "low");
  assert.equal(flashHigh.reasoningEffort, "high");
  assert.equal(flashHigh.confidence, "official");

  const local = inferModelProfile({
    canonicalName: "unknown-local:72b",
    displayName: "unknown-local:72b",
    metadata: { details: { parameter_size: "72B" }, capabilities: ["completion"] },
  }, { provider: "ollama", transport: "local" });
  assert.equal(local.tier, "economy");
  assert.equal(local.confidence, "provisional");

  const embedding = inferModelProfile({
    canonicalName: "nomic-embed-text:latest",
    displayName: "nomic-embed-text:latest",
    metadata: { capabilities: ["embedding"] },
  }, { provider: "ollama", transport: "local" });
  assert.deepEqual(embedding.capabilities, ["embedding"]);

  const claudeNames = SUBSCRIPTION_COMPATIBILITY_MODELS.filter((model) => model.provider === "claude").map((model) => model.canonicalName);
  assert.ok(claudeNames.includes("claude-fable-5"));
  assert.ok(claudeNames.includes("claude-sonnet-5"));
  assert.ok(claudeNames.includes("claude-opus-4-8"));
  assert.ok(claudeNames.includes("claude-haiku-4-5-20251001"));
  assert.equal(claudeNames.includes("haiku"), false);
});

test("adaptive router chooses Sol, Terra, and Luna equivalents by task tier and cools only the failed concrete model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-adaptive-routing-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    for (const [name, tier] of [["sol", "premium"], ["terra", "standard"], ["luna", "economy"]] as const) {
      const id = `subscription-cli:codex:model:${name}`;
      ledger.upsertDiscoveredModel({ id, connectionId: "subscription-cli:codex", canonicalName: name, displayName: name, source: "compatibility_catalog", lifecycle: "known", visible: false, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier, family: "codex", capabilities: ["text", "analysis", "code", "tools"], source: "catalog" }) });
      ledger.recordModelQualification({ modelId: id, fixtureVersion: "test", role: "general", passed: true, score: 1, evidence: {} });
      ledger.setModelPreference(id, { active: true });
    }
    const router = new ModelRouter(ledger);
    const config = structuredClone(defaultConfig);
    const base = { config, fallbackProvider: "codex" as const, allowedProviders: ["codex"] as const };
    assert.equal(router.route({ ...base, role: "architect", permission: "read_only" }).model.alias, "sol");
    const routine = { id: "routine", title: "Routine", description: "Implement", dependencies: [], preferredProvider: null, checks: ["test"], kind: "implementation" as const, permission: "workspace_write" as const, risk: "medium" as const, repositoryScope: ["."], capabilityNeeds: ["code"], acceptanceCriteria: [], expectedArtifacts: [] };
    assert.equal(router.route({ ...base, role: "worker", permission: "workspace_write", task: routine }).model.alias, "terra");
    const simple = { ...routine, id: "simple", kind: "diagnostic" as const, permission: "read_only" as const, risk: "low" as const, capabilityNeeds: ["analysis"] };
    assert.equal(router.route({ ...base, role: "worker", permission: "read_only", task: simple }).model.alias, "luna");
    ledger.recordModelOutcome("subscription-cli:codex:model:luna", { success: false, failureKind: "quota_exhausted", detail: "model allowance" });
    assert.equal(ledger.isConnectionEligible("subscription-cli:codex"), true);
    assert.equal(ledger.isModelEligible("subscription-cli:codex:model:luna"), false);
    assert.equal(router.route({ ...base, role: "worker", permission: "read_only", task: simple }).model.alias, "terra");

    ledger.upsertConnection({ id: "subscription-cli:claude", provider: "claude", transport: "subscription_cli", authentication: "subscription", displayName: "Claude", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const sonnetId = "subscription-cli:claude:model:sonnet";
    ledger.upsertDiscoveredModel({ id: sonnetId, connectionId: "subscription-cli:claude", canonicalName: "opus", displayName: "opus", source: "compatibility_catalog", lifecycle: "known", visible: false, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "premium", family: "claude", capabilities: ["text", "analysis", "code", "tools"], source: "catalog" }) });
    ledger.recordModelQualification({ modelId: sonnetId, fixtureVersion: "test", role: "general", passed: true, score: 1, evidence: {} });
    ledger.setModelPreference(sonnetId, { active: true });
    const independentReview = router.route({ ...base, role: "reviewer", allowedProviders: ["codex", "claude"], permission: "read_only", avoidProviders: ["codex"] });
    assert.equal(independentReview.provider, "claude");
    assert.ok(independentReview.scoreBreakdown.providerDiversity > 0);
    assert.ok(independentReview.factors.includes("independent provider from implementation"));

    ledger.upsertConnection({ id: "api:openrouter", provider: "openrouter", transport: "api", authentication: "credential_reference", displayName: "OpenRouter", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "paid", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    for (const [name, promptPrice, completionPrice] of [["a-expensive", 0.00001, 0.00003], ["z-cheap", 0.000001, 0.000003]] as const) {
      const id = `api:openrouter:model:${name}`;
      ledger.upsertDiscoveredModel({ id, connectionId: "api:openrouter", canonicalName: name, displayName: name, source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { ...profileMetadata({ tier: "premium", family: "paid-fixture", capabilities: ["text", "analysis"], source: "catalog" }), promptPrice, completionPrice } });
      ledger.recordModelQualification({ modelId: id, fixtureVersion: "test", role: "reviewer", passed: true, score: 1, evidence: {} });
      ledger.setModelPreference(id, { active: true });
    }
    const costAwareReview = router.route({ config, role: "reviewer", fallbackProvider: "codex", allowedProviders: ["openrouter"], permission: "read_only", excludedConnectionIds: new Set(["subscription-cli:codex"]) });
    assert.equal(costAwareReview.model.alias, "z-cheap");
    assert.ok(costAwareReview.scoreBreakdown.costAwareness > 0);
    assert.ok(costAwareReview.factors.includes("lower relative catalog price among comparable paid candidates"));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduler qualifies only the selected provider candidate at first use and then routes fairly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-first-use-qualification-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const connection = (id: string, provider: string) => ({ id, provider, transport: "subscription_cli" as const, authentication: "subscription" as const, displayName: provider, enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown" as const, capacity: "unknown" as const, adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    ledger.upsertConnection(connection("subscription-cli:codex", "codex"));
    ledger.upsertConnection(connection("subscription-cli:claude", "claude"));

    ledger.upsertDiscoveredModel({ id: "subscription-cli:codex:model:terra", connectionId: "subscription-cli:codex", canonicalName: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "standard", family: "gpt-5.6", capabilities: ["text", "analysis", "code", "tools"], source: "catalog" }) });
    ledger.recordModelQualification({ modelId: "subscription-cli:codex:model:terra", fixtureVersion: "test", role: "general", passed: true, score: 1, evidence: {}, fingerprint: "codex-current" });
    ledger.setModelPreference("subscription-cli:codex:model:terra", { active: true });

    for (const [id, canonicalName, tier] of [
      ["opus", "claude-opus-4-8", "premium"],
      ["sonnet", "claude-sonnet-5", "standard"],
      ["haiku", "claude-haiku-4-5-20251001", "economy"],
    ] as const) {
      ledger.upsertDiscoveredModel({ id: `subscription-cli:claude:model:${id}`, connectionId: "subscription-cli:claude", canonicalName, displayName: canonicalName, source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier, family: canonicalName.split("-").slice(0, 2).join("-"), capabilities: ["text", "analysis", "code", "tools"], source: "catalog" }) });
    }

    const task = { id: "routine", title: "Routine", description: "Implement a bounded change", dependencies: [], preferredProvider: "claude" as const, checks: ["test"], kind: "implementation" as const, permission: "workspace_write" as const, risk: "medium" as const, repositoryScope: ["src"], capabilityNeeds: ["code"], acceptanceCriteria: ["tests pass"], expectedArtifacts: [] };
    const config = structuredClone(defaultConfig);
    let probes = 0;
    const first = await ensureSchedulerCandidateQualified({
      ledger, config, cwd: root, role: "worker", preferredProvider: "claude", permission: "workspace_write", task,
      qualify: async ({ model, role }) => {
        probes += 1;
        return { fixtureVersion: "test-worker-v1", role, passed: true, score: 1, evidence: { requestedModelId: model.id } };
      },
    });
    assert.equal(first?.modelId, "subscription-cli:claude:model:sonnet");
    assert.equal(first?.attempted, true);
    assert.equal(first?.passed, true);
    assert.equal(ledger.getModel("subscription-cli:claude:model:sonnet")?.active, true);
    assert.equal(ledger.getModel("subscription-cli:claude:model:opus")?.qualified, false);
    assert.equal(ledger.getModel("subscription-cli:claude:model:haiku")?.qualified, false);

    const second = await ensureSchedulerCandidateQualified({
      ledger, config, cwd: root, role: "worker", preferredProvider: "claude", permission: "workspace_write", task,
      qualify: async () => { probes += 1; throw new Error("must not probe twice"); },
    });
    assert.equal(second?.attempted, false);
    assert.equal(probes, 1);

    ledger.upsertConnection({ ...connection("subscription-cli:claude", "claude"), runtimeVersion: "test-2" });
    const requalified = await ensureSchedulerCandidateQualified({
      ledger, config, cwd: root, role: "worker", preferredProvider: "claude", permission: "workspace_write", task,
      qualify: async ({ model, role }) => {
        probes += 1;
        return { fixtureVersion: "test-worker-v1", role, passed: true, score: 1, evidence: { requestedModelId: model.id, runtimeVersion: "test-2" } };
      },
    });
    assert.equal(requalified?.attempted, true);
    assert.equal(requalified?.passed, true);
    assert.equal(probes, 2);
    assert.equal(ledger.listModelQualifications("subscription-cli:claude:model:sonnet").length, 2);

    const routed = new ModelRouter(ledger).route({ role: "worker", config, fallbackProvider: "claude", allowedProviders: ["codex", "claude"], permission: "workspace_write", task });
    assert.equal(routed.provider, "claude");
    assert.equal(routed.model.alias, "claude-sonnet-5");
    assert.ok(routed.factors.includes("architect preferred provider"));
    assert.equal(Object.values(routed.scoreBreakdown).reduce((sum, value) => sum + value, 0), routed.score);
    assert.ok(routed.scoreBreakdown.tierFit > 0);
    assert.ok(routed.scoreBreakdown.preferredProvider > 0);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("architect qualification retries another model on the same provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-architect-provider-retry-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "subscription-cli:claude", provider: "claude", transport: "subscription_cli", authentication: "subscription", displayName: "Claude", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    for (const id of ["a-opus", "z-opus"] as const) {
      ledger.upsertDiscoveredModel({ id: `subscription-cli:claude:model:${id}`, connectionId: "subscription-cli:claude", canonicalName: `claude-${id}`, displayName: `Claude ${id}`, source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "premium", family: "claude-opus", capabilities: ["text", "analysis", "code", "tools"], source: "catalog" }) });
    }
    const excluded = new Set<string>();
    const attempted: string[] = [];
    const result = await ensureSchedulerProviderCandidateQualified({
      ledger,
      config: structuredClone(defaultConfig),
      cwd: root,
      role: "architect",
      preferredProvider: "claude",
      permission: "read_only",
      excludedModelIds: excluded,
      qualify: async ({ model, role }) => {
        attempted.push(model.id);
        const passed = model.id.endsWith("z-opus");
        return { fixtureVersion: "subscription-architect-v1", role, passed, score: passed ? 1 : 0, evidence: {} };
      },
    });
    assert.deepEqual(attempted, ["subscription-cli:claude:model:a-opus", "subscription-cli:claude:model:z-opus"]);
    assert.equal(result?.modelId, "subscription-cli:claude:model:z-opus");
    assert.equal(result?.passed, true);
    assert.ok(excluded.has("subscription-cli:claude:model:a-opus"));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit local reviewer assignment overrides tier fit but still requires qualification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-reviewer-first-use-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:qwen2.5:7b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "qwen2.5:7b", displayName: "qwen2.5:7b", source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: { capabilities: ["completion"], devHarmonicsProfile: { tier: "economy", family: "qwen2.5", capabilities: ["text", "analysis"], source: "runtime" } } });
    const config = structuredClone(defaultConfig);
    config.routing.reviewer.modelId = modelId;
    let selectedRole = "";
    const result = await ensureSchedulerCandidateQualified({
      ledger, config, cwd: root, role: "reviewer", preferredProvider: "codex", permission: "read_only",
      qualify: async ({ role }) => {
        selectedRole = role;
        return { fixtureVersion: "local-analysis-v1", role, passed: true, score: 1, evidence: {} };
      },
    });
    assert.equal(result?.modelId, modelId);
    assert.equal(result?.provider, "ollama");
    assert.equal(result?.passed, true);
    assert.equal(result?.activated, true);
    assert.equal(selectedRole, "analysis");
    const routed = new ModelRouter(ledger).route({ role: "reviewer", config, fallbackProvider: "codex", allowedProviders: ["ollama"], permission: "read_only" });
    assert.ok(routed.factors.includes("manual tier override: economy model assigned to premium workload"));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent results normalize structured envelopes and visibly retain malformed output", () => {
  const structured = normalizeAgentResult("worker", JSON.stringify({ summary: "done", artifacts: ["result.ts"], completionClaim: true }));
  assert.equal(structured.malformedSource, false);
  assert.deepEqual(structured.artifacts, ["result.ts"]);
  const fallback = normalizeAgentResult("reviewer", "READY with evidence");
  assert.equal(fallback.malformedSource, true);
  assert.match(fallback.summary, /READY/);
});

test("context packs enforce deterministic role budgets and retain source references", () => {
  const pack = assembleContextPack("worker", [
    { reference: "goal", priority: 100, content: "ship the feature" },
    { reference: "large-history", priority: 1, content: "x".repeat(2_000) },
  ], 1_000);
  assert.deepEqual(pack.includedReferences, ["goal"]);
  assert.deepEqual(pack.omittedReferences, ["large-history"]);
  assert.ok(pack.charCount <= pack.budgetChars);
  assert.equal(pack.sha256.length, 64);
});

test("local review splits file diffs into deterministic bounded chunks", () => {
  const chunks = chunkDiffFiles([
    { path: "small.md", diff: "one\ntwo" },
    { path: "large.md", diff: Array.from({ length: 40 }, (_, index) => `${index}: ${"x".repeat(60)}`).join("\n") },
  ], 1_000);
  assert.equal(chunks[0]?.label, "small.md");
  assert.equal(chunks.filter((chunk) => chunk.label.startsWith("large.md")).length, 3);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 1_000));
  assert.deepEqual(chunkDiffFiles([], 1_000), [{ label: "no-diff", content: "No repository diff was produced." }]);
});

test("context-only local review injects each chunk and propagates a bounded NOT READY verdict", async () => {
  const prompts: string[] = [];
  const adapter = {
    connection: {
      id: domainId("ProviderConnection", "local:ollama"),
      provider: "ollama",
      displayName: "Ollama",
      transport: "local" as const,
      authentication: "local_none" as const,
      capabilities: { structuredOutput: true, streaming: false, providerManagedTools: false, modelSelection: true, modelSettings: ["temperature", "num_ctx", "num_predict"], permissions: ["read_only" as const] },
    },
    metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
    invoke: async (request: any) => {
      prompts.push(request.prompt);
      const rejected = prompts.length === 2;
      return {
        connectionId: domainId("ProviderConnection", "local:ollama"), provider: "ollama", adapterVersion: "test", runtimeVersion: "test",
        model: { ...request.model, resolvedModelId: domainId("Model", "ollama:qwen2.5:7b"), resolution: "concrete" as const },
        text: rejected ? "READY\nPartial evidence looks valid.\nNOT READY\nA later contradiction was found." : "READY\nFirst chunk is consistent.",
        stdout: "", stderr: "", exitCode: 0, durationMs: 5, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0 }, toolRequests: [],
      };
    },
  };
  const progress: string[] = [];
  const result = await runContextOnlyReview({
    adapter,
    model: { requestedModelId: domainId("Model", "ollama:qwen2.5:7b"), alias: "qwen2.5:7b", settings: {} },
    cwd: os.tmpdir(),
    contextHeader: "Goal: preserve release truth",
    chunks: [{ label: "README.md", content: "+current v1.0.4" }, { label: "STATUS.md", content: "+current v1.0.3" }],
    evidenceLabel: "diagnostic report",
    onChunk: (receipt) => progress.push(`${receipt.label}:${receipt.verdict}`),
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /README\.md[\s\S]*current v1\.0\.4/);
  assert.match(prompts[0]!, /bounded diagnostic report 1 of 2/i);
  assert.match(prompts[1]!, /STATUS\.md[\s\S]*current v1\.0\.3/);
  assert.deepEqual(progress, ["README.md:READY", "STATUS.md:NOT READY"]);
  assert.match(result.text, /^NOT READY/);
  assert.match(result.text, /2 bounded diagnostic reports/);
  assert.equal(result.receipts[0]?.inputTokens, 10);
  assert.equal(classifyVerdict("READY\nEvidence only."), "READY");
  assert.equal(classifyVerdict("READY\nThe tasks can proceed as planned. Please approve execution."), "NOT READY");
  assert.equal(classifyVerdict("READY\nEvidence.\nNOT READY\nContradiction."), "NOT READY");
  assert.equal(classifyVerdict("Evidence without a verdict."), "NOT READY");
});

test("READY local review preserves target risks instead of claiming none exist", async () => {
  const adapter = {
    connection: { id: domainId("ProviderConnection", "local:ollama"), provider: "ollama", displayName: "Ollama", transport: "local" as const, authentication: "local_none" as const, capabilities: { structuredOutput: true, streaming: false, providerManagedTools: false, modelSelection: true, modelSettings: [], permissions: ["read_only" as const] } },
    metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
    invoke: async (request: any) => ({ connectionId: domainId("ProviderConnection", "local:ollama"), provider: "ollama", adapterVersion: "test", runtimeVersion: "test", model: { ...request.model, resolvedModelId: domainId("Model", "ollama:test"), resolution: "concrete" as const }, text: "READY\nThe report is supported, and it identifies a real release risk.", stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, toolRequests: [] }),
  };
  const result = await runContextOnlyReview({ adapter, model: { requestedModelId: null, alias: "test", settings: {} }, cwd: os.tmpdir(), contextHeader: "Audit", chunks: [{ label: "report", content: "README.md:1 documents an unresolved risk" }], evidenceLabel: "diagnostic report" });
  assert.match(result.text, /^READY/);
  assert.doesNotMatch(result.text, /Material risks: none/i);
  assert.match(result.text, /READY means the evidence package passed review/i);
});

test("context-only review retains repository-prefixed findings for the automatic fixer", async () => {
  let prompt = "";
  const adapter = {
    connection: { id: domainId("ProviderConnection", "local:ollama"), provider: "ollama", displayName: "Ollama", transport: "local" as const, authentication: "local_none" as const, capabilities: { structuredOutput: true, streaming: false, providerManagedTools: false, modelSelection: true, modelSettings: [], permissions: ["read_only" as const] } },
    metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
    invoke: async (request: any) => {
      prompt = request.prompt;
      const text = `NOT READY\nThe retained defect blocks delivery.\n\n\`\`\`json\n{"findings":[{"id":"core-defect","severity":"high","location":"repo:core/src/a.ts:7","rationale":"Unsafe bypass remains.","suggestedCorrection":"Remove the bypass.","disposition":"open"}]}\n\`\`\``;
      return { connectionId: domainId("ProviderConnection", "local:ollama"), provider: "ollama", adapterVersion: "test", runtimeVersion: "test", model: { ...request.model, resolvedModelId: domainId("Model", "ollama:test"), resolution: "concrete" as const }, text, stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, toolRequests: [] };
    },
  };
  const result = await runContextOnlyReview({ adapter, model: { requestedModelId: null, alias: "test", settings: {} }, cwd: os.tmpdir(), contextHeader: "Repositories: repo:core", chunks: [{ label: "repo:core/src/a.ts", content: "+unsafe bypass" }] });
  assert.match(prompt, /exactly one fenced JSON object/i);
  assert.match(prompt, /repository-prefixed location/i);
  const review = parseReviewerResponse(result.text, { provider: "ollama", modelId: "ollama:test", connectionId: "local:ollama" });
  const assignment = assignReviewFindings(review.findings, ["repo:core"]);
  assert.deepEqual(assignment.byRepository.get("repo:core")?.map((finding) => finding.id), ["core-defect"]);
  assert.deepEqual(assignment.unassigned, []);
});

test("context-only prose-only rejection remains visibly unassigned and fails closed", async () => {
  const adapter = {
    connection: { id: domainId("ProviderConnection", "local:ollama"), provider: "ollama", displayName: "Ollama", transport: "local" as const, authentication: "local_none" as const, capabilities: { structuredOutput: true, streaming: false, providerManagedTools: false, modelSelection: true, modelSettings: [], permissions: ["read_only" as const] } },
    metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
    invoke: async (request: any) => ({ connectionId: domainId("ProviderConnection", "local:ollama"), provider: "ollama", adapterVersion: "test", runtimeVersion: "test", model: { ...request.model, resolvedModelId: domainId("Model", "ollama:test"), resolution: "concrete" as const }, text: "NOT READY\nA defect remains, but no structured location was supplied.", stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, toolRequests: [] }),
  };
  const result = await runContextOnlyReview({ adapter, model: { requestedModelId: null, alias: "test", settings: {} }, cwd: os.tmpdir(), contextHeader: "Repositories: repo:core", chunks: [{ label: "repo:core/src/a.ts", content: "+unsafe bypass" }] });
  const review = parseReviewerResponse(result.text, { provider: "ollama", modelId: "ollama:test", connectionId: "local:ollama" });
  const assignment = assignReviewFindings(review.findings, ["repo:core"]);
  assert.equal(review.verdict, "NOT_READY");
  assert.deepEqual([...assignment.byRepository], []);
  assert.equal(assignment.unassigned.length, 1);
  assert.equal(assignment.unassigned[0]?.location, null);
});

test("tool policy allows receipted local work but gates external and unrestricted actions", () => {
  const config = structuredClone(defaultConfig);
  assert.equal(evaluateToolPolicy("git.commit", config).outcome, "allow");
  assert.equal(evaluateToolPolicy("validator:test", config).outcome, "allow");
  assert.equal(evaluateToolPolicy("github.pull_request", config).outcome, "deny");
  assert.equal(evaluateToolPolicy("shell.unrestricted", config).outcome, "deny");
  config.runPolicy.allowExternalWrites = true;
  assert.equal(evaluateToolPolicy("github.pull_request", config).outcome, "require_approval");
});

test("multi-repository review qualifies a premium candidate before adaptive routing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-reviewer-first-use-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "subscription-cli:codex:model:sol";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "subscription-cli:codex", canonicalName: "gpt-5.6", displayName: "GPT-5.6 Sol", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "premium", family: "gpt-5.6", capabilities: ["text", "analysis", "code", "tools"], source: "catalog" }) });
    ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "architect", passed: true, score: 1, evidence: {} });
    ledger.setModelPreference(modelId, { active: true });
    const config = structuredClone(defaultConfig);

    assert.throws(() => new ModelRouter(ledger).route({ role: "reviewer", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "read_only" }), /No eligible model/);
    const qualification = await ensureReviewerCandidateQualified({
      ledger,
      config,
      cwd: root,
      providers: ["codex"],
      qualify: async ({ role }) => ({ fixtureVersion: "test-reviewer-v1", role, passed: true, score: 1, evidence: {} }),
    });
    assert.equal(qualification?.modelId, modelId);
    assert.equal(qualification?.passed, true);
    const routed = new ModelRouter(ledger).route({ role: "reviewer", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "read_only" });
    assert.equal(routed.model.requestedModelId, modelId);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mellum2 local variants are distinct qualified-only specialist tracks", () => {
  const connection = { provider: "ollama", transport: "local" as const };
  const instruct = inferModelProfile({
    canonicalName: "JetBrains/mellum2-instruct-q4_k_m",
    displayName: "JetBrains/mellum2-instruct-q4_k_m",
    metadata: { capabilities: ["completion", "tools"] },
  }, connection);
  const thinking = inferModelProfile({
    canonicalName: "hf.co/JetBrains/Mellum2-12B-A2.5B-Thinking:Q4_K_M",
    displayName: "hf.co/JetBrains/Mellum2-12B-A2.5B-Thinking:Q4_K_M",
    metadata: { capabilities: ["completion", "tools", "thinking"] },
  }, connection);

  assert.equal(instruct.family, "mellum2-instruct");
  assert.equal(instruct.tier, "economy");
  assert.equal(instruct.confidence, "official");
  assert.equal(instruct.reasoningEffort, null);
  assert.ok(instruct.capabilities.includes("code"));
  assert.ok(instruct.capabilities.includes("tools"));
  assert.ok(instruct.capabilities.includes("structured-output"));
  assert.ok(instruct.capabilities.includes("routing"));
  assert.ok(instruct.evidenceUrls?.includes("https://arxiv.org/abs/2605.31268"));

  assert.equal(thinking.family, "mellum2-thinking");
  assert.equal(thinking.tier, "standard");
  assert.equal(thinking.confidence, "official");
  assert.equal(thinking.reasoningEffort, "medium");
  assert.ok(thinking.capabilities.includes("reasoning"));
  assert.notEqual(instruct.family, thinking.family, "family tracking must never promote across Mellum2 variants");
});

test("local specialist benchmark verifies structured feature fidelity instead of marker echoing", async () => {
  let observedPrompt = "";
  let specialistResponse = { valid: false, reason: "60 exceeds 40", holeCount: 4 };
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "mellum2-thinking:12b" }] }));
    if (request.url === "/api/show") return response.end(JSON.stringify({ capabilities: ["completion", "tools", "thinking"] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      observedPrompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]?.content ?? "";
      return response.end(JSON.stringify({
        message: { content: JSON.stringify(specialistResponse) },
        prompt_eval_count: 30,
        eval_count: 12,
      }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-specialist-"));
  try {
    const outcome = await qualifyRuntimeModel({
      model: {
        id: "ollama:mellum2-thinking:12b",
        connectionId: "local:ollama",
        canonicalName: "mellum2-thinking:12b",
        displayName: "Mellum2 Thinking",
        lifecycle: "visible",
        visible: true,
        verified: false,
        qualified: false,
        active: false,
        metadata: {},
        source: "runtime_discovery",
        degraded: false,
        retired: false,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastVerifiedAt: null,
        pinned: false,
        excluded: false,
        qualificationFingerprint: null,
        qualificationStale: false,
        missingObservations: 0,
        upgradePolicy: "pinned",
      },
      connection: {
        id: "local:ollama",
        provider: "ollama",
        transport: "local",
        authentication: "local_none",
        displayName: "Ollama",
        enabled: true,
        installed: true,
        authenticated: true,
        visible: true,
        healthy: true,
        available: true,
        entitlement: "local",
        capacity: "available",
        adapterVersion: "test",
        runtimeVersion: "fixture-1",
        metadata: { baseUrl },
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
      config: structuredClone(defaultConfig),
      cwd: root,
      role: "benchmark",
    });
    assert.match(observedPrompt, /40 mm bounding box/i);
    assert.match(observedPrompt, /two M4 holes per leg/i);
    assert.doesNotMatch(observedPrompt, /\{"valid":false,"reason":"60 exceeds 40","holeCount":4\}/, "the benchmark must require computation rather than expose the accepted answer");
    assert.equal(outcome.role, "benchmark");
    assert.equal(outcome.fixtureVersion, "local-specialist-v2");
    assert.equal(outcome.passed, true);
    const evidence = outcome.evidence as Readonly<Record<string, unknown>>;
    assert.equal(evidence.resolvedModelId, "ollama:mellum2-thinking:12b");
    assert.equal(typeof evidence.durationMs, "number");
    assert.equal(evidence.inputTokens, 30);
    assert.equal(evidence.outputTokens, 12);
    assert.equal(evidence.structuredOutput, true);
    assert.equal(evidence.contradictionDetected, true);
    assert.equal(evidence.featureCountMatched, true);

    specialistResponse = { valid: false, reason: "40 exceeds 60", holeCount: 4 };
    const reversed = await qualifyRuntimeModel({
      model: {
        id: "ollama:mellum2-thinking:12b", connectionId: "local:ollama", canonicalName: "mellum2-thinking:12b", displayName: "Mellum2 Thinking", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: {}, source: "runtime_discovery", degraded: false, retired: false, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), lastVerifiedAt: null, pinned: false, excluded: false, qualificationFingerprint: null, qualificationStale: false, missingObservations: 0, upgradePolicy: "pinned",
      },
      connection: {
        id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "fixture-1", metadata: { baseUrl }, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      },
      config: structuredClone(defaultConfig), cwd: root, role: "benchmark",
    });
    assert.equal(reversed.passed, false);
    assert.equal((reversed.evidence as Record<string, unknown>).contradictionDetected, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Mellum2 workspace writes require bounded tools and a current specialist benchmark", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-mellum-routing-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "ollama:JetBrains/mellum2-instruct-q4_k_m:latest";
    const name = "JetBrains/mellum2-instruct-q4_k_m:latest";
    const profile = inferModelProfile({ canonicalName: name, displayName: name, metadata: { capabilities: ["completion", "tools"] } }, { provider: "ollama", transport: "local" });
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: name, displayName: name, source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata(profile) });
    ledger.recordModelQualification({ modelId, fixtureVersion: "local-tools-v1", role: "local_tools", passed: true, score: 1, evidence: {}, fingerprint: null });
    ledger.setModelPreference(modelId, { active: true });
    const config = structuredClone(defaultConfig);
    config.routing.worker.modelId = modelId;
    config.routing.allowFallback = false;
    const task = { id: "mellum-write", title: "Small patch", description: "Patch one bounded file", dependencies: [], preferredProvider: null, checks: ["test"], kind: "implementation" as const, repositoryScope: ["src/value.ts"], permission: "workspace_write" as const, risk: "low" as const, capabilityNeeds: ["code", "structured-output"], acceptanceCriteria: ["change is correct"], expectedArtifacts: ["src/value.ts"] };

    assert.throws(() => new ModelRouter(ledger).route({ role: "worker", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "workspace_write", task }), /unqualified for the role|incompatible with workspace_write/i);

    ledger.recordModelQualification({ modelId, fixtureVersion: "local-specialist-v2", role: "benchmark", passed: true, score: 1, evidence: { structuredOutput: true, contradictionDetected: true, featureCountMatched: true }, fingerprint: null });
    const routed = new ModelRouter(ledger).route({ role: "worker", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "workspace_write", task });
    assert.equal(routed.provider, "ollama");
    assert.equal(routed.model.requestedModelId, modelId);
    assert.equal(routed.model.alias, name);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual Mellum2 assignments require a current role qualification as well as a current benchmark", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-mellum-role-fingerprint-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "ollama:mellum2-thinking:12b";
    const name = "mellum2-thinking:12b";
    const profile = inferModelProfile({ canonicalName: name, displayName: name, metadata: { capabilities: ["completion", "tools", "thinking"] } }, { provider: "ollama", transport: "local" });
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: name, displayName: name, source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata(profile) });
    ledger.recordModelQualification({ modelId, fixtureVersion: "local-analysis-v1", role: "analysis", passed: true, score: 1, evidence: {}, fingerprint: "old-fingerprint" });
    ledger.recordModelQualification({ modelId, fixtureVersion: "local-specialist-v2", role: "benchmark", passed: true, score: 1, evidence: {}, fingerprint: "current-fingerprint" });
    assert.equal(hasCurrentOperationalQualification(ledger, ledger.getModel(modelId)!), false);
    ledger.setModelPreference(modelId, { active: true });
    const config = structuredClone(defaultConfig);
    config.routing.reviewer.modelId = modelId;
    config.routing.allowFallback = false;

    assert.throws(
      () => new ModelRouter(ledger).route({ role: "reviewer", config, fallbackProvider: "codex", allowedProviders: ["ollama"], permission: "read_only" }),
      /unqualified for the role|incompatible with read_only/i,
    );

    ledger.recordModelQualification({ modelId, fixtureVersion: "local-analysis-v1", role: "analysis", passed: true, score: 1, evidence: {}, fingerprint: "current-fingerprint" });
    assert.equal(hasCurrentOperationalQualification(ledger, ledger.getModel(modelId)!), true);
    const routed = new ModelRouter(ledger).route({ role: "reviewer", config, fallbackProvider: "codex", allowedProviders: ["ollama"], permission: "read_only" });
    assert.equal(routed.model.requestedModelId, modelId);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduler qualifies Mellum2 tool use and specialist fidelity before activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-mellum-first-use-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "ollama:JetBrains/mellum2-instruct-q4_k_m:latest";
    const name = "JetBrains/mellum2-instruct-q4_k_m:latest";
    const profile = inferModelProfile({ canonicalName: name, displayName: name, metadata: { capabilities: ["completion", "tools"] } }, { provider: "ollama", transport: "local" });
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: name, displayName: name, source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata(profile) });
    const config = structuredClone(defaultConfig);
    config.routing.worker.modelId = modelId;
    const task = { id: "mellum", title: "Small fix", description: "Patch one file", dependencies: [], preferredProvider: null, checks: ["test"], kind: "implementation" as const, repositoryScope: ["src/value.ts"], permission: "workspace_write" as const, risk: "low" as const, capabilityNeeds: ["code", "structured-output"], acceptanceCriteria: ["passes"], expectedArtifacts: [] };
    const probedRoles: string[] = [];
    const result = await ensureSchedulerCandidateQualified({
      ledger, config, cwd: root, role: "worker", preferredProvider: "codex", permission: "workspace_write", task,
      qualify: async ({ role }) => {
        probedRoles.push(role);
        return { fixtureVersion: role === "benchmark" ? "local-specialist-v2" : "local-tools-v1", role, passed: true, score: 1, evidence: role === "benchmark" ? { structuredOutput: true, contradictionDetected: true, featureCountMatched: true } : { toolSequence: ["file.read", "file.patch"] } };
      },
    });
    assert.deepEqual(probedRoles, ["local_tools", "benchmark"]);
    assert.equal(result?.passed, true);
    assert.equal(result?.activated, true);
    assert.equal(ledger.listModelQualifications(modelId).some((item) => item.role === "local_tools" && item.passed), true);
    assert.equal(ledger.listModelQualifications(modelId).some((item) => item.role === "benchmark" && item.passed), true);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked local worker families qualify bounded tools before promotion", () => {
  assert.equal(trackedFamilyQualificationRole("local", "worker"), "local_tools");
  assert.equal(trackedFamilyQualificationRole("local", "reviewer"), "analysis");
  assert.equal(trackedFamilyQualificationRole("subscription_cli", "worker"), "worker");
});

test("manual local assignment cannot bypass declared task capabilities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-capability-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "ollama:not-code:latest";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "not-code:latest", displayName: "not-code:latest", source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "economy", family: "not-code", capabilities: ["text", "analysis"], source: "runtime" }) });
    ledger.recordModelQualification({ modelId, fixtureVersion: "local-tools-v1", role: "local_tools", passed: true, score: 1, evidence: {} });
    ledger.setModelPreference(modelId, { active: true });
    const config = structuredClone(defaultConfig);
    config.routing.worker.modelId = modelId;
    config.routing.allowFallback = false;
    const task = { id: "code", title: "Code", description: "Patch code", dependencies: [], preferredProvider: null, checks: ["test"], kind: "implementation" as const, repositoryScope: ["src/value.ts"], permission: "workspace_write" as const, risk: "low" as const, capabilityNeeds: ["code"], acceptanceCriteria: ["passes"], expectedArtifacts: [] };
    assert.throws(() => new ModelRouter(ledger).route({ role: "worker", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "workspace_write", task }), /unqualified for the role|incompatible with workspace_write/i);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local read-only assignments reject tool-required tasks until a read-only tool loop exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-read-tools-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "ollama:read-tools:12b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "read-tools:12b", displayName: "read-tools:12b", source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "standard", family: "read-tools", capabilities: ["text", "analysis", "tools"], source: "runtime" }) });
    ledger.recordModelQualification({ modelId, fixtureVersion: "local-analysis-v1", role: "analysis", passed: true, score: 1, evidence: {}, fingerprint: null });
    ledger.setModelPreference(modelId, { active: true });
    const config = structuredClone(defaultConfig);
    config.routing.reviewer.modelId = modelId;
    config.routing.allowFallback = false;
    const task = { id: "tool-review", title: "Inspect with tools", description: "Use repository tools to inspect one file", dependencies: [], preferredProvider: null, checks: [], kind: "review" as const, repositoryScope: ["src/value.ts"], permission: "read_only" as const, risk: "low" as const, capabilityNeeds: ["tools"], acceptanceCriteria: ["report evidence"], expectedArtifacts: [] };

    const qualification = await ensureSchedulerCandidateQualified({
      ledger, config, cwd: root, role: "reviewer", preferredProvider: "codex", permission: "read_only", task,
      qualify: async () => { throw new Error("unsupported local read-only tool tasks must not be probed"); },
    });
    assert.equal(qualification, null);
    assert.throws(() => new ModelRouter(ledger).route({ role: "reviewer", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "read_only", task }), /unqualified for the role|incompatible with read_only/i);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local write scheduling requires the dedicated bounded-tool qualification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-writer-qualification-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:qwen-writer:14b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "qwen-writer:14b", displayName: "qwen-writer:14b", source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "standard", family: "qwen-writer", capabilities: ["text", "analysis", "code"], source: "runtime" }) });
    const config = structuredClone(defaultConfig);
    config.routing.worker.modelId = modelId;
    const task = { id: "local", title: "Local patch", description: "Patch src/value.ts", dependencies: [], preferredProvider: null, checks: ["diff-check"], kind: "implementation" as const, repositoryScope: ["src"], permission: "workspace_write" as const, risk: "medium" as const, capabilityNeeds: ["code"], acceptanceCriteria: ["patch applied"], expectedArtifacts: ["src/value.ts"] };
    let selectedRole = "";
    const qualification = await ensureSchedulerCandidateQualified({
      ledger, config, cwd: root, role: "worker", preferredProvider: "codex", permission: "workspace_write", task,
      qualify: async ({ role }) => { selectedRole = role; return { fixtureVersion: "local-tools-v1", role, passed: true, score: 1, evidence: { toolSequence: ["file.read", "file.patch"] } }; },
    });
    assert.equal(selectedRole, "local_tools");
    assert.equal(qualification?.modelId, modelId);
    const routed = new ModelRouter(ledger).route({ role: "worker", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "workspace_write", task });
    assert.equal(routed.provider, "ollama");
    assert.equal(routed.model.requestedModelId, modelId);
    assert.equal(ledger.listModelQualifications(modelId).some((item) => item.role === "local_tools" && item.passed), true);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("typed tool policy enforces actor, stage, path scope, and consequential approval", async () => {
  const policy = await import("../src/policy.js") as unknown as {
    listToolDefinitions?: () => Array<Record<string, unknown>>;
    evaluateToolRequest?: (request: Record<string, unknown>, config: DevHarmonicsConfig) => {
      outcome: string;
      reason: string;
      receiptRequired: boolean;
      lockKeys: string[];
    };
  };
  assert.equal(typeof policy.listToolDefinitions, "function", "DH-440 requires a typed registry surface");
  assert.equal(typeof policy.evaluateToolRequest, "function", "DH-440 requires scoped policy evaluation");

  const definitions = policy.listToolDefinitions!();
  const patchTool = definitions.find((tool) => tool.id === "file.patch");
  assert.deepEqual(patchTool?.allowedRoles, ["worker", "coordinator"]);
  assert.deepEqual(patchTool?.allowedStages, ["implementation", "repair"]);
  assert.equal(patchTool?.secretPolicy, "forbid");
  assert.deepEqual(patchTool?.inputSchema, { type: "object", required: ["patch", "targetPaths"] });

  const config = structuredClone(defaultConfig);
  const worktree = path.resolve(os.tmpdir(), "devharmonics-policy-worktree");
  const baseRequest = {
    toolId: "file.patch",
    actorRole: "worker",
    stage: "implementation",
    taskPermission: "workspace_write",
    assignedWorktree: worktree,
    cwd: worktree,
    targetPaths: ["src/app.ts"],
    planApproved: true,
    approval: null,
  };

  const allowed = policy.evaluateToolRequest!(baseRequest, config);
  assert.equal(allowed.outcome, "allow");
  assert.equal(allowed.receiptRequired, true);
  assert.deepEqual(allowed.lockKeys, [`worktree:${worktree}`]);

  const escaped = policy.evaluateToolRequest!({ ...baseRequest, targetPaths: ["../outside.txt"] }, config);
  assert.equal(escaped.outcome, "deny");
  assert.match(escaped.reason, /outside the assigned worktree/i);

  const wrongStage = policy.evaluateToolRequest!({ ...baseRequest, toolId: "git.merge", actorRole: "coordinator" }, config);
  assert.equal(wrongStage.outcome, "deny");
  assert.match(wrongStage.reason, /not available during implementation/i);

  const externalRequest = {
    ...baseRequest,
    toolId: "github.pull_request",
    actorRole: "coordinator",
    stage: "release",
    targetPaths: [],
  };
  assert.equal(policy.evaluateToolRequest!(externalRequest, config).outcome, "deny");
  config.runPolicy.allowExternalWrites = true;
  assert.equal(policy.evaluateToolRequest!(externalRequest, config).outcome, "require_approval");
  const approved = policy.evaluateToolRequest!({
    ...externalRequest,
    approval: { id: "approval-1", kind: "external_write", approvedBy: "user", approvedAt: new Date().toISOString() },
  }, config);
  assert.equal(approved.outcome, "allow");
  assert.deepEqual(approved.lockKeys, ["external:github"]);
});

test("repository validators cannot escape their assigned worktree through cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-validator-scope-"));
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside.txt");
  await mkdir(worktree, { recursive: true });
  try {
    await assert.rejects(
      () => runValidator("escape", {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(outside)}, "mutated")`],
        cwd: "..",
        timeoutMs: 5_000,
      }, worktree),
      /outside the assigned worktree/i,
    );
    await assert.rejects(() => readFile(outside, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger retains redacted tool-policy receipts in the run evidence package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-tool-receipts-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & {
    recordToolPolicyReceipt?: (input: Record<string, unknown>) => number;
    listToolPolicyReceipts?: (runId: string) => Array<Record<string, unknown>>;
  };
  try {
    assert.equal(typeof ledger.recordToolPolicyReceipt, "function");
    assert.equal(typeof ledger.listToolPolicyReceipts, "function");
    const runId = ledger.createRun("Retain denied tool evidence", root);
    const secret = "sk-test-tool-receipt-12345678901234567890";
    const receiptId = ledger.recordToolPolicyReceipt!({
      runId,
      taskId: null,
      attemptId: null,
      toolId: "file.patch",
      actorRole: "worker",
      stage: "implementation",
      sideEffect: "workspace_write",
      outcome: "deny",
      reason: "Target is outside the assigned worktree",
      request: { targetPaths: ["../outside.txt"], payload: secret },
      lockKeys: [],
      approvalId: null,
    });
    assert.ok(receiptId > 0);

    const [receipt] = ledger.listToolPolicyReceipts!(runId);
    assert.equal(receipt?.toolId, "file.patch");
    assert.equal(receipt?.outcome, "deny");
    assert.equal(receipt?.actorRole, "worker");
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.match(JSON.stringify(receipt?.request), /\[REDACTED\]/);
    assert.ok(ledger.getRun(runId)?.events.some((event) => String(event.kind) === "tool.denied"));

    const evidence = ledger.getRunEvidence(runId) as ReturnType<Ledger["getRunEvidence"]> & {
      toolReceipts?: Array<Record<string, unknown>>;
    };
    assert.equal((evidence as unknown as { version: number } | null)?.version, 4);
    assert.equal(evidence?.toolReceipts?.length, 1);
    assert.equal(evidence?.toolReceipts?.[0]?.id, receiptId);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable Run Reporter derives verdicts only from retained evidence", async () => {
  const reporterPath = "../src/reporter.js";
  const reporterModule = await import(reporterPath).catch(() => ({})) as {
    createRunReport?: (evidence: Record<string, unknown>) => Record<string, any>;
    createRunEvidenceExport?: (evidence: Record<string, unknown>) => Record<string, any>;
  };
  assert.equal(typeof reporterModule.createRunReport, "function", "DH-450 requires a pure Run Reporter");
  assert.equal(typeof reporterModule.createRunEvidenceExport, "function", "DH-450 requires a portable deterministic evidence export");
  const runPlan = { summary: "bounded", recommendedConcurrency: 1, tasks: [] };
  const runTasks = [{ id: "one", status: "passed", checks: [{ name: "test", passed: true }] }];
  const evidenceBinding = createReviewEvidenceBinding({ autonomy: "bounded", plan: runPlan, taskReports: "retained", diff: [{ path: "result.txt", diff: "+done" }], checks: runTasks.map((task) => ({ id: task.id, checks: task.checks })), repositories: [{ repositoryId: "C:/fixture", baseCommit: "base", headCommit: "head" }] });
  const evidence = {
    version: 2,
    generatedAt: "2026-07-15T12:00:00.000Z",
    integritySha256: "a".repeat(64),
    run: {
      id: "run-ready",
      goal: "Ship the bounded change",
      status: "ready",
      finalReview: "READY\n\nAll retained gates passed.",
      plan: runPlan,
      tasks: runTasks,
      events: [],
    },
    attempts: [{ id: 1, status: "completed" }],
    blackboard: [],
    toolReceipts: [{ id: 1, outcome: "allow" }],
    reviews: [{ id: 1, verdict: "READY", integrationSha256: reviewEvidenceBindingSha256(evidenceBinding), evidenceBinding, invalidatedAt: null }],
  };
  const report = reporterModule.createRunReport!(evidence);
  assert.deepEqual(report, {
    version: 1,
    runId: "run-ready",
    verdict: "READY",
    evidenceHash: "a".repeat(64),
    summary: "All retained gates passed.",
    counts: { tasks: 1, attempts: 1, checks: 1, toolReceipts: 1, reviews: 1 },
    missingEvidence: [],
    inconsistencies: [],
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.counts), true);

  const sameEvidence = structuredClone(evidence);
  sameEvidence.generatedAt = "2026-07-16T09:00:00.000Z";
  assert.deepEqual(reporterModule.createRunReport!(sameEvidence), report, "displayed verdict must not depend on report time");
  const evidenceExport = reporterModule.createRunEvidenceExport!(evidence);
  assert.deepEqual(reporterModule.createRunEvidenceExport!(sameEvidence), evidenceExport, "portable export must not depend on report time");
  assert.equal(evidenceExport.version, 1);
  assert.equal(evidenceExport.evidenceVersion, 2);
  assert.equal(evidenceExport.integritySha256, evidence.integritySha256);
  assert.deepEqual(evidenceExport.report, report);
  assert.equal(Object.hasOwn(evidenceExport, "generatedAt"), false);
  assert.equal(Object.isFrozen(evidenceExport), true);

  const contradictory = structuredClone(evidence);
  contradictory.run.status = "not_ready";
  const contradictedReport = reporterModule.createRunReport!(contradictory);
  assert.equal(contradictedReport.verdict, "NOT_READY");
  assert.match(contradictedReport.inconsistencies.join(" "), /READY review conflicts with run status not_ready/i);

  const incomplete = structuredClone(evidence);
  incomplete.run.status = "running";
  incomplete.run.finalReview = null as unknown as string;
  incomplete.attempts = [];
  const incompleteReport = reporterModule.createRunReport!(incomplete);
  assert.equal(incompleteReport.verdict, "INCONCLUSIVE");
  assert.ok(incompleteReport.missingEvidence.includes("final review"));
  assert.ok(incompleteReport.missingEvidence.includes("attempt receipts"));

  const mismatchedIntegration = structuredClone(evidence) as typeof evidence & { integrationSet: Record<string, unknown> };
  mismatchedIntegration.integrationSet = { status: "ready", repositories: [{ repositoryId: "C:/fixture", baseCommit: "base", headCommit: "different-head" }] };
  const mismatchedReport = reporterModule.createRunReport!(mismatchedIntegration);
  assert.equal(mismatchedReport.verdict, "INCONCLUSIVE");
  assert.match(mismatchedReport.inconsistencies.join(" "), /different repository integration set/i);
});

test("risk-based review quorum fails closed on weak independence and open findings", async () => {
  const reviewPath = "../src/review.js";
  const reviewModule = await import(reviewPath).catch(() => ({})) as Record<string, any>;
  assert.equal(typeof reviewModule.reviewRequirement, "function", "DH-460 requires risk-derived quorum policy");
  assert.equal(typeof reviewModule.parseReviewerResponse, "function", "DH-460 requires structured reviewer findings");
  assert.equal(typeof reviewModule.adjudicateReviewQuorum, "function", "DH-460 requires deterministic quorum adjudication");

  const requirement = reviewModule.reviewRequirement(
    [{ id: "low", risk: "low" }, { id: "critical", risk: "high" }],
    defaultConfig.reviewPolicy,
  );
  assert.deepEqual(requirement, { risk: "high", requiredReviewers: 2, minimumDistinctProviders: 2, requireImplementorIndependence: true });

  const ready = reviewModule.parseReviewerResponse("READY\nNo material findings.", { provider: "claude", modelId: "sonnet", connectionId: "claude" });
  assert.equal(ready.verdict, "READY");
  assert.deepEqual(ready.findings, []);
  const notReady = reviewModule.parseReviewerResponse(`NOT READY\n\n\`\`\`json\n{"findings":[{"severity":"high","location":"src/a.ts:7","rationale":"Unsafe bypass remains.","suggestedCorrection":"Remove the bypass.","disposition":"open"}]}\n\`\`\``, { provider: "codex", modelId: "terra", connectionId: "codex" });
  assert.equal(notReady.verdict, "NOT_READY");
  assert.equal(notReady.findings[0].location, "src/a.ts:7");

  const passing = reviewModule.adjudicateReviewQuorum({
    requirement,
    implementationProviders: ["codex"],
    reviews: [ready, { ...ready, provider: "gemini", modelId: "gemini-pro", connectionId: "gemini" }],
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.distinctProviders, 2);

  const sameProvider = reviewModule.adjudicateReviewQuorum({ requirement, implementationProviders: ["codex"], reviews: [ready, { ...ready, modelId: "opus" }] });
  assert.equal(sameProvider.passed, false);
  assert.match(sameProvider.reasons.join(" "), /distinct reviewer providers/i);

  const rejected = reviewModule.adjudicateReviewQuorum({ requirement, implementationProviders: ["codex"], reviews: [ready, notReady] });
  assert.equal(rejected.passed, false);
  assert.equal(rejected.openFindings.length, 1);
  assert.match(rejected.reasons.join(" "), /open reviewer finding/i);
});

test("multi-repository review findings are assigned only by an exact repository path prefix", () => {
  const scoped = { id: "core-defect", severity: "high" as const, location: "repo:core\\src\\service.ts:7", rationale: "Defect remains.", suggestedCorrection: "Repair it.", disposition: "open" as const };
  const unscoped = { ...scoped, id: "unknown-defect", location: "src/service.ts:7" };
  const assignment = assignReviewFindings([scoped, unscoped], ["repo:core", "repo:docs"]);
  assert.deepEqual(assignment.byRepository.get("repo:core")?.map((finding) => finding.id), ["core-defect"]);
  assert.deepEqual(assignment.unassigned.map((finding) => finding.id), ["unknown-defect"]);
});

test("ledger retains structured reviews and invalidates them when fixer evidence changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-review-ledger-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & Record<string, any>;
  try {
    const runId = ledger.createRun("Repair and re-review", root);
    const evidenceBinding = createReviewEvidenceBinding({ autonomy: "bounded", plan: { summary: "repair", recommendedConcurrency: 1, tasks: [] }, taskReports: "", diff: [], checks: [], repositories: [{ repositoryId: root, baseCommit: "base", headCommit: "head" }] });
    const reviewId = ledger.recordReviewReceipt({
      runId,
      round: 1,
      integrationSha256: reviewEvidenceBindingSha256(evidenceBinding),
      evidenceBinding,
      review: {
        verdict: "NOT_READY",
        provider: "claude",
        modelId: "sonnet",
        connectionId: "subscription-cli:claude",
        summary: "A blocking defect remains.",
        rawText: "NOT READY",
        findings: [{ id: "unsafe", severity: "high", location: "src/a.ts:7", rationale: "Unsafe bypass remains.", suggestedCorrection: "Remove it.", disposition: "open" }],
      },
    });
    assert.equal(typeof reviewId, "number");
    let reviews = ledger.listReviewReceipts(runId);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.findings[0]!.location, "src/a.ts:7");
    assert.equal(reviews[0]!.invalidatedAt, null);
    assert.equal(ledger.invalidateReviewReceipts(runId, "Fixer changed the integration evidence"), 1);
    reviews = ledger.listReviewReceipts(runId);
    assert.ok(reviews[0]!.invalidatedAt);
    assert.match(reviews[0]!.invalidationReason!, /fixer changed/i);
    const evidence = ledger.getRunEvidence(runId) as Record<string, any>;
    assert.equal(evidence.version, 4);
    assert.equal(evidence.reviews[0].id, reviewId);
    assert.ok(evidence.reviews[0].invalidatedAt);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("verification-integrity gate fails closed on test weakening and reports bounded evidence", async () => {
  const integrityPath = "../src/verification-integrity.js";
  const integrityModule = await import(integrityPath).catch(() => ({})) as Record<string, any>;
  assert.equal(typeof integrityModule.analyzeVerificationIntegrity, "function", "DH-470 requires a deterministic verification-integrity gate");
  const result = integrityModule.analyzeVerificationIntegrity([
    { path: "test/auth.test.ts", diff: "diff --git a/test/auth.test.ts b/test/auth.test.ts\n@@ -1,4 +1,5 @@\n-test(\"denies invalid token\", () => {\n-  assert.equal(authorize(\"bad\"), false);\n+test.skip(\"denies invalid token\", () => {\n+  assert.ok(true);\n });" },
    { path: "package.json", diff: "@@ -4,1 +4,1 @@\n-\"test\": \"node --test\"\n+\"test\": \"node --test || true\"" },
  ]);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((finding: any) => finding.kind === "test-skipped" && finding.path === "test/auth.test.ts"));
  assert.ok(result.findings.some((finding: any) => finding.kind === "assertion-weakened"));
  assert.ok(result.findings.some((finding: any) => finding.kind === "unconditional-success" && finding.path === "package.json"));
  assert.ok(result.summary.includes("3"));

  const legitimate = integrityModule.analyzeVerificationIntegrity([
    { path: "src/auth.ts", diff: "@@ -1 +1 @@\n-return false;\n+return token === expected;" },
    { path: "test/auth.test.ts", diff: "@@ -1 +1,2 @@\n assert.equal(authorize(\"bad\"), false);\n+assert.equal(authorize(expected), true);" },
  ]);
  assert.equal(legitimate.passed, true);
  assert.deepEqual(legitimate.findings, []);
  assert.deepEqual(legitimate.census, { changedTestFiles: 1, deletedTestFiles: 0, addedSkips: 0, removedAssertions: 0, addedAssertions: 1 });
});

test("local model tool loop executes only bounded typed file tools", async () => {
  const localToolsPath = "../src/local-tools.js";
  const localTools = await import(localToolsPath).catch(() => ({})) as Record<string, any>;
  assert.equal(typeof localTools.runLocalToolLoop, "function", "DH-510 requires an orchestrator-managed local tool loop");
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-tools-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "value.txt"), "before\n", "utf8");
    let call = 0;
    const adapter = {
      connection: { id: "local:test", provider: "ollama" },
      metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
      invoke: async () => {
        call++;
        const text = call === 1
          ? JSON.stringify({ toolRequests: [{ id: "read-1", toolId: "file.read", arguments: { path: "src/value.txt" } }] })
          : call === 2
            ? JSON.stringify({ toolRequests: [{ id: "patch-1", toolId: "file.patch", arguments: { path: "src/value.txt", expectedSha256: createHash("sha256").update("before\n").digest("hex"), content: "after\n" } }] })
            : JSON.stringify({ final: "Updated src/value.txt with the approved bounded patch." });
        return { connectionId: "local:test", provider: "ollama", adapterVersion: "test", runtimeVersion: "test", model: { requestedModelId: "ollama:test", alias: "test", settings: {}, resolvedModelId: "ollama:test", resolution: "concrete" }, text, stdout: text, stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, toolRequests: [] };
      },
    };
    const authorized: string[] = [];
    const result = await localTools.runLocalToolLoop({
      adapter,
      request: { role: "worker", prompt: "Update the bounded file", cwd: root, permission: "workspace_write", timeoutMs: 10_000, model: { requestedModelId: "ollama:test", alias: "test", settings: {} } },
      worktreePath: root,
      repositoryScope: ["src"],
      authorize: (request: any) => { authorized.push(request.toolId); return { outcome: "allow", reason: "fixture", lockKeys: request.targetPaths }; },
    });
    assert.equal(result.text, "Updated src/value.txt with the approved bounded patch.");
    assert.deepEqual(authorized, ["file.read", "file.patch"]);
    assert.equal(await readFile(path.join(root, "src", "value.txt"), "utf8"), "after\n");
    assert.equal(result.toolExecutions.length, 2);

    const escapingAdapter = { ...adapter, invoke: async () => ({ ...(await adapter.invoke()), text: JSON.stringify({ toolRequests: [{ id: "escape", toolId: "file.read", arguments: { path: "../outside.txt" } }] }) }) };
    await assert.rejects(() => localTools.runLocalToolLoop({ adapter: escapingAdapter, request: { role: "worker", prompt: "escape", cwd: root, permission: "workspace_write", timeoutMs: 10_000, model: { requestedModelId: "ollama:test", alias: "test", settings: {} } }, worktreePath: root, repositoryScope: ["src"], authorize: () => ({ outcome: "allow", reason: "fixture", lockKeys: [] }) }), /outside the assigned worktree|outside repository scope/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration v1 migrates atomically into separated v2 scopes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-config-migration-"));
  try {
    await initializeProject(root);
    const destination = path.join(root, ".devharmonics", "config.json");
    const legacy = {
      version: 1,
      architect: "gemini",
      reviewer: "claude",
      workers: ["codex", "gemini"],
      concurrency: { mode: "manual", agents: 13, ceiling: null },
      retry: { maxAttempts: 4, backoffMs: 250 },
      providers: {
        codex: { enabled: true, command: "codex-custom", timeoutMs: 1_000 },
        claude: { enabled: false, command: "claude", timeoutMs: 2_000 },
        gemini: { enabled: true, command: "agy", timeoutMs: 3_000 },
      },
      validators: {
        test: { command: "npm", args: ["test"], timeoutMs: 4_000 },
      },
    };
    await writeFile(destination, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const migrated = await loadConfig(root);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.product.architect, "gemini");
    assert.equal(migrated.application.concurrency.agents, 13);
    assert.equal(migrated.connections.codex.command, "codex-custom");
    assert.deepEqual(migrated.repository.validators.test?.args, ["test"]);
    assert.equal(migrated.runPolicy.allowPaidApi, false);
    assert.deepEqual(JSON.parse(await readFile(`${destination}.v1.backup`, "utf8")), legacy);
    assert.equal(JSON.parse(await readFile(destination, "utf8")).version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual model schema prevents unsupported lifecycle claims", () => {
  const parsed = manualModelSchema.safeParse({
    id: "manual:model",
    connectionId: "subscription-cli:codex",
    canonicalName: "model",
    displayName: "Model",
    lifecycle: "active",
    visible: true,
    verified: true,
    qualified: false,
    active: true,
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.message, /active model must also be qualified/i);
});

test("Ollama discovery registers installed models and supports read-only inference", async () => {
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "qwen-fixture:7b", size: 42, digest: "abc" }] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal((JSON.parse(body) as { model: string }).model, "qwen-fixture:7b");
      return response.end(JSON.stringify({ message: { content: "local result" }, prompt_eval_count: 7, eval_count: 3 }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ollama-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const discovery = await discoverOllama(baseUrl);
    assert.equal(discovery.version, "fixture-1");
    await syncOllamaRegistry(ledger, baseUrl);
    assert.equal(ledger.listConnections().find((connection) => connection.id === "local:ollama")?.available, true);
    assert.equal(ledger.listModels("local:ollama")[0]?.id, "ollama:qwen-fixture:7b");
    await syncOllamaRuntimes(ledger, [
      { id: "system", displayName: "System Ollama", baseUrl, enabled: true },
      { id: "civicsuite", displayName: "CivicSuite Ollama", baseUrl, enabled: true },
    ]);
    assert.equal(ledger.listConnections().find((connection) => connection.id === "local:ollama:civicsuite")?.available, true);
    assert.equal(ledger.listModels("local:ollama:civicsuite")[0]?.id, "ollama:civicsuite:qwen-fixture:7b");
    const adapter = new OllamaAdapter(baseUrl);
    const result = await adapter.invoke({
      role: "worker",
      prompt: "Analyze without writing",
      cwd: root,
      permission: "read_only",
      timeoutMs: 5_000,
      model: { requestedModelId: domainId("Model", "ollama:qwen-fixture:7b"), alias: null, settings: {} },
    });
    assert.equal(result.text, "local result");
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, costUsd: 0 });
    const qualification = ledger.recordModelQualification({ modelId: "ollama:qwen-fixture:7b", fixtureVersion: "fixture-v1", role: "architect", passed: true, score: 1, evidence: { durationMs: result.durationMs } });
    assert.equal(qualification.passed, true);
    assert.equal(ledger.getModel("ollama:qwen-fixture:7b")?.qualified, true);
    const routingConfig = structuredClone(defaultConfig);
    routingConfig.routing.architect.modelId = "ollama:qwen-fixture:7b";
    const routed = new ModelRouter(ledger).route({ role: "architect", config: routingConfig, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "read_only" });
    assert.equal(routed.provider, "ollama");
    assert.equal(routed.model.alias, "qwen-fixture:7b");
    routingConfig.routing.worker.modelId = "ollama:qwen-fixture:7b";
    routingConfig.routing.allowFallback = false;
    assert.throws(() => new ModelRouter(ledger).route({ role: "worker", config: routingConfig, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "workspace_write" }), /incompatible with workspace_write/);
    assert.equal(ledger.setModelPreference("ollama:qwen-fixture:7b", { pinned: true, active: true }).active, true);
    const excluded = ledger.setModelPreference("ollama:qwen-fixture:7b", { excluded: true });
    assert.equal(excluded.excluded, true);
    assert.equal(excluded.active, false);
    const cooling = ledger.recordConnectionOutcome("local:ollama", { success: false, failureKind: "quota_exhausted", detail: "fixture quota" });
    assert.equal(cooling.state, "quota_exhausted");
    assert.ok(cooling.cooldownUntil);
    assert.equal(ledger.isConnectionEligible("local:ollama"), false);
    assert.equal(ledger.recordConnectionOutcome("local:ollama", { success: true }).state, "ready");
    assert.equal(ledger.isConnectionEligible("local:ollama"), true);
  } finally {
    ledger.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("subscription CLI runtime adapter emits normalized receipts and events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-runtime-"));
  try {
    const script = path.join(root, "runtime-fixture.mjs");
    await writeFile(
      script,
      `let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"runtime result: " + input.trim()}}));
`,
      "utf8",
    );
    const command = process.platform === "win32"
      ? path.join(root, "runtime-fixture.cmd")
      : path.join(root, "runtime-fixture.sh");
    if (process.platform === "win32") {
      await writeFile(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    } else {
      await writeFile(command, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, "utf8");
      await chmod(command, 0o755);
    }

    const adapter = createProvider("codex", { enabled: true, command, timeoutMs: 10_000 });
    const events: InvocationEvent[] = [];
    const result = await adapter.invoke(
      {
        role: "worker",
        prompt: "hello",
        cwd: root,
        permission: "workspace_write",
        timeoutMs: null,
        model: { requestedModelId: null, alias: null, settings: {} },
      },
      { onEvent: (event) => events.push(event) },
    );
    assert.equal(adapter.connection.id, "subscription-cli:codex");
    assert.equal(adapter.connection.transport, "subscription_cli");
    assert.equal(adapter.connection.authentication, "subscription");
    assert.deepEqual(adapter.connection.cli, {
      command,
      outputFormat: "json_lines",
      promptTransport: "stdin",
    });
    assert.equal(adapter.connection.capabilities.modelSelection, true);
    assert.deepEqual(adapter.connection.capabilities.modelSettings, ["effort"]);
    assert.deepEqual(adapter.connection.capabilities.permissions, ["read_only", "workspace_write"]);
    assert.equal(result.text, "runtime result: hello");
    assert.equal(result.model.resolvedModelId, "provider-default:codex");
    assert.equal(result.model.resolution, "provider_default_unresolved");
    assert.deepEqual(result.model.settings, {});
    assert.deepEqual(events.map((event) => event.type), ["started", "stdout", "completed"]);
    assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, costUsd: null });

    const selected = await adapter.invoke({
        role: "worker",
        prompt: "hello",
        cwd: root,
        permission: "workspace_write",
        timeoutMs: null,
        model: {
          requestedModelId: domainId("Model", "codex:explicit"),
          alias: "fixture-model",
          settings: { effort: "high" },
        },
      });
    assert.equal(selected.model.requestedModelId, "codex:explicit");
    assert.equal(selected.model.alias, "fixture-model");
    assert.equal(selected.model.resolvedModelId, "codex:explicit");
    assert.equal(selected.model.resolution, "concrete");

    await writeFile(script, 'console.log("not a Codex event");\n', "utf8");
    const parseEvents: InvocationEvent[] = [];
    await assert.rejects(
      () => adapter.invoke(
        {
          role: "worker",
          prompt: "hello",
          cwd: root,
          permission: "workspace_write",
          timeoutMs: null,
          model: { requestedModelId: null, alias: null, settings: {} },
        },
        { onEvent: (event) => parseEvents.push(event) },
      ),
      (error: unknown) =>
        error instanceof RuntimeInvocationError && error.kind === "incompatible",
    );
    assert.deepEqual(parseEvents.map((event) => event.type), ["started", "stdout", "failed"]);

    const missingAdapter = createProvider("codex", {
      enabled: true,
      command: path.join(root, "missing-runtime-command"),
      timeoutMs: 1_000,
    });
    await assert.rejects(
      () => missingAdapter.invoke({
        role: "worker",
        prompt: "hello",
        cwd: root,
        permission: "workspace_write",
        timeoutMs: null,
        model: { requestedModelId: null, alias: null, settings: {} },
      }),
      (error: unknown) =>
        error instanceof RuntimeInvocationError && error.kind === "process_failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini starts a fresh sandboxed project rooted at the isolated worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-gemini-workspace-"));
  try {
    const script = path.join(root, "gemini-fixture.mjs");
    await writeFile(script, 'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n', "utf8");
    const command = process.platform === "win32"
      ? path.join(root, "gemini-fixture.cmd")
      : path.join(root, "gemini-fixture.sh");
    if (process.platform === "win32") {
      await writeFile(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    } else {
      await writeFile(command, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, "utf8");
      await chmod(command, 0o755);
    }

    const adapter = createProvider("gemini", { enabled: true, command, timeoutMs: 10_000 });
    const result = await adapter.invoke({
      role: "worker",
      prompt: "probe",
      cwd: root,
      permission: "read_only",
      timeoutMs: null,
      model: { requestedModelId: null, alias: null, settings: {} },
    });
    const invocation = JSON.parse(result.text) as { argv: string[]; cwd: string };
    assert.equal(path.resolve(invocation.cwd), path.resolve(root));
    assert.deepEqual(invocation.argv.slice(0, 5), ["--new-project", "--add-dir", root, "--sandbox", "--mode"]);
    assert.equal(invocation.argv[5], "plan");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("primary checkout guard reports out-of-worktree mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-primary-guard-"));
  try {
    await runProcess({ command: "git", args: ["init"], cwd: root, timeoutMs: 30_000 });
    await writeFile(path.join(root, "tracked.txt"), "baseline\n", "utf8");
    await runProcess({ command: "git", args: ["add", "tracked.txt"], cwd: root, timeoutMs: 30_000 });
    await runProcess({ command: "git", args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline"], cwd: root, timeoutMs: 30_000 });
    const manager = new WorktreeManager(root, "guard-fixture");
    await manager.assertPrimaryClean("before fixture");
    await writeFile(path.join(root, "tracked.txt"), "mutated outside task worktree\n", "utf8");
    await assert.rejects(
      () => manager.assertPrimaryClean("after fixture"),
      (error: unknown) => error instanceof WorkspaceIsolationError && error.status.includes("tracked.txt"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime failure classification distinguishes fallback-relevant causes", () => {
  assert.deepEqual(
    classifyInvocationFailure({ detail: "weekly usage limit reached", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "quota_exhausted", retryable: true },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "429 too many requests", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "rate_limited", retryable: true },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "sign-in required", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "authentication", retryable: false },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "terminated", exitCode: 124, timedOut: true, aborted: true }),
    { kind: "cancelled", retryable: false },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "unknown option --future", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "incompatible", retryable: false },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "maximum context length exceeded", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "context_overflow", retryable: true },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "model allowance exhausted", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "model_quota_exhausted", retryable: true },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "CUDA out of memory", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "resource_exhausted", retryable: true },
  );
  assert.deepEqual(
    classifyInvocationFailure({ detail: "Individual quota reached. Resets in 4h35m32s.", exitCode: 1, timedOut: false, aborted: false }),
    { kind: "quota_group_exhausted", retryable: true },
  );
  assert.equal(quotaResetAt("Individual quota reached. Resets in 4h35m32s.", new Date("2026-07-15T12:00:00.000Z")), "2026-07-15T16:35:32.000Z");
  assert.equal(invocationFailureScope("model_quota_exhausted", true), "model");
  assert.equal(invocationFailureScope("context_overflow", true), "model");
  assert.equal(invocationFailureScope("quota_exhausted", true), "connection");
  assert.equal(invocationFailureScope("quota_group_exhausted", true), "quota_group");
  assert.equal(invocationFailureScope("authentication", true), "connection");
  assert.equal(invocationFailureScope("cancelled", true), "task");
});

test("domain identities, lifecycle transitions, and legacy provider projections are stable", () => {
  assert.equal(domainId("Run", "run-123"), "run-123");
  assert.throws(() => domainId("Run", "  "), /cannot be empty/i);
  assert.doesNotThrow(() => assertRunTransition("planning", "running"));
  assert.throws(() => assertRunTransition("ready", "running"), /invalid run status transition/i);
  assert.doesNotThrow(() => assertTaskTransition("retry", "working"));
  assert.throws(() => assertTaskTransition("passed", "working"), /invalid task status transition/i);
  assert.deepEqual(projectLegacyProvider("claude"), {
    provider: "claude",
    connectionId: "subscription-cli:claude",
    modelId: "provider-default:claude",
    transport: "subscription_cli",
    authentication: "subscription",
    modelResolution: "provider_default_unresolved",
  });
});

test("redaction recognizes credential formats while preserving diagnostic context", () => {
  const fixtures = [
    ["OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst", "sk-proj-abcdefghijklmnopqrst"],
    ["Authorization: Bearer bearer-token-value-12345", "bearer-token-value-12345"],
    ['{"password":"correct-horse-battery-staple"}', "correct-horse-battery-staple"],
    ["Google key AIzaabcdefghijklmnopqrstuvwxyz123456", "AIzaabcdefghijklmnopqrstuvwxyz123456"],
    ["OAuth code 4/abcdefghijklmnopqrstuvwxyz123456", "4/abcdefghijklmnopqrstuvwxyz123456"],
    ["GitHub github_pat_abcdefghijklmnopqrstuvwxyz123456", "github_pat_abcdefghijklmnopqrstuvwxyz123456"],
  ] as const;
  for (const [source, secret] of fixtures) {
    const redacted = redactText(`prefix ${source} suffix`);
    assert.equal(redacted.includes(secret), false, redacted);
    assert.match(redacted, /prefix/);
    assert.match(redacted, /suffix/);
    assert.match(redacted, /\[REDACTED\]/);
  }
});

test("redaction property coverage removes generated tokens in varied diagnostic text", () => {
  const wrappers = [
    (secret: string) => `failure token=${secret} while invoking provider`,
    (secret: string) => `Authorization: Bearer ${secret}\nrequest rejected`,
    (secret: string) => JSON.stringify({ nested: { access_token: secret }, status: 401 }),
    (secret: string) => `OPENROUTER_API_KEY='${secret}' command failed`,
  ];
  for (let index = 0; index < 128; index++) {
    const secret = `sk-proj-${index.toString(36).padStart(4, "0")}${"x".repeat(24)}`;
    const source = wrappers[index % wrappers.length]!(secret);
    const redacted = redactText(source);
    assert.equal(redacted.includes(secret), false, redacted);
    assert.match(redacted, /\[REDACTED\]/);
  }
});

test("ledger initializes a versioned schema without backing up a new database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ledger-new-"));
  const filename = path.join(root, "devharmonics.db");
  const ledger = new Ledger(filename);
  try {
    assert.equal(ledger.getSchemaVersion(), LEDGER_SCHEMA_VERSION);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".backup-")),
      [],
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger upgrades a v0.1 database transactionally and preserves a pre-migration backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ledger-upgrade-"));
  const filename = path.join(root, "devharmonics.db");
  const original = new Ledger(filename);
  const runId = original.createRun("Preserve this run", root);
  original.close();

  const legacy = new DatabaseSync(filename);
  legacy.exec("DROP TABLE IF EXISTS schema_migrations; PRAGMA user_version = 0;");
  legacy.close();

  const upgraded = new Ledger(filename);
  try {
    assert.equal(upgraded.getSchemaVersion(), LEDGER_SCHEMA_VERSION);
    assert.equal(upgraded.getRun(runId)?.goal, "Preserve this run");

    const upgradedDatabase = new DatabaseSync(filename);
    try {
      assert.deepEqual(
        upgradedDatabase
          .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => ({ ...(row as Record<string, unknown>) })),
        [
          { version: 1, name: "baseline-v0.1-schema" },
          { version: 2, name: "typed-event-payloads" },
          { version: 3, name: "attempt-runtime-receipts" },
          { version: 4, name: "connection-and-model-registry" },
          { version: 5, name: "durable-run-recovery-links" },
          { version: 6, name: "model-qualification-and-preferences" },
          { version: 7, name: "connection-health-and-cooldowns" },
          { version: 8, name: "blackboard-and-result-envelopes" },
          { version: 9, name: "product-and-repository-registry" },
          { version: 10, name: "durable-task-contracts" },
          { version: 11, name: "model-health-and-cooldowns" },
          { version: 12, name: "catalog-freshness-qualification-fingerprints-and-costs" },
          { version: 13, name: "durable-run-autonomy" },
          { version: 14, name: "model-performance-observation-policy" },
          { version: 15, name: "reviewer-invocation-performance" },
          { version: 16, name: "typed-tool-policy-receipts" },
          { version: 17, name: "structured-review-quorums" },
          { version: 18, name: "durable-objectives-and-plan-revisions" },
          { version: 19, name: "read-only-workbench-consultations" },
          { version: 20, name: "local-repository-configuration-and-inspection" },
          { version: 21, name: "multi-repository-integration-sets" },
          { version: 22, name: "source-backed-product-intelligence" },
          { version: 23, name: "provider-quota-groups-and-honest-model-resolution" },
          { version: 24, name: "review-evidence-bindings" },
          { version: 25, name: "atomic-paid-spend-reservations" },
        ],
      );
    } finally {
      upgradedDatabase.close();
    }

    const backups = (await readdir(root)).filter((name) =>
      name.startsWith(`devharmonics.db.backup-v0-to-v${LEDGER_SCHEMA_VERSION}-`),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(root, backups[0]!));
    try {
      assert.equal((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
      assert.equal(
        (backup.prepare("SELECT goal FROM runs WHERE id = ?").get(runId) as { goal: string }).goal,
        "Preserve this run",
      );
    } finally {
      backup.close();
    }
  } finally {
    upgraded.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger upgrades typed-event schema to runtime attempt receipts without losing attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ledger-v2-upgrade-"));
  const filename = path.join(root, "devharmonics.db");
  const original = new Ledger(filename);
  const runId = original.createRun("Preserve the attempt", root);
  original.savePlan(runId, {
    summary: "One task",
    recommendedConcurrency: 1,
    tasks: [{
      id: "one",
      title: "One",
      description: "Do it",
      dependencies: [],
      preferredProvider: "codex",
      checks: [],
    }],
  });
  const attemptId = original.startAttempt(runId, "one", "codex", "historical prompt");
  original.finishAttempt(attemptId, "completed", "historical output");
  original.close();

  const legacy = new DatabaseSync(filename);
  for (const column of [
    "failure_kind",
    "runtime_version",
    "adapter_version",
    "model_settings_json",
    "model_resolution",
    "model_id",
    "connection_id",
  ]) {
    legacy.exec(`ALTER TABLE attempts DROP COLUMN ${column};`);
  }
  legacy.exec("DROP TABLE models; DROP TABLE provider_connections; DELETE FROM schema_migrations WHERE version > 2; PRAGMA user_version = 2;");
  legacy.close();

  const upgraded = new Ledger(filename);
  try {
    assert.equal(upgraded.getSchemaVersion(), LEDGER_SCHEMA_VERSION);
    const database = new DatabaseSync(filename);
    try {
      const attempt = database
        .prepare("SELECT prompt, output, model_settings_json, connection_id FROM attempts WHERE id = ?")
        .get(attemptId) as Record<string, unknown>;
      assert.deepEqual({ ...attempt }, {
        prompt: "historical prompt",
        output: "historical output",
        model_settings_json: "{}",
        connection_id: null,
      });
    } finally {
      database.close();
    }
    const backups = (await readdir(root)).filter((name) =>
      name.startsWith(`devharmonics.db.backup-v2-to-v${LEDGER_SCHEMA_VERSION}-`),
    );
    assert.equal(backups.length, 1);
  } finally {
    upgraded.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger rolls back a failed migration and leaves a usable pre-migration backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ledger-rollback-"));
  const filename = path.join(root, "devharmonics.db");
  const malformed = new DatabaseSync(filename);
  malformed.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 0;");
  malformed.close();

  try {
    assert.throws(
      () => new Ledger(filename),
      new RegExp(`migration from version 0 to ${LEDGER_SCHEMA_VERSION} failed.*table 'runs' is missing columns`, "i"),
    );

    const original = new DatabaseSync(filename);
    try {
      assert.equal((original.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
      assert.deepEqual(
        original
          .prepare("SELECT name FROM pragma_table_info('runs')")
          .all()
          .map((row) => ({ ...(row as Record<string, unknown>) })),
        [{ name: "id" }],
      );
      assert.equal(
        (original
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
          .get() as { count: number }).count,
        0,
      );
    } finally {
      original.close();
    }

    const backups = (await readdir(root)).filter((name) =>
      name.startsWith(`devharmonics.db.backup-v0-to-v${LEDGER_SCHEMA_VERSION}-`),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(root, backups[0]!));
    try {
      assert.deepEqual(
        backup
          .prepare("SELECT name FROM pragma_table_info('runs')")
          .all()
          .map((row) => ({ ...(row as Record<string, unknown>) })),
        [{ name: "id" }],
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger refuses a database created by a newer schema version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ledger-future-"));
  const filename = path.join(root, "devharmonics.db");
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA user_version = 999;");
  database.close();
  try {
    assert.throws(() => new Ledger(filename), /newer ledger schema version 999/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger rejects foreign-key corruption before accepting the database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ledger-corrupt-"));
  const filename = path.join(root, "devharmonics.db");
  const ledger = new Ledger(filename);
  ledger.close();

  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = OFF;");
  database
    .prepare(
      `INSERT INTO tasks
        (run_id, task_id, title, description, dependencies_json, checks_json, status)
       VALUES ('missing-run', 'orphan', 'Orphan', 'Invalid fixture', '[]', '[]', 'queued')`,
    )
    .run();
  database.close();

  try {
    assert.throws(() => new Ledger(filename), /foreign-key integrity check failed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger.cancelRun cancels in-flight work and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-cancel-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Cancel it", root);
    ledger.savePlan(runId, {
      summary: "Two tasks",
      recommendedConcurrency: 1,
      tasks: [
        {
          id: "done",
          title: "Done",
          description: "Already finished",
          dependencies: [],
          preferredProvider: "codex",
          checks: ["diff-check"],
        },
        {
          id: "busy",
          title: "Busy",
          description: "Still running",
          dependencies: [],
          preferredProvider: "claude",
          checks: ["diff-check"],
        },
      ],
    });
    ledger.setTaskStatus(runId, "done", "working", "codex");
    ledger.setTaskStatus(runId, "done", "verifying", "codex");
    ledger.setTaskStatus(runId, "done", "passed", "codex");
    ledger.setTaskStatus(runId, "busy", "working", "claude");

    assert.equal(ledger.cancelRun(runId), true);
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "cancelled");
    assert.equal(run?.tasks.find((task) => task.id === "busy")?.status, "cancelled");
    assert.equal(run?.tasks.find((task) => task.id === "done")?.status, "passed");
    assert.ok(run?.events.some((event) => event.kind === "run.cancelled"));

    // Already terminal: no-op that reports nothing was cancelled.
    assert.equal(ledger.cancelRun(runId), false);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger.savePlan does not move a cancelled run back to running", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-save-plan-cancel-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Cancel during planning", root);
    assert.equal(ledger.cancelRun(runId), true);
    ledger.savePlan(runId, {
      summary: "Late plan",
      recommendedConcurrency: 1,
      tasks: [
        {
          id: "one",
          title: "One",
          description: "Do it",
          dependencies: [],
          preferredProvider: "codex",
          checks: ["diff-check"],
        },
      ],
    });

    const run = ledger.getRun(runId);
    assert.equal(run?.status, "cancelled");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger reconciles interrupted work into a durable paused recovery state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-recovery-"));
  const filename = path.join(root, "devharmonics.db");
  const original = new Ledger(filename);
  const runId = original.createRun("Recover after restart", root);
  original.savePlan(runId, {
    summary: "Interrupted task",
    recommendedConcurrency: 1,
    tasks: [{ id: "one", title: "One", description: "Do it", dependencies: [], preferredProvider: "codex", checks: [] }],
  });
  original.setTaskStatus(runId, "one", "working", "codex");
  original.startAttempt(runId, "one", "codex", "secret-free prompt");
  original.close();

  const reopened = new Ledger(filename);
  try {
    assert.deepEqual(reopened.reconcileInterruptedRuns(), [runId]);
    const run = reopened.getRun(runId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.tasks[0]?.status, "paused");
    assert.ok(run?.events.some((event) => event.kind === "run.paused"));
    assert.deepEqual(reopened.reconcileInterruptedRuns(), []);
    const receipt = new DatabaseSync(filename);
    try {
      const attempt = receipt.prepare("SELECT status, finished_at FROM attempts WHERE run_id = ?").get(runId) as { status: string; finished_at: string | null };
      assert.equal(attempt.status, "interrupted");
      assert.ok(attempt.finished_at);
    } finally {
      receipt.close();
    }
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("plan approval is a durable state transition before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-approval-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Approve plan", root);
    ledger.savePlan(runId, { summary: "one", recommendedConcurrency: 1, tasks: [{ id: "one", title: "One", description: "Do it", dependencies: [], preferredProvider: null, checks: [] }] });
    ledger.requestPlanApproval(runId);
    assert.equal(ledger.getRun(runId)?.status, "awaiting_approval");
    assert.equal(ledger.approvePlan(runId), true);
    assert.equal(ledger.getRun(runId)?.status, "running");
    assert.ok(ledger.getRun(runId)?.events.some((event) => event.kind === "plan.approved"));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger rejects invalid lifecycle transitions before persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-state-machine-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Validate transitions", root);
    ledger.savePlan(runId, {
      summary: "One task",
      recommendedConcurrency: 1,
      tasks: [{
        id: "one",
        title: "One",
        description: "Do it",
        dependencies: [],
        preferredProvider: null,
        checks: [],
      }],
    });
    assert.throws(
      () => ledger.setTaskStatus(runId, "one", "passed"),
      /invalid task status transition: queued -> passed/i,
    );
    assert.equal(ledger.getRun(runId)?.tasks[0]?.status, "queued");
    assert.throws(
      () => ledger.setRunStatus(runId, "planning"),
      /invalid run status transition: running -> planning/i,
    );
    assert.equal(ledger.getRun(runId)?.status, "running");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger replays typed events from durable cursors and projects legacy assignments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-events-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Replay events", root);
    const first = ledger.listEvents(runId)[0];
    assert.ok(first);
    const secondCursor = ledger.addEvent(runId, "scheduler.started", "Scheduler started", {
      concurrency: 7,
    });
    ledger.addEvent(runId, "review.started", "Reviewer started", { provider: "claude" });
    assert.equal(secondCursor > first.cursor, true);
    assert.deepEqual(
      ledger.listEvents(runId, { after: first.cursor }).map((event) => ({
        cursor: event.cursor,
        runId: event.runId,
        kind: event.kind,
        data: event.data,
      })),
      [
        { cursor: secondCursor, runId, kind: "scheduler.started", data: { concurrency: 7 } },
        { cursor: secondCursor + 1, runId, kind: "review.started", data: { provider: "claude" } },
      ],
    );
    assert.deepEqual(ledger.listEvents(runId, { after: secondCursor, limit: 1 })[0]?.data, {
      provider: "claude",
    });
    assert.throws(() => ledger.listEvents(runId, { after: -1 }), /cursor/i);

    ledger.savePlan(runId, {
      summary: "One task",
      recommendedConcurrency: 1,
      tasks: [{
        id: "one",
        title: "One",
        description: "Do it",
        dependencies: [],
        preferredProvider: "gemini",
        checks: [],
      }],
    });
    ledger.setTaskStatus(runId, "one", "working", "gemini");
    assert.equal(ledger.getRun(runId)?.tasks[0]?.assignment?.connectionId, "subscription-cli:gemini");
    assert.equal(ledger.getRun(runId)?.tasks[0]?.assignment?.modelResolution, "provider_default_unresolved");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger persists provider-neutral connections and guarded manual model entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-registry-"));
  const filename = path.join(root, "devharmonics.db");
  const secret = "sk-proj-registrysecret123456789";
  const ledger = new Ledger(filename);
  try {
    ledger.upsertConnection({
      id: "subscription-cli:codex",
      provider: "codex",
      transport: "subscription_cli",
      authentication: "subscription",
      displayName: "OpenAI Codex",
      enabled: true,
      installed: true,
      authenticated: true,
      visible: true,
      healthy: true,
      available: true,
      entitlement: "unknown",
      capacity: "unknown",
      adapterVersion: "0.1.0",
      runtimeVersion: "codex 1.2.3",
      metadata: { diagnostic: `Authorization: Bearer ${secret}` },
    });
    const connection = ledger.listConnections()[0];
    assert.equal(connection?.id, "subscription-cli:codex");
    assert.equal(connection?.available, true);
    assert.equal(connection?.entitlement, "unknown");

    const created = ledger.addManualModel({
      id: "manual:codex:future",
      connectionId: "subscription-cli:codex",
      canonicalName: "future-coder",
      displayName: "Future Coder",
      lifecycle: "verified",
      visible: true,
      verified: true,
      qualified: false,
      active: false,
      metadata: { contextWindow: 200_000, api_key: secret },
    });
    assert.equal(created.source, "manual");
    assert.equal(created.lastVerifiedAt !== null, true);
    assert.equal(created.qualificationStale, false);
    assert.deepEqual(created.metadata, { contextWindow: 200_000, api_key: REDACTED });

    const updated = ledger.addManualModel({
      id: created.id,
      connectionId: created.connectionId,
      canonicalName: created.canonicalName,
      displayName: "Future Coder Qualified",
      lifecycle: "qualified",
      visible: true,
      verified: true,
      qualified: true,
      active: false,
      metadata: { contextWindow: 200_000 },
    });
    assert.equal(updated.displayName, "Future Coder Qualified");
    assert.equal(updated.firstSeenAt, created.firstSeenAt);
    assert.equal(ledger.listModels("subscription-cli:codex").length, 1);
    assert.throws(
      () => ledger.addManualModel({
        ...updated,
        id: "manual:missing",
        connectionId: "missing-connection",
        metadata: {},
      }),
      /connection 'missing-connection' was not found/i,
    );
  } finally {
    ledger.close();
  }

  const database = new DatabaseSync(filename);
  try {
    const persisted = JSON.stringify({
      connections: database.prepare("SELECT * FROM provider_connections").all(),
      models: database.prepare("SELECT * FROM models").all(),
    });
    assert.equal(persisted.includes(secret), false);
    assert.match(persisted, /\[REDACTED\]/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog fingerprints stale qualifications and model retirement requires three missing observations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-catalog-policy-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "adapter-1", runtimeVersion: "runtime-1", metadata: {} });
    ledger.upsertDiscoveredModel({ id: "subscription-cli:codex:model:gpt-test", connectionId: "subscription-cli:codex", canonicalName: "gpt-test", displayName: "GPT Test", source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: {} });
    const modelId = "subscription-cli:codex:model:gpt-test";
    ledger.applyModelFingerprint(modelId, "fingerprint-1");
    ledger.recordModelQualification({ modelId, fixtureVersion: "fixture-1", role: "general", passed: true, score: 1, evidence: {}, fingerprint: "fingerprint-1" });
    ledger.setModelPreference(modelId, { active: true });
    assert.equal(ledger.getModel(modelId)?.qualificationStale, false);
    ledger.applyModelFingerprint(modelId, "fingerprint-2");
    assert.equal(ledger.getModel(modelId)?.qualificationStale, true);
    assert.throws(() => ledger.setModelPreference(modelId, { active: true }), /current qualification/i);

    ledger.reconcileDiscoveredModels("subscription-cli:codex", "runtime_discovery", [], 3);
    ledger.reconcileDiscoveredModels("subscription-cli:codex", "runtime_discovery", [], 3);
    assert.equal(ledger.getModel(modelId)?.retired, false);
    ledger.reconcileDiscoveredModels("subscription-cli:codex", "runtime_discovery", [], 3);
    assert.equal(ledger.getModel(modelId)?.retired, true);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger redacts secrets at every persistence entry point", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-redaction-"));
  const filename = path.join(root, "devharmonics.db");
  const secrets = {
    goal: "sk-proj-goalsecret123456789",
    plan: "sk-ant-plansecret123456789",
    prompt: "AIzaPromptSecretValue1234567890",
    output: "github_pat_outputsecret123456789012345",
    error: "4/errorsecret12345678901234567890",
    stdout: "eyJheader123456.payload123456.signature123456",
    stderr: "bearer-secret-123456789",
    event: "event-secret-123456789",
    review: "review-secret-123456789",
  };
  const ledger = new Ledger(filename);
  try {
    const runId = ledger.createRun(`Build safely ${secrets.goal}`, root);
    ledger.savePlan(runId, {
      summary: "Redaction plan",
      recommendedConcurrency: 1,
      tasks: [{
        id: "one",
        title: "One",
        description: `ANTHROPIC_API_KEY=${secrets.plan}`,
        dependencies: [],
        preferredProvider: "codex",
        checks: ["safe-check"],
      }],
    });
    ledger.setTaskStatus(runId, "one", "working", "codex");
    const attempt = ledger.startAttempt(runId, "one", "codex", `Prompt ${secrets.prompt}`);
    ledger.finishAttempt(
      attempt,
      "failed",
      `Output ${secrets.output}`,
      `Error code ${secrets.error}`,
      { failureKind: "authentication", resultEnvelope: { version: 1, role: "worker", summary: `password=${secrets.output}`, artifacts: [], assumptions: [], risks: [], nextAction: null, completionClaim: false, malformedSource: true } },
    );
    ledger.addBlackboardEntry({ runId, taskId: "one", kind: "risk", content: `password=${secrets.event}`, sourceAttemptId: attempt });
    ledger.recordCheck(runId, "one", {
      name: "safe-check",
      passed: false,
      exitCode: 1,
      stdout: `stdout ${secrets.stdout}`,
      stderr: `Authorization: Bearer ${secrets.stderr}`,
      durationMs: 1,
    });
    ledger.addEvent(runId, "task.provider_failed", `password=${secrets.event}`, {
      access_token: secrets.event,
      useful: "provider returned 401",
    });
    ledger.setRunStatus(runId, "failed", `password=${secrets.review}`);
  } finally {
    ledger.close();
  }

  const database = new DatabaseSync(filename);
  try {
    const persisted = JSON.stringify({
      runs: database.prepare("SELECT * FROM runs").all(),
      tasks: database.prepare("SELECT * FROM tasks").all(),
      attempts: database.prepare("SELECT * FROM attempts").all(),
      checks: database.prepare("SELECT * FROM checks").all(),
      events: database.prepare("SELECT * FROM events").all(),
      blackboard: database.prepare("SELECT * FROM blackboard_entries").all(),
    });
    for (const secret of Object.values(secrets)) {
      assert.equal(persisted.includes(secret), false, `Secret leaked to SQLite: ${secret}`);
    }
    assert.equal(persisted.includes(REDACTED), true);
    assert.match(persisted, /provider returned 401/);
    assert.match(persisted, /authentication/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("executeTask preserves cancellation at the commit/merge boundary", async () => {
  async function runBoundaryVariant(
    variant: "commit-aborts-before-merge" | "commit-aborts-and-throws",
  ): Promise<{ result: string; merged: boolean; status: string; eventKinds: string[] }> {
    const root = await mkdtemp(path.join(os.tmpdir(), `devharmonics-commit-cancel-${variant}-`));
    const ledger = new Ledger(path.join(root, "devharmonics.db"));
    try {
      const worktreePath = path.join(root, "task-worktree");
      await mkdir(worktreePath, { recursive: true });
      const task = {
        id: "one",
        title: "One",
        description: "Do it",
        dependencies: [],
        preferredProvider: "codex" as const,
        checks: ["pass"],
      };
      const runId = ledger.createRun("Cancel at commit boundary", root);
      ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
      ledger.savePlan(runId, {
        summary: "One task",
        recommendedConcurrency: 1,
        tasks: [task],
      });

      const controller = new AbortController();
      let merged = false;
      const orchestrator = new Orchestrator(ledger);
      (orchestrator as any).provider = () => ({
        connection: projectLegacyProvider("codex"),
        metadata: async () => ({ adapterVersion: "0.1.0", runtimeVersion: "fixture 1.0" }),
        invoke: async () => ({
          connectionId: "subscription-cli:codex",
          provider: "codex",
          adapterVersion: "0.1.0",
          runtimeVersion: "fixture 1.0",
          model: {
            requestedModelId: null,
            alias: null,
            settings: {},
            resolvedModelId: "provider-default:codex",
            resolution: "provider_default_unresolved",
          },
          text: "done",
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 0,
          usage: { inputTokens: null, outputTokens: null, costUsd: null },
          toolRequests: [],
        }),
      });

      const config: DevHarmonicsConfig = structuredClone(defaultConfig);
      config.application.retry.maxAttempts = 1;
      config.application.retry.backoffMs = 1;
      config.product.workers = ["codex"];
      config.repository.validators = {
        pass: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 30_000,
        },
      };

      const worktrees = {
        createTask: async () => ({ path: worktreePath, branch: "devharmonics/task-one" }),
        commitTask: async () => {
          controller.abort();
          ledger.cancelRun(runId);
          if (variant === "commit-aborts-and-throws") {
            throw new Error("commit aborted");
          }
          return true;
        },
        mergeTask: async () => {
          merged = true;
          throw new Error("merge should not run after cancellation");
        },
      };

      const result = await (orchestrator as any).executeTask({
        runId,
        goal: "Cancel at commit boundary",
        task,
        constitution: "Test constitution",
        config,
        providers: ["codex"],
        providerCursor: 0,
        worktrees,
        signal: controller.signal,
      });

      const run = ledger.getRun(runId);
      assert.ok(run);
      const savedTask = run.tasks.find((candidate) => candidate.id === "one");
      assert.ok(savedTask);
      return {
        result,
        merged,
        status: savedTask.status,
        eventKinds: run.events.map((event) => event.kind),
      };
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  const boundary = await runBoundaryVariant("commit-aborts-before-merge");
  assert.equal(boundary.result, "cancelled");
  assert.equal(boundary.merged, false);
  assert.equal(boundary.status, "cancelled");
  assert.ok(!boundary.eventKinds.includes("task.passed"));

  const failingCommit = await runBoundaryVariant("commit-aborts-and-throws");
  assert.equal(failingCommit.result, "cancelled");
  assert.equal(failingCommit.merged, false);
  assert.equal(failingCommit.status, "cancelled");
  assert.ok(!failingCommit.eventKinds.includes("task.retry"));
  assert.ok(!failingCommit.eventKinds.includes("task.failed"));
});

test("executeTask cannot pass a no-change retry while its task branch remains unmerged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-unmerged-retry-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const worktreePath = path.join(root, "task-worktree");
    await mkdir(worktreePath, { recursive: true });
    const task = {
      id: "conflicting-change",
      title: "Conflicting change",
      description: "Apply a change that conflicts during integration",
      dependencies: [],
      preferredProvider: "codex" as const,
      checks: ["pass"],
      kind: "implementation" as const,
      permission: "workspace_write" as const,
      risk: "medium" as const,
      repositoryScope: ["src/value.ts"],
      capabilityNeeds: ["code"],
      acceptanceCriteria: ["change is integrated"],
      expectedArtifacts: ["src/value.ts"],
    };
    const runId = ledger.createRun("Reject an unmerged retry", root);
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    ledger.savePlan(runId, { summary: "One conflicting task", recommendedConcurrency: 1, tasks: [task] });

    const orchestrator = new Orchestrator(ledger);
    (orchestrator as any).provider = () => ({
      connection: projectLegacyProvider("codex"),
      metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
      invoke: async () => ({
        connectionId: "subscription-cli:codex", provider: "codex", adapterVersion: "test", runtimeVersion: "test",
        model: { requestedModelId: null, alias: null, settings: {}, resolvedModelId: "provider-default:codex", resolution: "provider_default_unresolved" },
        text: "done", stdout: "", stderr: "", exitCode: 0, durationMs: 0,
        usage: { inputTokens: null, outputTokens: null, costUsd: null }, toolRequests: [],
      }),
    });
    const config: DevHarmonicsConfig = structuredClone(defaultConfig);
    config.application.retry.maxAttempts = 2;
    config.application.retry.backoffMs = 1;
    config.product.workers = ["codex"];
    config.repository.validators = { pass: { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 30_000 } };
    let commitCalls = 0;
    let mergeCalls = 0;
    const result = await (orchestrator as any).executeTask({
      runId,
      goal: "Reject an unmerged retry",
      task,
      constitution: "Test constitution",
      config,
      providers: ["codex"],
      providerCursor: 0,
      worktrees: {
        root,
        integrationPath: worktreePath,
        createTask: async () => ({ path: worktreePath, branch: "devharmonics/task-conflicting-change" }),
        commitTask: async () => ++commitCalls === 1,
        mergeTask: async () => { mergeCalls++; throw new Error("Merge conflict for conflicting-change: fixture conflict"); },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result, "failed");
    assert.equal(commitCalls, 2);
    assert.equal(mergeCalls, 2, "the existing task commit must be retried even when the agent produced no new commit");
    const run = ledger.getRun(runId)!;
    assert.equal(run.tasks.find((candidate) => candidate.id === task.id)?.status, "failed");
    assert.equal(run.events.some((event) => event.kind === "task.passed"), false);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only task contracts survive persistence and never cross the commit boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-read-only-task-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const task = {
      id: "observe",
      title: "Observe repository truth",
      description: "Report findings without modifying files",
      dependencies: [],
      preferredProvider: "codex" as const,
      checks: ["pass"],
      kind: "diagnostic" as const,
      repositoryScope: ["STATUS.md"],
      permission: "read_only" as const,
      risk: "low" as const,
      capabilityNeeds: ["analysis"],
      acceptanceCriteria: ["Report contradictory claims"],
      expectedArtifacts: ["finding envelope"],
    };
    const runId = ledger.createRun("Observe", root, null, "observe");
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    ledger.savePlan(runId, { summary: "Observe only", recommendedConcurrency: 1, tasks: [task] });
    assert.equal(ledger.getRun(runId)?.autonomy, "observe");
    assert.equal(ledger.getTask(runId, task.id)?.permission, "read_only");

    let invokedPermission = "";
    let committed = false;
    let isolationChecks = 0;
    const orchestrator = new Orchestrator(ledger);
    (orchestrator as any).provider = () => ({
      connection: projectLegacyProvider("codex"),
      metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
      invoke: async (request: { permission: string }) => {
        invokedPermission = request.permission;
        return { connectionId: "subscription-cli:codex", provider: "codex", adapterVersion: "test", runtimeVersion: "test", model: { requestedModelId: null, alias: null, settings: {}, resolvedModelId: "provider-default:codex", resolution: "provider_default_unresolved" }, text: "STATUS.md:7 identifies version 1.0.3 while README.md:1 identifies version 1.0.4. This is a concrete stale release claim requiring reconciliation; no files were modified.", stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: null, outputTokens: null, costUsd: null }, toolRequests: [] };
      },
    });
    const config = structuredClone(defaultConfig);
    config.runPolicy.autonomy = "observe";
    config.application.retry.maxAttempts = 1;
    config.repository.validators = { pass: { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 } };
    const result = await (orchestrator as any).executeTask({
      runId, goal: "Observe", task: ledger.getTask(runId, task.id), constitution: "test", config,
      providers: ["codex"], providerCursor: 0,
      worktrees: { createTask: async () => ({ path: root, branch: "observe" }), assertPrimaryClean: async () => { isolationChecks++; }, commitTask: async () => { committed = true; return false; }, mergeTask: async () => undefined },
      signal: new AbortController().signal,
    });
    assert.equal(result, "passed");
    assert.equal(invokedPermission, "read_only");
    assert.equal(committed, false);
    assert.equal(isolationChecks, 3);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quota exhaustion cools a subscription connection and falls back with durable handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-fallback-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    for (const provider of ["codex", "claude"] as const) {
      ledger.upsertConnection({ id: `subscription-cli:${provider}`, provider, transport: "subscription_cli", authentication: "subscription", displayName: provider, enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    }
    const task = { id: "one", title: "One", description: "Do it", dependencies: [], preferredProvider: "codex" as const, checks: ["pass"] };
    const runId = ledger.createRun("Fallback", root);
    ledger.savePlan(runId, { summary: "fallback", recommendedConcurrency: 1, tasks: [task] });
    const orchestrator = new Orchestrator(ledger);
    (orchestrator as any).provider = (provider: "codex" | "claude") => ({
      connection: { id: domainId("ProviderConnection", `subscription-cli:${provider}`) },
      metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
      invoke: async () => {
        if (provider === "codex") throw new RuntimeInvocationError("weekly usage limit reached", "quota_exhausted", domainId("ProviderConnection", "subscription-cli:codex"), 1, true);
        return { connectionId: "subscription-cli:claude", provider: "claude", adapterVersion: "test", runtimeVersion: "test", model: { requestedModelId: null, alias: null, settings: {}, resolvedModelId: "provider-default:claude", resolution: "provider_default_unresolved" }, text: "fallback completed", stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: null, outputTokens: null, costUsd: null }, toolRequests: [] };
      },
    });
    const config = structuredClone(defaultConfig);
    config.application.retry.maxAttempts = 2;
    config.application.retry.backoffMs = 1;
    config.product.workers = ["codex", "claude"];
    config.repository.validators = { pass: { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 } };
    const result = await (orchestrator as any).executeTask({ runId, goal: "Fallback", task, constitution: "test", config, providers: ["codex", "claude"], providerCursor: 0, worktrees: { root, integrationPath: root, createTask: async () => ({ path: root, branch: "fixture" }), commitTask: async () => false, mergeTask: async () => undefined }, signal: new AbortController().signal });
    assert.equal(result, "passed");
    assert.equal(ledger.getConnectionHealth("subscription-cli:codex")?.state, "quota_exhausted");
    assert.equal(ledger.getConnectionHealth("subscription-cli:claude")?.state, "ready");
    assert.ok(ledger.listBlackboardEntries(runId, "one").some((entry) => entry.kind === "risk" && entry.content.includes("usage limit")));
    assert.ok(ledger.listBlackboardEntries(runId, "one").some((entry) => entry.kind === "handoff" && entry.content.includes("fallback completed")));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity Gemini quota exhaustion falls back to the Claude and GPT quota group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-antigravity-quota-group-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const connectionId = "subscription-cli:gemini";
    ledger.upsertConnection({ id: connectionId, provider: "gemini", transport: "subscription_cli", authentication: "subscription", displayName: "Google Antigravity", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: { platform: "antigravity", legacyProviderKey: "gemini" } });
    const models = [
      { id: `${connectionId}:model:a-gemini-flash`, name: "Gemini 3.5 Flash (Medium)", vendor: "google", quotaGroup: "antigravity:gemini-models", quotaGroupDisplayName: "Gemini Models" },
      { id: `${connectionId}:model:z-gpt-oss`, name: "GPT-OSS 120B (Medium)", vendor: "openai", quotaGroup: "antigravity:claude-gpt-models", quotaGroupDisplayName: "Claude and GPT Models" },
    ];
    for (const model of models) {
      ledger.upsertDiscoveredModel({ id: model.id, connectionId, canonicalName: model.name, displayName: model.name, source: "runtime_discovery", lifecycle: "visible", visible: true, verified: false, qualified: false, active: false, metadata: { ...profileMetadata({ tier: "standard", family: model.vendor === "google" ? "gemini-flash" : "openai-gpt-oss", capabilities: ["text", "analysis", "code", "tools"], source: "runtime" }), platform: "antigravity", modelVendor: model.vendor, quotaGroup: model.quotaGroup, quotaGroupDisplayName: model.quotaGroupDisplayName } });
      const storedModel = ledger.getModel(model.id)!;
      const storedConnection = ledger.listConnections().find((connection) => connection.id === connectionId)!;
      ledger.recordModelQualification({ modelId: model.id, fixtureVersion: "subscription-worker-v1", role: "worker", passed: true, score: 1, evidence: {}, fingerprint: modelQualificationFingerprint(storedModel, storedConnection, QUALIFICATION_FINGERPRINT_FIXTURE) });
      ledger.setModelPreference(model.id, { active: true });
    }
    const task = { id: "one", title: "Inspect compatibility", description: "Return cited findings", dependencies: [], preferredProvider: "gemini" as const, checks: ["pass"], kind: "diagnostic" as const, permission: "read_only" as const, risk: "low" as const, repositoryScope: ["."], capabilityNeeds: ["analysis"], acceptanceCriteria: ["Cite findings"], expectedArtifacts: [] };
    const runId = ledger.createRun("Antigravity quota group fallback", root, undefined, "observe");
    ledger.savePlan(runId, { summary: "quota group fallback", recommendedConcurrency: 1, tasks: [task] });
    const invoked: string[] = [];
    const orchestrator = new Orchestrator(ledger);
    (orchestrator as any).provider = () => ({
      connection: { id: domainId("ProviderConnection", connectionId), provider: "gemini", transport: "subscription_cli", authentication: "subscription", displayName: "Google Antigravity", capabilities: { structuredOutput: false, streaming: false, providerManagedTools: true, modelSelection: true, modelSettings: [], permissions: ["read_only", "workspace_write"] } },
      metadata: async () => ({ adapterVersion: "test", runtimeVersion: "test" }),
      invoke: async (request: { model: { alias: string | null } }) => {
        invoked.push(String(request.model.alias));
        if (request.model.alias?.startsWith("Gemini")) {
          const detail = "Individual quota reached. Resets in 4h15m.";
          const failure = classifyInvocationFailure({ detail, exitCode: 1, timedOut: false, aborted: false });
          throw new RuntimeInvocationError(detail, failure.kind, domainId("ProviderConnection", connectionId), 1, failure.retryable);
        }
        return { connectionId, provider: "gemini", adapterVersion: "test", runtimeVersion: "test", model: { ...request.model, resolvedModelId: models[1]!.id, resolution: "requested_unverified" }, text: "README.md:7 confirms the compatibility finding and ARCHITECTURE.md:12 documents the relevant runtime boundary. The evidence indicates the change is compatible because both surfaces retain the same contract. No files were modified during this read-only diagnostic run.", stdout: "", stderr: "", exitCode: 0, durationMs: 1, usage: { inputTokens: null, outputTokens: null, costUsd: null }, toolRequests: [] };
      },
    });
    const config = structuredClone(defaultConfig);
    config.application.retry.maxAttempts = 2;
    config.application.retry.backoffMs = 1;
    config.product.workers = ["gemini"];
    config.repository.validators = { pass: { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 } };
    const outcome = await (orchestrator as any).executeTask({ runId, goal: "Observe", task, constitution: "test", config, providers: ["gemini"], providerCursor: 0, worktrees: { createTask: async () => ({ path: root, branch: "fixture" }), assertPrimaryClean: async () => undefined, commitTask: async () => false, mergeTask: async () => undefined }, signal: new AbortController().signal }).catch((error: unknown) => error);
    assert.equal(outcome, "passed", JSON.stringify({ invoked, events: ledger.getRun(runId)?.events, models: ledger.listModels(connectionId).map((model) => ({ id: model.id, active: model.active, qualified: model.qualified, stale: model.qualificationStale, health: ledger.getModelHealth(model.id), quota: model.metadata.quotaGroup })) }));
    assert.deepEqual(invoked, ["Gemini 3.5 Flash (Medium)", "GPT-OSS 120B (Medium)"]);
    assert.notEqual(ledger.getConnectionHealth(connectionId)?.state, "quota_exhausted");
    assert.equal(ledger.getQuotaGroupHealth(connectionId, "antigravity:gemini-models")?.state, "quota_exhausted");
    assert.equal(ledger.isQuotaGroupEligible(connectionId, "antigravity:claude-gpt-models"), true);
    ledger.recordQuotaGroupOutcome(connectionId, "antigravity:gemini-models", "Gemini Models", { success: true });
    assert.equal(ledger.getQuotaGroupHealth(connectionId, "antigravity:gemini-models")?.state, "quota_exhausted", "a late success must not clear a newer reset-bound quota signal");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runProcess terminates a child when its abort signal fires", async () => {
  const sleepScript = "setTimeout(() => {}, 60000);";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", sleepScript],
      cwd: os.tmpdir(),
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  } finally {
    clearTimeout(timer);
  }
});

test("runProcess resolves immediately for an already-aborted signal", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000);"],
    cwd: os.tmpdir(),
    timeoutMs: 30_000,
    signal: AbortSignal.abort(),
  });
  assert.equal(result.timedOut, true);
});

test("ledger persists tasks, events, attempts, and check receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-ledger-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Build it", root);
    ledger.savePlan(runId, {
      summary: "One task",
      recommendedConcurrency: 1,
      tasks: [
        {
          id: "one",
          title: "One",
          description: "Do it",
          dependencies: [],
          preferredProvider: "codex",
          checks: ["diff-check"],
        },
      ],
    });
    const modelId = "subscription-cli:codex:model:gpt-5-6-terra";
    const attempt = ledger.startAttempt(runId, "one", "codex", "prompt", {
      connectionId: "subscription-cli:codex",
      requestedModelId: modelId,
      modelSettings: { effort: "medium" },
      adapterVersion: "test",
      runtimeVersion: "test",
    });
    ledger.finishAttempt(attempt, "completed", "done", "", { resultEnvelope: normalizeAgentResult("worker", "done") });
    ledger.addBlackboardEntry({ runId, taskId: "one", kind: "handoff", content: "done", sourceAttemptId: attempt });
    ledger.recordCheck(runId, "one", {
      name: "diff-check",
      passed: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 2,
    });
    ledger.setTaskStatus(runId, "one", "working", "codex");
    ledger.setTaskStatus(runId, "one", "verifying", "codex");
    ledger.setTaskStatus(runId, "one", "passed", "codex");
    ledger.addEvent(runId, "task.integration_conflict", "One produced a merge conflict", { taskId: "one", attemptId: attempt, modelId });
    ledger.setRunStatus(runId, "not_ready", "NOT READY: independent review found a run-level issue");
    const run = ledger.getRun(runId);
    assert.equal(run?.tasks[0]?.attemptCount, 1);
    assert.equal(run?.tasks[0]?.checks[0]?.passed, true);
    assert.ok(run?.events.length);
    const evidence = ledger.getRunEvidence(runId);
    assert.equal(evidence?.attempts.length, 1);
    assert.equal(evidence?.blackboard.length, 1);
    assert.equal(evidence?.integritySha256.length, 64);
    const [performance] = ledger.listModelPerformanceProfiles(modelId);
    assert.ok(performance);
    assert.equal(performance.sampleSize, 1);
    assert.equal(performance.successRate, 1);
    assert.equal(performance.malformedEnvelopeCount, 1);
    assert.equal(performance.integrationConflictCount, 1);
    assert.equal(performance.notReadyRunCount, 1);
    assert.equal(performance.uncertainty, "insufficient");
    ledger.setModelPerformancePolicy(modelId, { excluded: true });
    assert.equal(ledger.listModelPerformanceProfiles(modelId)[0]?.observationsExcluded, true);
    assert.equal(ledger.listModelPerformanceProfiles(modelId)[0]?.eligibleForAdaptiveWeighting, false);
    ledger.setModelPerformancePolicy(modelId, { ignoredBefore: new Date(Date.now() + 1_000).toISOString() });
    assert.equal(ledger.listModelPerformanceProfiles(modelId).length, 0);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger retains observed products and repository intelligence without credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-portfolio-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const product = ledger.upsertProduct({
      id: "github:civicsuite",
      name: "CivicSuite",
      organizationUrl: "https://github.com/CivicSuite",
      description: "Civic technology product suite",
      repositories: [{
        id: "github:civicsuite/civiccore",
        name: "civiccore",
        fullName: "CivicSuite/civiccore",
        url: "https://github.com/CivicSuite/civiccore",
        cloneUrl: "https://github.com/CivicSuite/civiccore.git",
        defaultBranch: "main",
        visibility: "public",
        archived: false,
        sizeKb: 18891,
        language: "TypeScript",
        description: null,
        intelligence: { source: "github-observe", manifests: ["package.json"] },
      }],
    });
    assert.equal(product.repositories[0]?.fullName, "CivicSuite/civiccore");
    assert.equal(product.repositories[0]?.intelligence.source, "github-observe");
    assert.equal(ledger.listProducts()[0]?.repositories.length, 1);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("repository registry migrates remote observations and persists local governance plus inspection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-repository-registry-"));
  const filename = path.join(root, "devharmonics.db");
  const seed = new Ledger(filename);
  seed.upsertProduct({
    id: "github:civicsuite",
    name: "CivicSuite",
    organizationUrl: "https://github.com/CivicSuite",
    description: "Civic technology product suite",
    repositories: [{
      id: "github:civicsuite/civiccore",
      name: "civiccore",
      fullName: "CivicSuite/civiccore",
      url: "https://github.com/CivicSuite/civiccore",
      cloneUrl: "https://github.com/CivicSuite/civiccore.git",
      defaultBranch: "main",
      visibility: "public",
      archived: false,
      sizeKb: 18891,
      language: "TypeScript",
      description: null,
      intelligence: { source: "github-observe" },
    }],
  });
  seed.close();

  const version19 = new DatabaseSync(filename);
  version19.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE repositories_v19 (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      clone_url TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      visibility TEXT NOT NULL,
      archived INTEGER NOT NULL,
      size_kb INTEGER NOT NULL,
      language TEXT,
      description TEXT,
      intelligence_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    INSERT INTO repositories_v19
      SELECT id, product_id, name, full_name, url, clone_url, default_branch, visibility,
        archived, size_kb, language, description, intelligence_json, observed_at
      FROM repositories;
    DROP TABLE repositories;
    ALTER TABLE repositories_v19 RENAME TO repositories;
    CREATE INDEX repositories_product_id ON repositories(product_id);
    DELETE FROM schema_migrations WHERE version >= 20;
    PRAGMA user_version = 19;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  version19.close();

  const ledger = new Ledger(filename);
  try {
    assert.equal(ledger.getSchemaVersion(), LEDGER_SCHEMA_VERSION);
    const migrated = ledger.getRepository("github:civicsuite/civiccore");
    assert.ok(migrated);
    assert.equal(migrated.visibility, "public");
    assert.equal(migrated.localPath, null);
    assert.equal(migrated.role, "other");
    assert.equal(migrated.inspection, null);

    const configured = ledger.upsertRepository({
      ...migrated,
      productId: "github:civicsuite",
      localPath: path.join(root, "civiccore"),
      role: "shared_platform",
      expectedBranch: "main",
      owners: ["platform-team"],
      dependencyRepositoryIds: [],
      validators: {
        test: { command: "npm.cmd", args: ["test"], timeoutMs: 120_000 },
      },
      governanceSources: ["AGENTS.md", "docs/ARCHITECTURE.md"],
      governanceRules: ["No direct pushes to main"],
    });
    assert.equal(configured.localPath, path.join(root, "civiccore"));
    assert.equal(configured.validators.test?.command, "npm.cmd");

    const inspected = (ledger as any).recordRepositoryInspection(configured.id, {
      currentBranch: "feature/dh-700",
      headSha: "a".repeat(40),
      remoteUrl: "https://user:secret@github.com/CivicSuite/civiccore.git",
      dirty: true,
      compatibilityIssues: ["Expected branch main; found feature/dh-700"],
      checkedAt: "2026-07-15T18:00:00.000Z",
    });
    assert.equal(inspected.inspection.currentBranch, "feature/dh-700");
    assert.equal(inspected.inspection.dirty, true);
    assert.equal(inspected.inspection.remoteUrl, "https://github.com/CivicSuite/civiccore.git");
    assert.deepEqual(ledger.listRepositories("github:civicsuite").map((repository) => repository.id), [configured.id]);
    assert.throws(
      () => ledger.recordRepositoryInspection(configured.id, { ...inspected.inspection!, headSha: "not-a-sha" }),
      /Invalid string/i,
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("objective drafts persist without creating an execution run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-objective-draft-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const objective = ledger.createObjective(objectiveInputSchema.parse({
      outcome: "Ship a bounded CSV export",
      acceptanceCriteria: ["Filtered rows are preserved"],
      constraints: ["Do not change authentication"],
      projectPath: root,
      productId: "github:civicsuite",
      repositoryIds: ["github:civicsuite/civiccore"],
      risk: "medium",
      autonomy: "supervised",
      priority: "high",
      deadline: "2026-08-01T18:00:00.000Z",
      policyNotes: ["No external writes"],
    }));

    assert.equal(objective.revision, 1);
    assert.equal(ledger.getObjective(objective.id)?.outcome, "Ship a bounded CSV export");
    assert.equal(ledger.listObjectives().length, 1);
    assert.equal(ledger.listRuns().length, 0);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workbench persistence advances the ledger schema without creating execution state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-workbench-schema-"));
  const filename = path.join(root, "devharmonics.db");
  const seed = new Ledger(filename);
  seed.close();
  const version18 = new DatabaseSync(filename);
  version18.exec(`
    DROP TABLE workbench_messages;
    DROP TABLE workbench_sessions;
    DELETE FROM schema_migrations WHERE version >= 19;
    PRAGMA user_version = 18;
  `);
  version18.close();
  const ledger = new Ledger(filename);
  let sessionId = "";
  let objectiveId = "";
  try {
    assert.equal(ledger.getSchemaVersion(), LEDGER_SCHEMA_VERSION);
    const session = ledger.createWorkbenchSession({
      projectPath: root,
      title: "Explore release readiness",
    });
    sessionId = session.id;
    assert.equal(session.mode, "read_only");
    assert.equal(session.objectiveId, null);

    ledger.appendWorkbenchMessage({
      sessionId,
      role: "user",
      content: "Compare the migration approaches",
    });
    const result = ledger.appendWorkbenchMessage({
      sessionId,
      role: "assistant",
      content: "Use the bounded migration",
      provider: "ollama",
      connectionId: "ollama:system",
      requestedModelId: "ollama:mellum2:4b",
      resolvedModelId: "ollama:mellum2:4b-q4_K_M",
      status: "complete",
      inputTokens: 320,
      outputTokens: 88,
      costUsd: 0,
      durationMs: 2400,
    });
    assert.equal(result.provider, "ollama");
    assert.equal(result.resolvedModelId, "ollama:mellum2:4b-q4_K_M");
    assert.equal(ledger.listWorkbenchMessages(sessionId).length, 2);
    assert.throws(
      () => ledger.appendWorkbenchMessage({ sessionId, role: "assistant", content: "Unattributed" }),
      /require a provider/i,
    );

    const objective = ledger.createObjective({
      outcome: "Prepare the release migration",
      acceptanceCriteria: ["The chosen approach is documented"],
      constraints: ["No external writes"],
      projectPath: root,
      repositoryIds: [],
      risk: "low",
      autonomy: "observe",
      priority: "normal",
      policyNotes: [],
    });
    objectiveId = objective.id;
    const converted = ledger.linkWorkbenchObjective(sessionId, objectiveId);
    assert.equal(converted.objectiveId, objectiveId);
    assert.ok(converted.convertedAt);
    assert.equal(ledger.listRuns().length, 0);
  } finally {
    ledger.close();
  }

  const reopened = new Ledger(filename);
  try {
    assert.equal(reopened.getWorkbenchSession(sessionId)?.objectiveId, objectiveId);
    assert.equal(reopened.listWorkbenchMessages(sessionId)[1]?.durationMs, 2400);
    assert.equal(reopened.listWorkbenchSessions()[0]?.mode, "read_only");
    assert.equal(reopened.listRuns().length, 0);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("objective updates use optimistic revisions and redact persisted policy text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-objective-update-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const input = {
      outcome: "Prepare the inventory",
      acceptanceCriteria: ["Inventory is complete"],
      constraints: [],
      projectPath: root,
      repositoryIds: [],
      risk: "low" as const,
      autonomy: "observe" as const,
      priority: "normal" as const,
      policyNotes: [],
    };
    const created = ledger.createObjective(input);
    const updated = ledger.updateObjective(created.id, {
      ...input,
      outcome: "Prepare the verified inventory",
      policyNotes: ["OPENAI_API_KEY=sk-proj-objectivesecret123456789"],
    }, 1);

    assert.equal(updated.revision, 2);
    assert.equal(updated.outcome, "Prepare the verified inventory");
    assert.match(updated.policyNotes[0]!, /\[REDACTED\]/);
    assert.throws(() => ledger.updateObjective(created.id, input, 1), /revision conflict/i);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("plan revision two retains revision one and its rationale", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-plan-revisions-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const objective = ledger.createObjective({
      outcome: "Improve export reliability",
      acceptanceCriteria: ["Regression tests pass"],
      constraints: [],
      projectPath: root,
      repositoryIds: [],
      risk: "low",
      autonomy: "observe",
      priority: "normal",
      policyNotes: [],
    });
    const baseTask = {
      id: "export",
      title: "Review export",
      description: "Inspect the export path",
      dependencies: [],
      preferredProvider: "codex" as const,
      checks: ["npm test"],
    };
    const revision1 = ledger.appendPlanRevision(objective.id, {
      summary: "Inspect first",
      recommendedConcurrency: 1,
      tasks: [baseTask],
    }, "Start with a read-only inspection");
    const revision2 = ledger.appendPlanRevision(objective.id, {
      summary: "Inspect and implement",
      recommendedConcurrency: 1,
      tasks: [{ ...baseTask, description: "Inspect and repair the export path" }],
    }, "The inspection confirmed a bounded repair");

    assert.equal(revision1.revision, 1);
    assert.equal(revision2.revision, 2);
    assert.deepEqual(ledger.listPlanRevisions(objective.id).map((revision) => revision.revision), [1, 2]);
    assert.equal(ledger.getPlanRevision(objective.id, 1)?.rationale, "Start with a read-only inspection");
    assert.equal(ledger.getPlanRevision(objective.id, 1)?.plan.summary, "Inspect first");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approving an exact plan revision is durable and links the run to that immutable plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-plan-approval-"));
  const filename = path.join(root, "devharmonics.db");
  let objectiveId = "";
  let runId = "";
  const ledger = new Ledger(filename);
  try {
    const objective = ledger.createObjective({
      outcome: "Prepare a release inventory",
      acceptanceCriteria: ["Every repository is accounted for"],
      constraints: ["Read only"],
      projectPath: root,
      repositoryIds: ["github:civicsuite/civiccore"],
      risk: "low",
      autonomy: "observe",
      priority: "normal",
      policyNotes: [],
    });
    objectiveId = objective.id;
    const plan = {
      summary: "Inventory repositories",
      recommendedConcurrency: 1,
      tasks: [{
        id: "inventory",
        title: "Inventory",
        description: "List repository release state",
        dependencies: [],
        preferredProvider: "codex" as const,
        checks: ["inventory receipt"],
      }],
    };
    ledger.appendPlanRevision(objective.id, plan, "Initial proposal");
    ledger.appendPlanRevision(objective.id, { ...plan, summary: "Approved inventory" }, "Clarified output");
    ledger.approvePlanRevision(objective.id, 1);
    const approved = ledger.approvePlanRevision(objective.id, 2);
    assert.equal(approved.approved, true);
    assert.equal(ledger.getPlanRevision(objective.id, 1)?.approved, false);
    runId = ledger.createRun(objective.outcome, objective.projectPath, null, objective.autonomy, {
      objectiveId: objective.id,
      approvedPlanRevision: approved.revision,
    });
  } finally {
    ledger.close();
  }

  const reopened = new Ledger(filename);
  try {
    assert.equal(reopened.getPlanRevision(objectiveId, 2)?.approved, true);
    const run = reopened.getRun(runId);
    assert.equal(run?.objectiveId, objectiveId);
    assert.equal(run?.approvedPlanRevision, 2);
    assert.equal(run?.plan?.summary, "Approved inventory");
    assert.throws(
      () => reopened.createRun("Wrong revision", root, null, "observe", { objectiveId, approvedPlanRevision: 1 }),
      /not the approved plan revision/i,
    );
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
