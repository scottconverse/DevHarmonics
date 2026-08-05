import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "./config.mjs";
import { QUALIFICATION_HARNESSES, discoverCandidates } from "./fleet.mjs";
import { probeCli } from "./probes.mjs";
import { executeQualification, planQualifications } from "./qualify.mjs";

/**
 * CLI surface for the qualification sweep (spec: "for each discovered
 * candidate x applicable role, run the REAL role harness and append the
 * result"). Dry-run by default; --execute actually runs harnesses,
 * SEQUENTIALLY — local models share one GPU and subscription CLIs should
 * not be stampeded concurrently.
 *
 * Exit semantics mirror doctorCommand/workerCommand: 0 means the sweep RAN
 * (dry or executed, failures included) — 2 means the runner itself could
 * not operate (bad flags, unreadable config). A crashed runner must never
 * look like a completed sweep.
 */

const DEFAULT_WORKER_MODELS = Object.freeze({
  codex: ["gpt-5.6-luna"],
  claude: ["sonnet"],
  agy: ["default"],
});

async function fetchJsonTolerant(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { ok: false, body: null, note: `HTTP ${response.status}` };
    let body;
    try {
      body = await response.json();
    } catch (error) {
      return { ok: false, body: null, note: `non-JSON response: ${error.message}` };
    }
    return { ok: true, body, note: null };
  } catch (error) {
    return { ok: false, body: null, note: `unreachable: ${error.message}` };
  }
}

/**
 * Discover the full candidate pool for a real sweep: fetch Ollama/LM Studio
 * discovery ourselves (fleet.discoverCandidates never fetches), resolve real
 * CLI --version strings via probes.probeCli, and fill in each CLI's
 * `workerModels` default when the config doesn't declare one. A down/absent
 * endpoint or CLI never throws here — it just contributes no candidates,
 * noted honestly for the operator.
 */
async function discoverAllCandidates(config, { fetchTimeoutMs = 3_000 } = {}) {
  const notes = [];

  let ollamaTags = null;
  const ollamaBaseUrl = config?.endpoints?.ollama?.baseUrl;
  if (ollamaBaseUrl) {
    const result = await fetchJsonTolerant(`${ollamaBaseUrl}/api/tags`, fetchTimeoutMs);
    if (result.ok) ollamaTags = result.body;
    else notes.push(`ollama endpoint (${ollamaBaseUrl}) ${result.note} — no http:ollama candidates`);
  } else {
    notes.push("no endpoints.ollama.baseUrl configured — no http:ollama candidates");
  }

  let lmstudioModels = null;
  const lmstudioBaseUrl = config?.endpoints?.lmstudio?.baseUrl;
  if (lmstudioBaseUrl) {
    const result = await fetchJsonTolerant(`${lmstudioBaseUrl}/v1/models`, fetchTimeoutMs);
    if (result.ok) lmstudioModels = result.body;
    else notes.push(`lmstudio endpoint (${lmstudioBaseUrl}) ${result.note} — no http:lmstudio candidates`);
  } else {
    notes.push("no endpoints.lmstudio.baseUrl configured — no http:lmstudio candidates");
  }

  const clis = {};
  const cliVersions = {};
  for (const name of ["codex", "claude", "agy"]) {
    const cli = config?.clis?.[name];
    if (!cli) continue;
    clis[name] = { ...cli, workerModels: cli.workerModels ?? DEFAULT_WORKER_MODELS[name] };
    const probe = probeCli(`cli:${name}`, cli.command);
    cliVersions[name] = probe.status === "PASS" ? probe.version : "unknown";
    if (probe.status !== "PASS") notes.push(`cli:${name} (${cli.command}) not runnable — subprocess candidates use runtimeVersion "unknown"`);
  }

  const candidates = discoverCandidates({ config: { ...config, clis }, ollamaTags, lmstudioModels, cliVersions });
  return { candidates, notes };
}

/** Filesystem-safe directory segment: candidate ids and models carry ":" and "." (illegal/awkward on Windows paths). */
function safeDirName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function renderPlanTable(plan) {
  if (plan.length === 0) return "(no candidate x role pairs to qualify)";
  const rows = plan.map((row) => ({
    candidate: row.candidate.id,
    role: row.role,
    harness: row.harness,
    status: row.alreadyCurrent ? "current" : "due",
  }));
  const width = (key, min) => Math.max(min, ...rows.map((r) => r[key].length));
  const widths = { candidate: width("candidate", 9), role: width("role", 4), harness: width("harness", 7) };
  return rows
    .map((r) => `${r.candidate.padEnd(widths.candidate)}  ${r.role.padEnd(widths.role)}  ${r.harness.padEnd(widths.harness)}  ${r.status}`)
    .join("\n");
}

function printDryRun(plan, notes, asJson, write) {
  if (asJson) {
    write(`${JSON.stringify({ mode: "dry-run", notes, plan }, null, 2)}\n`);
    return;
  }
  write("DevHarmonics qualification sweep (dry run)\n\n");
  for (const note of notes) write(`note: ${note}\n`);
  if (notes.length) write("\n");
  write(`${renderPlanTable(plan)}\n`);
  const due = plan.filter((row) => !row.alreadyCurrent).length;
  write(`\n${plan.length} planned, ${due} due, ${plan.length - due} already current\n`);
}

function printRowResult(row, result, write) {
  const status = result.passed ? "PASS" : "FAIL";
  write(`${status.padEnd(4)} ${row.candidate.id}  ${row.role}  ${result.detail}\n`);
}

function printExecuteSummary(rows, asJson, write) {
  const passCount = rows.filter((row) => row.result.passed).length;
  const failCount = rows.length - passCount;
  if (asJson) {
    write(`${JSON.stringify({
      mode: "execute",
      results: rows.map(({ candidate, role, harness, fingerprint, alreadyCurrent, result }) =>
        ({ candidate, role, harness, fingerprint, alreadyCurrent, result })),
      summary: { total: rows.length, pass: passCount, fail: failCount },
    }, null, 2)}\n`);
    return;
  }
  write(`\n${rows.length} run, ${passCount} PASS, ${failCount} FAIL\n`);
}

/**
 * `write` defaults to real stdout but is injectable — this is what lets a
 * test drive qualifyCommand's dry-run/execute output without monkey-patching
 * the process-global process.stdout.write, which collides with node:test's
 * own asynchronous TAP/spec reporter writes running in the same process.
 */
export async function qualifyCommand(argv, { write = (text) => { process.stdout.write(text); } } = {}) {
  const options = {
    execute: false,
    asJson: false,
    configPath: null,
    lane: null,
    candidateSubstring: null,
    role: null,
    skipCurrent: false,
    workRoot: null,
    stateRoot: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => { i += 1; return argv[i]; };
    switch (argv[i]) {
      case "--execute": options.execute = true; break;
      case "--json": options.asJson = true; break;
      case "--config": options.configPath = next(); break;
      case "--lane": options.lane = next(); break;
      case "--candidate": options.candidateSubstring = next(); break;
      case "--role": options.role = next(); break;
      case "--skip-current": options.skipCurrent = true; break;
      case "--work-root": options.workRoot = next(); break;
      case "--state-root": options.stateRoot = next(); break;
      default: throw new Error(`Unknown qualify option: ${argv[i]}`);
    }
  }
  if (options.lane !== null && !["subprocess", "http"].includes(options.lane)) {
    throw new Error('--lane must be "subprocess" or "http"');
  }
  if (options.role !== null && !(options.role in QUALIFICATION_HARNESSES)) {
    throw new Error(`--role must be one of ${Object.keys(QUALIFICATION_HARNESSES).join(", ")}`);
  }

  const { config, source: configSource } = loadConfig(options.configPath, { projectPath: process.cwd() });
  const stateRoot = path.resolve(options.stateRoot ?? path.join(process.cwd(), ".devharmonics"));
  const qualificationsPath = path.join(stateRoot, "qualifications.jsonl");
  // Qualification fixtures MUST live outside any enclosing git repository.
  // Found live 2026-08-04: fixtures under the coordinator repo's own
  // .devharmonics/ made codex's workspace-write sandbox REJECT file edits
  // (nested-git workspace) and made claude behave like a project session
  // ("I can see there's uncommitted work in this repo") instead of obeying
  // the one-shot prompt. The system temp dir reproduces the conditions the
  // live-fire proved: standalone scratch repos, no enclosing project.
  const workRoot = path.resolve(options.workRoot ?? path.join(os.tmpdir(), "devharmonics-qualify"));

  const { candidates, notes } = await discoverAllCandidates(config);
  const filtered = candidates.filter((candidate) => {
    if (options.lane && candidate.lane !== options.lane) return false;
    if (options.candidateSubstring && !candidate.id.includes(options.candidateSubstring)) return false;
    return true;
  });

  let plan = planQualifications({
    candidates: filtered,
    roles: options.role ? [options.role] : null,
    qualificationsPath,
  });
  if (options.skipCurrent) plan = plan.filter((row) => !row.alreadyCurrent);

  if (!options.execute) {
    printDryRun(plan, notes, options.asJson, write);
    return 0;
  }

  const rows = [];
  for (const row of plan) {
    const result = await executeQualification({
      candidate: row.candidate,
      role: row.role,
      workRoot: path.join(workRoot, safeDirName(row.candidate.id), safeDirName(row.role)),
      qualificationsPath,
      // D1: the whole sweep meters against the qualify state root, with the
      // budgets from this command's (possibly --config-overridden) config.
      admission: { stateRoot, budgets: config.budgets },
    });
    rows.push({ ...row, result });
    if (!options.asJson) printRowResult(row, result, write);
    // ENG-004 (audit): a fan-out ceiling tripping mid-sweep is an
    // infrastructure stop, not a string of capability failures — abort the
    // sweep honestly instead of recording refusals against every remaining
    // candidate.
    if (result.infrastructureRefused) {
      const remaining = plan.length - rows.length;
      write(`\nsweep ABORTED: ${result.infrastructureRefused}\n${remaining} candidate/role pair(s) left unassessed — nothing was recorded against them.\n`);
      break;
    }
  }
  printExecuteSummary(rows, options.asJson, write);
  return 0;
}
