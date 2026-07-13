import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, initializeProject, loadConfig } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { Orchestrator, parseFirstJsonObject } from "../src/orchestrator.js";
import {
  extractClaudeText,
  extractCodexText,
  extractGeminiText,
} from "../src/providers.js";
import type { RingerConfig } from "../src/types.js";
import { runPlanSchema } from "../src/schemas.js";
import { runProcess, subscriptionEnvironment } from "../src/process.js";

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
    const root = await mkdtemp(path.join(os.tmpdir(), "ringer-command-"));
    const previousPath = process.env.PATH;
    try {
      await writeFile(path.join(root, "ringer-resolver-probe.ps1"), "throw 'wrong wrapper'\n");
      await writeFile(path.join(root, "ringer-resolver-probe.cmd"), "@echo chosen %*\r\n");
      process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
      const result = await runProcess({
        command: "ringer-resolver-probe",
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

test("project initialization detects Node validators and writes constitution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-config-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }),
    );
    await initializeProject(root);
    const config = await loadConfig(root);
    assert.equal(config.providers.gemini.command, "agy");
    assert.deepEqual(config.validators.test?.args, ["run", "test"]);
    assert.deepEqual(config.validators.build?.args, ["run", "build"]);
    assert.ok(config.validators["diff-check"]);
    assert.match(await readFile(path.join(root, ".ringer", "constitution.md"), "utf8"), /execution receipt/);
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

test("ledger.cancelRun cancels in-flight work and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-cancel-"));
  const ledger = new Ledger(path.join(root, "ringer.db"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-save-plan-cancel-"));
  const ledger = new Ledger(path.join(root, "ringer.db"));
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

test("executeTask preserves cancellation at the commit/merge boundary", async () => {
  async function runBoundaryVariant(
    variant: "commit-aborts-before-merge" | "commit-aborts-and-throws",
  ): Promise<{ result: string; merged: boolean; status: string; eventKinds: string[] }> {
    const root = await mkdtemp(path.join(os.tmpdir(), `ringer-commit-cancel-${variant}-`));
    const ledger = new Ledger(path.join(root, "ringer.db"));
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
      ledger.savePlan(runId, {
        summary: "One task",
        recommendedConcurrency: 1,
        tasks: [task],
      });

      const controller = new AbortController();
      let merged = false;
      const orchestrator = new Orchestrator(ledger);
      (orchestrator as any).provider = () => ({
        name: "codex" as const,
        run: async () => ({
          provider: "codex" as const,
          text: "done",
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 0,
        }),
      });

      const config: RingerConfig = structuredClone(defaultConfig);
      config.retry.maxAttempts = 1;
      config.retry.backoffMs = 1;
      config.workers = ["codex"];
      config.validators = {
        pass: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 30_000,
        },
      };

      const worktrees = {
        createTask: async () => ({ path: worktreePath, branch: "ringer/task-one" }),
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
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-ledger-"));
  const ledger = new Ledger(path.join(root, "ringer.db"));
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
    const attempt = ledger.startAttempt(runId, "one", "codex", "prompt");
    ledger.finishAttempt(attempt, "completed", "done");
    ledger.recordCheck(runId, "one", {
      name: "diff-check",
      passed: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 2,
    });
    ledger.setTaskStatus(runId, "one", "passed", "codex");
    const run = ledger.getRun(runId);
    assert.equal(run?.tasks[0]?.attemptCount, 1);
    assert.equal(run?.tasks[0]?.checks[0]?.passed, true);
    assert.ok(run?.events.length);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
