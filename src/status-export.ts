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
 *    plucks an explicit, named field list — `run.goal` (owner-typed into
 *    the composer), `product.name` (owner-typed at product registration),
 *    and the raw identifiers DevHarmonics itself assigned when it pushed to
 *    the remote (branch, commit sha, PR url/number, tag name, timestamps).
 *    It never spreads a whole run/delivery object, so a new agent-written
 *    field added to those types in the future cannot leak in silently.
 *  - Nothing that is or could be an agent's belief about the work — the
 *    run's finalReview, a RunPlan's summary, a PlannedTask's description, a
 *    delivery's error text, the ledger's own `status` verdict — is ever
 *    read by this file. test/status-export.test.ts seeds a ledger with
 *    marker strings in exactly those fields and asserts they never appear
 *    in the generated HTML.
 *  - View-time state (does the branch/PR/checks/tag still match) is never
 *    embedded either: it is computed by the SAME `classify*` functions
 *    unit-tested below, shipped into the page verbatim via `.toString()`
 *    (see `renderStatusExportHtml`), and run against live `fetch()` calls
 *    to api.github.com only after the owner opens the file in a browser —
 *    with DevHarmonics not even running.
 */

export interface StatusExportRecord {
  runId: string;
  /** Owner-typed goal text (the composer's "What should the team accomplish?" field) — never an agent summary. */
  runTitle: string;
  runCreatedAt: string;
  /** Owner-typed product name (set at product registration), or null when the run isn't linked to a registered product. */
  productTitle: string | null;
  repositoryId: string;
  /** The remote the delivered branch was pushed to, or null if DevHarmonics never recorded one. */
  repositoryUrl: string | null;
  branch: string;
  reviewedCommitSha: string;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  /** Only set once DevHarmonics actually pushed a tag (`status === "tagged"`) — never a value from an earlier, unrelated attempt. */
  tagName: string | null;
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

/** Same primary-objective/fallback-integration-set resolution as program-status.ts's `groupFor` — the authoritative product link, read-only. */
function productTitleFor(
  run: Pick<RunSummary, "objectiveId" | "integrationSet">,
  productsById: Map<string, ProductRecord>,
  objectivesById: Map<string, ObjectiveRecord>,
): string | null {
  const objectiveProductId = run.objectiveId ? objectivesById.get(run.objectiveId)?.productId : undefined;
  const productId = objectiveProductId ?? run.integrationSet?.productId ?? null;
  const product = productId ? productsById.get(productId) : undefined;
  return product ? product.name : null;
}

/**
 * Builds the strict allowlist of owner-held identifiers for every delivered
 * repository the ledger currently knows about. See the module doc above for
 * why this is the ONLY place export data is assembled.
 */
export function buildStatusExportRecords(
  runs: readonly RunSummary[],
  products: readonly ProductRecord[] = [],
  objectives: readonly ObjectiveRecord[] = [],
): StatusExportRecord[] {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const objectivesById = new Map(objectives.map((objective) => [objective.id, objective]));
  const records: StatusExportRecord[] = [];
  for (const run of runs) {
    if (!run.delivery) continue;
    const productTitle = productTitleFor(run, productsById, objectivesById);
    for (const repository of run.delivery.repositories) {
      if (!DELIVERED_STATUSES.has(repository.status)) continue;
      records.push({
        runId: run.id,
        runTitle: run.goal,
        runCreatedAt: run.createdAt,
        productTitle,
        repositoryId: repository.repositoryId,
        repositoryUrl: repository.remoteUrl,
        branch: repository.branch,
        reviewedCommitSha: repository.headCommit,
        pullRequestUrl: repository.pullRequestUrl,
        pullRequestNumber: pullRequestNumberFrom(repository.pullRequestUrl),
        tagName: repository.status === "tagged" ? repository.releaseTag : null,
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

/** A normalized view-time fetch outcome: `ok: true` means a response was received (any HTTP status, including 404); `ok: false` means the call itself failed (offline, rate-limited, timed out). */
export interface StatusExportApiResponse {
  ok: boolean;
  status?: number;
  body?: any;
  reason?: string;
}

export type StatusExportMergeSignal = "merged" | "not_merged" | "unobserved" | "no_pr_recorded";

export function short(sha: string): string {
  return sha ? sha.slice(0, 12) : sha;
}

/**
 * Extracts {owner, repo} from a GitHub remote URL (https or ssh form).
 * Returns null for anything that isn't a recognizable github.com URL — the
 * caller then reports "could not check" rather than guessing an API host.
 */
export function parseGitHubRepo(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
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
  expected: { number: number; reviewedCommitSha: string },
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
    return { state: "matches", message: `pull request #${expected.number} is merged.` };
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
  const checkRuns: Array<{ conclusion?: string | null }> = response.body?.check_runs ?? [];
  if (checkRuns.length === 0) {
    return { state: "unobserved", message: `no status checks were reported for ${short(expected.sha)}.` };
  }
  const failed = checkRuns.filter((run) => run.conclusion && !["success", "neutral", "skipped"].includes(run.conclusion));
  if (failed.length) {
    return { state: "diverged", message: `${failed.length} status check(s) now report a failing result.` };
  }
  return { state: "matches", message: "no status checks currently report a failing result." };
}

export function classifyTag(
  expected: { tag: string },
  response: StatusExportApiResponse,
): StatusExportClassifyResult {
  if (!response.ok) {
    return { state: "unobserved", message: `could not check whether tag '${expected.tag}' still exists: ${response.reason}` };
  }
  if (response.status === 404) {
    return { state: "diverged", message: `release tag '${expected.tag}' no longer exists on GitHub.` };
  }
  return { state: "matches", message: `release tag '${expected.tag}' is still present on GitHub.` };
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

const CLASSIFY_FUNCTIONS = [short, parseGitHubRepo, classifyBranch, classifyPullRequest, classifyChecks, classifyTag, classify];

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function recordCardHtml(record: StatusExportRecord, index: number): string {
  const heading = record.productTitle ? `${record.productTitle} — ${record.repositoryId}` : record.repositoryId;
  const repositoryCell = record.repositoryUrl
    ? `<a href="${escapeHtml(record.repositoryUrl)}" rel="noopener">${escapeHtml(record.repositoryUrl)}</a>`
    : escapeHtml(record.repositoryId);
  return `<article class="status-record" data-record-index="${index}">
  <h3>${escapeHtml(heading)}</h3>
  <p class="status-record-meta">Run: ${escapeHtml(record.runTitle)} &middot; delivery last recorded ${escapeHtml(record.deliveredAt)}</p>
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
<p class="purpose">Generated by DevHarmonics on ${escapeHtml(generatedAtHuman)} from delivery identifiers only &mdash; every status below is fetched live from GitHub when you open this page. This file works with DevHarmonics stopped: everything below comes from your own browser talking to GitHub, not from a running DevHarmonics or its ledger.</p>
<ul class="legend">
  <li><strong>Matches</strong> &mdash; observed on GitHub just now, and it agrees with the identifier recorded at delivery time.</li>
  <li><strong>Diverged</strong> &mdash; observed on GitHub just now, and it disagrees with what was recorded (branch gone, pull request closed without merging, checks failing, commit moved).</li>
  <li><strong>Could not check</strong> &mdash; GitHub could not be reached or refused the request (offline, rate-limited, or a private repository). This is never shown or treated as confirmation of anything.</li>
</ul>
<p class="rate-limit-note">This page calls the public GitHub API directly from your browser, unauthenticated, and only for public repositories. GitHub allows 60 such requests per hour per network address &mdash; with ${records.length} ${itemWord} on this page, opening it several times in a short window can exhaust that limit; a "could not check (rate limited)" result means try again in an hour, not that anything is wrong.</p>
${body}
</main>
<script id="status-export-data" type="application/json">${dataJson}</script>
<script>
${classifyScript}

(function () {
  var dataEl = document.getElementById("status-export-data");
  var records = dataEl ? JSON.parse(dataEl.textContent || "[]") : [];

  async function fetchGitHub(url) {
    try {
      var res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
      var body = null;
      try { body = await res.json(); } catch (parseError) { body = null; }
      if (res.status === 403 || res.status === 429) {
        return { ok: false, reason: "GitHub API rate limit reached (60 unauthenticated requests/hour) — try again later" };
      }
      return { ok: true, status: res.status, body: body };
    } catch (networkError) {
      return { ok: false, reason: "network error — this browser could not reach GitHub" };
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
      setCheckState(index, "branch", { state: "unobserved", message: "no repository URL was recorded for this delivery" });
      if (record.pullRequestUrl) {
        setCheckState(index, "pull_request", { state: "unobserved", message: "no repository URL was recorded for this delivery" });
        setCheckState(index, "checks", { state: "unobserved", message: "no repository URL was recorded for this delivery" });
      }
      if (record.tagName) setCheckState(index, "tag", { state: "unobserved", message: "no repository URL was recorded for this delivery" });
      return;
    }
    var base = "https://api.github.com/repos/" + repo.owner + "/" + repo.repo;
    var mergeSignal = "no_pr_recorded";
    var checkHeadSha = record.reviewedCommitSha;

    if (record.pullRequestUrl && record.pullRequestNumber) {
      var prResponse = await fetchGitHub(base + "/pulls/" + record.pullRequestNumber);
      var prResult = classify("pull_request", { number: record.pullRequestNumber, reviewedCommitSha: record.reviewedCommitSha }, prResponse);
      setCheckState(index, "pull_request", prResult);
      if (!prResponse.ok) {
        mergeSignal = "unobserved";
      } else if (prResponse.body && prResponse.body.state === "closed" && prResponse.body.merged_at) {
        mergeSignal = "merged";
      } else {
        mergeSignal = "not_merged";
      }
      if (prResponse.ok && prResponse.body && prResponse.body.head && prResponse.body.head.sha) {
        checkHeadSha = prResponse.body.head.sha;
      }
      var checksResponse = await fetchGitHub(base + "/commits/" + checkHeadSha + "/check-runs");
      setCheckState(index, "checks", classify("checks", { sha: checkHeadSha }, checksResponse));
    }

    var branchResponse = await fetchGitHub(base + "/branches/" + encodeURIComponent(record.branch));
    setCheckState(index, "branch", classify("branch", { branch: record.branch, sha: record.reviewedCommitSha, mergeSignal: mergeSignal }, branchResponse));

    if (record.tagName) {
      var tagResponse = await fetchGitHub(base + "/git/ref/tags/" + encodeURIComponent(record.tagName));
      setCheckState(index, "tag", classify("tag", { tag: record.tagName }, tagResponse));
    }
  }

  records.forEach(function (record, index) { checkRecord(record, index); });
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
