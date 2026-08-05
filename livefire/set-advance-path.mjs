// LIVE-FIRE, ADVANCE PATH: prove a 2-repo set reaches setReady=true and actually
// ADVANCES both integration refs, with a REAL tampercheck binary, a REAL validator
// that genuinely executes the tests, and a REAL model reviewer.
//
// Why the earlier attempt could not reach READY (my fixture's fault, not the code's):
// Python sources with a `node` validator meant the tests were never executed, and
// the module repo imported the umbrella's module, which cannot resolve across
// separate repositories — so its tests could not pass in isolation either. A real
// reviewer correctly refused both times ("validator is a no-op", "api.py shows zero
// changes"). Fixed here: each repository is self-contained JavaScript, the client
// takes its dependency by injection so its tests pass alone, and the validator is
// `node --test`, which really runs them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Defaults to the repository this script ships in, so it runs in any clone.
const REPO = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.argv[3] || "claude-haiku-4-5-20251001";
const { planIntegrationSet, integrateSet } = await import(pathToFileURL(path.join(REPO, "scripts", "integration-set.mjs")));

const root = mkdtempSync(path.join(os.tmpdir(), "livefire-ready-"));
const evidenceRoot = path.join(root, "evidence");

function makeRepo(name, files, workerFiles) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  g(["config", "user.email", "livefire@example.invalid"]);
  g(["config", "user.name", "Live Fire"]);
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, f), body);
  g(["add", "-A"]); g(["commit", "-q", "-m", "base"]);
  g(["checkout", "-q", "-b", "worker"]);
  for (const [f, body] of Object.entries(workerFiles)) writeFileSync(path.join(dir, f), body);
  g(["add", "-A"]); g(["commit", "-q", "-m", `${name}: add optional email field, with tests`]);
  g(["checkout", "-q", "main"]);
  return { dir, g };
}

try {
  // umbrella: owns the API. Self-contained, with its own passing tests.
  const umbrella = makeRepo("umbrella",
    {
      "api.mjs": 'export function getUser(uid) {\n  return { id: uid };\n}\n',
      "api.test.mjs":
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { getUser } from "./api.mjs";\n\n'
        + 'test("returns the id", () => {\n  assert.deepEqual(getUser(7), { id: 7 });\n});\n',
    },
    {
      "api.mjs":
        '/**\n * Look up a user by id.\n *\n * @param {number|string} uid - the user id.\n'
        + ' * @param {{includeEmail?: boolean}} [options] - when includeEmail is true, an\n'
        + ' *   `email` key is included. Omitted entirely otherwise, so existing callers\n'
        + ' *   see an unchanged shape.\n * @returns {{id: *, email?: string|null}}\n */\n'
        + 'export function getUser(uid, options = {}) {\n'
        + '  const { includeEmail = false } = options;\n'
        + '  const user = { id: uid };\n'
        + '  if (includeEmail) user.email = null;\n'
        + '  return user;\n}\n',
      "api.test.mjs":
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { getUser } from "./api.mjs";\n\n'
        + 'test("returns the id", () => {\n  assert.deepEqual(getUser(7), { id: 7 });\n});\n\n'
        + 'test("omits email by default, so existing callers are unaffected", () => {\n'
        + '  assert.equal("email" in getUser(7), false);\n});\n\n'
        + 'test("includes email when requested", () => {\n'
        + '  assert.deepEqual(getUser(7, { includeEmail: true }), { id: 7, email: null });\n});\n\n'
        + 'test("an explicit false behaves like the default", () => {\n'
        + '  assert.deepEqual(getUser(9, { includeEmail: false }), { id: 9 });\n});\n',
    });

  // module: consumes the API by INJECTION, so its own tests pass in isolation.
  const moduleRepo = makeRepo("module",
    {
      "client.mjs": 'export function show(getUser, uid) {\n  return getUser(uid);\n}\n',
      "client.test.mjs":
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { show } from "./client.mjs";\n\n'
        + 'const fakeGetUser = (uid) => ({ id: uid });\n\n'
        + 'test("passes the id through", () => {\n  assert.deepEqual(show(fakeGetUser, 3), { id: 3 });\n});\n',
    },
    {
      "client.mjs":
        '/**\n * Fetch a user for display.\n *\n * @param {(uid: *, options?: {includeEmail?: boolean}) => object} getUser -\n'
        + ' *   injected API accessor, so this module is testable without the API package.\n'
        + ' * @param {number|string} uid - the user id.\n'
        + ' * @param {{withEmail?: boolean}} [options] - forwarded as includeEmail.\n'
        + ' * @returns {object} the user record returned by getUser.\n */\n'
        + 'export function show(getUser, uid, options = {}) {\n'
        + '  const { withEmail = false } = options;\n'
        + '  return getUser(uid, { includeEmail: withEmail });\n}\n',
      "client.test.mjs":
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { show } from "./client.mjs";\n\n'
        + '// Mirrors the umbrella API contract: email appears only when requested.\n'
        + 'const fakeGetUser = (uid, { includeEmail = false } = {}) =>\n'
        + '  (includeEmail ? { id: uid, email: null } : { id: uid });\n\n'
        + 'test("passes the id through", () => {\n  assert.deepEqual(show(fakeGetUser, 3), { id: 3 });\n});\n\n'
        + 'test("omits email by default", () => {\n  assert.equal("email" in show(fakeGetUser, 3), false);\n});\n\n'
        + 'test("forwards withEmail as includeEmail", () => {\n'
        + '  assert.deepEqual(show(fakeGetUser, 3, { withEmail: true }), { id: 3, email: null });\n});\n',
    });

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "umbrella", repository: umbrella.dir, workerBranch: "worker" },
      { repositoryId: "module", repository: moduleRepo.dir, workerBranch: "worker" },
    ],
  });

  const started = Date.now();
  const result = await integrateSet({
    set: plan,
    evidenceRoot,
    env: process.env,                                  // real tampercheck, real claude
    timeoutMs: 5 * 60_000,
    check: { command: "node", args: ["--test"] },      // REALLY runs the tests
    checkTimeoutMs: 120_000,
    reviewer: { lane: "subprocess", provider: "claude", model: MODEL },
    requireEvidence: ["validator", "review"],          // demand the strict floor
    goal: "Add an optional email field to the user lookup: the umbrella API gains an "
      + "includeEmail option (omitted by default so existing callers are unaffected), and the "
      + "module client forwards it as withEmail. Each repository is independently tested.",
  });

  console.log(`=== SET RESULT (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
  for (const m of result.members) {
    console.log(JSON.stringify({
      id: m.repositoryId,
      prepared: m.prepared,
      integrated: m.integrated,
      reason: m.reason,
      assurance: m.assurance,
      missingEvidence: m.missingEvidence,
      validator: m.gates?.validator?.status,
      validatorExit: m.gates?.validator?.exitCode,
      tampercheck: m.gates?.tampercheck?.status,
      finalArtifact: m.gates?.finalArtifact?.status,
      review: m.review,
      integrationHead: m.integrationHead?.slice(0, 12) ?? null,
    }));
  }
  console.log(`setReady=${result.setReady} blockedBy=${JSON.stringify(result.blockedBy)}`);

  for (const m of result.members) {
    if (m.review?.receipt && existsSync(m.review.receipt)) {
      const b = JSON.parse(readFileSync(m.review.receipt, "utf8"));
      console.log(`\n--- real review receipt (${m.repositoryId}): ${b.modelVerdict} by ${b.reviewer?.model} ---`);
      for (const f of b.findings ?? []) console.log(`  - [${f.severity}] ${f.id}: ${String(f.rationale ?? "").slice(0, 200)}`);
    }
  }

  let refsOk = true;
  for (const m of result.members) {
    const dir = m.repositoryId === "umbrella" ? umbrella.dir : moduleRepo.dir;
    const head = execFileSync("git", ["-C", dir, "rev-parse", m.integrationBranch], { encoding: "utf8" }).trim();
    const advanced = head !== m.baseCommit;
    // A real merge commit with two parents is the proof the change was integrated.
    const parents = advanced
      ? execFileSync("git", ["-C", dir, "rev-list", "--parents", "-n", "1", head], { encoding: "utf8" }).trim().split(" ").length - 1
      : 0;
    console.log(`ref ${m.repositoryId}: -> ${head.slice(0, 12)} advanced=${advanced} parents=${parents} (expected advanced=${result.setReady})`);
    if (advanced !== result.setReady) refsOk = false;
  }

  const proved = result.setReady === true && refsOk
    && result.members.every((m) => m.assurance === "validated+reviewed" && m.integrationHead);
  console.log(`\nLIVE-FIRE ADVANCE PATH: setReady=${result.setReady}, both refs advanced=${refsOk}, assurance=validated+reviewed => ${proved ? "PROVEN" : "NOT PROVEN"}`);
  process.exit(proved ? 0 : 7);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}
