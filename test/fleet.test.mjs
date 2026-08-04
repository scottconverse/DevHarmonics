// Ported (with adaptation) from codex-factory test/factory-fleet.test.mjs
// (same owner, Apache-2.0). The source modeled ollama-vs-openai candidates;
// these tests exercise the three-lane ("subprocess"/"http") adaptation
// instead, plus the new "tool_use" role and the qualifications.jsonl
// persistence helpers that did not exist in the source module.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendQualification,
  candidateFingerprint,
  discoverCandidates,
  inferLocalTier,
  qualificationPlan,
  readQualifications,
  selectCandidate,
} from "../scripts/fleet.mjs";

const config = {
  clis: {
    codex: { command: "codex", workerModels: ["gpt-5.6-luna"] },
    claude: { command: "claude", workerModels: ["sonnet"] },
    agy: { command: "agy", workerModels: ["default"] },
  },
  endpoints: {
    ollama: { baseUrl: "http://127.0.0.1:11434" },
    lmstudio: { baseUrl: "http://127.0.0.1:1234" },
  },
};

const ollamaTags = {
  models: [
    { name: "qwen2.5:7b", digest: "sha256:abc123" },
    { name: "gemma3:27b" },
    { name: "" },
    {},
  ],
};

const lmstudioModels = {
  data: [
    { id: "mistral-nemo-12b" },
    { id: "" },
    {},
  ],
};

const cliVersions = { codex: "codex-cli 1.2.3", claude: "claude 2.0.1", agy: "agy 1.1.10" };

test("discoverCandidates builds subprocess candidates from config.clis workerModels", () => {
  const candidates = discoverCandidates({ config, ollamaTags: null, lmstudioModels: null, cliVersions });
  assert.deepEqual(candidates, [
    { id: "subprocess:codex:gpt-5.6-luna", lane: "subprocess", provider: "codex", model: "gpt-5.6-luna", tier: "premium", runtimeVersion: "codex-cli 1.2.3", paid: true },
    { id: "subprocess:claude:sonnet", lane: "subprocess", provider: "claude", model: "sonnet", tier: "premium", runtimeVersion: "claude 2.0.1", paid: true },
    { id: "subprocess:agy:default", lane: "subprocess", provider: "agy", model: "default", tier: "premium", runtimeVersion: "agy 1.1.10", paid: true },
  ]);
});

test("discoverCandidates falls back to runtimeVersion \"unknown\" when cliVersions omits a CLI", () => {
  const candidates = discoverCandidates({ config: { clis: { codex: { command: "codex", workerModels: ["gpt-5.6-luna"] } } }, cliVersions: {} });
  assert.equal(candidates[0].runtimeVersion, "unknown");
});

test("discoverCandidates builds http candidates with ids/lanes/tiers from realistic ollama + lmstudio fixtures", () => {
  const candidates = discoverCandidates({ config, ollamaTags, lmstudioModels, cliVersions: {} });
  const http = candidates.filter((c) => c.lane === "http");
  assert.deepEqual(http, [
    { id: "http:ollama:qwen2.5:7b", lane: "http", provider: "ollama", model: "qwen2.5:7b", tier: "economy", runtimeVersion: "unknown", baseUrl: "http://127.0.0.1:11434", paid: false, digest: "sha256:abc123" },
    { id: "http:ollama:gemma3:27b", lane: "http", provider: "ollama", model: "gemma3:27b", tier: "standard", runtimeVersion: "unknown", baseUrl: "http://127.0.0.1:11434", paid: false },
    { id: "http:lmstudio:mistral-nemo-12b", lane: "http", provider: "lmstudio", model: "mistral-nemo-12b", tier: "standard", runtimeVersion: "unknown", baseUrl: "http://127.0.0.1:1234", paid: false },
  ]);
});

test("discoverCandidates puts subprocess candidates before http candidates, in declared order", () => {
  const candidates = discoverCandidates({ config, ollamaTags, lmstudioModels, cliVersions });
  assert.deepEqual(candidates.map((c) => c.id), [
    "subprocess:codex:gpt-5.6-luna",
    "subprocess:claude:sonnet",
    "subprocess:agy:default",
    "http:ollama:qwen2.5:7b",
    "http:ollama:gemma3:27b",
    "http:lmstudio:mistral-nemo-12b",
  ]);
});

test("discoverCandidates skips malformed ollama/lmstudio entries rather than throwing", () => {
  const candidates = discoverCandidates({ config: {}, ollamaTags, lmstudioModels });
  assert.equal(candidates.length, 3, "blank-name and empty-object entries are skipped");
});

test("discoverCandidates rejects a workerModels entry without a model", () => {
  assert.throws(
    () => discoverCandidates({ config: { clis: { codex: { command: "codex", workerModels: [{ tier: "premium" }] } } } }),
    /workerModels contains an entry without a model/,
  );
});

test("discoverCandidates rejects an unsupported explicit tier", () => {
  assert.throws(
    () => discoverCandidates({ config: { clis: { codex: { command: "codex", workerModels: [{ model: "x", tier: "ultra" }] } } } }),
    /Unsupported candidate tier/,
  );
});

test("inferLocalTier reads the parameter-size marker and defaults to economy when absent", () => {
  assert.equal(inferLocalTier("qwen2.5:7b"), "economy");
  assert.equal(inferLocalTier("gemma3:27b"), "standard");
  assert.equal(inferLocalTier("llama3.1:70b"), "premium");
  assert.equal(inferLocalTier("mistral-nemo-12b"), "standard");
  assert.equal(inferLocalTier("some-model:latest"), "economy");
});

test("candidateFingerprint is deterministic and changes with runtime, digest, or tier", () => {
  const base = { id: "http:ollama:gemma3:27b", runtimeVersion: "0.11.4", digest: "sha256:aaa", tier: "standard" };
  const again = candidateFingerprint({ ...base }, "analysis");
  assert.equal(candidateFingerprint({ ...base }, "analysis"), again, "same inputs must fingerprint identically");
  assert.notEqual(candidateFingerprint({ ...base, runtimeVersion: "0.11.5" }, "analysis"), again);
  assert.notEqual(candidateFingerprint({ ...base, digest: "sha256:bbb" }, "analysis"), again);
  assert.notEqual(candidateFingerprint({ ...base, tier: "premium" }, "analysis"), again);
  assert.notEqual(candidateFingerprint(base, "benchmark"), again, "different role harness must fingerprint differently");
});

test("candidateFingerprint rejects an unknown qualification role", () => {
  assert.throws(() => candidateFingerprint({ id: "x" }, "not_a_role"), /Unknown qualification role/);
});

test("qualificationPlan gives http-lane candidates the tool_use role but not subprocess-lane candidates", () => {
  const candidates = discoverCandidates({ config, ollamaTags: { models: [{ name: "gemma3:27b" }] }, cliVersions });
  const byLane = (lane) => qualificationPlan(candidates.filter((c) => c.lane === lane)).map(({ role }) => role);
  assert.deepEqual(byLane("subprocess").filter((role, index, all) => all.indexOf(role) === index), ["analysis", "benchmark", "structured_write"]);
  assert.deepEqual(byLane("http").filter((role, index, all) => all.indexOf(role) === index), ["analysis", "benchmark", "structured_write", "tool_use"]);
});

function qualify(candidate, role, passed, finishedAt = "2026-08-04T00:00:00.000Z") {
  return {
    candidateId: candidate.id,
    fingerprint: candidateFingerprint(candidate, role),
    role,
    passed,
    finishedAt,
  };
}

test("selectCandidate prefers a free http candidate over a qualified paid subprocess candidate", () => {
  const candidates = discoverCandidates({ config, ollamaTags: { models: [{ name: "gemma3:27b" }] }, cliVersions });
  const http = candidates.find((c) => c.id === "http:ollama:gemma3:27b");
  const codex = candidates.find((c) => c.id === "subprocess:codex:gpt-5.6-luna");
  const qualifications = [qualify(http, "analysis", true), qualify(codex, "analysis", true)];
  const selected = selectCandidate({ candidates, qualifications, role: "analysis", requiredTier: "economy" });
  assert.equal(selected.id, "http:ollama:gemma3:27b");
  assert.ok(selected.factors.some((f) => f.includes("free local candidate preferred")));
});

test("selectCandidate's structured_write role requires a passing benchmark qualification too", () => {
  const candidates = discoverCandidates({ config: {}, ollamaTags: { models: [{ name: "gemma3:27b" }] } });
  const candidate = candidates[0];
  const withoutBenchmark = [qualify(candidate, "structured_write", true)];
  assert.throws(
    () => selectCandidate({ candidates, qualifications: withoutBenchmark, role: "structured_write", requiredTier: "standard" }),
    /No currently qualified candidate/,
  );
  const withBenchmark = [...withoutBenchmark, qualify(candidate, "benchmark", true)];
  const selected = selectCandidate({ candidates, qualifications: withBenchmark, role: "structured_write", requiredTier: "standard" });
  assert.equal(selected.id, candidate.id);
});

test("selectCandidate's tool_use role needs no benchmark gate (treated like analysis)", () => {
  const candidates = discoverCandidates({ config: {}, ollamaTags: { models: [{ name: "gemma3:27b" }] } });
  const candidate = candidates[0];
  const qualifications = [qualify(candidate, "tool_use", true)];
  const selected = selectCandidate({ candidates, qualifications, role: "tool_use", requiredTier: "standard" });
  assert.equal(selected.id, candidate.id);
});

test("selectCandidate rejects a stale qualification after a runtime fingerprint changes", () => {
  const oldCandidate = discoverCandidates({ config: {}, ollamaTags: { models: [{ name: "gemma3:27b" }] } })[0];
  const currentCandidate = { ...oldCandidate, runtimeVersion: "different-runtime" };
  const qualifications = [{
    candidateId: oldCandidate.id,
    fingerprint: candidateFingerprint(oldCandidate, "structured_write"),
    role: "structured_write",
    passed: true,
    finishedAt: "2026-08-04T00:00:00.000Z",
  }, {
    candidateId: currentCandidate.id,
    fingerprint: candidateFingerprint(currentCandidate, "benchmark"),
    role: "benchmark",
    passed: true,
    finishedAt: "2026-08-04T00:00:00.000Z",
  }];
  assert.throws(
    () => selectCandidate({ candidates: [currentCandidate], qualifications, role: "structured_write", requiredTier: "standard" }),
    /No currently qualified candidate/,
  );
});

test("the latest result for an exact qualification replaces older evidence", () => {
  const candidate = discoverCandidates({ config: {}, ollamaTags: { models: [{ name: "gemma3:27b" }] } })[0];
  assert.throws(
    () => selectCandidate({
      candidates: [candidate],
      qualifications: [
        qualify(candidate, "structured_write", true, "2026-07-29T10:00:00.000Z"),
        qualify(candidate, "structured_write", false, "2026-07-29T11:00:00.000Z"),
        qualify(candidate, "benchmark", true, "2026-07-29T10:00:00.000Z"),
      ],
      role: "structured_write",
      requiredTier: "standard",
    }),
    /No currently qualified candidate/,
    "a later FAILED result must override an earlier PASSED one for the same exact fingerprint",
  );
});

test("selectCandidate throws when no candidate meets the required tier", () => {
  const candidates = discoverCandidates({ config: {}, ollamaTags: { models: [{ name: "qwen2.5:7b" }] } });
  const qualifications = [qualify(candidates[0], "analysis", true)];
  assert.throws(
    () => selectCandidate({ candidates, qualifications, role: "analysis", requiredTier: "premium" }),
    /No currently qualified candidate/,
  );
});

test("selectCandidate rejects an unknown role or unsupported required tier", () => {
  assert.throws(() => selectCandidate({ candidates: [], qualifications: [], role: "not_a_role" }), /Unknown qualification role/);
  assert.throws(() => selectCandidate({ candidates: [], qualifications: [], role: "analysis", requiredTier: "ultra" }), /Unsupported required tier/);
});

test("readQualifications tolerates and counts malformed lines rather than throwing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dh-qualifications-"));
  try {
    const file = path.join(dir, "qualifications.jsonl");
    writeFileSync(file, [
      '{"candidateId":"http:ollama:gemma3:27b","role":"analysis","passed":true}',
      "not json at all",
      '{"candidateId":"http:ollama:gemma3:27b","role":"benchmark","passed":true}',
      "{ also not json",
    ].join("\n") + "\n");
    const { qualifications, malformedLines } = readQualifications(file);
    assert.equal(qualifications.length, 2);
    assert.equal(malformedLines, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readQualifications on a file that does not exist returns an empty result, not an error", () => {
  const result = readQualifications(path.join(tmpdir(), "dh-qualifications-never-created", "qualifications.jsonl"));
  assert.deepEqual(result, { qualifications: [], malformedLines: 0 });
});

test("appendQualification creates the parent directory and appends one JSON line", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dh-qualifications-append-"));
  try {
    const file = path.join(dir, "nested", "qualifications.jsonl");
    appendQualification(file, { candidateId: "http:ollama:gemma3:27b", role: "analysis", passed: true });
    appendQualification(file, { candidateId: "http:ollama:gemma3:27b", role: "benchmark", passed: true });
    const { qualifications, malformedLines } = readQualifications(file);
    assert.equal(malformedLines, 0);
    assert.deepEqual(qualifications.map((q) => q.role), ["analysis", "benchmark"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
