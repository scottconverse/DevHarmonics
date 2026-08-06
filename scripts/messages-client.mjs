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
  // v1 port (d): a third source — the NAME of a key in the DPAPI credential
  // store (devharmonics credential set <name>). Like apiKeyEnvVar, only the
  // name ever travels through call chains, receipts, and logs; the secret is
  // resolved here, at send time, and goes nowhere else.
  apiKeyCredential = null,
  // PAID-LANE BUDGET (owner correction, 2026-08-05 night): the money half of
  // admission.mjs was nearly deleted on an inference the owner never made.
  // It is now the live guard for every call that carries a REAL credential:
  // { stateRoot, maxPaidTokens } — reservation before the request, terminal
  // reconciliation with the response's real usage after, "unknown paid usage
  // closes the paid lane" enforced by the ledger itself. Key-less local
  // endpoints are unpaid and unaffected.
  paidBudget = undefined,
  deps = {},
  env = process.env,
}) {
  // SECRET-002 (audit 2026-08-06): config validation already refuses an endpoint
  // naming two credential sources; refuse it here too, so a library caller that
  // never went through config can't silently get the env var while believing the
  // stored credential is in use. Money guards refuse ambiguity everywhere.
  if (apiKeyEnvVar && apiKeyCredential) {
    return {
      ok: false,
      status: null,
      error: `ambiguous-credential-source: both apiKeyEnvVar ("${apiKeyEnvVar}") and apiKeyCredential ("${apiKeyCredential}") were supplied for ${baseUrl} — configure exactly one`,
      contentText: null,
      usage: null,
      resolvedModel: null,
    };
  }
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
  let storedKey;
  if (!apiKey && !apiKeyEnvVar && apiKeyCredential) {
    try {
      const store = deps.credentialStore ?? (await import("./credential-store.mjs")).createCredentialStore();
      storedKey = await store.get(apiKeyCredential);
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: `credential-unavailable: ${error.message}`,
        contentText: null,
        usage: null,
        resolvedModel: null,
      };
    }
    if (storedKey == null) {
      return {
        ok: false,
        status: null,
        error: `credential-unavailable: no credential named "${apiKeyCredential}" is stored — store it once with: devharmonics credential set ${apiKeyCredential}`,
        contentText: null,
        usage: null,
        resolvedModel: null,
      };
    }
  }
  // SECRET-004 (audit 2026-08-06): paid-ness is now decided by WHERE the
  // credential came from, not by comparing its text to the sentinel "local" —
  // a key whose literal value happened to be "local" used to skip metering.
  const resolvedApiKey = apiKey
    ?? (apiKeyEnvVar ? env[apiKeyEnvVar] : undefined)
    ?? storedKey
    ?? "local";
  const carriesRealCredential = Boolean(apiKey) || Boolean(apiKeyEnvVar && env[apiKeyEnvVar]) || storedKey != null;

  // A call is PAID exactly when a real credential rides with it. Fail closed:
  // no configured budget means no paid call — a metered endpoint must never
  // be reachable un-metered.
  const isPaid = carriesRealCredential;
  let paidReservation = null;
  if (isPaid) {
    // v1 port (b): the DOUBLE opt-in. Naming a credential opens nothing by
    // itself — budgets.allowPaidApi must also be set true, deliberately.
    if (paidBudget?.allowPaidApi !== true) {
      return {
        ok: false,
        httpStatus: null,
        stopReason: null,
        contentText: null,
        toolUses: [],
        usage: null,
        resolvedModel: null,
        error: `paid-api-disabled-by-policy: this call carries a real credential for ${baseUrl}, but budgets.allowPaidApi is not true. Paid API use is a double opt-in (v1 rule): set budgets.allowPaidApi: true AND budgets.maxPaidTokens in the project config (devharmonics config show) to open the paid lane deliberately.`,
        raw: null,
      };
    }
    if (!paidBudget || !Number.isSafeInteger(paidBudget.maxPaidTokens) || paidBudget.maxPaidTokens <= 0 || typeof paidBudget.stateRoot !== "string" || !paidBudget.stateRoot) {
      return {
        ok: false,
        httpStatus: null,
        stopReason: null,
        contentText: null,
        toolUses: [],
        usage: null,
        resolvedModel: null,
        error: `paid-budget-unconfigured: this call carries a real credential for ${baseUrl}, but no paid budget is configured. Set budgets.maxPaidTokens in the project's .devharmonics/config.json (see: devharmonics config show) — keep it deliberate; this is the ceiling on real API spend.`,
        raw: null,
      };
    }
    // Reserve BEFORE the request: the response ceiling we asked for plus an
    // estimate of the prompt. MONEY-002 (audit 2026-08-06): this divided by 4
    // (the English rule of thumb), which UNDER-counts code (~3 chars/token),
    // punctuation-dense JSON (~2.5) and CJK (~1) — so a single call could cross
    // the ceiling before reconciliation caught it. Halved to 2 so the estimate
    // errs toward the cap on realistic prompts; the reservation is temporary
    // either way (reconciliation replaces it with the response's real usage).
    const promptChars = JSON.stringify(messages).length + (system ? JSON.stringify(system).length : 0);
    const reservedTokens = maxTokens + Math.ceil(promptChars / 2);
    try {
      const reserveFn = deps.reservePaidUsage ?? (await import("./admission.mjs")).reservePaidUsage;
      paidReservation = await reserveFn({
        stateRoot: paidBudget.stateRoot,
        aggregateLimit: paidBudget.maxPaidTokens,
        reservedTokens,
        taskId: paidBudget.taskId ?? "messages-call",
        metadata: { baseUrl, model },
      });
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        stopReason: null,
        contentText: null,
        toolUses: [],
        usage: null,
        resolvedModel: null,
        error: `paid-budget-exceeded: ${error.message} (ledger: ${paidBudget.stateRoot}). Raise budgets.maxPaidTokens deliberately, or wait/reconcile — the request was never sent.`,
        raw: null,
      };
    }
  }
  // Close out the reservation with the response's REAL usage. A paid response
  // whose usage cannot be trusted is reconciled as usage:null, which the
  // ledger's own fail-closed rule then treats as "unknown paid usage" —
  // closing the paid lane until the owner reconciles it deliberately.
  const reconcilePaid = async (usage) => {
    if (!paidReservation) return;
    try {
      const reconcileFn = deps.reconcilePaidUsage ?? (await import("./admission.mjs")).reconcilePaidUsage;
      const total = Number.isSafeInteger(usage?.inputTokens) && Number.isSafeInteger(usage?.outputTokens)
        ? usage.inputTokens + usage.outputTokens
        : null;
      await reconcileFn({
        stateRoot: paidBudget.stateRoot,
        invocationId: paidReservation.invocationId,
        taskId: paidBudget.taskId ?? "messages-call",
        usage: total !== null ? { total_tokens: total } : null,
        metadata: { baseUrl, model },
      });
    } catch { /* the reservation stays counted — errs toward the ceiling */ }
  };

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
    // A request that MAY have reached a paid endpoint reconciles as unknown
    // usage — the ledger's fail-closed rule then closes the paid lane until
    // the owner reconciles deliberately (never silently charged zero).
    await reconcilePaid(null);
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
    await reconcilePaid(parsed?.usage
      ? { inputTokens: parsed.usage.input_tokens ?? null, outputTokens: parsed.usage.output_tokens ?? null }
      : null);
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

  await reconcilePaid(usage);
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
