import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * One receipt schema across all three worker lanes (spec §2.2). The schema
 * deliberately holds BOTH token usage and USD cost: Codex reports tokens,
 * Claude's headless mode reports `total_cost_usd`, local models report
 * telemetry tokens. Absence is represented as null, never invented as zero.
 *
 * `resolutionVerified` is the DevHarmonics-v1 rule carried forward: passing a
 * model argument is not proof of which model executed. When the runtime does
 * not report its resolved identity, the receipt keeps the request and marks
 * resolution unverified.
 */
export const RECEIPT_SCHEMA = "devharmonics-receipt-v1";
export const LANES = Object.freeze(["acp", "http", "subprocess"]);
export const STATUSES = Object.freeze(["completed", "failed", "timeout", "interrupted"]);

export function promptSha256(prompt) {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function createReceipt(input) {
  return {
    schema: RECEIPT_SCHEMA,
    receiptId: input.receiptId ?? randomUUID(),
    taskId: input.taskId,
    lane: input.lane,
    provider: input.provider,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel ?? null,
    resolutionVerified: input.resolutionVerified === true,
    endpoint: input.endpoint ?? null,
    args: input.args ?? null,
    promptSha256: input.promptSha256 ?? (typeof input.prompt === "string" ? promptSha256(input.prompt) : null),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    status: input.status,
    exit: input.exit ?? null,
    usage: input.usage ?? null,
    artifactPath: input.artifactPath ?? null,
    eventsPath: input.eventsPath ?? null,
    // What the worker-env boundary removed from this child's environment.
    // Recorded so the §2.5 protection is auditable evidence, not just
    // behavior a reader has to take on faith.
    strippedEnv: input.strippedEnv ?? null,
  };
}

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateReceipt(receipt) {
  const errors = [];
  const need = (condition, message) => { if (!condition) errors.push(message); };
  need(receipt && typeof receipt === "object", "receipt must be an object");
  if (errors.length) return { ok: false, errors };
  need(receipt.schema === RECEIPT_SCHEMA, `schema must be ${RECEIPT_SCHEMA}`);
  need(typeof receipt.receiptId === "string" && receipt.receiptId.length > 0, "receiptId required");
  need(TASK_ID_PATTERN.test(receipt.taskId ?? ""), "taskId must match the task-id pattern");
  need(LANES.includes(receipt.lane), `lane must be one of ${LANES.join(", ")}`);
  need(typeof receipt.provider === "string" && receipt.provider.length > 0, "provider required");
  need(typeof receipt.requestedModel === "string" && receipt.requestedModel.length > 0, "requestedModel required");
  need(receipt.resolvedModel === null || typeof receipt.resolvedModel === "string", "resolvedModel must be string or null");
  need(typeof receipt.resolutionVerified === "boolean", "resolutionVerified must be boolean");
  if (receipt.resolutionVerified) {
    need(typeof receipt.resolvedModel === "string" && receipt.resolvedModel.length > 0,
      "resolutionVerified=true requires a resolvedModel");
  }
  need(ISO_PATTERN.test(receipt.startedAt ?? ""), "startedAt must be ISO-8601");
  need(ISO_PATTERN.test(receipt.finishedAt ?? ""), "finishedAt must be ISO-8601");
  need(Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0, "durationMs must be >= 0");
  need(STATUSES.includes(receipt.status), `status must be one of ${STATUSES.join(", ")}`);
  need(receipt.promptSha256 === null || /^[0-9a-f]{64}$/.test(receipt.promptSha256 ?? ""), "promptSha256 must be a sha256 hex or null");
  if (receipt.usage !== null) {
    const usage = receipt.usage;
    need(typeof usage === "object", "usage must be object or null");
    for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
      if (usage?.[key] !== undefined && usage[key] !== null) {
        need(Number.isSafeInteger(usage[key]) && usage[key] >= 0, `usage.${key} must be a nonnegative integer`);
      }
    }
    if (usage?.costUsd !== undefined && usage.costUsd !== null) {
      need(Number.isFinite(usage.costUsd) && usage.costUsd >= 0, "usage.costUsd must be a nonnegative number");
    }
    // A2-5 (independent audit): every field was type-checked in isolation, so
    // {inputTokens:10, outputTokens:5, totalTokens:100} validated cleanly. Each
    // number was well-formed and the set of them was nonsense, which weakens a
    // receipt precisely where it is later used as evidence of spend. Only checked
    // when all three are present — a provider that reports a subset (or reports
    // nothing) stays valid, since absent is honestly absent.
    const { inputTokens: i, outputTokens: o, totalTokens: t } = usage ?? {};
    if (Number.isSafeInteger(i) && Number.isSafeInteger(o) && Number.isSafeInteger(t)) {
      need(i + o === t, `usage.totalTokens (${t}) must equal inputTokens + outputTokens (${i} + ${o} = ${i + o})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Persist a receipt into its own run directory. Fails closed: an invalid
 * receipt throws rather than writing a malformed record that later reads as
 * evidence. `receipt.json` is written last-and-only; its presence marks a
 * recorded run.
 */
export function writeReceipt(runsRoot, receipt) {
  const validation = validateReceipt(receipt);
  if (!validation.ok) {
    throw new Error(`Refusing to write invalid receipt: ${validation.errors.join("; ")}`);
  }
  const stamp = receipt.startedAt.replaceAll(":", "-").replace(/\.\d+/, "");
  const runDir = path.join(runsRoot, `${stamp}-${receipt.receiptId}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return runDir;
}
