import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInvocation, parseWorkerOutput, SUBPROCESS_PROVIDERS } from "../scripts/providers.mjs";

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "dh-providers-"));
}

function baseArgs(overrides = {}) {
  return {
    provider: "codex",
    model: "gpt-5.6-luna",
    prompt: "Implement add(a, b).",
    cwd: "C:\\scratch\\work",
    outputDir: "C:\\scratch\\out",
    ...overrides,
  };
}

test("SUBPROCESS_PROVIDERS names exactly the three known providers", () => {
  assert.deepEqual(SUBPROCESS_PROVIDERS, ["codex", "claude", "agy"]);
});

test("codex build: exact args, stdin delivery, prompt never in argv", () => {
  const result = buildInvocation(baseArgs({ sandbox: "workspace-write", reasoningEffort: "high" }));
  assert.equal(result.commandName, "codex");
  assert.equal(result.promptDelivery, "stdin");
  assert.deepEqual(result.args, [
    "exec",
    "-m",
    "gpt-5.6-luna",
    "-c",
    'model_reasoning_effort="high"',
    "--ephemeral",
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-C",
    "C:\\scratch\\work",
    "--output-last-message",
    path.join("C:\\scratch\\out", "last-message.txt"),
    "-",
  ]);
  assert.ok(!result.args.includes("Implement add(a, b)."), "prompt must not appear in codex args");
});

test("codex build defaults sandbox to read-only when not given", () => {
  const result = buildInvocation(baseArgs());
  assert.ok(result.args.includes("read-only"));
});

test("claude build: prompt is in args after -p, --bare is never present, subscription-first", () => {
  const result = buildInvocation(baseArgs({
    provider: "claude",
    model: "claude-sonnet-5",
    maxTurns: 12,
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Grep"],
  }));
  assert.equal(result.commandName, "claude");
  assert.equal(result.promptDelivery, "argv");
  const dashPIndex = result.args.indexOf("-p");
  assert.ok(dashPIndex >= 0, "-p flag must be present");
  assert.equal(result.args[dashPIndex + 1], "Implement add(a, b).");
  assert.ok(!result.args.includes("--bare"), "--bare would force API-key auth, not subscription OAuth");
  assert.deepEqual(result.args, [
    "-p",
    "Implement add(a, b).",
    "--output-format",
    "json",
    "--model",
    "claude-sonnet-5",
    "--max-turns",
    "12",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read,Grep",
    "--add-dir",
    "C:\\scratch\\work",
  ]);
});

test("agy build: prompt, explicit --add-dir workspace, no model flag emitted", () => {
  // Found live 2026-08-04: headless agy does not adopt the process cwd as
  // its workspace — without --add-dir it edits its own scratch dir while
  // claiming success.
  const result = buildInvocation(baseArgs({ provider: "agy", model: undefined }));
  assert.equal(result.commandName, "agy");
  assert.equal(result.promptDelivery, "argv");
  assert.deepEqual(result.args, ["-p", "Implement add(a, b).", "--add-dir", baseArgs().cwd]);
});

test("agy build: workspace-write adds --mode accept-edits, never --dangerously-skip-permissions", () => {
  // Found live 2026-08-04: bare `agy -p` exits 0 without editing files — the
  // false green the empty-diff gate exists for. accept-edits enables real
  // writes; command permission stays an owner-configured settings rule.
  const result = buildInvocation(baseArgs({ provider: "agy", model: undefined, sandbox: "workspace-write" }));
  assert.deepEqual(result.args, ["-p", "Implement add(a, b).", "--add-dir", baseArgs().cwd, "--mode", "accept-edits"]);
  assert.ok(!result.args.includes("--dangerously-skip-permissions"));
});

test("buildInvocation throws on an unknown provider", () => {
  assert.throws(() => buildInvocation(baseArgs({ provider: "chatgpt" })), /unknown provider/);
});

test("buildInvocation throws on an empty prompt", () => {
  assert.throws(() => buildInvocation(baseArgs({ prompt: "" })), /prompt/);
});

test("buildInvocation throws on a missing outputDir", () => {
  assert.throws(() => buildInvocation(baseArgs({ outputDir: undefined })), /outputDir/);
});

test("buildInvocation throws on a missing cwd", () => {
  assert.throws(() => buildInvocation(baseArgs({ cwd: "" })), /cwd/);
});

test("buildInvocation throws on an empty model for codex/claude but not for agy", () => {
  assert.throws(() => buildInvocation(baseArgs({ model: "" })), /model/);
  assert.throws(() => buildInvocation(baseArgs({ provider: "claude", model: "" })), /model/);
  assert.doesNotThrow(() => buildInvocation(baseArgs({ provider: "agy", model: "" })));
});

test("codex parse: usage from the last usage event, finalText from last-message.txt, garbage lines counted", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "last-message.txt"), "DONE");
    const stdout = [
      JSON.stringify({ type: "turn.started" }),
      "not json at all {{{",
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 40 } }),
    ].join("\n");
    const result = parseWorkerOutput("codex", { stdout, stderr: "", exitCode: 0, outputDir: dir });
    assert.equal(result.finalText, "DONE");
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 40, totalTokens: 140 });
    assert.equal(result.resolvedModel, null);
    assert.equal(result.resolutionVerified, false);
    assert.equal(result.parseNotes.length, 1);
    assert.match(result.parseNotes[0], /skipped 1 unparseable JSONL line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex parse: no usage event and no last-message file yields honest nulls, never fabricated zero", () => {
  const dir = tempDir();
  try {
    const stdout = JSON.stringify({ type: "turn.started" });
    const result = parseWorkerOutput("codex", { stdout, stderr: "", exitCode: 0, outputDir: dir });
    assert.equal(result.usage, null);
    assert.equal(result.finalText, null);
    assert.equal(result.resolvedModel, null);
    assert.equal(result.resolutionVerified, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex parse: resolvedModel is honored and marked verified only when an event names the model", () => {
  const dir = tempDir();
  try {
    const stdout = JSON.stringify({ type: "turn.completed", model: "gpt-5.6-luna-2026-08-01" });
    const result = parseWorkerOutput("codex", { stdout, stderr: "", exitCode: 0, outputDir: dir });
    assert.equal(result.resolvedModel, "gpt-5.6-luna-2026-08-01");
    assert.equal(result.resolutionVerified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex parse: an empty last-message.txt is treated as absent (null), not empty string", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "last-message.txt"), "   \n");
    const result = parseWorkerOutput("codex", { stdout: "", stderr: "", exitCode: 0, outputDir: dir });
    assert.equal(result.finalText, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude parse: well-formed result fixture maps finalText, costUsd, and verified resolvedModel", () => {
  const stdout = JSON.stringify({
    result: "ok",
    session_id: "s",
    total_cost_usd: 0.0125,
    cost_breakdown: { "claude-sonnet-5": 0.0125 },
  });
  // claude's parser never touches outputDir; a placeholder path is enough.
  const result = parseWorkerOutput("claude", { stdout, stderr: "", exitCode: 0, outputDir: "Z:/unused" });
  assert.equal(result.finalText, "ok");
  assert.deepEqual(result.usage, { costUsd: 0.0125 });
  assert.equal(result.resolvedModel, "claude-sonnet-5");
  assert.equal(result.resolutionVerified, true);
  assert.deepEqual(result.parseNotes, []);
});

test("claude parse: absent cost_breakdown yields unverified null resolution, not a guess", () => {
  const stdout = JSON.stringify({ result: "ok", session_id: "s", total_cost_usd: 0.01 });
  const result = parseWorkerOutput("claude", { stdout, stderr: "", exitCode: 0, outputDir: "Z:/unused" });
  assert.equal(result.resolvedModel, null);
  assert.equal(result.resolutionVerified, false);
});

test("claude parse: not-JSON stdout never throws, reports null + a parse note", () => {
  const result = parseWorkerOutput("claude", { stdout: "definitely not json", stderr: "", exitCode: 1, outputDir: "Z:/unused" });
  assert.equal(result.finalText, null);
  assert.equal(result.usage, null);
  assert.equal(result.resolvedModel, null);
  assert.equal(result.resolutionVerified, false);
  assert.ok(result.parseNotes.length > 0);
});

test("agy parse: plain text stdout passes through trimmed, no usage/model claimed", () => {
  const result = parseWorkerOutput("agy", { stdout: "  hello from agy  \n", stderr: "", exitCode: 0, outputDir: "Z:/unused" });
  assert.equal(result.finalText, "hello from agy");
  assert.equal(result.usage, null);
  assert.equal(result.resolvedModel, null);
  assert.equal(result.resolutionVerified, false);
});

test("agy parse: blank stdout is null, not an empty string", () => {
  const result = parseWorkerOutput("agy", { stdout: "   \n", stderr: "", exitCode: 0, outputDir: "Z:/unused" });
  assert.equal(result.finalText, null);
});

test("parseWorkerOutput never throws for an unknown provider; it reports honestly", () => {
  const result = parseWorkerOutput("chatgpt", { stdout: "x", stderr: "", exitCode: 0, outputDir: "Z:/unused" });
  assert.equal(result.finalText, null);
  assert.ok(result.parseNotes.some((n) => n.includes("unknown provider")));
});
