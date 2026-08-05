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
export async function runDoctor({ config, probeTimeoutMs = 45_000, repository = null, onProgress = null } = {}) {
  const report = (check) => {
    try { onProgress?.(check); } catch { /* a progress listener never breaks the assessment */ }
    return check;
  };

  // A4-7 (audit): the endpoint probes used to be awaited one at a time, so a
  // 3-endpoint doctor run cost the SUM of its probe times (worst case the sum
  // of its timeouts) and looked frozen while doing it. The network probes are
  // independent — start them all first, concurrently, so the run costs roughly
  // the slowest probe instead. The CLI probes are bounded synchronous child
  // processes (real --version runs); they execute while the network waits.
  const endpointPromises = Object.entries(config.endpoints).map(([name, endpoint]) =>
    probeMessagesEndpoint(`http:${name}`, endpoint.baseUrl, { timeoutMs: probeTimeoutMs }).then(report),
  );

  const cliChecks = Object.entries(config.clis).map(([name, cli]) => report(probeCli(`cli:${name}`, cli.command)));
  const endpointChecks = await Promise.all(endpointPromises);

  const checks = [
    ...cliChecks,
    ...endpointChecks,
    report(probeCli("rigor:tampercheck", config.rigor.tampercheckCommand)),
    report(probeSkillParity("rigor:skill-parity", config.rigor.skillHosts, config.rigor.skillName)),
  ];

  // Only in scope when a target repository was named: doctor's no-repo
  // behavior must stay exactly as it was before onboarding existed.
  if (repository) {
    checks.push(report(probeRepoGovernance("repo:governance", repository, { pinnedVersion: TAMPERCHECK_PINNED_VERSION })));
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
  // Progress rides stderr so it never pollutes --json's stdout: each check
  // prints the moment it completes, so a slow probe reads as "still working
  // on the others", never as a frozen command.
  const report = await runDoctor({
    config,
    repository: repository ? path.resolve(repository) : null,
    onProgress: (check) => process.stderr.write(`probe ${check.status.padEnd(7)} ${check.id}\n`),
  });
  report.configSource = source;
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctorReport(report)}\n(config: ${source})\n`);
  return 0;
}
