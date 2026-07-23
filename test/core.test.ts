import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { defaultConfig, devHarmonicsDirectory, initializeProject, loadConfig, resolveProviderCommand } from "../src/config.js";
import { projectLegacyProvider } from "../src/compatibility.js";
import { assertRunTransition, assertTaskTransition, domainId } from "../src/domain.js";
import { LEDGER_SCHEMA_VERSION, Ledger } from "../src/ledger.js";
import { architectValidatorNames, assignReviewFindings, describeReviewerUnavailability, buildRepositoryContext, canRoute, createReviewEvidenceBinding, Orchestrator, workerClassProbe, parseFirstJsonObject, planSteeredAdmission, repositoryTaskIds, reviewEvidenceBindingSha256, settleActiveAttemptsIfAborted, taskAttemptTimeoutMs } from "../src/orchestrator.js";
import { extractCitations, verifyReportCitations } from "../src/citations.js";
import { boundedThinkingSettings, discoverOllama, minimalThinking, OllamaAdapter, qualifyOllamaModel, syncOllamaRegistry, syncOllamaRuntimes } from "../src/ollama.js";
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
  isAbortError,
  type InvocationEvent,
} from "../src/runtime.js";
import type { DevHarmonicsConfig, PlannedTask, RunPlan, SteeringDirectiveRecord } from "../src/types.js";
import { devHarmonicsConfigSchema, manualModelSchema, objectiveInputSchema, runPlanSchema, steeringPayloadSchema } from "../src/schemas.js";
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
import { QUALIFICATION_FINGERPRINT_FIXTURE, ensureReviewerCandidateQualified, hasQualifiableCandidate, ensureSchedulerCandidateQualified, ensureSchedulerProviderCandidateQualified, hasCurrentOperationalQualification, qualifyRuntimeModel, trackedFamilyQualificationRole } from "../src/qualification.js";
import { modelQualificationFingerprint } from "../src/model-fingerprint.js";
import { aggregateModelPerformance } from "../src/model-performance.js";
import { quotaResetAt } from "../src/antigravity.js";
import { expandValidatorTokens, mergeRepositoryValidators, runValidator } from "../src/validators.js";
import { parseReviewerResponse } from "../src/review.js";
import { DeliveryService } from "../src/delivery.js";

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
  // The mechanical citation gate proves a cited line EXISTS; only the reviewer
  // can judge whether it SUPPORTS the conclusion drawn from it. That division
  // of labour must be stated in the prompt, in both reviewer variants, or the
  // reviewer reasonably assumes resolution implies support — which is exactly
  // how five fabricated-adjacent reports once read as convincing.
  assert.match(reviewer, /supports? the conclusion/i, "the tool-holding reviewer is told to judge support, not existence");
  assert.match(reviewer, /already been verified to exist|existence is already verified/i, "and told what the mechanical gate already covers");
  // One assertion helper for both variants, so their shared contract cannot
  // drift apart — an audit showed the context-only half could lose its
  // existence statement with this test still green.
  const assertCitationDuty = (prompt: string, variant: string): void => {
    assert.match(prompt, /supports? the conclusion/i, `${variant} is told to judge support, not existence`);
    assert.match(prompt, /already been verified to exist|existence is already verified/i, `${variant} is told what the mechanical gate already covers`);
  };
  assertCitationDuty(reviewer, "the tool-holding reviewer");
  assertCitationDuty(
    localReviewerContextHeader({ goal: "Audit release truth", constitution: "Evidence first", plan, checkSummary: "test: PASS", taskReports: reports, autonomy: "observe" }),
    "the context-only reviewer",
  );

  // Citations are verified mechanically only for read-only tasks. Telling a
  // reviewer of an IMPLEMENTATION plan that its report citations were verified
  // is a claim the product did not earn — an audit found both prompts making it
  // unconditionally. The claim must track what actually ran.
  const writePlan: RunPlan = {
    summary: "implementation fixture plan",
    recommendedConcurrency: 1,
    tasks: [{ id: "build", title: "Build it", description: "Build it", dependencies: [], preferredProvider: null, checks: ["test"], kind: "implementation", permission: "workspace_write", risk: "medium" }],
  };
  for (const [variant, prompt] of [
    ["tool-holding", reviewerPrompt({ goal: "Ship it", constitution: "Evidence first", plan: writePlan, checkSummary: "test: PASS", taskReports: "build: done", workspacePath: "C:/fixture", autonomy: "bounded" })],
    ["context-only", localReviewerContextHeader({ goal: "Ship it", constitution: "Evidence first", plan: writePlan, checkSummary: "test: PASS", taskReports: "build: done", autonomy: "bounded" })],
  ] as const) {
    assert.doesNotMatch(
      prompt,
      /already been verified to exist|existence is already verified/i,
      `${variant} must not claim mechanical verification for a plan with no read-only task`,
    );
  }

  // The MIXED plan: some reports were verified, some were not. The claim must
  // name which — an unqualified "verified" would overstate it, and no claim at
  // all would waste evidence the product did produce.
  const mixedPlan: RunPlan = {
    summary: "mixed fixture plan",
    recommendedConcurrency: 1,
    tasks: [
      { id: "inspect", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: ["test"], kind: "diagnostic", permission: "read_only", risk: "low" },
      { id: "build", title: "Build it", description: "Build it", dependencies: [], preferredProvider: null, checks: ["test"], kind: "implementation", permission: "workspace_write", risk: "medium" },
    ],
  };
  for (const [variant, prompt] of [
    ["tool-holding", reviewerPrompt({ goal: "Ship it", constitution: "Evidence first", plan: mixedPlan, checkSummary: "test: PASS", taskReports: "inspect: done", workspacePath: "C:/fixture", autonomy: "bounded" })],
    ["context-only", localReviewerContextHeader({ goal: "Ship it", constitution: "Evidence first", plan: mixedPlan, checkSummary: "test: PASS", taskReports: "inspect: done", autonomy: "bounded" })],
  ] as const) {
    assert.match(prompt, /verified to exist for the read-only tasks \(inspect\)/i, `${variant} names which reports were verified`);
    assert.match(prompt, /remaining tasks carry no such verification/i, `${variant} says the rest were not`);
    assert.match(prompt, /supports? the conclusion/i, `${variant} still carries the support duty`);
  }
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

  // A diagnostic whose acceptance criteria never mention line evidence used to
  // accept a report with no citations at all — the citation verifier had
  // nothing to check, so a purely rhetorical report passed the gate outright.
  // A read-only diagnostic's citations ARE its evidence: with no repository
  // change for validators to judge, a report grounded in nothing is not a
  // diagnostic, however fluent. Every diagnostic must cite at least one
  // verifiable location.
  const unphrased = { ...task, acceptanceCriteria: ["Summarize the repository's licensing posture"] };
  assert.match(
    validateDiagnosticResult(unphrased, "The licensing posture is broadly permissive and well maintained, with contributor expectations that appear consistent across the project and no obvious conflicts in spirit or intent anywhere.") ?? "",
    /cite|path:line/i,
    "a vacuous report must not pass merely because the criteria forgot to demand evidence",
  );
  // The SOLE citation is an extensionless canonical file. An earlier version of
  // this test put README.md:12 beside it, so it passed while LICENSE:1 was
  // silently unparseable — an audit proved the gate rejected a real LICENSE:1
  // report outright, before the verifier ever saw it. LICENSE, Dockerfile,
  // Makefile, CODEOWNERS and their kin are ordinary primary sources for exactly
  // the reports this gate exists to check.
  assert.equal(
    validateDiagnosticResult(unphrased, "LICENSE:1 declares the Apache License 2.0 for this repository, and that single legal text governs the entire posture with no competing grant anywhere else."),
    null,
    "a real extensionless canonical file is a citation on its own",
  );
  assert.deepEqual(
    extractCitations("Dockerfile:12 pins the base image and Makefile:5 rebuilds it; CODEOWNERS:2 assigns review.").map((item) => item.citation).sort(),
    ["CODEOWNERS:2", "Dockerfile:12", "Makefile:5"],
    "canonical extensionless names are extracted and handed to the verifier",
  );
  // A dotted DIRECTORY before an extensionless file. The generic alternative
  // could match `.github` and stop, leaving the real filename to be swallowed by
  // the link's trailing wildcard — so the citation either vanished or resolved
  // to a directory. `.github/CODEOWNERS` is where CODEOWNERS actually lives.
  assert.deepEqual(
    extractCitations("[owners](.github/CODEOWNERS:2) assigns review.").map((item) => item.citation),
    [".github/CODEOWNERS:2"],
    "a linked path whose directory is dotted keeps its extensionless filename",
  );
  assert.deepEqual(
    extractCitations("See [owners](.github/CODEOWNERS), line 2 for review assignment.").map((item) => item.citation),
    [".github/CODEOWNERS:2"],
    "and the same path with the line in nearby prose",
  );
  assert.deepEqual(
    extractCitations("[release](.github/workflows/release.yml:13) sets the default ref.").map((item) => item.citation),
    [".github/workflows/release.yml:13"],
    "ordinary extensioned files under dotted directories still parse",
  );
  // Prose that merely looks like a citation must stay out: extracting it would
  // fail verification and reject a real report.
  assert.deepEqual(extractCitations("The scanner returned ERROR:404 and ISO:9001 was cited.").map((item) => item.citation), []);
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

test("paid reservation lifecycle reclaims pre-invocation leases and atomically settles bound receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-openrouter-lifecycle-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const config = structuredClone(defaultConfig);
    config.openRouter = { enabled: true, allowPaidFallback: true, perRunLimitUsd: 0.005, monthlyLimitUsd: 0.01 };
    config.runPolicy.allowPaidApi = true;
    const service = new OpenRouterService(ledger, {} as any);
    (service as any).status = async () => ({ connected: true, key: { limit_remaining: 10 } });
    const runId = ledger.createRun("Paid lifecycle fixture", root);

    const abandonedBeforeInvocation = await service.acquirePaidRouting(config, runId, 0.004);
    (ledger as any).database.prepare("UPDATE paid_spend_reservations SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", abandonedBeforeInvocation.id);
    const replacement = await service.acquirePaidRouting(config, runId, 0.004);
    replacement.cancelBeforeInvocation();
    assert.equal(Number((ledger as any).database.prepare("SELECT COUNT(*) AS count FROM paid_spend_reservations").get().count), 0);

    const invoked = await service.acquirePaidRouting(config, runId, 0.004);
    invoked.markInvoked();
    ledger.recordInvocationReceipt({ runId, role: "architect", provider: "openrouter", connectionId: "api:openrouter", resolvedModelId: "api:openrouter:model:lifecycle", costUsd: 0.004, paidSpendReservationId: invoked.id });
    assert.equal(ledger.getRunSpendUsd(runId), 0.004);
    assert.equal(Number((ledger as any).database.prepare("SELECT COUNT(*) AS count FROM paid_spend_reservations").get().count), 0, "the bound receipt and reservation must settle in one transaction");
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
          paidSpendReservationId: consultation.paidSpendReservationId,
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

test("approved delivery pushes the exact reviewed branch before creating a draft PR and never merges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-delivery-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner = async (request: { command: string; args: string[]; cwd: string }) => {
    commands.push({ command: request.command, args: [...request.args], cwd: request.cwd });
    if (request.command === "git" && request.args.join(" ") === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/example.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args.includes("create")) {
      return { stdout: "https://github.com/civicsuite/example/pull/42\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };
  try {
    const runId = ledger.createRun("Deliver the reviewed branch", root);
    ledger.setRunStatus(runId, "running");
    ledger.setRunStatus(runId, "ready", "READY");
    ledger.prepareDeliveryRepository({
      runId,
      repositoryId: "repo:example",
      localPath: root,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      branch: "devharmonics/12345678",
    });
    const service = new DeliveryService(ledger, runner as never);
    const config = structuredClone(defaultConfig);
    const approval = { id: "approval-push", kind: "external_write" as const, approvedBy: "local-owner", approvedAt: new Date().toISOString() };

    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "push_branch", config, approval }),
      /external writes are disabled/i,
    );
    config.runPolicy.allowExternalWrites = true;
    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "create_draft_pr", config, approval: { ...approval, id: "approval-pr" } }),
      /push the reviewed branch first/i,
    );

    const pushed = await service.execute({ runId, repositoryId: "repo:example", action: "push_branch", config, approval });
    assert.equal(pushed.status, "branch_pushed");
    assert.equal(pushed.remoteUrl, "https://github.com/civicsuite/example");
    assert.deepEqual(commands.at(-1), {
      command: "git",
      args: ["push", "origin", `${"b".repeat(40)}:refs/heads/devharmonics/12345678`],
      cwd: root,
    });

    const delivered = await service.execute({ runId, repositoryId: "repo:example", action: "create_draft_pr", config, approval: { ...approval, id: "approval-pr" } });
    assert.equal(delivered.status, "draft_pr_created");
    assert.equal(delivered.pullRequestUrl, "https://github.com/civicsuite/example/pull/42");
    assert.ok(commands.some((item) => item.command === "gh" && item.args.includes("--draft") && item.args.includes("--head") && item.args.includes("devharmonics/12345678")));
    assert.equal(commands.some((item) => item.args.includes("merge")), false, "push and draft-PR actions never merge implicitly — merging is its own owner-receipted action");
    assert.deepEqual(ledger.listToolPolicyReceipts(runId).filter((item) => item.outcome === "allow").map((item) => item.approvalId), ["approval-push", "approval-pr"]);
    assert.equal(ledger.getRun(runId)?.delivery?.repositories[0]?.headCommit, "b".repeat(40));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
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

test("a \${repoRoot} token in a validator command expands to the repository root", async () => {
  // A registered validator that needs the repository's own toolchain — a venv
  // interpreter, a repo-local node_modules binary — cannot be written as a bare
  // command (wrong or missing on PATH) and must not be registered as an absolute
  // machine path (breaks on every other machine). The token names the one thing
  // both machines agree on: where the repository lives. It expands against the
  // PRIMARY repository root, not the task worktree, because per-machine
  // toolchains are gitignored and exist only in the primary checkout.
  const validators = {
    tests: { command: "${repoRoot}/.venv/Scripts/python.exe", args: ["-m", "pytest", "-q"], timeoutMs: 60_000 },
    lint: { command: "ruff", args: ["check", "${repoRoot}/pyproject.toml"], timeoutMs: 60_000 },
  };
  const expanded = expandValidatorTokens(validators, "C:\repos\civiccode");
  assert.equal(expanded.tests!.command, path.join("C:\repos\civiccode", ".venv/Scripts/python.exe"));
  assert.deepEqual(expanded.tests!.args, ["-m", "pytest", "-q"]);
  assert.deepEqual(expanded.lint!.args, ["check", path.join("C:\repos\civiccode", "pyproject.toml")]);
  // Untouched entries come through identical, and the input is not mutated.
  assert.equal(validators.tests.command, "${repoRoot}/.venv/Scripts/python.exe");

  // A token with no root to expand against must fail loudly. Expanding it to
  // nothing, or to the worktree, silently runs the wrong interpreter.
  assert.throws(() => expandValidatorTokens(validators, null), /repoRoot/);

  // The multi-repository merge: registered validators override the project's
  // own, and their token expands against THAT repository's primary root.
  const merged = mergeRepositoryValidators(
    { tests: { command: "python", args: ["-m", "pytest"], timeoutMs: 1_000 }, extra: { command: "echo", args: [], timeoutMs: 1_000 } },
    { tests: { command: "${repoRoot}/.venv/Scripts/python.exe", args: ["-m", "pytest", "-q"], timeoutMs: 2_000 } },
    "D:\elsewhere\repo",
  );
  assert.equal(merged.tests!.command, path.join("D:\elsewhere\repo", ".venv/Scripts/python.exe"), "registered wins and expands against the repository's own root");
  assert.equal(merged.extra!.command, "echo", "project validators without an override survive");

  // End to end: the expanded command actually runs from a worktree-like cwd.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-token-e2e-"));
  try {
    const repo = path.join(root, "primary repo");
    const bin = path.join(repo, "toolbin");
    await mkdir(bin, { recursive: true });
    const script = path.join(bin, "tool.mjs");
    await writeFile(script, ["console.log('TOKEN_TOOL_RAN'); process.exit(0);", ""].join("\n"), "utf8");
    const worktree = path.join(root, "worktree");
    await mkdir(worktree, { recursive: true });
    const config = expandValidatorTokens({
      probe: { command: process.execPath, args: ["${repoRoot}/toolbin/tool.mjs"], timeoutMs: 10_000 },
    }, repo);
    const result = await runValidator("probe", config.probe!, worktree);
    assert.equal(result.passed, true, result.stderr);
    assert.match(result.stdout, /TOKEN_TOOL_RAN/);

    // The two PRODUCTION wiring points, exercised as production runs them. An
    // audit reverted both while every test above stayed green, because only the
    // helpers were covered — the exact seam-instead-of-shipping-path mistake
    // this branch was supposed to have learned from.
    //
    // 1. A project's own config: loadConfig must return it expanded.
    const project = path.join(root, "token project");
    await initializeProject(project);
    const projectConfig = await loadConfig(project);
    projectConfig.repository.validators = {
      probe: { command: "${repoRoot}/toolbin/tool.mjs", args: ["--flag", "${repoRoot}/pyproject.toml"], timeoutMs: 10_000 },
    };
    await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(projectConfig, null, 2)}
`, "utf8");
    const loaded = await loadConfig(project);
    assert.equal(loaded.repository.validators.probe!.command, path.join(project, "toolbin/tool.mjs"), "loadConfig returns the project's validators expanded against the project root");
    assert.equal(loaded.repository.validators.probe!.args[1], path.join(project, "pyproject.toml"), "arguments expand too");

    // 2. The multi-repository context: registered validators expand against the
    // REGISTERED repository's root, not the run's own project root.
    const registeredRepo = path.join(root, "registered repo");
    await initializeProject(registeredRepo);
    const context = await buildRepositoryContext(loaded, {
      localPath: registeredRepo,
      validators: { tests: { command: "${repoRoot}/.venv/Scripts/python.exe", args: ["-m", "pytest"], timeoutMs: 10_000 } },
    });
    assert.equal(
      context.config.repository.validators.tests!.command,
      path.join(registeredRepo, ".venv/Scripts/python.exe"),
      "the repository context carries the registered validator expanded against that repository's own root",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    assert.equal((evidence as unknown as { version: number } | null)?.version, 5);
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
  assert.deepEqual(requirement, { risk: "high", requiredReviewers: 2, minimumDistinctProviders: 2, requireImplementorIndependence: true, requiredLenses: ["artifact", "claims"] });

  const ready = reviewModule.parseReviewerResponse("READY\nNo material findings.", { provider: "claude", modelId: "sonnet", connectionId: "claude", lens: "artifact" });
  assert.equal(ready.verdict, "READY");
  assert.deepEqual(ready.findings, []);
  const notReady = reviewModule.parseReviewerResponse(`NOT READY\n\n\`\`\`json\n{"findings":[{"severity":"high","location":"src/a.ts:7","rationale":"Unsafe bypass remains.","suggestedCorrection":"Remove the bypass.","disposition":"open"}]}\n\`\`\``, { provider: "codex", modelId: "terra", connectionId: "codex" });
  assert.equal(notReady.verdict, "NOT_READY");
  assert.equal(notReady.findings[0].location, "src/a.ts:7");

  const passing = reviewModule.adjudicateReviewQuorum({
    requirement,
    implementationProviders: ["codex"],
    reviews: [ready, reviewModule.parseReviewerResponse(`READY\nClaims cohere.\n\`\`\`json\n{"findings":[],"claimedChanges":[]}\n\`\`\``, { provider: "gemini", modelId: "gemini-pro", connectionId: "gemini", lens: "claims" })],
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
        lens: null,
        claimedChanges: null,
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
    assert.equal(evidence.version, 5);
    assert.equal(evidence.reviews[0].id, reviewId);
    assert.ok(evidence.reviews[0].invalidatedAt);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review lens coverage is a quorum dimension and receipts record the lens", async () => {
  const reviewModule = await import("../src/review.js") as Record<string, any>;

  assert.deepEqual(defaultConfig.reviewPolicy.requiredLensesByRisk, {
    low: ["artifact"],
    medium: ["artifact"],
    high: ["artifact", "claims"],
  }, "DH-460 requires lens coverage defaults by risk; lens count never exceeds reviewer count");

  const unsatisfiable = devHarmonicsConfigSchema.shape.reviewPolicy.safeParse({
    reviewerCountByRisk: { low: 1, medium: 1, high: 2 },
    minimumDistinctProvidersByRisk: { low: 1, medium: 1, high: 2 },
    requireImplementorIndependenceByRisk: { low: false, medium: true, high: true },
    requiredLensesByRisk: { low: ["artifact"], medium: ["artifact", "claims"], high: ["artifact", "claims"] },
    maxFixRounds: 2,
  });
  assert.equal(unsatisfiable.success, false, "a policy demanding more lenses than reviewers is refused at parse time");

  // Codex F-007: the sibling cardinality invariant — providers, same rule.
  const unsatisfiableProviders = devHarmonicsConfigSchema.shape.reviewPolicy.safeParse({
    reviewerCountByRisk: { low: 1, medium: 1, high: 2 },
    minimumDistinctProvidersByRisk: { low: 2, medium: 1, high: 2 },
    requireImplementorIndependenceByRisk: { low: false, medium: true, high: true },
    requiredLensesByRisk: { low: ["artifact"], medium: ["artifact"], high: ["artifact", "claims"] },
    maxFixRounds: 2,
  });
  assert.equal(unsatisfiableProviders.success, false, "a policy demanding more distinct providers than reviewers is refused at parse time");

  const legacyPolicy = devHarmonicsConfigSchema.shape.reviewPolicy.parse({
    reviewerCountByRisk: { low: 1, medium: 1, high: 2 },
    minimumDistinctProvidersByRisk: { low: 1, medium: 1, high: 2 },
    requireImplementorIndependenceByRisk: { low: false, medium: true, high: true },
    maxFixRounds: 2,
  });
  assert.deepEqual(legacyPolicy.requiredLensesByRisk.high, ["artifact", "claims"], "a config written before lenses existed still parses with lens defaults");

  const requirement = reviewModule.reviewRequirement([{ id: "critical", risk: "high" }], defaultConfig.reviewPolicy);
  assert.deepEqual(requirement.requiredLenses, ["artifact", "claims"]);

  const artifactReady = reviewModule.parseReviewerResponse("READY\nNo material findings.", { provider: "claude", modelId: "sonnet", connectionId: "claude", lens: "artifact" });
  assert.equal(artifactReady.lens, "artifact");
  const claimsReady = reviewModule.parseReviewerResponse(`READY\nClaims cohere with receipts.\n\`\`\`json\n{"findings":[],"claimedChanges":[]}\n\`\`\``, { provider: "gemini", modelId: "gemini-pro", connectionId: "gemini", lens: "claims" });

  const singleLens = reviewModule.adjudicateReviewQuorum({
    requirement,
    implementationProviders: ["codex"],
    reviews: [artifactReady, { ...artifactReady, provider: "gemini", connectionId: "gemini" }],
  });
  assert.equal(singleLens.passed, false, "two reviews through one lens must not satisfy a two-lens requirement");
  assert.equal(singleLens.singleLens, true);
  assert.match(singleLens.reasons.join(" "), /lens/i);

  const covered = reviewModule.adjudicateReviewQuorum({
    requirement,
    implementationProviders: ["codex"],
    reviews: [artifactReady, claimsReady],
  });
  assert.equal(covered.passed, true);
  assert.equal(covered.singleLens, false);
  assert.deepEqual([...covered.lensesCovered].sort(), ["artifact", "claims"]);

  const undeclared = reviewModule.parseReviewerResponse("READY\nOk.", { provider: "ollama", connectionId: "ollama" });
  assert.equal(undeclared.lens, null, "a review that never declared a lens records none");
  const withUndeclared = reviewModule.adjudicateReviewQuorum({ requirement, implementationProviders: ["codex"], reviews: [artifactReady, undeclared] });
  assert.equal(withUndeclared.passed, false, "an undeclared lens covers nothing");
  assert.match(withUndeclared.reasons.join(" "), /claims/i);

  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-review-lens-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & Record<string, any>;
  try {
    const runId = ledger.createRun("Lens receipts", root);
    const evidenceBinding = createReviewEvidenceBinding({ autonomy: "bounded", plan: { summary: "lens", recommendedConcurrency: 1, tasks: [] }, taskReports: "", diff: [], checks: [], repositories: [{ repositoryId: root, baseCommit: "base", headCommit: "head" }] });
    ledger.recordReviewReceipt({ runId, round: 1, integrationSha256: reviewEvidenceBindingSha256(evidenceBinding), evidenceBinding, review: { ...artifactReady, findings: [] } });
    ledger.recordReviewReceipt({
      runId,
      round: 1,
      integrationSha256: reviewEvidenceBindingSha256(evidenceBinding),
      evidenceBinding,
      review: { verdict: "READY", provider: "ollama", modelId: null, connectionId: "ollama", summary: "No lens declared.", rawText: "READY", findings: [], lens: null, claimedChanges: null },
    });
    const receipts = ledger.listReviewReceipts(runId);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]!.lens, "artifact", "the receipt must retain which lens produced the review");
    assert.equal(receipts[1]!.lens, null);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review lens bundles decorrelate what each reviewer is shown", async () => {
  const promptsModule = await import("../src/prompts.js") as Record<string, any>;
  const reviewModule = await import("../src/review.js") as Record<string, any>;

  assert.equal(typeof reviewModule.lensForSlot, "function", "DH-460 requires deterministic lens assignment");
  assert.equal(reviewModule.lensForSlot(["artifact", "claims"], 1), "artifact");
  assert.equal(reviewModule.lensForSlot(["artifact", "claims"], 2), "claims");
  assert.equal(reviewModule.lensForSlot(["artifact", "claims"], 3), "artifact");
  assert.equal(reviewModule.lensForSlot([], 1), null);

  assert.equal(typeof reviewModule.applicableReviewLenses, "function", "observe runs have no artifact to review");
  assert.deepEqual(reviewModule.applicableReviewLenses({ requiredLenses: ["artifact", "claims"] }, "observe"), ["claims"]);
  assert.deepEqual(reviewModule.applicableReviewLenses({ requiredLenses: ["artifact", "claims"] }, "bounded"), ["artifact", "claims"]);

  const plan = { summary: "lens bundles", recommendedConcurrency: 1, tasks: [] };
  const narrationSentinel = "NARRATION-SENTINEL-73f1";
  const workspaceSentinel = "C:/sentinel/integration-worktree";
  const common = { goal: "Ship the lens", constitution: "Be honest.", plan, checkSummary: "checks: 1 passed", autonomy: "bounded" };

  const artifactPrompt = promptsModule.reviewerPrompt({ ...common, taskReports: narrationSentinel, workspacePath: workspaceSentinel, lens: "artifact" });
  assert.ok(!artifactPrompt.includes(narrationSentinel), "the artifact lens must not see implementor narration");
  assert.ok(artifactPrompt.includes(workspaceSentinel), "the artifact lens keeps the worktree");
  assert.match(artifactPrompt, /withheld/i);

  const legacyPrompt = promptsModule.reviewerPrompt({ ...common, taskReports: narrationSentinel, workspacePath: workspaceSentinel });
  assert.ok(legacyPrompt.includes(narrationSentinel), "an unassigned lens keeps today's combined bundle");

  const claimsHeader = promptsModule.claimsReviewerContextHeader(common);
  assert.ok(!claimsHeader.includes(workspaceSentinel), "the claims lens must not learn the worktree location");
  assert.match(claimsHeader, /no repository access|do not have repository/i);
  assert.match(claimsHeader, /claimedChanges/, "the claims lens must be contracted to return a claimed-changes manifest");

  const claimsChunks = promptsModule.claimsReviewChunks(narrationSentinel);
  assert.ok(claimsChunks.length >= 1);
  assert.ok(claimsChunks[0].content.includes(narrationSentinel), "the claims lens reviews the narration itself");

  const artifactHeader = promptsModule.localReviewerContextHeader({ ...common, taskReports: narrationSentinel, lens: "artifact" });
  assert.ok(!artifactHeader.includes(narrationSentinel), "a tool-less artifact-lens reviewer is narration-free too");
});

test("claims/artifact divergence is a deterministic fail-closed finding", async () => {
  const reviewModule = await import("../src/review.js") as Record<string, any>;

  // The claims lens returns a structured manifest inside the same fenced JSON.
  const claims = reviewModule.parseReviewerResponse(
    `READY\nClaims cohere.\n\`\`\`json\n{"findings":[],"claimedChanges":[{"path":"src\\\\alpha.ts","kind":"modified","taskId":"t1"},{"path":"src/beta.ts","kind":"created","taskId":"t2"}]}\n\`\`\``,
    { provider: "gemini", modelId: "gemini-pro", connectionId: "gemini", lens: "claims" },
  );
  assert.deepEqual(claims.claimedChanges, [
    { path: "src/alpha.ts", kind: "modified", taskId: "t1" },
    { path: "src/beta.ts", kind: "created", taskId: "t2" },
  ], "manifest paths are normalized and retained");
  const noManifest = reviewModule.parseReviewerResponse("READY\nOk.", { provider: "gemini", connectionId: "gemini", lens: "claims" });
  assert.equal(noManifest.claimedChanges, null, "an absent manifest is not an empty manifest");

  // Codex F-002: a syntactically present but structurally invalid manifest must
  // not masquerade as a valid empty one — invalid entries fail the whole
  // manifest closed, exactly like absence.
  const malformed = reviewModule.parseReviewerResponse(
    `READY\nOk.\n\`\`\`json\n{"findings":[],"claimedChanges":[{}]}\n\`\`\``,
    { provider: "gemini", connectionId: "gemini", lens: "claims" },
  );
  assert.equal(malformed.claimedChanges, null, "an invalid manifest entry poisons the manifest");
  const partiallyMalformed = reviewModule.parseReviewerResponse(
    `READY\nOk.\n\`\`\`json\n{"claimedChanges":[{"path":"src/a.ts","kind":"modified","taskId":"t1"},{"kind":"modified"}]}\n\`\`\``,
    { provider: "gemini", connectionId: "gemini", lens: "claims" },
  );
  assert.equal(partiallyMalformed.claimedChanges, null, "a partially invalid manifest fails closed too");

  // Codex R2-003: exact grammar, no coercion — an unknown kind is not
  // "modified", and a missing task attribution is not an unattributed claim.
  const badKind = reviewModule.parseReviewerResponse(
    `READY\nOk.\n\`\`\`json\n{"claimedChanges":[{"path":"src/a.ts","kind":"renamed","taskId":"t1"}]}\n\`\`\``,
    { provider: "gemini", connectionId: "gemini", lens: "claims" },
  );
  assert.equal(badKind.claimedChanges, null, "an unrecognized kind invalidates the manifest");
  const missingTask = reviewModule.parseReviewerResponse(
    `READY\nOk.\n\`\`\`json\n{"claimedChanges":[{"path":"src/a.ts","kind":"modified"}]}\n\`\`\``,
    { provider: "gemini", connectionId: "gemini", lens: "claims" },
  );
  assert.equal(missingTask.claimedChanges, null, "a claim without its claiming task invalidates the manifest");

  assert.equal(typeof reviewModule.claimsArtifactDivergence, "function", "DH-460 requires the deterministic divergence gate");

  // Exact agreement: no findings.
  const agree = reviewModule.claimsArtifactDivergence({
    reviews: [claims],
    diffPaths: ["src/alpha.ts", "src\\beta.ts"],
    passedTaskIds: new Set(["t1", "t2"]),
  });
  assert.deepEqual(agree, []);

  // A claimed change absent from the diff fails closed (defect-22 class),
  // even when the diff is nonempty.
  const phantom = reviewModule.claimsArtifactDivergence({
    reviews: [claims],
    diffPaths: ["src/alpha.ts"],
    passedTaskIds: new Set(["t1", "t2"]),
  });
  assert.equal(phantom.length, 1);
  assert.equal(phantom[0].severity, "high");
  assert.match(phantom[0].rationale, /src\/beta\.ts/);
  assert.match(phantom[0].rationale, /t2/);
  assert.equal(phantom[0].disposition, "open");

  // A claim from a task that never passed is a fallback echo, not a divergence.
  const failedTask = reviewModule.claimsArtifactDivergence({
    reviews: [claims],
    diffPaths: ["src/alpha.ts"],
    passedTaskIds: new Set(["t1"]),
  });
  assert.deepEqual(failedTask, []);

  // An integrated change nobody claimed is an unexplained change.
  const unexplained = reviewModule.claimsArtifactDivergence({
    reviews: [claims],
    diffPaths: ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"],
    passedTaskIds: new Set(["t1", "t2"]),
  });
  assert.equal(unexplained.length, 1);
  assert.equal(unexplained[0].severity, "medium");
  assert.match(unexplained[0].rationale, /src\/gamma\.ts/);

  // Divergence findings and a manifest-less claims review both block the quorum.
  const requirement = { risk: "high", requiredReviewers: 2, minimumDistinctProviders: 2, requireImplementorIndependence: false, requiredLenses: ["artifact", "claims"] };
  const artifactReady = reviewModule.parseReviewerResponse("READY\nArtifact holds.", { provider: "claude", modelId: "sonnet", connectionId: "claude", lens: "artifact" });
  const blocked = reviewModule.adjudicateReviewQuorum({
    requirement,
    implementationProviders: [],
    reviews: [artifactReady, claims],
    divergence: phantom,
  });
  assert.equal(blocked.passed, false);
  assert.match(blocked.reasons.join(" "), /divergence/i);
  assert.equal(blocked.openFindings.some((finding: any) => finding.id === phantom[0].id), true);

  const manifestLess = reviewModule.adjudicateReviewQuorum({
    requirement,
    implementationProviders: [],
    reviews: [artifactReady, noManifest],
  });
  assert.equal(manifestLess.passed, false, "a claims-lens review without a manifest cannot support a pass");
  assert.match(manifestLess.reasons.join(" "), /manifest/i);

  // Observe runs have no artifact, so the manifest requirement is waived there.
  const observeWaived = reviewModule.adjudicateReviewQuorum({
    requirement: { ...requirement, requiredLenses: ["claims"], requiredReviewers: 1, minimumDistinctProviders: 1 },
    implementationProviders: [],
    reviews: [noManifest],
    expectClaimsManifest: false,
  });
  assert.equal(observeWaived.passed, true, "an observe review is not failed for a manifest it was never asked for");
});

test("adaptive routing prefers the cheapest candidate at established empirical parity", async () => {
  const routingModule = await import("../src/routing.js") as Record<string, any>;
  assert.equal(typeof routingModule.preferCheapestAtParity, "function", "DH-320 requires the parity preference");

  const established = (rate: number) => ({ eligibleForAdaptiveWeighting: true, firstAttemptSuccessRate: rate, sampleSize: 40 });
  const guards = { tierFit: 6, reasoningFit: 2, userPin: 0, preferredProvider: 0, fallbackProvider: 0, empiricalLatency: 0, providerDiversity: 0 };
  const premium = { id: "premium-model", provider: "claude", pinned: false, unitCostUsd: 12, empiricalWorkload: established(0.96), breakdown: { ...guards } };
  const budget = { id: "budget-model", provider: "codex", pinned: false, unitCostUsd: 1.5, empiricalWorkload: established(0.94), breakdown: { ...guards } };

  // Parity within tolerance: the cheaper candidate displaces the top.
  const displaced = routingModule.preferCheapestAtParity([premium, budget]);
  assert.equal(displaced?.id, "budget-model");

  // A real quality gap is not parity.
  const weaker = { ...budget, empiricalWorkload: established(0.7) };
  assert.equal(routingModule.preferCheapestAtParity([premium, weaker]), null);

  // An emerging record cannot claim parity.
  const emerging = { ...budget, empiricalWorkload: { ...established(0.94), eligibleForAdaptiveWeighting: false } };
  assert.equal(routingModule.preferCheapestAtParity([premium, emerging]), null);

  // A pinned top is the user's decision, not the router's.
  const pinnedTop = { ...premium, pinned: true };
  assert.equal(routingModule.preferCheapestAtParity([pinnedTop, budget]), null);

  // Unknown prices produce no preference rather than an invented one.
  const unpriced = { ...budget, unitCostUsd: null };
  assert.equal(routingModule.preferCheapestAtParity([premium, unpriced]), null);

  // A diversity-boosted top is not displaced by a same-provider bargain.
  const diverseTop = { ...premium, breakdown: { ...guards, providerDiversity: 8 } };
  assert.equal(routingModule.preferCheapestAtParity([diverseTop, budget]), null);

  // A materially slower model is not at parity, whatever its success rate.
  const slower = { ...budget, breakdown: { ...guards, empiricalLatency: -2 } };
  assert.equal(routingModule.preferCheapestAtParity([premium, slower]), null);

  // Neither is one whose reasoning-effort setting fits the workload worse.
  const worseFit = { ...budget, breakdown: { ...guards, reasoningFit: 0 } };
  assert.equal(routingModule.preferCheapestAtParity([premium, worseFit]), null);

  // A soft provider-affinity nudge does NOT shield a pricier top — that is
  // the one place the parity rule can fire at all once cost is in the score.
  const preferredTop = { ...premium, breakdown: { ...guards, preferredProvider: 8 } };
  assert.equal(routingModule.preferCheapestAtParity([preferredTop, budget])?.id, "budget-model");

  // Codex R2-002: a DIRECTED provider — architect-planned or owner-reassigned —
  // is a hard constraint. Parity never routes off it to another provider...
  assert.equal(routingModule.preferCheapestAtParity([premium, budget], { preferredProvider: "claude" }), null, "an owner's provider choice is not advisory");
  // ...but a cheaper model on the SAME directed provider may still win...
  const budgetSameProvider = { ...budget, id: "budget-claude", provider: "claude" };
  assert.equal(routingModule.preferCheapestAtParity([premium, budgetSameProvider], { preferredProvider: "claude" })?.id, "budget-claude");
  // ...and direction toward a provider the top doesn't hold constrains nothing.
  assert.equal(routingModule.preferCheapestAtParity([premium, budget], { preferredProvider: "gemini" })?.id, "budget-model");

  // Codex F-008: pin the exact tolerance boundary so the constant cannot
  // drift unnoticed — exactly 0.05 is parity, 0.0501 is not.
  assert.equal(routingModule.PARITY_SUCCESS_RATE_TOLERANCE, 0.05);
  const atBoundary = { ...budget, empiricalWorkload: established(0.96 - 0.05) };
  assert.equal(routingModule.preferCheapestAtParity([premium, atBoundary])?.id, "budget-model", "exactly the tolerance is parity");
  const pastBoundary = { ...budget, empiricalWorkload: established(0.96 - 0.0501) };
  assert.equal(routingModule.preferCheapestAtParity([premium, pastBoundary]), null, "just past the tolerance is not");
});

test("per-run cost counterfactual is an estimate from receipts, honest-absent without prices", async () => {
  const performanceModule = await import("../src/model-performance.js") as Record<string, any>;
  assert.equal(typeof performanceModule.runCostCounterfactual, "function", "DH-650 requires the cost counterfactual");

  const receipts = [
    { role: "worker", inputTokens: 100_000, outputTokens: 20_000, costUsd: 0.5 },
    { role: "worker", inputTokens: 50_000, outputTokens: 10_000, costUsd: 0.25 },
    { role: "reviewer", inputTokens: 30_000, outputTokens: 5_000, costUsd: 0.6 },
  ];
  const priciest = {
    worker: [
      { modelId: "cheap-w", displayName: "Cheap W", promptPriceUsdPerMTokens: 1, completionPriceUsdPerMTokens: 2 },
      { modelId: "premium-w", displayName: "Premium W", promptPriceUsdPerMTokens: 15, completionPriceUsdPerMTokens: 75 },
    ],
    reviewer: [{ modelId: "premium-r", displayName: "Premium R", promptPriceUsdPerMTokens: 10, completionPriceUsdPerMTokens: 40 }],
  };
  const result = performanceModule.runCostCounterfactual({ receipts, candidatesByRole: priciest });
  assert.equal(result.actualUsd, 1.35);
  assert.equal(result.counterfactualUsd, 5);
  assert.equal(result.byRole.find((entry: any) => entry.role === "worker").comparisonModelId, "premium-w");
  assert.equal(result.estimate, true, "the counterfactual is labeled an estimate");
  assert.deepEqual(result.excludedRoles, []);
  assert.equal(result.unprojectedUsd, 0);

  // Both sides of the comparison cover the SAME invocations: a role without a
  // comparator drops out of the actual side too, and its spend is reported
  // separately rather than skewing the pair.
  const partial = performanceModule.runCostCounterfactual({ receipts, candidatesByRole: { worker: priciest.worker } });
  assert.deepEqual(partial.excludedRoles, ["reviewer"], "a role without a priced comparator is named, not invented");
  assert.equal(partial.counterfactualUsd, 4.5);
  assert.equal(partial.actualUsd, 0.75, "the actual side is scoped to the invocations the counterfactual covers");
  assert.equal(partial.unprojectedUsd, 0.6, "excluded spend is visible, not vanished");

  // Within a role, a receipt with cost but no token counts cannot be projected:
  // it leaves both sides of the pair and lands in unprojectedUsd.
  const mixed = performanceModule.runCostCounterfactual({
    receipts: [
      { role: "worker", inputTokens: 100_000, outputTokens: 20_000, costUsd: 0.5 },
      { role: "worker", inputTokens: null, outputTokens: null, costUsd: 0.3 },
    ],
    candidatesByRole: priciest,
  });
  assert.equal(mixed.actualUsd, 0.5);
  assert.equal(mixed.counterfactualUsd, 3);
  assert.equal(mixed.unprojectedUsd, 0.3);

  // Codex F-004a: known tokens with UNKNOWN billed cost must not appear as a
  // $0 actual — the receipt leaves the pair and is counted, not invented.
  const unpriced2 = performanceModule.runCostCounterfactual({
    receipts: [
      { role: "worker", inputTokens: 100_000, outputTokens: 20_000, costUsd: 0.5 },
      { role: "worker", inputTokens: 10_000, outputTokens: 2_000, costUsd: null },
    ],
    candidatesByRole: priciest,
  });
  assert.equal(unpriced2.actualUsd, 0.5);
  assert.equal(unpriced2.counterfactualUsd, 3, "the counterfactual side is scoped to the same paired receipts");
  assert.equal(unpriced2.unknownCostReceipts, 1, "unknown billed cost is counted, never presented as zero");
  assert.equal(
    performanceModule.runCostCounterfactual({ receipts: [{ role: "worker", inputTokens: 100_000, outputTokens: 20_000, costUsd: null }], candidatesByRole: priciest }),
    null,
    "a run whose only receipts have unknown cost has no honest pair to show",
  );

  // Codex F-004b: sub-cent spends must never produce negative unprojected
  // spend from per-role rounding.
  const subCent = performanceModule.runCostCounterfactual({
    receipts: [
      { role: "worker", inputTokens: 1_000, outputTokens: 100, costUsd: 0.00006 },
      { role: "reviewer", inputTokens: 1_000, outputTokens: 100, costUsd: 0.00006 },
    ],
    candidatesByRole: priciest,
  });
  assert.ok(subCent.unprojectedUsd >= 0, "rounding must not invent negative unprojected spend");

  // Codex F-003: "priciest" means priciest FOR THIS RUN'S TOKEN MIX, not the
  // highest summed rate card. An output-heavy role must pick the
  // output-expensive comparator.
  const asymmetric = performanceModule.runCostCounterfactual({
    receipts: [{ role: "worker", inputTokens: 0, outputTokens: 1_000_000, costUsd: 0.1 }],
    candidatesByRole: {
      worker: [
        { modelId: "input-expensive", displayName: "In-heavy", promptPriceUsdPerMTokens: 100, completionPriceUsdPerMTokens: 0 },
        { modelId: "output-expensive", displayName: "Out-heavy", promptPriceUsdPerMTokens: 0, completionPriceUsdPerMTokens: 90 },
      ],
    },
  });
  assert.equal(asymmetric.byRole[0].comparisonModelId, "output-expensive");
  assert.equal(asymmetric.counterfactualUsd, 90);

  assert.equal(performanceModule.runCostCounterfactual({ receipts, candidatesByRole: {} }), null, "nothing computable shows nothing, not zero");
  assert.equal(
    performanceModule.runCostCounterfactual({ receipts: [{ role: "worker", inputTokens: null, outputTokens: null, costUsd: 0.2 }], candidatesByRole: priciest }),
    null,
    "receipts without token counts cannot be projected",
  );
});

test("the production router applies the parity preference at the route boundary", async () => {
  // Codex F-005: the helper was tested while the route() wiring could be
  // deleted with the suite green. This exercises ModelRouter.route itself:
  // the fallback-provider nudge tops the pricier model, and the established
  // parity record displaces it onto the cheaper candidate, explained.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-parity-route-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & Record<string, any>;
  try {
    for (const provider of ["codex", "claude"] as const) {
      ledger.upsertConnection({
        id: `subscription-cli:${provider}`, provider, transport: "subscription_cli", authentication: "subscription",
        displayName: provider, enabled: true, installed: true, authenticated: true, visible: true, healthy: true,
        available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "t", runtimeVersion: "t", metadata: {},
      });
    }
    const premiumProfile = { tier: "premium", family: "fixture", capabilities: ["text", "analysis"], source: "catalog" };
    const seed = (id: string, connectionId: string, promptPrice: number, completionPrice: number) => {
      const model = ledger.addManualModel({
        id, connectionId, canonicalName: id, displayName: id, lifecycle: "verified", visible: true, verified: true,
        qualified: true, active: true, metadata: { devHarmonicsProfile: premiumProfile, promptPrice, completionPrice },
      });
      ledger.recordModelQualification({ modelId: id, fixtureVersion: "t", role: "general", passed: true, score: 1, evidence: {}, fingerprint: model.qualificationFingerprint });
    };
    seed("manual:claude:a-premium", "subscription-cli:claude", 0.00002, 0.00006);
    seed("manual:codex:z-budget", "subscription-cli:codex", 0.000001, 0.000002);
    const runId = ledger.createRun("parity route fixture", root);
    for (const modelId of ["manual:claude:a-premium", "manual:codex:z-budget"]) {
      for (let index = 0; index < 25; index++) {
        ledger.recordInvocationReceipt({
          runId, role: "reviewer", provider: modelId.includes("claude") ? "claude" : "codex",
          connectionId: modelId.includes("claude") ? "subscription-cli:claude" : "subscription-cli:codex",
          requestedModelId: modelId, resolvedModelId: modelId, inputTokens: 10, outputTokens: 10, costUsd: 0.001,
          durationMs: 100, workloadClass: "complex:premium",
        });
      }
    }
    const decision = new ModelRouter(ledger).route({
      role: "reviewer",
      config: defaultConfig,
      fallbackProvider: "claude",
      allowedProviders: ["codex", "claude"],
      permission: "read_only",
    });
    assert.ok(String(decision.model.requestedModelId).includes("z-budget"), `expected the cheaper parity candidate, routed ${String(decision.model.requestedModelId)}: ${decision.factors.join("; ")}`);
    assert.match(decision.factors.join(" "), /parity/i, "the routing explanation must name parity");

    // Codex R2-002 at the route boundary: an explicitly directed provider
    // (architect-planned or owner-reassigned) is never walked back by parity.
    const directed = new ModelRouter(ledger).route({
      role: "reviewer",
      config: defaultConfig,
      fallbackProvider: "claude",
      allowedProviders: ["codex", "claude"],
      permission: "read_only",
      task: { id: "t1", title: "directed", description: "", dependencies: [], preferredProvider: "claude", checks: [] },
    });
    assert.ok(String(directed.model.requestedModelId).includes("a-premium"), `a directed provider holds: routed ${String(directed.model.requestedModelId)}: ${directed.factors.join("; ")}`);
    assert.doesNotMatch(directed.factors.join(" "), /parity/i, "no parity displacement off a directed provider");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("claims-lens reviews route only to adapters that can structurally deny tools", async () => {
  // Codex R2-001: capability, not prompt wording, is the gate. Codex CLI
  // sandbox modes govern writes, not read scope; Gemini's add-dir boundary is
  // undemonstrated. Tool-less transports and claude's --disallowedTools are in.
  const providersModule = await import("../src/providers.js") as Record<string, any>;
  const attested = { attestedNoManagedPolicy: true, managedPolicyDetected: false };
  assert.equal(providersModule.providerSupportsToolDenial("codex", "subscription_cli", attested), false);
  assert.equal(providersModule.providerSupportsToolDenial("gemini", "subscription_cli", attested), false);
  assert.equal(providersModule.providerSupportsToolDenial("ollama", "local"), true);
  assert.equal(providersModule.providerSupportsToolDenial("openrouter", "api"), true);
  // Codex R4-001/R5-001: --safe-mode does not disable admin-managed POLICY
  // hooks, and server/MDM-delivered policy is not client-enumerable. Claude's
  // capability therefore requires the OWNER'S explicit attestation AND no
  // client-visible policy detection — and defaults closed without both.
  assert.equal(providersModule.providerSupportsToolDenial("claude", "subscription_cli", attested), true);
  assert.equal(providersModule.providerSupportsToolDenial("claude", "subscription_cli", { attestedNoManagedPolicy: false, managedPolicyDetected: false }), false, "no attestation, no capability — the default fails closed");
  assert.equal(providersModule.providerSupportsToolDenial("claude", "subscription_cli", { attestedNoManagedPolicy: true, managedPolicyDetected: true }), false, "client-visible policy overrides the attestation");
  assert.equal(providersModule.providerSupportsToolDenial("claude", "subscription_cli"), false, "the bare default is unattested and closed");

  // Codex R6-001: "could not check" is not a clear detection pass. The
  // detector takes injectable probes; every result other than a definite
  // absence fails closed, for files, drop-ins, and registry hives alike.
  const absent = () => "absent" as const;
  assert.equal(providersModule.claudeManagedPolicyPresent(absent, absent), false, "definite absence everywhere is the only clear pass");
  assert.equal(providersModule.claudeManagedPolicyPresent(absent, () => "found"), true, "a policy file hit detects");
  assert.equal(providersModule.claudeManagedPolicyPresent(absent, () => "inconclusive"), true, "an unreadable policy location is not a clear pass");
  if (process.platform === "win32") {
    assert.equal(providersModule.claudeManagedPolicyPresent(() => "found", absent), true, "a registry hit detects");
    assert.equal(providersModule.claudeManagedPolicyPresent(() => "inconclusive", absent), true, "a failed or timed-out registry probe is not a clear pass");
    const probed: string[] = [];
    providersModule.claudeManagedPolicyPresent((keyPath: string) => { probed.push(keyPath); return "absent"; }, absent);
    assert.deepEqual(probed, ["HKLM\\SOFTWARE\\Policies\\ClaudeCode", "HKCU\\SOFTWARE\\Policies\\ClaudeCode"], "both hives are checked");
    const roots: Array<[string, boolean]> = [];
    providersModule.claudeManagedPolicyPresent(absent, (candidate: string, expectJsonEntries: boolean) => { roots.push([candidate, expectJsonEntries]); return "absent"; });
    assert.deepEqual(roots, [
      ["C:\\Program Files\\ClaudeCode\\managed-settings.json", false],
      ["C:\\Program Files\\ClaudeCode\\managed-settings.d", true],
      ["C:\\ProgramData\\ClaudeCode\\managed-settings.json", false],
      ["C:\\ProgramData\\ClaudeCode\\managed-settings.d", true],
    ], "current and legacy base files plus drop-in roots are all checked, with the drop-in flag");
  }

  // Codex R7-001: the CLASSIFIERS are the safety boundary — test the raw
  // outcome mappings directly, not just already-classified injections.
  assert.equal(providersModule.classifyRegistryOutcome({ error: new Error("spawn reg ENOENT"), status: null }), "inconclusive", "a probe that cannot launch is not a clear pass");
  assert.equal(providersModule.classifyRegistryOutcome({ status: null }), "inconclusive", "a timed-out probe is not a clear pass");
  assert.equal(providersModule.classifyRegistryOutcome({ status: 0 }), "found");
  assert.equal(providersModule.classifyRegistryOutcome({ status: 1 }), "absent");
  assert.equal(providersModule.classifyRegistryOutcome({ status: 2 }), "inconclusive", "an unexpected reg exit is not a clear pass");

  const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
  const eperm = Object.assign(new Error("denied"), { code: "EPERM" });
  const throwing = (error: Error) => ({ statSync: () => { throw error; }, readdirSync: () => [] as string[] });
  assert.equal(providersModule.pathProbe("x", false, throwing(enoent)), "absent", "ENOENT is the only absent filesystem answer");
  assert.equal(providersModule.pathProbe("x", false, throwing(eperm)), "inconclusive", "a permission error is not a clear pass");
  assert.equal(providersModule.pathProbe("x", false, { statSync: () => ({}), readdirSync: () => [] }), "found", "an existing base file detects");
  assert.equal(providersModule.pathProbe("x", true, { statSync: () => ({}), readdirSync: () => ["readme.txt"] }), "absent", "a drop-in root with no .json entries is a clear pass");
  assert.equal(providersModule.pathProbe("x", true, { statSync: () => ({}), readdirSync: () => ["policy.json"] }), "found", "a drop-in .json detects");
  assert.equal(providersModule.pathProbe("x", true, { statSync: () => ({}), readdirSync: () => { throw eperm; } }), "inconclusive", "an unenumerable drop-in root is not a clear pass");
});

test("the assembled claims-lens chunk prompt demands the manifest the header promised", async () => {
  // Panel finding A1: the per-chunk JSON instruction is the last and most
  // literal formatting order the model sees; if it names findings alone, the
  // header's claimedChanges demand is contradicted and the divergence gate
  // starves. Prove the ASSEMBLED prompt, not the header in isolation.
  const localReview = await import("../src/local-review.js") as Record<string, any>;
  const promptsModule = await import("../src/prompts.js") as Record<string, any>;
  const seen: string[] = [];
  const adapter = {
    connection: { id: "stub", provider: "stub", capabilities: { modelSettings: [] } },
    invoke: async (request: { prompt: string }) => {
      seen.push(request.prompt);
      return { text: `READY\nok\n\`\`\`json\n{"findings":[],"claimedChanges":[]}\n\`\`\``, durationMs: 1, provider: "stub", connectionId: "stub", model: { resolvedModelId: "stub-model" }, usage: { inputTokens: 1, outputTokens: 1, costUsd: null } };
    },
  };
  const chunks = [{ label: "task reports 1", content: "t1 [finding]: created result.txt" }];
  const claims = await localReview.runContextOnlyReview({
    adapter,
    model: { requestedModelId: null, alias: null, settings: {} },
    cwd: os.tmpdir(),
    contextHeader: "claims header",
    chunks,
    jsonContract: promptsModule.CLAIMS_CHUNK_JSON_CONTRACT,
  });
  assert.match(seen[0]!, /claimedChanges/, "the chunk-level instruction must demand the manifest");
  assert.match(claims.text, /claimedChanges/, "the synthesized response carries the manifest through");

  seen.length = 0;
  await localReview.runContextOnlyReview({
    adapter,
    model: { requestedModelId: null, alias: null, settings: {} },
    cwd: os.tmpdir(),
    contextHeader: "artifact header",
    chunks,
  });
  assert.ok(!/claimedChanges/.test(seen[0]!), "non-claims reviews keep the findings-only contract");
});

test("workflow documents parse with typed inputs and content-hash revision identity", async () => {
  // DH-810 S1: a workflow is a versioned parameterized document. Its identity
  // is its content hash — the same canonicalization discipline as plan
  // revisions — so a later edit can never masquerade as the revision a
  // historical run executed.
  const workflows = await import("../src/workflows.js").catch(() => ({})) as Record<string, any>;
  assert.equal(typeof workflows.parseWorkflowDocument, "function", "DH-810 requires a workflow parser");
  assert.equal(typeof workflows.workflowRevisionHash, "function", "DH-810 requires content-hash identity");

  const document = {
    name: "documentation-consistency",
    description: "Verify every versioned claim in the docs matches the repository state.",
    inputs: [
      { name: "repositoryId", type: "string", required: true, description: "Repository to audit" },
      { name: "maxFindings", type: "number", required: false, description: "Stop after this many findings" },
    ],
    objective: {
      outcomeTemplate: "Every versioned claim in ${repositoryId} documentation matches the code.",
      acceptanceCriteria: ["No stale version statements remain", "Every corrected claim cites its source line"],
      risk: "medium",
    },
    evidenceRequirements: ["path:line citation per corrected claim"],
    approvalPoints: ["plan", "external_write"],
    completionContract: { deliverable: "reviewed branch", reviewLenses: ["artifact"] },
    permissions: { autonomy: "supervised", allowExternalWrites: false },
  };

  const parsed = workflows.parseWorkflowDocument(JSON.stringify(document));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues ?? []));
  assert.equal(parsed.workflow.name, "documentation-consistency");
  assert.equal(parsed.workflow.inputs[0].required, true);

  // Identity: stable under key order, changed by content. (Audit
  // DH810-AUD-010: the reordered object must GENUINELY change key insertion
  // order, at the top level and in a nested object — a spread that overwrites
  // an existing key does not.)
  const hashA = workflows.workflowRevisionHash(parsed.workflow);
  const reordered = workflows.parseWorkflowDocument(JSON.stringify({
    permissions: { allowExternalWrites: document.permissions.allowExternalWrites, autonomy: document.permissions.autonomy },
    completionContract: document.completionContract,
    approvalPoints: document.approvalPoints,
    evidenceRequirements: document.evidenceRequirements,
    objective: { risk: document.objective.risk, acceptanceCriteria: document.objective.acceptanceCriteria, outcomeTemplate: document.objective.outcomeTemplate },
    inputs: document.inputs,
    description: document.description,
    name: document.name,
  }));
  assert.equal(reordered.ok, true);
  assert.equal(workflows.workflowRevisionHash(reordered.workflow), hashA, "identical content hashes identically regardless of key order");
  const edited = workflows.parseWorkflowDocument(JSON.stringify({ ...document, description: "changed" }));
  assert.notEqual(workflows.workflowRevisionHash(edited.workflow), hashA, "any content change is a new revision");

  // Malformed documents fail closed with named issues, never a partial parse.
  const missingInputs = workflows.parseWorkflowDocument(JSON.stringify({ ...document, inputs: [{ name: "", type: "mystery" }] }));
  assert.equal(missingInputs.ok, false);
  assert.ok(missingInputs.issues.length >= 1, "issues are named");
  const notJson = workflows.parseWorkflowDocument("not json {");
  assert.equal(notJson.ok, false);

  // A workflow may not demand permissions its declared approval points don't
  // gate: external writes without an external_write approval point is refused.
  const widened = workflows.parseWorkflowDocument(JSON.stringify({
    ...document,
    approvalPoints: ["plan"],
    permissions: { autonomy: "supervised", allowExternalWrites: true },
  }));
  assert.equal(widened.ok, false, "ungated external writes are refused at parse time");

  // Panel findings: duplicate input names are ambiguous, template placeholders
  // must reference declared inputs, and zero evidence requirements is not a
  // workflow — all refused at parse time, none discovered downstream.
  const duplicateInputs = workflows.parseWorkflowDocument(JSON.stringify({
    ...document,
    inputs: [
      { name: "repositoryId", type: "string", required: true, description: "one" },
      { name: "repositoryId", type: "number", required: false, description: "two" },
    ],
  }));
  assert.equal(duplicateInputs.ok, false, "duplicate input names are refused");
  const typoPlaceholder = workflows.parseWorkflowDocument(JSON.stringify({
    ...document,
    objective: { ...document.objective, outcomeTemplate: "Every claim in ${repoId} matches." },
  }));
  assert.equal(typoPlaceholder.ok, false, "a placeholder naming no declared input is refused");
  assert.match((typoPlaceholder as { issues: string[] }).issues.join(" "), /repoId/, "the offending placeholder is named");
  const noEvidence = workflows.parseWorkflowDocument(JSON.stringify({ ...document, evidenceRequirements: [] }));
  assert.equal(noEvidence.ok, false, "a workflow with no required evidence is refused");
});

test("workflow revisions persist immutably and runs pin the exact revision executed", async () => {
  // DH-810 S2: recording is idempotent by content hash, a stored revision
  // never changes, and a run records which revision it executed — so editing
  // a workflow can never rewrite what a historical run did.
  const workflows = await import("../src/workflows.js") as Record<string, any>;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-workflow-ledger-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & Record<string, any>;
  try {
    assert.equal(typeof ledger.recordWorkflowRevision, "function", "DH-810 requires workflow revision persistence");
    const document = {
      name: "release-truth-audit",
      description: "Verify every release-page claim against the tagged artifact.",
      inputs: [{ name: "tag", type: "string", required: true, description: "Release tag to audit" }],
      objective: { outcomeTemplate: "Release ${tag} claims match its artifacts.", acceptanceCriteria: ["Every checksum on the release page matches"], risk: "high" },
      evidenceRequirements: ["checksum transcript"],
      approvalPoints: ["plan"],
      completionContract: { deliverable: "audit report", reviewLenses: ["artifact", "claims"] },
      permissions: { autonomy: "supervised", allowExternalWrites: false },
    };
    const parsed = workflows.parseWorkflowDocument(JSON.stringify(document));
    assert.equal(parsed.ok, true);
    const hash = workflows.workflowRevisionHash(parsed.workflow);

    const first = ledger.recordWorkflowRevision({ workflow: parsed.workflow });
    assert.equal(first.revisionHash, hash);
    const second = ledger.recordWorkflowRevision({ workflow: parsed.workflow });
    assert.equal(second.revisionHash, hash, "same content is the same revision, not a duplicate");
    assert.equal(ledger.listWorkflowRevisions().length, 1);

    const stored = ledger.getWorkflowRevision(hash)!;
    assert.equal(stored.workflow.name, "release-truth-audit");
    assert.equal(stored.createdAt, first.createdAt, "re-recording does not touch the original record");

    // An edited workflow is a NEW revision beside the old one, never a rewrite.
    const editedParse = workflows.parseWorkflowDocument(JSON.stringify({ ...document, description: "tightened" }));
    const edited = ledger.recordWorkflowRevision({ workflow: editedParse.workflow });
    assert.notEqual(edited.revisionHash, hash);
    assert.equal(ledger.listWorkflowRevisions().length, 2);
    assert.equal(ledger.getWorkflowRevision(hash)!.workflow.description, document.description, "the historical revision is untouched");

    // Runs pin the revision they executed.
    const runId = ledger.createRun("workflow-driven run", root);
    ledger.linkRunWorkflowRevision(runId, hash);
    assert.equal(ledger.getRun(runId)?.workflowRevisionHash, hash);
    assert.throws(() => ledger.linkRunWorkflowRevision(runId, "0".repeat(64)), /unknown workflow revision/i, "a run cannot pin a revision the ledger never stored");
    // Panel finding: the pin is an audit fact — re-linking to a DIFFERENT
    // revision must be refused, while re-asserting the same pin is idempotent.
    ledger.linkRunWorkflowRevision(runId, hash);
    assert.throws(() => ledger.linkRunWorkflowRevision(runId, edited.revisionHash), /already pinned/i, "a pinned run can never be re-pointed at another revision");
    assert.equal(ledger.getRun(runId)?.workflowRevisionHash, hash, "the original pin survives the refused attempt");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the tag-truth gate refuses a tag the repository's own files contradict unless the owner confirms", async () => {
  // Owner-requested (2026-07-22): "if it's at 1.2.1 and I tag it 1.0.0, won't
  // that screw up versioning across all surfaces?" — yes, so the tag step now
  // reads the version the repository declares about itself and refuses a
  // contradiction unless the mismatch is explicitly confirmed.
  const workflows = await import("../src/delivery.js") as Record<string, any>;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-tag-truth-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  let prState = "OPEN";
  const runner = async (request: { command: string; args: string[] }) => {
    const joined = request.args.join(" ");
    if (request.command === "git" && joined === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/truth.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "create") {
      return { stdout: "https://github.com/civicsuite/truth/pull/3\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("state,isDraft,mergeable")) {
      return { stdout: JSON.stringify({ state: prState, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "b".repeat(40), statusCheckRollup: [] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("mergeCommit")) {
      return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "c".repeat(40) } }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "merge") prState = "MERGED";
    // The tag-truth gate reads the version from the IMMUTABLE merge commit
    // ("c" * 40) via `git show <oid>:package.json`, not the checkout: this
    // commit declares 1.2.1 about itself.
    if (request.command === "git" && request.args[0] === "show" && joined.endsWith(":package.json")) {
      return { stdout: JSON.stringify({ name: "truth", version: "1.2.1" }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "rev-parse" && joined.includes("refs/tags/")) {
      return { stdout: "", stderr: "", exitCode: 1, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };
  try {
    // The pure parser: package.json wins, pyproject reads ONLY [project].version.
    assert.equal(workflows.parseDeclaredVersion(null, null), null, "no manifest text means no discoverable claim");
    assert.equal(workflows.parseDeclaredVersion(null, '[project]\nname = "truth"\nversion = "3.4.5"\n'), "3.4.5", "pyproject declares the version when package.json is absent");
    assert.equal(workflows.parseDeclaredVersion(JSON.stringify({ name: "truth", version: "1.2.1" }), '[project]\nversion = "3.4.5"\n'), "1.2.1", "package.json wins when both exist");

    const runId = ledger.createRun("Tag truthfully", root);
    ledger.setRunStatus(runId, "running");
    ledger.setRunStatus(runId, "ready", "READY");
    ledger.prepareDeliveryRepository({ runId, repositoryId: "repo:truth", localPath: root, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), branch: "devharmonics/truth" });
    const service = new DeliveryService(ledger, runner as never);
    const config = structuredClone(defaultConfig);
    config.runPolicy.allowExternalWrites = true;
    const approval = (id: string) => ({ id, kind: "external_write" as const, approvedBy: "local-owner", approvedAt: new Date().toISOString() });
    await service.execute({ runId, repositoryId: "repo:truth", action: "push_branch", config, approval: approval("a-push") });
    await service.execute({ runId, repositoryId: "repo:truth", action: "create_draft_pr", config, approval: approval("a-pr") });
    await service.execute({ runId, repositoryId: "repo:truth", action: "merge_pr", config, approval: approval("a-merge") });

    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:truth", action: "tag_release", tag: "v1.0.0", config, approval: approval("a-tag1") }),
      /declare version 1\.2\.1.*requested tag is v1\.0\.0/,
      "a tag the repository contradicts refuses with both values",
    );
    assert.equal(ledger.getRun(runId)?.delivery?.repositories[0]?.status, "merged", "the refused tag changed nothing");
    // An explicitly confirmed mismatch is the owner's deliberate decision.
    const confirmed = await service.execute({ runId, repositoryId: "repo:truth", action: "tag_release", tag: "v1.0.0", config, approval: approval("a-tag2"), confirmVersionMismatch: true });
    assert.equal(confirmed.status, "tagged");
    assert.equal(confirmed.releaseTag, "v1.0.0");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pyproject version parsing reads only [project].version, ignoring another table's version", async () => {
  // MAJOR gate finding (2026-07-22): the old whole-file regex took the FIRST
  // `version = "..."` anywhere, so a [tool.*] table's version before [project]
  // masqueraded as the project's own — bypassing or falsely tripping the gate.
  const workflows = await import("../src/delivery.js") as Record<string, any>;
  const toml = [
    "[tool.audit]",
    'version = "1.0.0"',
    "",
    "[project]",
    'name = "x"',
    'version = "2.0.0"',
    "",
    "[project.scripts]",
    'version = "9.9.9"',
  ].join("\n");
  assert.equal(workflows.parseDeclaredVersion(null, toml), "2.0.0", "a [tool.*] version before [project] must not be read as the project version");
  assert.equal(workflows.parseDeclaredVersion(null, '[project]\r\nversion = "4.5.6"\r\n'), "4.5.6", "CRLF pyproject is parsed");
  assert.equal(workflows.parseDeclaredVersion(null, '[project]\nname = "x"\ndynamic = ["version"]\n'), null, "a [project] with no static version makes no discoverable claim");
  assert.equal(workflows.parseDeclaredVersion(JSON.stringify({ version: "3.0.0" }), toml), "3.0.0", "package.json still wins when both exist");
});

test("the tag-truth gate judges by the version in the merge COMMIT, not the mutable checkout", async () => {
  // CRITICAL gate finding (2026-07-22): the gate read package.json from the
  // working tree via fs, so a stale or locally edited primary checkout could
  // both falsely refuse a correct tag and falsely approve a contradicted one.
  // Here the checkout ON DISK declares 1.0.0 while the merge commit (served by
  // `git show`) declares 2.0.0. The gate must judge by the COMMIT both ways.
  // Against the OLD fs-based code this fails in both directions: it would tag
  // v1.0.0 (the checkout agreed) though the commit says 2.0.0, and it would
  // refuse v2.0.0 (the checkout disagreed) though the commit says 2.0.0.
  const { DeliveryService } = await import("../src/delivery.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-commit-truth-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  // The mutable checkout deliberately declares a DIFFERENT version than the commit.
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "truth", version: "1.0.0" }), "utf-8");
  let prState = "OPEN";
  let mergeCommitFetched = false;
  const runner = async (request: { command: string; args: string[] }) => {
    const joined = request.args.join(" ");
    if (request.command === "git" && joined === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/truth.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    // The merge commit ("c" * 40) declares 2.0.0 about itself — but only once
    // it exists locally. GitHub creates the merge commit remotely; until
    // `git fetch origin <base>` runs, `git show` on it MUST fail, so a gate
    // that asks before fetching silently no-ops and this test goes red
    // (boss-review ordering finding, 2026-07-22).
    if (request.command === "git" && request.args[0] === "fetch") mergeCommitFetched = true;
    if (request.command === "git" && request.args[0] === "show" && joined.endsWith(":package.json")) {
      if (!mergeCommitFetched) return { stdout: "", stderr: `fatal: invalid object name '${"c".repeat(40)}'`, exitCode: 128, durationMs: 1, timedOut: false };
      return { stdout: JSON.stringify({ name: "truth", version: "2.0.0" }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "create") {
      return { stdout: "https://github.com/civicsuite/truth/pull/7\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("state,isDraft,mergeable")) {
      return { stdout: JSON.stringify({ state: prState, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "b".repeat(40), statusCheckRollup: [] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("mergeCommit")) {
      return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "c".repeat(40) } }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "merge") prState = "MERGED";
    if (request.command === "git" && request.args[0] === "rev-parse" && joined.includes("refs/tags/")) {
      return { stdout: "", stderr: "", exitCode: 1, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };
  try {
    const runId = ledger.createRun("Tag by the commit", root);
    ledger.setRunStatus(runId, "running");
    ledger.setRunStatus(runId, "ready", "READY");
    ledger.prepareDeliveryRepository({ runId, repositoryId: "repo:truth", localPath: root, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), branch: "devharmonics/truth" });
    const service = new DeliveryService(ledger, runner as never);
    const config = structuredClone(defaultConfig);
    config.runPolicy.allowExternalWrites = true;
    const approval = (id: string) => ({ id, kind: "external_write" as const, approvedBy: "local-owner", approvedAt: new Date().toISOString() });
    await service.execute({ runId, repositoryId: "repo:truth", action: "push_branch", config, approval: approval("c-push") });
    await service.execute({ runId, repositoryId: "repo:truth", action: "create_draft_pr", config, approval: approval("c-pr") });
    await service.execute({ runId, repositoryId: "repo:truth", action: "merge_pr", config, approval: approval("c-merge") });

    // Falsely-approve direction: the checkout declares 1.0.0, so old fs-based
    // code would AGREE and tag v1.0.0 — but the COMMIT declares 2.0.0, so the
    // commit-resolved gate refuses.
    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:truth", action: "tag_release", tag: "v1.0.0", config, approval: approval("c-tag1") }),
      /declare version 2\.0\.0.*requested tag is v1\.0\.0/,
      "a tag matching only the stale checkout, not the merge commit, is refused",
    );
    assert.equal(ledger.getRun(runId)?.delivery?.repositories[0]?.status, "merged", "the refused tag left the delivery merged, untagged");

    // Falsely-refuse direction: the checkout declares 1.0.0, so old fs-based
    // code would REFUSE v2.0.0 — but the COMMIT declares 2.0.0, so the
    // commit-resolved gate approves it without any mismatch confirmation.
    const tagged = await service.execute({ runId, repositoryId: "repo:truth", action: "tag_release", tag: "v2.0.0", config, approval: approval("c-tag2") });
    assert.equal(tagged.status, "tagged", "the tag matching the merge commit is applied");
    assert.equal(tagged.releaseTag, "v2.0.0");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the Evidence page never claims a never-reviewed run passed review", async () => {
  // MAJOR gate finding (2026-07-22): derivedVerdictMarkup keyed the historical
  // "the review passed at the time it ran" wording off ISSUE COUNT, so an
  // ordinary in-progress / never-reviewed run (INCONCLUSIVE with issues) was
  // told its review had passed. Drive the REAL built createRunReport for two
  // states through the REAL verdictGuidance extracted from src/ui/app.js.
  const reporterModule = await import("../src/reporter.js") as { createRunReport: (evidence: Record<string, unknown>) => Record<string, any> };

  // Extract the (pure) verdictGuidance from the shipped UI source. It reads only
  // report.verdict / .missingEvidence / .inconsistencies, so it runs headless.
  const appSource = readFileSync(path.join(process.cwd(), "src", "ui", "app.js"), "utf8");
  const start = appSource.indexOf("function verdictGuidance(report)");
  const end = appSource.indexOf("\nfunction parseReviewTargets(");
  assert.ok(start >= 0 && end > start, "verdictGuidance must exist as an extractable function in app.js");
  const verdictGuidance = new Function(`${appSource.slice(start, end)}; return verdictGuidance;`)() as (report: Record<string, any>) => string;

  // (a) An in-progress run that has never been reviewed: finalReview is null.
  const inProgress = {
    version: 2,
    integritySha256: "b".repeat(64),
    run: { id: "run-open", goal: "Building", status: "running", finalReview: null, plan: { summary: "bounded", tasks: [] }, tasks: [], events: [] },
    attempts: [],
    blackboard: [],
    toolReceipts: [],
    reviews: [],
  };
  const openReport = reporterModule.createRunReport(inProgress);
  assert.equal(openReport.verdict, "INCONCLUSIVE", "a never-reviewed in-progress run is INCONCLUSIVE");
  assert.ok(openReport.missingEvidence.includes("final review"), "the reporter records the absent review");
  const openGuidance = verdictGuidance(openReport);
  assert.match(openGuidance, /has not reached a reviewed state/, "an unreviewed run is described as not yet reviewed");
  assert.doesNotMatch(openGuidance, /passed at the time it ran/, "an unreviewed run is NEVER told its review passed");

  // (b) A run whose retained review WAS READY but whose evidence later went
  // inconsistent (the integration set moved after review): the historical
  // wording is earned here and only here.
  const runPlan = { summary: "bounded", recommendedConcurrency: 1, tasks: [] };
  const runTasks = [{ id: "one", status: "passed", checks: [{ name: "test", passed: true }] }];
  const evidenceBinding = createReviewEvidenceBinding({ autonomy: "bounded", plan: runPlan, taskReports: "retained", diff: [{ path: "result.txt", diff: "+done" }], checks: runTasks.map((task) => ({ id: task.id, checks: task.checks })), repositories: [{ repositoryId: "C:/fixture", baseCommit: "base", headCommit: "head" }] });
  const reviewedThenInconsistent = {
    version: 2,
    integritySha256: "c".repeat(64),
    run: { id: "run-historical", goal: "Shipped", status: "ready", finalReview: "READY\n\nAll retained gates passed.", plan: runPlan, tasks: runTasks, events: [] },
    attempts: [{ id: 1, status: "completed" }],
    blackboard: [],
    toolReceipts: [{ id: 1, outcome: "allow" }],
    reviews: [{ id: 1, verdict: "READY", integrationSha256: reviewEvidenceBindingSha256(evidenceBinding), evidenceBinding, invalidatedAt: null }],
    // The integration set moved after review — a retained READY invalidated by
    // later inconsistency, not a missing review.
    integrationSet: { status: "ready", repositories: [{ repositoryId: "C:/fixture", baseCommit: "base", headCommit: "different-head" }] },
  };
  const historicalReport = reporterModule.createRunReport(reviewedThenInconsistent);
  assert.equal(historicalReport.verdict, "INCONCLUSIVE");
  assert.deepEqual([...historicalReport.missingEvidence], [], "a retained READY leaves no review evidence missing");
  assert.ok(historicalReport.inconsistencies.length > 0, "the retained READY is invalidated by later inconsistency");
  const historicalGuidance = verdictGuidance(historicalReport);
  assert.match(historicalGuidance, /passed at the time it ran/, "a retained READY gone inconsistent keeps the historical wording");
  assert.match(historicalGuidance, /Treat the READY as historical/, "the historical wording tells the owner what to do");
});

test("declining a tag mismatch records a CANCELLED operation — never succeeded, never failed", async () => {
  // MINOR gate finding (2026-07-22), ROUND2-001: declining the version-mismatch
  // override returns a cancellation SENTINEL from the delivery action, and
  // withOperation must map that sentinel to a distinct "cancelled" end state so
  // the activity strip reports honest "you declined" copy instead of "done".
  // Drive the REAL shipped cancelledOperation + classifyOperationOutcome
  // extracted from src/ui/app.js — the exact pure seam withOperation calls — so
  // a future refactor that restores the false-success path fails HERE.
  const appSource = readFileSync(path.join(process.cwd(), "src", "ui", "app.js"), "utf8");
  const start = appSource.indexOf("const OPERATION_CANCELLED = Symbol");
  const end = appSource.indexOf("\nfunction beginOperation(");
  assert.ok(start >= 0 && end > start, "the operation-outcome seam must be extractable from app.js");
  const helpers = new Function(
    `${appSource.slice(start, end)}; return { OPERATION_CANCELLED, cancelledOperation, classifyOperationOutcome };`,
  )() as {
    OPERATION_CANCELLED: symbol;
    cancelledOperation: (detail?: string) => Record<PropertyKey, unknown>;
    classifyOperationOutcome: (result: unknown) => { status: string; detail: string };
  };

  // The decline branch's actual return value: cancelledOperation(reason).
  const declined = helpers.cancelledOperation("Tag not applied — you declined tagging v1.0.0 over the declared 2.0.0.");
  const cancelled = helpers.classifyOperationOutcome(declined);
  assert.equal(cancelled.status, "cancelled", "a returned cancellation sentinel ends the operation as cancelled");
  assert.notEqual(cancelled.status, "succeeded", "a declined mismatch is NEVER recorded as a success");
  assert.notEqual(cancelled.status, "failed", "a declined mismatch is NEVER recorded as a failure (nothing broke)");
  assert.equal(cancelled.detail, "Tag not applied — you declined tagging v1.0.0 over the declared 2.0.0.", "the decline reason rides through to the strip");

  // Every ORDINARY resolved value is a plain success — the sentinel is the only
  // thing that diverts to cancelled.
  assert.equal(helpers.classifyOperationOutcome({ ok: true }).status, "succeeded", "a normal resolved value is a success");
  assert.equal(helpers.classifyOperationOutcome(undefined).status, "succeeded", "an absent return value is a success");
  assert.equal(helpers.classifyOperationOutcome(null).status, "succeeded", "a null return value is a success");
});

test("delivery tag caption never claims 'declares no version' during a mergeVersionUnavailable outage", async () => {
  // MAJOR gate finding R4-002 (2026-07-22): PR #38 made GET
  // /api/runs/:id/delivery return `mergeVersionUnavailable: true` for a
  // repository whose merged version could not be re-resolved (a transient
  // GitHub/network failure), but the cockpit's fillDeclaredTagVersions never
  // checked the flag — it fell into the declaredVersion===null branch and
  // told the owner "This repository declares no version in its own files",
  // which is false during the outage and contradicts the CHANGELOG's
  // promised "merge version temporarily unavailable - retry" copy. Drive the
  // REAL shipped deliveryTagCaption pure seam extracted from src/ui/app.js —
  // the exact function fillDeclaredTagVersions calls — so a future refactor
  // that drops the mergeVersionUnavailable check fails HERE.
  const appSource = readFileSync(path.join(process.cwd(), "src", "ui", "app.js"), "utf8");
  const start = appSource.indexOf("function deliveryTagCaption(repository)");
  const end = appSource.indexOf("\nasync function fillDeclaredTagVersions(");
  assert.ok(start >= 0 && end > start, "deliveryTagCaption must exist as an extractable function in app.js");
  const deliveryTagCaption = new Function(`${appSource.slice(start, end)}; return deliveryTagCaption;`)() as (
    repository: Record<string, unknown>,
  ) => { prefill: string | null; help: string };

  // (a) The outage state: merge OID could not be re-resolved this GET.
  const unavailable = deliveryTagCaption({ repositoryId: "repo:truth", declaredVersion: null, mergeVersionUnavailable: true });
  assert.doesNotMatch(unavailable.help, /declares no version/, "an unavailable merge read is NEVER described as a versionless repository");
  assert.match(unavailable.help, /can't be read right now|retry/i, "the outage state gives explicit retry guidance");
  assert.equal(unavailable.prefill, null, "the outage state never prefills a tag — there is nothing confirmed to prefill");

  // (b) A genuinely versionless repository (no mergeVersionUnavailable flag)
  // keeps the pre-existing, correct copy — this finding must not overcorrect.
  const trulyVersionless = deliveryTagCaption({ repositoryId: "repo:truth", declaredVersion: null });
  assert.match(trulyVersionless.help, /declares no version/, "a repository that truly has no declared version still says so");
  assert.equal(trulyVersionless.prefill, null);

  // (c) The ordinary success path is unaffected by the new branch.
  const resolved = deliveryTagCaption({ repositoryId: "repo:truth", declaredVersion: "2.0.0" });
  assert.equal(resolved.prefill, "v2.0.0", "a resolved declared version still prefills the tag field");
  assert.match(resolved.help, /declares version 2\.0\.0/);

  // (d) mergeVersionUnavailable wins even if a stale declaredVersion string
  // is also present on the record — the outage guidance must not be masked.
  const staleButUnavailable = deliveryTagCaption({ repositoryId: "repo:truth", declaredVersion: "1.0.0", mergeVersionUnavailable: true });
  assert.equal(staleButUnavailable.prefill, null, "mergeVersionUnavailable suppresses prefill even over a present declaredVersion");
  assert.doesNotMatch(staleButUnavailable.help, /declares version/, "the outage guidance is never masked by a stale declaredVersion");
});

test("migration 30's delivery-table rebuild preserves row data from a physical schema-29 database", async () => {
  // Gate finding ENG-3 (2026-07-22): the CHECK-widening RENAME/rebuild in
  // migration 30 had no test proving a delivery row's VALUES survive it.
  // Reconstruct the physical v27-shaped table (narrow CHECK, no release_tag),
  // seed a real row, replay migrations 30-33, and compare every column.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-migration-29-"));
  const filename = path.join(root, "devharmonics.db");
  const seeded = new Ledger(filename);
  const runId = seeded.createRun("Deliver across the rebuild", root);
  seeded.setRunStatus(runId, "running");
  seeded.setRunStatus(runId, "ready", "READY");
  seeded.prepareDeliveryRepository({ runId, repositoryId: "repo:rebuild", localPath: root, baseBranch: "main", baseCommit: "1".repeat(40), headCommit: "2".repeat(40), branch: "devharmonics/rebuild" });
  seeded.close();

  const surgery = new DatabaseSync(filename);
  const before = surgery.prepare("SELECT * FROM delivery_repositories WHERE run_id = ?").get(runId) as Record<string, unknown>;
  surgery.exec(`
    ALTER TABLE delivery_repositories RENAME TO delivery_repositories_new;
    CREATE TABLE delivery_repositories (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL,
      local_path TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      head_commit TEXT NOT NULL,
      branch TEXT NOT NULL,
      remote_url TEXT,
      status TEXT NOT NULL CHECK(status IN ('prepared', 'branch_pushed', 'draft_pr_created', 'failed')),
      pull_request_url TEXT,
      approval_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, repository_id)
    );
    INSERT INTO delivery_repositories (run_id, repository_id, local_path, base_branch, base_commit, head_commit, branch, remote_url, status, pull_request_url, approval_id, error, created_at, updated_at)
      SELECT run_id, repository_id, local_path, base_branch, base_commit, head_commit, branch, remote_url, status, pull_request_url, approval_id, error, created_at, updated_at
      FROM delivery_repositories_new;
    DROP TABLE delivery_repositories_new;
    DELETE FROM schema_migrations WHERE version > 29;
    PRAGMA user_version = 29;
  `);
  surgery.close();

  const upgraded = new Ledger(filename);
  try {
    assert.equal(upgraded.getSchemaVersion(), LEDGER_SCHEMA_VERSION, "the physical v29 database reaches the current schema");
    const record = upgraded.getRun(runId)?.delivery?.repositories.find((repository) => repository.repositoryId === "repo:rebuild");
    assert.ok(record, "the delivery row survives the rebuild");
    assert.equal(record!.status, "prepared");
    assert.equal(record!.baseCommit, "1".repeat(40));
    assert.equal(record!.headCommit, "2".repeat(40));
    assert.equal(record!.branch, "devharmonics/rebuild");
    const database = new DatabaseSync(filename);
    try {
      const after = database.prepare("SELECT * FROM delivery_repositories WHERE run_id = ?").get(runId) as Record<string, unknown>;
      for (const [column, value] of Object.entries(before)) {
        assert.deepEqual(after[column], value, `column '${column}' survives the CHECK-widening rebuild byte-for-byte`);
      }
      const rebuiltSql = String((database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'delivery_repositories'").get() as { sql: string }).sql);
      assert.match(rebuiltSql, /'merged'/, "the rebuilt table accepts the widened states");
      assert.match(rebuiltSql, /'tagged'/, "the rebuilt table accepts the widened states");
    } finally {
      database.close();
    }
  } finally {
    upgraded.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery completes from the cockpit: receipted merge and tag, never blind", async () => {
  // Owner-corrected rule (2026-07-22): "never auto-merge" means never WITHOUT
  // the owner's approval — the cockpit must be able to run the whole delivery.
  // merge_pr shows PR state and refuses conflicts; tag_release is an explicit
  // versioned go/no-go; each step is its own external-write receipt.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-delivery-complete-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  const commands: Array<{ command: string; args: string[] }> = [];
  let mergeable = "CONFLICTING";
  let prState = "OPEN";
  let headRefOid = "b".repeat(40);
  let checkRollup: Array<{ status: string; conclusion: string | null }> = [];
  let localTagOid: string | null = null;
  let failTagPushOnce = false;
  const runner = async (request: { command: string; args: string[] }) => {
    commands.push({ command: request.command, args: [...request.args] });
    const joined = request.args.join(" ");
    if (request.command === "git" && joined === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/example.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "create") {
      return { stdout: "https://github.com/civicsuite/example/pull/7\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("state,isDraft,mergeable")) {
      return { stdout: JSON.stringify({ state: prState, isDraft: true, mergeable, mergeStateStatus: "CLEAN", headRefOid, statusCheckRollup: checkRollup }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("mergeCommit")) {
      return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "c".repeat(40) } }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "merge") prState = "MERGED";
    if (request.command === "git" && request.args[0] === "rev-parse" && joined.includes("refs/tags/")) {
      return localTagOid
        ? { stdout: `${localTagOid}\n`, stderr: "", exitCode: 0, durationMs: 1, timedOut: false }
        : { stdout: "", stderr: "", exitCode: 1, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "tag") localTagOid = request.args[3] ?? null;
    if (request.command === "git" && joined.startsWith("push origin refs/tags/") && failTagPushOnce) {
      failTagPushOnce = false;
      return { stdout: "", stderr: "network hiccup", exitCode: 1, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };
  try {
    const runId = ledger.createRun("Complete the delivery", root);
    ledger.setRunStatus(runId, "running");
    ledger.setRunStatus(runId, "ready", "READY");
    ledger.prepareDeliveryRepository({ runId, repositoryId: "repo:example", localPath: root, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), branch: "devharmonics/777" });
    const service = new DeliveryService(ledger, runner as never);
    const config = structuredClone(defaultConfig);
    config.runPolicy.allowExternalWrites = true;
    const approval = (id: string) => ({ id, kind: "external_write" as const, approvedBy: "local-owner", approvedAt: new Date().toISOString() });

    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "merge_pr", config, approval: approval("approval-merge") }),
      /draft pull request first/i,
      "merge requires the PR to exist",
    );
    await service.execute({ runId, repositoryId: "repo:example", action: "push_branch", config, approval: approval("approval-push") });
    await service.execute({ runId, repositoryId: "repo:example", action: "create_draft_pr", config, approval: approval("approval-pr") });

    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "merge_pr", config, approval: approval("approval-merge") }),
      /not mergeable|conflict/i,
      "a conflicting PR is never merged blind",
    );
    mergeable = "MERGEABLE";
    // Panel: pending or failing status checks refuse the merge — red never ships.
    checkRollup = [{ status: "IN_PROGRESS", conclusion: null }];
    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "merge_pr", config, approval: approval("approval-merge") }),
      /still running/i,
      "pending checks refuse the merge",
    );
    checkRollup = [{ status: "COMPLETED", conclusion: "FAILURE" }];
    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "merge_pr", config, approval: approval("approval-merge") }),
      /failed.*never merged|red pull request/i,
      "failing checks refuse the merge",
    );
    checkRollup = [];
    // Panel: a PR head that is no longer the reviewed commit refuses the merge.
    headRefOid = "e".repeat(40);
    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "merge_pr", config, approval: approval("approval-merge") }),
      /no longer the reviewed commit/i,
      "head drift refuses the merge",
    );
    headRefOid = "b".repeat(40);
    const merged = await service.execute({ runId, repositoryId: "repo:example", action: "merge_pr", config, approval: approval("approval-merge") });
    assert.equal(merged.status, "merged");
    assert.ok(commands.some((item) => item.command === "gh" && item.args[1] === "ready"), "a draft PR is marked ready before merging");
    assert.ok(commands.some((item) => item.command === "gh" && item.args[1] === "merge" && item.args.includes("--merge")));

    // Panel: resuming past-completed steps reconciles instead of throwing.
    assert.equal((await service.execute({ runId, repositoryId: "repo:example", action: "push_branch", config, approval: approval("approval-r1") })).status, "merged");
    assert.equal((await service.execute({ runId, repositoryId: "repo:example", action: "create_draft_pr", config, approval: approval("approval-r2") })).status, "merged");
    assert.equal((await service.execute({ runId, repositoryId: "repo:example", action: "merge_pr", config, approval: approval("approval-r3") })).status, "merged");

    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "tag_release", tag: "bad tag!", config, approval: approval("approval-tag") }),
      /tag/i,
      "an invalid tag name is refused",
    );
    // Panel: a failed tag PUSH leaves a local tag behind — the retry reuses it
    // instead of stranding the delivery.
    failTagPushOnce = true;
    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "tag_release", tag: "v0.9.9", config, approval: approval("approval-tag") }),
      /network hiccup|push failed/i,
      "the real push failure reason is surfaced",
    );
    assert.equal(ledger.getRun(runId)?.delivery?.repositories[0]?.status, "merged", "a failed push falls back to merged, not failed");
    const tagged = await service.execute({ runId, repositoryId: "repo:example", action: "tag_release", tag: "v0.9.9", config, approval: approval("approval-tag2") });
    assert.equal(tagged.status, "tagged");
    assert.equal(tagged.releaseTag, "v0.9.9", "the applied tag is persisted on the record");
    assert.equal(commands.filter((item) => item.command === "git" && item.args[0] === "tag").length, 1, "the retry reused the existing local tag instead of re-creating it");
    assert.ok(commands.some((item) => item.command === "git" && item.args[0] === "tag" && item.args.includes("v0.9.9") && item.args.includes("c".repeat(40))), "the tag lands on the actual merge commit");
    assert.ok(commands.some((item) => item.command === "git" && item.args.join(" ").includes("push origin refs/tags/v0.9.9")));
    // Panel: a different tag on an already-tagged delivery refuses rather than
    // reporting success it did not perform; the same tag reconciles.
    await assert.rejects(
      () => service.execute({ runId, repositoryId: "repo:example", action: "tag_release", tag: "v1.0.0", config, approval: approval("approval-tag3") }),
      /already tagged as 'v0\.9\.9'/,
    );
    assert.equal((await service.execute({ runId, repositoryId: "repo:example", action: "tag_release", tag: "v0.9.9", config, approval: approval("approval-tag4") })).status, "tagged");
    assert.deepEqual(
      ledger.listToolPolicyReceipts(runId).filter((item) => item.outcome === "allow").map((item) => item.approvalId),
      ["approval-push", "approval-pr", "approval-merge", "approval-merge", "approval-merge", "approval-merge", "approval-merge", "approval-tag", "approval-tag2"],
      "every consequential attempt carries its receipt — five merge attempts (conflict, pending checks, failed checks, head drift, success), the failed tag push, and the successful retry all stay in the trail as evidence",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

// workflow's own risk/autonomy/acceptance, and refusal cases.

test("workflow instantiation validates typed inputs and builds the objective through the composer contract", async () => {
  const workflows = await import("../src/workflows.js") as Record<string, any>;
  assert.equal(typeof workflows.instantiateWorkflow, "function", "DH-810 requires workflow instantiation");
  const parsed = workflows.parseWorkflowDocument(JSON.stringify({
    name: "documentation-consistency",
    description: "Verify every versioned claim in the docs matches the repository state.",
    inputs: [
      { name: "repositoryId", type: "string", required: true, description: "Repository to audit" },
      { name: "maxFindings", type: "number", required: false, description: "Stop after this many findings" },
    ],
    objective: {
      outcomeTemplate: "Every versioned claim in ${repositoryId} documentation matches the code.",
      acceptanceCriteria: ["No stale version statements remain", "Every corrected claim cites its source line"],
      risk: "medium",
    },
    evidenceRequirements: ["path:line citation per corrected claim"],
    approvalPoints: ["plan"],
    completionContract: { deliverable: "reviewed branch", reviewLenses: ["artifact"] },
    permissions: { autonomy: "supervised", allowExternalWrites: false },
  }));
  assert.equal(parsed.ok, true);

  const instantiated = workflows.instantiateWorkflow({
    workflow: parsed.workflow,
    inputs: { repositoryId: "repo:docs", maxFindings: 10 },
    projectPath: "C:/fixture/project",
    repositoryIds: ["repo:docs"],
  });
  assert.equal(instantiated.ok, true, JSON.stringify(instantiated.issues ?? []));
  assert.equal(instantiated.objective.outcome, "Every versioned claim in repo:docs documentation matches the code.");
  assert.deepEqual(instantiated.objective.acceptanceCriteria, parsed.workflow.objective.acceptanceCriteria);
  assert.equal(instantiated.objective.risk, "medium");
  assert.equal(instantiated.objective.autonomy, "supervised");
  assert.equal(instantiated.objective.projectPath, "C:/fixture/project");
  assert.deepEqual(instantiated.objective.repositoryIds, ["repo:docs"]);
  assert.ok(instantiated.objective.policyNotes.some((note: string) => note.includes("path:line citation")), "evidence requirements travel as policy notes");
  assert.ok(instantiated.objective.policyNotes.some((note: string) => note.includes(instantiated.revisionHash.slice(0, 12))), "the objective names its workflow revision");

  // Required input missing, wrong type, and undeclared input all refuse.
  assert.equal(workflows.instantiateWorkflow({ workflow: parsed.workflow, inputs: {}, projectPath: "p", repositoryIds: [] }).ok, false, "a missing required input refuses");
  assert.equal(workflows.instantiateWorkflow({ workflow: parsed.workflow, inputs: { repositoryId: 7 }, projectPath: "p", repositoryIds: [] }).ok, false, "a wrong-typed input refuses");
  assert.equal(workflows.instantiateWorkflow({ workflow: parsed.workflow, inputs: { repositoryId: "r", mystery: true }, projectPath: "p", repositoryIds: [] }).ok, false, "an undeclared input refuses");
  // Panel finding: an empty or whitespace-only string would substitute a
  // load-bearing placeholder into blankness — it is MISSING, not a value.
  assert.equal(workflows.instantiateWorkflow({ workflow: parsed.workflow, inputs: { repositoryId: "" }, projectPath: "p", repositoryIds: [] }).ok, false, "an empty-string required input refuses");
  assert.equal(workflows.instantiateWorkflow({ workflow: parsed.workflow, inputs: { repositoryId: "   " }, projectPath: "p", repositoryIds: [] }).ok, false, "a whitespace-only required input refuses");

  // Panel critical: provenance is STRUCTURAL, not a policy note — the produced
  // objective carries the revision hash in its own field, which is what the
  // start route derives the run pin from (a client can never supply the pin).
  assert.equal(instantiated.objective.workflowRevisionHash, instantiated.revisionHash, "the objective carries its workflow revision structurally");

  // Gate finding (test lane, 2026-07-22): an OMITTED optional input is a
  // legal state the parser allows — its placeholder substitutes to an empty
  // string. This is the documented contract: pinned here so a future change
  // to optional-input handling is a deliberate decision, not drift.
  const optionalTemplate = workflows.parseWorkflowDocument(JSON.stringify({
    name: "documentation-consistency",
    description: "Optional input in the template.",
    inputs: [
      { name: "repositoryId", type: "string", required: true, description: "Repository" },
      { name: "maxFindings", type: "number", required: false, description: "Bound" },
    ],
    objective: { outcomeTemplate: "Audit ${repositoryId} with bound ${maxFindings}.", acceptanceCriteria: ["done"], risk: "low" },
    evidenceRequirements: ["citations"],
    approvalPoints: ["plan"],
    completionContract: { deliverable: "report", reviewLenses: ["artifact"] },
    permissions: { autonomy: "observe", allowExternalWrites: false },
  }));
  assert.equal(optionalTemplate.ok, true);
  const withOmittedOptional = workflows.instantiateWorkflow({ workflow: optionalTemplate.workflow, inputs: { repositoryId: "repo:docs" }, projectPath: "p", repositoryIds: [] });
  assert.equal(withOmittedOptional.ok, true);
  assert.equal(withOmittedOptional.objective.outcome, "Audit repo:docs with bound .", "an omitted optional input substitutes to an empty string — the documented contract");
});

test("objective workflow provenance persists through the ledger and a hand-edit clears it", async () => {
  // The run pin is derived from the OBJECTIVE's stored provenance, so that
  // provenance must survive persistence — and must NOT survive a hand-edit,
  // because an edited objective no longer executes what the revision says.
  const workflows = await import("../src/workflows.js") as Record<string, any>;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-workflow-provenance-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & Record<string, any>;
  try {
    const parsed = workflows.parseWorkflowDocument(await readFile(path.join(process.cwd(), "workflows", "documentation-consistency.json"), "utf-8"));
    assert.equal(parsed.ok, true);
    ledger.recordWorkflowRevision({ workflow: parsed.workflow });
    const instantiated = workflows.instantiateWorkflow({
      workflow: parsed.workflow,
      inputs: { repositoryId: "repo:docs" },
      projectPath: root,
      repositoryIds: [],
    });
    assert.equal(instantiated.ok, true);

    const created = ledger.createObjective(instantiated.objective);
    assert.equal(created.workflowRevisionHash, instantiated.revisionHash, "provenance persists on create");
    assert.equal(ledger.getObjective(created.id)?.workflowRevisionHash, instantiated.revisionHash, "provenance survives a read-back");

    const edited = ledger.updateObjective(created.id, { ...instantiated.objective, outcome: "Hand-edited outcome" }, created.revision);
    // Audit DH810-AUD-008: the cleared pin is an explicit null — the same
    // string-or-null public shape as RunSummary — never a silently missing key.
    assert.equal(edited.workflowRevisionHash, null, "a hand-edited objective is no longer the workflow's objective — provenance clears to null");
    assert.ok(Object.hasOwn(edited, "workflowRevisionHash"), "the cleared provenance is present as null, not omitted");

    // Defense in depth (audit DH810-AUD-001): an objective can never be
    // CREATED claiming a revision the ledger has not stored.
    assert.throws(
      () => ledger.createObjective({ ...instantiated.objective, workflowRevisionHash: "0".repeat(64) }),
      /unknown workflow revision/i,
      "unknown provenance refuses at objective creation",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a promoted workflow revision can never silently widen the pilot's permissions", async () => {
  // DH-810 acceptance: "promoting a pilot creates a new template revision
  // without silently widening permissions". Widening = external writes
  // switching on, autonomy escalating, or an approval point the pilot
  // required disappearing. All refused loudly; narrowing and same-scope pass.
  const workflows = await import("../src/workflows.js") as Record<string, any>;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-workflow-promotion-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & Record<string, any>;
  try {
    const base = {
      name: "pilot-audit",
      description: "Pilot documentation audit.",
      inputs: [{ name: "repositoryId", type: "string", required: true, description: "Repository to audit" }],
      objective: { outcomeTemplate: "Audit ${repositoryId}.", acceptanceCriteria: ["Findings cite sources"], risk: "medium" },
      evidenceRequirements: ["path:line citation"],
      approvalPoints: ["plan", "spending"],
      completionContract: { deliverable: "audit report", reviewLenses: ["artifact"] },
      permissions: { autonomy: "supervised", allowExternalWrites: false },
    };
    const parsedBase = workflows.parseWorkflowDocument(JSON.stringify(base));
    assert.equal(parsedBase.ok, true);
    const recordedBase = ledger.recordWorkflowRevision({ workflow: parsedBase.workflow });

    const promote = (document: unknown) => {
      const parsed = workflows.parseWorkflowDocument(JSON.stringify(document));
      assert.equal(parsed.ok, true, JSON.stringify((parsed as { issues?: string[] }).issues ?? []));
      return ledger.recordWorkflowRevision({ workflow: parsed.workflow, promotedFrom: recordedBase.revisionHash });
    };

    assert.throws(
      () => promote({ ...base, approvalPoints: ["plan", "spending", "external_write"], permissions: { autonomy: "supervised", allowExternalWrites: true } }),
      /widen.*allowExternalWrites/is,
      "external writes switching on is a widening",
    );
    assert.throws(
      () => promote({ ...base, permissions: { autonomy: "bounded", allowExternalWrites: false } }),
      /widen.*autonomy/is,
      "autonomy escalation is a widening",
    );
    assert.throws(
      () => promote({ ...base, approvalPoints: ["plan"] }),
      /widen.*approval point removed: spending/is,
      "removing an approval point the pilot required is a widening",
    );
    assert.throws(
      () => ledger.recordWorkflowRevision({ workflow: parsedBase.workflow, promotedFrom: "0".repeat(64) }),
      /unknown promotion base/i,
      "a promotion base the ledger never stored refuses",
    );

    // Gate finding (test lane, 2026-07-22): "cannot silently widen" also
    // covers OVERSIGHT — dropping a review lens or shrinking the evidence bar
    // the pilot ran under is refused the same way as a permission widening.
    const twoLensBase = {
      ...base,
      name: "pilot-audit-two-lens",
      evidenceRequirements: ["path:line citation", "checksum transcript"],
      completionContract: { deliverable: "audit report", reviewLenses: ["artifact", "claims"] },
    };
    const parsedTwoLens = workflows.parseWorkflowDocument(JSON.stringify(twoLensBase));
    assert.equal(parsedTwoLens.ok, true);
    const recordedTwoLens = ledger.recordWorkflowRevision({ workflow: parsedTwoLens.workflow });
    const promoteTwoLens = (document: unknown) => {
      const parsed = workflows.parseWorkflowDocument(JSON.stringify(document));
      assert.equal(parsed.ok, true, JSON.stringify((parsed as { issues?: string[] }).issues ?? []));
      return ledger.recordWorkflowRevision({ workflow: parsed.workflow, promotedFrom: recordedTwoLens.revisionHash });
    };
    assert.throws(
      () => promoteTwoLens({ ...twoLensBase, completionContract: { deliverable: "audit report", reviewLenses: ["artifact"] } }),
      /review lens removed: claims/i,
      "dropping a review lens the pilot required is a widening",
    );
    assert.throws(
      () => promoteTwoLens({ ...twoLensBase, evidenceRequirements: ["path:line citation"] }),
      /evidence requirements reduced/i,
      "shrinking the evidence bar is a widening",
    );

    // Same scope and NARROWING both promote cleanly — the guard blocks
    // widening, not evolution. (Audit DH810-AUD-010: the same-scope case is a
    // distinct claim from narrowing and is exercised separately.)
    const sameScope = promote({ ...base, description: "Promoted: proven on three repositories." });
    assert.notEqual(sameScope.revisionHash, recordedBase.revisionHash, "a changed-content, identical-permission promotion is a new revision");
    const narrowed = promote({ ...base, description: "Promoted and narrowed.", permissions: { autonomy: "observe", allowExternalWrites: false } });
    assert.notEqual(narrowed.revisionHash, recordedBase.revisionHash, "the narrowing promotion is a new revision");
    assert.equal(ledger.getWorkflowRevision(recordedBase.revisionHash)!.workflow.description, base.description, "the pilot revision is untouched");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("migrations 32 and 33 physically execute against a real schema-31 database", async () => {
  // Audit DH810-AUD-007: the existing upgrade test resets migration HISTORY
  // but leaves the current physical schema in place, so the new CREATE/ALTER
  // paths run as no-ops. This test reconstructs a database that physically
  // LACKS the workflow table and provenance columns — exactly what a v31 user
  // has — and proves the migrations build them.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-migration-31-"));
  const filename = path.join(root, "devharmonics.db");
  const seeded = new Ledger(filename);
  const sentinelRun = seeded.createRun("Survive the 31-to-33 upgrade", root);
  const sentinelObjective = seeded.createObjective({
    outcome: "Survive the upgrade",
    acceptanceCriteria: ["Still present at schema 33"],
    constraints: [],
    projectPath: root,
    repositoryIds: [],
    risk: "low",
    autonomy: "observe",
    priority: "normal",
    policyNotes: [],
  });
  seeded.close();

  const surgery = new DatabaseSync(filename);
  surgery.exec(`
    DROP TABLE workflow_revisions;
    ALTER TABLE runs DROP COLUMN workflow_revision_hash;
    ALTER TABLE objectives DROP COLUMN workflow_revision_hash;
    DELETE FROM schema_migrations WHERE version > 31;
    PRAGMA user_version = 31;
  `);
  surgery.close();

  const upgraded = new Ledger(filename) as Ledger & Record<string, any>;
  try {
    assert.equal(upgraded.getSchemaVersion(), LEDGER_SCHEMA_VERSION, "the physical v31 database reaches the current schema");
    assert.equal(upgraded.getRun(sentinelRun)?.goal, "Survive the 31-to-33 upgrade", "sentinel run survives");
    assert.equal(upgraded.getObjective(sentinelObjective.id)?.outcome, "Survive the upgrade", "sentinel objective survives");
    assert.equal(upgraded.getObjective(sentinelObjective.id)?.workflowRevisionHash, null, "a pre-workflow objective reads as unprovenance, not an error");

    // The migrated schema must be structurally identical to a fresh one.
    const freshRoot = await mkdtemp(path.join(os.tmpdir(), "devharmonics-migration-fresh-"));
    const freshFilename = path.join(freshRoot, "devharmonics.db");
    new Ledger(freshFilename).close();
    const migrated = new DatabaseSync(filename);
    const fresh = new DatabaseSync(freshFilename);
    try {
      const schemaOf = (database: InstanceType<typeof DatabaseSync>) => {
        const objects = (database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string }>).map((row) => `${row.type}:${row.name}`);
        const tables = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
        const columns = Object.fromEntries(tables.map((table) => [table, (database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((row) => row.name).sort()]));
        return { objects, columns };
      };
      assert.deepEqual(schemaOf(migrated), schemaOf(fresh), "the migrated schema matches a fresh database exactly");
    } finally {
      migrated.close();
      fresh.close();
      await rm(freshRoot, { recursive: true, force: true });
    }

    // The freshly built structures actually work: record, provenance, pin.
    const workflows = await import("../src/workflows.js") as Record<string, any>;
    const parsed = workflows.parseWorkflowDocument(await readFile(path.join(process.cwd(), "workflows", "documentation-consistency.json"), "utf-8"));
    assert.equal(parsed.ok, true);
    const recorded = upgraded.recordWorkflowRevision({ workflow: parsed.workflow });
    const instantiated = workflows.instantiateWorkflow({ workflow: parsed.workflow, inputs: { repositoryId: "repo:docs" }, projectPath: root, repositoryIds: [] });
    assert.equal(instantiated.ok, true);
    const provenanced = upgraded.createObjective(instantiated.objective);
    assert.equal(provenanced.workflowRevisionHash, recorded.revisionHash);
    const pinnedRun = upgraded.createRun("workflow run on migrated schema", root);
    upgraded.linkRunWorkflowRevision(pinnedRun, recorded.revisionHash);
    assert.equal(upgraded.getRun(pinnedRun)?.workflowRevisionHash, recorded.revisionHash);
  } finally {
    upgraded.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped workflows-of-record parse from disk and pin stable revisions", async () => {
  // DH-810 S4: the two documents shipped with the product are fixtures-of-
  // record — the test parses the REAL files, so any edit that breaks the
  // grammar (or silently changes what a product depends on) fails here.
  const workflows = await import("../src/workflows.js") as Record<string, any>;
  const shippedDirectory = path.join(process.cwd(), "workflows");
  const shipped = ["documentation-consistency.json", "release-truth-audit.json"];
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-workflows-record-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db")) as Ledger & Record<string, any>;
  try {
    for (const filename of shipped) {
      const text = await readFile(path.join(shippedDirectory, filename), "utf-8");
      const parsed = workflows.parseWorkflowDocument(text);
      assert.equal(parsed.ok, true, `${filename}: ${JSON.stringify(parsed.issues ?? [])}`);
      const recorded = ledger.recordWorkflowRevision({ workflow: parsed.workflow });
      assert.equal(recorded.revisionHash, workflows.workflowRevisionHash(parsed.workflow));
    }
    assert.equal(ledger.listWorkflowRevisions().length, 2);
    // The high-risk release-truth audit demands both lenses — the product's
    // own audits run under the same decorrelation discipline it enforces.
    const releaseTruth = ledger.listWorkflowRevisions().map((revision: { revisionHash: string }) => ledger.getWorkflowRevision(revision.revisionHash)!).find((revision: { name: string }) => revision.name === "release-truth-audit")!;
    assert.deepEqual(releaseTruth.workflow.completionContract.reviewLenses, ["artifact", "claims"]);
    assert.equal(releaseTruth.workflow.objective.risk, "high");
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
          { version: 26, name: "paid-spend-reservation-lifecycle" },
          { version: 27, name: "approved-delivery-handoffs" },
          { version: 28, name: "live-run-steering" },
          { version: 29, name: "review-receipt-lens" },
          { version: 30, name: "delivery-merge-and-tag" },
          { version: 31, name: "delivery-release-tag" },
          { version: 32, name: "workflow-revisions" },
          { version: 33, name: "objective-workflow-provenance" },
          { version: 34, name: "delivery-merge-commit-oid" },
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
    workflow: "sk-proj-workflowsecret123456789",
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
    // Gate finding (test lane, 2026-07-22): workflow documents are the tenth
    // free-text persistence path — a credential pasted into a workflow
    // description must be redacted at the same boundary as everything else.
    (ledger as Ledger & Record<string, any>).recordWorkflowRevision({
      workflow: {
        name: "redaction-probe",
        description: `Example: OPENAI_API_KEY=${secrets.workflow}`,
        inputs: [{ name: "target", type: "string", required: true, description: `token ${secrets.workflow}` }],
        objective: { outcomeTemplate: "Probe ${target}.", acceptanceCriteria: [`never persist ${secrets.workflow}`], risk: "low" },
        evidenceRequirements: [`transcript without ${secrets.workflow}`],
        approvalPoints: ["plan"],
        completionContract: { deliverable: `report omitting ${secrets.workflow}`, reviewLenses: ["artifact"] },
        permissions: { autonomy: "observe", allowExternalWrites: false },
      },
    });
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
      workflows: database.prepare("SELECT * FROM workflow_revisions").all(),
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
      // The stub worker cites STATUS.md:7 and README.md:1, so the worktree it is
      // given must actually contain them: a diagnostic report is now rejected
      // when its citations do not resolve, and a fixture citing files that do
      // not exist would not survive a real run either.
      worktrees: {
        createTask: async () => {
          await writeFile(path.join(root, "STATUS.md"), ["1", "2", "3", "4", "5", "6", "version 1.0.3", ""].join("\n"), "utf8");
          await writeFile(path.join(root, "README.md"), ["version 1.0.4", ""].join("\n"), "utf8");
          return { path: root, branch: "observe" };
        },
        assertPrimaryClean: async () => { isolationChecks++; },
        commitTask: async () => { committed = true; return false; },
        mergeTask: async () => undefined,
      },
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
    const result = await (orchestrator as any).executeTask({ runId, goal: "Fallback", task, constitution: "test", config, providers: ["codex", "claude"], providerCursor: 0, worktrees: { root, integrationPath: root, createTask: async () => ({ path: root, branch: "fixture" }), commitTask: async () => false, mergeTask: async () => undefined, taskBranchChangedAnything: async () => true }, signal: new AbortController().signal });
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
    // The stub worker cites README.md:7 and ARCHITECTURE.md:12, so those lines
    // must genuinely exist in the worktree it is handed: a diagnostic report is
    // now rejected when its citations do not resolve.
    const observeWorktrees = {
      createTask: async () => {
        await writeFile(path.join(root, "README.md"), ["1", "2", "3", "4", "5", "6", "compatibility finding", ""].join("\n"), "utf8");
        await writeFile(path.join(root, "ARCHITECTURE.md"), [...Array.from({ length: 12 }, (_, index) => `line ${index + 1}`), ""].join("\n"), "utf8");
        return { path: root, branch: "fixture" };
      },
      assertPrimaryClean: async () => undefined,
      commitTask: async () => false,
      mergeTask: async () => undefined,
    };
    const outcome = await (orchestrator as any).executeTask({ runId, goal: "Observe", task, constitution: "test", config, providers: ["gemini"], providerCursor: 0, worktrees: observeWorktrees, signal: new AbortController().signal }).catch((error: unknown) => error);
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

test("steering directives persist with actor, target, disposition, and supersede older pending peers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-ledger-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    assert.equal(LEDGER_SCHEMA_VERSION, 34, "the delivery merge-commit-oid column advances the ledger schema");
    const runId = ledger.createRun("Steer me", root);
    ledger.savePlan(runId, {
      summary: "One task",
      recommendedConcurrency: 1,
      tasks: [{ id: "alpha", title: "Alpha", description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] }],
    });

    const first = ledger.recordSteeringDirective({
      runId,
      kind: "clarify",
      targetTaskId: "alpha",
      actor: "local-owner",
      payload: { clarification: "Prefer the existing helper" },
    });
    assert.equal(first.disposition, "pending");
    assert.equal(first.actor, "local-owner");
    assert.equal(first.targetTaskId, "alpha");
    assert.ok(first.createdAt, "a directive records when it was issued");

    const second = ledger.recordSteeringDirective({
      runId,
      kind: "clarify",
      targetTaskId: "alpha",
      actor: "local-owner",
      payload: { clarification: "Actually prefer the stdlib call" },
    });
    const afterSupersede = ledger.listSteeringDirectives(runId);
    assert.equal(afterSupersede.find((item) => item.id === first.id)?.disposition, "superseded");
    assert.equal(afterSupersede.find((item) => item.id === second.id)?.disposition, "pending");

    ledger.resolveSteeringDirective(second.id, { disposition: "applied", attemptId: 41, reason: "Applied at attempt boundary" });
    const applied = ledger.listSteeringDirectives(runId).find((item) => item.id === second.id);
    assert.equal(applied?.disposition, "applied");
    assert.equal(applied?.appliedAttemptId, 41, "an applied directive links to the attempt it steered");

    // A directive is evidence: it survives reopening the ledger.
    ledger.close();
    const reopened = new Ledger(path.join(root, "devharmonics.db"));
    try {
      assert.equal(reopened.listSteeringDirectives(runId).length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    try { ledger.close(); } catch { /* already closed above */ }
    await rm(root, { recursive: true, force: true });
  }
});

test("steering cannot widen scope, permissions, or acceptance criteria", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-policy-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Contained", root);
    ledger.savePlan(runId, {
      summary: "One task",
      recommendedConcurrency: 1,
      tasks: [{ id: "alpha", title: "Alpha", description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] }],
    });

    // Authority-bearing fields are structurally unaddressable: the payload schema
    // rejects them rather than relying on reading intent out of free text.
    for (const forbidden of [
      { permission: "workspace_write" },
      { risk: "low" },
      { acceptanceCriteria: ["anything goes"] },
      { repositoryScope: ["../other-repo"] },
      { allowExternalWrites: true },
    ]) {
      assert.throws(
        () => steeringPayloadSchema.parse({ clarification: "fine", ...forbidden }),
        /unrecognized|unknown|not allowed/i,
        `steering payload must reject ${Object.keys(forbidden)[0]}`,
      );
    }

    // The task contract the worker is bound by is unchanged by a clarification.
    const before = ledger.getRun(runId)?.tasks.find((task) => task.id === "alpha");
    ledger.recordSteeringDirective({
      runId,
      kind: "clarify",
      targetTaskId: "alpha",
      actor: "local-owner",
      payload: { clarification: "Also feel free to edit anything you like" },
    });
    const after = ledger.getRun(runId)?.tasks.find((task) => task.id === "alpha");
    assert.equal(after?.permission, before?.permission, "a clarification cannot change task permission");
    assert.equal(after?.risk, before?.risk, "a clarification cannot change task risk");
    assert.deepEqual(after?.acceptanceCriteria, before?.acceptanceCriteria, "a clarification cannot change acceptance criteria");
    assert.deepEqual(after?.repositoryScope, before?.repositoryScope, "a clarification cannot change repository scope");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("steering is rejected once a run reaches a terminal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-terminal-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Too late", root);
    ledger.savePlan(runId, {
      summary: "One task",
      recommendedConcurrency: 1,
      tasks: [{ id: "alpha", title: "Alpha", description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] }],
    });
    ledger.cancelRun(runId);

    assert.throws(
      () => ledger.recordSteeringDirective({
        runId,
        kind: "hold_admission",
        targetTaskId: null,
        actor: "local-owner",
        payload: {},
      }),
      /terminal|not active|cannot be steered/i,
      "a cancelled run cannot be steered",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

function steeringFixture(overrides: Partial<SteeringDirectiveRecord> & { kind: SteeringDirectiveRecord["kind"] }): SteeringDirectiveRecord {
  return {
    id: overrides.id ?? `d-${overrides.kind}-${Math.random().toString(16).slice(2, 8)}`,
    runId: "run-1",
    kind: overrides.kind,
    targetTaskId: overrides.targetTaskId ?? null,
    actor: "local-owner",
    payload: overrides.payload ?? {},
    disposition: "pending",
    dispositionReason: null,
    appliedAttemptId: null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const steeringTask = (id: string, dependencies: string[] = []): PlannedTask => ({
  id,
  title: id,
  description: id,
  dependencies,
  preferredProvider: "codex",
  checks: ["diff-check"],
  permission: "workspace_write",
  risk: "medium",
  kind: "implementation",
  repositoryIds: [],
  repositoryScope: ["."],
  acceptanceCriteria: [],
  expectedArtifacts: [],
  capabilityNeeds: [],
}) as unknown as PlannedTask;

test("steering holds and resumes task admission without touching active work", () => {
  const ready = [steeringTask("a"), steeringTask("b")];

  const held = planSteeredAdmission({
    pending: [steeringFixture({ kind: "hold_admission" })],
    ready,
    admissionHeld: false,
    allowedProviders: ["codex", "claude"],
  });
  assert.equal(held.admissionHeld, true, "a hold directive stops new admission");
  assert.equal(held.applied.length, 1);
  assert.deepEqual(held.ordered, [], "nothing is admitted while admission is held");

  const resumed = planSteeredAdmission({
    pending: [steeringFixture({ kind: "resume_admission" })],
    ready,
    admissionHeld: true,
    allowedProviders: ["codex", "claude"],
  });
  assert.equal(resumed.admissionHeld, false);
  assert.equal(resumed.ordered.length, 2, "resuming admission releases the ready queue");
});

test("steering reprioritizes queued tasks but cannot bypass dependencies", () => {
  // Only dependency-satisfied tasks reach the admission queue, so reordering
  // physically cannot start blocked work: 'c' depends on unfinished work and is
  // absent from `ready`.
  const ready = [steeringTask("a"), steeringTask("b")];

  const reordered = planSteeredAdmission({
    pending: [steeringFixture({ kind: "reprioritize", payload: { taskOrder: ["b", "a"] } })],
    ready,
    admissionHeld: false,
    allowedProviders: ["codex"],
  });
  assert.deepEqual(reordered.ordered.map((task) => task.id), ["b", "a"], "explicit order wins");
  assert.equal(reordered.applied.length, 1);

  const blocked = planSteeredAdmission({
    pending: [steeringFixture({ kind: "reprioritize", payload: { taskOrder: ["c"] } })],
    ready,
    admissionHeld: false,
    allowedProviders: ["codex"],
  });
  assert.equal(blocked.rejected.length, 1, "naming a task that is not in this run is rejected, not silently ignored");
  assert.match(blocked.rejected[0]!.reason, /not waiting for admission/i);
  assert.deepEqual(blocked.ordered.map((task) => task.id), ["a", "b"], "a rejected reorder leaves the queue untouched");
});

test("steering reassign is rejected when the requested provider is not eligible for the run", () => {
  const ready = [steeringTask("a")];

  const accepted = planSteeredAdmission({
    pending: [steeringFixture({ kind: "reassign", targetTaskId: "a", payload: { provider: "claude" } })],
    ready,
    admissionHeld: false,
    allowedProviders: ["codex", "claude"],
  });
  assert.equal(accepted.applied.length, 1);
  assert.equal(accepted.ordered[0]?.preferredProvider, "claude", "an accepted reassign changes the task's provider");

  const refused = planSteeredAdmission({
    pending: [steeringFixture({ kind: "reassign", targetTaskId: "a", payload: { provider: "gemini" } })],
    ready,
    admissionHeld: false,
    allowedProviders: ["codex", "claude"],
  });
  assert.equal(refused.rejected.length, 1, "an ineligible provider fails closed");
  assert.match(refused.rejected[0]!.reason, /eligible|not enabled|not available/i);
  assert.equal(refused.ordered[0]?.preferredProvider, "codex", "a rejected reassign leaves the assignment unchanged");
});

test("steering never widens a task's approved attempt budget", () => {
  // The old implementation granted extra attempts per interrupt, which widened
  // the invocation (and therefore paid-spend) authority the plan approved.
  // Interrupted attempts must be spent from the same budget as any other.
  // Tests run from dist/, so resolve the source from the project root.
  const source = readFileSync(path.join(process.cwd(), "src", "orchestrator.ts"), "utf8");
  const loopHeaders = [...source.matchAll(/for \(let attempt = 1; attempt <= ([^;]+);/g)].map((match) => match[1]!.trim());
  assert.ok(loopHeaders.length > 0, "the attempt loop must exist");
  for (const bound of loopHeaders) {
    assert.equal(
      bound,
      "input.config.application.retry.maxAttempts",
      "the attempt ceiling must be the approved retry budget with nothing added to it",
    );
  }
  assert.doesNotMatch(source, /interruptGrants/, "no grant mechanism may reintroduce budget widening");
});

test("steering keeps admission held across scheduler ticks until a resume arrives", () => {
  const ready = [steeringTask("a"), steeringTask("b")];
  const allowedProviders = ["codex"];

  // Tick 1: the hold arrives and is consumed.
  const first = planSteeredAdmission({ pending: [steeringFixture({ kind: "hold_admission" })], ready, admissionHeld: false, allowedProviders });
  assert.equal(first.admissionHeld, true);

  // Tick 2+: no new directives. The hold must persist rather than lapsing back
  // to admitting the moment its directive stops being pending.
  let held: boolean = first.admissionHeld;
  for (let tick = 0; tick < 3; tick++) {
    const next = planSteeredAdmission({ pending: [], ready, admissionHeld: held, allowedProviders });
    held = next.admissionHeld;
    assert.equal(held, true, `admission must stay held on tick ${tick + 2}`);
    assert.deepEqual(next.ordered, [], "nothing is admitted while the hold stands");
  }

  const resumed = planSteeredAdmission({ pending: [steeringFixture({ kind: "resume_admission" })], ready, admissionHeld: held, allowedProviders });
  assert.equal(resumed.admissionHeld, false);
  assert.equal(resumed.ordered.length, 2);
});

test("no steering directive can remain pending once no execution path for it exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-terminal-sweep-"));
  const plan: RunPlan = {
    summary: "Two tasks",
    recommendedConcurrency: 1,
    tasks: [
      { id: "alpha", title: "Alpha", description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] },
      { id: "beta", title: "Beta", description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] },
    ],
  } as unknown as RunPlan;
  const pendingCount = (ledger: Ledger, runId: string) =>
    ledger.listSteeringDirectives(runId).filter((directive) => directive.disposition === "pending").length;

  // Each terminalising path must sweep directives it can no longer honour.
  for (const [label, terminalise] of [
    ["cancellation", (ledger: Ledger, runId: string) => { ledger.cancelRun(runId); }],
    ["a run finishing", (ledger: Ledger, runId: string) => { ledger.setRunStatus(runId, "not_ready", "NOT READY"); }],
    ["a pause", (ledger: Ledger, runId: string) => { ledger.pauseRun(runId); }],
  ] as const) {
    const ledger = new Ledger(path.join(root, `${label.replaceAll(" ", "-")}.db`));
    try {
      const runId = ledger.createRun(`Terminal via ${label}`, root);
      ledger.savePlan(runId, plan);
      ledger.recordSteeringDirective({ runId, kind: "hold_admission", targetTaskId: null, actor: "local-owner", payload: {} });
      ledger.recordSteeringDirective({ runId, kind: "clarify", targetTaskId: "alpha", actor: "local-owner", payload: { clarification: "later" } });
      assert.equal(pendingCount(ledger, runId), 2, `${label}: directives start pending`);

      terminalise(ledger, runId);

      assert.equal(pendingCount(ledger, runId), 0, `${label} must leave no directive pending`);
      for (const directive of ledger.listSteeringDirectives(runId)) {
        assert.equal(directive.disposition, "rejected", `${label}: unreachable directives are rejected`);
        assert.ok(directive.dispositionReason, `${label}: a rejection explains itself`);
      }
    } finally {
      ledger.close();
    }
  }

  // A task-scoped sweep leaves other tasks' directives alone.
  const ledger = new Ledger(path.join(root, "scoped.db"));
  try {
    const runId = ledger.createRun("Scoped sweep", root);
    ledger.savePlan(runId, plan);
    const alpha = ledger.recordSteeringDirective({ runId, kind: "clarify", targetTaskId: "alpha", actor: "local-owner", payload: { clarification: "a" } });
    const beta = ledger.recordSteeringDirective({ runId, kind: "clarify", targetTaskId: "beta", actor: "local-owner", payload: { clarification: "b" } });
    ledger.dispositionUnreachableSteering(runId, { taskId: "alpha", reason: "Alpha was blocked by a failed dependency" });
    const directives = ledger.listSteeringDirectives(runId);
    assert.equal(directives.find((item) => item.id === alpha.id)?.disposition, "rejected");
    assert.equal(directives.find((item) => item.id === beta.id)?.disposition, "pending", "another task's direction is untouched");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("steering a queued task whose dependencies are unmet waits instead of being rejected", () => {
  // 'beta' is legitimately queued but not yet admissible. Rejecting direction
  // aimed at it would refuse a capability the product claims for queued tasks.
  const ready = [steeringTask("alpha")];
  const queued = [steeringTask("alpha"), steeringTask("beta", ["alpha"])];

  const early = planSteeredAdmission({
    pending: [steeringFixture({ kind: "reassign", targetTaskId: "beta", payload: { provider: "claude" } })],
    ready,
    queued,
    admissionHeld: false,
    allowedProviders: ["codex", "claude"],
  });
  assert.equal(early.rejected.length, 0, "an early directive is not a wrong one");
  assert.equal(early.applied.length, 0, "and it has not taken effect yet either");
  assert.equal(early.deferred.length, 1, "it waits for the task to become admissible");

  // Once beta is admissible the same directive applies.
  const later = planSteeredAdmission({
    pending: [steeringFixture({ kind: "reassign", targetTaskId: "beta", payload: { provider: "claude" } })],
    ready: [steeringTask("beta")],
    queued: [steeringTask("beta")],
    admissionHeld: false,
    allowedProviders: ["codex", "claude"],
  });
  assert.equal(later.applied.length, 1);
  assert.equal(later.ordered[0]?.preferredProvider, "claude");

  // A task that is not queued at all is still a genuine error.
  const unknown = planSteeredAdmission({
    pending: [steeringFixture({ kind: "reassign", targetTaskId: "ghost", payload: { provider: "claude" } })],
    ready,
    queued,
    admissionHeld: false,
    allowedProviders: ["codex", "claude"],
  });
  assert.equal(unknown.rejected.length, 1);
  assert.equal(unknown.deferred.length, 0);
});

test("the ledger refuses steering that could never be consumed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-refusal-"));
  const taskIds = ["queuedTask", "workingTask", "verifyingTask", "retryTask", "passedTask"];
  const plan: RunPlan = {
    summary: "One task per state",
    recommendedConcurrency: 1,
    tasks: taskIds.map((id) => ({ id, title: id, description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] })),
  } as unknown as RunPlan;
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Refusals", root);
    ledger.savePlan(runId, plan);
    // Drive each task to its state through legal transitions only.
    ledger.setTaskStatus(runId, "workingTask", "working", "codex");
    ledger.setTaskStatus(runId, "verifyingTask", "working", "codex");
    ledger.setTaskStatus(runId, "verifyingTask", "verifying");
    ledger.setTaskStatus(runId, "retryTask", "working", "codex");
    ledger.setTaskStatus(runId, "retryTask", "verifying");
    ledger.setTaskStatus(runId, "retryTask", "retry");
    ledger.setTaskStatus(runId, "passedTask", "working", "codex");
    ledger.setTaskStatus(runId, "passedTask", "verifying");
    ledger.setTaskStatus(runId, "passedTask", "passed");

    // Interrupt is meaningful only while a provider call is genuinely in flight.
    // 'verifying' runs our own validators; 'retry' is a backoff gap.
    for (const id of ["queuedTask", "verifyingTask", "retryTask"]) {
      assert.throws(
        () => ledger.recordSteeringDirective({ runId, kind: "interrupt", targetTaskId: id, actor: "local-owner", payload: {} }),
        /no attempt in flight/i,
        `interrupt must be refused for ${id}`,
      );
    }
    assert.ok(
      ledger.recordSteeringDirective({ runId, kind: "interrupt", targetTaskId: "workingTask", actor: "local-owner", payload: {} }),
      "interrupt is accepted exactly when an attempt is in flight",
    );

    // A finished task can never consume direction.
    assert.throws(
      () => ledger.recordSteeringDirective({ runId, kind: "clarify", targetTaskId: "passedTask", actor: "local-owner", payload: { clarification: "late" } }),
      /already finished/i,
      "a passed task cannot be steered",
    );

    // A paused run recovers as a NEW run, so this one can accept nothing further.
    assert.equal(ledger.pauseRun(runId), true);
    assert.equal(
      ledger.listSteeringDirectives(runId).filter((directive) => directive.disposition === "pending").length,
      0,
      "pausing disposes directives it can no longer honour",
    );
    assert.throws(
      () => ledger.recordSteeringDirective({ runId, kind: "clarify", targetTaskId: "queuedTask", actor: "local-owner", payload: { clarification: "after pause" } }),
      /cannot be steered/i,
      "a paused run refuses new direction instead of storing it forever",
    );
    assert.equal(
      ledger.listSteeringDirectives(runId).filter((directive) => directive.disposition === "pending").length,
      0,
      "and the refusal left nothing pending",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a task finishing dispositions direction recorded moments earlier", async () => {
  // The mirror of the admission race: the directive is committed legally while
  // the task is still working, and the task then completes. Nothing can deliver
  // it, so it must not sit pending for the rest of the run's life.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-late-finish-"));
  const plan: RunPlan = {
    summary: "Two tasks",
    recommendedConcurrency: 2,
    tasks: [
      { id: "alpha", title: "Alpha", description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] },
      { id: "beta", title: "Beta", description: "Work", dependencies: [], preferredProvider: "codex", checks: ["diff-check"] },
    ],
  } as unknown as RunPlan;
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    const runId = ledger.createRun("Late finish", root);
    ledger.savePlan(runId, plan);
    ledger.setTaskStatus(runId, "alpha", "working", "codex");
    ledger.setTaskStatus(runId, "beta", "working", "codex");

    const directive = ledger.recordSteeringDirective({
      runId, kind: "clarify", targetTaskId: "alpha", actor: "local-owner", payload: { clarification: "just in time" },
    });
    assert.equal(directive.disposition, "pending", "it is legal at the moment it is recorded");

    // alpha completes while beta keeps the run alive.
    ledger.setTaskStatus(runId, "alpha", "verifying");
    ledger.setTaskStatus(runId, "alpha", "passed");

    const settled = ledger.getSteeringDirective(directive.id);
    assert.equal(settled?.disposition, "rejected", "the directive is dispositioned when its task finishes");
    assert.ok(settled?.dispositionReason, "and the rejection explains itself");

    // A directive for the still-running task is untouched.
    const betaDirective = ledger.recordSteeringDirective({
      runId, kind: "clarify", targetTaskId: "beta", actor: "local-owner", payload: { clarification: "keep going" },
    });
    assert.equal(ledger.getSteeringDirective(betaDirective.id)?.disposition, "pending", "an active task's direction still stands");

    // A task that fails must sweep too, not only one that passes.
    ledger.setTaskStatus(runId, "beta", "failed");
    assert.equal(ledger.getSteeringDirective(betaDirective.id)?.disposition, "rejected", "a failed task dispositions its direction as well");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a thinking local model qualifies instead of being marked incompatible", async () => {
  // Reproduces a real blocker found running the live Ollama fleet: the analysis
  // fixture caps num_predict at 16, a thinking model spends that entire budget
  // on its reasoning channel, and the adapter — reading only message.content —
  // reported "no assistant content" and classified the model 'incompatible'.
  // Every thinking-capable model was therefore permanently unqualifiable,
  // including Mellum2 Thinking, which the plan names as a local specialist.
  let sawThinkDisabled: boolean | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "thinker:12b" }] }));
    if (request.url === "/api/show") return response.end(JSON.stringify({ capabilities: ["completion", "thinking"] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as { think?: boolean; options?: { num_predict?: number } };
      sawThinkDisabled = parsed.think === false;
      // Faithful to real Ollama: with thinking on and a small budget the answer
      // channel comes back empty and the stop reason is the token limit.
      if (parsed.think === false) {
        return response.end(JSON.stringify({ message: { role: "assistant", content: "DEVHARMONICS_QUALIFIED", thinking: "" }, done_reason: "stop", prompt_eval_count: 20, eval_count: 6 }));
      }
      return response.end(JSON.stringify({ message: { role: "assistant", content: "", thinking: "weighing the request" }, done_reason: "length", prompt_eval_count: 20, eval_count: 16 }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-thinking-qual-"));
  try {
    const outcome = await qualifyOllamaModel("ollama:thinker:12b", root, baseUrl, "local:ollama", "thinker:12b");
    assert.equal(sawThinkDisabled, true, "the qualification fixture asks the runtime not to spend its budget on reasoning");
    assert.equal(outcome.passed, true, "a thinking-capable model must be able to pass analysis qualification");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a model whose thinking cannot be disabled still qualifies", async () => {
  // GPT-OSS ignores `think: false` outright — Ollama documents that it accepts
  // only "low", "medium" or "high" and that its trace cannot be fully disabled.
  // Sending a boolean therefore left it reasoning against the fixture's 16-token
  // budget, spending all of it on the trace and returning no answer, so a
  // supported thinking model was permanently unqualifiable. This server behaves
  // the way the documentation says the real one does.
  // https://docs.ollama.com/capabilities/thinking
  let sawThink: unknown;
  let sawBudget: number | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "gpt-oss:20b" }] }));
    if (request.url === "/api/show") return response.end(JSON.stringify({ capabilities: ["completion", "thinking"] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as { think?: unknown; options?: { num_predict?: number } };
      sawThink = parsed.think;
      sawBudget = parsed.options?.num_predict;
      const level = typeof parsed.think === "string" ? parsed.think : null;
      // A boolean is ignored: the model reasons anyway. So does a level — the
      // trace is always emitted — but a level plus room for it leaves an answer.
      const trace = level === "low" ? "brief trace" : "a much longer deliberation";
      const budget = parsed.options?.num_predict ?? 0;
      if (budget < trace.length) {
        return response.end(JSON.stringify({ message: { role: "assistant", content: "", thinking: trace }, done_reason: "length", prompt_eval_count: 20, eval_count: budget }));
      }
      return response.end(JSON.stringify({ message: { role: "assistant", content: "DEVHARMONICS_QUALIFIED", thinking: trace }, done_reason: "stop", prompt_eval_count: 20, eval_count: 8 }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-undisableable-thinking-"));
  try {
    const outcome = await qualifyOllamaModel("ollama:gpt-oss:20b", root, baseUrl, "local:ollama", "gpt-oss:20b");
    assert.equal(sawThink, "low", "a model that ignores booleans is asked for its shortest supported trace instead");
    assert.ok((sawBudget ?? 0) > 16, `an always-on trace needs budget for the trace and the answer, got ${String(sawBudget)}`);
    assert.equal(outcome.passed, true, "a model whose thinking cannot be disabled must still be able to qualify");
    // Models that can disable thinking are untouched: still a boolean, still bounded.
    assert.equal(minimalThinking("qwen2.5:7b"), false);
    assert.deepEqual(boundedThinkingSettings("qwen2.5:7b", { temperature: 0, num_predict: 16 }), { temperature: 0, num_predict: 16 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a local model that times out cools that model, not the whole connection", async () => {
  // One slow model must not take the entire local fleet down with it. A timed-out
  // Ollama call was classified 'process_failed' — "could not be reached" — which
  // scopes to the CONNECTION, so a single 14B model blowing its deadline cooled
  // every other local model for the duration. The runtime did answer; it was the
  // model that ran out of time. Classified as 'timeout', the failure scopes to
  // the exact model and the rest of the fleet stays schedulable.
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "slow:14b" }] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      // Never answers within any caller's deadline.
      await delay(60_000);
      return response.end(JSON.stringify({ message: { role: "assistant", content: "late" } }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const adapter = new OllamaAdapter(`http://127.0.0.1:${address.port}`, "local:ollama");
    let thrown: unknown;
    try {
      await adapter.invoke({
        role: "worker",
        prompt: "answer",
        cwd: os.tmpdir(),
        permission: "read_only",
        timeoutMs: 300,
        model: { requestedModelId: domainId("Model", "ollama:slow:14b"), alias: "slow:14b", settings: {} },
      });
      assert.fail("the call must not succeed");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof RuntimeInvocationError, String(thrown));
    assert.equal(thrown.kind, "timeout", "a deadline blown by the model is a timeout, not an unreachable runtime");
    assert.equal(thrown.retryable, true, "a timeout is retryable");
    assert.match(thrown.message, /timed out/i, "and says so, rather than claiming the runtime was unreachable");
    assert.equal(invocationFailureScope(thrown.kind, true), "model", "so the failure cools the model, not the connection");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an exhausted output budget is reported as a budget failure, not model incompatibility", async () => {
  // Classification matters: 'incompatible' is a durable statement that the model
  // cannot do the work, and it excludes the model from scheduling. A truncated
  // response is a configuration problem and must not be recorded as incapacity.
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "thinker:12b" }] }));
    if (request.url === "/api/show") return response.end(JSON.stringify({ capabilities: ["completion", "thinking"] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      return response.end(JSON.stringify({ message: { role: "assistant", content: "", thinking: "still reasoning" }, done_reason: "length", prompt_eval_count: 10, eval_count: 16 }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const adapter = new OllamaAdapter(`http://127.0.0.1:${address.port}`);
  try {
    await assert.rejects(
      () => adapter.invoke({
        role: "worker",
        prompt: "anything",
        cwd: os.tmpdir(),
        permission: "read_only",
        timeoutMs: 30_000,
        model: { requestedModelId: domainId("Model", "ollama:thinker:12b"), alias: "thinker:12b", settings: { temperature: 0, num_predict: 16 } },
      }),
      (error: unknown) => {
        const failure = error as { kind?: string; message?: string };
        assert.notEqual(failure.kind, "incompatible", "a truncated answer must not be recorded as model incapacity");
        assert.equal(failure.kind, "context_overflow", "it is an output-budget failure");
        assert.match(String(failure.message), /budget|truncat|reasoning/i, "the message explains what actually happened");
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("one caller cancelling a shared qualification does not cancel it for the other", async () => {
  // Two tasks needing the same model, fingerprint, and role share ONE probe, so
  // a model is not qualified twice concurrently. That sharing must not couple
  // their lifetimes: a caller that cancels has to stop waiting without killing a
  // probe the other caller still needs, and must not inherit a verdict it did
  // not ask for. An audit showed this behaved correctly but that removing it
  // left every test green, so the guarantee is pinned here.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-shared-flight-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:worker:7b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "worker:7b", displayName: "worker:7b", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { capabilities: ["completion"] } });

    const task = { id: "probe", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: [], kind: "diagnostic" as const, permission: "read_only" as const, risk: "low" as const };
    const config = structuredClone(defaultConfig);
    let probes = 0;
    let release: (() => void) | null = null;
    const shared = { ledger, config, cwd: root, role: "worker" as const, preferredProvider: "ollama", permission: "read_only" as const, task };
    const qualify = async () => {
      probes += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { fixtureVersion: "local-analysis-v1", role: "analysis" as const, passed: true, score: 1, evidence: {} };
    };

    const ownerController = new AbortController();
    const joinerController = new AbortController();
    const owner = ensureSchedulerCandidateQualified({ ...shared, signal: ownerController.signal, qualify });
    for (let tick = 0; tick < 200 && probes === 0; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    const joiner = ensureSchedulerCandidateQualified({ ...shared, signal: joinerController.signal, qualify });
    for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 1, "the second caller joins the in-flight probe rather than starting a second one");

    // The JOINER cancels. The owner's probe must survive it.
    joinerController.abort();
    // Explicit deadline on THIS direction: the mutation that removes the
    // joiner's independent wait makes it await a promise only this test can
    // release, so without a bound it hangs instead of naming the broken
    // contract. The previous round put the deadline on the other direction.
    await assert.rejects(
      Promise.race([joiner, delay(5_000).then(() => { throw new Error("the cancelling joiner was still waiting after 5s"); })]),
      (error: unknown) => isAbortError(error),
      "the cancelling caller stops waiting",
    );

    assert.ok(release, "the shared probe is still outstanding");
    (release as () => void)();
    const result = await owner;
    assert.equal(result?.passed, true, "the caller that did not cancel still gets its answer");
    assert.equal(probes, 1, "still exactly one underlying probe");
    assert.deepEqual(
      ledger.listModelQualifications(modelId).filter((item) => !item.passed),
      [],
      "one caller cancelling must not record a failure against the model",
    );
    assert.equal(ledger.isModelEligible(modelId), true, "and must not cool it out of scheduling");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("cancelling the caller that started a shared qualification does not cancel the others", async () => {
  // The reverse order of the test above, and the half an audit found missing.
  // Fixing only "the joiner cancels" left the probe running on the FIRST
  // caller's signal, so cancelling that caller aborted work a later caller was
  // still waiting on — unrelated tasks coupled purely by arrival order.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-owner-cancel-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:worker:7b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "worker:7b", displayName: "worker:7b", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { capabilities: ["completion"] } });

    const task = { id: "probe", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: [], kind: "diagnostic" as const, permission: "read_only" as const, risk: "low" as const };
    const shared = { ledger, config: structuredClone(defaultConfig), cwd: root, role: "worker" as const, preferredProvider: "ollama", permission: "read_only" as const, task };
    let probes = 0;
    let release: (() => void) | null = null;
    let sawProbeAbort = false;
    // The seam observes the SHARED probe's signal, so this test can tell whether
    // the underlying work was really cancelled. A callback that ignores the
    // signal cannot distinguish a correct implementation from a broken one.
    const qualify = async ({ signal }: { signal: AbortSignal }) => {
      probes += 1;
      signal.addEventListener("abort", () => { sawProbeAbort = true; }, { once: true });
      await new Promise<void>((resolve) => { release = resolve; });
      return { fixtureVersion: "local-analysis-v1", role: "analysis" as const, passed: true, score: 1, evidence: {} };
    };

    const ownerController = new AbortController();
    const joinerController = new AbortController();
    const owner = ensureSchedulerCandidateQualified({ ...shared, signal: ownerController.signal, qualify });
    for (let tick = 0; tick < 200 && probes === 0; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    const joiner = ensureSchedulerCandidateQualified({ ...shared, signal: joinerController.signal, qualify });
    for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 1, "the second caller joined rather than starting a second probe");

    // The OWNER cancels. The joiner never asked to stop.
    ownerController.abort();
    // An explicit deadline, so a lifetime regression fails by naming the broken
    // contract rather than by hanging until an outer CI watchdog fires.
    await assert.rejects(
      Promise.race([owner, delay(5_000).then(() => { throw new Error("the cancelling caller was still waiting after 5s"); })]),
      (error: unknown) => isAbortError(error),
      "the cancelling caller stops waiting",
    );
    assert.equal(joinerController.signal.aborted, false, "the joiner never cancelled");
    for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sawProbeAbort, false, "the shared probe must survive while a subscriber still wants it");

    assert.ok(release, "the shared probe is still outstanding");
    (release as () => void)();
    const result = await joiner;
    assert.equal(result?.passed, true, "the caller that did not cancel still gets its answer");
    assert.equal(probes, 1, "still exactly one underlying probe");
    assert.deepEqual(
      ledger.listModelQualifications(modelId).filter((item) => !item.passed),
      [],
      "no failure was recorded against the model",
    );
    assert.equal(ledger.isModelEligible(modelId), true, "and it was not cooled out of scheduling");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a live joiner keeps a shared qualification discoverable after its creator cancels", async () => {
  // One probe per model/fingerprint/role is the whole point of sharing. Cleanup
  // used to be tied to the CREATOR's wait, so a creator that cancelled
  // unpublished a flight live joiners were still using — and the next caller
  // started a second concurrent probe against the same model, racing the same
  // durable qualification and health writes. The entry must live as long as the
  // probe does, not as long as whoever happened to start it.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-flight-lifetime-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:worker:7b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "worker:7b", displayName: "worker:7b", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { capabilities: ["completion"] } });

    const task = { id: "probe", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: [], kind: "diagnostic" as const, permission: "read_only" as const, risk: "low" as const };
    const shared = { ledger, config: structuredClone(defaultConfig), cwd: root, role: "worker" as const, preferredProvider: "ollama", permission: "read_only" as const, task };
    let probes = 0;
    let release: (() => void) | null = null;
    const qualify = async () => {
      probes += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { fixtureVersion: "local-analysis-v1", role: "analysis" as const, passed: true, score: 1, evidence: {} };
    };
    const settle = async () => { for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve)); };

    const ownerController = new AbortController();
    const owner = ensureSchedulerCandidateQualified({ ...shared, signal: ownerController.signal, qualify });
    for (let tick = 0; tick < 200 && probes === 0; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    const joiner = ensureSchedulerCandidateQualified({ ...shared, signal: new AbortController().signal, qualify });
    await settle();
    assert.equal(probes, 1, "the joiner joined the creator's probe");

    // The creator cancels while the joiner is still waiting.
    ownerController.abort();
    await assert.rejects(
      Promise.race([owner, delay(5_000).then(() => { throw new Error("the cancelling creator was still waiting after 5s"); })]),
      (error: unknown) => isAbortError(error),
      "the creator stops waiting",
    );
    await settle();

    // A third caller arrives. It must find the SAME probe, not start another.
    const late = ensureSchedulerCandidateQualified({ ...shared, signal: new AbortController().signal, qualify });
    await settle();
    assert.equal(probes, 1, "a still-live joiner keeps the shared flight discoverable to later callers");

    assert.ok(release, "the shared probe is still outstanding");
    (release as () => void)();
    const [joinerResult, lateResult] = await Promise.all([joiner, late]);
    assert.equal(joinerResult?.passed, true, "the joiner gets its answer");
    assert.equal(lateResult?.passed, true, "and so does the later caller, from the same probe");
    assert.equal(probes, 1, "exactly one underlying probe ran throughout");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an answer that lands as the caller cancels is not persisted as a verdict", async () => {
  // The narrow ordering this guards: the shared probe wins its race against the
  // caller's abort, so the caller receives a value — and only then does the
  // cancellation land, before the caller resumes and would persist it. I claimed
  // this window could not be staged deterministically; an audit showed it can,
  // by scheduling the abort from a getter on the outcome, which runs while the
  // result is being read and queues the cancellation into exactly that gap.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-late-cancel-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:worker:7b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "worker:7b", displayName: "worker:7b", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { capabilities: ["completion"] } });

    const controller = new AbortController();
    const outcome = {
      fixtureVersion: "local-analysis-v1",
      role: "analysis" as const,
      passed: false,
      score: 0,
      // Read while the outcome is spread, which is after the probe settled and
      // before the caller resumes. Two microtasks put the abort in that gap.
      get evidence() {
        queueMicrotask(() => queueMicrotask(() => controller.abort()));
        return {};
      },
    };

    await assert.rejects(
      ensureSchedulerCandidateQualified({
        ledger,
        config: structuredClone(defaultConfig),
        cwd: root,
        role: "worker",
        preferredProvider: "ollama",
        permission: "read_only",
        task: { id: "probe", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: [], kind: "diagnostic", permission: "read_only", risk: "low" },
        signal: controller.signal,
        qualify: async () => outcome,
      }),
      (error: unknown) => isAbortError(error),
      "an answer that arrives as the caller cancels must not become that caller's verdict",
    );

    assert.deepEqual(
      ledger.listModelQualifications(modelId).filter((item) => !item.passed),
      [],
      "and must not be persisted as a failed qualification",
    );
    assert.equal(ledger.isModelEligible(modelId), true, "nor cool the model out of scheduling");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a probe that ignores cancellation is not left published for later callers", async () => {
  // An abort is a REQUEST, and not every probe honours it. Cleanup used to run
  // only when the shared promise settled, so a probe that ignored cancellation
  // never settled and its entry stayed published forever: the next caller for
  // that model joined work nobody owned and no caller could ever finish, with
  // each stranded key held for the life of the process.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-abandoned-flight-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:worker:7b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "worker:7b", displayName: "worker:7b", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { capabilities: ["completion"] } });

    const task = { id: "probe", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: [], kind: "diagnostic" as const, permission: "read_only" as const, risk: "low" as const };
    const shared = { ledger, config: structuredClone(defaultConfig), cwd: root, role: "worker" as const, preferredProvider: "ollama", permission: "read_only" as const, task };
    let probes = 0;
    const settle = async () => { for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve)); };
    // Deliberately deaf to cancellation, and it never answers.
    const deaf = () => { probes += 1; return new Promise<never>(() => {}); };

    const first = new AbortController();
    const stranded = ensureSchedulerCandidateQualified({ ...shared, signal: first.signal, qualify: deaf });
    for (let tick = 0; tick < 200 && probes === 0; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    first.abort();
    await assert.rejects(
      Promise.race([stranded, delay(5_000).then(() => { throw new Error("the only subscriber was still waiting after 5s"); })]),
      (error: unknown) => isAbortError(error),
      "the only subscriber stops waiting",
    );
    await settle();

    // Every subscriber has gone. A later caller must start fresh work, not join
    // the abandoned probe that nobody owns and that will never answer.
    const later = new AbortController();
    const revived = ensureSchedulerCandidateQualified({ ...shared, signal: later.signal, qualify: deaf });
    for (let tick = 0; tick < 200 && probes < 2; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 2, "a later caller starts its own probe rather than joining an abandoned one");

    later.abort();
    await assert.rejects(
      Promise.race([revived, delay(5_000).then(() => { throw new Error("the later caller was still waiting after 5s"); })]),
      (error: unknown) => isAbortError(error),
      "and it can cancel too",
    );
    await settle();

    // The same boundary, entered by a caller whose signal was ALREADY aborted
    // when it arrived. An aborted signal never emits 'abort', so a listener
    // alone would leave that subscriber counted forever and strand the flight.
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      Promise.race([
        ensureSchedulerCandidateQualified({ ...shared, signal: preAborted.signal, qualify: deaf }),
        delay(5_000).then(() => { throw new Error("an already-cancelled caller was still waiting after 5s"); }),
      ]),
      (error: unknown) => isAbortError(error),
      "a caller that had already cancelled does not wait",
    );
    await settle();
    const probesBefore = probes;
    const after = new AbortController();
    const fresh = ensureSchedulerCandidateQualified({ ...shared, signal: after.signal, qualify: deaf });
    for (let tick = 0; tick < 200 && probes === probesBefore; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(probes > probesBefore, "an already-cancelled caller must not leave a stranded probe behind it");
    after.abort();
    await assert.rejects(
      Promise.race([fresh, delay(5_000).then(() => { throw new Error("the fresh caller was still waiting after 5s"); })]),
      (error: unknown) => isAbortError(error),
      "and that fresh probe can be cancelled too",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("cancelling a real local qualification call leaves the model schedulable", async () => {
  // The previous version of this guarantee was tested through an injected
  // qualify callback that listened to the signal — so it proved the seam the
  // test controlled, not the path that ships. An audit then showed the two
  // Ollama fixtures took a signal parameter and never handed it to the HTTP
  // call underneath: a cancelled probe whose response arrived anyway was scored
  // as a failed qualification and cooled the only local worker for 30 minutes.
  // This drives the real adapter against a real server that answers late.
  let sawSignalledAbort = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "worker:7b" }] }));
    if (request.url === "/api/show") return response.end(JSON.stringify({ capabilities: ["completion"] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      // Answers late, and answers WRONG — so if the abort is not honoured, the
      // result is a failed qualification rather than a passing one.
      await delay(400);
      // The socket being gone is what proves the signal reached the request
      // itself, rather than being noticed only after the answer came back.
      if (request.destroyed || response.destroyed) {
        sawSignalledAbort = true;
        return;
      }
      return response.end(JSON.stringify({ message: { role: "assistant", content: "NOT_THE_MARKER" }, done_reason: "stop", prompt_eval_count: 5, eval_count: 5 }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-real-abort-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    await syncOllamaRuntimes(ledger, [{ id: "fixture", displayName: "Fixture", baseUrl: `http://127.0.0.1:${address.port}`, enabled: true }]);
    const model = ledger.listModels("local:ollama:fixture")[0];
    assert.ok(model, "the fixture runtime registered a model");

    const controller = new AbortController();
    const inFlight = ensureSchedulerCandidateQualified({
      ledger,
      config: structuredClone(defaultConfig),
      cwd: root,
      role: "worker",
      preferredProvider: "ollama",
      permission: "read_only",
      task: { id: "probe", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: [], kind: "diagnostic", permission: "read_only", risk: "low" },
      signal: controller.signal,
    });
    // Cancel while the real HTTP call is genuinely outstanding.
    await delay(120);
    controller.abort();
    await assert.rejects(inFlight, (error: unknown) => isAbortError(error), "a cancelled real qualification surfaces as an abort");

    // The rejection arrives as soon as the signal fires; the server only learns
    // the socket is gone when it tries to answer, so give it that moment.
    for (let tick = 0; tick < 60 && !sawSignalledAbort; tick += 1) await delay(25);
    assert.equal(sawSignalledAbort, true, "the abort reached the HTTP request rather than being dropped at the adapter");
    assert.deepEqual(
      ledger.listModelQualifications(model.id).filter((item) => !item.passed),
      [],
      "a cancelled call must not be persisted as a failed qualification",
    );
    assert.equal(ledger.isModelEligible(model.id), true, "a cancelled call must not cool the model out of scheduling");
  } finally {
    ledger.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("interrupting a first-use qualification leaves the model's health untouched", async () => {
  // An audit found this in the fix for the interrupt window: the abort signal
  // reached the probe, but qualification caught EVERY throw and turned it into
  // passed:false. That was persisted as a failed qualification and recorded as
  // 'incompatible', which carries a 30-minute cooldown — so exercising the
  // owner's interrupt could make the only local worker ineligible for its own
  // retry and for later runs. An interrupt is a control action, not evidence
  // about a model.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-abort-health-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    const modelId = "ollama:worker:7b";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "local:ollama", canonicalName: "worker:7b", displayName: "worker:7b", source: "runtime_discovery", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: { capabilities: ["completion"] } });

    const controller = new AbortController();
    let probeStarted = false;
    // A probe that never answers on its own — only the abort ends it, which is
    // what a real first-use qualification against a live model looks like.
    const blocked = ensureSchedulerCandidateQualified({
      ledger,
      config: structuredClone(defaultConfig),
      cwd: root,
      role: "worker",
      preferredProvider: "ollama",
      permission: "read_only",
      // A low-risk read-only diagnostic classifies to the lowest tier, which is
      // what a small local model can actually be selected for.
      task: { id: "probe", title: "Inspect", description: "Inspect", dependencies: [], preferredProvider: null, checks: [], kind: "diagnostic", permission: "read_only", risk: "low" },
      signal: controller.signal,
      // Deliberately UNABORTABLE: it ignores the signal and answers late with a
      // failing result. Some adapters cannot be cancelled, and any adapter can
      // have its answer land in the moment after cancellation. Neither may be
      // allowed to become a verdict, so the guarantee has to sit at the boundary
      // rather than depend on the call underneath being well behaved.
      qualify: async () => {
        probeStarted = true;
        await delay(150);
        return { fixtureVersion: "local-analysis-v1", role: "analysis" as const, passed: false, score: 0, evidence: {} };
      },
    });
    for (let tick = 0; tick < 200 && !probeStarted; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probeStarted, true, "the probe is genuinely in flight before the interrupt");

    controller.abort();
    await assert.rejects(blocked, (error: unknown) => isAbortError(error), "an unabortable probe answering after cancellation must not become a verdict");

    // The point of the test: nothing about the model was concluded.
    const after = ledger.getModel(modelId);
    assert.equal(after?.qualified, false, "the model is no more qualified than before");
    assert.deepEqual(
      ledger.listModelQualifications(modelId).filter((item) => !item.passed),
      [],
      "an interrupt must not be persisted as a failed qualification",
    );
    assert.equal(ledger.isModelEligible(modelId), true, "an interrupt must not cool the model out of scheduling");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a cross-repository architect is offered the validators its repositories actually have", () => {
  // Found by running the first real cross-repository objective. The architect is
  // told "every check name must come from the allowlisted validators above", and
  // was handed the PROJECT's validator names — diff-check, test, build — while
  // the affected repositories register lint, tests, typecheck. It obeyed, planned
  // `test`, and every task failed with "unknown validator 'test'". The run could
  // not have succeeded: the vocabulary it was given did not exist where the work
  // had to run.
  const project = {
    "diff-check": { command: "git", args: ["diff", "--check"], timeoutMs: 1_000 },
    test: { command: "npm", args: ["test"], timeoutMs: 1_000 },
  };
  const repositories = [
    { id: "repo:core", validators: { lint: { command: "ruff", args: [], timeoutMs: 1_000 }, tests: { command: "pytest", args: [], timeoutMs: 1_000 } } },
    { id: "repo:web", validators: { typecheck: { command: "tsc", args: [], timeoutMs: 1_000 }, tests: { command: "vitest", args: [], timeoutMs: 1_000 } } },
  ];
  assert.deepEqual(
    architectValidatorNames(project, repositories),
    ["diff-check", "lint", "test", "tests", "typecheck"],
    "the vocabulary is the union of the project's validators and every affected repository's, deduplicated and stable",
  );
  // With no repository scope the project's own validators are the whole answer.
  assert.deepEqual(architectValidatorNames(project, []), ["diff-check", "test"]);
});

test("a qualification for one role does not hide the provider default for another", async () => {
  // Found by the third attempt at the first real cross-repository run. Earlier
  // runs had qualified models for the WORKER and ARCHITECT roles, so every
  // connection carried a current qualification. `defaultProvider` then treated
  // each connection as a managed fleet and declined to offer its provider
  // default — for the REVIEWER role, which nothing on either connection was
  // qualified for. The run was refused with "no subscription or qualified local
  // reviewer is available" while both subscriptions were ready.
  //
  // "Has a managed fleet" has to mean "has a model that can serve THIS role".
  // Otherwise the first role to be qualified permanently blocks first-use
  // qualification of every other role on that connection.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-role-blind-fleet-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "subscription-cli:codex:model:gpt-5-6";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "subscription-cli:codex", canonicalName: "gpt-5-6", displayName: "gpt-5-6", source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "premium", family: "gpt-5", capabilities: ["text", "code"], source: "catalog" }) });
    // Current, non-stale, active — qualified for WORKER only, exactly as a prior
    // run leaves a connection.
    ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "worker", passed: true, score: 1, evidence: {} });
    ledger.setModelPreference(modelId, { active: true });

    const config = structuredClone(defaultConfig);
    // Routing correctly refuses: nothing is qualified as a reviewer YET, and the
    // reviewer path deliberately qualifies a candidate before routing rather
    // than falling back to a provider default.
    assert.equal(
      canRoute(ledger, { role: "reviewer", config, fallbackProvider: "codex", allowedProviders: ["codex"], permission: "read_only", task: null }),
      false,
      "nothing is reviewer-qualified yet, so routing has nothing to choose",
    );
    // But a candidate exists, so the run must not be refused before first-use
    // qualification has had its chance.
    assert.equal(
      hasQualifiableCandidate({ ledger, config, role: "reviewer", preferredProvider: "codex", permission: "read_only" }),
      true,
      "a premium model on a ready connection is a reviewer candidate even before it is qualified",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a review blocked by implementor independence says so", () => {
  // Found by the first real cross-repository run. Both tasks ran on the only two
  // enabled providers, medium risk requires implementor independence, so BOTH
  // connections were excluded from reviewing and no reviewer could exist. The run
  // reported "No eligible model or provider default is available for reviewer
  // (premium tier required)" — blaming the model tier, never mentioning
  // independence, and giving the owner nothing to act on. The true remedy is to
  // enable another provider, which that message does not hint at.
  assert.equal(
    describeReviewerUnavailability({
      routingReason: "No eligible model or provider default is available for reviewer (premium tier required)",
      implementationProviders: ["codex", "claude"],
      availableProviders: ["codex", "claude"],
      requireImplementorIndependence: true,
    }),
    "No independent reviewer is available: implementor independence is required for this risk level, and every available provider (codex, claude) implemented part of this run. Enable another provider, or lower the risk level to allow a same-provider review.",
    "the owner is told the real cause and the actual remedy",
  );
  // When independence is not the cause, the routing reason stands unchanged.
  assert.equal(
    describeReviewerUnavailability({
      routingReason: "No eligible model or provider default is available for reviewer (premium tier required)",
      implementationProviders: ["codex"],
      availableProviders: ["codex", "claude", "gemini"],
      requireImplementorIndependence: true,
    }),
    "No eligible model or provider default is available for reviewer (premium tier required)",
    "a genuine routing shortfall is not relabelled as an independence problem",
  );
  assert.equal(
    describeReviewerUnavailability({
      routingReason: "some other routing reason",
      implementationProviders: ["codex", "claude"],
      availableProviders: ["codex", "claude"],
      requireImplementorIndependence: false,
    }),
    "some other routing reason",
    "independence that is not required cannot be the explanation",
  );
});

test("a stale qualification does not hide a connection's provider default", async () => {
  // Found by running the product: an approved cross-repository run was refused
  // at start with "no subscription or qualified local worker is available",
  // while reporting both subscriptions READY.
  //
  // Two implementations of one decision had drifted. `defaultProvider` decides a
  // connection has a managed fleet — and therefore should NOT fall back to the
  // provider default — using active && qualified && !excluded, which counts a
  // STALE qualification. `acceptModel` then rejects those same models precisely
  // because they are stale. The connection is skipped as managed while nothing
  // on it is usable, so routing finds nothing at all.
  //
  // A stale qualification means "requalify at first use", which is exactly what
  // scheduler-time qualification does. It must not suppress the provider default.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-stale-default-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    const modelId = "subscription-cli:codex:model:gpt-5-5";
    ledger.upsertDiscoveredModel({ id: modelId, connectionId: "subscription-cli:codex", canonicalName: "gpt-5-5", displayName: "gpt-5-5", source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "premium", family: "gpt-5", capabilities: ["text", "code"], source: "catalog" }) });
    // Qualified under an old fingerprint, then the runtime changed — the ordinary
    // state after a provider CLI upgrade, applied exactly as the scheduler does.
    ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "general", passed: true, score: 1, evidence: {}, fingerprint: "old-fingerprint" });
    ledger.setModelPreference(modelId, { active: true });
    ledger.applyModelFingerprint(modelId, "new-fingerprint");

    const stale = ledger.getModel(modelId);
    assert.equal(stale?.qualified, true, "the model still carries a qualification record");
    assert.equal(stale?.qualificationStale, true, "but it is stale, so it cannot be accepted as-is");
    assert.equal(stale?.active, true, "and it is active, which is what made the connection look like a managed fleet");

    const config = structuredClone(defaultConfig);
    assert.equal(
      canRoute(ledger, workerClassProbe(config, ["codex"])),
      true,
      "a connection whose only qualification is stale must still offer its provider default, so first-use requalification can run",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("worker liveness is decided by the router itself, not by a proxy that disagrees with it", async () => {
  // Found by the v0.6 item-4 fallback proving run. The attempt loop guards on
  // input.providers, which only ever holds subscription providers, so once the
  // last subscription connection cools the task is failed with "all eligible
  // providers are cooling down or unavailable" — without ever asking the router,
  // which is the only place a local model is considered. Local fallback was
  // therefore reachable in routing and unreachable in practice.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-fallback-guard-"));
  const ledger = new Ledger(path.join(root, "devharmonics.db"));
  try {
    ledger.upsertConnection({ id: "subscription-cli:claude", provider: "claude", transport: "subscription_cli", authentication: "subscription", displayName: "Claude", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    ledger.upsertConnection({ id: "local:ollama", provider: "ollama", transport: "local", authentication: "local_none", displayName: "Ollama", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "local", capacity: "available", adapterVersion: "test", runtimeVersion: "test", metadata: { baseUrl: "http://127.0.0.1:11434" } });
    ledger.upsertDiscoveredModel({ id: "ollama:worker:7b", connectionId: "local:ollama", canonicalName: "worker:7b", displayName: "worker:7b", source: "runtime_discovery", lifecycle: "active", visible: true, verified: true, qualified: true, active: true, metadata: { capabilities: ["completion"] } });

    // The subscription connection runs out; the local runtime is untouched.
    ledger.recordConnectionOutcome("subscription-cli:claude", { success: false, failureKind: "quota_exhausted", detail: "usage limit reached" });

    const subscriptionEligible = ledger.isConnectionEligible("subscription-cli:claude");
    const localEligible = ledger.isConnectionEligible("local:ollama");
    assert.equal(localEligible, true, "the local runtime is still usable");

    // The decision the attempt loop has to make: with no subscription connection
    // usable, is there still somewhere to run? That question is only answered
    // honestly by the router. A predicate that checked generic lifecycle flags
    // instead — qualified, active, not excluded — disagreed with routing in both
    // directions, and an audit proved both. Each case below is one of those.
    const config = structuredClone(defaultConfig);
    const noSubscription = () => workerClassProbe(config, []);
    const modelId = "ollama:worker:7b";

    // False positive: qualified and active, but only for the architect role. The
    // old predicate said the task could run; routing then threw out of the
    // attempt and failed the whole run instead of settling one task.
    ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "architect", passed: true, score: 1, evidence: {} });
    assert.equal(ledger.getModel(modelId)?.qualified, true, "the model is qualified in the generic sense the old predicate checked");
    assert.equal(canRoute(ledger, noSubscription()), false, "a model qualified only as architect cannot take worker work");

    // Qualified for analysis: it can carry read-only worker work.
    ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "analysis", passed: true, score: 1, evidence: {} });
    assert.equal(canRoute(ledger, noSubscription()), true, "a cooling subscription must not end the task while a qualified local worker is available");
    // ...but not a write: that needs the local tool qualification, which the
    // generic predicate had no way to see.
    assert.equal(
      canRoute(ledger, { ...noSubscription(), permission: "workspace_write" }),
      false,
      "an analysis-qualified local model cannot be treated as a writer",
    );

    // False negative: an inactive model that is manually assigned. Routing
    // honours explicit assignment without requiring active, so refusing here
    // would refuse a model the router would in fact have selected.
    ledger.setModelPreference(modelId, { active: false });
    assert.equal(canRoute(ledger, noSubscription()), false, "an inactive model is not picked up by ordinary selection");
    const assigned = structuredClone(defaultConfig);
    assigned.routing.worker.modelId = modelId;
    assert.equal(
      canRoute(ledger, workerClassProbe(assigned, [])),
      true,
      "a manually assigned local model routes even while inactive, so liveness must say so too",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a diagnostic report citing files that do not exist is rejected as unverifiable", async () => {
  // A local model produced five reports whose path:line citations were entirely
  // invented — non-existent files, empty lines, unrelated content — and every
  // task passed, because the diagnostic gate only checked that citations LOOKED
  // like citations. Only the independent reviewer caught it, after a full run.
  // Citations are mechanically checkable, so check them.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-citations-"));
  try {
    await writeFile(path.join(root, "README.md"), "line one\nline two\nline three\n", "utf8");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "app.py"), "import os\nVERSION = '1.2.0'\n", "utf8");

    const genuine = await verifyReportCitations(root, "Found the pin at src/app.py:2 and context in README.md:1.");
    assert.deepEqual(genuine.unverifiable, [], "citations that resolve to real lines verify cleanly");
    assert.equal(genuine.checked.length, 2, "both citations were checked");

    // The exact shapes observed in the real run.
    const fabricated = await verifyReportCitations(
      root,
      "Evidence: config.yaml:3 states the version, user_manual.md:2 confirms it, and README.md:99 repeats it.",
    );
    const bad = fabricated.unverifiable.map((item) => item.citation).sort();
    assert.deepEqual(bad, ["README.md:99", "config.yaml:3", "user_manual.md:2"], "missing files and out-of-range lines are all unverifiable");
    assert.ok(
      fabricated.unverifiable.every((item) => item.reason.length > 0),
      "each rejection explains itself so the owner can see what was wrong",
    );
    // A report with no citations at all is not this check's business.
    const none = await verifyReportCitations(root, "No citations here, just prose.");
    assert.deepEqual(none.checked, []);
    assert.deepEqual(none.unverifiable, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("every evidence form the diagnostic gate accepts is resolved by the citation verifier", async () => {
  // An audit proved the verifier was bypassable: the gate in agents.ts accepted
  // `[missing.md](missing.md), line 2` as evidence, but the verifier's own
  // narrower pattern found zero citations in it, so a fabricated finding written
  // in that shape passed unchecked. Range ends were discarded, empty files
  // counted as one line, `../` traversal was silently stripped, and a legitimate
  // absolute path inside the worktree was rejected. Each row below is one of
  // those proven evasions.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-citation-forms-"));
  try {
    await writeFile(path.join(root, "README.md"), "line one\nline two\nline three\n", "utf8");
    await writeFile(path.join(root, "empty.md"), "", "utf8");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "app.py"), "import os\nVERSION = '1.2.0'\n", "utf8");
    // A decoy with the same basename as the traversal target, to prove the
    // traversal is rejected rather than quietly resolved against the decoy.
    await writeFile(path.join(root, "outside.ts"), "export const x = 1;\n", "utf8");
    // The traversal and absolute-path rows must fail because the cited path is
    // outside the worktree, NOT merely because nothing is there — so both
    // targets really exist. Without this the containment check can be deleted
    // and the suite stays green.
    // A directory and a filename that both contain spaces, inside the worktree.
    const spaced = path.join(root, "dir with spaces");
    await mkdir(spaced, { recursive: true });
    await writeFile(path.join(spaced, "inside file.ts"), ["export const a = 1;", "export const b = 2;", ""].join("\n"), "utf8");
    await mkdir(path.join(root, "sub dir"), { recursive: true });
    await writeFile(path.join(root, "sub dir", "notes file.md"), ["first line", ""].join("\n"), "utf8");

    const neighbour = await mkdtemp(path.join(os.tmpdir(), "devharmonics-citation-neighbour-"));
    await writeFile(path.join(neighbour, "other.ts"), "export const y = 2;\n", "utf8");
    await writeFile(path.join(path.dirname(root), "outside.ts"), "export const z = 3;\n", "utf8");

    const cases: Array<{ text: string; verifies: boolean; why: string }> = [
      { text: "Found the pin at src/app.py:2 and context in README.md:1.", verifies: true, why: "plain path:line" },
      { text: "See [README.md](README.md), line 2 for the claim.", verifies: true, why: "linked path with nearby line" },
      { text: "See [missing.md](missing.md), line 2 for the claim.", verifies: false, why: "linked form naming a file that does not exist" },
      { text: "The evidence is in [empty.md](empty.md), line 1.", verifies: false, why: "a line cited in an empty file" },
      { text: "Range README.md:1-2 covers it.", verifies: true, why: "a range fully inside the file" },
      { text: "Range README.md:2-999 covers it.", verifies: false, why: "a range whose end is past the file" },
      { text: "Range README.md:3-1 covers it.", verifies: false, why: "a backwards range" },
      { text: "Broken at ../outside.ts:1 upstream.", verifies: false, why: "traversal outside the worktree" },
      { text: `Broken at ${path.join(root, "src", "app.py")}:2 exactly.`, verifies: true, why: "an absolute path inside the worktree" },
      { text: `Broken at ${path.join(neighbour, "other.ts")}:1 exactly.`, verifies: false, why: "an absolute path to a real file outside the worktree" },
      { text: "Version 1.2.0 shipped and 3.4.5 followed, no files named.", verifies: true, why: "version strings are not citations" },
      // An audit built a real repository under a path containing spaces and
      // showed the citation was truncated to its last segment and then rejected
      // as fabricated. Real repositories live under such paths.
      { text: `Broken at ${path.join(spaced, "inside file.ts")}:2 exactly.`, verifies: true, why: "an absolute path containing spaces" },
      { text: `Broken at ${path.join(spaced, "inside file.ts")}:99 exactly.`, verifies: false, why: "an absolute path with spaces, past the end of the file" },
      { text: `See [the file](${path.join(spaced, "inside file.ts")}:2) for the claim.`, verifies: true, why: "a linked path containing spaces" },
      { text: `See \`${path.join(spaced, "inside file.ts")}:2\` for the claim.`, verifies: true, why: "a backtick-quoted path containing spaces" },
      { text: `See [notes](sub dir/notes file.md), line 1 for the claim.`, verifies: true, why: "a linked relative path containing spaces" },
      { text: "See `sub dir/notes file.md`, line 1 for the claim.", verifies: true, why: "a backtick-quoted relative path containing spaces" },
      { text: "See `sub dir/missing file.md`, line 1 for the claim.", verifies: false, why: "a quoted relative path with spaces that does not exist" },
      // The forms an audit showed were truncated to a bare suffix such as
      // `file.md:2`, because a shorter wrong match claimed the span first.
      { text: "See [notes](sub dir/notes file.md:2) for the claim.", verifies: false, why: "a linked relative spaced path with an inline line past the end" },
      { text: "See [notes](sub dir/notes file.md:1) for the claim.", verifies: true, why: "a linked relative spaced path with an inline line" },
      { text: "See `sub dir/notes file.md:1` for the claim.", verifies: true, why: "a quoted relative spaced path with an inline line" },
      { text: `Broken at ${path.join(spaced, "inside file.ts").replaceAll("\\", "/")}:2 exactly.`, verifies: true, why: "a POSIX-separated rooted spaced path" },
    ];

    for (const item of cases) {
      const verification = await verifyReportCitations(root, item.text);
      assert.equal(
        verification.unverifiable.length === 0,
        item.verifies,
        `${item.why}: ${JSON.stringify(item.text)} produced ${JSON.stringify(verification.unverifiable)}`,
      );
    }

    // A POSIX-rooted path with spaces must be EXTRACTED whole. On Windows it
    // will then be judged outside the worktree, which is correct — but it must
    // not first be truncated to a bare suffix, which is the defect an audit
    // found. Asserting on extraction keeps this claim platform-independent.
    assert.deepEqual(
      extractCitations("Broken at /repo with spaces/notes file.md:2 exactly.").map((item) => item.rawPath),
      ["/repo with spaces/notes file.md"],
      "a POSIX-rooted path containing spaces is read whole, not truncated to its last segment",
    );
    assert.deepEqual(
      extractCitations("Broken at file:///repo with spaces/notes file.md:2 exactly.").map((item) => item.rawPath),
      ["file:///repo with spaces/notes file.md"],
      "a POSIX file:/// path containing spaces is read whole",
    );

    // The gate and the verifier must agree on what counts as evidence. Any form
    // the gate passes must produce at least one citation for the verifier to
    // resolve — that equivalence is the whole defence against this class.
    const gated = {
      id: "t-citation-parity",
      title: "Inspect evidence",
      description: "Inspect evidence",
      dependencies: [],
      preferredProvider: null,
      checks: ["test"],
      kind: "diagnostic" as const,
      permission: "read_only" as const,
      risk: "low" as const,
      acceptanceCriteria: ["Every finding cites a repository-relative file path and line number"],
    };
    const padding = " This report is long enough to clear the minimum length required of a diagnostic report body.";
    for (const item of cases) {
      const text = item.text + padding;
      if (validateDiagnosticResult(gated, text) === null) {
        assert.ok(
          extractCitations(text).length > 0,
          `the gate accepted ${JSON.stringify(item.text)} as evidence but the verifier found nothing to check`,
        );
      }
    }

    await rm(neighbour, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(path.join(path.dirname(root), "outside.ts"), { force: true, maxRetries: 10, retryDelay: 100 });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
