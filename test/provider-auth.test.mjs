import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROVIDER_AUTH, probeProviderAuth, safeSummaryLine } from "../scripts/probes.mjs";
import { runDoctor } from "../scripts/doctor.mjs";

const IS_WINDOWS = process.platform === "win32";

/** A real executable that prints what we tell it and exits with the code we choose. */
function fakeCli(t, name, { stdout = "", exitCode = 0 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, IS_WINDOWS ? `${name}.cmd` : name);
  const body = IS_WINDOWS
    ? `@echo off\r\n${stdout ? `echo ${stdout}\r\n` : ""}exit /b ${exitCode}\r\n`
    : `#!/bin/sh\n${stdout ? `echo "${stdout}"\n` : ""}exit ${exitCode}\n`;
  writeFileSync(file, body);
  if (!IS_WINDOWS) chmodSync(file, 0o755);
  return { dir, env: { ...process.env, PATH: dir, Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } };
}

test("a signed-in provider PASSes and reports the account line it printed", (t) => {
  const { env } = fakeCli(t, "claude", { stdout: "Login method: Claude Max account", exitCode: 0 });
  const result = probeProviderAuth("auth:claude", "claude", "claude", { env, timeoutMs: 10_000 });
  assert.equal(result.status, "PASS", result.detail);
  assert.match(result.detail, /Claude: signed in/);
  assert.match(result.detail, /Claude Max account/);
});

test("a signed-OUT provider FAILs and names the command the OWNER runs — never asking for a password", (t) => {
  const { env } = fakeCli(t, "codex", { stdout: "Not logged in", exitCode: 1 });
  const result = probeProviderAuth("auth:codex", "codex", "codex", { env, timeoutMs: 10_000 });
  assert.equal(result.status, "FAIL");
  assert.match(result.detail, /not signed in/);
  assert.match(result.detail, /codex login/);
  assert.match(result.detail, /never asks for, sees, or stores your password/);
  assert.ok(Array.isArray(result.steps) && result.steps.length >= 3, "setup steps travel with the failure");
});

test("a provider that exits 0 while SAYING it is signed out is still reported as signed out", (t) => {
  // Adversarial review: exit status alone was the signal, so a CLI that returns
  // success while printing "not signed in" would have read as ready.
  const { env } = fakeCli(t, "codex", { stdout: "Not signed in - run codex login", exitCode: 0 });
  const result = probeProviderAuth("auth:codex", "codex", "codex", { env, timeoutMs: 10_000 });
  assert.equal(result.status, "FAIL", "ambiguity must resolve toward NOT signed in");
});

test("a provider that isn't installed is SKIPPED, not FAILed — the cli: row already says it's missing", () => {
  const result = probeProviderAuth("auth:claude", "claude", "definitely-not-installed-anywhere", { env: { PATH: "" }, timeoutMs: 5_000 });
  assert.equal(result.status, "SKIPPED");
  assert.match(result.detail, /not installed/);
});

test("provider output is REDACTED before it is reported — a report is never worth a leaked credential", () => {
  assert.match(safeSummaryLine("Authenticated with sk-ant-api03-abcdefghijklmnop"), /\[redacted\]/);
  assert.ok(!safeSummaryLine("Authenticated with sk-ant-api03-abcdefghijklmnop").includes("abcdefghij"));
  assert.match(safeSummaryLine("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), /\[redacted\]/);
  assert.match(safeSummaryLine("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaaaaaaaaaaa"), /\[redacted\]/);
  // A long opaque blob with no keyword at all is still redacted on shape.
  assert.match(safeSummaryLine("session AbCdEf0123456789AbCdEf0123456789AbCdEf"), /\[redacted\]/);
  // Benign lines survive intact.
  assert.equal(safeSummaryLine("Login method: Claude Max account"), "Login method: Claude Max account");
  // And nothing unbounded ever reaches a report.
  assert.ok(safeSummaryLine("x".repeat(500)).length <= 120);
});

test("a token-shaped line cannot reach the probe's reported detail or account field", (t) => {
  const { env } = fakeCli(t, "claude", { stdout: "session sk-ant-SUPERSECRETVALUE123456", exitCode: 0 });
  const result = probeProviderAuth("auth:claude", "claude", "claude", { env, timeoutMs: 10_000 });
  assert.ok(!result.detail.includes("SUPERSECRETVALUE"), "the secret must never appear in the report");
  assert.ok(!(result.account ?? "").includes("SUPERSECRETVALUE"));
});

test("doctor adds one auth row per KNOWN provider and none for unknown tools", async () => {
  const config = {
    version: 1,
    endpoints: {},
    clis: { ghost: { command: "definitely-not-installed-tool" } },
    rigor: { tampercheckCommand: "definitely-not-installed", skillHosts: { claude: "Z:/none" }, skillName: "dev-rigor-stack-lite" },
    budgets: { maxWorkers: 100, maxConcurrentWorkers: 3, maxTotalTokens: 50_000_000, windowHours: 24 },
  };
  const noneReport = await runDoctor({ config, probeTimeoutMs: 3_000, env: {} });
  assert.equal(noneReport.checks.some((c) => c.id.startsWith("auth:")), false, "an unknown tool gets no sign-in row");

  const known = { ...config, clis: { claude: { command: "definitely-not-installed-tool" } } };
  const knownReport = await runDoctor({ config: known, probeTimeoutMs: 3_000, env: {} });
  const row = knownReport.checks.find((c) => c.id === "auth:claude");
  assert.ok(row, "a known provider gets a sign-in row");
  assert.equal(row.status, "SKIPPED");
});

test("every known provider carries a login command and real setup steps", () => {
  for (const [name, spec] of Object.entries(PROVIDER_AUTH)) {
    assert.ok(spec.loginCommand, `${name} needs a login command`);
    assert.ok(spec.steps.length >= 3, `${name} needs setup steps`);
    assert.ok(spec.label, `${name} needs a human label`);
  }
  // The Antigravity one-time-code warning is security guidance worth pinning:
  // the code goes to Antigravity's own prompt, never into DevHarmonics or chat.
  assert.match(PROVIDER_AUTH.agy.steps.join(" "), /NEVER paste it into DevHarmonics/);
});
