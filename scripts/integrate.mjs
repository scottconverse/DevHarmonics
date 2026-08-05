import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { acquireFileLock } from "./slots.mjs";
import { resolvePathCommand, runResolved } from "./path-resolve.mjs";
import { superviseProcess } from "./supervise.mjs";

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
  "tampercheck-findings",
  "tampercheck-unavailable",
  "merge-conflict",
]);

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
  const lockPath = path.join(evidenceRoot, "locks", `${repoKey}.lock`);
  const lock = await acquireFileLock(lockPath, { taskId, repository }, { timeoutMs: 60_000, retryMs: 25 });

  const gates = {
    emptyDiff: { status: "pending", detail: null },
    tampercheck: { status: "skipped", detail: "not invoked" },
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
    const resolvedTampercheck = resolvePathCommand(tampercheckCommand, { env });
    if (!resolvedTampercheck) {
      gates.tampercheck = { status: "refused", detail: `tampercheck command not found on PATH: "${tampercheckCommand}"`, exitCode: null, timedOut: false };
      reason = "tampercheck-unavailable";
      return { integrated: false, reason, integrationHead: null, gates, evidencePath: writeEvidence() };
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
      const identity = runResolved(resolvedTampercheck, ["--version"], { env, timeoutMs: 20_000 });
      const reported = `${identity.stdout}${identity.stderr}`.trim().split(/\r?\n/)[0] ?? "";
      // A real CLI answers --version with a bare semantic version. An
      // echo-a-sentence stub does not. Shape, not exact value: version
      // pinning was tried and rejected — it locked out operators running a
      // different tampercheck release while adding no security, since a stub
      // author can print whatever string is expected.
      const looksLikeVersion = /^v?\d+\.\d+\.\d+/.test(reported);
      const versionMatches = !expectedTampercheckVersion || reported.includes(expectedTampercheckVersion);
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
      gates.tampercheckIdentity = { status: "pass", detail: `verified ${reported} at ${resolvedTampercheck}` };
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
        env,
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

    // Both gates passed: merge. Create integrationBranch at baseRef if it
    // does not already exist in the repository, then merge inside a
    // temporary worktree checked out on that branch — never the user's own
    // checkout — so the branch ref itself advances only on a clean merge.
    const branchExists = git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${integrationBranch}`]).ok;
    if (!branchExists) {
      const createBranch = git(repository, ["branch", integrationBranch, baseRef]);
      if (!createBranch.ok) fail(`could not create integration branch "${integrationBranch}": ${createBranch.stderr.trim()}`);
    }

    const mergeWorktree = addWorktree(repository, integrationBranch, { detach: false });
    if (!mergeWorktree.ok) fail(`could not create worktree for integration branch "${integrationBranch}": ${mergeWorktree.stderr}`);
    try {
      const mergeRes = gitIn(mergeWorktree.worktreePath, ["merge", "--no-ff", workerBranch, "-m", `integrate ${taskId}`]);
      if (!mergeRes.ok) {
        conflictPaths = conflictingPaths(mergeWorktree.worktreePath);
        // No automatic conflict repair — abort back to the pre-merge state
        // so the integration branch is left exactly as it was.
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
      const headRes = gitIn(mergeWorktree.worktreePath, ["rev-parse", "HEAD"]);
      integrationHead = headRes.stdout.trim();
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

export const INTEGRATION_REASONS = REASONS;
