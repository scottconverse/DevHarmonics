import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Per-provider invocation builders and output parsers for the subprocess
 * worker lane (spec §2.2, lane "subprocess"). Each provider CLI has its own
 * flag surface and output shape; this module is the one place that encodes
 * both, so the supervisor never has to special-case a provider inline.
 *
 * The invocation shapes below were verified LIVE this week (2026-08-04)
 * against the actual installed CLIs, not from documentation alone — do not
 * add flags beyond what is written here without re-verifying live.
 */
export const SUBPROCESS_PROVIDERS = Object.freeze(["codex", "claude", "agy"]);

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`buildInvocation: ${name} must be a non-empty string`);
  }
}

/**
 * Build the argv (and stdin-vs-argv prompt delivery) for one subprocess
 * worker invocation. Never spawns anything itself — the supervisor decides
 * how to run the result.
 *
 * `promptDelivery` matters for a real reason: codex reads its prompt from
 * stdin (keeping it out of argv, out of process listings, out of shell
 * history replays), while claude and agy take it as a CLI argument. Getting
 * this wrong either sends a prompt nobody reads (stdin ignored) or leaks a
 * prompt into argv that the caller expected to keep off argv.
 */
export function buildInvocation({
  provider,
  model,
  prompt,
  cwd,
  outputDir,
  sandbox = "read-only",
  permissionMode = "dontAsk",
  allowedTools = ["Read"],
  maxTurns = 30,
  // Optional USD spend ceiling for providers that support one (claude).
  // null = no cap emitted, which is the pre-existing behavior.
  maxBudgetUsd = null,
  reasoningEffort = "low",
}) {
  if (!SUBPROCESS_PROVIDERS.includes(provider)) {
    throw new Error(`buildInvocation: unknown provider "${provider}" (expected one of ${SUBPROCESS_PROVIDERS.join(", ")})`);
  }
  requireNonEmptyString(prompt, "prompt");
  requireNonEmptyString(cwd, "cwd");
  requireNonEmptyString(outputDir, "outputDir");
  // agy ignores the model argument entirely (see below) — every other
  // provider requires a real model string, fail closed rather than silently
  // running whatever the CLI defaults to.
  if (provider !== "agy") {
    requireNonEmptyString(model, "model");
  }

  if (provider === "codex") {
    return {
      commandName: "codex",
      args: [
        "exec",
        "-m",
        model,
        "-c",
        `model_reasoning_effort="${reasoningEffort}"`,
        "--ephemeral",
        "--json",
        "--sandbox",
        sandbox,
        // Required for scratch/non-git working directories — found live:
        // without it, codex exits 1 with "Not inside a trusted directory"
        // even when --sandbox and -C are both set correctly (2026-08-04).
        "--skip-git-repo-check",
        "-C",
        cwd,
        "--output-last-message",
        path.join(outputDir, "last-message.txt"),
        "-",
      ],
      promptDelivery: "stdin",
    };
  }

  if (provider === "claude") {
    return {
      commandName: "claude",
      args: [
        // --print (headless). The prompt is delivered on STDIN, not as a
        // positional argv element — see promptDelivery below. On Windows
        // `claude` resolves to claude.CMD (an npm %*-forwarding shim), so an
        // argv-delivered prompt is parsed by cmd.exe twice and an adversarial
        // one with an odd `"` count before a metacharacter launched a second
        // process (GAUNTLET B-1, reproduced live); a multi-line one was
        // silently truncated at the first newline (C-1). Riding stdin keeps
        // untrusted model/task/reviewer content off the command line entirely,
        // where no cmd.exe parse can ever reach it. Verified live 2026-08-05:
        // `claude -p --output-format json` reads its prompt from stdin,
        // including through the ComSpec wrap superviseProcess uses.
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--max-turns",
        String(maxTurns),
        "--permission-mode",
        permissionMode,
        "--allowedTools",
        allowedTools.join(","),
        "--add-dir",
        cwd,
        // Spend ceiling. SPEC §2.2 listed --max-budget-usd among claude's
        // verified flags, but buildInvocation never emitted it — the same
        // spec-claims-what-code-lacks class as the §2.5 credential gap,
        // caught by the gauntlet's docs audit. A bounded worker with no
        // spend ceiling is exactly the runaway the factory exists to
        // prevent, so the flag is emitted whenever a cap is configured.
        ...(maxBudgetUsd != null ? ["--max-budget-usd", String(maxBudgetUsd)] : []),
      ],
      // Deliberately NOT --bare: --bare forces API-key auth, and the factory
      // is subscription-first — non-bare uses the claude.ai subscription
      // OAuth session already signed in on this box.
      promptDelivery: "stdin",
    };
  }

  // provider === "agy" (Antigravity CLI, verified live 2026-08-04 against
  // agy 1.1.10). A model-selection flag is NOT verified to exist, so no
  // model flag is emitted; model pinning for agy is deferred.
  //
  // Three live findings shape these args:
  // 1. Bare `agy -p` answers WITHOUT editing files and still exits 0 — the
  //    classic process-completed-but-task-not-done false green.
  //    `--mode accept-edits` enables real file edits.
  // 2. Headless agy does NOT adopt the process cwd as its workspace — it
  //    edited its own ~/.gemini scratch dir while claiming success. The
  //    workspace must be declared explicitly with `--add-dir` (one apparent
  //    success without it proved to be luck, not behavior).
  // 3. Command execution in headless mode auto-denies without a
  //    settings.json permissions.allow rule (agy's own error says so); this
  //    adapter deliberately does NOT reach for
  //    --dangerously-skip-permissions — command permission stays an
  //    owner-configured rule, least privilege by default.
  return {
    commandName: "agy",
    args: [
      "-p", prompt,
      "--add-dir", cwd,
      ...(sandbox === "workspace-write" ? ["--mode", "accept-edits"] : []),
    ],
    promptDelivery: "argv",
  };
}

function parseCodexJsonl(stdout) {
  const events = [];
  const parseNotes = [];
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let garbageCount = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      garbageCount += 1;
    }
  }
  if (garbageCount > 0) {
    parseNotes.push(`skipped ${garbageCount} unparseable JSONL line(s)`);
  }
  return { events, parseNotes };
}

/** Pull {inputTokens, outputTokens, totalTokens} out of a codex usage-shaped event, or null. */
function extractUsageFromEvent(event) {
  const usage = event?.usage ?? (event?.token_count ? event.token_count : null);
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? null;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? null;
  if (inputTokens === null && outputTokens === null) return null;
  const totalTokens = usage.total_tokens ?? usage.totalTokens
    ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
  const result = {};
  if (inputTokens !== null) result.inputTokens = inputTokens;
  if (outputTokens !== null) result.outputTokens = outputTokens;
  result.totalTokens = totalTokens;
  return result;
}

/** Pull a model name out of any codex event field that names one, or null. */
function extractModelFromEvent(event) {
  return event?.model ?? event?.resolved_model ?? event?.resolvedModel ?? null;
}

function readCodexLastMessage(outputDir) {
  const file = path.join(outputDir, "last-message.txt");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  return text.length > 0 ? text : null;
}

function parseCodexOutput({ stdout, outputDir }) {
  const { events, parseNotes } = parseCodexJsonl(stdout ?? "");

  let usage = null;
  for (const event of events) {
    const found = extractUsageFromEvent(event);
    if (found) usage = found; // last usage event wins
  }

  let resolvedModel = null;
  for (const event of events) {
    const found = extractModelFromEvent(event);
    if (found) resolvedModel = found; // last one wins, same as usage
  }

  const finalText = readCodexLastMessage(outputDir);

  return {
    finalText,
    usage,
    resolvedModel,
    // true only when the runtime itself reported the model in events — a
    // requested model string passed as an argument is never proof of what
    // actually ran (the receipts.mjs v1 rule, carried forward here).
    resolutionVerified: resolvedModel !== null,
    parseNotes,
  };
}

function parseClaudeOutput({ stdout }) {
  const parseNotes = [];
  let parsed;
  try {
    parsed = JSON.parse(stdout ?? "");
  } catch (error) {
    return {
      finalText: null,
      usage: null,
      resolvedModel: null,
      resolutionVerified: false,
      parseNotes: [`stdout was not valid JSON: ${error.message}`],
    };
  }

  const finalText = typeof parsed?.result === "string" && parsed.result.length > 0 ? parsed.result : null;

  const usage = typeof parsed?.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : null;

  const costBreakdown = parsed?.cost_breakdown;
  const modelKeys = costBreakdown && typeof costBreakdown === "object" ? Object.keys(costBreakdown) : [];
  let resolvedModel = null;
  let resolutionVerified = false;
  if (modelKeys.length === 1) {
    resolvedModel = modelKeys[0];
    resolutionVerified = true;
  } else if (modelKeys.length > 1) {
    parseNotes.push(`cost_breakdown named ${modelKeys.length} models, expected exactly 1`);
  }

  return { finalText, usage, resolvedModel, resolutionVerified, parseNotes };
}

function parseAgyOutput({ stdout }) {
  const text = (stdout ?? "").trim();
  return {
    finalText: text.length > 0 ? text : null,
    usage: null,
    resolvedModel: null,
    resolutionVerified: false,
    parseNotes: [],
  };
}

/**
 * Parse one subprocess worker's raw output into the shared receipt shape.
 * Never throws: malformed/missing output is reported honestly through
 * `parseNotes` and null fields, never fabricated as zero or guessed.
 */
export function parseWorkerOutput(provider, { stdout, stderr, exitCode, outputDir } = {}) {
  if (!SUBPROCESS_PROVIDERS.includes(provider)) {
    return {
      finalText: null,
      usage: null,
      resolvedModel: null,
      resolutionVerified: false,
      parseNotes: [`unknown provider "${provider}"`],
    };
  }
  if (provider === "codex") return parseCodexOutput({ stdout, stderr, exitCode, outputDir });
  if (provider === "claude") return parseClaudeOutput({ stdout, stderr, exitCode, outputDir });
  return parseAgyOutput({ stdout, stderr, exitCode, outputDir });
}
