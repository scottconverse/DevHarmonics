import { writeFileSync } from "node:fs";

/**
 * A worker-claims artifact is deliberately separate from both the worker's
 * prose and the coordinator-computed git diff. The worker supplies it in a
 * small versioned JSON object; the coordinator only adds trusted correlation
 * metadata and then compares the claimed paths with the candidate diff.
 */
export const WORKER_CLAIMS_SCHEMA = "devharmonics-worker-claims-v1";

export function unavailableWorkerClaims({ taskId, lane, reason }) {
  return {
    schema: WORKER_CLAIMS_SCHEMA,
    status: "unavailable",
    taskId: typeof taskId === "string" ? taskId : null,
    lane: typeof lane === "string" ? lane : null,
    reason: String(reason || "worker did not provide a usable claims manifest"),
  };
}

export function normalizeClaimPath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

function validateAvailable(raw, { taskId = null, lane = null } = {}) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) errors.push("claims artifact must be an object");
  if (raw?.schema !== WORKER_CLAIMS_SCHEMA) errors.push(`schema must be ${WORKER_CLAIMS_SCHEMA}`);
  if (raw?.status !== "available") errors.push('status must be "available"');
  if (taskId !== null && raw?.taskId !== undefined && raw.taskId !== taskId) errors.push("taskId does not match the coordinator task");
  if (lane !== null && raw?.lane !== undefined && raw.lane !== lane) errors.push("lane does not match the worker lane");
  if (!Array.isArray(raw?.claimedPaths)) errors.push("claimedPaths must be an array");

  const claimedPaths = [];
  for (const value of raw?.claimedPaths ?? []) {
    const normalized = normalizeClaimPath(value);
    if (!normalized) errors.push(`claimedPaths contains an invalid repository path: ${JSON.stringify(value)}`);
    else claimedPaths.push(normalized);
  }
  if (new Set(claimedPaths).size !== claimedPaths.length) errors.push("claimedPaths contains duplicates");

  if (!Array.isArray(raw?.materialClaims)) errors.push("materialClaims must be an array");
  const materialClaims = [];
  for (const [index, claim] of (raw?.materialClaims ?? []).entries()) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      errors.push(`materialClaims[${index}] must be an object`);
      continue;
    }
    if (typeof claim.id !== "string" || !claim.id.trim()) errors.push(`materialClaims[${index}].id is required`);
    if (typeof claim.summary !== "string" || !claim.summary.trim()) errors.push(`materialClaims[${index}].summary is required`);
    if (!Array.isArray(claim.paths) || claim.paths.length === 0) {
      errors.push(`materialClaims[${index}].paths must be a non-empty array`);
      continue;
    }
    const paths = [];
    for (const value of claim.paths) {
      const normalized = normalizeClaimPath(value);
      if (!normalized) errors.push(`materialClaims[${index}] contains an invalid repository path: ${JSON.stringify(value)}`);
      else paths.push(normalized);
    }
    if (paths.some((value) => !claimedPaths.includes(value))) {
      errors.push(`materialClaims[${index}] names a path absent from claimedPaths`);
    }
    materialClaims.push({
      id: typeof claim.id === "string" ? claim.id.trim() : `claim-${index + 1}`,
      summary: typeof claim.summary === "string" ? claim.summary.trim() : "",
      paths,
    });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    artifact: {
      schema: WORKER_CLAIMS_SCHEMA,
      status: "available",
      taskId: taskId ?? raw.taskId ?? null,
      lane: lane ?? raw.lane ?? null,
      claimedPaths,
      materialClaims,
    },
  };
}

/** Validate a coordinator-ready artifact, or return an unavailable artifact. */
export function parseWorkerClaimsObject(raw, { taskId = null, lane = null } = {}) {
  const result = validateAvailable(raw, { taskId, lane });
  if (result.ok) return result.artifact;
  return unavailableWorkerClaims({ taskId, lane, reason: `malformed claims manifest: ${result.errors.join("; ")}` });
}

/** Parse the worker's separate fenced JSON manifest from final text. */
export function parseWorkerClaims(text, { taskId = null, lane = null } = {}) {
  const source = typeof text === "string" ? text : "";
  const blocks = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const candidates = blocks.filter((block) => block.includes(WORKER_CLAIMS_SCHEMA));
  if (candidates.length !== 1) {
    return unavailableWorkerClaims({
      taskId,
      lane,
      reason: candidates.length === 0 ? "worker did not provide a claims manifest" : "worker provided multiple claims manifests",
    });
  }
  try {
    return parseWorkerClaimsObject(JSON.parse(candidates[0]), { taskId, lane });
  } catch (error) {
    return unavailableWorkerClaims({ taskId, lane, reason: `malformed claims manifest: ${error.message}` });
  }
}

/** A strict format check used by callers that need to distinguish malformed
 * worker output from a valid, empty manifest. */
export function workerClaimsFormat(text) {
  const source = typeof text === "string" ? text : "";
  const blocks = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const candidates = blocks.filter((block) => block.includes(WORKER_CLAIMS_SCHEMA));
  if (candidates.length !== 1) return { valid: false, reason: candidates.length === 0 ? "claims manifest missing" : "multiple claims manifests" };
  try {
    const raw = JSON.parse(candidates[0]);
    const parsed = parseWorkerClaimsObject(raw);
    return { valid: claimsAvailable(parsed), reason: claimsAvailable(parsed) ? null : parsed.reason };
  } catch (error) {
    return { valid: false, reason: `malformed claims manifest: ${error.message}` };
  }
}

export function claimsAvailable(artifact) {
  return artifact?.schema === WORKER_CLAIMS_SCHEMA && artifact.status === "available";
}

/** Persist even an unavailable artifact so the refusal is auditable. */
export function writeWorkerClaimsArtifact(filePath, artifact) {
  writeFileSync(filePath, `${JSON.stringify(artifact ?? unavailableWorkerClaims({}), null, 2)}\n`);
  return filePath;
}

/**
 * Compare independently supplied claims with a coordinator-computed diff.
 * Callers must check `claimsAvailable` first; unavailable claims are never an
 * empty claim set and therefore never produce a false zero-divergence result.
 */
export function claimsArtifactDivergence({ claimedPaths = [], materialClaims = [], diffPaths = [] } = {}) {
  const normalizedClaimed = [...new Set((claimedPaths ?? []).map(normalizeClaimPath).filter(Boolean))];
  const diffSet = new Set((diffPaths ?? []).map(normalizeClaimPath).filter(Boolean));
  const claimedSet = new Set(normalizedClaimed);
  const findings = [];
  for (const claimedPath of normalizedClaimed) {
    if (diffSet.has(claimedPath)) continue;
    findings.push({
      id: `divergence-claimed-${findings.length + 1}`,
      severity: "high",
      location: claimedPath,
      rationale: `A change to "${claimedPath}" was claimed but the integrated diff does not contain it.`,
      suggestedCorrection: "Establish whether the work was actually done; a report narrating changes that do not exist must fail, not pass.",
      disposition: "open",
    });
  }
  for (const claim of materialClaims ?? []) {
    const missing = (claim?.paths ?? []).map(normalizeClaimPath).filter(Boolean).find((claimPath) => !diffSet.has(claimPath));
    if (missing) {
      findings.push({
        id: `divergence-material-${claim.id || findings.length + 1}`,
        severity: "high",
        location: missing,
        rationale: `Material claim "${claim.summary || claim.id}" is not supported by the integrated diff at "${missing}".`,
        suggestedCorrection: "Reconcile the material claim with the actual artifact before re-review.",
        disposition: "open",
      });
    }
  }
  for (const diffPath of diffSet) {
    if (claimedSet.has(diffPath)) continue;
    findings.push({
      id: `divergence-unexplained-${findings.length + 1}`,
      severity: "medium",
      location: diffPath,
      rationale: `"${diffPath}" changed in the integration but no claim reported it.`,
      suggestedCorrection: "Attribute the change to a task or remove it before re-review.",
      disposition: "open",
    });
  }
  return findings;
}
