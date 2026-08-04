#!/usr/bin/env node
/**
 * A real ACP agent, speaking the real protocol, over real stdio — driven by
 * the same @agentclientprotocol/sdk the worker under test uses. No AI runs
 * here; this exists so acp-worker.test.mjs exercises a genuine protocol
 * round-trip (spawn, initialize, session/new, session/update notifications,
 * a permission request, session/prompt completion) with zero network calls.
 *
 * Behavior is selected by the FAKE_ACP_BEHAVIOR env var:
 *   - "ok" (default): initialize, create a session that reports a resolved
 *     model via a "model" configOption, stream two session/update
 *     notifications (a message chunk, then a pending "edit" tool call),
 *     request permission for that tool call, and finish with a different
 *     final message depending on whether the permission was granted or
 *     refused. This single behavior covers both the allow-edits and deny
 *     acceptance tests — the interesting difference between them is entirely
 *     in which answer the *client* (the worker under test) gives.
 *   - "protocol-error": exit immediately, before answering anything, to
 *     simulate an adapter that is broken/incompatible.
 *   - "hang": complete initialize and session/new normally, but never
 *     resolve the session/prompt turn, to exercise the worker's timeout path.
 */
import * as acp from "@agentclientprotocol/sdk";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const behavior = process.env.FAKE_ACP_BEHAVIOR ?? "ok";

// Lets the test assert the adapter's whole process tree is actually dead
// after a timeout, rather than trusting that a kill call was merely issued.
if (process.env.FAKE_ACP_PIDFILE) {
  writeFileSync(process.env.FAKE_ACP_PIDFILE, String(process.pid));
}

if (behavior === "protocol-error") {
  process.exit(7);
}

class FakeAgent {
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
  }

  async newSession() {
    const sessionId = `fake-session-${Math.random().toString(16).slice(2)}`;
    return {
      sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fake-acp-model-1",
          options: [{ value: "fake-acp-model-1", name: "Fake ACP Model 1" }],
        },
      ],
    };
  }

  async authenticate() {
    return {};
  }

  async prompt(params, clientContext) {
    const { sessionId } = params;

    if (behavior === "hang") {
      // Never resolves and never notifies again — the worker's wall-clock
      // timeout is the only thing that ends this turn.
      await new Promise(() => {});
    }

    await clientContext.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Looking at the repository before editing." },
      },
    });

    await clientContext.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Edit config.json",
        kind: "edit",
        status: "pending",
        locations: [{ path: "config.json" }],
        rawInput: { path: "config.json" },
      },
    });

    const permission = await clientContext.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: "call-1",
        title: "Edit config.json",
        kind: "edit",
        status: "pending",
      },
      options: [
        { kind: "allow_once", name: "Allow this change", optionId: "allow" },
        { kind: "reject_once", name: "Skip this change", optionId: "reject" },
      ],
    });

    const granted = permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow";

    await clientContext.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: granted ? "completed" : "failed",
      },
    });

    await clientContext.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: granted
            ? "Edited config.json successfully."
            : "I could not edit the file: permission was refused.",
        },
      },
    });

    return {
      stopReason: "end_turn",
      usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 },
    };
  }

  async cancel() {}
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
const impl = new FakeAgent();

acp
  .agent({ name: "fake-acp-agent" })
  .onRequest("initialize", (ctx) => impl.initialize(ctx.params))
  .onRequest("session/new", (ctx) => impl.newSession(ctx.params))
  .onRequest("authenticate", (ctx) => impl.authenticate(ctx.params))
  .onRequest("session/prompt", (ctx) => impl.prompt(ctx.params, ctx.client))
  .onNotification("session/cancel", (ctx) => impl.cancel(ctx.params))
  .connect(stream);
