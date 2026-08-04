import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { resolvePathCommand, spawnPlan } from "./path-resolve.mjs";
import { createReceipt, writeReceipt } from "./receipts.mjs";

/**
 * Lane A: drive a coding agent over the Agent Client Protocol (stdio
 * JSON-RPC, @agentclientprotocol/sdk 1.3.0) as a bounded worker, emitting the
 * same receipt schema as the subprocess (run-worker.mjs) and HTTP lanes.
 *
 * API actually used from the SDK (verified against node_modules, not
 * guessed): the modern fluent builders `acp.client({name})` /
 * `acp.agent({name})` — NOT the deprecated `ClientSideConnection` /
 * `AgentSideConnection` classes, which the SDK's own README now points away
 * from ("Prefer {@link agent} / {@link client}"). Concretely:
 *   - `acp.ndJsonStream(output, input)` turns a child's stdin/stdout (via
 *     `Writable.toWeb` / `Readable.toWeb`) into the bidirectional Stream the
 *     connection needs.
 *   - `acp.client({name}).onRequest(acp.methods.client.session.requestPermission, handler)
 *     .connectWith(stream, async (ctx) => { ... })` is the client-side
 *     handshake; `ctx.request(acp.methods.agent.initialize, {...})` performs
 *     `initialize`, and `ctx.buildSession(cwd).withSession(async (session) => {...})`
 *     performs `session/new` and gives back an `ActiveSession`.
 *   - `session.prompt(text)` sends `session/prompt`; `session.nextUpdate()`
 *     yields `{kind:"session_update", notification, update}` for every
 *     `session/update` notification and finally one
 *     `{kind:"stop", response, stopReason}` carrying the `PromptResponse` —
 *     confirmed by reading acp.js: a rejected `session/prompt` request is
 *     also funneled into this same queue via `updates.reject(error)`, so a
 *     protocol-level failure surfaces as a rejection from the `nextUpdate()`
 *     loop rather than needing separate handling.
 *
 * Model resolution: ACP v1 has no top-level "resolved model" field. The
 * closest protocol-native signal is a `session/new` `configOptions` entry
 * with `category: "model"` and its `currentValue` (the `SessionConfigSelect`
 * shape), with a `_meta.model` extension key as a fallback some adapters may
 * use. When neither is present, resolution stays unverified — this mirrors
 * the DevHarmonics-v1 rule in receipts.mjs: a requested model is not proof of
 * which model executed.
 */

/**
 * A command is "bare" (needs PATH+PATHEXT resolution) when it names no
 * directory component. An already-resolved absolute path (or a path with any
 * separator) is used as-is, exactly like run-worker.mjs's precedent of only
 * calling resolvePathCommand on a bare commandName.
 */
function isBareCommand(command) {
  return path.basename(command) === command;
}

/**
 * Decide which permission option (if any) answers a `session/request_permission`
 * call under the worker's policy.
 *
 * - "deny": read-only posture, refuse every request.
 * - "allow-edits": grant only file-edit tool calls (`toolCall.kind === "edit"`);
 *   everything else (delete, move, execute, fetch, ...) is still refused. This
 *   is a deliberately narrow reading of "file-edit-type requests" — broader
 *   kinds like "delete"/"move" are treated as NOT edits and refused, since the
 *   contract calls out edits specifically.
 *
 * Prefers the "once" variant of the chosen answer over "always" (a bounded,
 * single-turn worker has no standing reason to ask for a blanket allow/deny).
 * Returns null if the agent didn't offer a matching option at all, in which
 * case the caller reports the request as cancelled rather than guessing.
 */
function choosePermissionOption(request, permissionMode) {
  const options = request.options ?? [];
  const findKind = (kind) => options.find((option) => option.kind === kind);
  const isEdit = request.toolCall?.kind === "edit";
  const wantAllow = permissionMode === "allow-edits" && isEdit;
  const chosen = wantAllow
    ? (findKind("allow_once") ?? findKind("allow_always"))
    : (findKind("reject_once") ?? findKind("reject_always"));
  return chosen ?? null;
}

/**
 * Pull a resolved model identifier out of a `session/new` response, per the
 * "Model resolution" note above. Returns resolutionVerified only when a real
 * value was found — never invented.
 */
function extractResolvedModel(newSessionResponse) {
  const configOptions = newSessionResponse?.configOptions ?? [];
  const modelOption = configOptions.find(
    (option) => option?.category === "model" && option?.type === "select" && typeof option?.currentValue === "string" && option.currentValue.length > 0,
  );
  if (modelOption) {
    return { resolvedModel: modelOption.currentValue, resolutionVerified: true };
  }
  const metaModel = newSessionResponse?._meta?.model;
  if (typeof metaModel === "string" && metaModel.length > 0) {
    return { resolvedModel: metaModel, resolutionVerified: true };
  }
  return { resolvedModel: null, resolutionVerified: false };
}

/**
 * Kill the adapter's whole process tree. Mirrors supervise.mjs's killTree
 * (same taskkill /T /F on Windows, SIGTERM on POSIX process groups) since
 * that function isn't exported and this lane needs its own copy: unlike
 * superviseProcess, the ACP lane keeps stdio open for a live JSON-RPC
 * connection instead of running one shot to completion, so it can't reuse
 * superviseProcess directly.
 */
function killTree(child, platform) {
  if (!child || child.pid == null) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already exited — fine.
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already exited — fine.
    }
  }, 5000);
  escalate.unref?.();
}

export async function runAcpWorker({
  taskId,
  provider,
  adapterCommand,
  adapterArgs = [],
  model = null,
  prompt,
  cwd,
  runsRoot,
  permissionMode = "deny",
  timeoutMs = 10 * 60_000,
  env = process.env,
}) {
  const receiptId = randomUUID();
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replaceAll(":", "-").replace(/\.\d+/, "");
  const runDir = path.join(runsRoot, `${stamp}-${receiptId}`);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, "events.jsonl");
  writeFileSync(eventsPath, "");

  const events = [];
  const permissionRequests = [];
  const appendEvent = (event) => {
    events.push(event);
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  };

  // Every attempt leaves a receipt, spawn failures included — the
  // run-worker.mjs precedent this lane must not break.
  const finish = ({
    status,
    resolvedModel = null,
    resolutionVerified = false,
    usage = null,
    finalText = null,
    error = null,
    exitCode = null,
    timedOut = false,
  }) => {
    const finishedAt = new Date().toISOString();
    if (finalText != null) {
      writeFileSync(path.join(runDir, "final-text.txt"), finalText);
    }
    const receipt = createReceipt({
      receiptId,
      taskId,
      lane: "acp",
      provider,
      requestedModel: model ?? "adapter-default",
      resolvedModel,
      resolutionVerified,
      endpoint: adapterCommand,
      args: adapterArgs,
      prompt,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      status,
      exit: { code: exitCode, timedOut, error },
      usage,
      artifactPath: finalText != null ? path.join(runDir, "final-text.txt") : null,
      eventsPath,
    });
    writeReceipt(runsRoot, receipt);
    return { receipt, runDir, events, permissionRequests };
  };

  const resolvedCommand = isBareCommand(adapterCommand)
    ? resolvePathCommand(adapterCommand, { env })
    : adapterCommand;
  if (!resolvedCommand) {
    return finish({ status: "failed", error: `"${adapterCommand}" not found on PATH` });
  }

  const platform = process.platform;
  // Host-session hygiene (found live 2026-08-04): when the coordinator IS a
  // Claude session — a first-class deployment shape for this factory — the
  // inherited CLAUDECODE marker makes the adapter's child Claude refuse to
  // start ("cannot be launched inside another Claude Code session"; its own
  // error names unsetting the variable as the sanctioned bypass). A worker
  // is a deliberately separate bounded workload in its own workspace, so
  // session markers must not leak into it — the same principle as v1's
  // credential stripping at the worker boundary.
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete childEnv[key];
  }
  const { spawnCommand, spawnArgs, verbatim } = spawnPlan(resolvedCommand, adapterArgs, { platform, env: childEnv });

  let child;
  try {
    child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // See supervise.mjs: detaching on POSIX makes the child a process-group
      // leader so killTree can signal the whole group; Windows has no such
      // concept and taskkill /T walks the real tree by PID instead.
      detached: platform !== "win32",
      windowsVerbatimArguments: verbatim,
    });
  } catch (err) {
    return finish({ status: "failed", error: `spawn: ${err?.message ?? err}` });
  }

  let stderrText = "";
  child.stderr?.on("data", (chunk) => {
    stderrText += chunk.toString();
  });
  // Writing to / reading from a child that dies mid-handshake raises stream
  // errors; left unhandled these are uncaught "error" events that would
  // crash the whole worker process instead of surfacing as a failed receipt.
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
  let spawnError = null;
  child.on("error", (err) => {
    spawnError = String(err?.message ?? err);
  });

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout);
  const stream = acp.ndJsonStream(input, output);

  let resolvedModel = null;
  let resolutionVerified = false;
  let finalText = "";
  let usage = null;

  const clientApp = acp.client({ name: "devharmonics-acp-worker" }).onRequest(
    acp.methods.client.session.requestPermission,
    (ctx) => {
      const request = ctx.params;
      const chosen = choosePermissionOption(request, permissionMode);
      const response = chosen
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } };
      const record = {
        toolCallId: request.toolCall?.toolCallId ?? null,
        kind: request.toolCall?.kind ?? null,
        title: request.toolCall?.title ?? null,
        options: request.options ?? [],
        answer: response.outcome,
      };
      permissionRequests.push(record);
      appendEvent({ type: "permission_request", at: new Date().toISOString(), ...record });
      return response;
    },
  );

  const runOperation = clientApp.connectWith(stream, async (ctx) => {
    const initResult = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    appendEvent({ type: "initialize", at: new Date().toISOString(), result: initResult });

    return ctx.buildSession(cwd).withSession(async (session) => {
      const modelInfo = extractResolvedModel(session.newSessionResponse);
      resolvedModel = modelInfo.resolvedModel;
      resolutionVerified = modelInfo.resolutionVerified;
      appendEvent({ type: "session_new", at: new Date().toISOString(), response: session.newSessionResponse });

      // Errors from this request (a rejected session/prompt call) are also
      // delivered through nextUpdate() below — see the acp.js citation above
      // — so this rejection is intentionally left unhandled here.
      session.prompt(prompt).catch(() => {});

      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          if (message.response.usage) {
            usage = {
              inputTokens: message.response.usage.inputTokens ?? null,
              outputTokens: message.response.usage.outputTokens ?? null,
              totalTokens: message.response.usage.totalTokens ?? null,
            };
          }
          appendEvent({ type: "stop", at: new Date().toISOString(), response: message.response });
          return message.response;
        }
        appendEvent({ type: "session_update", at: new Date().toISOString(), notification: message.notification });
        const { update } = message;
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
          finalText += update.content.text;
        }
      }
    });
  });

  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const operationPromise = runOperation.then(
    (response) => ({ kind: "ok", response }),
    (error) => ({ kind: "error", error }),
  );

  const outcome = await Promise.race([operationPromise, timeoutPromise]);
  clearTimeout(timeoutHandle);
  // If the timeout won the race, the operation promise is still pending
  // against a stream that's about to be killed below; it will settle (almost
  // always to "error", once the killed child closes the stream) after we've
  // already produced our result. Swallow it so that late settlement never
  // becomes an unhandled rejection.
  operationPromise.catch(() => {});

  // The prompt turn (if it ever completed) is over; nothing further should
  // be talking to this adapter process. Kill it in every terminal case, not
  // only on timeout — a bounded worker never leaves a zombie behind.
  killTree(child, platform);

  if (outcome.kind === "timeout") {
    return finish({
      status: "timeout",
      resolvedModel,
      resolutionVerified,
      finalText: finalText || null,
      timedOut: true,
      error: "timed out waiting for the agent to complete the prompt turn",
    });
  }

  if (outcome.kind === "error") {
    const message = spawnError ?? String(outcome.error?.message ?? outcome.error);
    return finish({
      status: "failed",
      resolvedModel,
      resolutionVerified,
      finalText: finalText || null,
      error: stderrText ? `${message} | stderr: ${stderrText.slice(0, 2000)}` : message,
    });
  }

  return finish({
    status: "completed",
    resolvedModel,
    resolutionVerified,
    finalText: finalText || null,
    usage,
  });
}
