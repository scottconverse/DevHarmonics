/**
 * Worker child-process environment hygiene.
 *
 * SPEC §2.5 states plainly: "Credential-shaped env vars stripped from worker
 * child processes; provider auth stays provider-owned." That claim was TRUE
 * only inside the ACP lane (which strips Claude session markers because a
 * live bug forced it) and FALSE for the subprocess and HTTP lanes, which
 * passed the operator's entire environment through untouched — including
 * every API key on the box. A specification asserting a safety boundary the
 * code does not implement is the exact false-green this factory exists to
 * catch, so the boundary is implemented here, once, for every lane.
 *
 * What this is NOT: a sandbox. A determined worker with shell access can
 * read credentials from disk, from a keychain, or from a config file. This
 * strips the *ambient inheritance* path — the one that hands a worker every
 * secret in the operator's shell for free, with no intent required. That is
 * a real and worthwhile boundary; it is not containment, and the manual says
 * so rather than implying otherwise.
 *
 * Deliberately NOT stripped: subscription CLI auth. `codex exec`, `claude
 * -p`, and `agy -p` authenticate through their own provider-owned sessions
 * (OAuth tokens in the CLI's own store, not env vars). Stripping API-key
 * variables therefore does not break them — it removes a fallback path that
 * would let a worker spend against a key the owner never intended to use for
 * that task, which is the subscription-first principle enforced mechanically
 * instead of merely stated.
 */

/** Exact names to remove. Provider API keys and cloud credentials. */
const EXACT_STRIP = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "REPLICATE_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "PYPI_TOKEN",
  "TWINE_PASSWORD",
  // Connection strings carry an embedded password/secret but contain no
  // credential *word* for the shape pass to catch (GAUNTLET-2026-08-05 M-3).
  "DATABASE_URL",
  "REDIS_URL",
  "MONGODB_URI",
  "SENTRY_DSN",
  // base64 registry credentials — carries no credential word (GAUNTLET, Agent A)
  "DOCKER_AUTH_CONFIG",
]);

/**
 * Shape-based removal for the long tail no fixed list can enumerate. A name
 * CONTAINING one of these markers is credential-shaped; an allowlist of benign
 * lookalikes keeps ordinary tooling working (e.g. a var that merely points at a
 * *path* rather than carrying a secret).
 *
 * GAUNTLET-2026-08-05 M-3: the markers previously required a leading underscore
 * (`_TOKEN`, `_PASSWORD`, ...), so undelimited real names slipped through —
 * `DBPASSWORD`, `SESSIONTOKEN`, `STRIPESECRETKEY`, `SERVICECREDENTIALS`. The
 * distinctive credential words match as bare substrings now; the still-ambiguous
 * short ones (`PASS`, `PWD`) stay underscore-guarded so `PWD`/`OLDPWD`/`COMPASS`
 * are not swept up.
 */
const SHAPE_MARKERS = [
  "API_KEY", "APIKEY",
  "SECRET",
  "TOKEN",
  "PASSWORD", "PASSWD",
  "_PASS", "_PWD",
  "CREDENTIAL",
  "PRIVATE_KEY", "PRIVATEKEY",
  "WEBHOOK", // a webhook URL is a post-as-me capability secret (GAUNTLET, Agent A)
];
const SHAPE_ALLOW = new Set([
  "SSH_AUTH_SOCK",       // a socket path, not a secret
  "GPG_TTY",
  "CREDENTIAL_HELPER",
]);

/** Session markers that make a nested provider CLI refuse to launch. */
const SESSION_MARKER_PREFIXES = ["CLAUDE_CODE_", "CODEX_SESSION_"];
const SESSION_MARKER_EXACT = new Set(["CLAUDECODE", "CLAUDE_CODE", "CODEXCODE"]);

export function isCredentialShaped(name) {
  const upper = String(name).toUpperCase();
  if (SHAPE_ALLOW.has(upper)) return false;
  if (EXACT_STRIP.has(upper)) return true;
  return SHAPE_MARKERS.some((marker) => upper.includes(marker));
}

export function isSessionMarker(name) {
  const upper = String(name).toUpperCase();
  if (SESSION_MARKER_EXACT.has(upper)) return true;
  return SESSION_MARKER_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Build the environment a worker child process actually receives.
 * Returns both the env and the list of removed names, so a receipt can
 * record what was stripped rather than leaving it invisible — the boundary
 * is evidence, not just behavior.
 */
export function workerEnv(env = process.env, { stripSessionMarkers = true } = {}) {
  const out = {};
  const stripped = [];
  for (const [key, value] of Object.entries(env)) {
    if (isCredentialShaped(key) || (stripSessionMarkers && isSessionMarker(key))) {
      stripped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { env: out, stripped: stripped.sort() };
}
