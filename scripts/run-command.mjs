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
import { SUBPROCESS_PROVIDERS } from "./providers.mjs";
import { assuranceFor, missingEvidence, parseRequireEvidence, describeAssurance } from "./assurance.mjs";
import { detectSuiteQualification, describeSuiteQualification } from "./suite-qualification.mjs";
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
  maxBudgetUsd = null,   // spend ceiling forwarded to a provider that supports one (claude)
  // Evidence floor: ["validator"], ["review"], or both. Readiness is REFUSED when
  // demanded evidence is absent (A4-6). Empty by default — the level is still always
  // reported, so the honest case needs no flag and the strict case is one flag away.
  requireEvidence = [],
  // R-7 (owner decision): the tampercheck pin stays opt-in, but it must be
  // REACHABLE — these were library-only knobs no CLI caller could set.
  tampercheckPath = null,          // absolute path — never consult PATH at all
  expectedTampercheckSha256 = null, // content pin; mismatch refuses the gate
  // D1 fan-out ceilings (audit ENG-001): { stateRoot?, budgets? } — the
  // operator's budgets, threaded to every worker AND the reviewer. When set,
  // the state root defaults to the repository's own .devharmonics so caps
  // accumulate where the work happens.
  admission = undefined,
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
  // A1-4 / A2-4b: --check was advertised as optional, but the http lane's task
  // validation throws on a missing check.command AFTER setup, surfacing as an opaque
  // exit 2. Stated up front instead, alongside the --files requirement — and after
  // it, so the more fundamental missing-files case still reports first.
  if (lane === "http" && (check === null || String(check).trim().length === 0)) {
    throw new Error('runPipeline: the http lane requires --check (e.g. --check "npm test") — its structured-write mode commits only when a declared check passes, so there is no no-validator mode for this lane');
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

  // The repository's .devharmonics is the canonical meter for this pipeline's
  // worker AND its reviewer; a caller-supplied stateRoot still wins.
  const workerAdmission = admission
    ? { stateRoot: path.join(repo, ".devharmonics"), ...admission }
    : undefined;

  const runId = (taskId ?? `run-${randomUUID().slice(0, 8)}`).toLowerCase();
  const baseRef = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  if (!baseRef) throw new Error("could not resolve HEAD; the repository needs at least one commit");
  const stateRoot = path.join(repo, ".devharmonics");
  const evidenceRoot = path.join(stateRoot, "runs", runId);
  const workerBranch = `devharmonics/task/${runId}`;
  const integrationBranch = `devharmonics/integration/${runId}`;

  // A1-7 (independent audit): branch names are derived deterministically from
  // --task-id, and a stable task id is exactly what an operator reuses when
  // retrying interrupted work. The second run died inside `git worktree add -b`
  // with a raw "a branch named ... already exists", which reads like a bug in the
  // tool rather than a decision the operator has to make.
  //
  // There is no resume: the pipeline keeps no resumable state, so silently reusing
  // the branch could mix a new attempt into an old one's commits. Refuse up front,
  // name the branch, and state the two honest ways forward.
  const existingWorker = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${workerBranch}`]).ok;
  const existingIntegration = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${integrationBranch}`]).ok;
  if (existingWorker || existingIntegration) {
    const which = [existingWorker ? workerBranch : null, existingIntegration ? integrationBranch : null].filter(Boolean);
    throw new Error(
      `task-id "${runId}" has already been used in this repository: ${which.join(" and ")} ${which.length > 1 ? "already exist" : "already exists"}. `
      + "This pipeline has no resume — it keeps no resumable state, so reusing these refs could blend a new attempt into an old one's history. "
      + `Either choose a different --task-id, or delete the previous refs once you have finished with them (git branch -D ${which.join(" ")}).`,
    );
  }

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
        // A2-4a: --timeout-minutes was parsed and then never handed to the http
        // lane, so the model call and the check silently used local-patch's own
        // hard-coded 5 minutes no matter what the operator asked for.
        timeoutMs,
        commitMessage: `devharmonics ${runId}: ${provider}${model ? `:${model}` : ""}`,
      };
      const patchResult = await d.runLocalPatch({ task, client: d.sendMessages, runsRoot: evidenceRoot, env });
      stages.worker = {
        status: patchResult.receipt.status,
        receiptDir: patchResult.runDir,
        usage: patchResult.receipt.usage,
        detail: patchResult.detail,
      };
      // A2-4c: local-patch runs the check ITSELF as its commit gate. On success,
      // stages.validator is populated below from the integration engine's own
      // validator run against the MERGED candidate (R-5) — the authoritative
      // result. On a check failure inside local-patch, integration never runs,
      // so surface local-patch's own result here instead.
      if (patchResult.detail?.exitCode !== undefined && patchResult.detail?.message === "check failed") {
        stages.validator = {
          command: [command, ...args].join(" "),
          exitCode: patchResult.detail.exitCode ?? null,
          timedOut: Boolean(patchResult.detail.timedOut),
          stdoutTail: "",
          stderrTail: (patchResult.detail.stderrTail ?? "").slice(-2000),
          ranInsideLocalPatch: true,
        };
      }

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
            admission: workerAdmission,
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
            maxBudgetUsd,
            admission: workerAdmission,
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

      // R-5 (audit residual): the validator used to run HERE, pre-merge, in the
      // worker's own worktree — while `set`'s ran on the merged candidate. So
      // `run` could pass a check the delivered merge would fail. The check now
      // rides into integrateWorkerBranch (the same machinery `set` uses) and
      // executes against the exact merged commit offered to the owner, with the
      // same credential-stripped env (C-2) it always had.
    }

    const integration = await d.integrateWorkerBranch({
      repository: repo,
      integrationBranch,
      workerBranch,
      baseRef,
      taskId: runId,
      evidenceRoot,
      check: check ? splitCheck(check) : null,
      tampercheckPath,
      expectedTampercheckSha256,
      env,
    });
    stages.integration = integration;
    // The validator's authoritative result — run against the merged candidate
    // inside integrateWorkerBranch — surfaced in the shape the reviewer prompt
    // and the assurance ladder already consume.
    const gateValidator = integration.gates?.validator;
    if (gateValidator && gateValidator.status !== "skipped") {
      stages.validator = {
        command: gateValidator.command ?? check,
        exitCode: gateValidator.exitCode,
        timedOut: gateValidator.timedOut,
        stdoutTail: gateValidator.stdoutTail ?? "",
        stderrTail: gateValidator.stderrTail ?? "",
        candidateHead: gateValidator.candidateHead ?? null,
        onMergedCandidate: true,
      };
    }
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
        admission: workerAdmission,
      });
      const divergenceCount = review.divergence === null ? null : review.divergence.length;
      stages.review = { verdict: review.verdict, findings: review.findings?.length ?? 0, divergence: divergenceCount, receipt: review.reviewReceiptPath };
      // Deliberately NO early return on a NOT_READY verdict (audit DOC-004): the
      // old early return skipped the evidence floor below, so
      // `--require-evidence review` exited 0 on the exact case it exists for —
      // a reviewer that ran and refused. The floor and the assurance ladder now
      // see every review outcome; `set` always worked this way.
    }

    // Assurance (A4-6): report readiness qualified by the evidence that actually
    // ran, never as a bare "READY", and refuse it outright if the operator demanded
    // evidence that is absent. Derived from what passed, not from what was asked for.
    const validatorPassed = stages.validator?.exitCode === 0;
    const reviewPassed = stages.review?.verdict === "READY";
    const assurance = assuranceFor({ validatorPassed, reviewPassed });
    // SPEC §2.4: label validator-green by whether this repo's suite was ever proven
    // sensitive. Detection only — see suite-qualification.mjs for why enforcing
    // deterministic-detector here would violate that tool's own contract.
    const suiteQualification = detectSuiteQualification(repo);
    stages.suiteQualification = suiteQualification;
    const missing = missingEvidence(requireEvidence, { validatorPassed, reviewPassed });
    if (missing.length > 0) {
      return {
        integrated: true,
        reviewed: reviewPassed,
        assurance,
        suiteQualification,
        requiredEvidence: requireEvidence,
        missingEvidence: missing,
        reason: `insufficient-evidence (missing: ${missing.join(", ")})`,
        runId, baseRef, integrationBranch,
        integrationHead: integration.integrationHead, stages, evidenceRoot,
      };
    }

    if (reviewer && !reviewPassed) {
      const d = stages.review?.divergence;
      const divergenceNote = d === null || d === undefined ? "divergence not checked" : `${d} divergence`;
      return {
        integrated: true,
        reviewed: false,
        assurance,
        suiteQualification,
        requiredEvidence: requireEvidence,
        missingEvidence: [],
        reason: `review-not-ready (${stages.review?.findings ?? 0} finding(s), ${divergenceNote})`,
        runId, baseRef, integrationBranch,
        integrationHead: integration.integrationHead, stages, evidenceRoot,
      };
    }

    return {
      integrated: true,
      reviewed: Boolean(reviewer),
      assurance,
      suiteQualification,
      requiredEvidence: requireEvidence,
      missingEvidence: [],
      reason: "ready-for-owner-review",
      runId, baseRef, integrationBranch,
      integrationHead: integration.integrationHead, stages, evidenceRoot,
    };
  } finally {
    cleanup();
    // QA-005 (audit): a refused run used to leave devharmonics/task/<id> behind
    // even when the worker never committed anything, turning every transient
    // failure into manual cleanup on retry. A branch still pointing EXACTLY at
    // the pinned base provably has nothing to blend into a future attempt —
    // delete it. A branch with commits is preserved (the no-resume refusal's
    // rationale genuinely applies there).
    const workerTip = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${workerBranch}`]).stdout.trim();
    if (workerTip && workerTip === baseRef) {
      git(repo, ["branch", "-D", workerBranch]);
    }
  }
}

/**
 * One honest line about the integrity gate's identity posture (R-7, owner
 * decision): the pin stays opt-in, but the loose mode must never look like the
 * strict one — same pattern as the assurance ladder. Empty when the gate never
 * fingerprinted a binary (refused before tampercheck, or integration not reached).
 */
export function describeTampercheckIdentity(binary) {
  if (!binary || !binary.path) return "";
  // QA-002 (audit): three states, never conflated — a REQUESTED pin whose
  // comparison failed must not read as a verified one.
  if (binary.pinned && binary.verified) {
    // ENG-002: for a pip console-script launcher, the hash binds the LAUNCHER
    // file, not the package code in site-packages that produces the verdict —
    // say so rather than letting the strongest claim overreach.
    const launcherNote = binary.launcherShaped ? "; binds the launcher file — the Python package it invokes is not covered by this pin, see the manual" : "";
    return `tampercheck: identity pinned — sha256 verified (${binary.path}${launcherNote})\n`;
  }
  if (binary.pinned) {
    return `tampercheck: identity pin REQUESTED but MISMATCHED — the gate refused (${binary.path} is sha256 ${binary.sha256 ?? "(unreadable)"})\n`;
  }
  const hint = binary.sha256 ? ` — pin with --tampercheck-sha256 ${binary.sha256}` : "";
  return `tampercheck: identity version-shape only (unpinned${hint})\n`;
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
    reviewer: null, requireEvidence: null, maxBudgetUsd: null, tampercheckPath: null, expectedTampercheckSha256: null, configPath: null, taskId: null, asJson: false, timeoutMinutes: 15,
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
      case "--timeout-minutes": {
        // A1-6: a bare Number() accepted "nope", "-1" and "Infinity", which reached
        // the timeout APIs as NaN / negative / infinite. Reject before anything is
        // created, so an invalid operational limit never produces a branch, an
        // evidence directory, a worktree, or a subprocess.
        const raw = next();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--timeout-minutes must be a positive finite number, got: ${JSON.stringify(raw)}`);
        }
        options.timeoutMinutes = parsed;
        break;
      }
      case "--max-budget-usd": {
        const raw = next();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--max-budget-usd must be a positive finite number, got: ${JSON.stringify(raw)}`);
        }
        options.maxBudgetUsd = parsed;
        break;
      }
      case "--lane": options.lane = next(); break;
      case "--files": options.files = next(); break;
      case "--adapter": options.adapter = next(); break;
      case "--base-url": options.baseUrl = next(); break;
      case "--config": options.configPath = next(); break;
      case "--tampercheck-path": options.tampercheckPath = next(); break;
      case "--tampercheck-sha256": {
        const raw = next();
        if (!/^[0-9a-fA-F]{64}$/.test(raw ?? "")) {
          throw new Error(`--tampercheck-sha256 must be a 64-hex-character sha256 digest, got: ${raw === undefined ? "missing value" : JSON.stringify(raw)} (doctor prints the resolved binary's value)`);
        }
        options.expectedTampercheckSha256 = raw;
        break;
      }
      case "--json": options.asJson = true; break;
      default: throw new Error(`Unknown run option: ${argv[i]}`);
    }
  }
  if (!options.repository || !options.prompt) throw new Error("--repository and --prompt are required");
  if (!options.provider) throw new Error("--provider is required");
  // QA-004 (audit): a PROVIDED --check that trims to empty (e.g. an unset shell
  // variable) used to silently downgrade the run to gates-only; `set` already
  // refuses this. An omitted --check stays legal.
  if (options.check !== null && String(options.check).trim().length === 0) {
    throw new Error('--check must be a non-empty command, e.g. --check "npm test"');
  }
  if (options.lane === "subprocess" && !SUBPROCESS_PROVIDERS.includes(options.provider)) {
    throw new Error(`--provider must be one of ${SUBPROCESS_PROVIDERS.join(", ")}`);
  }

  // ENG-001 (audit): the fan-out budgets were validated config that no spawning
  // command could consume — the refusal message's own remedy was impossible.
  // Every spawning command now takes --config and threads its budgets to the
  // admission gate (workers AND the reviewer).
  const { config } = loadConfig(options.configPath);
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
    maxBudgetUsd: options.maxBudgetUsd,
    tampercheckPath: options.tampercheckPath,
    expectedTampercheckSha256: options.expectedTampercheckSha256,
    admission: { budgets: config.budgets },
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
    write(describeTampercheckIdentity(result.stages?.integration?.gates?.tampercheckBinary));
    if (result.stages?.review) {
      const r = result.stages.review;
      const divergenceText = r.divergence === null || r.divergence === undefined ? "divergence not checked" : `${r.divergence} divergence`;
      write(`review:      ${r.verdict} (${r.findings} finding(s), ${divergenceText})
`);
    }
    if (result.assurance) {
      write(`assurance:   ${describeAssurance(result.assurance, result.requiredEvidence)}\n`);
      // Never let "validated" stand unqualified when the suite was never proven able to fail.
      if (result.stages?.suiteQualification && result.assurance.startsWith("validated")) {
        write(`             suite: ${describeSuiteQualification(result.stages.suiteQualification)}\n`);
      }
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
