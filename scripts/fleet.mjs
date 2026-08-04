import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Ported (with adaptation) from codex-factory scripts/factory-fleet.mjs (same
 * owner, Apache-2.0, live-fire-tested 2026-08). The source modeled two
 * provider families (ollama vs openai); DevHarmonics has three worker LANES
 * instead (spec §2.2: acp, http, subprocess — this module covers "http" and
 * "subprocess", the two lanes that have candidates to qualify and select
 * among). A candidate here is:
 *
 *   { id, lane: "subprocess"|"http", provider, model, tier, runtimeVersion,
 *     digest?, baseUrl? (http only), paid: boolean }
 *
 * id convention: `${lane}:${provider}:${model}`, e.g.
 * "subprocess:codex:gpt-5.6-luna" or "http:ollama:qwen2.5:7b".
 *
 * Kept verbatim in spirit from the source: candidateFingerprint (exact
 * fingerprint = identity + runtime + harness), currentQualification (latest
 * exact-fingerprint PASS wins), tierFit/TIER_RANK, and selectCandidate's
 * free-local-first scoring plus its benchmark gate for roles that make real
 * workspace edits.
 *
 * NOT ported: codexLauncher/detectCodexRuntimeVersion (DevHarmonics resolves
 * and probes CLI runtimes via scripts/path-resolve.mjs and scripts/probes.mjs
 * instead) and Ollama's own HTTP fetching (scripts/probes.mjs owns that
 * transport — discoverCandidates below takes already-fetched JSON payloads,
 * never fetches itself).
 */

export const QUALIFICATION_HARNESSES = Object.freeze({
  analysis: "analysis-exact-artifact-v1",
  benchmark: "structured-reasoning-v1",
  structured_write: "structured-file-worktree-v1",
  // NEW vs. the source: the http lane's tool-calling qualification. Local
  // models talk to workers over the Anthropic-Messages-compatible HTTP
  // surface (scripts/messages-client.mjs) rather than a CLI's own tool
  // adapter, so whether a given local model can actually drive tool_use
  // reliably is its own qualification, gated like "analysis" below (no
  // benchmark gate — see BENCHMARK_GATED_ROLES).
  tool_use: "messages-tool-use-v1",
});

export const TIER_RANK = Object.freeze({ economy: 1, standard: 2, premium: 3 });

// Roles that additionally require a passing "benchmark" qualification before
// a candidate may be selected for them. The source gated its paid-lane
// "workspace_write" role the same way as its free-lane "structured_write"
// role; DevHarmonics' three-lane candidate model merged those into the one
// "structured_write" role (real workspace edits are gated the same way
// regardless of which lane the candidate runs on), so only it appears here.
const BENCHMARK_GATED_ROLES = Object.freeze(["structured_write"]);

/**
 * Infer a coarse capability tier from a model name's parameter-count marker
 * (e.g. "qwen2.5:7b", "gemma-4-12b"). Ported verbatim from the source's
 * `inferLocalTier`. Models with no discernible size marker default to
 * "economy" — never guessed upward.
 */
export function inferLocalTier(model) {
  const billions = Number(model.match(/(?:^|[:_-])(\d+(?:\.\d+)?)b(?:$|[:_-])/i)?.[1]);
  if (!Number.isFinite(billions)) return "economy";
  if (billions <= 10) return "economy";
  if (billions <= 30) return "standard";
  return "premium";
}

function tierFit(candidateTier, requiredTier) {
  const difference = TIER_RANK[candidateTier] - TIER_RANK[requiredTier];
  return difference < 0 ? null : difference;
}

/**
 * Build the subprocess-lane candidate list from `config.clis` (codex/claude/
 * agy) crossed with each CLI's configured `workerModels`. `workerModels` is a
 * config-declared array per CLI — never hardcoded here — in the shape
 * `config.clis.<name>.workerModels`, e.g.:
 *
 *   { codex: ["gpt-5.6-luna"], claude: ["sonnet"], agy: ["default"] }
 *
 * Each entry is either a bare model-name string (tier defaults to "premium":
 * subscription-CLI capacity is assumed to be this factory's strongest, until
 * an operator overrides it) or `{ model, tier }` for an explicit tier.
 */
function discoverSubprocessCandidates(config, cliVersions) {
  const candidates = [];
  for (const name of ["codex", "claude", "agy"]) {
    const workerModels = config?.clis?.[name]?.workerModels;
    if (!Array.isArray(workerModels)) continue;
    for (const entry of workerModels) {
      const model = typeof entry === "string" ? entry : entry?.model;
      if (typeof model !== "string" || !model.trim()) {
        throw new Error(`config.clis.${name}.workerModels contains an entry without a model`);
      }
      const tier = (typeof entry === "object" && entry !== null && entry.tier) || "premium";
      if (!(tier in TIER_RANK)) {
        throw new Error(`Unsupported candidate tier for ${name}:${model}: ${tier}`);
      }
      candidates.push({
        id: `subprocess:${name}:${model}`,
        lane: "subprocess",
        provider: name,
        model,
        tier,
        runtimeVersion: cliVersions?.[name] ?? "unknown",
        paid: true,
      });
    }
  }
  return candidates;
}

/**
 * Build the http-lane candidate list from already-fetched discovery payloads:
 * `ollamaTags` is Ollama's `/api/tags` JSON (`models[].name` + optional
 * `models[].digest`), `lmstudioModels` is LM Studio's OpenAI-compatible
 * `/v1/models` JSON (`data[].id`). Malformed entries (missing/blank name or
 * id) are skipped rather than thrown on, matching the source's
 * `parseOllamaDiscovery` tolerance for a sparse/partial payload.
 */
function discoverHttpCandidates(config, ollamaTags, lmstudioModels) {
  const candidates = [];
  const ollamaBaseUrl = config?.endpoints?.ollama?.baseUrl ?? null;
  for (const item of Array.isArray(ollamaTags?.models) ? ollamaTags.models : []) {
    const model = typeof item?.name === "string" ? item.name : null;
    if (!model || !model.trim()) continue;
    candidates.push({
      id: `http:ollama:${model}`,
      lane: "http",
      provider: "ollama",
      model,
      tier: inferLocalTier(model),
      runtimeVersion: "unknown",
      baseUrl: ollamaBaseUrl,
      paid: false,
      ...(typeof item.digest === "string" && item.digest.trim() ? { digest: item.digest } : {}),
    });
  }
  const lmstudioBaseUrl = config?.endpoints?.lmstudio?.baseUrl ?? null;
  for (const item of Array.isArray(lmstudioModels?.data) ? lmstudioModels.data : []) {
    const model = typeof item?.id === "string" ? item.id : null;
    if (!model || !model.trim()) continue;
    candidates.push({
      id: `http:lmstudio:${model}`,
      lane: "http",
      provider: "lmstudio",
      model,
      tier: inferLocalTier(model),
      runtimeVersion: "unknown",
      baseUrl: lmstudioBaseUrl,
      paid: false,
    });
  }
  return candidates;
}

/**
 * Discover the full candidate pool: subprocess-lane candidates from
 * `config.clis[*].workerModels`, plus http-lane candidates from already-
 * fetched `ollamaTags` and `lmstudioModels` payloads. Neither payload is
 * fetched here — probes own that transport (scripts/probes.mjs).
 */
export function discoverCandidates({ config, ollamaTags = null, lmstudioModels = null, cliVersions = {} }) {
  return [
    ...discoverSubprocessCandidates(config, cliVersions),
    ...discoverHttpCandidates(config, ollamaTags, lmstudioModels),
  ];
}

/**
 * A candidate's exact-identity fingerprint for one qualification role: SHA-256
 * over its identity (id), runtime, digest (when known), tier, and the
 * versioned harness id for the role. Any change to any of these — a runtime
 * upgrade, a re-pulled model digest, a re-tiered candidate — produces a
 * different fingerprint, so a prior qualification result silently stops
 * applying rather than silently continuing to be trusted.
 */
export function candidateFingerprint(candidate, role) {
  const harness = QUALIFICATION_HARNESSES[role];
  if (!harness) throw new Error(`Unknown qualification role: ${role}`);
  return createHash("sha256").update(JSON.stringify({
    candidateId: candidate.id,
    runtimeVersion: candidate.runtimeVersion,
    digest: candidate.digest ?? null,
    tier: candidate.tier,
    harness,
  })).digest("hex");
}

/**
 * The current (latest, exact-fingerprint) qualification result for a
 * candidate + role, or null when none exists or the latest one failed.
 * "Latest" is by `finishedAt` (ISO string comparison) among records that
 * match this exact candidateId + role + fingerprint — a qualification run
 * against a stale fingerprint (old runtime/digest/tier) never counts, no
 * matter how recent it is.
 */
function currentQualification(candidate, qualifications, role) {
  const fingerprint = candidateFingerprint(candidate, role);
  const matching = qualifications.filter((item) =>
    item.candidateId === candidate.id
    && item.role === role
    && item.fingerprint === fingerprint);
  const latest = matching.reduce((selected, item) => {
    if (!selected) return item;
    return String(item.finishedAt ?? "") >= String(selected.finishedAt ?? "") ? item : selected;
  }, null);
  return latest?.passed === true ? latest : null;
}

/**
 * Select the best candidate currently qualified for `role` at >= `requiredTier`.
 * Free-local-first: an unpaid (http lane) candidate always outscores a paid
 * (subprocess lane) one, tie-broken by the tightest tier fit, then discovery
 * order, then id. Roles in BENCHMARK_GATED_ROLES additionally require a
 * passing current "benchmark" qualification — a candidate that can write
 * files but has never proven it reasons correctly does not get to write them.
 * Throws when nothing is eligible, rather than silently falling back.
 */
export function selectCandidate({
  candidates,
  qualifications,
  role,
  requiredTier = "economy",
  excludedCandidateIds = [],
}) {
  if (!(requiredTier in TIER_RANK)) throw new Error(`Unsupported required tier: ${requiredTier}`);
  if (!(role in QUALIFICATION_HARNESSES)) throw new Error(`Unknown qualification role: ${role}`);
  const excluded = new Set(excludedCandidateIds);
  const eligible = candidates.flatMap((candidate, discoveryIndex) => {
    if (excluded.has(candidate.id)) return [];
    const fit = tierFit(candidate.tier, requiredTier);
    if (fit === null || !currentQualification(candidate, qualifications, role)) return [];
    if (BENCHMARK_GATED_ROLES.includes(role) && !currentQualification(candidate, qualifications, "benchmark")) return [];
    return [{
      ...candidate,
      qualificationRole: role,
      qualificationFingerprint: candidateFingerprint(candidate, role),
      score: (candidate.paid ? 0 : 1_000) - fit * 10,
      discoveryIndex,
    }];
  }).sort((left, right) =>
    right.score - left.score
    || left.discoveryIndex - right.discoveryIndex
    || left.id.localeCompare(right.id));
  if (!eligible.length) throw new Error(`No currently qualified candidate can perform ${role} at ${requiredTier} tier`);
  const selected = eligible[0];
  return {
    ...selected,
    factors: [
      "exact current role qualification passed",
      `${selected.tier} tier satisfies ${requiredTier}`,
      selected.paid ? "metered candidate selected after free candidates were ineligible" : "free local candidate preferred",
    ],
  };
}

/**
 * The set of qualification roles each discovered candidate needs run against
 * its harness. Subprocess-lane candidates never get "tool_use" — that
 * qualification exists specifically for the http lane's Messages-API tool
 * calling (see QUALIFICATION_HARNESSES above); subprocess CLIs' tool use is
 * the CLI's own, already-verified adapter (scripts/providers.mjs), not
 * something this factory qualifies separately.
 */
export function qualificationPlan(candidates) {
  return candidates.flatMap((candidate) => {
    const roles = candidate.lane === "http"
      ? ["analysis", "benchmark", "structured_write", "tool_use"]
      : ["analysis", "benchmark", "structured_write"];
    return roles.map((role) => ({
      candidateId: candidate.id,
      lane: candidate.lane,
      provider: candidate.provider,
      model: candidate.model,
      role,
      harness: QUALIFICATION_HARNESSES[role],
      fingerprint: candidateFingerprint(candidate, role),
      ...(candidate.digest ? { digest: candidate.digest } : {}),
    }));
  });
}

/**
 * Read an append-only `qualifications.jsonl` file. Tolerates malformed lines
 * (rather than throwing) so one corrupted record does not take down every
 * other candidate's qualification history; malformed lines are counted, never
 * silently dropped without a trace.
 */
export function readQualifications(file) {
  if (!existsSync(file)) return { qualifications: [], malformedLines: 0 };
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  const qualifications = [];
  let malformedLines = 0;
  for (const line of lines) {
    try {
      qualifications.push(JSON.parse(line));
    } catch {
      malformedLines += 1;
    }
  }
  return { qualifications, malformedLines };
}

/** Append one qualification record as its own JSON line. */
export function appendQualification(file, record) {
  const resolved = path.resolve(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  appendFileSync(resolved, `${JSON.stringify(record)}\n`);
}
