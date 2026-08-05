import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInvocation } from "../scripts/providers.mjs";
import { createReceipt, validateReceipt } from "../scripts/receipts.mjs";
import { sendMessages } from "../scripts/messages-client.mjs";
import { runPipeline } from "../scripts/run-command.mjs";

/**
 * Regression guards for the medium-severity findings from the four independent
 * audits of 2026-08-05. Each was verified still-open against the code before being
 * fixed, so each gets a test that would catch it coming back.
 */

// --- A2-7a: --max-budget-usd was unreachable -------------------------------
test("A2-7a: maxBudgetUsd reaches the claude argv, and is omitted when not set", () => {
  const base = {
    provider: "claude", model: "claude-x", prompt: "p", cwd: "C:/w", outputDir: "C:/o",
  };
  const without = buildInvocation(base);
  assert.equal(without.args.includes("--max-budget-usd"), false, "no cap configured -> no flag");

  const withCap = buildInvocation({ ...base, maxBudgetUsd: 2.5 });
  const i = withCap.args.indexOf("--max-budget-usd");
  assert.ok(i >= 0, "a configured cap must be emitted");
  assert.equal(withCap.args[i + 1], "2.5");
});

// --- A2-5: receipt usage fields were type-checked but never cross-checked ---
test("A2-5: a receipt whose totalTokens contradicts its parts is refused", () => {
  const base = {
    receiptId: "11111111-1111-4111-8111-111111111111",
    taskId: "t", lane: "subprocess", provider: "codex",
    requestedModel: "m", resolvedModel: "m", resolutionVerified: true,
    prompt: "p", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 1, status: "completed",
  };
  const inconsistent = createReceipt({ ...base, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 100 } });
  const bad = validateReceipt(inconsistent);
  assert.equal(bad.ok, false, "10 + 5 != 100 must not validate");
  assert.ok(bad.errors.some((e) => /totalTokens/.test(e)), bad.errors.join("; "));

  // Consistent totals still pass.
  const good = validateReceipt(createReceipt({ ...base, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }));
  assert.equal(good.ok, true, good.errors.join("; "));

  // A provider reporting only a subset stays valid — absent is honestly absent,
  // not an inconsistency to invent.
  const partial = validateReceipt(createReceipt({ ...base, usage: { totalTokens: 15 } }));
  assert.equal(partial.ok, true, partial.errors.join("; "));
  const costOnly = validateReceipt(createReceipt({ ...base, usage: { costUsd: 0.02 } }));
  assert.equal(costOnly.ok, true, costOnly.errors.join("; "));
});

// --- A1-5: the http client hardcoded `x-api-key: local` --------------------
test("A1-5: an authenticated endpoint can be given a real credential by env-var name, and a missing one refuses instead of sending a placeholder", async () => {
  // Refuses BEFORE any network call when the nominated variable is unset — the old
  // behavior sent the literal string "local" and let the server reject it.
  const missing = await sendMessages({
    baseUrl: "http://127.0.0.1:9",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    apiKeyEnvVar: "DH_TEST_KEY_DEFINITELY_UNSET",
    env: {},
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /DH_TEST_KEY_DEFINITELY_UNSET/);
  assert.match(missing.error, /refusing to send a placeholder credential/);

  // The credential itself is never echoed back to the caller.
  assert.equal(JSON.stringify(missing).includes("s3cret"), false);
});

// --- A1-7: reusing a --task-id died with a raw git error --------------------
test("A1-7: a reused --task-id is refused up front with an actionable message, not a raw git error", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dh-am-repo-"));
  const g = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@e.com"]);
    g(["config", "user.name", "T"]);
    writeFileSync(path.join(repo, "f.txt"), "v1\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "base"]);
    // Simulate a previous run of the same task-id having left its branch behind.
    g(["branch", "devharmonics/task/audit-1"]);

    await assert.rejects(
      () => runPipeline({ repository: repo, prompt: "p", provider: "codex", model: "m", taskId: "audit-1" }),
      (error) => {
        assert.match(error.message, /already been used/, error.message);
        assert.match(error.message, /devharmonics\/task\/audit-1/);
        assert.match(error.message, /no resume/, "must say plainly that there is no resume");
        assert.match(error.message, /different --task-id|git branch -D/, "must state a way forward");
        // The old failure surfaced as git's own wording; that must not be what an
        // operator sees now.
        assert.doesNotMatch(error.message, /could not create worker worktree/);
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- A1-4 / A2-4b: the http lane advertised --check as optional -------------
test("A1-4: the http lane refuses a missing --check up front, naming the lane's contract", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dh-am-http-"));
  const g = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@e.com"]);
    g(["config", "user.name", "T"]);
    writeFileSync(path.join(repo, "f.txt"), "v1\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "base"]);

    await assert.rejects(
      () => runPipeline({ repository: repo, prompt: "p", provider: "ollama", lane: "http", files: ["f.txt"], baseUrl: "http://127.0.0.1:9" }),
      /the http lane requires --check/,
    );
    // The more fundamental missing-files case still reports first, unchanged.
    await assert.rejects(
      () => runPipeline({ repository: repo, prompt: "p", provider: "ollama", lane: "http", baseUrl: "http://127.0.0.1:9" }),
      /requires a non-empty files list/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("A1-5: the credential is resolved from the named env var, and never appears in the result", async () => {
  // Points at a closed port so the fetch fails fast; what matters is that the
  // resolution path accepted the env var and did not leak it into the result.
  const result = await sendMessages({
    baseUrl: "http://127.0.0.1:9",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    apiKeyEnvVar: "DH_TEST_KEY",
    env: { DH_TEST_KEY: "sk-s3cret-value" },
    timeoutMs: 1500,
  });
  assert.equal(result.ok, false, "a closed port cannot succeed");
  assert.equal(JSON.stringify(result).includes("sk-s3cret-value"), false, "the credential must never surface in the result");
});
