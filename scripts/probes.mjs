import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolvePathCommand, runResolved } from "./path-resolve.mjs";

/**
 * Doctor probes. Every probe returns { id, status, detail, ...evidence } where
 * status is exactly PASS, FAIL, or SKIPPED. A probe reports only what it
 * executed and observed — reachability is never inferred from configuration,
 * and a probe that could not run its check reports FAIL with the reason, never
 * PASS by absence of error.
 */

export function probeCli(id, commandName, { env = process.env, platform = process.platform, timeoutMs = 20_000 } = {}) {
  const resolved = resolvePathCommand(commandName, { env, platform });
  if (!resolved) {
    return { id, status: "FAIL", detail: `"${commandName}" not found on PATH`, path: null, version: null };
  }
  const run = runResolved(resolved, ["--version"], { env, platform, timeoutMs });
  if (!run.ok) {
    const reason = run.timedOut ? `timed out after ${timeoutMs}ms` : (run.error ?? `exited ${run.status}: ${run.stderr.trim() || run.stdout.trim() || "no output"}`);
    return { id, status: "FAIL", detail: `resolved to ${resolved} but --version failed: ${reason}`, path: resolved, version: null };
  }
  const version = `${run.stdout}${run.stderr}`.trim().split(/\r?\n/)[0] ?? "";
  return { id, status: "PASS", detail: version || "(no version output)", path: resolved, version: version || null };
}

async function fetchJson(url, options, timeoutMs) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON body reported raw */ }
  return { httpStatus: response.status, body, text };
}

/**
 * Discover one available model on an Anthropic-compatible local endpoint.
 * Ollama exposes /api/tags; LM Studio (and OpenAI-compatible proxies such as
 * LiteLLM) expose /v1/models. Try both; report honestly when neither answers.
 */
async function discoverModel(baseUrl, timeoutMs) {
  try {
    const tags = await fetchJson(`${baseUrl}/api/tags`, { method: "GET" }, timeoutMs);
    const name = tags.body?.models?.[0]?.name;
    if (typeof name === "string" && name) return { model: name, via: "/api/tags" };
  } catch { /* fall through */ }
  try {
    const models = await fetchJson(`${baseUrl}/v1/models`, { method: "GET" }, timeoutMs);
    const id = models.body?.data?.[0]?.id;
    if (typeof id === "string" && id) return { model: id, via: "/v1/models" };
  } catch { /* fall through */ }
  return { model: null, via: null };
}

/**
 * A REAL Anthropic Messages request — the spec forbids inferring endpoint
 * health from a port being open. PASS requires a well-formed message response
 * with content from an actual model.
 */
export async function probeMessagesEndpoint(id, baseUrl, { timeoutMs = 45_000, discoveryTimeoutMs = 5_000 } = {}) {
  let discovery;
  try {
    discovery = await discoverModel(baseUrl, discoveryTimeoutMs);
  } catch (error) {
    return { id, status: "FAIL", detail: `unreachable: ${error.message}`, baseUrl, model: null, durationMs: null };
  }
  if (!discovery.model) {
    return { id, status: "FAIL", detail: "endpoint did not list any available model (server down, or no model loaded)", baseUrl, model: null, durationMs: null };
  }
  const started = Date.now();
  try {
    const result = await fetchJson(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "local",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: discovery.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    }, timeoutMs);
    const durationMs = Date.now() - started;
    const content = result.body?.content;
    const ok = result.httpStatus === 200 && result.body?.type === "message" && Array.isArray(content) && content.length > 0;
    if (!ok) {
      return {
        id, status: "FAIL", baseUrl, model: discovery.model, durationMs,
        detail: `HTTP ${result.httpStatus}: ${result.text.slice(0, 200)}`,
      };
    }
    return {
      id, status: "PASS", baseUrl, model: discovery.model, durationMs,
      detail: `Messages OK via ${discovery.model} (discovered via ${discovery.via}) in ${durationMs}ms`,
    };
  } catch (error) {
    return { id, status: "FAIL", baseUrl, model: discovery.model, durationMs: Date.now() - started, detail: `Messages request failed: ${error.message}` };
  }
}

/** Extract a rigor-skill version from a host's skill install, honestly UNKNOWN when absent. */
function skillVersion(hostRoot, skillName) {
  const skillFile = path.join(hostRoot, skillName, "SKILL.md");
  if (!existsSync(skillFile)) return { present: false, version: null, file: skillFile };
  const text = readFileSync(skillFile, "utf8");
  const match = text.match(/\bv(\d+\.\d+\.\d+)\b/);
  return { present: true, version: match ? match[1] : null, file: skillFile };
}

/**
 * Skill-version parity across coordinator hosts (spec §2.4): the .claude vs
 * .codex drift is a known live bug class. PASS only when every present host
 * reports the same parseable version. A single present host is PASS with
 * detail. No present hosts is FAIL — the discipline layer is missing.
 */
export function probeSkillParity(id, skillHosts, skillName) {
  const findings = Object.entries(skillHosts).map(([host, root]) => ({ host, root, ...skillVersion(root, skillName) }));
  const present = findings.filter((f) => f.present);
  if (present.length === 0) {
    return { id, status: "FAIL", detail: `${skillName} not installed under any coordinator host`, hosts: findings };
  }
  const unparsed = present.filter((f) => f.version === null);
  if (unparsed.length) {
    return { id, status: "FAIL", detail: `version unreadable for: ${unparsed.map((f) => f.host).join(", ")}`, hosts: findings };
  }
  const versions = [...new Set(present.map((f) => f.version))];
  if (versions.length > 1) {
    const spread = present.map((f) => `${f.host}=v${f.version}`).join(", ");
    return { id, status: "FAIL", detail: `version mismatch across hosts: ${spread}`, hosts: findings };
  }
  const absent = findings.filter((f) => !f.present).map((f) => f.host);
  const note = absent.length ? ` (absent on: ${absent.join(", ")})` : "";
  return { id, status: "PASS", detail: `v${versions[0]} on ${present.map((f) => f.host).join(", ")}${note}`, hosts: findings };
}

/** Enumerate installed skills per host root, for the doctor's information section. */
export function listSkills(hostRoot) {
  if (!existsSync(hostRoot)) return null;
  try {
    return readdirSync(hostRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return null;
  }
}
