import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runWorker as defaultRunWorker } from "./run-worker.mjs";
import { sendMessages as defaultSendMessages } from "./messages-client.mjs";
import { promptSha256 } from "./receipts.mjs";

/**
 * The review stage: an independent artifact-lens reviewer (sees only the
 * diff and executed check receipts, NEVER worker/implementor narration) plus
 * a deterministic claims-vs-diff divergence gate. Ported from
 * devharmonics-v1's src/review.ts and src/prompts.ts (reviewerPrompt,
 * parseReviewerResponse, claimsArtifactDivergence), simplified to a single
 * artifact lens and a plain claimed-paths list rather than v1's full
 * multi-lens quorum machinery — this factory does not (yet) have a quorum
 * layer, so only the pieces that stand on their own were ported.
 *
 * House-style precedent followed here (scripts/integrate.mjs,
 * scripts/local-patch.mjs): read-only ref/object git commands run directly
 * against the caller's `repository`, never touching or moving the user's own
 * checkout; anything that needs real files on disk for a subprocess reviewer
 * to `Read` runs inside a temporary DETACHED worktree under os.tmpdir(),
 * always removed in a `finally`. The small git/worktree helpers below are
 * deliberately duplicated from integrate.mjs rather than imported — this
 * task is scoped to touch only scripts/review.mjs and test/review.test.mjs
 * (same disclosed tradeoff local-patch.mjs makes for its TASK_ID_PATTERN).
 *
 * Fail-closed rule carried forward from every other stage in this codebase:
 * a reviewer that never produced a usable verdict (crashed subprocess, dead
 * HTTP endpoint, empty response) is NEVER treated as a pass. It is reported
 * as NOT_READY with a synthesized "reviewer-unavailable" finding, same as
 * integrate.mjs refuses on a crashed tampercheck rather than silently
 * proceeding.
 */

const MAX_DIFF_CHARS = 200_000;
const SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);
const DISPOSITIONS = Object.freeze(["open", "accepted", "rejected", "fixed"]);

function fail(message) {
  throw new Error(`runReview: ${message}`);
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

/** Create a temporary DETACHED worktree under os.tmpdir() for `ref` — never
 * the user's own checkout. Detach avoids "branch already checked out
 * elsewhere" refusals for a branch this function never intends to advance. */
function addWorktree(repository, ref) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "dh-review-"));
  const worktreePath = path.join(parent, "wt");
  const result = git(repository, ["worktree", "add", "--detach", worktreePath, ref]);
  if (!result.ok) {
    rmSync(parent, { recursive: true, force: true });
    return { ok: false, worktreePath: null, parent: null, stderr: result.stderr };
  }
  return { ok: true, worktreePath, parent };
}

/** Remove a temporary review worktree unconditionally: `git worktree remove
 * --force`, falling back to a raw rmSync, then always remove the temp parent. */
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

function boundDiff(fullDiffText) {
  const text = fullDiffText ?? "";
  if (text.length <= MAX_DIFF_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_DIFF_CHARS)}\n[... diff truncated at ${MAX_DIFF_CHARS} characters by DevHarmonics review stage ...]`,
    truncated: true,
  };
}

const NARRATION_WITHHELD =
  "Implementor task reports are deliberately withheld from this review lens. Judge only the artifact itself — the diff (shown below and/or discoverable by reading the checked-out files) and the executed check receipts. Do not assume anything a worker's narration might have claimed.";

/**
 * The artifact lens prompt (ported and simplified from v1's reviewerPrompt +
 * its NARRATION_WITHHELD constant). Demands a verdict line beginning exactly
 * READY or NOT READY, followed by exactly one fenced json findings block.
 * READY requires an empty findings array.
 */
export function reviewerPrompt({ goal, diffStat, checkReceiptsSummary }) {
  return `You are the final artifact-lens reviewer. Operate strictly read-only: do not modify any file, create commits or branches, or run write commands.

Goal:
${goal}

${NARRATION_WITHHELD}

Diff summary (--stat):
${diffStat && diffStat.trim() ? diffStat : "(no changes)"}

Executed check receipts:
${checkReceiptsSummary && checkReceiptsSummary.trim() ? checkReceiptsSummary : "No check receipts were supplied for this review."}

Review the combined diff and repository state. Return a concise verdict beginning with exactly READY or NOT READY on the first line. After the verdict, explain the evidence and material risks. Then include exactly one fenced JSON object with this shape:
\`\`\`json
{"findings":[{"id":"stable-short-id","severity":"low|medium|high|critical","location":"path:line or null","rationale":"evidence-backed reason","suggestedCorrection":"bounded correction","disposition":"open"}]}
\`\`\`
READY must use an empty findings array. NOT READY must include every blocking finding. Do not inherit implementor claims as fact, do not modify files, and do not emit another verdict after the first line.`;
}

function firstVerdict(text) {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trim().toUpperCase();
  return firstLine === "READY" ? "READY" : "NOT_READY";
}

/** Extract the findings array from the reviewer's fenced (or bare) JSON
 * object. Never throws: any parse failure or shape mismatch yields []. */
function parseFindingsJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return [];
  try {
    const value = JSON.parse(candidate);
    return Array.isArray(value?.findings) ? value.findings : [];
  } catch {
    return [];
  }
}

function normalizeFinding(value, index) {
  if (!value || typeof value !== "object") return null;
  const rationale = typeof value.rationale === "string" ? value.rationale.trim() : "";
  if (!rationale) return null; // entries without rationale are dropped (spec)
  const severity = SEVERITIES.includes(String(value.severity)) ? String(value.severity) : "high";
  const disposition = DISPOSITIONS.includes(String(value.disposition)) ? String(value.disposition) : "open";
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : `finding-${index + 1}`,
    severity,
    location: typeof value.location === "string" && value.location.trim() ? value.location.trim() : null,
    rationale,
    suggestedCorrection: typeof value.suggestedCorrection === "string" && value.suggestedCorrection.trim()
      ? value.suggestedCorrection.trim()
      : "Investigate and correct the reported condition before re-review.",
    disposition,
  };
}

/**
 * Port of v1's parseReviewerResponse, simplified to the artifact lens (no
 * claimedChanges manifest extraction — the divergence gate below takes its
 * claimed paths directly from the caller instead). First non-blank line
 * decides the verdict; anything other than exactly "READY" is NOT_READY. A
 * NOT_READY response with no parseable findings synthesizes exactly one
 * finding from the response body, so a reviewer that explains itself in
 * prose without the required JSON block never silently vanishes into an
 * unexplained NOT_READY.
 */
export function parseReviewerResponse(text, identity = {}) {
  const source = typeof text === "string" ? text : "";
  const verdict = firstVerdict(source);
  const rawFindings = parseFindingsJson(source);
  const normalized = rawFindings.map(normalizeFinding).filter((finding) => finding !== null);
  const body = source.trim().split(/\r?\n/).slice(1).join("\n").replace(/```json[\s\S]*?```/gi, "").trim();
  const findings = verdict === "NOT_READY" && normalized.length === 0
    ? [{
        id: "finding-1",
        severity: "high",
        location: null,
        rationale: body || "Reviewer returned NOT READY without a structured rationale.",
        suggestedCorrection: "Inspect the retained review and correct the blocking issue before re-review.",
        disposition: "open",
      }]
    : normalized;
  return {
    verdict,
    provider: identity.provider ?? null,
    modelId: identity.modelId ?? null,
    summary: body || (verdict === "READY" ? "No material findings." : findings[0].rationale),
    findings,
    rawText: source,
  };
}

/** One path grammar for claims and diffs, so the two sides cannot drift
 * apart on a cosmetic difference (ported from v1's normalizeChangePath). */
function normalizeChangePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * The deterministic half of the review (ported and simplified from v1's
 * claimsArtifactDivergence): compare what was claimed changed against what
 * the diff actually contains. A claimed-but-absent path is the "narration
 * without artifacts" defect class — high severity. A changed-but-unclaimed
 * path is an unexplained/unattributed change — medium severity. Pure
 * function; no I/O.
 */
export function claimsArtifactDivergence({ claimedPaths = [], diffPaths = [] }) {
  const normalizedClaimed = [...new Set((claimedPaths ?? []).map(normalizeChangePath).filter(Boolean))];
  const diffSet = new Set((diffPaths ?? []).map(normalizeChangePath).filter(Boolean));
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

function reviewerUnavailableFinding(detail) {
  return {
    id: "reviewer-unavailable",
    severity: "critical",
    location: null,
    rationale: `Reviewer did not return a usable verdict (${detail}). A crashed or unreachable reviewer is never treated as a pass.`,
    suggestedCorrection: "Investigate why the reviewer failed to complete and re-review before merging.",
    disposition: "open",
  };
}

/** Interpret a subprocess-lane runWorker() result. Anything short of a
 * completed status with real final text is a refusal, never a pass. */
function interpretWorkerResult(runResult, identity) {
  const status = runResult?.receipt?.status ?? null;
  const finalText = runResult?.parsed?.finalText;
  if (status !== "completed" || typeof finalText !== "string" || finalText.trim().length === 0) {
    const detail = status ? `worker status=${status}` : "worker produced no receipt";
    return {
      verdict: "NOT_READY",
      provider: identity.provider,
      modelId: runResult?.receipt?.resolvedModel ?? identity.modelId,
      summary: `Reviewer worker did not complete (${detail}); a crashed reviewer is never a pass.`,
      findings: [reviewerUnavailableFinding(detail)],
      rawText: typeof finalText === "string" ? finalText : "",
    };
  }
  return parseReviewerResponse(finalText, { provider: identity.provider, modelId: runResult.receipt.resolvedModel ?? identity.modelId });
}

/** Interpret an http-lane sendMessages() result the same way. */
function interpretHttpResult(response, identity) {
  if (!response?.ok || typeof response.contentText !== "string" || response.contentText.trim().length === 0) {
    const detail = response?.error ?? "no content returned";
    return {
      verdict: "NOT_READY",
      provider: identity.provider,
      modelId: response?.resolvedModel ?? identity.modelId,
      summary: `Reviewer HTTP call did not complete (${detail}); a crashed reviewer is never a pass.`,
      findings: [reviewerUnavailableFinding(detail)],
      rawText: typeof response?.contentText === "string" ? response.contentText : "",
    };
  }
  return parseReviewerResponse(response.contentText, { provider: identity.provider, modelId: response.resolvedModel ?? identity.modelId });
}

/**
 * Run one full review: compute the diff, run the deterministic divergence
 * gate, dispatch the model reviewer on the requested lane, and always write
 * a review receipt. Overall verdict is READY only when the model reviewer
 * said READY AND the divergence gate found nothing open — the mechanical
 * gate outranks the model, same rule integrate.mjs applies to tampercheck.
 */
export async function runReview({
  repository,
  integrationBranch,
  baseRef,
  goal,
  reviewer,
  claimedPaths = null,
  checkReceiptsSummary = null,
  evidenceRoot,
  env = process.env,
  timeoutMs = 10 * 60_000,
  deps = {},
}) {
  assertGitRoot(repository);
  assertNonEmptyString(integrationBranch, "integrationBranch");
  assertNonEmptyString(baseRef, "baseRef");
  assertNonEmptyString(goal, "goal");
  assertNonEmptyString(evidenceRoot, "evidenceRoot");
  if (!reviewer || typeof reviewer !== "object") fail("reviewer must be an object");
  if (reviewer.lane !== "subprocess" && reviewer.lane !== "http") {
    fail(`reviewer.lane must be "subprocess" or "http", got: ${JSON.stringify(reviewer.lane)}`);
  }
  assertNonEmptyString(reviewer.provider, "reviewer.provider");
  assertNonEmptyString(reviewer.model, "reviewer.model");
  if (claimedPaths !== null && !Array.isArray(claimedPaths)) fail("claimedPaths must be an array or null");

  const runWorkerFn = deps.runWorker ?? defaultRunWorker;
  const sendMessagesFn = deps.sendMessages ?? defaultSendMessages;

  // Read-only diff computation directly against `repository` — same
  // refs/objects-only precedent as scripts/integrate.mjs. Malformed refs
  // (baseRef/integrationBranch that do not resolve) are a malformed
  // request, not a review verdict, so they throw before any evidence
  // directory exists — mirroring integrate.mjs's merge-base resolution.
  const diffFullRes = git(repository, ["diff", baseRef, integrationBranch]);
  if (!diffFullRes.ok) fail(`could not compute diff(${baseRef}, ${integrationBranch}): ${diffFullRes.stderr.trim()}`);
  const diffStatRes = git(repository, ["diff", "--stat", baseRef, integrationBranch]);
  if (!diffStatRes.ok) fail(`could not compute diff --stat(${baseRef}, ${integrationBranch}): ${diffStatRes.stderr.trim()}`);
  const diffNamesRes = git(repository, ["diff", "--name-only", baseRef, integrationBranch]);
  if (!diffNamesRes.ok) fail(`could not compute diff --name-only(${baseRef}, ${integrationBranch}): ${diffNamesRes.stderr.trim()}`);

  const diffStat = diffStatRes.stdout;
  const diffPaths = diffNamesRes.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const { text: diffPatch, truncated: diffTruncated } = boundDiff(diffFullRes.stdout);

  // Divergence gate: computed unconditionally against the real diff, before
  // the model reviewer is even asked — the model's opinion never overrides it.
  const divergence = claimedPaths !== null
    ? claimsArtifactDivergence({ claimedPaths, diffPaths })
    : [];

  const reviewId = `review-${randomUUID().split("-")[0]}`;
  const evidenceDir = path.join(evidenceRoot, reviewId);
  const startedAt = new Date().toISOString();

  const basePrompt = reviewerPrompt({
    goal,
    diffStat,
    // Threaded from the caller (slice-8 audit finding: this was a hardcoded
    // placeholder, so a reviewer never saw the validator's real result).
    checkReceiptsSummary: checkReceiptsSummary ?? "No check receipts were supplied to this review.",
  });

  const identity = { provider: reviewer.provider, modelId: reviewer.model };

  let modelReview;
  // The full (bounded) patch is embedded for BOTH lanes. Found live
  // 2026-08-04: a subprocess reviewer given only a read-only checkout plus
  // diff --stat correctly refused with "the combined diff and repository
  // state were not supplied" — it can see the RESULT files but not what
  // changed, and a reviewer that cannot see the change is right to withhold
  // READY. Supplying the artifact is the factory's job, not the reviewer's.
  const diffSection = `\n\nDiff (${baseRef}..${integrationBranch}${diffTruncated ? ", truncated" : ""}):\n\`\`\`diff\n${diffPatch || "(no changes)"}\n\`\`\``;

  if (reviewer.lane === "subprocess") {
    // Still gets a real read-only checkout so it can Read surrounding
    // context the patch alone does not show.
    const wt = addWorktree(repository, integrationBranch);
    if (!wt.ok) fail(`could not create review worktree for "${integrationBranch}": ${wt.stderr}`);
    try {
      const runResult = await runWorkerFn({
        taskId: reviewId,
        provider: reviewer.provider,
        model: reviewer.model,
        prompt: `${basePrompt}${diffSection}`,
        cwd: wt.worktreePath,
        runsRoot: path.join(evidenceDir, "reviewer-runs"),
        sandbox: "read-only",
        allowedTools: ["Read"],
        timeoutMs,
        env,
      });
      modelReview = interpretWorkerResult(runResult, identity);
    } finally {
      removeWorktree(repository, wt.worktreePath, wt.parent);
    }
  } else {
    // The http lane has no repository access at all — the embedded patch
    // above is its only view of the change.
    let response;
    try {
      response = await sendMessagesFn({
        baseUrl: reviewer.baseUrl,
        model: reviewer.model,
        messages: [{ role: "user", content: `${basePrompt}${diffSection}` }],
        timeoutMs,
      });
    } catch (error) {
      response = { ok: false, error: `client threw: ${error.message}` };
    }
    modelReview = interpretHttpResult(response, identity);
  }

  const divergenceOpen = divergence.some((finding) => finding.disposition === "open");
  const verdict = modelReview.verdict === "READY" && !divergenceOpen ? "READY" : "NOT_READY";
  const finishedAt = new Date().toISOString();

  // Always written from here on — an attempt that leaves no evidence is
  // indistinguishable from an attempt that never happened (run-worker.mjs's
  // rule, applied here to the review stage).
  mkdirSync(evidenceDir, { recursive: true });
  const bundle = {
    schema: "devharmonics-review-v1",
    reviewId,
    repository: path.resolve(repository),
    baseRef,
    integrationBranch,
    reviewer: {
      lane: reviewer.lane,
      provider: reviewer.provider,
      model: reviewer.model,
      ...(reviewer.baseUrl ? { baseUrl: reviewer.baseUrl } : {}),
    },
    modelVerdict: modelReview.verdict,
    verdict,
    findings: modelReview.findings,
    divergence,
    diffStat,
    diffTruncated,
    promptSha256: promptSha256(basePrompt),
    startedAt,
    finishedAt,
  };
  const reviewReceiptPath = path.join(evidenceDir, "review.json");
  writeFileSync(reviewReceiptPath, `${JSON.stringify(bundle, null, 2)}\n`);

  return { verdict, findings: modelReview.findings, divergence, reviewReceiptPath };
}
