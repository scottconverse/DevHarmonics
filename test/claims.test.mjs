import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_CLAIMS_SCHEMA,
  claimsArtifactDivergence,
  claimsAvailable,
  parseWorkerClaims,
  parseWorkerClaimsObject,
} from "../scripts/claims.mjs";

const manifest = (claimedPaths = ["src/a.js"], materialClaims = []) => ({
  schema: WORKER_CLAIMS_SCHEMA,
  status: "available",
  claimedPaths,
  materialClaims,
});

test("worker claims are parsed as a separate versioned artifact and malformed output is unavailable", () => {
  const parsed = parseWorkerClaims(`worker prose\n\n\`\`\`json\n${JSON.stringify(manifest())}\n\`\`\``);
  assert.equal(claimsAvailable(parsed), true);
  assert.deepEqual(parsed.claimedPaths, ["src/a.js"]);
  assert.equal(claimsAvailable(parseWorkerClaims("NOT READY\nno manifest")), false);
  assert.equal(claimsAvailable(parseWorkerClaims(String.raw`\`\`json
{"schema":"devharmonics-worker-claims-v1"}
\`\``)), false);
});

test("claims reject invalid paths and material claims that are not backed by claimedPaths", () => {
  const invalid = parseWorkerClaimsObject(manifest(["../escape.js"], []));
  assert.equal(claimsAvailable(invalid), false);
  const unsupportedMaterial = parseWorkerClaimsObject(manifest(["src/a.js"], [{ id: "logic", summary: "changed logic", paths: ["src/missing.js"] }]));
  assert.equal(claimsAvailable(unsupportedMaterial), false);
});

test("claims-vs-diff divergence catches claims in both directions and material omissions", () => {
  const findings = claimsArtifactDivergence({
    claimedPaths: ["src/a.js", "ghost.js"],
    materialClaims: [{ id: "logic", summary: "logic changed", paths: ["src/a.js", "src/logic.js"] }],
    diffPaths: ["src/a.js", "unclaimed.js"],
  });
  assert.ok(findings.some((finding) => finding.location === "ghost.js" && finding.severity === "high"));
  assert.ok(findings.some((finding) => finding.location === "src/logic.js" && finding.severity === "high"));
  assert.ok(findings.some((finding) => finding.location === "unclaimed.js" && finding.severity === "medium"));
});
