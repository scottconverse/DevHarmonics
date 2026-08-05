import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// --- v1 port (a): self-initializing project-scoped config -------------------

import { initializeProjectConfig, projectConfigPath } from "../scripts/config.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");

test("initializeProjectConfig materializes the defaults once and never overwrites an edited file", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dh-cfg-init-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const first = initializeProjectConfig(repo);
  assert.equal(first.created, true);
  assert.equal(first.path, projectConfigPath(repo));
  const onDisk = JSON.parse(readFileSync(first.path, "utf8"));
  assert.equal(onDisk.budgets.maxWorkers, defaultConfig().budgets.maxWorkers, "seeded from the defaults");
  assert.ok(Array.isArray(onDisk._readme), "the seeded file explains itself");

  // Operator edits survive: a second initialize NEVER overwrites.
  onDisk.budgets.maxWorkers = 7;
  writeFileSync(first.path, JSON.stringify(onDisk, null, 2));
  const second = initializeProjectConfig(repo);
  assert.equal(second.created, false);
  assert.equal(JSON.parse(readFileSync(first.path, "utf8")).budgets.maxWorkers, 7);
});

test("loadConfig precedence: explicit --config beats the project config, which beats the defaults", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dh-cfg-prec-"));
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-cfg-explicit-"));
  t.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });

  // No project config yet: loading with projectPath CREATES it and announces so.
  const auto = loadConfig(null, { projectPath: repo });
  assert.equal(auto.created, true);
  assert.equal(auto.source, projectConfigPath(repo));
  assert.equal(auto.config.budgets.maxWorkers, defaultConfig().budgets.maxWorkers);

  // Edit the project config; the edit is what loads next time (created: false).
  const projectFile = projectConfigPath(repo);
  const edited = JSON.parse(readFileSync(projectFile, "utf8"));
  edited.budgets.maxWorkers = 5;
  writeFileSync(projectFile, JSON.stringify(edited, null, 2));
  const fromProject = loadConfig(null, { projectPath: repo });
  assert.equal(fromProject.created, false);
  assert.equal(fromProject.config.budgets.maxWorkers, 5);

  // An explicit --config file wins over the project config.
  const explicitFile = path.join(dir, "explicit.json");
  writeFileSync(explicitFile, JSON.stringify({ budgets: { maxWorkers: 9 } }));
  const explicit = loadConfig(explicitFile, { projectPath: repo });
  assert.equal(explicit.config.budgets.maxWorkers, 9);
  assert.equal(explicit.source, path.resolve(explicitFile));
});

test("a nonexistent projectPath must NOT conjure directories — defaults load instead", () => {
  const ghost = path.join(os.tmpdir(), "dh-cfg-ghost-definitely-not-created");
  const result = loadConfig(null, { projectPath: ghost });
  assert.equal(result.source, "defaults");
  assert.equal(existsSync(ghost), false, "loading config must never create a mistyped project path");
});

test("an invalid PROJECT config fails loud with the file named — never a silent fallback to defaults", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dh-cfg-invalid-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  initializeProjectConfig(repo);
  const file = projectConfigPath(repo);
  const broken = JSON.parse(readFileSync(file, "utf8"));
  broken.budgets.maxWorkers = 0;
  writeFileSync(file, JSON.stringify(broken));
  let thrown = null;
  try { loadConfig(null, { projectPath: repo }); } catch (error) { thrown = error; }
  assert.ok(thrown, "an invalid project config must throw");
  assert.match(thrown.message, /maxWorkers must be a positive integer/);
  assert.ok(thrown.message.includes(file), "the error must name the offending file");
});

test("config show / config path work through the real CLI, announcing the source", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dh-cfg-show-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const shown = spawnSync(process.execPath, [CLI_PATH, "config", "show", "--json"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(shown.status, 0, shown.stderr);
  const parsed = JSON.parse(shown.stdout);
  assert.equal(parsed.created, true, "first touch materializes the file");
  assert.equal(parsed.configSource, projectConfigPath(repo));
  assert.equal(parsed.config.budgets.maxWorkers, defaultConfig().budgets.maxWorkers);

  const pathOut = spawnSync(process.execPath, [CLI_PATH, "config", "path"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(pathOut.status, 0);
  assert.equal(pathOut.stdout.trim(), projectConfigPath(repo));
});
