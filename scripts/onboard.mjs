import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Repo-onboarding ceremony (spec: `devharmonics onboard <repo>`): make a
 * TARGET repository governed — its own independent verification enforcement
 * — in one idempotent, fully-detectable pass. This is what lets the
 * factory's gates hold even when the factory itself is bypassed: an agent
 * working directly in the target repo, outside `devharmonics run`, still
 * hits CI on push.
 *
 * Two-phase, same split as the rest of this codebase's command surfaces
 * (qualify's plan/execute, doctor's probe-then-report): planOnboarding only
 * ever READS and never writes; applyOnboarding is the only function that
 * writes, and only for the steps the plan actually calls for.
 */

// Single source of truth for the pinned version: the rendered template, the
// "differs" detection below, and probes.mjs's probeRepoGovernance all read
// this constant, so the three can never quietly drift apart.
export const TAMPERCHECK_PINNED_VERSION = "0.1.1";

export const CI_WORKFLOW_RELATIVE_PATH = path.join(".github", "workflows", "tampercheck.yml");
const GITIGNORE_EXCLUDE_RELATIVE_PATH = path.join(".git", "info", "exclude");
const README_RELATIVE_PATH = "README.md";

// v1 precedent (scripts/run-command.mjs's ensureExcluded): a private,
// per-repo exclude — never the owner's shared, committed .gitignore.
const DEVHARMONICS_EXCLUDE_ENTRY = ".devharmonics/";

const README_BADGE_LINE = "verification: tampercheck";

/**
 * Render the exact pinned-install tampercheck CI workflow. The pinned-install
 * rule matters: CI always installs tampercheck fresh from PyPI at the version
 * named here — never from the working tree — so a locally edited copy of
 * this file cannot change what CI enforces.
 */
export function renderTampercheckWorkflow(pinnedVersion = TAMPERCHECK_PINNED_VERSION) {
  return `name: tampercheck
on: [push, pull_request]
jobs:
  tampercheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # full history: a shallow clone makes the diff vacuous
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install tampercheck (pinned)
        run: pip install tampercheck==${pinnedVersion}
      - name: Diff summary (kills the vacuous-pass trap)
        run: git diff --stat \${{ github.event.pull_request.base.sha || github.event.before }}..HEAD || true
      - name: tampercheck
        run: tampercheck --from \${{ github.event.pull_request.base.sha || github.event.before }} --to HEAD
`;
}

/**
 * Pull the pinned version and fetch-depth out of an existing workflow
 * file's text, honestly null when either is absent/unparseable. Shared by
 * this module's own "differs" detection and probes.mjs's probeRepoGovernance
 * so the two checks can never disagree about what "pinned correctly" means.
 */
export function parseTampercheckWorkflow(content) {
  const versionMatch = content.match(/tampercheck==([^\s'"]+)/);
  const fetchDepthMatch = content.match(/fetch-depth:\s*([^\s#]+)/);
  return {
    version: versionMatch ? versionMatch[1] : null,
    fetchDepth: fetchDepthMatch ? fetchDepthMatch[1] : null,
  };
}

function ciWorkflowStep(repository, pinnedVersion) {
  const filePath = path.join(repository, CI_WORKFLOW_RELATIVE_PATH);
  const description = `Install the pinned tampercheck CI workflow (tampercheck==${pinnedVersion}, fetch-depth 0)`;
  if (!existsSync(filePath)) {
    return { id: "ci-tampercheck", description, status: "missing", path: filePath };
  }
  const { version, fetchDepth } = parseTampercheckWorkflow(readFileSync(filePath, "utf8"));
  const matchesTemplate = version === pinnedVersion && fetchDepth === "0";
  return { id: "ci-tampercheck", description, status: matchesTemplate ? "present" : "differs", path: filePath };
}

function gitignoreStep(repository) {
  const filePath = path.join(repository, GITIGNORE_EXCLUDE_RELATIVE_PATH);
  const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const present = content.includes(DEVHARMONICS_EXCLUDE_ENTRY);
  return {
    id: "gitignore-devharmonics",
    description: "Exclude .devharmonics/ via .git/info/exclude (private — never touches the owner's shared .gitignore)",
    status: present ? "present" : "missing",
    path: filePath,
  };
}

function readmeBadgeStep(repository) {
  const filePath = path.join(repository, README_RELATIVE_PATH);
  const content = readFileSync(filePath, "utf8");
  const present = content.includes(README_BADGE_LINE);
  return {
    id: "readme-badge",
    description: `Append a one-line "${README_BADGE_LINE}" note to README.md`,
    status: present ? "present" : "missing",
    path: filePath,
  };
}

/**
 * Plan what onboarding a repository would do. READ-ONLY: never writes.
 *
 * The readme-badge step is OPTIONAL and only offered when README.md already
 * exists — onboarding never creates a README, it only ever appends one line
 * to a README the repository already has.
 */
export function planOnboarding({ repository }) {
  const steps = [ciWorkflowStep(repository, TAMPERCHECK_PINNED_VERSION), gitignoreStep(repository)];
  if (existsSync(path.join(repository, README_RELATIVE_PATH))) {
    steps.push(readmeBadgeStep(repository));
  }
  return { repository, steps };
}

function writeCiWorkflow(repository) {
  const filePath = path.join(repository, CI_WORKFLOW_RELATIVE_PATH);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderTampercheckWorkflow(TAMPERCHECK_PINNED_VERSION));
}

function writeGitignoreEntry(repository) {
  const filePath = path.join(repository, GITIGNORE_EXCLUDE_RELATIVE_PATH);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  if (current.includes(DEVHARMONICS_EXCLUDE_ENTRY)) return; // already there; idempotent no-op
  writeFileSync(filePath, `${current}\n${DEVHARMONICS_EXCLUDE_ENTRY}\n`);
}

function writeReadmeBadge(repository) {
  const filePath = path.join(repository, README_RELATIVE_PATH);
  const current = readFileSync(filePath, "utf8");
  if (current.includes(README_BADGE_LINE)) return; // already there; idempotent no-op
  const separator = current.length && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, `${current}${separator}${README_BADGE_LINE}\n`);
}

const STEP_WRITERS = {
  "ci-tampercheck": writeCiWorkflow,
  "gitignore-devharmonics": writeGitignoreEntry,
  "readme-badge": writeReadmeBadge,
};

/**
 * Apply exactly the steps the plan calls for.
 *
 * Writes only "missing" steps, plus "differs" steps when `force` is set — a
 * differing file is NEVER overwritten without force. "present" steps are
 * left alone. A step that throws while writing is recorded in `errors` and
 * does NOT stop the remaining steps from being attempted.
 */
export function applyOnboarding({ repository, plan, force = false }) {
  const applied = [];
  const skipped = [];
  const errors = [];

  for (const step of plan.steps) {
    if (step.status === "present") {
      skipped.push(step.id);
      continue;
    }
    if (step.status === "differs" && !force) {
      skipped.push(step.id);
      continue;
    }
    const writer = STEP_WRITERS[step.id];
    if (!writer) {
      errors.push({ id: step.id, path: step.path, reason: `no writer registered for step "${step.id}"` });
      continue;
    }
    try {
      writer(repository);
      applied.push(step.id);
    } catch (error) {
      errors.push({ id: step.id, path: step.path, reason: error.message });
    }
  }

  return { applied, skipped, errors };
}
