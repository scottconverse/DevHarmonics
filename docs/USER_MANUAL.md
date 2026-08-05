# DevHarmonics User Manual

## 1. What this is

DevHarmonics is a set of plain Node.js command-line scripts that let an AI coding agent make one bounded, gated change to a git repository on your own machine, using accounts you already have — there is no DevHarmonics server and no DevHarmonics account. Work is driven through one of three worker lanes: subprocess (a supervised call to a signed-in subscription CLI — Codex, Claude Code, or Antigravity's `agy`), HTTP (one Anthropic-Messages-API client pointed at a local model server or, only if you opt in, the real Claude API), and ACP (the Agent Client Protocol — implemented in this codebase but not yet wired into any command; see "Known limitations"). A change only reaches a local integration branch after clearing an empty-diff check and a `tampercheck` integrity scan, and it is never pushed anywhere or merged into your own branch — the tool always stops at a point where you, the owner, decide what happens next. Every attempt, whether it succeeds, is refused, or never even starts, leaves a written receipt.

## 2. Requirements

- **Node.js 24 or newer** (`package.json` declares `"engines": {"node": ">=24"}`), and **Git**.
- To use the **subprocess** lane: at least one of the Codex CLI (`codex`), Claude Code (`claude`), or Antigravity's CLI (`agy`) installed and already signed in. DevHarmonics finds it the way your own shell would (real `PATH`/`PATHEXT` resolution) and calls it the way you would from a terminal.
- To use the **HTTP** lane: a locally running Anthropic-compatible Messages endpoint. The built-in defaults are Ollama on `http://127.0.0.1:11434`, LM Studio on `http://127.0.0.1:1234`, and a LiteLLM proxy on `http://127.0.0.1:4000`. A real Anthropic API key is supported only as a separate, explicit opt-in — nothing reaches for one by default.
- To use the **ACP** lane: an installed ACP adapter for your provider. The code to drive one exists (`scripts/acp-worker.mjs`, with its own passing tests), but no `devharmonics` command currently calls it — see "Known limitations."
- **DevHarmonics never asks you for an API key.** It authenticates the way you already do — a signed-in subscription CLI, or a local endpoint that needs no key at all — and it is not built around cloud credentials.

## 3. Install

There is no published package yet; install from source.

```
git clone https://github.com/scottconverse/DevHarmonics.git
cd DevHarmonics
npm ci
npm link
```

`npm ci` installs the repository's one runtime dependency (`@agentclientprotocol/sdk`). `npm link` uses the `bin` entry in `package.json` to put a global `devharmonics` command on your `PATH`, pointing at `scripts/cli.mjs`. Confirm it worked with:

```
devharmonics --version
```

If you'd rather not create a global link, every command below also works as `node scripts/cli.mjs <command> ...` run from the repository root.

Two other npm scripts are useful straight from the repo: `npm test` runs the automated test suite (`node --test "test/*.test.mjs"`), and `npm run check` runs a syntax check over every script followed by the full test suite — this is exactly what CI runs, on both Ubuntu and Windows.

## 4. Commands

DevHarmonics has five commands: `doctor`, `onboard`, `qualify`, `worker`, and `run`. There is no per-command `--help` — every subcommand's argument parser treats an unrecognized flag (including `--help`) as an error and exits with code 2. Run `devharmonics --help`, `devharmonics -h`, or `devharmonics` with no arguments to see the built-in usage summary.

### `doctor`

Probes every capability the factory depends on and reports PASS, FAIL, or SKIPPED for each one — never inferred from configuration, always from a real attempt.

```
devharmonics doctor [--json] [--config <file>] [--repository <repo>]
```

- `--json` — print the full report as JSON instead of a text table.
- `--config <file>` — load a config file instead of the built-in defaults (deep-merged over them). An invalid file is a hard error, never a silent fallback.
- `--repository <repo>` — also check whether the named repository is "governed" (has the pinned `tampercheck` CI workflow that `devharmonics onboard` installs). Without this flag that check is reported SKIPPED, not FAIL, since no repository was in scope.

What it actually checks: each configured CLI (`codex`, `claude`, `agy`) by resolving it on `PATH` and running its real `--version`; each configured HTTP endpoint (Ollama, LM Studio, LiteLLM) by discovering an available model and sending it a real Messages request; whether `tampercheck` itself is on `PATH`; and whether the `dev-rigor-stack-lite` skill is installed at the *same* version under every configured coordinator host (`~/.claude/skills` and `~/.codex/skills` by default).

**Exit codes:** 0 = the assessment completed, including a report full of FAILs. 2 = doctor itself could not run (bad flag, unreadable config file).

Real output, captured on this machine:
```
DevHarmonics doctor

PASS    cli:codex           codex-cli 0.145.0
PASS    cli:claude          2.1.220 (Claude Code)
FAIL    cli:agy             "agy" not found on PATH
PASS    http:ollama         Messages OK via gemma4:e4b (discovered via /api/tags) in 23070ms
PASS    http:lmstudio       Messages OK via gemma-4-12b-it-qat@q4_k_xl (discovered via /v1/models) in 740ms
FAIL    http:litellm        endpoint did not list any available model (server down, or no model loaded)
PASS    rigor:tampercheck   0.1.1
PASS    rigor:skill-parity  v0.7.0 on claude, codex

6 PASS, 2 FAIL, 0 SKIPPED
(config: defaults)
```

### `onboard`

Makes a target repository "governed": installs a pinned `tampercheck` CI workflow and a private state exclusion, so the repository still enforces the integrity gate even if someone bypasses DevHarmonics entirely and pushes to it directly.

```
devharmonics onboard <repo> [--apply] [--force] [--json]
```

(`<repo>` may also be given as `--repository <repo>`; exactly one repository per invocation.)

**Dry run by default** — it only reads and reports. Three possible steps: `ci-tampercheck` (write `.github/workflows/tampercheck.yml`, pinned to install `tampercheck==0.1.1` fresh from PyPI on every CI run, never from a working copy), `gitignore-devharmonics` (add `.devharmonics/` to the repository's *private* `.git/info/exclude` — deliberately never the shared, committed `.gitignore`), and `readme-badge` (append a one-line `verification: tampercheck` note to `README.md` — only offered if the repository already has one; onboarding never creates a README). `--apply` writes whatever is missing; `--force` additionally rewrites a step whose existing file differs from the pinned template (a step that already matches is always left alone). It is idempotent — run it again after a full apply and everything reports already present.

**Exit codes:** 0 whenever onboarding actually ran, dry-run or applied — even an `--apply` where an individual step failed to write; those land in a per-step error list in the output, never in the exit code. 2 = the command itself couldn't operate: no repository given, more than one given, the path isn't a directory, or it isn't a git repository.

Real output, run against this repository:
```
DevHarmonics onboard (dry run): C:\Users\scott\Desktop\Code\DevHarmonics

missing  ci-tampercheck          Install the pinned tampercheck CI workflow (tampercheck==0.1.1, fetch-depth 0)
missing  gitignore-devharmonics  Exclude .devharmonics/ via .git/info/exclude (private — never touches the owner's shared .gitignore)
missing  readme-badge            Append a one-line "verification: tampercheck" note to README.md

3 step(s), 3 not yet present

Run with --apply to write them (add --force to rewrite steps that differ from the template).
```

### `qualify`

Runs the qualification sweep: for every discovered candidate (a CLI, or an HTTP endpoint+model) crossed with every role that applies to its lane, run the real role harness and append the result — pass or fail — to a ledger. Qualification is a yes/no admission gate; it never ranks or routes.

```
devharmonics qualify [--execute] [--json] [--config <file>] [--lane subprocess|http]
                     [--candidate <substring>] [--role analysis|benchmark|structured_write|tool_use]
                     [--skip-current] [--work-root <dir>] [--state-root <dir>]
```

**Dry run (plan only) by default**; `--execute` actually runs the harnesses, one at a time in sequence — never concurrently, since local models share one GPU and subscription CLIs shouldn't be stampeded. `--lane` and `--role` restrict the sweep; `--candidate` filters by a substring of the candidate id (e.g. `http:ollama:qwen2.5`); `--skip-current` drops any candidate/role pair whose latest qualification, at today's exact fingerprint, already passed. `--state-root` controls where `qualifications.jsonl` lives (default: `.devharmonics/` under the current directory); `--work-root` controls where harness scratch fixtures are created (default: your OS temp directory — deliberately outside any enclosing git repository, because a nested fixture was found to confuse both Codex's sandbox and Claude's session detection).

Roles differ by lane: HTTP candidates get `analysis`, `tool_use`, `benchmark`, and `structured_write`; subprocess candidates get `analysis`, `benchmark`, and `structured_write` (no separate `tool_use` — a CLI's own tool-calling is its already-verified adapter, not something this factory re-qualifies). A `structured_write` pass additionally requires a passing `benchmark` result: a candidate that can edit files but has never shown it reasons correctly does not get to edit them unsupervised.

**Exit codes:** 0 whenever the sweep ran, dry-run or executed — regardless of how many candidates passed or failed; a sweep where everything fails is still a completed sweep. 2 = the runner itself couldn't operate (bad flag, bad `--lane`/`--role` value, unreadable config).

Real output, trimmed — the full run on this machine reported 65 candidate/role pairs:
```
DevHarmonics qualification sweep (dry run)

note: cli:agy (agy) not runnable — subprocess candidates use runtimeVersion "unknown"

subprocess:codex:gpt-5.6-luna     analysis          analysis-exact-artifact-v1   current
subprocess:codex:gpt-5.6-luna     benchmark         structured-reasoning-v1      current
subprocess:codex:gpt-5.6-luna     structured_write  structured-file-worktree-v1  current
...
65 planned, 48 due, 17 already current
```

### `worker`

Runs exactly **one** bounded subprocess-lane worker attempt and leaves a receipt. This is the raw primitive underneath `run` — no worktree isolation, no gates, no integration; it calls the CLI once and reports what happened.

```
devharmonics worker --provider codex|claude|agy --prompt <text> --cwd <dir>
                    [--model <id>] [--task-id <id>] [--runs-root <dir>]
                    [--sandbox read-only|workspace-write]
                    [--permission-mode <mode>] [--allowed-tools a,b,c]
                    [--timeout-minutes <n>] [--json]
```

`--provider`, `--prompt`, and `--cwd` are required. Defaults: `--task-id adhoc`, `--runs-root <cwd>/.devharmonics/runs`, `--sandbox read-only`, `--permission-mode dontAsk`, `--allowed-tools Read`, `--timeout-minutes 10`. `--model` is not checked at the flag-parsing stage, but it is effectively required for `codex` and `claude`: omit it and the attempt still runs far enough to leave a *failed receipt* (exit 1), rather than stopping early with a usage error. `agy` ignores the model argument entirely — no model-selection flag has been verified to exist for it.

`--sandbox` is honored differently per provider: for `codex` it is passed straight through as that CLI's own `--sandbox` flag; for `agy` only the value `workspace-write` matters (it adds `--mode accept-edits`; anything else leaves file edits blocked by `agy`'s own headless permission model); for `claude` this flag has **no effect at all** — `--permission-mode` and `--allowed-tools` are what actually govern it there.

**Exit codes:** 0 = completed. 1 = it ran but failed or timed out (the receipt says which). 2 = the runner itself couldn't start. Verified live: `devharmonics worker --provider bogus --prompt x --cwd .` prints `devharmonics error: --provider must be one of codex, claude, agy` and exits 2 before anything is spawned.

Example invocation (running this for real spawns an actual, subscription-metered call to your signed-in CLI — nothing here is simulated):
```
devharmonics worker --provider claude --model sonnet \
  --prompt "Read package.json and report the Node engines requirement." \
  --cwd . --sandbox read-only
```

### `run`

The full single-repository pipeline: intake, an isolated worker, an optional validator, the two integration gates, and a stop at the owner-approval boundary. See "How a run actually flows" below.

```
devharmonics run --repository <repo> --prompt <text> --provider codex|claude|agy
                 [--model m] [--check "cmd args"] [--reviewer <spec>]
                 [--task-id t] [--timeout-minutes <n>] [--json]
```

`--repository`, `--prompt`, and `--provider` are required; `--provider` accepts only `codex`, `claude`, or `agy` — `run` drives the subprocess lane only (see "Known limitations"). `--check "cmd args"` is an optional command run inside the worker's own worktree before integration is attempted, e.g. `--check "npm test"`; it is split on plain spaces, so an argument that itself needs a space in it cannot currently be expressed this way. `--reviewer` requests an independent review after integration: `provider:model` (e.g. `claude:sonnet`) asks a subprocess-lane reviewer; `http:provider:model` (e.g. `http:ollama:qwen2.5:7b`) is *accepted by the parser* but is not actually usable today (see "Known limitations"). `--timeout-minutes` (default 15) bounds the worker and, if requested, the reviewer stage; the `--check` validator and the `tampercheck` gate use their own fixed internal timeouts (10 minutes and 2 minutes) regardless of this flag.

**Exit codes:** 0 = the change reached the integration branch — this includes the case where an independent reviewer flagged it as not ready. The exit code alone does not distinguish "ready for you" from "integrated but flagged"; only the printed `reason`/`review:` line (or the JSON `reason` field) does. 1 = the run was refused at some stage (see "Troubleshooting"). 2 = an error before any of that: bad flags, a dirty tracked working tree, or a repository with no commits yet.

Example invocation (running this for real spawns a live worker and creates real local branches and worktrees):
```
devharmonics run --repository ../my-project --provider codex \
  --prompt "Add input validation to the /signup endpoint" \
  --check "npm test" --reviewer claude:sonnet
```

## 5. How a run actually flows

1. **Intake.** `run` resolves your repository path, refuses to proceed if it has *tracked* uncommitted changes (untracked files are fine — nothing is stashed, reset, or silently skipped), and records the current `HEAD` as the pinned base. It adds `.devharmonics/` to the repository's private `.git/info/exclude`.
2. **Isolated worker.** A fresh git worktree is created in your OS temp directory — never inside the repository's own working tree — on a new branch `devharmonics/task/<runId>`. The worker (subprocess lane, `workspace-write` sandbox, `acceptEdits` permission mode, `Read`/`Edit`/`Write` tools) runs inside it. If the worker doesn't finish cleanly, the run stops there with a `worker-<status>` reason.
3. **Commit.** Whatever the worker changed is staged and committed on the worker branch. Nothing staged means an immediate `worker-empty-diff` refusal, before integration is ever attempted.
4. **Optional validator.** If you passed `--check`, it runs inside the same worktree. A nonzero exit or a timeout refuses with `validator-failed`.
5. **Empty-diff gate.** The worker branch is diffed against the merge-base with the pinned commit. No difference means `empty-diff` — a second, independent check of the same thing step 3 already looked for, this time at the integration boundary.
6. **Tampercheck gate.** `tampercheck` is resolved from `PATH` and run (`tampercheck --from <merge-base> --to <worker-head>`) inside its own detached temp worktree. Exit 0 is the only pass; exit 1 refuses as `tampercheck-findings`; not found on `PATH`, a timeout, or any other exit code all refuse as `tampercheck-unavailable`. A crashed integrity gate is never read as a green light.
7. **Merge.** Only after both gates pass: a `--no-ff` merge of the worker branch into `devharmonics/integration/<runId>` (created off the pinned base if it doesn't already exist). A conflict aborts the merge automatically — there is no automatic conflict repair — and refuses as `merge-conflict`.
8. **Optional independent review.** If you passed `--reviewer`, it runs only now, after the deterministic gates already passed. The reviewer sees the diff stat plus the full diff patch (truncated past 200,000 characters) — deliberately never the worker's own narration of what it did. A subprocess-lane reviewer additionally gets a real read-only checkout it can browse for context; an HTTP-lane reviewer gets only the diff text, no filesystem access. Separately, a mechanical check compares whatever paths were claimed-changed against what the diff actually contains. Either the model or the mechanical check finding a problem makes the overall review verdict NOT_READY — but the run is still reported as integrated (see the `run` exit-code note above).
9. **Stop.** Nothing is ever pushed, and no branch is merged into the branch you had checked out. `run` prints the integration branch name and the evidence path, then stops. You decide whether, and how, to bring the change into your own history.

## 6. Evidence

Every attempt — worker, integration, or review — writes evidence before it reports anything, and an attempt that fails to even start still leaves a record: an attempt that leaves no evidence is meant to be indistinguishable from an attempt that never happened, and the code enforces that rather than just asserting it.

For a repository you've run `devharmonics run` against, evidence lives under `<repository>/.devharmonics/runs/<runId>/` (excluded from your committed `.gitignore` via the private `.git/info/exclude` entry that both `onboard` and `run` maintain). Inside it:

- A worker **receipt** (`receipt.json`, schema `devharmonics-receipt-v1`) for every worker/reviewer attempt: which lane, provider, and model were *requested*; the model actually *resolved* (or `null`, with `resolutionVerified: false`, when the runtime never reported its own identity — a requested model name is never treated as proof of what ran); a prompt hash; start/finish times and duration; a status of `completed`, `failed`, `timeout`, or `interrupted` (the schema allows `interrupted`, though nothing in the current code paths actually produces it); usage, when reported (token counts and/or a USD cost — both nullable, never invented as zero when absent); and paths to the raw artifact and event log.
- An **integration bundle** (`integration.json`, plus `tampercheck-output.txt` when tampercheck actually ran) recording both gate results and the merge outcome, for every attempt including refused ones.
- A **review bundle** (`review.json`, schema `devharmonics-review-v1`) when a reviewer ran: the model's verdict, the overall verdict, every finding, every divergence, and the diff stat reviewed.
- A qualification sweep instead appends one line per attempt to `qualifications.jsonl` — an append-only ledger, tolerant of a corrupted line on read (it's counted, never silently dropped, and never takes down every other candidate's history).

## 7. Multi-repository

A cross-repository change is planned and judged as an **integration set**: one task per repository — never one task touching several repositories, enforced structurally, not just by convention — each pinned at plan time to its repository's exact base commit, not whatever that branch has since moved to, with its own integration branch and worktree. Same-repository merges still serialize through the same file lock the single-repo engine already uses; different repositories in the same set integrate concurrently, since planning already refuses a set where two members share a repository.

Readiness is all-or-nothing: a set is `setReady` only when every member integrated cleanly. A member that integrates fine while a sibling is refused is not rolled back — there is no cross-repository transaction that could do that — but it is also never reported as a plain success: its reason becomes `advanced-but-set-blocked`, so nothing downstream mistakes a set-blocked branch for something ready. A reviewer finding that can't be pinned to exactly one member repository (no `repositoryId`, more than one candidate, or an id outside the set) fails closed and is treated as blocking the *whole* set, never guessed at.

This is implemented in `scripts/integration-set.mjs` (`planIntegrationSet`, `integrateSet`, `scopeFinding`) with a full, passing test suite — but as of this writing there is **no `devharmonics` command that exposes it**. Using it today means calling it as a library module directly, not from the command line.

## 8. Known limitations

This section exists to be read before you trust this tool with something that matters.

- **The F-1 gate-deception finding, and how far its fix actually reaches.** An adversarial test substituted a fake `tampercheck` earlier on `PATH` that always printed a clean result and exited 0; a change that skipped a failing test was integrated as a result. The fix adds an optional identity check — the resolved binary must self-report an expected version via `--version` before its verdict is trusted — but it is **off by default**, and **no `devharmonics` command currently exposes a flag to turn it on**: neither `run` nor the multi-repo integrator ever pass the `expectedTampercheckVersion` option that `integrateWorkerBranch` supports. Using it today requires calling that function directly as a library. The threat is bounded — a worker child process cannot alter its parent's `PATH`, so this is an operator-environment risk, not something a worker can exploit — and a second, independent defense already exists: `devharmonics onboard` installs a repository-side CI workflow that installs its own pinned `tampercheck` fresh on every run, unaffected by anything on the local operator's `PATH`.
- **The ACP lane is not reachable from the command line.** `scripts/acp-worker.mjs` fully implements driving a coding agent over ACP, with its own passing test suite, but no `devharmonics` command calls it. There is no `devharmonics acp` command, and `doctor`, `qualify`, `worker`, and `run` never touch it; `doctor` doesn't even probe for an installed ACP adapter. As of today, ACP is a library capability, not a usable one.
- **`run` only drives the subprocess lane.** `--provider` is validated against `codex`, `claude`, or `agy` only, and the pipeline calls the subprocess worker directly. There is no way today to run the full gated pipeline with an HTTP-lane (Ollama/LM Studio) model as the *worker* making the change, even though the HTTP lane's constrained write mode (`scripts/local-patch.mjs`) exists and is exercised by `qualify`'s `structured_write` harness.
- **`--reviewer http:provider:model` is accepted but does not work.** The CLI's reviewer-spec parser for the http form captures only a provider and a model; it has no syntax for a base URL, and the review function needs one to make its HTTP request. The result is not a crash — the fail-closed design catches the resulting request failure and reports a clean `NOT_READY` verdict with a `reviewer-unavailable` finding, every time. The subprocess form (`--reviewer provider:model`) works as documented.
- **A review never actually sees your `--check` validator's real output.** The reviewer prompt has a slot for "executed check receipts," but `runReview` always fills it with the fixed string `"No check receipts were supplied to this review"` — `run` does not thread the validator's real result through, even when `--check` passed cleanly.
- **No restart or reconstruction of an interrupted run or set.** If the process is killed mid-run, there is no saved state to resume from — a re-run starts over from scratch. This is explicit by design for multi-repository sets (`docs/INTEGRATION-SETS.md`) and is equally true of the single-repository pipeline, which cleans up its temporary worktree unconditionally and keeps no resumable state file.
- **No automatic merge-conflict repair.** A conflicting merge is aborted back to the pre-merge state and refused; resolving it is a human's job.
- **Antigravity (`agy`) has several rough edges, found live and worked around rather than solved:** no verified model-pinning flag, so DevHarmonics never tells it which model to use; headless `agy` does not treat its process's working directory as its workspace, so `--add-dir` must name it explicitly, or `agy` silently edits its own scratch directory instead while still reporting success; and command/tool execution in headless mode auto-denies unless the owner has already added a permission rule to `agy`'s own `settings.json` — DevHarmonics deliberately does not reach for a skip-all-permissions flag to work around that.
- **A resolved model from an ACP session is usually null.** ACP v1 has no top-level "which model actually ran" field; DevHarmonics reads a `session/new` `configOptions` entry of category `model` (or a `_meta.model` extension) when an adapter happens to offer one, and otherwise honestly reports `resolutionVerified: false` rather than trusting the requested model name.
- **Usage and cost reporting genuinely differs per provider**, not by choice but by what each one's own output actually contains: Codex's JSON events carry token counts; Claude's `--output-format json` carries a `total_cost_usd` figure (recorded as `usage.costUsd`); HTTP-lane local models report input/output token counts (no cost); `agy`'s output has not been found to carry any usage information at all, so its receipts always show `usage: null`.
- **The qualification write-prompt is not identical across providers.** Codex is asked to edit the file plainly; Claude and `agy` additionally get "do not run any commands," because Codex's own sandbox reads that phrase as forbidding the edit entirely, while `agy` needs it — without it, a headless command attempt aborts the whole run.
- **`tampercheck` covers Python and JavaScript patterns only.** Rust — needed before some of the owner's other repositories can lean on this gate — is a named, not-yet-built gap.
- **The `run` pipeline itself has no hermetic unit tests.** `scripts/run-command.mjs` (`runPipeline`/`runCommandCli`) is not imported by anything under `test/`; it is covered by a syntax check (`node --check`, part of `npm run check`) and by real, live-fire use, not by a mocked/hermetic test the way almost every other module in `scripts/` is. `scripts/worker-command.mjs` and `scripts/cli.mjs` (the CLI parsing/dispatch layer itself) are similarly untested directly, though the logic underneath them is.
- **The subprocess lane does not strip your environment.** The spec's stated boundary ("credential-shaped env vars stripped from worker child processes") is only actually implemented as a narrow removal of Claude-Code session markers (`CLAUDECODE`, `CLAUDE_CODE_*`) inside the ACP lane — which, per above, no command currently uses. The subprocess lane that `run` and `worker` actually drive passes your full current environment to the child process unfiltered, the same as running that CLI yourself from the same shell would.
- **No dashboard, no routing/ranking optimizer, no campaign kernel.** These are deliberate scope brakes, not oversights: qualification is stated to be an admission gate only ("never a ranking engine"), and staged rollouts, pilots, and promotion are explicitly out of scope for v1. A separate, third-party app is the intended human cockpit; this factory's own output is CLI text or JSON.
- **One repository per task, always** — enforced structurally: planning a multi-repo set rejects two members that resolve to the same repository or share a `repositoryId`.
- **Multi-repository integration sets have no CLI command** (see "Multi-repository" above) — today's five commands are `doctor`, `onboard`, `qualify`, `worker`, and `run`; nothing exposes `planIntegrationSet`/`integrateSet` from the terminal.
- **A config file's `budgets.maxWorkerMinutes` is validated but not enforced.** No command currently reads it; the timeouts that actually apply are each command's own `--timeout-minutes` flag.
- **The repository's own `README.md` is stale.** It currently says "Specification stage. No code yet." That is no longer true — this manual describes a working implementation: five commands, three worker-lane code paths, a full gated single-repo pipeline, and a tested multi-repo integration-set module. Trust this manual and the source over that line.

## 9. Troubleshooting

These are the refusal reasons `run` and the integration engine actually produce, and what each means.

| Reason | Stage | Meaning |
|---|---|---|
| `worker-failed` / `worker-timeout` / `worker-interrupted` | worker | The worker subprocess didn't finish cleanly; nothing was committed or integrated. Check its receipt for why. |
| `worker-empty-diff` | after the worker | The worker completed but staged nothing. Different from `empty-diff` below — this fires before integration is even attempted. |
| `validator-unresolvable` | `--check` | The command named in `--check` couldn't be found on `PATH` at all. |
| `validator-failed` | `--check` | The `--check` command was found and ran, but exited nonzero or timed out. |
| `commit-failed` | commit | `git commit` itself failed inside the worker's worktree after a nonempty diff was staged — rare. |
| `empty-diff` | integration gate 1 | The worker branch has no changes relative to the pinned merge-base. |
| `tampercheck-findings` | integration gate 2 | `tampercheck` ran and reported findings (exit 1). Read `tampercheck-output.txt` in the evidence bundle. |
| `tampercheck-unavailable` | integration gate 2 | `tampercheck` couldn't be trusted to answer at all: not on `PATH`, it crashed, it timed out, or (only if the identity check has been wired in by hand) it didn't self-report the expected version. Never treated as a pass. |
| `merge-conflict` | merge | The `--no-ff` merge conflicted and was aborted automatically. The listed conflicting paths need a human. |
| `review-not-ready` | review | The run **did** integrate (exit code is still 0) but the optional reviewer came back NOT READY, or the deterministic claims-vs-diff check found an unexplained difference. Read the review evidence bundle. |
| `advanced-but-set-blocked` | multi-repo sets only | This member integrated cleanly, but a sibling in the same set did not, so the set overall isn't ready. This member is not rolled back. |
| `integration-error` | multi-repo sets only | The integration engine threw for this one member (for example, its repository changed underneath a planned set). Recorded as refused; never allowed to take down the rest of the set. |
