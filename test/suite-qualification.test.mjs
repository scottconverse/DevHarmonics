import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectSuiteQualification, describeSuiteQualification } from "../scripts/suite-qualification.mjs";

/**
 * SPEC §2.4: "A repo whose suite hasn't been proven sensitive gets its
 * validator-green labeled accordingly in receipts." Detection only — see the
 * module header for why enforcing deterministic-detector here would violate that
 * tool's own contract (its checks are informational until an OWNER promotes them).
 */

function repoWith(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-sq-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const DETECTOR_WORKFLOW = `name: deterministic-detectors
on: [pull_request]
jobs:
  randomized-suite:
    name: randomized-suite
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  mutation-report:
    name: mutation-report
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

test("a repo carrying the detector workflow is governed, and its jobs are named", () => {
  const dir = repoWith({ ".github/workflows/detectors.yml": DETECTOR_WORKFLOW });
  try {
    const q = detectSuiteQualification(dir);
    assert.equal(q.status, "governed");
    assert.deepEqual(q.jobs, ["randomized-suite", "mutation-report"]);
    assert.match(q.workflow, /detectors\.yml$/);
    assert.match(describeSuiteQualification(q), /subject to randomized-order and mutation checks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detection is by declared workflow name, not filename — a renamed file still counts", () => {
  const dir = repoWith({ ".github/workflows/quality-gates.yml": DETECTOR_WORKFLOW });
  try {
    const q = detectSuiteQualification(dir);
    assert.equal(q.status, "governed");
    assert.match(q.workflow, /quality-gates\.yml$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repo with no workflows at all is ungoverned, and the label says a passing validator proves less", () => {
  const dir = repoWith({ "README.md": "# nothing here\n" });
  try {
    const q = detectSuiteQualification(dir);
    assert.equal(q.status, "ungoverned");
    assert.equal(q.workflow, null);
    assert.match(describeSuiteQualification(q), /NOT been detector-qualified/);
    assert.match(describeSuiteQualification(q), /not proof that the tests can fail/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unrelated workflow does not count as governance, and neither does a mere mention in a comment", () => {
  const dir = repoWith({
    ".github/workflows/ci.yml": "name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
    // A comment referencing the detector must NOT be mistaken for having it.
    ".github/workflows/notes.yml": "# see also: name: deterministic-detectors (not installed here)\nname: notes\non: [push]\n",
  });
  try {
    const q = detectSuiteQualification(dir);
    assert.equal(q.status, "ungoverned", "a commented mention must not be read as governance");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partially-installed detector workflow is governed but honest about which jobs exist", () => {
  const partial = "name: deterministic-detectors\non: [pull_request]\njobs:\n  randomized-suite:\n    runs-on: ubuntu-latest\n";
  const dir = repoWith({ ".github/workflows/detectors.yml": partial });
  try {
    const q = detectSuiteQualification(dir);
    assert.equal(q.status, "governed");
    assert.deepEqual(q.jobs, ["randomized-suite"], "must not claim a job that is not there");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing repository path is ungoverned rather than a crash", () => {
  const q = detectSuiteQualification(path.join(os.tmpdir(), "dh-sq-does-not-exist-12345"));
  assert.equal(q.status, "ungoverned");
  assert.match(q.detail, /no \.github\/workflows/);
});

test("governance is never reported as a passing verdict — the checks' results live in CI", () => {
  const dir = repoWith({ ".github/workflows/detectors.yml": DETECTOR_WORKFLOW });
  try {
    const text = describeSuiteQualification(detectSuiteQualification(dir));
    assert.match(text, /verdicts live in CI, not here/, "must not imply the detector checks passed");
    assert.doesNotMatch(text, /proven sensitive/, "governance is not proof of sensitivity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
