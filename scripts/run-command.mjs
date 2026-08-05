import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runWorker } from "./run-worker.mjs";
import { integrateWorkerBranch } from "./integrate.mjs";
import { runReview } from "./review.mjs";
import { superviseProcess } from "./supervise.mjs";
import { resolvePathCommand } from "./path-resolve.mjs";
import { SUBPROCESS_PROVIDERS } from "./providers.mjs";
import { loadConfig } from "./config.mjs";

/**
 * The single-repo pipeline (spec slice 4): intake -> isolated worker ->
 * optional validator -> the two integration gates -> STOP at the owner
 * approval boundary. Nothing is ever pushed; the deliverable is a local
 * integration branch plus the evidence bundle that says exactly how it
 * got there.
 */

function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Tracked changes refuse intake (v1 rule: never stash, reset, or silently omit owner work). Untracked files are allowed. */
function assertCleanTrackedTree(repository) {
  const status = git(repository, ["status", "--porcelain"]);
  if (!status.ok) throw new Error(`not a usable git repository: ${repository}: ${status.stderr.trim()}`);
  const dirty = status.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("??"));
  if (dirty.length) {
    throw new Error(`repository has tracked uncommitted changes; commit or stash them first:\n${dirty.slice(0, 10).join("\n")}`);
  }
}

/** Keep factory state out of the owner's shared .gitignore — private exclude, v1 precedent. */
function ensureExcluded(repository) {
  const exclude = path.join(repository, ".git", "info", "exclude");
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.includes(".devharmonics/")) appendFileSync(exclude, "\n.devharmonics/\n");
  } catch { /* non-fatal: state dir simply shows as untracked */ }
}

export async function runPipeline({
  repository,
  prompt,
  provider,
  model = null,
  check = null,          // "command arg arg..." run inside the worker worktree
  reviewer = null,       // { lane, provider, model } — independent review after integration
  taskId = null,
  timeoutMs = 15 * 60_000,
  env = process.env,
}) {
  const repo = path.resolve(repository);
  assertCleanTrackedTree(repo);
  ensureExcluded(repo);

  const runId = (taskId ?? `run-${randomUUID().slice(0, 8)}`).toLowerCase();
  const baseRef = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  if (!baseRef) throw new Error("could not resolve HEAD; the repository needs at least one commit");
  const stateRoot = path.join(repo, ".devharmonics");
  const evidenceRoot = path.join(stateRoot, "runs", runId);
  const workerBranch = `devharmonics/task/${runId}`;
  const integrationBranch = `devharmonics/integration/${runId}`;

  // Worker worktree lives in the system temp dir — never nested inside the
  // target repo's working tree (the slice-3 lesson: nested fixtures changed
  // codex's sandbox verdicts and claude's session behavior).
  const worktree = mkdtempSync(path.join(os.tmpdir(), `dh-run-${runId}-`));
  const wt = path.join(worktree, "wt");
  const added = git(repo, ["worktree", "add", "-b", workerBranch, wt, baseRef]);
  if (!added.ok) throw new Error(`could not create worker worktree: ${added.stderr.trim()}`);

  const stages = { worker: null, commit: null, validator: null, integration: null, review: null };
  try {
    const workerResult = await runWorker({
      taskId: runId,
      provider,
      model,
      prompt,
      cwd: wt,
      runsRoot: evidenceRoot,
      sandbox: "workspace-write",
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Edit", "Write"],
      timeoutMs,
      env,
    });
    stages.worker = { status: workerResult.receipt.status, receiptDir: workerResult.runDir, usage: workerResult.receipt.usage };
    if (workerResult.receipt.status !== "completed") {
      return { integrated: false, reason: `worker-${workerResult.receipt.status}`, runId, baseRef, stages, evidenceRoot };
    }

    git(wt, ["add", "-A"]);
    const staged = git(wt, ["diff", "--cached", "--stat"]).stdout.trim();
    if (!staged) {
      stages.commit = { committed: false };
      return { integrated: false, reason: "worker-empty-diff", runId, baseRef, stages, evidenceRoot };
    }
    const committed = git(wt, ["commit", "-m", `devharmonics ${runId}: ${provider}${model ? `:${model}` : ""}`]);
    if (!committed.ok) return { integrated: false, reason: `commit-failed: ${committed.stderr.trim()}`, runId, baseRef, stages, evidenceRoot };
    stages.commit = { committed: true, head: git(wt, ["rev-parse", "HEAD"]).stdout.trim(), stat: staged };

    if (check) {
      const [checkCommand, ...checkArgs] = check.split(" ").filter(Boolean);
      const resolved = resolvePathCommand(checkCommand, { env });
      if (!resolved) return { integrated: false, reason: `validator-unresolvable: ${checkCommand}`, runId, baseRef, stages, evidenceRoot };
      const validated = await superviseProcess({ command: resolved, args: checkArgs, cwd: wt, prompt: null, timeoutMs: 10 * 60_000, env });
      stages.validator = { command: check, exitCode: validated.exitCode, timedOut: validated.timedOut, stdoutTail: validated.stdout.slice(-2000), stderrTail: validated.stderr.slice(-2000) };
      if (validated.exitCode !== 0) {
        return { integrated: false, reason: `validator-failed (exit ${validated.exitCode})`, runId, baseRef, stages, evidenceRoot };
      }
    }

    const integration = await integrateWorkerBranch({
      repository: repo,
      integrationBranch,
      workerBranch,
      baseRef,
      taskId: runId,
      evidenceRoot,
      env,
    });
    stages.integration = integration;
    if (!integration.integrated) {
      return { integrated: false, reason: integration.reason, runId, baseRef, integrationBranch: null, integrationHead: null, stages, evidenceRoot };
    }

    // Independent review AFTER the deterministic gates: the model reviewer is
    // the last layer, never the first. Its verdict cannot rescue a run the
    // gates refused, and the divergence check inside runReview outranks it.
    if (reviewer) {
      const claimedPaths = git(repo, ["diff", "--name-only", baseRef, workerBranch]).stdout
        .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const review = await runReview({
        repository: repo,
        integrationBranch,
        baseRef,
        goal: prompt,
        reviewer,
        claimedPaths,
        checkReceiptsSummary: stages.validator
          ? `Validator: ${stages.validator.command}
exit code: ${stages.validator.exitCode}${stages.validator.timedOut ? " (timed out)" : ""}
${(stages.validator.stdoutTail || "").slice(-800)}`
          : "No validator was configured for this run.",
        evidenceRoot,
        env,
        timeoutMs,
      });
      stages.review = { verdict: review.verdict, findings: review.findings?.length ?? 0, divergence: review.divergence?.length ?? 0, receipt: review.reviewReceiptPath };
      if (review.verdict !== "READY") {
        return {
          integrated: true, reviewed: false, reason: `review-not-ready (${review.findings?.length ?? 0} finding(s), ${review.divergence?.length ?? 0} divergence)`,
          runId, baseRef, integrationBranch, integrationHead: integration.integrationHead, stages, evidenceRoot,
        };
      }
    }

    return {
      integrated: true,
      reviewed: Boolean(reviewer),
      reason: "ready-for-owner-review",
      runId, baseRef, integrationBranch,
      integrationHead: integration.integrationHead, stages, evidenceRoot,
    };
  } finally {
    git(repo, ["worktree", "remove", "--force", wt]);
    rmSync(worktree, { recursive: true, force: true });
  }
}

/** --reviewer "provider:model" (subprocess lane) or "http:provider:model". */
function parseReviewerSpec(spec, config) {
  const parts = spec.split(":");
  if (parts[0] === "http") {
    // Found by the slice-8 manual audit: this form parsed but could never
    // work — runReview's http branch needs a baseUrl and nothing supplied
    // one, so it failed closed as reviewer-unavailable every time. The
    // endpoint now comes from config by provider name.
    if (parts.length < 3) throw new Error('--reviewer http form is "http:provider:model"');
    const provider = parts[1];
    const baseUrl = config?.endpoints?.[provider]?.baseUrl;
    if (!baseUrl) throw new Error(`--reviewer http:${provider}: no endpoints.${provider}.baseUrl in config`);
    return { lane: "http", provider, model: parts.slice(2).join(":"), baseUrl };
  }
  if (parts.length < 2) throw new Error('--reviewer must be "provider:model" or "http:provider:model"');
  return { lane: "subprocess", provider: parts[0], model: parts.slice(1).join(":") };
}

export async function runCommandCli(argv, { write = (t) => process.stdout.write(t) } = {}) {
  const options = { repository: null, prompt: null, provider: null, model: null, check: null, reviewer: null, taskId: null, asJson: false, timeoutMinutes: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => { i += 1; return argv[i]; };
    switch (argv[i]) {
      case "--repository": options.repository = next(); break;
      case "--prompt": options.prompt = next(); break;
      case "--provider": options.provider = next(); break;
      case "--model": options.model = next(); break;
      case "--check": options.check = next(); break;
      case "--reviewer": options.reviewer = next(); break;
      case "--task-id": options.taskId = next(); break;
      case "--timeout-minutes": options.timeoutMinutes = Number(next()); break;
      case "--json": options.asJson = true; break;
      default: throw new Error(`Unknown run option: ${argv[i]}`);
    }
  }
  if (!options.repository || !options.prompt) throw new Error("--repository and --prompt are required");
  if (!SUBPROCESS_PROVIDERS.includes(options.provider)) throw new Error(`--provider must be one of ${SUBPROCESS_PROVIDERS.join(", ")}`);

  const result = await runPipeline({
    repository: options.repository,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    check: options.check,
    reviewer: options.reviewer ? parseReviewerSpec(options.reviewer, loadConfig().config) : null,
    taskId: options.taskId,
    timeoutMs: Math.round(options.timeoutMinutes * 60_000),
  });

  if (options.asJson) {
    write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    write(`run:         ${result.runId} (base ${result.baseRef?.slice(0, 8)})\n`);
    write(`outcome:     ${result.integrated ? "INTEGRATED" : "REFUSED"} — ${result.reason}\n`);
    if (result.stages?.review) {
      const r = result.stages.review;
      write(`review:      ${r.verdict} (${r.findings} finding(s), ${r.divergence} divergence)
`);
    }
    if (result.integrated && result.reason === "ready-for-owner-review") {
      write(`branch:      ${result.integrationBranch} @ ${result.integrationHead?.slice(0, 8)}\n`);
      write(`\nSTOPPED at the owner approval boundary. Nothing was pushed.\n`);
      write(`Review the branch and the evidence bundle, then merge/push only if you approve.\n`);
    }
    write(`evidence:    ${result.evidenceRoot}\n`);
  }
  return result.integrated ? 0 : 1;
}
