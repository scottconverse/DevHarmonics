import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, loadConfig } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { parseFirstJsonObject } from "../src/orchestrator.js";
import {
  extractClaudeText,
  extractCodexText,
  extractGeminiText,
} from "../src/providers.js";
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
