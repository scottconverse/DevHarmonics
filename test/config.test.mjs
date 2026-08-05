import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, loadConfig, validateConfig } from "../scripts/config.mjs";

test("defaults validate clean", () => {
  const result = validateConfig(defaultConfig());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("a config file deep-merges over defaults without erasing siblings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-config-"));
  try {
    const file = path.join(dir, "factory.config.json");
    writeFileSync(file, JSON.stringify({ endpoints: { ollama: { baseUrl: "http://127.0.0.1:9999" } } }));
    const { config, source } = loadConfig(file);
    assert.equal(config.endpoints.ollama.baseUrl, "http://127.0.0.1:9999");
    assert.equal(config.endpoints.lmstudio.baseUrl, "http://127.0.0.1:1234", "unmentioned endpoints keep defaults");
    assert.equal(config.clis.codex.command, "codex");
    assert.equal(source, path.resolve(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid merged config throws rather than silently using defaults", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-config-"));
  try {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ endpoints: { ollama: { baseUrl: "not-a-url" } } }));
    assert.throws(() => loadConfig(file), /baseUrl must be an http/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing config path throws; malformed JSON throws with the path named", () => {
  assert.throws(() => loadConfig("Z:/does/not/exist.json"), /not found/);
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-config-"));
  try {
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{ nope");
    assert.throws(() => loadConfig(file), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateConfig names each failing field", () => {
  const bad = { ...defaultConfig(), version: 2, budgets: { maxWorkers: 0, maxConcurrentWorkers: 9, maxTotalTokens: -1, windowHours: 0 } };
  const result = validateConfig(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("version")));
  assert.ok(result.errors.some((e) => e.includes("maxWorkers")));
  assert.ok(result.errors.some((e) => e.includes("maxConcurrentWorkers")));
  assert.ok(result.errors.some((e) => e.includes("maxTotalTokens")));
  assert.ok(result.errors.some((e) => e.includes("windowHours")));
});

test("validateConfig rejects the deleted maxWorkerMinutes with a message naming its replacement", () => {
  const stale = { ...defaultConfig(), budgets: { ...defaultConfig().budgets, maxWorkerMinutes: 30 } };
  const result = validateConfig(stale);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("maxWorkerMinutes") && e.includes("--timeout-minutes")));
});
