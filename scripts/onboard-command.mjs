import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { applyOnboarding, planOnboarding } from "./onboard.mjs";

/**
 * CLI surface for `devharmonics onboard <repo>`. Dry run (plan only) by
 * default; --apply actually writes. Exit semantics mirror
 * doctorCommand/qualifyCommand/workerCommand: 0 means onboarding RAN
 * (dry-run or applied, including the everything-already-present case) — 2
 * means the runner itself could not operate (bad flags, missing/non-git
 * repository). Per-step write failures during --apply are NOT a runner
 * error: they land honestly in the result's `errors` list and the command
 * still exits 0, exactly as a doctor run full of FAILs still exits 0.
 */

function renderStepsTable(steps) {
  if (steps.length === 0) return "(no onboarding steps apply to this repository)";
  const width = Math.max(...steps.map((s) => s.id.length));
  return steps.map((s) => `${s.status.padEnd(8)} ${s.id.padEnd(width)}  ${s.description}`).join("\n");
}

function printPlan(plan, asJson, write) {
  if (asJson) {
    write(`${JSON.stringify({ mode: "dry-run", ...plan }, null, 2)}\n`);
    return;
  }
  write(`DevHarmonics onboard (dry run): ${plan.repository}\n\n`);
  write(`${renderStepsTable(plan.steps)}\n`);
  const outstanding = plan.steps.filter((s) => s.status !== "present").length;
  write(`\n${plan.steps.length} step(s), ${outstanding} not yet present\n`);
  if (outstanding) {
    write("\nRun with --apply to write them (add --force to rewrite steps that differ from the template).\n");
  }
}

function printApply(plan, result, asJson, write) {
  if (asJson) {
    write(`${JSON.stringify({ mode: "apply", repository: plan.repository, ...result }, null, 2)}\n`);
    return;
  }
  write(`DevHarmonics onboard: ${plan.repository}\n\n`);
  const width = Math.max(...plan.steps.map((s) => s.id.length));
  for (const step of plan.steps) {
    const failed = result.errors.find((e) => e.id === step.id);
    const outcome = result.applied.includes(step.id) ? "WROTE" : failed ? "ERROR" : "SKIP";
    write(`${outcome.padEnd(6)} ${step.id.padEnd(width)}  ${failed ? failed.reason : step.description}\n`);
  }
  write(`\n${result.applied.length} written, ${result.skipped.length} skipped, ${result.errors.length} error(s)\n`);
}

export async function onboardCommand(argv, {
  write = (text) => { process.stdout.write(text); },
  // Injectable so tests can be hermetic: otherwise the ci-detectors step's status
  // depends on whether the deterministic-detector plugin happens to be installed on
  // the machine running the suite.
  detectorTemplateDir = undefined,
} = {}) {
  const options = { repository: null, apply: false, force: false, asJson: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => { i += 1; return argv[i]; };
    switch (argv[i]) {
      case "--repository": options.repository = next(); break;
      case "--apply": options.apply = true; break;
      case "--force": options.force = true; break;
      case "--json": options.asJson = true; break;
      default:
        if (String(argv[i]).startsWith("--")) throw new Error(`Unknown onboard option: ${argv[i]}`);
        positionals.push(argv[i]);
    }
  }
  if (positionals.length > 1) {
    throw new Error(`onboard takes a single repository argument; got: ${positionals.join(", ")}`);
  }
  const repositoryArg = options.repository ?? positionals[0];
  if (!repositoryArg) {
    throw new Error("repository is required: devharmonics onboard <repo> (or --repository <repo>)");
  }

  const repository = path.resolve(repositoryArg);
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new Error(`Not a directory: ${repository}`);
  }
  if (!existsSync(path.join(repository, ".git"))) {
    throw new Error(`Not a git repository (no .git found): ${repository}`);
  }

  const plan = planOnboarding({ repository, ...(detectorTemplateDir === undefined ? {} : { detectorTemplateDir }) });

  if (!options.apply) {
    printPlan(plan, options.asJson, write);
    return 0;
  }

  const result = applyOnboarding({ repository, plan, force: options.force });
  printApply(plan, result, options.asJson, write);
  return 0;
}
