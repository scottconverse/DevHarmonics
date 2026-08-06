import path from "node:path";
import process from "node:process";
import { loadConfig } from "./config.mjs";
import { TAMPERCHECK_PINNED_VERSION } from "./onboard.mjs";
import { PROVIDER_AUTH, probeCli, probeMessagesEndpoint, probePaidBudget, probeProviderAuth, probeRepoGovernance, probeSkillParity } from "./probes.mjs";

/**
 * Doctor: probe every capability the factory depends on and report only what
 * was actually observed. PASS / FAIL / SKIPPED per check, never inferred.
 *
 * Exit semantics: doctor is a diagnostic, not a gate. Exit 0 means the
 * assessment COMPLETED (even with FAILs in it); exit 2 means doctor itself
 * could not run. A crashed assessment must never be mistaken for a clean one.
 */
export async function runDoctor({ config, probeTimeoutMs = 45_000, repository = null, onProgress = null, env = process.env, credentialStore = undefined } = {}) {
  // v1 port (d): the paid row can check stored-credential PRESENCE (never the
  // value). The real store is only constructed when some endpoint names one,
  // so a default keyless config touches nothing under the home directory.
  const resolveStore = async () => (credentialStore !== undefined
    ? credentialStore
    : (await import("./credential-store.mjs")).createCredentialStore());
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

  // Provider sign-in (ported from v1): "installed" and "signed in" are
  // different questions, and only the second one means work can actually run.
  // Asked with credentials stripped, so an API key in the environment cannot
  // make a signed-OUT subscription look signed in.
  const authChecks = Object.entries(config.clis)
    .filter(([name]) => PROVIDER_AUTH[name])
    .map(([name, cli]) => report(probeProviderAuth(`auth:${name}`, name, cli.command, { env, timeoutMs: probeTimeoutMs })));
  const endpointChecks = await Promise.all(endpointPromises);

  const checks = [
    ...cliChecks,
    ...authChecks,
    ...endpointChecks,
    // sha256 so an operator who wants the pin (`run`/`set` --tampercheck-sha256)
    // sees the exact value to copy, fingerprinted from the binary that answered.
    report(probeCli("rigor:tampercheck", config.rigor.tampercheckCommand, { sha256: true })),
    report(probeSkillParity("rigor:skill-parity", config.rigor.skillHosts, config.rigor.skillName)),
  ];

  // Paid-setup rows (v1 port (c)): one per credentialed endpoint, and only
  // then — a default keyless setup gets zero extra noise. Catches "the env
  // var isn't set" and "no paid budget configured" here, in the diagnostic,
  // instead of in a refused run.
  for (const [name, endpoint] of Object.entries(config.endpoints)) {
    if (endpoint?.apiKeyEnvVar || endpoint?.credential) {
      checks.push(report(probePaidBudget(`paid:${name}`, name, endpoint, config.budgets, env, { credentialStore: await resolveStore() })));
    }
  }

  // DOC-002 (audit): the probe itself has an honest SKIPPED branch for a null
  // repository — surface it instead of omitting the row, so the report shows
  // "repo:governance SKIPPED — no repository in scope" exactly as the manual
  // describes, rather than a silently absent line.
  checks.push(report(probeRepoGovernance("repo:governance", repository ?? null, { pinnedVersion: TAMPERCHECK_PINNED_VERSION })));

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
  const { config, source, created } = loadConfig(configPath, { projectPath: process.cwd() });
  // Progress rides stderr so it never pollutes --json's stdout: each check
  // prints the moment it completes, so a slow probe reads as "still working
  // on the others", never as a frozen command.
  const report = await runDoctor({
    config,
    repository: repository ? path.resolve(repository) : null,
    onProgress: (check) => process.stderr.write(`probe ${check.status.padEnd(7)} ${check.id}\n`),
  });
  report.configSource = source;
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctorReport(report)}\n(config: ${source}${created ? " — created now with the defaults" : ""})\n`);
  return 0;
}
