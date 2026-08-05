import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeCli, probeMessagesEndpoint, probeSkillParity } from "../scripts/probes.mjs";

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "dh-probes-"));
}

function fakeVersionTool(dir, name, versionLine) {
  if (process.platform === "win32") {
    const file = path.join(dir, `${name}.cmd`);
    writeFileSync(file, `@echo off\r\necho ${versionLine}\r\nexit /b 0\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${versionLine}"\nexit 0\n`);
  chmodSync(file, 0o755);
  return file;
}

test("probeCli reports FAIL, not PASS, for a command that is nowhere on PATH", () => {
  const dir = tempDir();
  try {
    const result = probeCli("cli:ghost", "ghost-tool", { env: { PATH: dir, PATHEXT: ".CMD" } });
    assert.equal(result.status, "FAIL");
    assert.match(result.detail, /not found on PATH/);
    assert.equal(result.version, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeCli PASSes only by actually executing --version", () => {
  const dir = tempDir();
  try {
    fakeVersionTool(dir, "faketool", "faketool 9.9.9");
    const result = probeCli("cli:faketool", "faketool", { env: { ...process.env, PATH: dir, PATHEXT: ".CMD" } });
    assert.equal(result.status, "PASS", result.detail);
    assert.match(result.version, /9\.9\.9/);
    assert.equal(result.sha256, undefined, "the fingerprint is opt-in, not a default cost on every CLI probe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeCli sha256 option fingerprints the exact resolved binary — the value an operator pins with", () => {
  const dir = tempDir();
  try {
    const file = fakeVersionTool(dir, "faketool", "faketool 9.9.9");
    const expected = createHash("sha256").update(readFileSync(file)).digest("hex");
    const result = probeCli("rigor:tampercheck", "faketool", { env: { ...process.env, PATH: dir, PATHEXT: ".CMD" }, sha256: true });
    assert.equal(result.status, "PASS", result.detail);
    assert.equal(result.sha256, expected);
    assert.ok(result.detail.includes(expected), "the digest must be visible in the printed detail, not only in JSON");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("probeMessagesEndpoint PASSes on a real, well-formed Messages exchange", async () => {
  const result = await withServer((request, response) => {
    if (request.url === "/api/tags") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "fake-model:1b" }] }));
      return;
    }
    if (request.url === "/v1/messages" && request.method === "POST") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 2 } }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  }, (baseUrl) => probeMessagesEndpoint("http:fake", baseUrl, { timeoutMs: 5_000, discoveryTimeoutMs: 2_000 }));
  assert.equal(result.status, "PASS", result.detail);
  assert.equal(result.model, "fake-model:1b");
});

test("a reachable endpoint with no available model is FAIL with the reason, never PASS", async () => {
  const result = await withServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [] }));
    if (request.url === "/v1/models") return response.end(JSON.stringify({ data: [] }));
    response.statusCode = 404;
    response.end("{}");
  }, (baseUrl) => probeMessagesEndpoint("http:fake", baseUrl, { timeoutMs: 5_000, discoveryTimeoutMs: 2_000 }));
  assert.equal(result.status, "FAIL");
  assert.match(result.detail, /did not list any available model/);
});

test("a server error on the Messages call is FAIL carrying the HTTP evidence", async () => {
  const result = await withServer((request, response) => {
    if (request.url === "/api/tags") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ models: [{ name: "fake-model:1b" }] }));
    }
    response.statusCode = 500;
    response.end("boom");
  }, (baseUrl) => probeMessagesEndpoint("http:fake", baseUrl, { timeoutMs: 5_000, discoveryTimeoutMs: 2_000 }));
  assert.equal(result.status, "FAIL");
  assert.match(result.detail, /HTTP 500/);
});

test("a dead port is FAIL, not an exception and not SKIPPED", async () => {
  const result = await probeMessagesEndpoint("http:dead", "http://127.0.0.1:1", { timeoutMs: 3_000, discoveryTimeoutMs: 1_500 });
  assert.equal(result.status, "FAIL");
});

function hostWithSkill(version) {
  const root = tempDir();
  const skillDir = path.join(root, "dev-rigor-stack-lite");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), `# Standing dev rigor stack Lite v${version}\n`);
  return root;
}

test("skill parity PASSes only when every present host agrees on a parseable version", () => {
  const a = hostWithSkill("0.7.0");
  const b = hostWithSkill("0.7.0");
  try {
    const equal = probeSkillParity("rigor:skill-parity", { claude: a, codex: b }, "dev-rigor-stack-lite");
    assert.equal(equal.status, "PASS", equal.detail);
    assert.match(equal.detail, /v0\.7\.0/);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("skill parity FAILs on a version mismatch, naming both sides", () => {
  const a = hostWithSkill("0.7.0");
  const b = hostWithSkill("0.5.1");
  try {
    const result = probeSkillParity("rigor:skill-parity", { claude: a, codex: b }, "dev-rigor-stack-lite");
    assert.equal(result.status, "FAIL");
    assert.match(result.detail, /claude=v0\.7\.0/);
    assert.match(result.detail, /codex=v0\.5\.1/);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("skill parity with a single present host is PASS with the absence disclosed", () => {
  const a = hostWithSkill("0.7.0");
  try {
    const result = probeSkillParity("rigor:skill-parity", { claude: a, codex: "Z:/absent" }, "dev-rigor-stack-lite");
    assert.equal(result.status, "PASS");
    assert.match(result.detail, /absent on: codex/);
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test("skill parity with no installed hosts is SKIPPED, not FAIL — absence blocks nothing", () => {
  // Changed deliberately (2026-08-05, owner call). These skills are markdown
  // discipline for whichever agent app drives DevHarmonics; NO command reads them at
  // runtime, so their absence cannot break anything. Scoring it FAIL told every
  // fresh installer their install was broken — the same category error as failing
  // the repo-governance probe when no repository is in scope. DRIFT between hosts is
  // the real bug class, and that still FAILs (see the next test).
  const result = probeSkillParity("rigor:skill-parity", { claude: "Z:/none", codex: "Z:/nada" }, "dev-rigor-stack-lite");
  assert.equal(result.status, "SKIPPED");
  assert.match(result.detail, /not installed under any/);
  assert.match(result.detail, /never read at runtime/, "must say why it is not a failure");
});
