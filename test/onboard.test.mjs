import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TAMPERCHECK_PINNED_VERSION, applyOnboarding, planOnboarding, renderTampercheckWorkflow } from "../scripts/onboard.mjs";

/**
 * Hermetic detector-template dir: an EMPTY directory, so the ci-detectors step is
 * deterministically "unavailable" regardless of whether the deterministic-detector
 * plugin happens to be installed on the machine running the suite. Reading the real
 * ~/.claude path here would make these tests environment-sensitive — the exact
 * non-hermetic defect an audit flagged in the doctor tests.
 */
const NO_DETECTOR_TEMPLATES = mkdtempSync(path.join(os.tmpdir(), "dh-no-detector-"));
import { onboardCommand } from "../scripts/onboard-command.mjs";
import { probeRepoGovernance } from "../scripts/probes.mjs";
import { runDoctor } from "../scripts/doctor.mjs";
import { defaultConfig } from "../scripts/config.mjs";

/**
 * Real git repos in temp dirs — same rationale as test/integrate.test.mjs:
 * onboarding's own detection logic reads real filesystem/git state
 * (.git/info/exclude, .github/workflows/, README.md), so faking any of it
 * would test nothing.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo() {
  const dir = tempDir("dh-onboard-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(dir, "placeholder.txt"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function withRepo(fn) {
  const repo = initRepo();
  return (async () => {
    try {
      await fn(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  })();
}

function workflowPathOf(repo) {
  return path.join(repo, ".github", "workflows", "tampercheck.yml");
}

/** Mirrors test/doctor.test.mjs's fixtureConfig: guaranteed-dead targets, so
 * runDoctor completes fast and hermetically without touching a real
 * network/process. Duplicated locally (not imported) — same reason
 * test/doctor.test.mjs keeps its own copy rather than exporting one. */
function fixtureConfig() {
  const config = defaultConfig();
  config.endpoints = { deadend: { baseUrl: "http://127.0.0.1:1" } };
  config.clis = { ghost: { command: "definitely-not-installed-tool" } };
  config.rigor.tampercheckCommand = "definitely-not-installed-tampercheck";
  config.rigor.skillHosts = { claude: "Z:/none", codex: "Z:/nada" };
  return config;
}

function collectWrites() {
  const lines = [];
  return { write: (text) => lines.push(text), text: () => lines.join("") };
}

// --- 1. planOnboarding is read-only, all steps missing on a fresh repo ----

test("planOnboarding on a fresh git repo reports every step missing and never writes", () => withRepo(async (repo) => {
  const before = git(repo, ["status", "--porcelain"]);
  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });

  assert.equal(plan.repository, repo);
  assert.equal(plan.steps.length, 3, "no README.md in this fixture -> readme-badge must not be offered");
  const byId = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
  assert.equal(byId["ci-tampercheck"].status, "missing");
  assert.equal(byId["gitignore-devharmonics"].status, "missing");
  // No detector plugin templates available in this hermetic fixture.
  assert.equal(byId["ci-detectors"].status, "unavailable");
  assert.match(byId["ci-detectors"].detail, /not installed locally/);
  assert.equal(byId["readme-badge"], undefined);

  assert.equal(existsSync(workflowPathOf(repo)), false);
  assert.equal(git(repo, ["status", "--porcelain"]), before, "planning must not touch the working tree");
}));

// --- 2. applyOnboarding writes, and is idempotent -------------------------

test("applyOnboarding writes the pinned workflow and the exclude entry; re-planning afterward reports present", () => withRepo(async (repo) => {
  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  const result = applyOnboarding({ repository: repo, plan });

  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.applied].sort(), ["ci-tampercheck", "gitignore-devharmonics"]);
  // ci-detectors is skipped here: no detector templates are available in this
  // hermetic fixture, and inventing a workflow would be worse than skipping.
  assert.deepEqual(result.skipped, ["ci-detectors"]);

  const workflowContent = readFileSync(workflowPathOf(repo), "utf8");
  assert.match(workflowContent, new RegExp(`tampercheck==${TAMPERCHECK_PINNED_VERSION.replace(/\./g, "\\.")}`));
  assert.match(workflowContent, /fetch-depth:\s*0/);
  assert.equal(workflowContent, renderTampercheckWorkflow(TAMPERCHECK_PINNED_VERSION));

  const excludeContent = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(excludeContent, /\.devharmonics\//);

  // Idempotent: re-planning now reports everything present.
  const rePlan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  for (const step of rePlan.steps) {
    // ci-detectors stays "unavailable" with no templates to copy — it was never
    // written, so claiming it "present" would be the false green.
    const expected = step.id === "ci-detectors" ? "unavailable" : "present";
    assert.equal(step.status, expected, `${step.id} after apply`);
  }

  // Re-applying writes nothing further.
  const reApply = applyOnboarding({ repository: repo, plan: rePlan });
  assert.deepEqual(reApply.applied, []);
  assert.deepEqual([...reApply.skipped].sort(), ["ci-detectors", "ci-tampercheck", "gitignore-devharmonics"]);
  assert.deepEqual(reApply.errors, []);
  assert.equal(readFileSync(workflowPathOf(repo), "utf8"), workflowContent, "re-apply must not touch an already-present file");
}));

// --- 3. differs / force ----------------------------------------------------

test("a workflow pinning a different version reports differs; force gates the rewrite", () => withRepo(async (repo) => {
  mkdirSync(path.dirname(workflowPathOf(repo)), { recursive: true });
  const stale = renderTampercheckWorkflow("0.0.1");
  writeFileSync(workflowPathOf(repo), stale);

  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  const step = plan.steps.find((s) => s.id === "ci-tampercheck");
  assert.equal(step.status, "differs");

  const withoutForce = applyOnboarding({ repository: repo, plan });
  assert.equal(withoutForce.applied.includes("ci-tampercheck"), false);
  assert.ok(withoutForce.skipped.includes("ci-tampercheck"));
  assert.deepEqual(withoutForce.errors, []);
  assert.equal(readFileSync(workflowPathOf(repo), "utf8"), stale, "must never overwrite a differing file without force");

  const withForce = applyOnboarding({ repository: repo, plan, force: true });
  assert.ok(withForce.applied.includes("ci-tampercheck"));
  assert.equal(readFileSync(workflowPathOf(repo), "utf8"), renderTampercheckWorkflow(TAMPERCHECK_PINNED_VERSION));

  const rePlan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.equal(rePlan.steps.find((s) => s.id === "ci-tampercheck").status, "present");
}));

// --- 4. README badge step --------------------------------------------------

test("readme-badge: not offered without a README; missing then applied with exactly one appended line; present once there", () => withRepo(async (repo) => {
  // (a) absent README -> step not offered at all.
  const noReadmePlan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.equal(noReadmePlan.steps.some((s) => s.id === "readme-badge"), false);

  // (b) README present without the badge line -> missing -> apply appends one line.
  const readmePath = path.join(repo, "README.md");
  const original = "# My Project\n\nSome existing content.\n";
  writeFileSync(readmePath, original);

  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  const step = plan.steps.find((s) => s.id === "readme-badge");
  assert.ok(step, "readme-badge must be offered once README.md exists");
  assert.equal(step.status, "missing");

  const result = applyOnboarding({ repository: repo, plan });
  assert.ok(result.applied.includes("readme-badge"));
  const updated = readFileSync(readmePath, "utf8");
  assert.ok(updated.startsWith(original), "original content must be left intact");
  const addedLines = updated.slice(original.length).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(addedLines, ["verification: tampercheck"], "exactly one line must be appended");

  // (c) already present -> "present", and re-applying is a no-op.
  const rePlan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  const reStep = rePlan.steps.find((s) => s.id === "readme-badge");
  assert.equal(reStep.status, "present");
  const reResult = applyOnboarding({ repository: repo, plan: rePlan });
  assert.equal(reResult.applied.includes("readme-badge"), false);
  assert.equal(readFileSync(readmePath, "utf8"), updated, "must not rewrite an already-present badge");
}));

// --- 5. probeRepoGovernance --------------------------------------------------

test("probeRepoGovernance PASSes only on a correctly onboarded repo, and reports the precise FAIL reason otherwise", () => withRepo(async (repo) => {
  const absent = probeRepoGovernance("repo:governance", repo, { pinnedVersion: TAMPERCHECK_PINNED_VERSION });
  assert.equal(absent.status, "FAIL");
  assert.match(absent.detail, /absent/);

  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  applyOnboarding({ repository: repo, plan });
  const pass = probeRepoGovernance("repo:governance", repo, { pinnedVersion: TAMPERCHECK_PINNED_VERSION });
  assert.equal(pass.status, "PASS", pass.detail);

  writeFileSync(workflowPathOf(repo), renderTampercheckWorkflow("9.9.9"));
  const wrongVersion = probeRepoGovernance("repo:governance", repo, { pinnedVersion: TAMPERCHECK_PINNED_VERSION });
  assert.equal(wrongVersion.status, "FAIL");
  assert.match(wrongVersion.detail, /9\.9\.9/);

  writeFileSync(workflowPathOf(repo), "name: tampercheck\non: [push]\njobs: {}\n");
  const unpinned = probeRepoGovernance("repo:governance", repo, { pinnedVersion: TAMPERCHECK_PINNED_VERSION });
  assert.equal(unpinned.status, "FAIL");
  assert.match(unpinned.detail, /unpinned/);

  const skipped = probeRepoGovernance("repo:governance", null, { pinnedVersion: TAMPERCHECK_PINNED_VERSION });
  assert.equal(skipped.status, "SKIPPED");
}));

// --- 6. doctor wiring --------------------------------------------------------

test("runDoctor adds the governance check only when a repository is supplied; check count matches the existing no-repo expectation otherwise", () => withRepo(async (repo) => {
  const withoutRepo = await runDoctor({ config: fixtureConfig(), probeTimeoutMs: 3_000 });
  assert.equal(withoutRepo.checks.length, 4, "must match test/doctor.test.mjs's existing 4-check expectation, unmodified");
  assert.equal(withoutRepo.checks.some((c) => c.id === "repo:governance"), false);

  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  applyOnboarding({ repository: repo, plan });

  const withRepoReport = await runDoctor({ config: fixtureConfig(), probeTimeoutMs: 3_000, repository: repo });
  assert.equal(withRepoReport.checks.length, 5);
  const governance = withRepoReport.checks.find((c) => c.id === "repo:governance");
  assert.ok(governance);
  assert.equal(governance.status, "PASS", governance.detail);
}));

test("cli doctor --repository wires the governance check through the real subprocess", () => withRepo(async (repo) => {
  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  applyOnboarding({ repository: repo, plan });

  const dir = tempDir("dh-onboard-doctorcfg-");
  try {
    const file = path.join(dir, "dead.json");
    writeFileSync(file, JSON.stringify({
      endpoints: { deadend: { baseUrl: "http://127.0.0.1:1" } },
      clis: { ghost: { command: "definitely-not-installed-tool" } },
      rigor: {
        tampercheckCommand: "definitely-not-installed-tampercheck",
        skillHosts: { claude: path.join(dir, "none"), codex: path.join(dir, "nada") },
      },
    }));
    const run = spawnSync(process.execPath, [CLI, "doctor", "--json", "--config", file, "--repository", repo], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    const governance = report.checks.find((c) => c.id === "repo:governance");
    assert.ok(governance, "expected repo:governance in checks");
    assert.equal(governance.status, "PASS", governance.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("cli doctor without --repository behaves exactly as before (no governance check)", () => {
  // NOTE on why this doesn't also assert an exact checks.length: loadConfig
  // deep-merges a --config file over defaultConfig() (config.mjs's
  // deepMerge), so clis/endpoints from the file land ALONGSIDE the real
  // default codex/claude/agy/ollama/lmstudio/litellm entries, not in place
  // of them — exactly why test/doctor.test.mjs's own equivalent CLI-spawn
  // test asserts `counts.FAIL >= 3` rather than an exact count. The
  // hermetic, exact-count "4 checks without a repository" proof already
  // lives above, in the in-process runDoctor test, which passes a config
  // object directly (no file, no merge). This test's job is narrower: prove
  // that omitting --repository through the real CLI never adds the
  // governance check.
  const dir = tempDir("dh-onboard-doctorcfg-");
  try {
    const file = path.join(dir, "dead.json");
    writeFileSync(file, JSON.stringify({
      endpoints: { deadend: { baseUrl: "http://127.0.0.1:1" } },
      clis: { ghost: { command: "definitely-not-installed-tool" } },
      rigor: {
        tampercheckCommand: "definitely-not-installed-tampercheck",
        skillHosts: { claude: path.join(dir, "none"), codex: path.join(dir, "nada") },
      },
    }));
    const run = spawnSync(process.execPath, [CLI, "doctor", "--json", "--config", file], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.checks.some((c) => c.id === "repo:governance"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 7. onboardCommand -------------------------------------------------------

test("onboardCommand dry run writes nothing; --apply writes; --repository also works; bad flags and non-git paths are runner errors", () => withRepo(async (repo) => {
  const dry = collectWrites();
  const before = git(repo, ["status", "--porcelain"]);
  const dryExit = await onboardCommand([repo], { write: dry.write, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.equal(dryExit, 0);
  assert.equal(git(repo, ["status", "--porcelain"]), before, "dry run must not touch the working tree");
  assert.equal(existsSync(workflowPathOf(repo)), false);
  assert.ok(dry.text().includes("ci-tampercheck"));
  assert.ok(dry.text().includes("missing"));

  const apply = collectWrites();
  const applyExit = await onboardCommand([repo, "--apply"], { write: apply.write, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.equal(applyExit, 0);
  assert.equal(existsSync(workflowPathOf(repo)), true);
  assert.ok(apply.text().includes("WROTE"));

  // Reachable via --repository instead of the positional form; everything is
  // already present by now, so this is the "everything already present"
  // still-exit-0 case, exercised through --json.
  const already = collectWrites();
  const alreadyExit = await onboardCommand(["--repository", repo, "--apply", "--json"], { write: already.write, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.equal(alreadyExit, 0);
  const parsed = JSON.parse(already.text());
  assert.deepEqual(parsed.applied, []);
  assert.deepEqual([...parsed.skipped].sort(), ["ci-detectors", "ci-tampercheck", "gitignore-devharmonics"]);

  // force + differs, end to end through the command layer.
  writeFileSync(workflowPathOf(repo), renderTampercheckWorkflow("0.0.1"));
  const dryDiffers = collectWrites();
  await onboardCommand([repo], { write: dryDiffers.write, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.ok(dryDiffers.text().includes("differs"));

  const applyNoForce = collectWrites();
  await onboardCommand([repo, "--apply"], { write: applyNoForce.write, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.equal(readFileSync(workflowPathOf(repo), "utf8"), renderTampercheckWorkflow("0.0.1"), "must not rewrite without --force");

  const applyForce = collectWrites();
  await onboardCommand([repo, "--apply", "--force"], { write: applyForce.write, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  assert.equal(readFileSync(workflowPathOf(repo), "utf8"), renderTampercheckWorkflow(TAMPERCHECK_PINNED_VERSION));

  // Bad flag -> runner error (the exit-2 path once wired into cli.mjs).
  await assert.rejects(() => onboardCommand([repo, "--bogus"]), /Unknown onboard option/);

  // Non-git path -> runner error (the exit-2 path once wired into cli.mjs).
  const notGit = tempDir("dh-onboard-notgit-");
  try {
    await assert.rejects(() => onboardCommand([notGit]), /git/i);
  } finally {
    rmSync(notGit, { recursive: true, force: true });
  }

  // Missing repository argument entirely.
  await assert.rejects(() => onboardCommand([]), /repository is required/);
}));

// --- deterministic-detector provisioning + the two-installers collision -----
// deterministic-detector is not a runtime gate (no CLI, and its own templates
// forbid an agent from promoting its checks), so provisioning its CI workflow is
// the only legitimate integration. SPEC §2.4: "rigor-suite installer: the
// repo-onboarding ceremony for every new portfolio member."

/** A stand-in for the installed plugin's ci/ directory. */
function detectorTemplates() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-detector-tpl-"));
  writeFileSync(path.join(dir, "detectors.yml"),
    "# deterministic-detector CI template\nname: deterministic-detectors\non: [pull_request]\njobs:\n  randomized-suite:\n    runs-on: ubuntu-latest\n  mutation-report:\n    runs-on: ubuntu-latest\n");
  return dir;
}

test("ci-detectors: copied VERBATIM from the installed plugin template, then reported present (even if renamed)", () => withRepo(async (repo) => {
  const tpl = detectorTemplates();
  try {
    const plan = planOnboarding({ repository: repo, detectorTemplateDir: tpl });
    const step = plan.steps.find((s) => s.id === "ci-detectors");
    assert.equal(step.status, "missing");

    const result = applyOnboarding({ repository: repo, plan });
    assert.ok(result.applied.includes("ci-detectors"));
    const written = path.join(repo, ".github", "workflows", "detectors.yml");
    // Verbatim: no vendored fork that could drift from its owner.
    assert.equal(readFileSync(written, "utf8"), readFileSync(path.join(tpl, "detectors.yml"), "utf8"));

    // Present on re-plan, and still present after a rename, because detection is
    // by the workflow's declared name rather than its filename.
    assert.equal(planOnboarding({ repository: repo, detectorTemplateDir: tpl }).steps.find((s) => s.id === "ci-detectors").status, "present");
    const renamed = path.join(repo, ".github", "workflows", "quality.yml");
    writeFileSync(renamed, readFileSync(written, "utf8"));
    rmSync(written);
    assert.equal(planOnboarding({ repository: repo, detectorTemplateDir: tpl }).steps.find((s) => s.id === "ci-detectors").status, "present");
  } finally {
    rmSync(tpl, { recursive: true, force: true });
  }
}));

test("ci-tampercheck: a workflow owned by the detector plugin is 'foreign' and is NEVER overwritten, even with --force", () => withRepo(async (repo) => {
  // Simulate the collision: deterministic-detector ships its OWN tampercheck
  // template, so both tools want .github/workflows/tampercheck.yml. Before this,
  // --force silently clobbered the other tool's file.
  const foreign = "# deterministic-detector CI template — tampercheck lane\nname: tampercheck\non: [pull_request]\njobs:\n  tampercheck:\n    runs-on: ubuntu-latest\n";
  mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(workflowPathOf(repo), foreign);

  const plan = planOnboarding({ repository: repo, detectorTemplateDir: NO_DETECTOR_TEMPLATES });
  const step = plan.steps.find((s) => s.id === "ci-tampercheck");
  assert.equal(step.status, "foreign", "must not be mistaken for our own stale output");
  assert.match(step.detail, /deterministic-detector/);

  // Neither a plain apply nor --force may touch it.
  for (const force of [false, true]) {
    const result = applyOnboarding({ repository: repo, plan, force });
    assert.ok(result.skipped.includes("ci-tampercheck"), `force=${force} must skip a foreign file`);
    assert.equal(readFileSync(workflowPathOf(repo), "utf8"), foreign, `force=${force} must leave the other tool's file byte-identical`);
  }
}));
