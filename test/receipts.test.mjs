import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReceipt, promptSha256, validateReceipt, writeReceipt } from "../scripts/receipts.mjs";

function validInput(overrides = {}) {
  return {
    taskId: "implement-add",
    lane: "subprocess",
    provider: "codex",
    requestedModel: "gpt-5.6-luna",
    resolvedModel: null,
    resolutionVerified: false,
    prompt: "Implement add(a, b).",
    startedAt: "2026-08-04T20:00:00.000Z",
    finishedAt: "2026-08-04T20:00:09.000Z",
    durationMs: 9000,
    status: "completed",
    exit: { code: 0 },
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsd: null },
    ...overrides,
  };
}

test("a complete receipt validates and round-trips to disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-receipts-"));
  try {
    const receipt = createReceipt(validInput());
    assert.deepEqual(validateReceipt(receipt), { ok: true, errors: [] });
    const runDir = writeReceipt(dir, receipt);
    const file = path.join(runDir, "receipt.json");
    assert.ok(existsSync(file));
    const readBack = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(readBack.receiptId, receipt.receiptId);
    assert.equal(readBack.promptSha256, promptSha256("Implement add(a, b)."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid receipt is refused at the write boundary, fail closed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-receipts-"));
  try {
    const receipt = createReceipt(validInput({ lane: "telepathy" }));
    assert.throws(() => writeReceipt(dir, receipt), /Refusing to write invalid receipt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claiming verified resolution without a resolved model is invalid", () => {
  // The v1 rule carried forward: passing a model argument is not proof of
  // which model executed.
  const receipt = createReceipt(validInput({ resolutionVerified: true, resolvedModel: null }));
  const result = validateReceipt(receipt);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("resolutionVerified")));
});

test("usage may be absent (null) but never malformed", () => {
  assert.equal(validateReceipt(createReceipt(validInput({ usage: null }))).ok, true);
  const negative = validateReceipt(createReceipt(validInput({ usage: { totalTokens: -1 } })));
  assert.equal(negative.ok, false);
  const badCost = validateReceipt(createReceipt(validInput({ usage: { costUsd: -0.5 } })));
  assert.equal(badCost.ok, false);
});

test("both usage shapes are representable: token counts and USD cost", () => {
  const tokens = createReceipt(validInput({ usage: { totalTokens: 140 } }));
  const usd = createReceipt(validInput({ usage: { costUsd: 0.0125 } }));
  assert.equal(validateReceipt(tokens).ok, true);
  assert.equal(validateReceipt(usd).ok, true);
});
