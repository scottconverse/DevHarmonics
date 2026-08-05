import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { probeToolUse, sendMessages } from "../scripts/messages-client.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => resolve(raw ? JSON.parse(raw) : null));
  });
}

function jsonHandler(bodyFactory) {
  return async (request, response) => {
    const requestBody = await readBody(request);
    const result = bodyFactory(requestBody, request);
    response.statusCode = result.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result.body));
  };
}

test("sendMessages happy path: text content, usage, and resolved model are mapped", async () => {
  const result = await withServer(
    jsonHandler(() => ({
      body: {
        id: "msg_1",
        type: "message",
        model: "gemma-4-12b",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    })),
    (baseUrl) =>
      sendMessages({
        baseUrl,
        model: "gemma-4-12b",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 5_000,
      })
  );

  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.contentText, "hello world");
  assert.deepEqual(result.toolUses, []);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
  assert.equal(result.resolvedModel, "gemma-4-12b");
  assert.equal(result.error, null);
});

test("sendMessages tool_use response: toolUses populated, contentText null", async () => {
  const result = await withServer(
    jsonHandler(() => ({
      body: {
        id: "msg_2",
        type: "message",
        model: "gemma-4-12b",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
    })),
    (baseUrl) =>
      sendMessages({
        baseUrl,
        model: "gemma-4-12b",
        messages: [{ role: "user", content: "weather?" }],
        tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
        timeoutMs: 5_000,
      })
  );

  assert.equal(result.ok, true);
  assert.equal(result.contentText, null);
  assert.deepEqual(result.toolUses, [{ id: "toolu_1", name: "get_weather", input: { city: "Paris" } }]);
  assert.equal(result.usage, null);
});

test("sendMessages HTTP 500 -> ok:false, httpStatus 500, error set, no throw", async () => {
  const result = await withServer(
    (request, response) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: "internal boom" } }));
    },
    (baseUrl) =>
      sendMessages({
        baseUrl,
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 5_000,
      })
  );

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 500);
  assert.match(result.error, /HTTP 500/);
  assert.match(result.error, /internal boom/);
});

test("sendMessages dead port -> ok:false, error set, no throw", async () => {
  const result = await sendMessages({
    baseUrl: "http://127.0.0.1:1",
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    timeoutMs: 3_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, null);
  assert.ok(result.error && result.error.length > 0);
});

test("sendMessages usage absent -> usage null, never zeros", async () => {
  const result = await withServer(
    jsonHandler(() => ({
      body: { id: "msg_3", type: "message", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    })),
    (baseUrl) =>
      sendMessages({
        baseUrl,
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 5_000,
      })
  );

  assert.equal(result.ok, true);
  assert.equal(result.usage, null);
});

test("probeToolUse PASS: server returns a correct get_weather tool_use for Paris", async () => {
  const result = await withServer(
    jsonHandler(() => ({
      body: {
        id: "msg_4",
        type: "message",
        model: "gemma-4-12b",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_2", name: "get_weather", input: { city: "Paris, France" } },
        ],
      },
    })),
    (baseUrl) => probeToolUse({ baseUrl, model: "gemma-4-12b", timeoutMs: 5_000 })
  );

  assert.equal(result.status, "PASS", result.detail);
  assert.equal(result.id, "tooluse:gemma-4-12b");
  assert.equal(result.evidence.stopReason, "tool_use");
});

test("probeToolUse FAIL on a text-only answer, detail says no tool_use block", async () => {
  const result = await withServer(
    jsonHandler(() => ({
      body: {
        id: "msg_5",
        type: "message",
        model: "gemma-4-12b",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "It's sunny in Paris today." }],
      },
    })),
    (baseUrl) => probeToolUse({ baseUrl, model: "gemma-4-12b", timeoutMs: 5_000 })
  );

  assert.equal(result.status, "FAIL");
  assert.match(result.detail, /no tool_use block/);
  assert.equal(result.evidence.stopReason, "end_turn");
});

test("probeToolUse FAIL on malformed tool_use (wrong tool name), named in detail", async () => {
  const result = await withServer(
    jsonHandler(() => ({
      body: {
        id: "msg_6",
        type: "message",
        model: "gemma-4-12b",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_3", name: "lookup_forecast", input: { city: "Paris" } }],
      },
    })),
    (baseUrl) => probeToolUse({ baseUrl, model: "gemma-4-12b", timeoutMs: 5_000 })
  );

  assert.equal(result.status, "FAIL");
  assert.match(result.detail, /lookup_forecast/);
  assert.match(result.detail, /get_weather/);
});

test("system/tools are omitted from the request body when null", async () => {
  let capturedBody = null;
  const result = await withServer(
    async (request, response) => {
      capturedBody = await readBody(request);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ id: "msg_7", type: "message", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] })
      );
    },
    (baseUrl) =>
      sendMessages({
        baseUrl,
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 5_000,
      })
  );

  assert.equal(result.ok, true);
  assert.ok(!("system" in capturedBody), "system key must be absent when null");
  assert.ok(!("tools" in capturedBody), "tools key must be absent when null");
  assert.ok(!("tool_choice" in capturedBody), "tool_choice key must be absent when null");
  assert.deepEqual(Object.keys(capturedBody).sort(), ["max_tokens", "messages", "model"]);
});

test("system/tools/tool_choice are included in the request body when provided", async () => {
  let capturedBody = null;
  await withServer(
    async (request, response) => {
      capturedBody = await readBody(request);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ id: "msg_8", type: "message", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] })
      );
    },
    (baseUrl) =>
      sendMessages({
        baseUrl,
        model: "x",
        system: "be terse",
        tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
        toolChoice: { type: "auto" },
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 5_000,
      })
  );

  assert.equal(capturedBody.system, "be terse");
  assert.equal(capturedBody.tools[0].name, "t");
  assert.deepEqual(capturedBody.tool_choice, { type: "auto" });
});

// --- PAID-LANE BUDGET (owner decision 2026-08-05 night) ---------------------
// A call carrying a real credential must be metered by the money half of the
// admission ledger, fail closed without a configured budget, reserve before
// the request, and reconcile with the response's real usage after.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const OK_MESSAGE = {
  type: "message",
  model: "claude-test",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 40, output_tokens: 10 },
};

test("paid: a credentialed call with NOTHING configured is refused by the master switch first — the double opt-in (v1 port (b))", async (t) => {
  let requests = 0;
  const result = await withServer(
    jsonHandler(() => { requests += 1; return { body: OK_MESSAGE }; }),
    (baseUrl) => sendMessages({
      baseUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-real-credential",
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /^paid-api-disabled-by-policy/);
  assert.match(result.error, /allowPaidApi/);
  assert.equal(requests, 0, "the metered endpoint must never be reached un-metered");
});

test("paid: allowPaidApi alone is not enough — a missing token budget still refuses before any request", async (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "dh-paid-nobudget-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  let requests = 0;
  const result = await withServer(
    jsonHandler(() => { requests += 1; return { body: OK_MESSAGE }; }),
    (baseUrl) => sendMessages({
      baseUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-real-credential",
      paidBudget: { stateRoot, allowPaidApi: true, taskId: "paid-nobudget" },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /^paid-budget-unconfigured/);
  assert.equal(requests, 0, "the metered endpoint must never be reached un-metered");
});

test("paid: reservation before the request, reconciliation with REAL usage after — replayable from the ledger", async (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "dh-paid-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const result = await withServer(
    jsonHandler(() => ({ body: OK_MESSAGE })),
    (baseUrl) => sendMessages({
      baseUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
      apiKey: "sk-real-credential",
      paidBudget: { stateRoot, allowPaidApi: true, maxPaidTokens: 10_000, taskId: "paid-ok" },
    }),
  );
  assert.equal(result.ok, true, result.error);
  const ledger = readFileSync(path.join(stateRoot, "usage.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(ledger.length, 2, "one reservation + one terminal");
  assert.equal(ledger[0].stage, "reserved");
  assert.equal(ledger[0].paid, true);
  assert.deepEqual(ledger[1].usage, { total_tokens: 50 }, "reconciled with the response's REAL 40+10 tokens, not the estimate");
});

test("paid: a budget that cannot cover the reservation refuses — the request is never sent", async (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "dh-paid-over-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  let requests = 0;
  const result = await withServer(
    jsonHandler(() => { requests += 1; return { body: OK_MESSAGE }; }),
    (baseUrl) => sendMessages({
      baseUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
      apiKey: "sk-real-credential",
      paidBudget: { stateRoot, allowPaidApi: true, maxPaidTokens: 10, taskId: "paid-over" },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /^paid-budget-exceeded/);
  assert.equal(requests, 0);
});

test("paid: a failed request reconciles as UNKNOWN usage, which closes the paid lane until reconciled deliberately", async (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "dh-paid-unknown-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  // Server returns a 500 with no usage: the spend is unknowable.
  await withServer(
    jsonHandler(() => ({ status: 500, body: { error: { message: "boom" } } })),
    (baseUrl) => sendMessages({
      baseUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-real-credential",
      paidBudget: { stateRoot, allowPaidApi: true, maxPaidTokens: 10_000, taskId: "paid-boom" },
    }),
  );
  // The next paid call must be refused: the ledger now contains a paid
  // terminal with unknown usage, and summarizeLedger throws on it (the
  // "unknown paid usage closes the paid lane" rule).
  const next = await withServer(
    jsonHandler(() => ({ body: OK_MESSAGE })),
    (baseUrl) => sendMessages({
      baseUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-real-credential",
      paidBudget: { stateRoot, allowPaidApi: true, maxPaidTokens: 10_000, taskId: "paid-after-boom" },
    }),
  );
  assert.equal(next.ok, false);
  assert.match(next.error, /paid-budget-exceeded/);
  assert.match(next.error, /without trustworthy token usage/);
});

test("unpaid: key-less local calls are untouched — no budget required, no ledger written", async (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "dh-unpaid-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const result = await withServer(
    jsonHandler(() => ({ body: OK_MESSAGE })),
    (baseUrl) => sendMessages({
      baseUrl,
      model: "local-model",
      messages: [{ role: "user", content: "hi" }],
      paidBudget: { stateRoot, allowPaidApi: true, maxPaidTokens: 10_000, taskId: "unpaid" },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(existsSync(path.join(stateRoot, "usage.jsonl")), false, "an unpaid call writes nothing to the money ledger");
});
