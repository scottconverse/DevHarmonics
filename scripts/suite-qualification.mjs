import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Is the target repository's own test suite governed by deterministic-detector?
 *
 * SPEC §2.4 obliges the factory to label validator evidence by this: "A repo whose
 * suite hasn't been proven sensitive gets its validator-green labeled accordingly
 * in receipts." Without it, `assurance: validated` means only "a check ran and
 * exited 0" — not "a check capable of failing". A real reviewer made exactly that
 * objection during live-fire on 2026-08-05, refusing a change whose validator was
 * `node -e process.exit(0)`: a no-op that could never fail.
 *
 * Why this DETECTS rather than ENFORCES. deterministic-detector is not a runtime
 * gate like tampercheck — it has no CLI; it is a skill that installs CI workflow
 * templates into a target repo. Those templates state their own rule plainly:
 * `randomized-suite` starts INFORMATIONAL and is promoted to a required check only
 * by the repo owner after burn-in, `mutation-report` is permanently informational,
 * and "Agents NEVER create, modify, or remove required-status-check / branch
 * protection settings, in either direction." Running it as a blocking gate here
 * would violate the contract of the very tool being relied on.
 *
 * So the honest scope, and the limit worth stating: presence of the workflow proves
 * the repository is SUBJECT TO detector checks. It does not prove those checks
 * passed — their results live in GitHub Actions, not on this machine. This module
 * therefore reports governance, never a verdict, and the label says which.
 */

const DETECTOR_WORKFLOW_NAME = "deterministic-detectors";
const DETECTOR_JOBS = ["randomized-suite", "mutation-report"];

/**
 * Look for the detector workflow by its declared `name:`, not by filename, so a
 * repo that renamed the file is still recognized. Never throws: an unreadable
 * .github directory yields "unknown", which is not treated as governed.
 */
export function detectSuiteQualification(repository) {
  const workflowsDir = path.join(repository, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    return { status: "ungoverned", detail: "no .github/workflows directory in the target repository", workflow: null, jobs: [] };
  }
  let entries;
  try {
    entries = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/i.test(f));
  } catch (error) {
    return { status: "unknown", detail: `could not read .github/workflows: ${error.message}`, workflow: null, jobs: [] };
  }
  for (const file of entries) {
    const full = path.join(workflowsDir, file);
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    // The workflow's own `name:` line, anchored so a mention in a comment does not count.
    const named = new RegExp(`^\\s*name:\\s*["']?${DETECTOR_WORKFLOW_NAME}["']?\\s*$`, "m").test(text);
    if (!named) continue;
    const jobs = DETECTOR_JOBS.filter((job) => new RegExp(`^\\s+${job}:\\s*$`, "m").test(text));
    return {
      status: "governed",
      detail: `deterministic-detector workflow present (${file}) with job(s): ${jobs.length ? jobs.join(", ") : "none recognized"}`,
      workflow: path.join(".github", "workflows", file),
      jobs,
    };
  }
  return {
    status: "ungoverned",
    detail: `no workflow named "${DETECTOR_WORKFLOW_NAME}" in .github/workflows — the suite has not been detector-qualified`,
    workflow: null,
    jobs: [],
  };
}

/**
 * The sentence that goes next to a validator result. A passing check in an
 * unqualified repository is still evidence — just weaker than it looks — and the
 * receipt should say so rather than let "validated" imply more than it earned.
 */
export function describeSuiteQualification(q) {
  if (!q) return "suite qualification not evaluated";
  if (q.status === "governed") {
    return "the repository carries deterministic-detector CI, so its suite is subject to randomized-order and mutation checks (their verdicts live in CI, not here)";
  }
  if (q.status === "unknown") {
    return `suite qualification could not be determined (${q.detail}); treat a passing validator as unproven for sensitivity`;
  }
  return "the suite has NOT been detector-qualified, so a passing validator is not proof that the tests can fail";
}
