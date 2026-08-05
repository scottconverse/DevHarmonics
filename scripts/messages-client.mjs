/**
 * A single Anthropic Messages API client, switched by base URL. The same
 * request shape works against a local Ollama endpoint (:11434), LM Studio
 * (:1234), a LiteLLM proxy, or the real Anthropic API — they all speak
 * POST {baseUrl}/v1/messages. Network errors and non-200 responses never
 * throw; they come back as { ok: false, error, httpStatus }. Fields the
 * server didn't send (usage, model) are reported null — never invented.
 */

/**
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.model
 * @param {string|Array|null} [params.system]
 * @param {Array} params.messages
 * @param {number} [params.maxTokens]
 * @param {Array|null} [params.tools]
 * @param {object|null} [params.toolChoice]
 * @param {number} [params.timeoutMs]
 * @param {string|null} [params.apiKey] explicit credential; prefer apiKeyEnvVar
 * @param {string|null} [params.apiKeyEnvVar] name of an env var holding the credential
 * @param {object} [params.env]
 */
export async function sendMessages({
  baseUrl,
  model,
  system = null,
  messages,
  maxTokens = 1024,
  tools = null,
  toolChoice = null,
  timeoutMs = 120_000,
  // A1-5 (independent audit): this defaulted to the literal string "local" and the
  // http pipeline never supplied anything else, so an authenticated endpoint — the
  // opt-in real Claude API that SPEC §2.2 lists — always received `x-api-key: local`
  // and rejected it. There was no way to provide the real credential through the
  // call chain at all.
  //
  // Resolution order: an explicit apiKey argument, else a NAMED environment variable
  // the caller nominates (apiKeyEnvVar), else "local" for key-less local servers.
  // The key is read from the environment at call time and never returned, logged, or
  // written into a receipt — receipts record the endpoint, never the credential.
  apiKey = null,
  apiKeyEnvVar = null,
  env = process.env,
}) {
  const resolvedApiKey = apiKey
    ?? (apiKeyEnvVar ? env[apiKeyEnvVar] : undefined)
    ?? "local";
  if (apiKeyEnvVar && !env[apiKeyEnvVar]) {
    return {
      ok: false,
      status: null,
      error: `apiKeyEnvVar "${apiKeyEnvVar}" was requested but is not set in the environment — refusing to send a placeholder credential to ${baseUrl}`,
      contentText: null,
      usage: null,
      resolvedModel: null,
    };
  }
  const body = { model, max_tokens: maxTokens, messages };
  if (system !== null) body.system = system;
  if (tools !== null) body.tools = tools;
  if (toolChoice !== null) body.tool_choice = toolChoice;

  let response;
  let text;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": resolvedApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      stopReason: null,
      contentText: null,
      toolUses: [],
      usage: null,
      resolvedModel: null,
      error: `request failed: ${error.message}`,
      raw: null,
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body; reported raw via the error/text path below */
  }

  if (response.status !== 200) {
    const reason = parsed?.error?.message ?? text.slice(0, 200) ?? "(no body)";
    return {
      ok: false,
      httpStatus: response.status,
      stopReason: parsed?.stop_reason ?? null,
      contentText: null,
      toolUses: [],
      usage: null,
      resolvedModel: parsed?.model ?? null,
      error: `HTTP ${response.status}: ${reason}`,
      raw: parsed,
    };
  }

  const content = Array.isArray(parsed?.content) ? parsed.content : [];

  const textBlocks = content.filter((block) => block?.type === "text" && typeof block.text === "string");
  const contentText = textBlocks.length > 0 ? textBlocks.map((block) => block.text).join("") : null;

  const toolUses = content
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));

  const usage = parsed?.usage
    ? {
        inputTokens: parsed.usage.input_tokens ?? null,
        outputTokens: parsed.usage.output_tokens ?? null,
      }
    : null;

  return {
    ok: true,
    httpStatus: response.status,
    stopReason: parsed?.stop_reason ?? null,
    contentText,
    toolUses,
    usage,
    resolvedModel: parsed?.model ?? null,
    error: null,
    raw: parsed,
  };
}

/**
 * The tool-use QUALIFICATION probe. A local Anthropic-compat layer (Ollama,
 * LM Studio) claiming Messages-API support says nothing about whether its
 * tool-calling actually works for this endpoint and this model — that can
 * only be answered by making a real tool-use request and inspecting the
 * response. PASS requires an actual tool_use block named "get_weather" whose
 * input names Paris; everything else (text-only answer, wrong tool, error,
 * timeout) is FAIL with the exact reason and the raw stop_reason as evidence.
 *
 * Does not set tool_choice — Ollama is documented to ignore it, so the probe
 * must succeed on instruction alone, the same constraint a real caller faces.
 */
export async function probeToolUse({ baseUrl, model, timeoutMs = 90_000 }) {
  const id = `tooluse:${model}`;

  const tools = [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      input_schema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      },
    },
  ];

  const messages = [
    { role: "user", content: "What is the weather in Paris? Use the get_weather tool." },
  ];

  const result = await sendMessages({ baseUrl, model, messages, tools, timeoutMs });

  if (!result.ok) {
    return {
      id,
      status: "FAIL",
      detail: `request failed: ${result.error}`,
      evidence: { httpStatus: result.httpStatus, stopReason: result.stopReason, error: result.error },
    };
  }

  if (result.toolUses.length === 0) {
    return {
      id,
      status: "FAIL",
      detail: `no tool_use block in the response (text-only answer): ${JSON.stringify(result.contentText)}`,
      evidence: { stopReason: result.stopReason, contentText: result.contentText },
    };
  }

  const weatherCall = result.toolUses.find((toolUse) => toolUse.name === "get_weather");
  if (!weatherCall) {
    const gotNames = result.toolUses.map((toolUse) => toolUse.name).join(", ");
    return {
      id,
      status: "FAIL",
      detail: `tool_use block present but named "${gotNames}", expected "get_weather"`,
      evidence: { stopReason: result.stopReason, toolUses: result.toolUses },
    };
  }

  const city = weatherCall.input?.city;
  if (typeof city !== "string" || !city.toLowerCase().includes("paris")) {
    return {
      id,
      status: "FAIL",
      detail: `get_weather tool_use input did not name Paris: ${JSON.stringify(weatherCall.input)}`,
      evidence: { stopReason: result.stopReason, toolUses: result.toolUses },
    };
  }

  return {
    id,
    status: "PASS",
    detail: `get_weather called with city=${JSON.stringify(city)}`,
    evidence: { stopReason: result.stopReason, toolUses: result.toolUses },
  };
}
