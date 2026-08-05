import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { acquireFileLock } from "./slots.mjs";
import { resolvePathCommand, runResolved } from "./path-resolve.mjs";
import { superviseProcess } from "./supervise.mjs";
import { workerEnv } from "./worker-env.mjs";

/**
 * The single-repo integration engine: a completed worker branch enters the
 * run's integration line ONLY through two integrity gates (empty-diff, then
 * tampercheck) followed by a serial `--no-ff` merge. This is the factory's
 * whole claim of trustworthy integration — every refusal path below is fail
 * closed on purpose, and every attempt (pass or refusal) leaves a written
 * evidence bundle.
 *
 * House-style deviation, disclosed: the assignment names `runResolved` for
 * the tampercheck invocation, but `runResolved` (scripts/path-resolve.mjs)
 * never threads a `cwd` option into its spawnSync call — it always runs in
 * the CURRENT process's directory. Running the integrity gate against the
 * wrong directory would be a silent correctness hole in the gate itself, and
 * this task is scoped to touch only scripts/integrate.mjs and
 * test/integrate.test.mjs, so path-resolve.mjs cannot be fixed here.
 * `superviseProcess` (scripts/supervise.mjs) already resolves the same
 * .cmd/.bat ComSpec-wrap concern via the same `spawnPlan` helper, accepts a
 * real `cwd`, and is exactly the pattern local-patch.mjs itself uses to run
 * a resolved, worktree-scoped command with a timeout (see its Step 7). It is
 * used here instead, wired to the caller's `timeoutMs`.
 *
 * Git operations that only read refs/objects (merge-base, diff --stat,
 * rev-parse, branch-create) run directly against `repository` via
 * `-C repository` — precedent: local-patch.mjs runs `rev-parse
 * --is-inside-work-tree` and `worktree add`/`remove` directly against
 * task.repository the same way. These commands never touch or move the
 * user's own checked-out working tree; only operations that need real files
 * on disk (running tampercheck, performing the merge) use a temporary
 * worktree under os.tmpdir(), never the user's own checkout.
 */

const REASONS = Object.freeze([
  "empty-diff",
  // The recorded base is not an ancestor of the worker branch (audit 2026-08-05):
  // without this, the "pinned base" is not enforced and the delivered merge can
  // combine changes nobody gated.
  "stale-worker-base",
  "tampercheck-findings",
  "tampercheck-unavailable",
  // The post-merge scan of the exact commit being offered to the owner.
  "final-artifact-findings",
  "final-artifact-unavailable",
  "merge-conflict",
  // The task's own validator, run against the merged candidate.
  "validator-failed",
  "validator-unresolvable",
  // The integration branch ref could not be advanced (e.g. it is checked out in
  // the owner's own working tree) — refuse rather than yank it from under them.
  "integration-ref-locked",
  // Two-phase: the branch moved between the gated prepare and the finalize, so
  // the candidate is no longer the right successor.
  "integration-ref-moved",
  // A set member was fully gated but the set as a whole was blocked, so its ref
  // was deliberately NOT advanced (replaces the old advanced-but-set-blocked).
  "set-blocked-not-advanced",
]);

/** The one-per-repository serialization lock's path (ENG-005): derived from
 * the repository, never from a per-run evidence root. Exported so the
 * invariant is testable. */
export function integrationLockPath(repository) {
  const repoKey = createHash("sha256").update(path.resolve(repository)).digest("hex");
  return path.join(path.resolve(repository), ".devharmonics", "locks", `${repoKey}.lock`);
}

function fail(message) {
  throw new Error(`integrateWorkerBranch: ${message}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function assertGitRoot(repository) {
  assertNonEmptyString(repository, "repository");
  if (!existsSync(repository)) fail(`repository must be an existing directory: "${repository}"`);
  const probe = spawnSync("git", ["-C", repository, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") {
    fail(`repository is not a git root: "${repository}"`);
  }
}

/**
 * Fail-closed precondition check for the fields this function is never
 * allowed to proceed without. Throws before the lock is acquired and before
 * any evidence directory exists — mirroring local-patch.mjs's rule that a
 * malformed request (nothing valid to attribute an attempt to) is not itself
 * a recorded attempt.
 */
function validateInputs(input) {
  if (!input || typeof input !== "object") fail("arguments must be an object");
  assertGitRoot(input.repository);
  assertNonEmptyString(input.integrationBranch, "integrationBranch");
  assertNonEmptyString(input.workerBranch, "workerBranch");
  assertNonEmptyString(input.baseRef, "baseRef");
  assertNonEmptyString(input.taskId, "taskId");
  // Path-SAFETY (not the worker's strict lowercase slug): taskId flows into the
  // evidence directory name (`${taskId}-${uuid}`) and the lock metadata, so a
  // path separator, `..` traversal, drive colon, or Windows-illegal character
  // would escape evidenceRoot to an arbitrary disk location, or crash the
  // evidence write with no record at all (GAUNTLET, Agent B). But the
  // integration layer legitimately receives composite, mixed-case ids like
  // `${setId}-${repositoryId}`, so allow ordinary letters/digits/._- and only
  // forbid the dangerous shapes — enforcing the worker slug here breaks sets.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.taskId) || input.taskId.includes("..")) {
    throw new Error(`integrateWorkerBranch: taskId must be a path-safe id (letters, digits, ._- ; no separators, no "..", no drive colon), got: ${JSON.stringify(input.taskId)}`);
  }
  assertNonEmptyString(input.evidenceRoot, "evidenceRoot");
}

/** Run a read-only (refs/objects only) git command directly against the
 * user's repository. Never mutates the working tree — see file header. */
function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run a git command inside an already-created worktree directory. */
function gitIn(worktreePath, args) {
  const result = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Create a temporary worktree under os.tmpdir() for `ref`, never the user's
 * own checkout. `detach` checks out a bare commit instead of a branch name,
 * which avoids "branch already checked out elsewhere" refusals for a branch
 * this function does not intend to advance from this worktree. */
function addWorktree(repository, ref, { detach = false } = {}) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "dh-integrate-"));
  const worktreePath = path.join(parent, "wt");
  const args = ["worktree", "add"];
  if (detach) args.push("--detach");
  args.push(worktreePath, ref);
  const result = git(repository, args);
  if (!result.ok) {
    rmSync(parent, { recursive: true, force: true });
    return { ok: false, worktreePath: null, parent: null, stderr: result.stderr };
  }
  return { ok: true, worktreePath, parent };
}

/** Remove a temporary worktree in all paths (success or refusal): `git
 * worktree remove --force`, falling back to a raw rmSync if that fails for
 * any reason, then always remove the temp parent directory. */
function removeWorktree(repository, worktreePath, parent) {
  if (!worktreePath) return;
  const removed = spawnSync("git", ["-C", repository, "worktree", "remove", "--force", worktreePath], { encoding: "utf8" });
  if (removed.status !== 0) {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* already gone — fine */ }
  }
  if (parent) {
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* already gone — fine */ }
  }
}

function conflictingPaths(worktreePath) {
  const result = gitIn(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function integrateWorkerBranch({
  repository,
  integrationBranch,
  workerBranch,
  baseRef,
  taskId,
  evidenceRoot,
  tampercheckCommand = "tampercheck",
  // Falsification finding F-1 (docs/FALSIFICATION.md): a PATH-substituted
  // always-exit-0 stub was accepted as authoritative — demonstrated live.
  //
  // The defense is DEFAULT-ON but deliberately checks IDENTITY-SHAPE, not an
  // exact version: the resolved binary must answer --version with a bare
  // semantic version, which a real CLI does and an echo-a-sentence stub does
  // not. Version-pinning was tried first and rejected — it locked out any
  // operator running a different tampercheck release, trading a real
  // usability failure for no extra security (an attacker writing a stub can
  // print any string, including the expected version).
  //
  // Set expectedTampercheckVersion to a string to ALSO require that exact
  // version; set requireTampercheckIdentity false to disable the check.
  // Trust root (audit 2026-08-05): three independent auditors defeated the
  // identity check with a script named `tampercheck` that printed a
  // semver-shaped string and exited 0. A version *shape* cannot establish
  // identity, because the attacker writes the string. These bind the gate to a
  // specific artifact instead of to whatever PATH resolves:
  //   tampercheckPath           - an absolute path, skipping PATH resolution
  //   expectedTampercheckSha256 - pin the binary's content
  // Both are opt-in, but the resolved path AND its checksum are ALWAYS recorded
  // in the evidence, so a receipt can say which binary actually answered — the
  // thing it previously could not.
  // Two-phase readiness (multi-repo sets). When true, every gate runs and the
  // integration candidate is built and parked under a ref, but the integration
  // BRANCH is not moved — the caller finalizes only once all members passed, so a
  // blocked set leaves nothing advanced anywhere.
  // Optional validator: {command, args}. Run against the MERGED candidate — the
  // artifact actually being delivered — not the worker's pre-merge tree. `set` had
  // no validator at all (audit A2-6/A4-6), so a cross-repo change received LESS
  // scrutiny than a single-repo one.
  check = null,
  checkTimeoutMs = 10 * 60_000,
  deferRefUpdate = false,
  tampercheckPath = null,
  expectedTampercheckSha256 = null,
  expectedTampercheckVersion = null,
  requireTampercheckIdentity = true,
  env = process.env,
  timeoutMs = 120_000,
}) {
  validateInputs({ repository, integrationBranch, workerBranch, baseRef, taskId, evidenceRoot });

  // Serialize per repository: the lock is keyed off the resolved repository
  // path so two integrations into the SAME repo queue rather than
  // interleave, while unrelated repositories never contend with each other.
  const repoKey = createHash("sha256").update(path.resolve(repository)).digest("hex");
  // ENG-005 (audit): the lock was KEYED by repository but LOCATED under the
  // per-run evidence root, so two integrations into the same repo from
  // different runs/sets held two different lock files and never contended —
  // the stated "serialize per repository" invariant was false exactly when
  // D1's concurrency made it reachable. The lock now lives in the repo's own
  // state dir, one path per repository, so cross-invocation same-repo
  // integrations genuinely queue.
  const lockPath = integrationLockPath(repository);
  const lock = await acquireFileLock(lockPath, { taskId, repository }, { timeoutMs: 60_000, retryMs: 25 });

  const gates = {
    baseAncestry: { status: "pending", detail: null },
    emptyDiff: { status: "pending", detail: null },
    tampercheck: { status: "skipped", detail: "not invoked" },
    // The gate that scans the commit actually delivered, not just the worker's
    // own tree — see the candidate-first merge below.
    finalArtifact: { status: "skipped", detail: "not reached" },
    validator: { status: "skipped", detail: "no validator configured" },
  };
  let workerHead = null;
  let mergeBase = null;
  let integrationHead = null;
  let reason = null;
  let integrated = false;
  let conflictPaths = null;
  let tampercheckOutput = null;

  const evidenceId = `${taskId}-${randomUUID().split("-")[0]}`;
  const evidenceDir = path.join(evidenceRoot, evidenceId);

  const writeEvidence = () => {
    mkdirSync(evidenceDir, { recursive: true });
    if (tampercheckOutput !== null) {
      writeFileSync(path.join(evidenceDir, "tampercheck-output.txt"), tampercheckOutput);
    }
    const bundle = {
      taskId,
      repository: path.resolve(repository),
      baseRef,
      workerBranch,
      workerHead,
      integrationBranch,
      integrationHead,
      gates,
      reason,
      ...(conflictPaths ? { conflictingPaths: conflictPaths } : {}),
      integratedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(evidenceDir, "integration.json"), `${JSON.stringify(bundle, null, 2)}\n`);
    return path.join(evidenceDir, "integration.json");
  };

  try {
    // Resolve the two refs everything downstream depends on. A failure here
    // means baseRef/workerBranch do not resolve in this repository at all —
    // a malformed request, not a gate refusal, so it throws rather than
    // manufacturing a reason from the fixed REASONS list.
    const mergeBaseRes = git(repository, ["merge-base", baseRef, workerBranch]);
    if (!mergeBaseRes.ok) fail(`could not resolve merge-base(${baseRef}, ${workerBranch}): ${mergeBaseRes.stderr.trim()}`);
    mergeBase = mergeBaseRes.stdout.trim();

    const workerHeadRes = git(repository, ["rev-parse", workerBranch]);
    if (!workerHeadRes.ok) fail(`could not resolve workerBranch "${workerBranch}": ${workerHeadRes.stderr.trim()}`);
    workerHead = workerHeadRes.stdout.trim();

    const baseHeadRes = git(repository, ["rev-parse", baseRef]);
    if (!baseHeadRes.ok) fail(`could not resolve baseRef "${baseRef}": ${baseHeadRes.stderr.trim()}`);
    const baseHead = baseHeadRes.stdout.trim();

    // Gate 0: base ancestry. Found by an independent audit (2026-08-05) and
    // reproduced: a worker branch that does NOT descend from the recorded base
    // was accepted and merged. That makes the "pinned base" a label rather than
    // a constraint — the merge then silently combines the worker's tree with
    // whatever the base has since gained, producing a delivered tree that no
    // gate ever saw. `set` is the sharp edge here: it takes operator-supplied
    // worker branches and never checked them at all.
    //
    // Exact-base semantics: the base must be an ancestor of the worker branch
    // AND the merge-base must equal the base, so "pinned to this commit" means
    // the work genuinely started there.
    const isAncestor = git(repository, ["merge-base", "--is-ancestor", baseRef, workerBranch]).ok;
    if (!isAncestor || mergeBase !== baseHead) {
      gates.baseAncestry = {
        status: "refused",
        detail: !isAncestor
          ? `worker branch "${workerBranch}" (${workerHead.slice(0, 12)}) does not descend from the recorded base ${baseHead.slice(0, 12)} — the pinned base is not the branch's actual starting point`
          : `merge-base(${baseHead.slice(0, 12)}, ${workerBranch}) is ${mergeBase.slice(0, 12)}, not the recorded base — the branch has diverged from its pin`,
        baseHead,
        workerHead,
        mergeBase,
      };
      reason = "stale-worker-base";
      return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
    }
    gates.baseAncestry = { status: "pass", detail: `worker branch descends from the recorded base ${baseHead.slice(0, 12)} with merge-base equal to it`, baseHead, workerHead };

    // Gate 1: empty-diff. A validator that finds no fault with an empty diff
    // is not evidence of success — refuse before tampercheck is ever asked.
    const diffStatRes = git(repository, ["diff", "--stat", mergeBase, workerBranch]);
    if (!diffStatRes.ok) fail(`git diff --stat failed: ${diffStatRes.stderr.trim()}`);
    if (diffStatRes.stdout.trim().length === 0) {
      gates.emptyDiff = { status: "refused", detail: "worker branch has no changes relative to merge-base", diffStat: "" };
      reason = "empty-diff";
      return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
    }
    gates.emptyDiff = { status: "pass", detail: "worker branch changes files relative to merge-base", diffStat: diffStatRes.stdout };

    // Gate 2: tampercheck. Exit 0 is the only passing outcome; a crashed or
    // missing integrity gate NEVER counts as a pass (disclosed, not implied
    // green — and at this boundary, disclosed means refused).
    let resolvedTampercheck;
    if (tampercheckPath) {
      // An explicitly configured artifact: never consult PATH at all, so a
      // shadow binary earlier on PATH is structurally irrelevant.
      if (!path.isAbsolute(tampercheckPath) || !existsSync(tampercheckPath)) {
        gates.tampercheck = { status: "refused", detail: `tampercheckPath must be an existing absolute path, got: "${tampercheckPath}"`, exitCode: null, timedOut: false };
        reason = "tampercheck-unavailable";
        return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
      }
      resolvedTampercheck = tampercheckPath;
    } else {
      resolvedTampercheck = resolvePathCommand(tampercheckCommand, { env });
      if (!resolvedTampercheck) {
        gates.tampercheck = { status: "refused", detail: `tampercheck command not found on PATH: "${tampercheckCommand}"`, exitCode: null, timedOut: false };
        reason = "tampercheck-unavailable";
        return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
      }
    }

    // ALWAYS fingerprint the binary that is about to be trusted, pinned or not.
    // This is the evidence the old receipts could not provide: which artifact
    // answered. Unreadable is recorded as null rather than guessed.
    let tampercheckSha256 = null;
    let tampercheckLauncherShaped = false;
    try {
      const binaryBytes = readFileSync(resolvedTampercheck);
      tampercheckSha256 = createHash("sha256").update(binaryBytes).digest("hex");
      // ENG-002 (audit): pip console scripts are LAUNCHERS — a generated .EXE
      // or "#!...python" shim whose hash does NOT bind the package code in
      // site-packages that actually produces the verdict. Detect the shape
      // (a shebang, or a binary that references python) so the identity line
      // can say what the pin really binds instead of overclaiming.
      const head = binaryBytes.subarray(0, 2).toString("utf8");
      tampercheckLauncherShaped = head === "#!" || binaryBytes.includes("python") || binaryBytes.includes("Python");
    } catch {
      tampercheckSha256 = null;
    }
    gates.tampercheckBinary = {
      path: resolvedTampercheck,
      sha256: tampercheckSha256,
      source: tampercheckPath ? "configured-absolute-path" : "PATH-resolved",
      // QA-002 (audit): `pinned` records that a pin was REQUESTED; `verified`
      // records that the comparison actually PASSED. The old single flag made
      // a refused mismatch print "sha256 verified" — the failed strict mode
      // must never look like the succeeded strict mode.
      pinned: Boolean(expectedTampercheckSha256),
      verified: false,
      launcherShaped: tampercheckLauncherShaped,
    };

    // Checksum pin: the only local check a stub author cannot satisfy by
    // printing the expected string. Enforced independently of the shape check,
    // so pinning works even with requireTampercheckIdentity disabled.
    if (expectedTampercheckSha256) {
      const want = String(expectedTampercheckSha256).trim().toLowerCase();
      if (!tampercheckSha256 || tampercheckSha256 !== want) {
        gates.tampercheck = {
          status: "refused",
          detail: `tampercheck checksum mismatch: ${resolvedTampercheck} is sha256 ${tampercheckSha256 ?? "(unreadable)"}, expected ${want}`,
          exitCode: null,
          timedOut: false,
        };
        reason = "tampercheck-unavailable";
        return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
      }
      gates.tampercheckBinary.verified = true;
    }

    // Identity check before trusting the gate (falsification finding F-1,
    // 2026-08-05): the gate resolves from PATH, so a PATH-substituted
    // always-exit-0 stub deceived it in an adversarial trial. A worker
    // cannot reach this (a child cannot alter its parent's PATH, verified
    // in the same pass), so this is an operator-environment risk, not a
    // worker-escape — but a gate that cannot say WHICH tool answered is
    // not evidence. When expectedTampercheckVersion is set, the resolved
    // binary must self-report it or the gate refuses. The repo-side pinned
    // CI install (see docs/INTEGRATION-SETS.md's sibling, `devharmonics
    // onboard`) remains the independent second copy of this defense.
    if (requireTampercheckIdentity || expectedTampercheckVersion) {
      // C-2 consistency (GAUNTLET, Agent A): tampercheck runs with cwd inside
      // the untrusted worktree, so strip credentials from its env like every
      // other spawn — PATH survives, so it still resolves and runs.
      const identity = runResolved(resolvedTampercheck, ["--version"], { env: workerEnv(env).env, timeoutMs: 20_000 });
      const reported = `${identity.stdout}${identity.stderr}`.trim().split(/\r?\n/)[0] ?? "";
      // A real CLI answers --version with a bare semantic version. An
      // echo-a-sentence stub does not. Shape, not exact value: version
      // pinning was tried and rejected — it locked out operators running a
      // different tampercheck release while adding no security, since a stub
      // author can print whatever string is expected.
      const looksLikeVersion = /^v?\d+\.\d+\.\d+/.test(reported);
      // Extract the semver token and compare EXACTLY. A substring `includes`
      // let "12.1.0" satisfy a pin of "2.1.0" (also "2.1.0.99", "0.2.1.0") —
      // GAUNTLET, Agent B. Pinning stays off by default; when on it must not be
      // trivially bypassable by a superstring.
      const reportedVersion = (reported.match(/\d+\.\d+\.\d+(?:\.\d+)*/) ?? [])[0] ?? null;
      const versionMatches = !expectedTampercheckVersion || reportedVersion === String(expectedTampercheckVersion).trim();
      if (!identity.ok || !looksLikeVersion || !versionMatches) {
        gates.tampercheck = {
          status: "refused",
          detail: `tampercheck identity check failed: ${resolvedTampercheck} answered --version with "${reported || "(no output)"}"${expectedTampercheckVersion ? ` (expected ${expectedTampercheckVersion})` : " (expected a bare semantic version)"}`,
          exitCode: identity.status ?? null,
          timedOut: false,
        };
        reason = "tampercheck-unavailable";
        return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
      }
      gates.tampercheckIdentity = {
        status: "pass",
        // Say exactly what was and was NOT established. A semver shape is not an
        // identity; only the checksum pin is. Overstating this in the receipt is
        // what let three auditors call the gate deceptive.
        detail: expectedTampercheckSha256
          ? `verified ${reported} at ${resolvedTampercheck} (checksum-pinned)`
          : `${resolvedTampercheck} reported ${reported} — version SHAPE only, not a verified identity; set expectedTampercheckSha256 (or tampercheckPath) to bind the gate to a specific artifact`,
        resolvedPath: resolvedTampercheck,
        sha256: tampercheckSha256,
        identityEstablished: Boolean(expectedTampercheckSha256),
      };
    }

    const tcWorktree = addWorktree(repository, workerHead, { detach: true });
    if (!tcWorktree.ok) fail(`could not create worktree for tampercheck run: ${tcWorktree.stderr}`);
    let tcRun;
    try {
      tcRun = await superviseProcess({
        command: resolvedTampercheck,
        args: ["--from", mergeBase, "--to", workerHead],
        cwd: tcWorktree.worktreePath,
        timeoutMs,
        env: workerEnv(env).env,
      });
    } finally {
      removeWorktree(repository, tcWorktree.worktreePath, tcWorktree.parent);
    }

    tampercheckOutput = `${tcRun.stdout ?? ""}${tcRun.stderr ? `\n--- stderr ---\n${tcRun.stderr}` : ""}`;

    // A killed-by-timeout process's REPORTED exit code is not meaningful —
    // on Windows, a taskkill-terminated tree commonly reports exit code 1,
    // which would otherwise be misread as "findings" rather than "the gate
    // never finished". timedOut/spawn-error must be checked BEFORE exitCode
    // for exactly this reason (found live by this module's own test suite).
    if (tcRun.timedOut || tcRun.error) {
      gates.tampercheck = {
        status: "refused",
        detail: tcRun.timedOut ? "tampercheck timed out" : `tampercheck failed to run: ${tcRun.error}`,
        exitCode: tcRun.exitCode,
        timedOut: tcRun.timedOut,
        stdout: tcRun.stdout,
        stderr: tcRun.stderr,
      };
      reason = "tampercheck-unavailable";
      return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
    }

    if (tcRun.exitCode === 0) {
      gates.tampercheck = { status: "pass", detail: "tampercheck reported no findings", exitCode: 0, timedOut: false, stdout: tcRun.stdout };
    } else if (tcRun.exitCode === 1) {
      gates.tampercheck = {
        status: "refused",
        detail: "tampercheck reported findings",
        exitCode: 1,
        timedOut: false,
        stdout: tcRun.stdout,
        stderr: tcRun.stderr,
      };
      reason = "tampercheck-findings";
      return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
    } else {
      // exit 2, or any other non-0/1 exit: fold into the same fail-closed
      // refusal — a crashed gate is never a silent pass.
      gates.tampercheck = {
        status: "refused",
        detail: `tampercheck exited ${tcRun.exitCode}`,
        exitCode: tcRun.exitCode,
        timedOut: false,
        stdout: tcRun.stdout,
        stderr: tcRun.stderr,
      };
      reason = "tampercheck-unavailable";
      return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
    }

    // Both worker-side gates passed. Now build the integration CANDIDATE
    // WITHOUT moving any ref, gate the candidate itself, and advance the branch
    // only if that gate passes.
    //
    // Why candidate-first (audit 2026-08-05, reproduced): the previous flow
    // checked out the integration branch and merged into it, so the ref advanced
    // the moment the merge succeeded — and the only thing tampercheck had ever
    // scanned was the WORKER's tree. Whenever the integration branch sat ahead of
    // the base, git's clean auto-merge produced a combined tree that no gate had
    // seen, and it was handed to the owner as gated. Building the merge in a
    // DETACHED worktree makes the ref update the last action, which is both the
    // fix here and the shape multi-repo two-phase readiness needs.
    const branchExists = git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${integrationBranch}`]).ok;
    if (!branchExists) {
      const createBranch = git(repository, ["branch", integrationBranch, baseRef]);
      if (!createBranch.ok) fail(`could not create integration branch "${integrationBranch}": ${createBranch.stderr.trim()}`);
    }
    const preMergeRes = git(repository, ["rev-parse", integrationBranch]);
    if (!preMergeRes.ok) fail(`could not resolve integration branch "${integrationBranch}": ${preMergeRes.stderr.trim()}`);
    const preMergeHead = preMergeRes.stdout.trim();

    const mergeWorktree = addWorktree(repository, preMergeHead, { detach: true });
    if (!mergeWorktree.ok) fail(`could not create worktree for integration candidate: ${mergeWorktree.stderr}`);
    try {
      const mergeRes = gitIn(mergeWorktree.worktreePath, ["merge", "--no-ff", workerBranch, "-m", `integrate ${taskId}`]);
      if (!mergeRes.ok) {
        conflictPaths = conflictingPaths(mergeWorktree.worktreePath);
        // No automatic conflict repair. Nothing to undo on the branch itself:
        // the ref was never moved, so aborting the worktree merge is enough.
        gitIn(mergeWorktree.worktreePath, ["merge", "--abort"]);
        reason = "merge-conflict";
        return {
          integrated: false,
          reason,
          integrationHead: null,
          gates,
          conflictingPaths: conflictPaths,
          evidencePath: writeEvidence(),
        };
      }
      const candidateRes = gitIn(mergeWorktree.worktreePath, ["rev-parse", "HEAD"]);
      if (!candidateRes.ok) fail(`could not resolve the integration candidate commit: ${candidateRes.stderr.trim()}`);
      const candidateHead = candidateRes.stdout.trim();

      // FINAL-ARTIFACT GATE: scan the exact commit being offered, measured from
      // the base the owner pinned — "everything you are being asked to accept,
      // relative to where you started". Deliberately conservative: on a reused
      // integration branch this re-scans previously integrated work too, which
      // can refuse again rather than assume earlier passes still hold. Fail
      // closed is the house rule.
      const finalRun = await superviseProcess({
        command: resolvedTampercheck,
        args: ["--from", baseHead, "--to", candidateHead],
        cwd: mergeWorktree.worktreePath,
        timeoutMs,
        env: workerEnv(env).env,
      });
      tampercheckOutput = `${tampercheckOutput ?? ""}\n--- final artifact (${candidateHead.slice(0, 12)}) ---\n${finalRun.stdout ?? ""}${finalRun.stderr ? `\n--- stderr ---\n${finalRun.stderr}` : ""}`;

      // timedOut/error before exitCode — a taskkill'd tree reports 1 on Windows,
      // which would otherwise read as "findings" instead of "never finished".
      if (finalRun.timedOut || finalRun.error) {
        gates.finalArtifact = {
          status: "refused",
          detail: finalRun.timedOut ? "final-artifact tampercheck timed out" : `final-artifact tampercheck failed to run: ${finalRun.error}`,
          candidateHead,
          exitCode: finalRun.exitCode,
          timedOut: finalRun.timedOut,
        };
        reason = "final-artifact-unavailable";
        return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
      }
      if (finalRun.exitCode !== 0) {
        gates.finalArtifact = {
          status: "refused",
          detail: finalRun.exitCode === 1
            ? "final-artifact tampercheck reported findings on the merged commit — the delivered tree differs from the worker tree that passed"
            : `final-artifact tampercheck exited ${finalRun.exitCode}`,
          candidateHead,
          exitCode: finalRun.exitCode,
          timedOut: false,
          stdout: finalRun.stdout,
          stderr: finalRun.stderr,
        };
        reason = finalRun.exitCode === 1 ? "final-artifact-findings" : "final-artifact-unavailable";
        return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
      }
      gates.finalArtifact = {
        status: "pass",
        detail: `the delivered commit itself passed tampercheck (scanned ${baseHead.slice(0, 12)}..${candidateHead.slice(0, 12)})`,
        candidateHead,
        exitCode: 0,
        timedOut: false,
        stdout: finalRun.stdout,
      };

      // Optional validator, against the merged candidate. Runs after tampercheck
      // (cheap diff scan first, slow test suite second) and with a
      // credential-stripped environment, since it executes code from the tree the
      // untrusted worker just contributed to.
      if (check && typeof check.command === "string" && check.command.length > 0) {
        const checkEnv = workerEnv(env).env;
        const resolvedCheck = resolvePathCommand(check.command, { env: checkEnv });
        if (!resolvedCheck) {
          gates.validator = { status: "refused", detail: `validator command not found on PATH: "${check.command}"`, exitCode: null, timedOut: false };
          reason = "validator-unresolvable";
          return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
        }
        const validated = await superviseProcess({
          command: resolvedCheck,
          args: check.args ?? [],
          cwd: mergeWorktree.worktreePath,
          prompt: null,
          timeoutMs: checkTimeoutMs,
          env: checkEnv,
        });
        const failed = validated.timedOut || Boolean(validated.error) || validated.exitCode !== 0;
        gates.validator = {
          status: failed ? "refused" : "pass",
          detail: failed
            ? (validated.timedOut ? "validator timed out on the merged candidate" : `validator exited ${validated.exitCode} on the merged candidate`)
            : "validator passed against the merged candidate",
          command: [check.command, ...(check.args ?? [])].join(" "),
          candidateHead,
          exitCode: validated.exitCode,
          timedOut: validated.timedOut,
          stdoutTail: (validated.stdout ?? "").slice(-2000),
          stderrTail: (validated.stderr ?? "").slice(-2000),
        };
        if (failed) {
          reason = "validator-failed";
          return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
        }
      }

      // Two-phase mode (multi-repo sets): stop here with a fully gated candidate
      // and let the caller decide whether EVERY member passed before any ref in
      // any repository moves. The candidate is parked under a real ref so the
      // commit stays reachable (an unreferenced commit could be gc'd between
      // phases) and so it is inspectable if the set is abandoned.
      if (deferRefUpdate) {
        const candidateRef = `refs/devharmonics/candidate/${taskId}`;
        const parked = git(repository, ["update-ref", candidateRef, candidateHead]);
        if (!parked.ok) fail(`could not park integration candidate at ${candidateRef}: ${parked.stderr.trim()}`);
        reason = null;
        return {
          integrated: false,
          prepared: true,
          candidateHead,
          candidateRef,
          preMergeHead,
          reason,
          integrationHead: null,
          gates,
          evidencePath: writeEvidence(),
        };
      }

      // Single-repo mode: advance the ref — the last action, after every gate.
      // Fails if the owner has this branch checked out; refuse rather than move it.
      const update = git(repository, ["branch", "-f", integrationBranch, candidateHead]);
      if (!update.ok) {
        gates.finalArtifact.detail += " (but the branch ref could not be advanced)";
        reason = "integration-ref-locked";
        return {
          integrated: false,
          reason,
          integrationHead: null,
          gates,
          evidencePath: writeEvidence(),
        };
      }
      integrationHead = candidateHead;
      integrated = true;
      reason = null;
      return { integrated, reason, integrationHead, gates, evidencePath: writeEvidence() };
    } finally {
      removeWorktree(repository, mergeWorktree.worktreePath, mergeWorktree.parent);
    }
  } finally {
    lock.release();
  }
}

/**
 * Phase 2 of two-phase integration: advance the integration branch to a candidate
 * that already passed every gate in a `deferRefUpdate` run.
 *
 * Refuses if the branch no longer points where phase 1 left it — something else
 * moved it in between, so the gated candidate is no longer the right successor.
 * Never merges, never re-gates; it only moves a ref that a gated candidate earned.
 */
export function finalizeIntegrationCandidate({ repository, integrationBranch, candidateHead, expectedPreMergeHead, candidateRef = null }) {
  const current = git(repository, ["rev-parse", integrationBranch]);
  if (!current.ok) {
    return { ok: false, reason: "integration-ref-locked", detail: `could not resolve "${integrationBranch}": ${current.stderr.trim()}` };
  }
  const head = current.stdout.trim();
  if (head !== expectedPreMergeHead) {
    return {
      ok: false,
      reason: "integration-ref-moved",
      detail: `"${integrationBranch}" is now ${head.slice(0, 12)}, but the gated candidate was prepared against ${String(expectedPreMergeHead).slice(0, 12)}`,
    };
  }
  const update = git(repository, ["branch", "-f", integrationBranch, candidateHead]);
  if (!update.ok) {
    return { ok: false, reason: "integration-ref-locked", detail: update.stderr.trim() };
  }
  if (candidateRef) git(repository, ["update-ref", "-d", candidateRef]);
  return { ok: true, integrationHead: candidateHead };
}

/** Drop a parked candidate — the set was blocked, so nothing is delivered. */
export function abandonIntegrationCandidate({ repository, candidateRef }) {
  if (!candidateRef) return { ok: true };
  const res = git(repository, ["update-ref", "-d", candidateRef]);
  return { ok: res.ok, detail: res.ok ? null : res.stderr.trim() };
}

/** Put an integration branch back where it was, used if a later member of the
 * same set fails to finalize after earlier ones already advanced. */
export function rollbackIntegrationRef({ repository, integrationBranch, toCommit }) {
  const res = git(repository, ["branch", "-f", integrationBranch, toCommit]);
  return { ok: res.ok, detail: res.ok ? null : res.stderr.trim() };
}

export const INTEGRATION_REASONS = REASONS;
