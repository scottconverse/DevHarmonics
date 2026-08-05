import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  integrateWorkerBranch,
  finalizeIntegrationCandidate,
  abandonIntegrationCandidate,
  rollbackIntegrationRef,
} from "./integrate.mjs";
import { runReview } from "./review.mjs";
import { assuranceFor, missingEvidence } from "./assurance.mjs";

/**
 * Multi-repo extension of scripts/integrate.mjs (design contract:
 * docs/INTEGRATION-SETS.md; spec: docs/SPEC.md §2.3 / §4 slice 7). An
 * integration SET is the per-repository {repository, baseCommit,
 * workerBranch, integrationBranch} tuple a cross-repo change is judged as:
 * one task per repository, each pinned to a retained base commit at PLAN
 * time, readiness judged as a set (all-or-nothing). This module owns
 * planning (resolve + validate the tuple) and orchestration (fan the
 * already-proven single-repo gates from integrate.mjs out across
 * repositories); it never re-implements the empty-diff/tampercheck/merge
 * gates themselves — those stay exactly integrate.mjs's job.
 *
 * House-style precedent followed here (scripts/integrate.mjs,
 * scripts/review.mjs): the small git-plumbing helpers below (assertGitRoot,
 * git, resolveCommit) are deliberately duplicated rather than imported —
 * integrate.mjs does not export them, and this task is scoped to touch only
 * docs/INTEGRATION-SETS.md, scripts/integration-set.mjs, and
 * test/integration-set.test.mjs. What IS imported, never duplicated, is
 * integrateWorkerBranch itself — the actual gate/merge logic.
 */

// Set-level reasons layered on top of integrate.mjs's own REASONS
// (empty-diff / tampercheck-findings / tampercheck-unavailable /
// merge-conflict, all unchanged and reused as-is via integrateWorkerBranch).
const SET_REASONS = Object.freeze(["advanced-but-set-blocked", "integration-error"]);

function failPlan(message) {
  throw new Error(`planIntegrationSet: ${message}`);
}

function failIntegrate(message) {
  throw new Error(`integrateSet: ${message}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    failPlan(`${label} must be a non-empty string`);
  }
}

/** Read-only git command directly against `repository` — never mutates the
 * working tree (same precedent as integrate.mjs/review.mjs). */
function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertGitRoot(repository) {
  if (!existsSync(repository)) failPlan(`repository must be an existing directory: "${repository}"`);
  const probe = git(repository, ["rev-parse", "--is-inside-work-tree"]);
  if (!probe.ok || probe.stdout.trim() !== "true") {
    failPlan(`repository is not a git root: "${repository}"`);
  }
}

/** Resolve `ref` to its exact commit hash in `repository`, or fail closed —
 * a ref that does not resolve at PLAN time is a malformed request, not
 * something to discover later mid-integration. */
function resolveCommit(repository, ref, label) {
  const result = git(repository, ["rev-parse", "--verify", "--quiet", ref]);
  if (!result.ok || !result.stdout.trim()) {
    failPlan(`${label} "${ref}" does not resolve to a commit in repository "${repository}"`);
  }
  return result.stdout.trim();
}

/** Case-insensitive path comparison on win32 only — ported from the v1
 * TypeScript design's comparablePath (src/integration-sets.ts), used to
 * catch the same local git root listed under two different repositoryIds. */
function comparableRoot(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Plan an integration set: validate and resolve every member into an exact
 * {repository, baseCommit, workerBranch, integrationBranch} tuple. Fully
 * synchronous and read-only against every repository (git plumbing only —
 * no worktrees, no branches created here). Throws a descriptively-prefixed
 * Error (fail closed) for anything malformed; nothing is left ambiguous for
 * integrateSet to discover later.
 */
export function planIntegrationSet({ members }) {
  if (!Array.isArray(members) || members.length === 0) {
    failPlan("members must be a non-empty array");
  }

  const setId = `set-${randomUUID().slice(0, 8)}`;
  const seenRepositoryIds = new Set();
  const seenRoots = new Map(); // comparableRoot(repository) -> repositoryId

  const resolvedMembers = members.map((member) => {
    if (!member || typeof member !== "object") failPlan("each member must be an object");

    assertNonEmptyString(member.repositoryId, "member.repositoryId");
    const repositoryId = member.repositoryId.trim();
    // repositoryId becomes a directory segment under evidenceRoot/members/
    // in integrateSet — reject anything that could escape that directory.
    if (/[\\/]/.test(repositoryId) || repositoryId === "." || repositoryId === "..") {
      failPlan(`member.repositoryId must not contain a path separator or be "." or "..": "${repositoryId}"`);
    }
    if (seenRepositoryIds.has(repositoryId)) failPlan(`duplicate repositoryId "${repositoryId}"`);
    seenRepositoryIds.add(repositoryId);

    assertNonEmptyString(member.repository, "member.repository");
    const repository = path.resolve(member.repository);
    assertGitRoot(repository);

    const root = comparableRoot(repository);
    const existingId = seenRoots.get(root);
    if (existingId) {
      failPlan(`repositories "${existingId}" and "${repositoryId}" resolve to the same repository root: "${repository}"`);
    }
    seenRoots.set(root, repositoryId);

    assertNonEmptyString(member.workerBranch, "member.workerBranch");
    const workerBranch = member.workerBranch.trim();
    resolveCommit(repository, workerBranch, "workerBranch");

    // baseRef is optional; undefined/null/"" means "default to current HEAD".
    // An explicitly-provided-but-blank string is a caller error, not a
    // request to default — assertNonEmptyString below will throw on it.
    const baseRefOmitted = member.baseRef === undefined || member.baseRef === null || member.baseRef === "";
    if (!baseRefOmitted) assertNonEmptyString(member.baseRef, "member.baseRef");
    const baseRef = baseRefOmitted ? "HEAD" : member.baseRef.trim();
    const baseCommit = resolveCommit(repository, baseRef, "baseRef");

    const integrationBranch = typeof member.integrationBranch === "string" && member.integrationBranch.trim().length > 0
      ? member.integrationBranch.trim()
      : `devharmonics/integration/${setId}`;

    return { repositoryId, repository, baseRef, baseCommit, workerBranch, integrationBranch };
  });

  return { setId, members: resolvedMembers };
}

/**
 * Integrate every member of a planned set CONCURRENTLY. Safe under
 * Promise.all because (a) planIntegrationSet already refuses a plan where
 * two members share a repository — there is no same-repo race for this
 * function to worry about — and (b) integrateWorkerBranch itself serializes
 * any contention on a single repository via its own file lock
 * (scripts/slots.mjs). Nothing here re-implements that lock.
 *
 * Each member integrates against its PINNED baseCommit (not the possibly
 * since-moved baseRef branch tip) — the whole point of the plan step is that
 * the set is judged against the commit it was planned against.
 *
 * Set semantics are all-or-nothing: setReady is true only when every member
 * integrated. A refused member does NOT roll back members that already
 * integrated; those are reported honestly as "advanced-but-set-blocked"
 * rather than faked as either a full success or an atomic rollback this
 * factory does not have (docs/INTEGRATION-SETS.md).
 */
export async function integrateSet({
  set,
  evidenceRoot,
  env,
  timeoutMs,
  check = null,
  checkTimeoutMs = undefined,
  // Independent review per member (audit A2-6/A4-6). Runs on each member's GATED
  // CANDIDATE during the prepare phase — before anything is finalized — so a
  // NOT_READY review blocks the whole set with nothing advanced anywhere.
  reviewer = null,
  goal = null,
  // Evidence floor for the SET (A4-6). A set whose members lack demanded evidence
  // does not reach setReady, so nothing advances anywhere.
  requireEvidence = [],
  deps = {},
}) {
  if (!set || typeof set !== "object") failIntegrate("set must be an object (from planIntegrationSet)");
  if (!Array.isArray(set.members) || set.members.length === 0) failIntegrate("set.members must be a non-empty array");
  if (typeof set.setId !== "string" || set.setId.trim().length === 0) failIntegrate("set.setId must be a non-empty string");
  if (typeof evidenceRoot !== "string" || evidenceRoot.trim().length === 0) failIntegrate("evidenceRoot must be a non-empty string");

  // PHASE 1 — prepare every member: all gates run and a gated candidate commit is
  // built per repository, but NO integration ref moves anywhere yet.
  const attempts = await Promise.all(set.members.map(async (member) => {
    const memberEvidenceRoot = path.join(evidenceRoot, "members", member.repositoryId);
    try {
      const outcome = await integrateWorkerBranch({
        repository: member.repository,
        integrationBranch: member.integrationBranch,
        workerBranch: member.workerBranch,
        baseRef: member.baseCommit,
        taskId: `${set.setId}-${member.repositoryId}`,
        evidenceRoot: memberEvidenceRoot,
        deferRefUpdate: true,
        // Every member gets the same validator, run against its own merged
        // candidate. A set that cannot pass its checks never advances any member.
        check,
        ...(checkTimeoutMs === undefined ? {} : { checkTimeoutMs }),
        env,
        timeoutMs,
      });
      return { member, outcome, threw: null };
    } catch (error) {
      // A thrown integrateWorkerBranch call (e.g. the repository mutated out
      // from under a planned set between plan and integrate) must never take
      // down the whole Promise.all and lose every OTHER member's outcome —
      // the same "a crashed gate is never silently dropped" rule integrate.mjs
      // itself applies to a crashed tampercheck. Recorded as refused, never
      // as a pass, and the set as a whole is still reported.
      return {
        member,
        outcome: { integrated: false, prepared: false, reason: "integration-error", integrationHead: null, gates: null, evidencePath: null },
        threw: error?.message ?? String(error),
      };
    }
  }));

  const gatesPassed = attempts.every(({ outcome }) => outcome.prepared === true);

  // PHASE 1b — independent review of each gated candidate. Sequential: reviewers
  // are model calls, and stampeding them buys nothing. A member whose review is
  // not READY is treated exactly like a failed gate, so the set blocks and phase 2
  // never runs. Findings are attributed to a single member via scopeFinding; an
  // unattributable finding is left unscoped rather than guessed at.
  const reviewByRepositoryId = new Map();
  if (reviewer && gatesPassed) {
    const { runReview: reviewFn = runReview } = deps;

    // Cross-repo context, found necessary by live-fire (2026-08-05): a reviewer
    // that sees ONE repository while being judged against a SET-WIDE goal
    // concludes its sibling's half is missing and refuses. A real reviewer said
    // exactly that — "client.py calls get_user(include_email=...) but api.py shows
    // zero changes" — so every coordinated change would have been blocked. Each
    // member's reviewer is now told the scope of its own review and shown the
    // sibling members' diffstats. Diffstats are ARTIFACTS, not worker narration,
    // so this respects the artifact-lens rule.
    const memberDiffStats = new Map();
    for (const { member, outcome } of attempts) {
      const stat = git(member.repository, ["diff", "--stat", member.baseCommit, outcome.candidateHead]);
      memberDiffStats.set(member.repositoryId, stat.ok ? stat.stdout.trim() : "(diffstat unavailable)");
    }

    for (const { member, outcome } of attempts) {
      const siblings = attempts
        .filter(({ member: other }) => other.repositoryId !== member.repositoryId)
        .map(({ member: other }) => `--- ${other.repositoryId} (reviewed separately) ---\n${memberDiffStats.get(other.repositoryId)}`)
        .join("\n\n");
      const scopedGoal = [
        goal ?? `integration set ${set.setId}`,
        "",
        `SCOPE: you are reviewing ONLY the repository "${member.repositoryId}" of a ${attempts.length}-repository coordinated set.`,
        "The other repositories are reviewed independently by their own reviews, and the set is all-or-nothing:",
        "it advances only if every repository passes. Do NOT refuse this repository because a change that belongs to",
        "a sibling repository is absent from this diff — judge only this repository's own correctness and coherence.",
        siblings ? `\nSibling repositories in this set, for context only:\n\n${siblings}` : "",
      ].join("\n");

      // Thread the validator's real result through, so the reviewer is not left
      // refusing for "no proof the tests ran" when a check actually ran.
      const v = outcome.gates?.validator;
      const checkReceiptsSummary = v && v.status !== "skipped"
        ? `Validator: ${v.command}\nexit code: ${v.exitCode}${v.timedOut ? " (timed out)" : ""}\nstatus: ${v.status}\n${(v.stdoutTail || "").slice(-800)}`
        : "No validator was configured for this set, so no executed check receipts exist for it.";

      try {
        const review = await reviewFn({
          repository: member.repository,
          // Review the CANDIDATE, not the branch: the branch has not moved yet.
          integrationBranch: outcome.candidateRef,
          baseRef: member.baseCommit,
          goal: scopedGoal,
          checkReceiptsSummary,
          reviewer,
          evidenceRoot: path.join(evidenceRoot, "members", member.repositoryId),
          env,
          timeoutMs,
          deps,
        });
        reviewByRepositoryId.set(member.repositoryId, {
          verdict: review?.verdict ?? "NOT_READY",
          findings: review?.findings?.length ?? 0,
          divergence: review?.divergence === null || review?.divergence === undefined ? null : review.divergence.length,
          receipt: review?.reviewReceiptPath ?? null,
        });
      } catch (error) {
        // A crashed reviewer is never a pass — same rule as a crashed gate.
        reviewByRepositoryId.set(member.repositoryId, {
          verdict: "NOT_READY",
          findings: 0,
          divergence: null,
          receipt: null,
          threw: error?.message ?? String(error),
        });
      }
    }
  }
  const reviewsPassed = !reviewer || [...reviewByRepositoryId.values()].every((r) => r.verdict === "READY");

  // Evidence floor, per member: absent evidence is missing evidence (fail closed).
  const missingByRepositoryId = new Map();
  for (const { member, outcome } of attempts) {
    const validatorPassed = outcome?.gates?.validator?.status === "pass";
    const reviewPassed = reviewByRepositoryId.get(member.repositoryId)?.verdict === "READY";
    missingByRepositoryId.set(member.repositoryId, {
      assurance: assuranceFor({ validatorPassed, reviewPassed }),
      missing: missingEvidence(requireEvidence, { validatorPassed, reviewPassed }),
    });
  }
  const evidenceSatisfied = [...missingByRepositoryId.values()].every((e) => e.missing.length === 0);
  const allPrepared = gatesPassed && reviewsPassed && evidenceSatisfied;
  const abandonAll = () => {
    for (const { member, outcome } of attempts) {
      if (outcome?.candidateRef) abandonIntegrationCandidate({ repository: member.repository, candidateRef: outcome.candidateRef });
    }
  };

  // PHASE 2 — commit the set. Only reached when EVERY member produced a gated
  // candidate, so a blocked set leaves every repository exactly as it was. This is
  // the atomicity the docs previously only claimed: the old flow advanced each
  // member as it passed and relabelled survivors "advanced-but-set-blocked",
  // leaving a half-applied cross-repo change on disk.
  let finalizeFailure = null;
  const advanced = [];
  if (allPrepared) {
    // Sequential: a failure mid-way is then trivially rewindable.
    for (const { member, outcome } of attempts) {
      const res = finalizeIntegrationCandidate({
        repository: member.repository,
        integrationBranch: member.integrationBranch,
        candidateHead: outcome.candidateHead,
        expectedPreMergeHead: outcome.preMergeHead,
        candidateRef: outcome.candidateRef,
      });
      if (!res.ok) { finalizeFailure = { member, ...res }; break; }
      advanced.push({ member, outcome });
    }
    if (finalizeFailure) {
      // Rewind whatever already advanced, so the set is still all-or-nothing.
      for (const { member, outcome } of advanced) {
        rollbackIntegrationRef({ repository: member.repository, integrationBranch: member.integrationBranch, toCommit: outcome.preMergeHead });
      }
      advanced.length = 0;
      abandonAll();
    }
  } else {
    abandonAll();
  }

  const setReady = allPrepared && finalizeFailure === null;

  const members = attempts.map(({ member, outcome, threw }) => {
    // A member that passed every gate but whose set was blocked is reported as
    // gated-but-deliberately-not-advanced — not as a success, and not as a
    // half-applied change the operator has to remember to avoid.
    const review = reviewByRepositoryId.get(member.repositoryId) ?? null;
    const reviewBlocked = review !== null && review.verdict !== "READY";
    const evidence = missingByRepositoryId.get(member.repositoryId) ?? { assurance: "gates-only", missing: [] };
    const evidenceBlocked = evidence.missing.length > 0;
    const gatedButBlocked = outcome?.prepared === true && !reviewBlocked && !evidenceBlocked && !setReady;
    return {
      repositoryId: member.repositoryId,
      integrated: setReady,
      prepared: outcome?.prepared === true,
      assurance: evidence.assurance,
      ...(requireEvidence.length > 0 ? { requiredEvidence: requireEvidence, missingEvidence: evidence.missing } : {}),
      ...(review ? { review } : {}),
      reason: setReady
        ? null
        : reviewBlocked
          ? "review-not-ready"
          : evidenceBlocked
            ? `insufficient-evidence (missing: ${evidence.missing.join(", ")})`
            : gatedButBlocked
              ? "set-blocked-not-advanced"
              : (outcome?.reason ?? null),
      integrationHead: setReady ? (outcome.candidateHead ?? null) : null,
      evidencePath: outcome?.evidencePath ?? null,
      baseCommit: member.baseCommit,
      workerBranch: member.workerBranch,
      integrationBranch: member.integrationBranch,
      gates: outcome?.gates ?? null,
      ...(threw ? { threw } : {}),
      ...(finalizeFailure && finalizeFailure.member.repositoryId === member.repositoryId
        ? { finalizeRefused: { reason: finalizeFailure.reason, detail: finalizeFailure.detail } }
        : {}),
    };
  });

  // A member blocks the set if it failed to prepare OR its own review refused it;
  // a member that was gated and reviewed fine is not itself a blocker.
  const blockedBy = members
    .filter((m) => m.prepared !== true
      || m.reason === "review-not-ready"
      || (m.missingEvidence?.length ?? 0) > 0)
    .map((m) => m.repositoryId);
  if (finalizeFailure && !blockedBy.includes(finalizeFailure.member.repositoryId)) {
    blockedBy.push(finalizeFailure.member.repositoryId);
  }

  mkdirSync(evidenceRoot, { recursive: true });
  const bundle = {
    schema: "devharmonics-integration-set-v1",
    setId: set.setId,
    setReady,
    blockedBy,
    members,
    createdAt: new Date().toISOString(),
  };
  const evidencePath = path.join(evidenceRoot, "set.json");
  writeFileSync(evidencePath, `${JSON.stringify(bundle, null, 2)}\n`);

  return { setId: set.setId, setReady, members, blockedBy, evidencePath };
}

/**
 * Attribute a blocking review finding to exactly one member repository of an
 * integration set, or refuse. A finding can name a repository two ways: an
 * explicit finding.repositoryId field, or a "<repositoryId>:" prefix on
 * finding.location — but a location prefix is only recognized when it
 * exactly matches a KNOWN member id. An unrecognized colon-prefix (e.g. a
 * plain "path/to/file.py:12" location with no repository component at all)
 * is deliberately NOT treated as naming an unknown repository: syntax alone
 * cannot tell whether "path/to/file.py" in that string was meant as a
 * repositoryId or is just an ordinary path that happens to contain a colon
 * before the line number, so an unmatched prefix falls through to "names no
 * repositoryId" rather than a fabricated guess.
 *
 * Zero candidates, more than one DISTINCT candidate (an explicit
 * repositoryId disagreeing with a location prefix counts as two), or a
 * single candidate absent from knownRepositoryIds all refuse. This function
 * never picks a "most likely" repository — the caller must treat any
 * non-scoped finding as blocking the WHOLE set (docs/INTEGRATION-SETS.md).
 */
export function scopeFinding(finding, knownRepositoryIds) {
  const known = Array.isArray(knownRepositoryIds)
    ? knownRepositoryIds.filter((id) => typeof id === "string" && id.length > 0)
    : [];

  if (!finding || typeof finding !== "object") {
    return { scoped: false, repositoryId: null, reason: "finding is not an object" };
  }

  const candidates = new Set();

  const explicitId = typeof finding.repositoryId === "string" ? finding.repositoryId.trim() : "";
  if (explicitId) candidates.add(explicitId);

  const location = typeof finding.location === "string" ? finding.location : "";
  for (const id of known) {
    if (location.startsWith(`${id}:`)) candidates.add(id);
  }

  if (candidates.size === 0) {
    return {
      scoped: false,
      repositoryId: null,
      reason: 'finding names no repositoryId (no repositoryId field and no known "<repositoryId>:" prefix in location)',
    };
  }
  if (candidates.size > 1) {
    return {
      scoped: false,
      repositoryId: null,
      reason: `finding names multiple repositories: ${[...candidates].sort().join(", ")}`,
    };
  }

  const [only] = candidates;
  if (!known.includes(only)) {
    return { scoped: false, repositoryId: null, reason: `finding names an unknown repositoryId: "${only}"` };
  }
  return { scoped: true, repositoryId: only, reason: null };
}

export const INTEGRATION_SET_REASONS = SET_REASONS;
