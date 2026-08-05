import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderDoctorReport, runDoctor } from "../scripts/doctor.mjs";

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
  assert.equal(report.checks.length, 4);
  // 3 genuine capability failures (a missing CLI, a dead endpoint, absent
  // tampercheck) + 1 SKIPPED: skill-parity has nothing to compare and blocks no
  // command, so it is no longer scored as a capability failure (owner call,
  // 2026-08-05). Drift between installed hosts still FAILs.
  assert.equal(report.counts.FAIL, 3);
  assert.equal(report.counts.SKIPPED, 1);
  assert.equal(report.counts.PASS + report.counts.FAIL + report.counts.SKIPPED, report.checks.length);
  const rendered = renderDoctorReport(report);
  assert.match(rendered, /FAIL\s+cli:ghost/);
  assert.match(rendered, /FAIL\s+http:deadend/);
  assert.match(rendered, /3 FAIL/);
  assert.match(rendered, /SKIPPED\s+rigor:skill-parity/);
});

test("cli doctor exits 0 when the assessment completes, even full of FAILs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-doctor-"));
  try {
    const file = path.join(dir, "dead.json");
    // A4-7 (audit): a --config file is DEEP-MERGED over the defaults, so a file
    // that only adds "deadend"/"ghost" still leaves the three default endpoints
    // and three default CLIs in the merged config — and this test then probed
    // the live Ollama/LM Studio/LiteLLM ports and ran the real CLIs' --version,
    // taking most of a minute and flaking with the machine's load. Every default
    // target is explicitly deadened here so the merged config is fully inert.
    const dead = { baseUrl: "http://127.0.0.1:1" };
    const ghost = { command: "definitely-not-installed-tool" };
    writeFileSync(file, JSON.stringify({
      endpoints: { ollama: dead, lmstudio: dead, litellm: dead, deadend: dead },
      clis: { codex: ghost, claude: ghost, agy: ghost, ghost },
      rigor: {
        tampercheckCommand: "definitely-not-installed-tampercheck",
        skillHosts: { claude: path.join(dir, "none"), codex: path.join(dir, "nada") },
      },
    }));
    const run = spawnSync(process.execPath, [CLI, "doctor", "--json", "--config", file], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.counts.FAIL >= 3, true);
    assert.ok(report.checks.every((c) => ["PASS", "FAIL", "SKIPPED"].includes(c.status)));
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
