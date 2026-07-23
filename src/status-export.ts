import type { DeliveryRepositoryRecord, ObjectiveRecord, RunSummary } from "./types.js";
import type { ProductRecord } from "./ledger.js";

/**
 * DH-645 S4. The exportable standalone status page.
 *
 * Locked decision 4 (DESIGN-BRIEF-v1.0.md): "The status export contains no
 * agent-written values. The exported page embeds only owner-held facts
 * (repo names, branch names, PR numbers — identifiers, not verdicts) and
 * fetches live state from the GitHub API in the owner's browser."
 *
 * This module enforces that STRUCTURALLY, not by convention:
 *
 *  - `buildStatusExportRecords` is the ONLY function that reads a
 *    `RunSummary`/`DeliveryRepositoryRecord` to build export data, and it
 *    plucks an explicit, named field list of raw identifiers DevHarmonics
 *    itself assigned when it pushed to the remote — repository id, branch,
 *    commit sha, PR url/number, tag name, the merge commit OID recorded when
 *    a merge completed, and timestamps. It never spreads a whole run/
 *    delivery object, so a new agent-written field added to those types in
 *    the future cannot leak in silently.
 *  - NO FREE TEXT of any kind is embedded — not even owner-typed text.
 *    Review finding C1: a Workbench-converted objective's `run.goal` can
 *    itself be model-authored, so this module never reads `run.goal` or a
 *    product's `name` at all, regardless of provenance. Cards are headed by
 *    `repositoryId` alone, with the run id (short form) and dates for
 *    context — never a goal, never a product name, never any prose.
 *  - Nothing that is or could be an agent's belief about the work — the
 *    run's finalReview, a RunPlan's summary, a PlannedTask's description, a
 *    delivery's error text, the ledger's own `status` verdict — is ever
 *    read by this file. test/status-export.test.ts seeds a ledger with
 *    marker strings in exactly those fields (plus the run goal and product
 *    name) and asserts none of them ever appear in the generated HTML.
 *  - View-time state (does the branch/PR/checks/tag still match) is never
 *    embedded either: it is computed by the SAME `classify*` functions
 *    unit-tested below, shipped into the page verbatim via `.toString()`
 *    (see `renderStatusExportHtml`), and run against live `fetch()` calls
 *    to api.github.com only after the owner opens the file in a browser —
 *    with DevHarmonics not even running.
 *  - Review finding C2: GitHub deliberately makes a private/invisible repo
 *    indistinguishable from a missing one to an unauthenticated caller, so
 *    an unauthenticated 404 is never, by itself, proof a branch/PR/tag is
 *    gone. `classifyRepositoryVisible` runs FIRST, per repository — only
 *    once the repository itself responds 2xx do branch/PR/tag 404s get
 *    classified as genuine absence; otherwise every artifact for that
 *    repository reports "unobserved".
 */

export interface StatusExportRecord {
  runId: string;
  runCreatedAt: string;
  repositoryId: string;
  /** The remote the delivered branch was pushed to, or null if DevHarmonics never recorded one. */
  repositoryUrl: string | null;
  branch: string;
  reviewedCommitSha: string;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  /** Only set once DevHarmonics actually pushed a tag (`status === "tagged"`) — never a value from an earlier, unrelated attempt. */
  tagName: string | null;
  /**
   * The immutable merge commit OID DevHarmonics itself recorded when
   * merge_pr completed (see DeliveryRepositoryRecord.mergeCommitOid) — an
   * owner-held identifier DevHarmonics assigned, never agent prose. Null
   * before a merge commit exists. Used to confirm a merged pull request
   * actually merged the reviewed commit (review finding M-merged-head).
   */
  mergeCommitOid: string | null;
  /** When the ledger last recorded this delivery record changing — an identifier's timestamp, not a claim about current remote state. */
  deliveredAt: string;
}

/**
 * Only these statuses mean something was actually pushed to the remote —
 * the same set src/reconciliation.ts's `DELIVERED_STATUSES` uses, for the
 * same reason: `prepared` and `failed` have nothing on GitHub to point an
 * owner at yet.
 */
const DELIVERED_STATUSES: ReadonlySet<DeliveryRepositoryRecord["status"]> = new Set([
  "branch_pushed",
  "draft_pr_created",
  "merged",
  "tagged",
]);

function pullRequestNumberFrom(url: string | null): number | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)/);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Builds the strict allowlist of owner-held identifiers for every delivered
 * repository the ledger currently knows about. See the module doc above for
 * why this is the ONLY place export data is assembled.
 *
 * `products`/`objectives` are accepted for call-site compatibility with the
 * server route (which still resolves a product for other, non-export
 * purposes) but are deliberately never read here — per C1, this module
 * embeds no free text, so there is nothing product- or objective-shaped for
 * it to look up.
 */
export function buildStatusExportRecords(
  runs: readonly RunSummary[],
  _products: readonly ProductRecord[] = [],
  _objectives: readonly ObjectiveRecord[] = [],
): StatusExportRecord[] {
  const records: StatusExportRecord[] = [];
  for (const run of runs) {
    if (!run.delivery) continue;
    for (const repository of run.delivery.repositories) {
      if (!DELIVERED_STATUSES.has(repository.status)) continue;
      records.push({
        runId: run.id,
        runCreatedAt: run.createdAt,
        repositoryId: repository.repositoryId,
        repositoryUrl: repository.remoteUrl,
        branch: repository.branch,
        reviewedCommitSha: repository.headCommit,
        pullRequestUrl: repository.pullRequestUrl,
        pullRequestNumber: pullRequestNumberFrom(repository.pullRequestUrl),
        tagName: repository.status === "tagged" ? repository.releaseTag : null,
        mergeCommitOid: repository.mergeCommitOid,
        deliveredAt: repository.updatedAt,
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// View-time classification. These functions run TWICE from the SAME source:
// here, driven directly in Node against fake fetch responses (never a real
// GitHub call — see test/status-export.test.ts); and inside the exported
// page's own <script> tag, where `renderStatusExportHtml` embeds each
// function's `.toString()` verbatim. They must therefore stay fully
// self-contained (no reference to anything outside this block) and use only
// syntax valid after `tsc` erases the type annotations below.
// ---------------------------------------------------------------------------

/** The three honest states — SAME language as src/reconciliation.ts's ReconciliationState. */
export type StatusExportState = "matches" | "diverged" | "unobserved";

export interface StatusExportClassifyResult {
  state: StatusExportState;
  message: string;
}

/**
 * A normalized view-time fetch outcome. `ok: true` means GitHub returned a
 * response this page can safely reason about — a 2xx, OR a 404 (whose
 * meaning is resolved by `classifyRepositoryVisible` before any other 404 is
 * trusted as genuine absence; see review finding C2). `ok: false` means the
 * call itself failed, timed out, or GitHub returned a status this page
 * cannot safely interpret (401/403/429/5xx — review finding M-export-http).
 */
export interface StatusExportApiResponse {
  ok: boolean;
  status?: number;
  body?: any;
  reason?: string;
  /**
   * Tag-only (R6-export): the result of the SECOND fetch needed to peel an
   * annotated tag — GET .../git/tags/:sha, where :sha is the annotated tag
   * object's own sha named by the first ref fetch's `body.object.sha` (only
   * present when that first fetch's `body.object.type === "tag"`).
   * `classifyTag` is a pure function, so both fetches are made by the caller
   * (checkRecord, via the SAME fetchGitHub helper and its timeout) and
   * threaded in here rather than classifyTag reaching out to the network
   * itself.
   */
  tagObjectResponse?: StatusExportApiResponse;
}

export type StatusExportMergeSignal = "merged" | "not_merged" | "unobserved" | "no_pr_recorded";

export function short(sha: string): string {
  return sha ? sha.slice(0, 12) : sha;
}

/**
 * Extracts {owner, repo} from a GitHub remote URL (https or ssh form).
 * Structural parse: everything after the owner segment is the repo name,
 * with only a trailing `.git` suffix stripped — GitHub repository names may
 * themselves contain dots, so the repo group is never dot-excluded (review
 * finding minor-dots). Returns null for anything that isn't a recognizable
 * github.com URL — the caller then reports "could not check" rather than
 * guessing an API host.
 */
export function parseGitHubRepo(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = String(url).match(/github\.com[/:]([^/]+)\/(.+?)\/?$/i);
  if (!match || !match[1] || !match[2]) return null;
  const owner = match[1];
  let repo = match[2];
  if (repo.toLowerCase().endsWith(".git")) {
    repo = repo.slice(0, -4);
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Gate run FIRST, per repository, before any branch/PR/tag/checks fetch is
 * trusted (review finding C2). GitHub returns 404 for both a genuinely
 * missing repository and a private/invisible one to an unauthenticated
 * caller — those are indistinguishable, so a non-2xx repository response
 * (including 404) can only ever mean "unobserved" here, never "gone".
 */
export function classifyRepositoryVisible(response: StatusExportApiResponse): StatusExportClassifyResult {
  if (!response.ok) {
    return { state: "unobserved", message: `could not check this repository: ${response.reason}` };
  }
  if (typeof response.status === "number" && response.status >= 200 && response.status < 300) {
    return { state: "matches", message: "the repository is visible." };
  }
  return { state: "unobserved", message: "this repository is not found, or not visible without signing in." };
}

export function classifyBranch(
  expected: { branch: string; sha: string; mergeSignal?: StatusExportMergeSignal },
  response: StatusExportApiResponse,
): StatusExportClassifyResult {
  if (!response.ok) {
    return { state: "unobserved", message: `could not check whether branch '${expected.branch}' still exists: ${response.reason}` };
  }
  if (response.status === 404) {
    const mergeSignal = expected.mergeSignal ?? "no_pr_recorded";
    if (mergeSignal === "merged") {
      return { state: "matches", message: `branch '${expected.branch}' was deleted after its pull request merged — routine cleanup, nothing wrong.` };
    }
    if (mergeSignal === "unobserved") {
      return { state: "unobserved", message: `branch '${expected.branch}' is gone, and whether its pull request merged first could not be checked.` };
    }
    return { state: "diverged", message: `branch '${expected.branch}' no longer exists on GitHub — it was deleted or renamed.` };
  }
  const sha = response.body?.commit?.sha;
  if (!sha) {
    return { state: "unobserved", message: `GitHub returned an unreadable response for branch '${expected.branch}'.` };
  }
  if (sha === expected.sha) {
    return { state: "matches", message: `branch '${expected.branch}' is still at the reviewed commit ${short(sha)}.` };
  }
  return { state: "diverged", message: `branch '${expected.branch}' is now at ${short(sha)}, not the reviewed commit ${short(expected.sha)} — new commits landed after review.` };
}

export function classifyPullRequest(
  expected: { number: number; reviewedCommitSha: string; mergeCommitOid?: string | null },
  response: StatusExportApiResponse,
): StatusExportClassifyResult {
  if (!response.ok) {
    return { state: "unobserved", message: `could not check pull request #${expected.number}: ${response.reason}` };
  }
  if (response.status === 404) {
    return { state: "diverged", message: `pull request #${expected.number} could not be found on GitHub.` };
  }
  const body = response.body ?? {};
  if (body.state === "open") {
    const headSha = body.head?.sha;
    if (headSha && headSha !== expected.reviewedCommitSha) {
      return {
        state: "diverged",
        message: `pull request #${expected.number} is open, but its head is now ${short(headSha)}, not the reviewed commit ${short(expected.reviewedCommitSha)} — new commits landed after review.`,
      };
    }
    return { state: "matches", message: `pull request #${expected.number} is still open at the reviewed commit.` };
  }
  if (body.state === "closed" && body.merged_at) {
    // Review finding M-merged-head (round 2, R9-export): a merged PR only
    // "matches" once BOTH its observed merge commit equals the merge commit
    // OID DevHarmonics recorded, AND its observed head sha equals the
    // reviewed commit DevHarmonics actually approved — matching only the
    // merge commit is not enough, since a different (unreviewed) head could
    // have been merged. Missing either side of either identity is honestly
    // unobserved, never a silent match; a genuine mismatch on either side is
    // a divergence naming the commits involved.
    if (!expected.mergeCommitOid) {
      return { state: "unobserved", message: `pull request #${expected.number} is merged, but no merge commit was recorded to compare against.` };
    }
    const observedMergeSha = body.merge_commit_sha;
    if (!observedMergeSha) {
      return { state: "unobserved", message: `pull request #${expected.number} is merged, but GitHub did not report which commit was merged.` };
    }
    const observedHeadSha = body.head?.sha;
    if (!observedHeadSha) {
      return { state: "unobserved", message: `pull request #${expected.number} is merged, but GitHub did not report its head commit to compare against the reviewed commit ${short(expected.reviewedCommitSha)}.` };
    }
    if (observedMergeSha !== expected.mergeCommitOid) {
      return {
        state: "diverged",
        message: `pull request #${expected.number} is merged, but the merged commit ${short(observedMergeSha)} does not match the recorded merge commit ${short(expected.mergeCommitOid)}.`,
      };
    }
    if (observedHeadSha !== expected.reviewedCommitSha) {
      return {
        state: "diverged",
        message: `pull request #${expected.number} is merged, but its head commit ${short(observedHeadSha)} does not match the reviewed commit ${short(expected.reviewedCommitSha)} — a different commit than the one reviewed was merged.`,
      };
    }
    return { state: "matches", message: `pull request #${expected.number} is merged at the recorded merge commit ${short(observedMergeSha)}, reviewed at head ${short(observedHeadSha)}.` };
  }
  return { state: "diverged", message: `pull request #${expected.number} is closed without merging.` };
}

export function classifyChecks(
  expected: { sha: string },
  response: StatusExportApiResponse,
): StatusExportClassifyResult {
  if (!response.ok) {
    return { state: "unobserved", message: `could not check status checks for ${short(expected.sha)}: ${response.reason}` };
  }
  const body = response.body ?? {};
  const checkRuns: Array<{ status?: string; conclusion?: string | null }> = body.check_runs ?? [];
  if (checkRuns.length === 0) {
    return { state: "unobserved", message: `no status checks were reported for ${short(expected.sha)}.` };
  }
  // Review finding M-export-checks: validate the full result set was read
  // before trusting it — a paginated response that under-reports its own
  // total_count must never silently pass as complete.
  const totalCount = typeof body.total_count === "number" ? body.total_count : checkRuns.length;
  if (totalCount > checkRuns.length) {
    return {
      state: "unobserved",
      message: `${totalCount} status checks were reported for ${short(expected.sha)}, but only ${checkRuns.length} could be read — the result set was incomplete.`,
    };
  }
  // Pending/queued/in-progress runs, or a "completed" run with no
  // conclusion yet, are still running — never a false pass and never
  // silently ignored.
  const incomplete = checkRuns.filter((run) => run.status !== "completed" || run.conclusion == null);
  if (incomplete.length) {
    return { state: "unobserved", message: `status checks for ${short(expected.sha)} are still running.` };
  }
  const failed = checkRuns.filter((run) => !["success", "neutral", "skipped"].includes(String(run.conclusion)));
  if (failed.length) {
    return { state: "diverged", message: `${failed.length} status check(s) now report a failing result.` };
  }
  return { state: "matches", message: "no status checks currently report a failing result." };
}

/**
 * Review finding R6-export: presence alone (the tag ref still resolves) does
 * not prove a force-moved tag is unchanged — a moved tag still resolves. The
 * ref response's `body.object` names either the commit directly
 * (`type: "commit"`, a lightweight tag) or the annotated tag object's OWN sha
 * (`type: "tag"`), which must be peeled one more hop before it names a
 * commit at all. `classifyTag` stays a pure, synchronous, closure-complete
 * function (no network access of its own, for `.toString()` embedding) — the
 * caller (checkRecord, in the shipped page's own script) performs both
 * fetches through the SAME `fetchGitHub` helper and its timeout, threading
 * the second result in as `response.tagObjectResponse`.
 *
 * Only the PEELED commit is ever compared, and only against
 * `expected.mergeCommitOid` — tags land on the merge commit, never the
 * reviewed head. Missing either the ledger's recorded merge commit or a
 * resolvable peeled commit is honestly unobserved; a genuine mismatch is a
 * divergence naming both commits.
 */
export function classifyTag(
  expected: { tag: string; mergeCommitOid?: string | null },
  response: StatusExportApiResponse,
): StatusExportClassifyResult {
  if (!response.ok) {
    return { state: "unobserved", message: `could not check whether tag '${expected.tag}' still exists: ${response.reason}` };
  }
  if (response.status === 404) {
    return { state: "diverged", message: `release tag '${expected.tag}' no longer exists on GitHub.` };
  }
  const object = response.body?.object;
  let peeledSha: string | undefined;
  if (object?.type === "commit" && object.sha) {
    // Lightweight tag: the ref already names a commit directly.
    peeledSha = object.sha;
  } else if (object?.type === "tag" && object.sha) {
    // Annotated tag: the ref names the tag object's own sha — only the
    // SECOND fetch (the peeled tag object) tells us what commit it targets.
    const tagObjectResponse = response.tagObjectResponse;
    if (!tagObjectResponse || !tagObjectResponse.ok) {
      return {
        state: "unobserved",
        message: `release tag '${expected.tag}' is an annotated tag, but its target commit could not be read: ${tagObjectResponse?.reason ?? "no follow-up request was made"}.`,
      };
    }
    const peeledObject = tagObjectResponse.body?.object;
    if (!peeledObject?.sha) {
      return { state: "unobserved", message: `release tag '${expected.tag}' is an annotated tag, but GitHub's response for its target object did not name a commit.` };
    }
    peeledSha = peeledObject.sha;
  }
  if (!peeledSha) {
    return { state: "unobserved", message: `GitHub returned an unreadable response for tag '${expected.tag}'.` };
  }
  if (!expected.mergeCommitOid) {
    return { state: "unobserved", message: `release tag '${expected.tag}' was read, but no merge commit was recorded to compare it against.` };
  }
  if (peeledSha === expected.mergeCommitOid) {
    return { state: "matches", message: `release tag '${expected.tag}' still points at the recorded merge commit ${short(expected.mergeCommitOid)}.` };
  }
  return {
    state: "diverged",
    message: `release tag '${expected.tag}' now points at ${short(peeledSha)}, not the recorded merge commit ${short(expected.mergeCommitOid)} — the tag was moved to a different commit.`,
  };
}

/** Single dispatch point the shipped page calls: `classify(kind, expected, response) -> state`. */
export function classify(
  kind: "branch" | "pull_request" | "checks" | "tag",
  expected: any,
  response: StatusExportApiResponse,
): StatusExportClassifyResult {
  if (kind === "branch") return classifyBranch(expected, response);
  if (kind === "pull_request") return classifyPullRequest(expected, response);
  if (kind === "checks") return classifyChecks(expected, response);
  if (kind === "tag") return classifyTag(expected, response);
  return { state: "unobserved", message: "unknown check kind" };
}

const CLASSIFY_FUNCTIONS = [
  short,
  parseGitHubRepo,
  classifyRepositoryVisible,
  classifyBranch,
  classifyPullRequest,
  classifyChecks,
  classifyTag,
  classify,
];

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function recordCardHtml(record: StatusExportRecord, index: number): string {
  const repositoryCell = record.repositoryUrl
    ? `<a href="${escapeHtml(record.repositoryUrl)}" rel="noopener">${escapeHtml(record.repositoryUrl)}</a>`
    : escapeHtml(record.repositoryId);
  return `<article class="status-record" data-record-index="${index}">
  <h3>${escapeHtml(record.repositoryId)}</h3>
  <p class="status-record-meta">Run ${escapeHtml(short(record.runId))} &middot; created ${escapeHtml(record.runCreatedAt)} &middot; delivery last recorded ${escapeHtml(record.deliveredAt)}</p>
  <dl class="status-record-facts">
    <div><dt>Repository</dt><dd>${repositoryCell}</dd></div>
    <div><dt>Branch</dt><dd>${escapeHtml(record.branch)}</dd></div>
    <div><dt>Reviewed commit</dt><dd>${escapeHtml(short(record.reviewedCommitSha))}</dd></div>
    ${record.pullRequestUrl ? `<div><dt>Pull request</dt><dd><a href="${escapeHtml(record.pullRequestUrl)}" rel="noopener">#${record.pullRequestNumber ?? "?"}</a></dd></div>` : ""}
    ${record.tagName ? `<div><dt>Release tag</dt><dd>${escapeHtml(record.tagName)}</dd></div>` : ""}
  </dl>
  <div class="status-record-checks" data-checks-for="${index}">
    <p class="status-check" data-check="branch">Branch: <span class="status-state status-pending">checking&hellip;</span></p>
    ${record.pullRequestUrl ? `<p class="status-check" data-check="pull_request">Pull request: <span class="status-state status-pending">checking&hellip;</span></p>
    <p class="status-check" data-check="checks">Status checks: <span class="status-state status-pending">checking&hellip;</span></p>` : ""}
    ${record.tagName ? `<p class="status-check" data-check="tag">Release tag: <span class="status-state status-pending">checking&hellip;</span></p>` : ""}
  </div>
</article>`;
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 880px; margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; }
  .purpose { font-size: 1rem; opacity: 0.85; }
  .legend { list-style: none; padding: 0; margin: 1rem 0; display: grid; gap: 0.35rem; }
  .rate-limit-note { font-size: 0.9rem; opacity: 0.75; border-left: 3px solid currentColor; padding-left: 0.75rem; }
  .status-empty { padding: 2rem 1rem; text-align: center; opacity: 0.8; border: 1px dashed currentColor; border-radius: 8px; }
  .status-record { border: 1px solid rgba(128,128,128,0.35); border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .status-record h3 { margin: 0 0 0.25rem; }
  .status-record-meta { font-size: 0.85rem; opacity: 0.75; margin: 0 0 0.75rem; }
  .status-record-facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; margin: 0 0 0.75rem; }
  .status-record-facts dt { opacity: 0.7; }
  .status-record-facts dd { margin: 0; word-break: break-all; }
  .status-check { margin: 0.25rem 0; }
  .status-state { font-weight: 600; }
  .status-matches { color: #1a7f37; }
  .status-diverged { color: #cf222e; }
  .status-unobserved { color: #9a6700; }
  .status-pending { opacity: 0.6; font-weight: 400; }
`;

/**
 * Renders the full self-contained export page for the given identifiers —
 * inline CSS/JS, no external assets except the GitHub API calls the page
 * itself makes when opened. Pure and synchronous: the SAME output for the
 * same records regardless of whether DevHarmonics or the network is even
 * running, which is exactly the property the export exists to provide.
 */
export function renderStatusExportHtml(records: readonly StatusExportRecord[], generatedAt: Date = new Date()): string {
  const generatedAtHuman = generatedAt.toUTCString();
  const dataJson = JSON.stringify(records).replaceAll("<", "\\u003c");
  const classifyScript = CLASSIFY_FUNCTIONS.map((fn) => fn.toString()).join("\n\n");

  const body = records.length === 0
    ? `<p class="status-empty">No deliveries recorded yet. Once DevHarmonics pushes a branch, opens a pull request, or tags a release under your approval, it will appear here.</p>`
    : `<div id="status-records">\n${records.map((record, index) => recordCardHtml(record, index)).join("\n")}\n</div>`;

  const itemWord = records.length === 1 ? "item" : "items";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DevHarmonics status export</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>DevHarmonics status export</h1>
<p class="purpose">Generated by DevHarmonics on ${escapeHtml(generatedAtHuman)}. The identifiers on this page &mdash; repository, branch, commit, pull request, and tag &mdash; came from the DevHarmonics delivery ledger when each was recorded; only the status classifications below (matches / diverged / could not check) are fetched live from GitHub when you open this page. This file works with DevHarmonics stopped: every status shown was fetched by your own browser talking to GitHub just now, not read from a running DevHarmonics or its ledger.</p>
<ul class="legend">
  <li><strong>Matches</strong> &mdash; observed on GitHub just now, and it agrees with the identifier recorded at delivery time.</li>
  <li><strong>Diverged</strong> &mdash; observed on GitHub just now, and it disagrees with what was recorded (branch gone, pull request closed without merging, checks failing, commit moved).</li>
  <li><strong>Could not check</strong> &mdash; GitHub could not be reached, refused the request, or the repository is private/invisible without signing in (offline, rate-limited, timed out, or not visible). This is never shown or treated as confirmation of anything.</li>
</ul>
<p class="rate-limit-note">This page calls the public GitHub API directly from your browser, unauthenticated. GitHub allows 60 such requests per hour per network address &mdash; with ${records.length} ${itemWord} on this page, opening it several times in a short window can exhaust that limit; a "could not check (rate limited)" result means try again in an hour, not that anything is wrong.</p>
${body}
</main>
<script id="status-export-data" type="application/json">${dataJson}</script>
<script>
${classifyScript}

(function () {
  var dataEl = document.getElementById("status-export-data");
  var records = dataEl ? JSON.parse(dataEl.textContent || "[]") : [];
  var FETCH_TIMEOUT_MS = 10000;

  // round3 Minor: 'sharedSignal', when passed, means the CALLER owns the
  // single deadline for this logical check (see the tag check below, which
  // threads one AbortController's signal through both of its fetches) — no
  // fresh FETCH_TIMEOUT_MS timer is started here in that case, so a
  // multi-fetch check never composes into more than its one shared budget.
  // Without it (the default), fetchGitHub keeps its own independent
  // FETCH_TIMEOUT_MS deadline, unchanged from before.
  async function fetchGitHub(url, sharedSignal) {
    var controller = new AbortController();
    var ownTimer = null;
    if (sharedSignal) {
      if (sharedSignal.aborted) controller.abort();
      else sharedSignal.addEventListener("abort", function () { controller.abort(); });
    } else {
      ownTimer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    }
    try {
      var res = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal: controller.signal });
      var body = null;
      try { body = await res.json(); } catch (parseError) { body = null; }
      if ((res.status >= 200 && res.status < 300) || res.status === 404) {
        return { ok: true, status: res.status, body: body };
      }
      if (res.status === 403 || res.status === 429) {
        return { ok: false, reason: "GitHub API rate limit reached (60 unauthenticated requests/hour) — try again later" };
      }
      return { ok: false, reason: "GitHub responded with an unexpected status (" + res.status + ")" };
    } catch (networkError) {
      if (networkError && networkError.name === "AbortError") {
        return { ok: false, reason: "the request timed out" };
      }
      return { ok: false, reason: "network error — this browser could not reach GitHub" };
    } finally {
      if (ownTimer) clearTimeout(ownTimer);
    }
  }

  function setCheckState(index, kind, result) {
    var container = document.querySelector('[data-checks-for="' + index + '"]');
    if (!container) return;
    var row = container.querySelector('[data-check="' + kind + '"]');
    if (!row) return;
    var span = row.querySelector(".status-state");
    if (!span) return;
    span.className = "status-state status-" + result.state;
    var label = result.state === "matches" ? "matches" : result.state === "diverged" ? "diverged — " + result.message : "could not check — " + result.message;
    span.textContent = label;
  }

  async function checkRecord(record, index) {
    var repo = parseGitHubRepo(record.repositoryUrl);
    if (!repo) {
      var noUrl = { state: "unobserved", message: "no repository URL was recorded for this delivery" };
      setCheckState(index, "branch", noUrl);
      if (record.pullRequestUrl) {
        setCheckState(index, "pull_request", noUrl);
        setCheckState(index, "checks", noUrl);
      }
      if (record.tagName) setCheckState(index, "tag", noUrl);
      return;
    }
    var base = "https://api.github.com/repos/" + repo.owner + "/" + repo.repo;

    // C2: confirm the repository itself is visible BEFORE trusting any
    // branch/PR/tag 404 as genuine absence — an unauthenticated 404 on a
    // private repo is indistinguishable from a truly missing one.
    var repoResponse = await fetchGitHub(base);
    var repoVisible = classifyRepositoryVisible(repoResponse);
    if (repoVisible.state !== "matches") {
      setCheckState(index, "branch", repoVisible);
      if (record.pullRequestUrl) {
        setCheckState(index, "pull_request", repoVisible);
        setCheckState(index, "checks", repoVisible);
      }
      if (record.tagName) setCheckState(index, "tag", repoVisible);
      return;
    }

    var mergeSignal = "no_pr_recorded";
    var checkHeadSha = record.reviewedCommitSha;

    if (record.pullRequestUrl && record.pullRequestNumber) {
      var prResponse = await fetchGitHub(base + "/pulls/" + record.pullRequestNumber);
      var prResult = classify("pull_request", { number: record.pullRequestNumber, reviewedCommitSha: record.reviewedCommitSha, mergeCommitOid: record.mergeCommitOid }, prResponse);
      setCheckState(index, "pull_request", prResult);
      // R9-export: mergeSignal must be "merged" ONLY once classifyPullRequest's
      // own full merge-identity check (merge commit AND reviewed head, both
      // observed and equal) actually returned "matches" — not from raw
      // state+merged_at alone. A merged-state PR whose identity could not be
      // read is unobserved; one whose identity mismatched is not_merged, so a
      // deleted branch is never waved off as routine cleanup on an unverified
      // merge (classifyBranch only treats a 404 as routine cleanup when
      // mergeSignal is exactly "merged").
      if (!prResponse.ok) {
        mergeSignal = "unobserved";
      } else if (prResponse.body && prResponse.body.state === "closed" && prResponse.body.merged_at) {
        mergeSignal = prResult.state === "matches" ? "merged" : prResult.state === "unobserved" ? "unobserved" : "not_merged";
      } else {
        mergeSignal = "not_merged";
      }
      if (prResponse.ok && prResponse.body && prResponse.body.head && prResponse.body.head.sha) {
        checkHeadSha = prResponse.body.head.sha;
      }
      var checksResponse = await fetchGitHub(base + "/commits/" + checkHeadSha + "/check-runs?per_page=100");
      setCheckState(index, "checks", classify("checks", { sha: checkHeadSha }, checksResponse));
    }

    var branchResponse = await fetchGitHub(base + "/branches/" + encodeURIComponent(record.branch));
    setCheckState(index, "branch", classify("branch", { branch: record.branch, sha: record.reviewedCommitSha, mergeSignal: mergeSignal }, branchResponse));

    if (record.tagName) {
      // R6-export: presence alone does not prove a force-moved tag is
      // unchanged. Read the tag ref first; when it names an annotated tag
      // object (type "tag") rather than a commit directly, peel it one more
      // hop through the SAME fetchGitHub helper before classifyTag ever
      // compares a commit against the recorded merge commit. classifyTag
      // itself stays pure/synchronous — both fetch results are threaded in
      // as a single response.
      //
      // round3 Minor: ONE deadline for the whole logical tag check, shared
      // across both fetches — without this, a slow ref response followed by
      // a stalled peel could take nearly 2x FETCH_TIMEOUT_MS, since each
      // fetchGitHub call used to start its own fresh timer.
      var tagCheckController = new AbortController();
      var tagCheckTimer = setTimeout(function () { tagCheckController.abort(); }, FETCH_TIMEOUT_MS);
      try {
        var tagRefResponse = await fetchGitHub(base + "/git/ref/tags/" + encodeURIComponent(record.tagName), tagCheckController.signal);
        if (tagRefResponse.ok && tagRefResponse.body && tagRefResponse.body.object && tagRefResponse.body.object.type === "tag" && tagRefResponse.body.object.sha) {
          tagRefResponse.tagObjectResponse = await fetchGitHub(base + "/git/tags/" + tagRefResponse.body.object.sha, tagCheckController.signal);
        }
        setCheckState(index, "tag", classify("tag", { tag: record.tagName, mergeCommitOid: record.mergeCommitOid }, tagRefResponse));
      } finally {
        clearTimeout(tagCheckTimer);
      }
    }
  }

  // M-export-unbounded: never launch every record's fetches at once — a
  // large export would amplify GitHub's rate limit and pile up sockets.
  // Each fetch also carries its own abort deadline (FETCH_TIMEOUT_MS above),
  // so a stalled request resolves to "could not check (timed out)" instead
  // of leaving a row reading "checking..." forever.
  function runBoundedQueue(items, concurrency, worker) {
    var cursor = 0;
    function next() {
      var current = cursor++;
      if (current >= items.length) return Promise.resolve();
      return worker(items[current], current).then(next, next);
    }
    var lanes = [];
    var laneCount = Math.min(concurrency, items.length);
    for (var i = 0; i < laneCount; i++) {
      lanes.push(next());
    }
    return Promise.all(lanes);
  }

  runBoundedQueue(records, 4, checkRecord);
})();
</script>
</body>
</html>
`;
}

/** Convenience: build the identifiers and render the page in one call — what the server route uses. */
export function generateStatusExportHtml(
  runs: readonly RunSummary[],
  products: readonly ProductRecord[] = [],
  objectives: readonly ObjectiveRecord[] = [],
  generatedAt: Date = new Date(),
): string {
  return renderStatusExportHtml(buildStatusExportRecords(runs, products, objectives), generatedAt);
}
