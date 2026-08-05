/**
 * Assurance: how much evidence actually backs a readiness claim.
 *
 * The problem this solves (independent audit A4-6, 2026-08-05): `run` and `set`
 * both reported "integrated / ready-for-owner-review" whether a validator and an
 * independent review had run or nothing semantic had run at all. The reader could
 * not tell those apart, so the claim outran the evidence — the exact false-green
 * class this project exists to catch.
 *
 * The fix is deliberately NOT "require a validator and a reviewer always". That
 * breaks honest uses (a repo with no meaningful suite, a docs-only change) and
 * rewards check-theater: a `--check "true"` satisfies a naive requirement while
 * proving nothing. A real reviewer demonstrated this live on 2026-08-05, refusing
 * a change with "Validator receipted as `node -e process.exit(0)`, a no-op ...
 * tests are never run" — the requirement would have been met, the evidence still
 * worthless.
 *
 * So: the level is always DERIVED from evidence that actually ran and is always
 * reported, and an operator who wants a hard floor asks for one explicitly. The
 * honest case is the default; the strict case is one flag away.
 *
 * A level is never proof that the evidence was GOOD — a passing check whose
 * sensitivity was never established is still weak evidence (that is what
 * deterministic-detector is for). `assurance` states what ran, not what it proved.
 */

/** The evidence kinds an operator can demand. */
export const EVIDENCE_KINDS = Object.freeze(["validator", "review"]);

export const ASSURANCE_LEVELS = Object.freeze([
  "gates-only",           // deterministic gates only: ancestry, empty-diff, tampercheck, final-artifact
  "validated",            // + the task's own validator passed
  "reviewed",             // + an independent review returned READY
  "validated+reviewed",   // both
]);

/**
 * Derive the level from what actually ran and passed. `null`/absent means the
 * evidence does not exist — never treated as a pass.
 */
export function assuranceFor({ validatorPassed = false, reviewPassed = false } = {}) {
  if (validatorPassed && reviewPassed) return "validated+reviewed";
  if (validatorPassed) return "validated";
  if (reviewPassed) return "reviewed";
  return "gates-only";
}

/** Parse `--require-evidence validator,review` into a validated list. */
export function parseRequireEvidence(spec) {
  if (spec === null || spec === undefined || String(spec).trim().length === 0) return [];
  const parts = String(spec).split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.includes("both")) return ["validator", "review"];
  if (parts.includes("none")) return [];
  for (const p of parts) {
    if (!EVIDENCE_KINDS.includes(p)) {
      throw new Error(`--require-evidence must be a comma-separated list of ${EVIDENCE_KINDS.join(", ")} (or "both"/"none"), got: "${p}"`);
    }
  }
  return [...new Set(parts)];
}

/**
 * Which demanded evidence is missing. Empty array => the floor is satisfied.
 * Fail-closed by construction: absent evidence is missing evidence.
 */
export function missingEvidence(required, { validatorPassed = false, reviewPassed = false } = {}) {
  const missing = [];
  for (const kind of required ?? []) {
    if (kind === "validator" && !validatorPassed) missing.push("validator");
    if (kind === "review" && !reviewPassed) missing.push("review");
  }
  return missing;
}

/** One-line, honest summary for CLI output — never a bare "READY". */
export function describeAssurance(level, required = []) {
  const floor = (required ?? []).length > 0 ? ` (required: ${required.join("+")})` : "";
  switch (level) {
    case "validated+reviewed": return `validated+reviewed — a validator passed and an independent review returned READY${floor}`;
    case "validated": return `validated — a validator passed; NO independent review ran${floor}`;
    case "reviewed": return `reviewed — an independent review returned READY; NO validator ran${floor}`;
    default: return `gates-only — deterministic gates passed; NO validator and NO independent review ran${floor}`;
  }
}
