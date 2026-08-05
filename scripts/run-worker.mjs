import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { resolvePathCommand } from "./path-resolve.mjs";
import { buildInvocation, parseWorkerOutput } from "./providers.mjs";
import { superviseProcess } from "./supervise.mjs";
import { createReceipt, writeReceipt } from "./receipts.mjs";
import { workerEnv } from "./worker-env.mjs";

/**
 * Run one bounded subprocess-lane worker and leave a receipt — ALWAYS a
 * receipt, including for attempts that never spawned. An attempt that leaves
 * no evidence is indistinguishable from an attempt that never happened, and
 * the factory's whole claim is that those two things are never confused.
 *
 * The run directory is created up front (the codex adapter needs a place for
 * --output-last-message before the process starts) and the receipt lands in
 * that same directory last, mirroring the receipt-marks-a-recorded-run rule.
 */
export async function runWorker({
  taskId,
  provider,
  model,
  prompt,
  cwd,
  runsRoot,
  sandbox = "read-only",
  permissionMode = "dontAsk",
  allowedTools = ["Read"],
  maxTurns = 30,
  reasoningEffort = "low",
  timeoutMs = 10 * 60_000,
  env = process.env,
}) {
  const receiptId = randomUUID();
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replaceAll(":", "-").replace(/\.\d+/, "");
  const runDir = path.join(runsRoot, `${stamp}-${receiptId}`);
  mkdirSync(runDir, { recursive: true });

  // SPEC §2.5, implemented (was claimed-but-absent until 2026-08-05, proven
  // by a live leak test): the worker child receives a credential-stripped
  // environment. PATH survives, so resolution is unaffected; API keys do not.
  const { env: childEnv, stripped } = workerEnv(env);

  const finish = ({ status, exit, supervised = null, parsed = null }) => {
    const finishedAt = new Date().toISOString();
    const receipt = createReceipt({
      receiptId,
      taskId,
      lane: "subprocess",
      provider,
      requestedModel: model || "unspecified",
      resolvedModel: parsed?.resolvedModel ?? null,
      resolutionVerified: parsed?.resolutionVerified === true,
      args: exit.args ?? null,
      prompt,
      startedAt,
      finishedAt,
      durationMs: supervised?.durationMs ?? (Date.parse(finishedAt) - Date.parse(startedAt)),
      status,
      exit: { code: exit.code ?? null, timedOut: exit.timedOut ?? false, error: exit.error ?? null },
      usage: parsed?.usage ?? null,
      artifactPath: parsed?.finalText != null ? path.join(runDir, "final-text.txt") : null,
      eventsPath: supervised ? path.join(runDir, "stdout.log") : null,
      strippedEnv: stripped,
    });
    if (parsed?.finalText != null) writeFileSync(path.join(runDir, "final-text.txt"), parsed.finalText);
    writeReceipt(runsRoot, receipt);
    return { receipt, runDir, parsed, supervised };
  };

  let invocation;
  try {
    invocation = buildInvocation({ provider, model, prompt, cwd, outputDir: runDir, sandbox, permissionMode, allowedTools, maxTurns, reasoningEffort });
  } catch (error) {
    return finish({ status: "failed", exit: { error: `invocation: ${error.message}` } });
  }

  const command = resolvePathCommand(invocation.commandName, { env: childEnv });
  if (!command) {
    return finish({ status: "failed", exit: { error: `"${invocation.commandName}" not found on PATH`, args: invocation.args } });
  }

  const supervised = await superviseProcess({
    command,
    args: invocation.args,
    cwd,
    prompt: invocation.promptDelivery === "stdin" ? prompt : null,
    timeoutMs,
    env: childEnv,
  });
  writeFileSync(path.join(runDir, "stdout.log"), supervised.stdout);
  writeFileSync(path.join(runDir, "stderr.log"), supervised.stderr);

  const parsed = parseWorkerOutput(provider, {
    stdout: supervised.stdout,
    stderr: supervised.stderr,
    exitCode: supervised.exitCode,
    outputDir: runDir,
  });

  const status = supervised.timedOut ? "timeout"
    : (supervised.error || supervised.exitCode !== 0) ? "failed"
    : "completed";
  return finish({
    status,
    exit: { code: supervised.exitCode, timedOut: supervised.timedOut, error: supervised.error, args: invocation.args },
    supervised,
    parsed,
  });
}
