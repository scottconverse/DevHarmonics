import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSURANCE_LEVELS,
  EVIDENCE_KINDS,
  assuranceFor,
  parseRequireEvidence,
  missingEvidence,
  describeAssurance,
} from "../scripts/assurance.mjs";

/**
 * A4-6: readiness used to be reported identically whether a validator and review
 * ran or nothing semantic ran at all. The level is DERIVED from evidence that
 * actually passed, and an operator can demand a floor that fails closed.
 */

test("assuranceFor derives the level from evidence that actually passed, never from intent", () => {
  assert.equal(assuranceFor({}), "gates-only");
  assert.equal(assuranceFor({ validatorPassed: false, reviewPassed: false }), "gates-only");
  assert.equal(assuranceFor({ validatorPassed: true }), "validated");
  assert.equal(assuranceFor({ reviewPassed: true }), "reviewed");
  assert.equal(assuranceFor({ validatorPassed: true, reviewPassed: true }), "validated+reviewed");
  for (const level of [assuranceFor({}), assuranceFor({ validatorPassed: true, reviewPassed: true })]) {
    assert.ok(ASSURANCE_LEVELS.includes(level));
  }
});

test("parseRequireEvidence accepts the documented forms and rejects anything else", () => {
  assert.deepEqual(parseRequireEvidence(null), []);
  assert.deepEqual(parseRequireEvidence(""), []);
  assert.deepEqual(parseRequireEvidence("none"), []);
  assert.deepEqual(parseRequireEvidence("validator"), ["validator"]);
  assert.deepEqual(parseRequireEvidence("review"), ["review"]);
  assert.deepEqual(parseRequireEvidence("validator,review"), ["validator", "review"]);
  assert.deepEqual(parseRequireEvidence("both"), ["validator", "review"]);
  assert.deepEqual(parseRequireEvidence(" REVIEW , validator "), ["review", "validator"]);
  assert.deepEqual(parseRequireEvidence("validator,validator"), ["validator"], "deduplicates");
  assert.throws(() => parseRequireEvidence("tests"), /--require-evidence must be/);
  assert.throws(() => parseRequireEvidence("validator,gates"), /--require-evidence must be/);
  for (const kind of EVIDENCE_KINDS) assert.deepEqual(parseRequireEvidence(kind), [kind]);
});

test("missingEvidence fails closed: absent evidence is missing evidence", () => {
  assert.deepEqual(missingEvidence([], {}), [], "no floor demanded, nothing missing");
  assert.deepEqual(missingEvidence(["validator"], {}), ["validator"]);
  assert.deepEqual(missingEvidence(["validator"], { validatorPassed: true }), []);
  // A validator that RAN but FAILED is not evidence of anything passing.
  assert.deepEqual(missingEvidence(["validator"], { validatorPassed: false }), ["validator"]);
  assert.deepEqual(missingEvidence(["validator", "review"], { validatorPassed: true }), ["review"]);
  assert.deepEqual(missingEvidence(["validator", "review"], {}), ["validator", "review"]);
  assert.deepEqual(missingEvidence(["review"], { reviewPassed: true }), []);
});

test("describeAssurance never emits a bare READY and always says what did NOT run", () => {
  const gates = describeAssurance("gates-only");
  assert.match(gates, /gates-only/);
  assert.match(gates, /NO validator and NO independent review/);
  assert.match(describeAssurance("validated"), /NO independent review ran/);
  assert.match(describeAssurance("reviewed"), /NO validator ran/);
  assert.match(describeAssurance("validated+reviewed"), /validator passed and an independent review returned READY/);
  // A demanded floor is surfaced in the text.
  assert.match(describeAssurance("validated", ["validator", "review"]), /required: validator\+review/);
  for (const level of ASSURANCE_LEVELS) {
    assert.doesNotMatch(describeAssurance(level), /^READY$/);
  }
});
