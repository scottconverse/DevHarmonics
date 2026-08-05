import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runWorker } from "./run-worker.mjs";
import { runAcpWorker } from "./acp-worker.mjs";
import { runLocalPatch } from "./local-patch.mjs";
import { sendMessages } from "./messages-client.mjs";
import { integrateWorkerBranch } from "./integrate.mjs";
import { runReview } from "./review.mjs";
import { superviseProcess } from "./supervise.mjs";
import { resolvePathCommand } from "./path-resolve.mjs";
import { SUBPROCESS_PROVIDERS } from "./providers.mjs";
import { workerEnv } from "./worker-env.mjs";
import { assuranceFor, missingEvidence, parseRequireEvidence, describeAssurance } from "./assurance.mjs";
import { loadConfig } from "./config.mjs";

/**
 * The single-repo pipeline (spec slice 4): intake -> isolated worker ->
 * optional validator -> the two integration gates -> STOP at the owner
 * approval boundary. Nothing is ever pushed; the deliverable is a local
 * integration branch plus the evidence bundle that says exactly how it
 * got there.
 *
 * Three worker LANES share this one pipeline (spec §2.2): "subprocess"
 * (default, unchanged — an AI CLI run by run-worker.mjs), "acp" (an Agent
 * Client Protocol adapter run by acp-worker.mjs), and "http" (a
 * constrained read-file/write-file round trip run by local-patch.mjs
 * against a plain Messages-API endpoint).
 *
 * "subprocess" and "acp" share the exact same worktree/commit/check shape
 * below — the pipeline itself owns one isolated worktree, the worker
 * edits files in it, then the pipeline stages+commits+checks the result —
 * because both are "an agent edits files in a directory I gave it", just
 * over a different transport (argv/stdout vs. an ACP stdio JSON-RPC
 * session). "http" is structurally different: local-patch.mjs already
 * owns its OWN isolated worktree, already validates paths, already runs
 * the declared check, and already commits only on green, so the pipeline
 * does none of that work twice — it just turns the resulting commit into
 * a `workerBranch` ref and lets the SAME integration (gates + merge) and
 * review logic run unchanged, exactly as the other two lanes do.
 */

const LANES = Object.freeze(["subprocess", "http", "acp"]);

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

/** Split a simple "command arg arg..." string — unchanged from the original
 * subprocess-lane --check parsing (no quoting support). The http lane maps
 * --check onto local-patch's {command, args} the same simple way. */
function splitCheck(check) {
  const [command, ...args] = (check ?? "").split(" ").filter(Boolean);
  return { command, args };
}

export async function runPipeline({
  repository,
  prompt,
  provider,
  model = null,
  check = null,          // "command arg arg..." — validator (subprocess/acp) or local-patch's check (http)
  reviewer = null,       // { lane, provider, model } — independent review after integration
  // Evidence floor: ["validator"], ["review"], or both. Readiness is REFUSED when
  // demanded evidence is absent (A4-6). Empty by default — the level is still always
  // reported, so the honest case needs no flag and the strict case is one flag away.
  requireEvidence = [],
  taskId = null,
  timeoutMs = 15 * 60_000,
  env = process.env,
  lane = "subprocess",   // "subprocess" | "http" | "acp"
  files = null,          // http lane only: array of repo-relative read/write paths (--files)
  adapterCommand = "claude-code-acp", // acp lane only (--adapter)
  baseUrl = null,        // http lane only (--base-url)
  deps = {},
}) {
  if (!LANES.includes(lane)) {
    throw new Error(`runPipeline: lane must be one of ${LANES.join(", ")}, got: ${JSON.stringify(lane)}`);
  }
  if (lane === "http" && (!Array.isArray(files) || files.length === 0)) {
    throw new Error("runPipeline: the http lane requires a non-empty files list (--files, comma-separated repo-relative paths)");
  }

  // Real modules by default; a caller (tests) may inject any subset via
  // `deps` — this is what makes the pipeline hermetically testable without
  // a real AI CLI, a real ACP adapter, or a real HTTP endpoint.
  const d = {
    runWorker,
    runAcpWorker,
    runLocalPatch,
    sendMessages,
    integrateWorkerBranch,
    ...deps,
  };

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

  const stages = { worker: null, commit: null, validator: null, integration: null, review: null };

  // Whatever worktree the lane created (the pipeline's own, for
  // subprocess/acp; local-patch's own, for http) is always removed here,
  // exactly once, regardless of outcome — assigned once that worktree
  // actually exists, a no-op until then.
  let cleanup = () => {};

  try {
    if (lane === "http") {
      const { command, args } = splitCheck(check);
      const task = {
        taskId: runId,
        repository: repo,
        base: baseRef,
        model: model ?? "unspecified",
        baseUrl,
        instructions: prompt,
        readPaths: files,
        writePaths: files,
        check: { command, args },
        commitMessage: `devharmonics ${runId}: ${provider}${model ? `:${model}` : ""}`,
      };
      const patchResult = await d.runLocalPatch({ task, client: d.sendMessages, runsRoot: evidenceRoot, env });
      stages.worker = {
        status: patchResult.receipt.status,
        receiptDir: patchResult.runDir,
        usage: patchResult.receipt.usage,
        detail: patchResult.detail,
      };

      // local-patch leaves its own worktree on disk (by design — "kept for
      // inspection" once real content has been written into it); the
      // pipeline is the one place that knows to clean it back up.
      if (patchResult.worktreePath) {
        const leftoverWorktree = patchResult.worktreePath;
        cleanup = () => {
          git(repo, ["worktree", "remove", "--force", leftoverWorktree]);
          rmSync(path.dirname(leftoverWorktree), { recursive: true, force: true });
        };
      }

      if (patchResult.receipt.status !== "completed") {
        return { integrated: false, reason: `worker-${patchResult.receipt.status}`, runId, baseRef, stages, evidenceRoot };
      }

      // local-patch commits on its OWN branch name; the pipeline's
      // integration contract is a `workerBranch` ref, so point one at the
      // exact commit local-patch just made (a real object already in this
      // repository's object store — worktrees share it).
      const branched = git(repo, ["branch", workerBranch, patchResult.headCommit]);
      if (!branched.ok) throw new Error(`could not create workerBranch from the local-patch commit: ${branched.stderr.trim()}`);
      stages.commit = {
        committed: true,
        head: patchResult.headCommit,
        stat: git(repo, ["diff", "--stat", baseRef, workerBranch]).stdout,
      };
    } else {
      // subprocess and acp: the pipeline owns one isolated worktree the
      // worker edits in. Everything below this point (worktree creation,
      // add/commit, optional --check, cleanup) is UNCHANGED for the
      // subprocess lane and shared as-is by the acp lane — only the actual
      // worker call differs between the two.
      const worktree = mkdtempSync(path.join(os.tmpdir(), `dh-run-${runId}-`));
      const wt = path.join(worktree, "wt");
      const added = git(repo, ["worktree", "add", "-b", workerBranch, wt, baseRef]);
      if (!added.ok) throw new Error(`could not create worker worktree: ${added.stderr.trim()}`);
      cleanup = () => {
        git(repo, ["worktree", "remove", "--force", wt]);
        rmSync(worktree, { recursive: true, force: true });
      };

      const workerResult = lane === "acp"
        ? await d.runAcpWorker({
            taskId: runId,
            provider,
            adapterCommand,
            model,
            prompt,
            cwd: wt,
            runsRoot: evidenceRoot,
            permissionMode: "allow-edits",
            timeoutMs,
            env,
          })
        : await d.runWorker({
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
        const { command: checkCommand, args: checkArgs } = splitCheck(check);
        // C-2 (GAUNTLET-2026-08-05): the validator executes INSIDE the worktree
        // the untrusted worker just committed to, so one planted test line or a
        // pretest hook would run with every credential on the box and leak it
        // into stdoutTail -> receipt -> reviewer prompt. Strip credential-shaped
        // vars exactly as the worker lane does; PATH survives so it still runs.
        const { env: checkEnv } = workerEnv(env);
        const resolved = resolvePathCommand(checkCommand, { env: checkEnv });
        if (!resolved) return { integrated: false, reason: `validator-unresolvable: ${checkCommand}`, runId, baseRef, stages, evidenceRoot };
        const validated = await superviseProcess({ command: resolved, args: checkArgs, cwd: wt, prompt: null, timeoutMs: 10 * 60_000, env: checkEnv });
        stages.validator = { command: check, exitCode: validated.exitCode, timedOut: validated.timedOut, stdoutTail: validated.stdout.slice(-2000), stderrTail: validated.stderr.slice(-2000) };
        if (validated.exitCode !== 0) {
          return { integrated: false, reason: `validator-failed (exit ${validated.exitCode})`, runId, baseRef, stages, evidenceRoot };
        }
      }
    }

    const integration = await d.integrateWorkerBranch({
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
      // GAUNTLET-2026-08-05 M-1: claimedPaths is deliberately null here. The
      // divergence gate is sound (see review.mjs / its tests) but it needs a
      // manifest of what the WORKER claimed it changed, distinct from the diff.
      // The subprocess lane's worker emits only freeform narration, no
      // structured change-manifest, and parsing prose for "claimed" paths
      // yields false positives that would block honest runs. Feeding the diff
      // back in (the previous behavior) compared the diff to itself — a gate
      // mathematically incapable of finding anything, reported as a reassuring
      // "0 divergence". That false green is removed: divergence is reported as
      // null ("not checked") until a structured worker-claims source exists.
      // The artifact-lens reviewer still judges the real diff, so the actual
      // protection is unchanged.
      const review = await runReview({
        repository: repo,
        integrationBranch,
        baseRef,
        goal: prompt,
        reviewer,
        claimedPaths: null,
        checkReceiptsSummary: stages.validator
          ? `Validator: ${stages.validator.command}
exit code: ${stages.validator.exitCode}${stages.validator.timedOut ? " (timed out)" : ""}
${(stages.validator.stdoutTail || "").slice(-800)}`
          : "No validator was configured for this run.",
        evidenceRoot,
        env,
        timeoutMs,
      });
      const divergenceCount = review.divergence === null ? null : review.divergence.length;
      stages.review = { verdict: review.verdict, findings: review.findings?.length ?? 0, divergence: divergenceCount, receipt: review.reviewReceiptPath };
      if (review.verdict !== "READY") {
        const divergenceNote = divergenceCount === null ? "divergence not checked" : `${divergenceCount} divergence`;
        return {
          integrated: true, reviewed: false, reason: `review-not-ready (${review.findings?.length ?? 0} finding(s), ${divergenceNote})`,
          runId, baseRef, integrationBranch, integrationHead: integration.integrationHead, stages, evidenceRoot,
        };
      }
    }

    // Assurance (A4-6): report readiness qualified by the evidence that actually
    // ran, never as a bare "READY", and refuse it outright if the operator demanded
    // evidence that is absent. Derived from what passed, not from what was asked for.
    const validatorPassed = stages.validator?.exitCode === 0;
    const reviewPassed = stages.review?.verdict === "READY";
    const assurance = assuranceFor({ validatorPassed, reviewPassed });
    const missing = missingEvidence(requireEvidence, { validatorPassed, reviewPassed });
    if (missing.length > 0) {
      return {
        integrated: true,
        reviewed: reviewPassed,
        assurance,
        requiredEvidence: requireEvidence,
        missingEvidence: missing,
        reason: `insufficient-evidence (missing: ${missing.join(", ")})`,
        runId, baseRef, integrationBranch,
        integrationHead: integration.integrationHead, stages, evidenceRoot,
      };
    }

    return {
      integrated: true,
      reviewed: Boolean(reviewer),
      assurance,
      requiredEvidence: requireEvidence,
      missingEvidence: [],
      reason: "ready-for-owner-review",
      runId, baseRef, integrationBranch,
      integrationHead: integration.integrationHead, stages, evidenceRoot,
    };
  } finally {
    cleanup();
  }
}

/** --reviewer "provider:model" (subprocess lane) or "http:provider:model". */
export function parseReviewerSpec(spec, config) {
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
  const options = {
    repository: null, prompt: null, provider: null, model: null, check: null,
    reviewer: null, requireEvidence: null, taskId: null, asJson: false, timeoutMinutes: 15,
    lane: "subprocess", files: null, adapter: "claude-code-acp", baseUrl: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => { i += 1; return argv[i]; };
    switch (argv[i]) {
      case "--repository": options.repository = next(); break;
      case "--prompt": options.prompt = next(); break;
      case "--provider": options.provider = next(); break;
      case "--model": options.model = next(); break;
      case "--check": options.check = next(); break;
      case "--reviewer": options.reviewer = next(); break;
      case "--require-evidence": options.requireEvidence = next(); break;
      case "--task-id": options.taskId = next(); break;
      case "--timeout-minutes": options.timeoutMinutes = Number(next()); break;
      case "--lane": options.lane = next(); break;
      case "--files": options.files = next(); break;
      case "--adapter": options.adapter = next(); break;
      case "--base-url": options.baseUrl = next(); break;
      case "--json": options.asJson = true; break;
      default: throw new Error(`Unknown run option: ${argv[i]}`);
    }
  }
  if (!options.repository || !options.prompt) throw new Error("--repository and --prompt are required");
  if (!options.provider) throw new Error("--provider is required");
  if (options.lane === "subprocess" && !SUBPROCESS_PROVIDERS.includes(options.provider)) {
    throw new Error(`--provider must be one of ${SUBPROCESS_PROVIDERS.join(", ")}`);
  }

  const { config } = loadConfig();
  const files = options.files ? options.files.split(",").map((s) => s.trim()).filter(Boolean) : null;
  let baseUrl = options.baseUrl;
  if (options.lane === "http" && !baseUrl) {
    baseUrl = config?.endpoints?.[options.provider]?.baseUrl ?? null;
    if (!baseUrl) throw new Error(`--base-url is required for the http lane (no endpoints.${options.provider}.baseUrl in config either)`);
  }

  const result = await runPipeline({
    repository: options.repository,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    check: options.check,
    reviewer: options.reviewer ? parseReviewerSpec(options.reviewer, config) : null,
    requireEvidence: parseRequireEvidence(options.requireEvidence),
    taskId: options.taskId,
    timeoutMs: Math.round(options.timeoutMinutes * 60_000),
    lane: options.lane,
    files,
    adapterCommand: options.adapter,
    baseUrl,
  });

  if (options.asJson) {
    write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    write(`run:         ${result.runId} (base ${result.baseRef?.slice(0, 8)})\n`);
    write(`lane:        ${options.lane}\n`);
    write(`outcome:     ${result.integrated ? "INTEGRATED" : "REFUSED"} — ${result.reason}\n`);
    if (result.stages?.review) {
      const r = result.stages.review;
      const divergenceText = r.divergence === null || r.divergence === undefined ? "divergence not checked" : `${r.divergence} divergence`;
      write(`review:      ${r.verdict} (${r.findings} finding(s), ${divergenceText})
`);
    }
    if (result.assurance) {
      write(`assurance:   ${describeAssurance(result.assurance, result.requiredEvidence)}\n`);
    }
    if (result.missingEvidence?.length) {
      write(`             REFUSED for missing evidence: ${result.missingEvidence.join(", ")}\n`);
    }
    if (result.integrated && result.reason === "ready-for-owner-review") {
      write(`branch:      ${result.integrationBranch} @ ${result.integrationHead?.slice(0, 8)}\n`);
      write(`\nSTOPPED at the owner approval boundary. Nothing was pushed.\n`);
      write(`Review the branch and the evidence bundle, then merge/push only if you approve.\n`);
    }
    write(`evidence:    ${result.evidenceRoot}\n`);
  }
  // A run that integrated but failed the operator's evidence floor is NOT a success:
  // the demanded proof is absent, so it exits refused.
  return result.integrated && !(result.missingEvidence?.length > 0) ? 0 : 1;
}
