import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { planIntegrationSet, integrateSet } from "./integration-set.mjs";
import { parseReviewerSpec } from "./run-command.mjs";
import { loadConfig } from "./config.mjs";
import { parseRequireEvidence, describeAssurance } from "./assurance.mjs";

/**
 * CLI surface for a cross-repo integration SET (scripts/integration-set.mjs).
 * Plans the set (resolves + validates every member into an exact
 * {repository, baseCommit, workerBranch, integrationBranch} tuple), then
 * integrates it — the set is judged all-or-nothing, exactly as
 * integrateSet itself judges it. Exit semantics mirror the rest of this
 * CLI's honesty rule: 0 only when every member integrated (setReady),
 * 1 when the set was blocked (a member refused, findings, empty diff,
 * merge conflict...), 2 when the runner itself could not operate (bad
 * flags, a member that fails to resolve at plan time).
 */

/** "<repositoryId>=<repoPath>:<workerBranch>". A repoPath may itself
 * contain a colon (a Windows drive letter, e.g. "C:\..."), but git branch
 * names never contain one (git-check-ref-format forbids it) — so the LAST
 * colon in the remainder is always the repoPath/workerBranch separator. */
function parseMember(spec) {
  const usage = '--member must be "<repositoryId>=<repoPath>:<workerBranch>"';
  if (typeof spec !== "string" || spec.length === 0) throw new Error(usage);
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`${usage}, got: "${spec}"`);
  const repositoryId = spec.slice(0, eq);
  const rest = spec.slice(eq + 1);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0 || colon === rest.length - 1) throw new Error(`${usage}, got: "${spec}"`);
  const repository = rest.slice(0, colon);
  const workerBranch = rest.slice(colon + 1);
  return { repositoryId, repository, workerBranch };
}

/** "<repositoryId>=<ref>". */
function parseBase(spec) {
  const usage = '--base must be "<repositoryId>=<ref>"';
  if (typeof spec !== "string" || spec.length === 0) throw new Error(usage);
  const eq = spec.indexOf("=");
  if (eq <= 0 || eq === spec.length - 1) throw new Error(`${usage}, got: "${spec}"`);
  return { repositoryId: spec.slice(0, eq), ref: spec.slice(eq + 1) };
}

function renderMemberTable(members) {
  if (members.length === 0) return "(no members)";
  const idWidth = Math.max(12, ...members.map((m) => m.repositoryId.length));
  const reasonWidth = Math.max(6, ...members.map((m) => (m.reason ?? "-").length));
  const assuranceWidth = Math.max(9, ...members.map((m) => (m.assurance ?? "-").length));
  const header = `${"repositoryId".padEnd(idWidth)}  ${"ready".padEnd(5)}  ${"assurance".padEnd(assuranceWidth)}  ${"reason".padEnd(reasonWidth)}  integrationHead`;
  const rows = members.map((m) => {
    const head = m.integrationHead ? m.integrationHead.slice(0, 10) : "-";
    return `${m.repositoryId.padEnd(idWidth)}  ${String(m.integrated).padEnd(5)}  ${(m.assurance ?? "-").padEnd(assuranceWidth)}  ${(m.reason ?? "-").padEnd(reasonWidth)}  ${head}`;
  });
  return [header, ...rows].join("\n");
}

/** The set is only as well-evidenced as its weakest member. */
function weakestAssurance(members) {
  const order = ["gates-only", "validated", "reviewed", "validated+reviewed"];
  const present = members.map((m) => m.assurance).filter(Boolean);
  if (present.length === 0) return null;
  return present.reduce((worst, a) => (order.indexOf(a) < order.indexOf(worst) ? a : worst), present[0]);
}

function printResult(result, asJson, write) {
  if (asJson) {
    write(`${JSON.stringify({
      setId: result.setId,
      setReady: result.setReady,
      blockedBy: result.blockedBy,
      members: result.members,
      evidencePath: result.evidencePath,
    }, null, 2)}\n`);
    return;
  }
  write(`DevHarmonics integration set: ${result.setId}\n\n`);
  write(`${renderMemberTable(result.members)}\n`);
  write(`\nset:       ${result.setReady ? "READY" : "NOT READY"}\n`);
  // Never a bare READY: say what evidence backs it, as `run` does. The set is only
  // as well-evidenced as its weakest member, so that is what is reported.
  const assurance = weakestAssurance(result.members);
  if (assurance) {
    const required = result.members.find((m) => m.requiredEvidence)?.requiredEvidence ?? [];
    write(`assurance: ${describeAssurance(assurance, required)}\n`);
    const missing = [...new Set(result.members.flatMap((m) => m.missingEvidence ?? []))];
    if (missing.length) write(`           REFUSED for missing evidence: ${missing.join(", ")}\n`);
  }
  if (!result.setReady) write(`blockedBy: ${result.blockedBy.join(", ")}\n`);
  write(`evidence:  ${result.evidencePath}\n`);
}

export async function setCommand(argv, {
  write = (text) => { process.stdout.write(text); },
  env = process.env,
  deps = {},
} = {}) {
  const { planIntegrationSet: planFn = planIntegrationSet, integrateSet: integrateFn = integrateSet } = deps;

  const options = { members: [], bases: [], evidenceRoot: null, asJson: false, check: null, reviewer: null, goal: null, requireEvidence: null };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => { i += 1; return argv[i]; };
    switch (argv[i]) {
      case "--member": options.members.push(next()); break;
      case "--base": options.bases.push(next()); break;
      case "--evidence-root": options.evidenceRoot = next(); break;
      case "--check": options.check = next(); break;
      case "--reviewer": options.reviewer = next(); break;
      case "--goal": options.goal = next(); break;
      case "--require-evidence": options.requireEvidence = next(); break;
      case "--json": options.asJson = true; break;
      default: throw new Error(`Unknown set option: ${argv[i]}`);
    }
  }
  if (options.check !== null && String(options.check).trim().length === 0) {
    throw new Error('--check must be a non-empty command, e.g. --check "npm test"');
  }
  if (options.members.length < 2) {
    throw new Error("--member must be given at least twice (an integration set needs 2+ repositories)");
  }

  const parsedMembers = options.members.map(parseMember);
  const baseByRepositoryId = new Map(options.bases.map(parseBase).map((b) => [b.repositoryId, b.ref]));
  const members = parsedMembers.map((m) => {
    const baseRef = baseByRepositoryId.get(m.repositoryId);
    return baseRef === undefined ? m : { ...m, baseRef };
  });

  const evidenceRoot = path.resolve(options.evidenceRoot ?? mkdtempSync(path.join(os.tmpdir(), "devharmonics-set-")));

  const plan = planFn({ members });
  // Split on plain spaces, the same shape `run --check` uses. An argument that
  // itself needs a space cannot be expressed this way — a known, documented limit.
  const [checkCommand, ...checkArgs] = String(options.check ?? "").split(" ").filter(Boolean);
  const check = checkCommand ? { command: checkCommand, args: checkArgs } : null;
  // Same reviewer grammar as `run`: "provider:model" or "http:provider:model".
  const reviewer = options.reviewer ? parseReviewerSpec(options.reviewer, loadConfig()) : null;
  const result = await integrateFn({
    set: plan, evidenceRoot, env, check, reviewer, goal: options.goal,
    requireEvidence: parseRequireEvidence(options.requireEvidence),
  });

  printResult(result, options.asJson, write);
  return result.setReady ? 0 : 1;
}
