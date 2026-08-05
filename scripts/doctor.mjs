import path from "node:path";
import process from "node:process";
import { loadConfig } from "./config.mjs";
import { TAMPERCHECK_PINNED_VERSION } from "./onboard.mjs";
import { probeCli, probeMessagesEndpoint, probeRepoGovernance, probeSkillParity } from "./probes.mjs";

/**
 * Doctor: probe every capability the factory depends on and report only what
 * was actually observed. PASS / FAIL / SKIPPED per check, never inferred.
 *
 * Exit semantics: doctor is a diagnostic, not a gate. Exit 0 means the
 * assessment COMPLETED (even with FAILs in it); exit 2 means doctor itself
 * could not run. A crashed assessment must never be mistaken for a clean one.
 */
export async function runDoctor({ config, probeTimeoutMs = 45_000, repository = null } = {}) {
  const checks = [];

  for (const [name, cli] of Object.entries(config.clis)) {
    checks.push(probeCli(`cli:${name}`, cli.command));
  }

  for (const [name, endpoint] of Object.entries(config.endpoints)) {
    checks.push(await probeMessagesEndpoint(`http:${name}`, endpoint.baseUrl, { timeoutMs: probeTimeoutMs }));
  }

  checks.push(probeCli("rigor:tampercheck", config.rigor.tampercheckCommand));
  checks.push(probeSkillParity("rigor:skill-parity", config.rigor.skillHosts, config.rigor.skillName));

  // Only in scope when a target repository was named: doctor's no-repo
  // behavior must stay exactly as it was before onboarding existed.
  if (repository) {
    checks.push(probeRepoGovernance("repo:governance", repository, { pinnedVersion: TAMPERCHECK_PINNED_VERSION }));
  }

  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { generatedAt: new Date().toISOString(), counts, checks };
}

export function renderDoctorReport(report) {
  const lines = ["DevHarmonics doctor", ""];
  const width = Math.max(...report.checks.map((c) => c.id.length));
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(7)} ${check.id.padEnd(width)}  ${check.detail}`);
  }
  lines.push("", `${report.counts.PASS} PASS, ${report.counts.FAIL} FAIL, ${report.counts.SKIPPED} SKIPPED`);
  return lines.join("\n");
}

export async function doctorCommand(argv) {
  let configPath = null;
  let asJson = false;
  let repository = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") asJson = true;
    else if (argv[i] === "--config") { configPath = argv[i + 1]; i += 1; }
    else if (argv[i] === "--repository") { repository = argv[i + 1]; i += 1; }
    else throw new Error(`Unknown doctor option: ${argv[i]}`);
  }
  const { config, source } = loadConfig(configPath);
  const report = await runDoctor({ config, repository: repository ? path.resolve(repository) : null });
  report.configSource = source;
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctorReport(report)}\n(config: ${source})\n`);
  return 0;
}
