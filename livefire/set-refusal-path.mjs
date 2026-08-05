// LIVE-FIRE: `set` with a REAL tampercheck binary and a REAL model reviewer.
// No injected deps, no fake gates. Two real git repos, real worker branches, the
// real installed tampercheck, and runReview -> runWorker -> real `claude` over the
// subprocess lane (prompt on stdin, per the B-1 fix — so this also proves the
// multi-line reviewer prompt survives the Windows ComSpec wrap for real).
//
// Answers A4-5 (no retained real-provider/real-gate proof) for the set path.
// Costs real subscription tokens: one reviewer call per member.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Defaults to the repository this script ships in, so it runs in any clone.
const REPO = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.argv[3] || "claude-haiku-4-5-20251001";
const { planIntegrationSet, integrateSet } = await import(pathToFileURL(path.join(REPO, "scripts", "integration-set.mjs")));

const root = mkdtempSync(path.join(os.tmpdir(), "livefire-set-"));
const evidenceRoot = path.join(root, "evidence");

// `extras` lets the worker commit ship accompanying files (e.g. tests), so the
// change a real reviewer sees is genuinely complete. This is making the work good,
// not steering the model — an incomplete change SHOULD be refused, and was.
function makeRepo(name, filename, baseBody, workerBody, extras = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  g(["config", "user.email", "livefire@example.invalid"]);
  g(["config", "user.name", "Live Fire"]);
  writeFileSync(path.join(dir, filename), baseBody);
  g(["add", "-A"]); g(["commit", "-q", "-m", "base"]);
  // a real worker branch cut from the pinned base
  g(["checkout", "-q", "-b", "worker"]);
  writeFileSync(path.join(dir, filename), workerBody);
  for (const [fname, body] of Object.entries(extras)) writeFileSync(path.join(dir, fname), body);
  g(["add", "-A"]); g(["commit", "-q", "-m", `${name}: real change`]);
  g(["checkout", "-q", "main"]);
  return { dir, base: g(["rev-parse", "main"]), g };
}

try {
  // An umbrella + module pair, the CivicSuite shape: a coordinated API bump.
  const umbrella = makeRepo("umbrella", "api.py",
    'def get_user(uid):\n    """Return a user by id."""\n    return {"id": uid}\n',
    'def get_user(uid, include_email=False):\n'
    + '    """Return a user by id.\n\n'
    + '    Args:\n        uid: the user id.\n        include_email: when True, include an "email" key.\n\n'
    + '    Returns:\n        dict: {"id": uid}, plus "email" when include_email is True.\n    """\n'
    + '    user = {"id": uid}\n    if include_email:\n        user["email"] = None\n    return user\n',
    {
      "test_api.py":
        'from api import get_user\n\n\n'
        + 'def test_defaults_to_no_email():\n    assert get_user(7) == {"id": 7}\n\n\n'
        + 'def test_includes_email_when_requested():\n    assert get_user(7, include_email=True) == {"id": 7, "email": None}\n\n\n'
        + 'def test_existing_callers_are_unaffected():\n    """The new parameter is optional, so the old call shape still works."""\n'
        + '    assert "email" not in get_user(1)\n',
    });
  const moduleRepo = makeRepo("module", "client.py",
    'from api import get_user\n\ndef show(uid):\n    return get_user(uid)\n',
    'from api import get_user\n\n\n'
    + 'def show(uid, with_email=False):\n'
    + '    """Return a user for display, optionally including the email field.\n\n'
    + '    Args:\n        uid: the user id.\n        with_email: forwarded to get_user as include_email.\n\n'
    + '    Returns:\n        dict: the user record from get_user.\n    """\n'
    + '    return get_user(uid, include_email=with_email)\n',
    {
      "test_client.py":
        'from client import show\n\n\n'
        + 'def test_defaults_to_no_email():\n    assert show(3) == {"id": 3}\n\n\n'
        + 'def test_forwards_the_flag():\n    assert show(3, with_email=True) == {"id": 3, "email": None}\n\n\n'
        + 'def test_default_call_shape_is_backward_compatible():\n    """Existing callers passing only uid keep the old behavior."""\n'
        + '    assert "email" not in show(3)\n',
    });

  const plan = planIntegrationSet({
    members: [
      { repositoryId: "umbrella", repository: umbrella.dir, workerBranch: "worker" },
      { repositoryId: "module", repository: moduleRepo.dir, workerBranch: "worker" },
    ],
  });
  console.log("plan:", JSON.stringify(plan.members.map((m) => ({ id: m.repositoryId, base: m.baseCommit.slice(0, 12), branch: m.integrationBranch })), null, 1));

  const started = Date.now();
  const result = await integrateSet({
    set: plan,
    evidenceRoot,
    env: process.env,          // REAL PATH: real tampercheck, real claude
    timeoutMs: 5 * 60_000,
    reviewer: { lane: "subprocess", provider: "claude", model: MODEL },
    check: { command: "node", args: ["-e", "process.exit(0)"] },
    checkTimeoutMs: 60_000,
    goal: "Add an optional include_email flag to get_user and thread it through the client, consistently across both repositories.",
    // NO deps -> the real runReview -> real runWorker -> real `claude`
  });

  console.log(`\n=== SET RESULT (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
  console.log(JSON.stringify({
    setReady: result.setReady,
    blockedBy: result.blockedBy,
    members: result.members.map((m) => ({
      id: m.repositoryId,
      prepared: m.prepared,
      integrated: m.integrated,
      reason: m.reason,
      review: m.review,
      tampercheck: m.gates?.tampercheck?.status,
      tampercheckBinary: m.gates?.tampercheckBinary?.path,
      tampercheckSha256: m.gates?.tampercheckBinary?.sha256?.slice(0, 16),
      finalArtifact: m.gates?.finalArtifact?.status,
      integrationHead: m.integrationHead?.slice(0, 12) ?? null,
    })),
  }, null, 2));

  // Prove a REAL model answered: read a review receipt off disk.
  for (const m of result.members) {
    if (m.review?.receipt && existsSync(m.review.receipt)) {
      const bundle = JSON.parse(readFileSync(m.review.receipt, "utf8"));
      console.log(`\n=== REAL REVIEW RECEIPT (${m.repositoryId}) ===`);
      console.log(JSON.stringify({
        schema: bundle.schema,
        modelVerdict: bundle.modelVerdict,
        verdict: bundle.verdict,
        reviewer: bundle.reviewer,
        divergence: bundle.divergence,
        findings: bundle.findings?.length ?? 0,
        diffStat: (bundle.diffStat ?? "").trim().split("\n").slice(0, 3),
      }, null, 2));
      // Print the ACTUAL findings: the only way to tell a legitimately strict
      // reviewer from a gate that always refuses.
      for (const f of bundle.findings ?? []) {
        console.log(`  - [${f.severity}] ${f.id} @ ${f.location ?? "-"}: ${String(f.rationale ?? "").slice(0, 220)}`);
      }
    }
  }

  // Did the refs actually advance (or correctly not)?
  for (const m of result.members) {
    const dir = m.repositoryId === "umbrella" ? umbrella.dir : moduleRepo.dir;
    const head = execFileSync("git", ["-C", dir, "rev-parse", m.integrationBranch], { encoding: "utf8" }).trim();
    const advanced = head !== m.baseCommit;
    console.log(`ref ${m.repositoryId}: ${m.integrationBranch} -> ${head.slice(0, 12)} (advanced=${advanced}, expected=${result.setReady})`);
    if (advanced !== result.setReady) { console.log("!! REF STATE DISAGREES WITH setReady"); process.exitCode = 7; }
  }
  console.log(`\nLIVE-FIRE VERDICT: real tampercheck + real ${MODEL} reviewer drove a 2-repo set to setReady=${result.setReady}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* leave it if locked */ }
}
