import assert from "node:assert/strict";
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
import { Orchestrator, parseFirstJsonObject, taskAttemptTimeoutMs } from "../src/orchestrator.js";
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
import { manualModelSchema, runPlanSchema } from "../src/schemas.js";
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
import { estimateInvocationCost, estimateQualificationCost, isExactOpenRouterModelId } from "../src/openrouter.js";
import { architectPrompt, localReviewerContextHeader, reviewerPrompt, workerPrompt } from "../src/prompts.js";
import { ensureSchedulerCandidateQualified } from "../src/qualification.js";
import { aggregateModelPerformance } from "../src/model-performance.js";

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

test("Claude official catalog watcher selects the newest exact model in each tracked family", () => {
  const models = parseCurrentClaudeModels(`claude-opus-47 claude-opus-4-7 claude-opus-4-8 claude-fable-5 claude-sonnet-5 claude-haiku-4-5-20251001`);
  assert.deepEqual(models, ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
});

test("OpenRouter cost estimates use catalog per-token pricing without activating catalog models", () => {
  const model = { metadata: { promptPrice: 0.000001, completionPrice: 0.000002 } };
  assert.ok(Math.abs((estimateQualificationCost(model) ?? 0) - 0.000244) < 1e-12);
  assert.ok(Math.abs((estimateInvocationCost(model, "12345678", 10) ?? 0) - 0.000022) < 1e-12);
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

test("tool policy allows receipted local work but gates external and unrestricted actions", () => {
  const config = structuredClone(defaultConfig);
  assert.equal(evaluateToolPolicy("git.commit", config).outcome, "allow");
  assert.equal(evaluateToolPolicy("validator:test", config).outcome, "allow");
  assert.equal(evaluateToolPolicy("github.pull_request", config).outcome, "deny");
  assert.equal(evaluateToolPolicy("shell.unrestricted", config).outcome, "deny");
  config.runPolicy.allowExternalWrites = true;
  assert.equal(evaluateToolPolicy("github.pull_request", config).outcome, "require_approval");
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
    const qualification = ledger.recordModelQualification({ modelId: "ollama:qwen-fixture:7b", fixtureVersion: "fixture-v1", role: "analysis", passed: true, score: 1, evidence: { durationMs: result.durationMs } });
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
  assert.equal(invocationFailureScope("model_quota_exhausted", true), "model");
  assert.equal(invocationFailureScope("context_overflow", true), "model");
  assert.equal(invocationFailureScope("quota_exhausted", true), "connection");
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
    assert.equal(isolationChecks, 2);
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
    const result = await (orchestrator as any).executeTask({ runId, goal: "Fallback", task, constitution: "test", config, providers: ["codex", "claude"], providerCursor: 0, worktrees: { createTask: async () => ({ path: root, branch: "fixture" }), commitTask: async () => false, mergeTask: async () => undefined }, signal: new AbortController().signal });
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
