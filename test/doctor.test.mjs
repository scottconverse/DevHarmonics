import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderDoctorReport, runDoctor } from "../scripts/doctor.mjs";
import { defaultConfig } from "../scripts/config.mjs";
import { PROVIDER_AUTH } from "../scripts/probes.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");

function fixtureConfig() {
  // Everything points at guaranteed-dead targets: doctor must COMPLETE the
  // assessment and report FAILs, never crash and never invent a PASS.
  //
  // A4-7 (audit): built from scratch, NOT from defaultConfig() — starting from
  // the defaults meant any probe-relevant field this fixture forgot to replace
  // silently probed this machine's live endpoints and real CLIs, which is
  // exactly the environment-sensitivity that made these tests flake under load.
  return {
    version: 1,
    endpoints: { deadend: { baseUrl: "http://127.0.0.1:1" } },
    clis: { ghost: { command: "definitely-not-installed-tool" } },
    rigor: {
      tampercheckCommand: "definitely-not-installed-tampercheck",
      skillHosts: { claude: "Z:/none", codex: "Z:/nada" },
      skillName: "dev-rigor-stack-lite",
    },
    budgets: { maxWorkers: 100, maxConcurrentWorkers: 3, maxTotalTokens: 50_000_000, windowHours: 24 },
  };
}

test("doctor completes an all-dead assessment: operational checks FAIL, advisory skill-parity is SKIPPED, and the counts add up", async () => {
  const report = await runDoctor({ config: fixtureConfig(), probeTimeoutMs: 3_000 });
  assert.equal(report.checks.length, 5);
  // 3 genuine capability failures (a missing CLI, a dead endpoint, absent
  // tampercheck) + 2 SKIPPED: skill-parity has nothing to compare and blocks no
  // command (owner call, 2026-08-05), and — DOC-002 — repo:governance with no
  // --repository in scope now appears as an honest SKIPPED row instead of
  // silently vanishing from the report. Drift between installed hosts still FAILs.
  assert.equal(report.counts.FAIL, 3);
  assert.equal(report.counts.SKIPPED, 2);
  assert.equal(report.counts.PASS + report.counts.FAIL + report.counts.SKIPPED, report.checks.length);
  const rendered = renderDoctorReport(report);
  assert.match(rendered, /FAIL\s+cli:ghost/);
  assert.match(rendered, /FAIL\s+http:deadend/);
  assert.match(rendered, /3 FAIL/);
  assert.match(rendered, /SKIPPED\s+rigor:skill-parity/);
  assert.match(rendered, /SKIPPED\s+repo:governance\s+no repository in scope/);
});

test("cli doctor exits 0 when the assessment completes, even full of FAILs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-doctor-"));
  try {
    const file = path.join(dir, "dead.json");
    // A4-7 (audit): a --config file is DEEP-MERGED over the defaults, so a file
    // that only adds "deadend"/"ghost" still leaves the default endpoints and
    // CLIs in the merged config — and this test then probed the live ports and
    // ran the real CLIs' --version, taking most of a minute and flaking with
    // the machine's load. TEST-007: the dead config is built STRUCTURALLY from
    // defaultConfig()'s own keys, so a future default added to config.mjs can
    // never silently resurrect live probing here.
    const defaults = defaultConfig();
    const dead = { baseUrl: "http://127.0.0.1:1" };
    const ghost = { command: "definitely-not-installed-tool" };
    const deadEndpoints = Object.fromEntries(Object.keys(defaults.endpoints).map((k) => [k, dead]));
    const deadClis = Object.fromEntries(Object.keys(defaults.clis).map((k) => [k, ghost]));
    writeFileSync(file, JSON.stringify({
      endpoints: { ...deadEndpoints, deadend: dead },
      clis: { ...deadClis, ghost },
      rigor: {
        tampercheckCommand: "definitely-not-installed-tampercheck",
        skillHosts: { claude: path.join(dir, "none"), codex: path.join(dir, "nada") },
      },
    }));
    // endpoints+deadend, clis+ghost, one sign-in row per KNOWN provider CLI,
    // tampercheck+parity+governance. Derived structurally so a new default
    // cannot silently widen this test back into live probing (TEST-007).
    const knownProviders = Object.keys(deadClis).filter((name) => PROVIDER_AUTH[name]).length;
    const expectedChecks = Object.keys(deadEndpoints).length + 1 + Object.keys(deadClis).length + 1 + knownProviders + 3;
    const run = spawnSync(process.execPath, [CLI, "doctor", "--json", "--config", file], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.counts.FAIL >= 3, true);
    assert.ok(report.checks.every((c) => ["PASS", "FAIL", "SKIPPED"].includes(c.status)));
    // TEST-007: pin the exact probe count so an added default cannot silently
    // widen this test back into live probing, and assert nothing PASSed —
    // every target in the merged config is dead by construction.
    assert.equal(report.checks.length, expectedChecks, JSON.stringify(report.checks.map((c) => c.id)));
    assert.equal(report.counts.PASS, 0, "a fully-deadened config must have zero passing probes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli doctor exits 2 when doctor itself cannot run — never mistakable for a clean result", () => {
  const badFlag = spawnSync(process.execPath, [CLI, "doctor", "--nonsense"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /Unknown doctor option/);

  const badConfig = spawnSync(process.execPath, [CLI, "doctor", "--config", "Z:/missing.json"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(badConfig.status, 2);
  assert.match(badConfig.stderr, /not found/);
});

test("cli with an unknown command exits 2 with usage", () => {
  const run = spawnSync(process.execPath, [CLI, "frobnicate"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Unknown command/);
});

// --- v1 port (c): the paid-setup check catches misconfiguration in the
// diagnostic, not in a refused run --------------------------------------------

function paidFixtureConfig() {
  const config = fixtureConfig();
  config.endpoints = { anthropic: { baseUrl: "http://127.0.0.1:1", apiKeyEnvVar: "DH_TEST_PAID_KEY" } };
  return config;
}

test("paid rows appear ONLY for credentialed endpoints, and name each failure's remedy in plain language", async () => {
  // No credentialed endpoints (the base fixture): zero paid rows.
  const noneReport = await runDoctor({ config: fixtureConfig(), probeTimeoutMs: 3_000, env: {} });
  assert.equal(noneReport.checks.some((c) => c.id.startsWith("paid:")), false);

  // Credentialed, env var NOT set: FAIL telling you to set it.
  const unsetReport = await runDoctor({ config: paidFixtureConfig(), probeTimeoutMs: 3_000, env: {} });
  const unset = unsetReport.checks.find((c) => c.id === "paid:anthropic");
  assert.equal(unset?.status, "FAIL");
  assert.match(unset.detail, /DH_TEST_PAID_KEY is not set/);
  assert.match(unset.detail, /Set DH_TEST_PAID_KEY/);

  // Env var set, NO budget: FAIL telling you every call will refuse.
  const noBudgetConfig = paidFixtureConfig();
  delete noBudgetConfig.budgets.maxPaidTokens;
  const noBudgetReport = await runDoctor({ config: noBudgetConfig, probeTimeoutMs: 3_000, env: { DH_TEST_PAID_KEY: "sk-x" } });
  const noBudget = noBudgetReport.checks.find((c) => c.id === "paid:anthropic");
  assert.equal(noBudget?.status, "FAIL");
  assert.match(noBudget.detail, /budgets\.maxPaidTokens is not configured/);
  assert.match(noBudget.detail, /every paid call will refuse/);

  // Env var + budget set but the master switch OFF: FAIL naming the double opt-in.
  const noSwitchConfig = paidFixtureConfig();
  noSwitchConfig.budgets.maxPaidTokens = 2_000_000;
  const noSwitchReport = await runDoctor({ config: noSwitchConfig, probeTimeoutMs: 3_000, env: { DH_TEST_PAID_KEY: "sk-x" } });
  const noSwitch = noSwitchReport.checks.find((c) => c.id === "paid:anthropic");
  assert.equal(noSwitch?.status, "FAIL");
  assert.match(noSwitch.detail, /allowPaidApi is not true/);
  assert.match(noSwitch.detail, /double opt-in/);

  // Everything configured: PASS with the ceiling stated in tokens AND a labeled dollar estimate.
  const okConfig = paidFixtureConfig();
  okConfig.budgets.maxPaidTokens = 2_000_000;
  okConfig.budgets.allowPaidApi = true;
  const okReport = await runDoctor({ config: okConfig, probeTimeoutMs: 3_000, env: { DH_TEST_PAID_KEY: "sk-x" } });
  const ok = okReport.checks.find((c) => c.id === "paid:anthropic");
  assert.equal(ok?.status, "PASS", ok?.detail);
  assert.match(ok.detail, /2,000,000 tokens/);
  assert.match(ok.detail, /estimate, not the enforced unit/);

  // With the USD pair configured too, the PASS row states both ceilings.
  const usdConfig = paidFixtureConfig();
  usdConfig.budgets.maxPaidTokens = 2_000_000;
  usdConfig.budgets.allowPaidApi = true;
  usdConfig.budgets.perRunLimitUsd = 5;
  usdConfig.budgets.monthlyLimitUsd = 100;
  const usdReport = await runDoctor({ config: usdConfig, probeTimeoutMs: 3_000, env: { DH_TEST_PAID_KEY: "sk-x" } });
  const usd = usdReport.checks.find((c) => c.id === "paid:anthropic");
  assert.equal(usd?.status, "PASS", usd?.detail);
  assert.match(usd.detail, /\$5\/run/);
  assert.match(usd.detail, /\$100\/30 days/);
  assert.match(usd.detail, /report real cost/);
});

test("v1 port (d): a stored-credential endpoint gets the same paid row — not-stored FAIL names the exact command; stored + opted-in PASSes", async () => {
  const config = fixtureConfig();
  config.endpoints = { anthropic: { baseUrl: "http://127.0.0.1:1", credential: "anthropic" } };
  config.budgets.maxPaidTokens = 2_000_000;
  config.budgets.allowPaidApi = true;

  const notStored = await runDoctor({ config, probeTimeoutMs: 3_000, env: {}, credentialStore: { has: () => false } });
  const missing = notStored.checks.find((c) => c.id === "paid:anthropic");
  assert.equal(missing?.status, "FAIL");
  assert.match(missing.detail, /not in the credential store/);
  assert.match(missing.detail, /devharmonics credential set anthropic/);

  const stored = await runDoctor({ config, probeTimeoutMs: 3_000, env: {}, credentialStore: { has: () => true } });
  const ok = stored.checks.find((c) => c.id === "paid:anthropic");
  assert.equal(ok?.status, "PASS", ok?.detail);
  assert.match(ok.detail, /stored credential "anthropic" present/);
  assert.match(ok.detail, /2,000,000 tokens/);
});
