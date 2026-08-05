# DevHarmonics User Manual

## 1. What this is

DevHarmonics is a set of plain Node.js command-line scripts that let an AI coding agent make one bounded, gated change to a git repository on your own machine, using accounts you already have — there is no DevHarmonics server and no DevHarmonics account. Work is driven through one of three worker lanes: subprocess (a supervised call to a signed-in subscription CLI — Codex, Claude Code, or Antigravity's `agy`), HTTP (one Anthropic-Messages-API client pointed at a local model server or, only if you opt in, the real Claude API), and ACP (the Agent Client Protocol, driven by an installed ACP adapter over stdio). All three lanes are reachable today from the command line, standalone (`devharmonics worker`, `devharmonics acp`) or as the worker inside the full gated pipeline (`devharmonics run --lane subprocess|http|acp`). A change only reaches a local integration branch after clearing an empty-diff check and a `tampercheck` integrity scan, and it is never pushed anywhere or merged into your own branch — the tool always stops at a point where you, the owner, decide what happens next. Every attempt, whether it succeeds, is refused, or never even starts, leaves a written receipt.

DevHarmonics has seven commands: `doctor`, `onboard`, `qualify`, `worker`, `acp`, `run`, and `set`. The last one plans and integrates a change across more than one repository at once, judged all-or-nothing.

## 2. Requirements

- **Node.js 24 or newer** (`package.json` declares `"engines": {"node": ">=24"}`), and **Git**.
- **`tampercheck` on your `PATH`** — required by `devharmonics run` and `devharmonics set`, because the integrity gate they both depend on *is* that tool. It is **not** bundled: DevHarmonics has exactly one runtime dependency (`@agentclientprotocol/sdk`) and deliberately ships no verification code of its own, so the gate stays an independent, pinnable tool rather than something this repo could quietly weaken. It is a Python package:

  ```
  pip install tampercheck==0.1.1        # or: pipx install tampercheck==0.1.1
  ```

  Without it, integration does not silently succeed and does not crash — it refuses with `tampercheck-unavailable`, which is the fail-closed behavior, but it does mean **no change can reach an integration branch until it is installed**. `devharmonics doctor` reports whether it was found, and its version. For stronger binding than "whatever `PATH` resolves", `integrateWorkerBranch` accepts `tampercheckPath` (an absolute path) and `expectedTampercheckSha256` (a content pin); the resolved path and its checksum are recorded in every integration bundle either way. `devharmonics onboard` additionally installs a repo-side CI workflow that pins the same version, so the gate still holds if DevHarmonics is bypassed entirely.
- **`python` on your `PATH`** — only for `devharmonics qualify`, whose structured-write harness runs `python test_add.py` inside a scratch fixture. Absent, that harness reports `"python" not found on PATH` and the candidate is not credited with the role; nothing else is affected.
- **Nothing external is vendored.** Every tool above, every provider CLI below, and the ACP adapter are resolved from your `PATH` at the moment they are used — this repo declares exactly one runtime dependency (`@agentclientprotocol/sdk`). That is deliberate: the pieces that judge the work stay independent of the code being judged. The practical consequence is that a fresh clone can run `doctor` and the raw `worker`/`acp` primitives, but cannot complete an integration until `tampercheck` exists.
- To use the **subprocess** lane: at least one of the Codex CLI (`codex`), Claude Code (`claude`), or Antigravity's CLI (`agy`) installed and already signed in. DevHarmonics finds it the way your own shell would (real `PATH`/`PATHEXT` resolution) and calls it the way you would from a terminal.
- To use the **HTTP** lane: a locally running Anthropic-compatible Messages endpoint. The built-in defaults are Ollama on `http://127.0.0.1:11434`, LM Studio on `http://127.0.0.1:1234`, and a LiteLLM proxy on `http://127.0.0.1:4000`. A real Anthropic API key is supported only as a separate, explicit opt-in — nothing reaches for one by default.
- To use the **ACP** lane: an ACP adapter binary on your `PATH` (the default is `claude-code-acp`; any other adapter can be named with `--adapter`). DevHarmonics speaks the protocol itself (`@agentclientprotocol/sdk`) but does not install or bundle any adapter for you.
- **DevHarmonics never asks you for an API key.** It authenticates the way you already do — a signed-in subscription CLI, a local endpoint that needs no key at all, or an ACP adapter's own session — and it is not built around cloud credentials.

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

Two other npm scripts are useful straight from the repo: `npm test` runs the automated test suite (`node --test --test-concurrency=2 "test/*.test.mjs"`), and `npm run check` runs a syntax check (`node --check`) over every individual file in `scripts/` followed by the full test suite — this is exactly what CI runs, on both Ubuntu and Windows (`.github/workflows/ci.yml`), plus a `doctor --json` smoke check on a runner with nothing installed.

## 4. Commands

DevHarmonics has seven commands: `doctor`, `onboard`, `qualify`, `worker`, `acp`, `run`, and `set`. There is no per-command `--help` — every subcommand's argument parser treats an unrecognized flag (including `--help`) as an error and exits with code 2; this was verified live for all seven. Run `devharmonics --help`, `devharmonics -h`, or `devharmonics` with no arguments to see the built-in usage summary:

```
Usage:
  devharmonics doctor [--json] [--config <file>]
  devharmonics qualify [--execute] [--json] [--lane L] [--role R] [--skip-current]
  devharmonics onboard <repo> [--apply] [--force] [--json]
  devharmonics run --repository <repo> --prompt <text> --provider <p>
                   [--model m] [--check "cmd args"] [--task-id t]
                   [--lane subprocess|http|acp] [--files a,b,c]
                   [--adapter <cmd>] [--base-url <url>] [--json]
  devharmonics worker --provider <codex|claude|agy> --prompt <text> --cwd <dir>
                      [--model <id>] [--task-id <id>] [--runs-root <dir>]
                      [--sandbox read-only|workspace-write]
                      [--permission-mode <mode>] [--allowed-tools a,b,c]
                      [--timeout-minutes <n>] [--json]
  devharmonics acp --prompt <text> --cwd <dir> [--adapter <cmd>]
                   [--task-id <id>] [--runs-root <dir>]
                   [--permission-mode deny|allow-edits]
                   [--timeout-minutes <n>] [--json]
  devharmonics set --member "<repositoryId>=<repoPath>:<workerBranch>" (2+)
                   [--base "<repositoryId>=<ref>"] [--evidence-root <dir>]
                   [--json]
```

Only `doctor` and `qualify` accept `--config <file>`; the other five commands always use the built-in default configuration (the local Ollama/LM Studio/LiteLLM endpoints and the `codex`/`claude`/`agy` CLI names) — there is no way today to point `run`, `worker`, `acp`, `onboard`, or `set` at a custom config file.

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
PASS    http:ollama         Messages OK via qwen2.5vl:3b (discovered via /api/tags) in 339ms
PASS    http:lmstudio       Messages OK via gemma-4-12b-it-qat@q4_k_xl (discovered via /v1/models) in 410ms
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

**Dry run (plan only) by default**; `--execute` actually runs the harnesses, one at a time in sequence — never concurrently, since local models share one GPU and subscription CLIs shouldn't be stampeded. `--lane` restricts the sweep to `subprocess` or `http` only — there is no `--lane acp` for qualification; ACP candidates are not part of this sweep at all. `--role` restricts to one role; `--candidate` filters by a substring of the candidate id (e.g. `http:ollama:qwen2.5`). `--skip-current` drops any candidate/role pair whose latest qualification, at today's exact fingerprint, already passed. `--state-root` controls where `qualifications.jsonl` lives (default: `.devharmonics/` under the current directory); `--work-root` controls where harness scratch fixtures are created (default: your OS temp directory — deliberately outside any enclosing git repository, because a nested fixture was found to confuse both Codex's sandbox and Claude's session detection).

Roles differ by lane: HTTP candidates get `analysis`, `tool_use`, `benchmark`, and `structured_write`; subprocess candidates get `analysis`, `benchmark`, and `structured_write` (no separate `tool_use` — a CLI's own tool-calling is its already-verified adapter, not something this factory re-qualifies). A `structured_write` pass additionally requires a passing `benchmark` result: a candidate that can edit files but has never shown it reasons correctly does not get to edit them unsupervised. The write-fixture prompt itself is not identical across providers: Codex is asked to edit the file plainly, while Claude and `agy` additionally get "do not run any commands" — Codex's own sandbox reads that phrase as forbidding the edit entirely, while `agy` needs it (a headless command attempt otherwise aborts the whole run).

**Exit codes:** 0 whenever the sweep ran, dry-run or executed — regardless of how many candidates passed or failed; a sweep where everything fails is still a completed sweep. 2 = the runner itself couldn't operate (bad flag, bad `--lane`/`--role` value, unreadable config).

Real output, trimmed — the full run on this machine reported 65 candidate/role pairs (the exact numbers depend on your own locally installed models and qualification history, so treat this as illustrative, not a number to expect on a different machine):
```
DevHarmonics qualification sweep (dry run)

note: cli:agy (agy) not runnable — subprocess candidates use runtimeVersion "unknown"

subprocess:codex:gpt-5.6-luna     analysis          analysis-exact-artifact-v1   current
subprocess:codex:gpt-5.6-luna     benchmark         structured-reasoning-v1      current
subprocess:codex:gpt-5.6-luna     structured_write  structured-file-worktree-v1  current
http:ollama:qwen2.5:7b            tool_use          messages-tool-use-v1         current
http:lmstudio:gemma-4-12b-it-qat@q4_k_xl  structured_write  structured-file-worktree-v1  current
...
65 planned, 48 due, 17 already current
```

### `worker`

Runs exactly **one** bounded subprocess-lane worker attempt and leaves a receipt. This is the raw primitive underneath `run`'s subprocess lane — no worktree isolation, no gates, no integration; it calls the CLI once and reports what happened.

```
devharmonics worker --provider codex|claude|agy --prompt <text> --cwd <dir>
                    [--model <id>] [--task-id <id>] [--runs-root <dir>]
                    [--sandbox read-only|workspace-write]
                    [--permission-mode <mode>] [--allowed-tools a,b,c]
                    [--timeout-minutes <n>] [--json]
```

`--provider`, `--prompt`, and `--cwd` are required. Defaults: `--task-id adhoc`, `--runs-root <cwd>/.devharmonics/runs`, `--sandbox read-only`, `--permission-mode dontAsk`, `--allowed-tools Read`, `--timeout-minutes 10`. `--model` is not checked at the flag-parsing stage, but it is effectively required for `codex` and `claude`: omit it and the attempt still runs far enough to leave a *failed receipt* (exit 1), rather than stopping early with a usage error. `agy` ignores the model argument entirely — no model-selection flag has been verified to exist for it.

`--sandbox` is honored differently per provider: for `codex` it is passed straight through as that CLI's own `--sandbox` flag; for `agy` only the value `workspace-write` matters (it adds `--mode accept-edits`; anything else leaves file edits blocked by `agy`'s own headless permission model); for `claude` this flag has **no effect at all** — `--permission-mode` and `--allowed-tools` are what actually govern it there.

The child process this spawns receives a credential-stripped environment (see "The credential-stripping boundary" below) — the receipt's `strippedEnv` field lists exactly which variable names were removed for this run.

**Exit codes:** 0 = completed. 1 = it ran but failed or timed out (the receipt says which). 2 = the runner itself couldn't start. Verified live: `devharmonics worker --provider bogus --prompt x --cwd .` prints `devharmonics error: --provider must be one of codex, claude, agy` and exits 2 before anything is spawned.

Example invocation (running this for real spawns an actual, subscription-metered call to your signed-in CLI — nothing here is simulated):
```
devharmonics worker --provider claude --model sonnet \
  --prompt "Read package.json and report the Node engines requirement." \
  --cwd . --sandbox read-only
```

### `acp`

Runs exactly **one** bounded ACP-lane worker attempt — a coding agent driven over the Agent Client Protocol (stdio JSON-RPC) — and leaves a receipt in the same schema as `worker`. This is the raw primitive underneath `run --lane acp`.

```
devharmonics acp --prompt <text> --cwd <dir> [--adapter <cmd>]
                 [--task-id <id>] [--runs-root <dir>]
                 [--permission-mode deny|allow-edits]
                 [--timeout-minutes <n>] [--json]
```

`--prompt` and `--cwd` are required. Defaults: `--adapter claude-code-acp`, `--task-id adhoc`, `--runs-root <cwd>/.devharmonics/runs`, `--permission-mode deny`, `--timeout-minutes 10`. `--permission-mode` must be exactly `deny` or `allow-edits` — anything else is a flag error (exit 2). Under `deny`, every permission request the adapter makes is refused; under `allow-edits`, only file-*edit* tool calls are granted (deliberately narrow — a delete, move, execute, or fetch request is still refused even in `allow-edits` mode). DevHarmonics always prefers the "once" variant of whichever answer it gives, never a blanket always-allow/always-deny.

A resolved model is usually not available: ACP v1 has no top-level "which model actually ran" field. DevHarmonics reads a `session/new` response's `configOptions` entry of category `model` (or a `_meta.model` extension) when an adapter happens to offer one; otherwise the receipt honestly reports `resolvedModel: null` and `resolutionVerified: false` rather than trusting the requested model name.

The child process this spawns receives a credential-stripped environment, same as `worker` — but see "The credential-stripping boundary" below for a caveat specific to this lane's receipt.

**Exit codes:** 0 = completed. 1 = it ran but failed or timed out. 2 = the runner itself couldn't start (missing `--prompt`/`--cwd`, or a bad `--permission-mode`).

Example invocation (running this for real spawns your installed ACP adapter and, depending on the adapter, a metered call to its underlying provider):
```
devharmonics acp --prompt "Read package.json and report the Node engines requirement." \
  --cwd . --permission-mode deny
```

### `run`

The full single-repository pipeline: intake, an isolated worker on any of the three lanes, an optional validator, the two integration gates, and a stop at the owner-approval boundary. See "How a run actually flows" below.

```
devharmonics run --repository <repo> --prompt <text> --provider <p>
                 [--model m] [--check "cmd args"] [--reviewer <spec>]
                 [--task-id t] [--timeout-minutes <n>]
                 [--lane subprocess|http|acp] [--files a,b,c]
                 [--adapter <cmd>] [--base-url <url>] [--json]
```

`--repository`, `--prompt`, and `--provider` are required. `--lane` defaults to `subprocess`; it may also be `http` or `acp`.

- When `--lane subprocess` (the default), `--provider` is validated against `codex`, `claude`, or `agy` only.
- When `--lane http` or `--lane acp`, `--provider` is **not** restricted to those three names — it becomes a free-text label recorded in the receipt and commit message (and, for the http lane, it also doubles as the config lookup key for `--base-url` when that flag is omitted).

Lane-specific flags:
- `--files a,b,c` — a comma-separated list of repository-relative paths the model is allowed to read and write. **Required** for `--lane http` (the command errors out if it's missing or empty); ignored for the other two lanes.
- `--adapter <cmd>` — which ACP adapter binary to run. Only meaningful for `--lane acp` (default `claude-code-acp`); ignored otherwise.
- `--base-url <url>` — the HTTP endpoint to call. Only meaningful for `--lane http`. If omitted, DevHarmonics looks up `endpoints.<provider>.baseUrl` in the (always default, since `run` has no `--config` flag) configuration — so `--provider ollama`, `--provider lmstudio`, or `--provider litellm` work out of the box without `--base-url`; any other provider name needs an explicit `--base-url` or the command errors out.
- `--check "cmd args"` — an optional command run inside the worker's own worktree before integration is attempted, e.g. `--check "npm test"`; it is split on plain spaces, so an argument that itself needs a space in it cannot currently be expressed this way. It is genuinely optional for `--lane subprocess` and `--lane acp` (the deterministic gates still run without it). For `--lane http` it is **effectively required**: the HTTP lane's structured-write module (`local-patch.mjs`) validates its own task up front and throws if no check command was given, which surfaces as a hard error (exit 2) rather than a graceful refusal — omitting `--check` with `--lane http` is not currently a supported combination in practice.
- `--reviewer <spec>` requests an independent review after integration. `provider:model` (e.g. `claude:sonnet`) asks a subprocess-lane reviewer. `http:provider:model` (e.g. `http:ollama:qwen2.5:7b`) asks an HTTP-lane reviewer — this form now works: the base URL is resolved from `endpoints.<provider>.baseUrl` in the default configuration, the same lookup `--base-url` uses. There is no `acp:...` reviewer form.
- `--timeout-minutes` (default 15) bounds the worker and, if requested, the reviewer stage, for the **subprocess and acp lanes only**. It has **no effect on the http lane**: `local-patch.mjs` always uses its own fixed internal timeout (5 minutes) for both the model call and the check command, regardless of this flag. The `--check` validator on the subprocess/acp lanes and the `tampercheck` gate each use their own fixed internal timeouts (10 minutes and 2 minutes) regardless of this flag too.

**Exit codes:** 0 = the change reached the integration branch — this includes the case where an independent reviewer flagged it as not ready. The exit code alone does not distinguish "ready for you" from "integrated but flagged"; only the printed `reason`/`review:` line (or the JSON `reason` field) does. 1 = the run was refused at some stage (see "Troubleshooting"). 2 = an error before any of that: bad flags, a dirty tracked working tree, a repository with no commits yet, or (http lane) a task the pipeline could not even construct.

Example invocation (running this for real spawns a live worker and creates real local branches and worktrees):
```
devharmonics run --repository ../my-project --provider codex \
  --prompt "Add input validation to the /signup endpoint" \
  --check "npm test" --reviewer claude:sonnet
```

Example of the newer lanes (still unexecuted here — both spawn real work):
```
devharmonics run --repository ../my-project --provider ollama --lane http \
  --files src/config.js --check "npm test" \
  --prompt "Add a default timeout of 30 seconds to the fetch config."

devharmonics run --repository ../my-project --provider claude --lane acp \
  --adapter claude-code-acp \
  --prompt "Add input validation to the /signup endpoint"
```

### `set`

Plans and integrates a cross-repository integration **set**: one already-existing worker branch per repository, each pinned to that repository's exact base commit at plan time, judged all-or-nothing.

```
devharmonics set --member "<repositoryId>=<repoPath>:<workerBranch>" (2+)
                 [--base "<repositoryId>=<ref>"] [--evidence-root <dir>]
                 [--json]
```

`--member` must be given at least twice — a set needs two or more repositories. Each value has the shape `<repositoryId>=<repoPath>:<workerBranch>`; a Windows drive letter in `repoPath` (e.g. `C:\...`) is handled correctly because the parser splits on the *last* colon, and git branch names can never legally contain one. `--base "<repositoryId>=<ref>"` optionally pins a specific base ref for one member (defaults to that repository's current `HEAD` otherwise). `--evidence-root <dir>` controls where the set's evidence bundle is written (default: a freshly created OS-temp directory, printed in the output — capture the `evidence:` line if you want to find it again).

**`set` does not dispatch any workers itself.** Every named `workerBranch` must already exist with a real commit on it in its repository (produced by a separate `devharmonics run`, `devharmonics worker`, or by hand) before you call `set` — `planIntegrationSet` throws at plan time if a named branch doesn't resolve to a commit. What `set` actually does is the *integration* half: pin each member's base, then run the same empty-diff gate, `tampercheck` gate, and `--no-ff` merge that a single-repository `run` uses, once per repository, judged together.

There is no `--check` flag and no `--reviewer` flag on `set` — a multi-repository set has no validator step and no independent-review step at the CLI level today. (A library-level helper, `scopeFinding` in `scripts/integration-set.mjs`, exists to attribute a review finding to exactly one set member, with its own passing tests — but nothing in `set-command.mjs` calls it yet, so there is currently no way to actually get a scoped review of a set from the command line.)

**Exit codes:** 0 = every member integrated (`setReady`). 1 = the set was blocked (at least one member was refused). 2 = the runner itself couldn't operate: fewer than two `--member` flags, a malformed `--member`/`--base` value, a duplicate `repositoryId`, two repository ids resolving to the same repository root, or a named `workerBranch`/base ref that doesn't resolve to a commit.

Example invocation (running this for real performs real git worktree/merge operations, and a real `tampercheck` run, against both repositories — no worker is spawned by this command itself):
```
devharmonics set \
  --member "civicsuite-umbrella=../civicsuite:devharmonics/task/run-1a2b3c4d" \
  --member "civicsuite-records=../civicsuite-records:devharmonics/task/run-1a2b3c4d"
```

## 5. How a run actually flows

1. **Intake.** `run` resolves your repository path, refuses to proceed if it has *tracked* uncommitted changes (untracked files are fine — nothing is stashed, reset, or silently skipped), and records the current `HEAD` as the pinned base. It adds `.devharmonics/` to the repository's private `.git/info/exclude`. This step is identical for all three lanes.
2. **Isolated worker.** What happens next depends on the lane:
   - **subprocess** and **acp** share one shape: the pipeline creates a fresh git worktree in your OS temp directory — never inside the repository's own working tree — on a new branch `devharmonics/task/<runId>`, then runs the worker inside it (subprocess: `workspace-write` sandbox, `acceptEdits` permission mode, `Read`/`Edit`/`Write` tools; acp: `allow-edits` permission mode). Whatever the worker changed is then staged and committed by the pipeline itself on the worker branch. Nothing staged means an immediate `worker-empty-diff` refusal, before integration is ever attempted.
   - **http** is structurally different: `local-patch.mjs` owns its own isolated worktree from the start. It reads the declared `--files` from that worktree, sends them (plus your prompt) to the model over the Messages API, validates that every path the model wants to write is one you declared, writes the files, and requires a real, nonempty diff. It then runs the `--check` command itself (see above — effectively required for this lane) and commits **only if that check passes**. The pipeline turns that commit into a `workerBranch` ref and cleans up `local-patch`'s worktree afterward. A model that echoes a file back unchanged surfaces here as `worker-failed` (with a detail explaining why) rather than the subprocess/acp lanes' distinct `worker-empty-diff` reason — `local-patch.mjs` reports it as a generic failed receipt, not a separately named status.
3. **Optional validator (subprocess/acp only).** If you passed `--check`, it now runs inside the same worktree, with its own fixed 10-minute timeout. A nonzero exit or a timeout refuses with `validator-failed`; a command that can't be resolved on `PATH` refuses with `validator-unresolvable`. (For the http lane, the equivalent check already ran as part of step 2, inside `local-patch.mjs`.)
4. **Empty-diff gate.** The worker branch is diffed against the merge-base with the pinned commit. No difference means `empty-diff` — a second, independent check of the same thing step 2/3 already looked for, this time at the integration boundary.
5. **Tampercheck gate.** `tampercheck` is resolved from `PATH` and run (`tampercheck --from <merge-base> --to <worker-head>`) inside its own detached temp worktree, with a fixed 2-minute timeout. Before its verdict is trusted at all, an **identity check runs automatically, on by default**: the resolved binary must answer `--version` with something that looks like a bare semantic version (shape, not an exact value — a stub that merely prints a sentence fails this). This closes a real, adversarially-demonstrated gap (see "The tampercheck identity check" below). Only after that identity check passes does DevHarmonics trust the actual scan result: exit 0 is the only pass; exit 1 refuses as `tampercheck-findings`; not found on `PATH`, a timeout, a failed identity check, or any other exit code all refuse as `tampercheck-unavailable`. A crashed integrity gate is never read as a green light.
6. **Merge.** Only after both gates pass: a `--no-ff` merge of the worker branch into `devharmonics/integration/<runId>` (created off the pinned base if it doesn't already exist). A conflict aborts the merge automatically — there is no automatic conflict repair — and refuses as `merge-conflict`.
7. **Optional independent review.** If you passed `--reviewer`, it runs only now, after the deterministic gates already passed. The reviewer sees the diff stat plus the full diff patch (truncated past 200,000 characters) — deliberately never the worker's own narration of what it did. A subprocess-lane reviewer additionally gets a real read-only checkout it can browse for context; an HTTP-lane reviewer gets only the diff text, no filesystem access. For a subprocess- or acp-lane worker, the reviewer's prompt also includes the real exit code and tail output of your `--check` validator; **for an http-lane run, the reviewer is always told "No check receipts were supplied to this review" even though `local-patch.mjs` did run a real check** — that result is not currently threaded through to the reviewer for this lane. Separately, a mechanical divergence check *can* compare the paths a worker claimed it changed against what the diff actually contains — and that mechanical finding, when present, outranks a model READY verdict. But it needs a structured manifest of what the worker *claimed*, distinct from the diff, and the subprocess/acp worker emits only freeform narration, no such manifest; parsing prose for "claimed" paths produces false positives that would block honest runs. So for a `run` today the divergence gate is reported as **"not checked"** rather than fed the diff compared against itself (which the earlier build did — a check mathematically incapable of finding anything, reported as a reassuring "0 divergence"; GAUNTLET-2026-08-05 finding M-1). The model reviewer, which judges the *actual* diff, is the active review gate; its NOT_READY still blocks readiness while the run is still reported as integrated (see the `run` exit-code note above). The divergence function and gate remain fully wired and tested for any caller that *can* supply a real claims manifest.
8. **Stop.** Nothing is ever pushed, and no branch is merged into the branch you had checked out. `run` prints the integration branch name and the evidence path, then stops. You decide whether, and how, to bring the change into your own history.

### The credential-stripping boundary

Before a worker child process is spawned (the **subprocess** and **acp** lanes only — the http lane never spawns the model as a local process, since it talks to it over the network), DevHarmonics builds it a stripped copy of your environment. Removed: an explicit list of named provider API keys and cloud credentials (Anthropic, OpenAI, Google/Gemini, AWS, Azure, GitHub tokens, npm/PyPI tokens, and connection-string URLs such as `DATABASE_URL`, `REDIS_URL`, `MONGODB_URI`, and `SENTRY_DSN`), plus anything whose name *contains* a credential word — `API_KEY`/`APIKEY`, `SECRET`, `TOKEN`, `PASSWORD`/`PASSWD`, `CREDENTIAL`, `PRIVATE_KEY`, or an underscore-delimited `_PASS`/`_PWD` — so undelimited real names like `DBPASSWORD`, `SESSIONTOKEN`, and `STRIPESECRETKEY` are caught too (a small allowlist keeps benign lookalikes such as `SSH_AUTH_SOCK`, a socket path, and `PWD`, a working directory, from being swept up). Also removed: nested coordinator session markers (`CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_SESSION_*`) that would otherwise make a nested provider CLI refuse to launch when the coordinator itself is a Claude Code session. `PATH` itself is untouched, so command resolution still works, and subscription-CLI auth is unaffected — it lives in the CLI's own sign-in session, not in an environment variable. (The broadened name matching is GAUNTLET-2026-08-05 finding M-3; earlier builds required a leading underscore and missed the undelimited names.)

This is **a boundary, not a sandbox**, and the manual says so plainly: it closes the *ambient inheritance* path that would otherwise hand a worker every secret in your shell for free, with no intent required. It does not stop a worker with real shell or file access from reading credentials directly off disk, a keychain, or a config file. Two further caveats worth knowing:

- The `worker` command's and the subprocess-lane `run` pipeline's receipts carry a `strippedEnv` field listing exactly which variable names were removed for that run — real, checkable evidence, not just a claim. The `acp` lane applies the identical stripping to its own child process, but its receipt does not currently carry that list: `strippedEnv` on an ACP receipt is always `null`, even though the stripping happened. The protection is real in both lanes; only one lane's receipt currently shows the evidence for it.
- The `--check` validator's own subprocess — whether it's the subprocess/acp lane's separate check step, or the check command `local-patch.mjs` runs internally for the http lane — **also** receives a credential-stripped environment, for exactly the same reason the worker does: it executes *inside the worktree the untrusted worker just wrote to*, so a planted line in a test file or a `pretest` hook must not run with every API key on your box. `PATH` still survives, so the check command resolves and runs normally. (Earlier builds ran the validator with your full, unstripped environment; that gap is GAUNTLET-2026-08-05 finding C-2, now closed.) The `tampercheck` integrity gate also runs credential-stripped now: it, too, executes with its working directory inside the untrusted worktree, so a later adversarial audit closed the inconsistency of it alone keeping the full environment. `git` plumbing (add, commit, diff, worktree) still runs with the ordinary environment — it never executes worktree-tracked content as code (hooks live in the shared `.git/hooks`, unreachable from committed content), so there is no exfiltration path there.

### The tampercheck identity check

An adversarial test (documented in full in `docs/FALSIFICATION.md`, finding F-1) substituted a fake `tampercheck` earlier on `PATH` that always printed a clean line and exited 0; a change that skipped a failing test was integrated as a result. The fix — described in step 5 above — is implemented in `integrateWorkerBranch` and is **on by default today**, automatically, for both `run` and `set`; there is no flag on either command that needs to be set to turn it on. It checks *shape*, not an exact value, on purpose: pinning an exact expected version was tried and rejected, because it would lock out an operator legitimately running a different `tampercheck` release while adding no real security (a stub author can print whatever version string is expected). Two things remain library-only, reachable only by calling `integrateWorkerBranch` directly rather than through any `devharmonics` command: pinning an *exact* expected version (`expectedTampercheckVersion`), and turning the identity check off entirely (`requireTampercheckIdentity: false`). The threat this defends against is bounded: a worker child process cannot alter its parent's `PATH`, so this is an operator-environment risk, not something a worker can exploit — and a second, independent defense already exists regardless: `devharmonics onboard` installs a repository-side CI workflow that installs its own pinned `tampercheck` fresh on every run, unaffected by anything on the local operator's `PATH`.

## 6. Evidence

Every attempt — worker, integration, or review — writes evidence before it reports anything, and an attempt that fails to even start still leaves a record: an attempt that leaves no evidence is meant to be indistinguishable from an attempt that never happened, and the code enforces that rather than just asserting it.

For a repository you've run `devharmonics run` against, evidence lives under `<repository>/.devharmonics/runs/<runId>/` (excluded from your committed `.gitignore` via the private `.git/info/exclude` entry that both `onboard` and `run` maintain). Inside it:

- A worker **receipt** (`receipt.json`, schema `devharmonics-receipt-v1`) for every worker/reviewer attempt: which lane, provider, and model were *requested*; the model actually *resolved* (or `null`, with `resolutionVerified: false`, when the runtime never reported its own identity — a requested model name is never treated as proof of what ran); a prompt hash; start/finish times and duration; a status of `completed`, `failed`, `timeout`, or `interrupted` (the schema allows `interrupted`, though nothing in the current code paths actually produces it); usage, when reported (token counts and/or a USD cost — both nullable, never invented as zero when absent); paths to the raw artifact and event log; and `strippedEnv` (see above — populated for the subprocess lane, always `null` for the acp lane today).
- An **integration bundle** (`integration.json`, plus `tampercheck-output.txt` when tampercheck actually ran) recording both gate results and the merge outcome, for every attempt including refused ones.
- A **review bundle** (`review.json`, schema `devharmonics-review-v1`) when a reviewer ran: the model's verdict, the overall verdict, every finding, every divergence, and the diff stat reviewed.
- A qualification sweep instead appends one line per attempt to `qualifications.jsonl` — an append-only ledger, tolerant of a corrupted line on read (it's counted, never silently dropped, and never takes down every other candidate's history).
- A `devharmonics set` run writes one set-level bundle (`set.json`, schema `devharmonics-integration-set-v1`, under the `--evidence-root` you gave or the freshly created temp directory it prints) plus each member's own `integration.json` under a `members/<repositoryId>/` subdirectory — the same integration bundle shape a single-repository `run` produces, one per repository in the set.

## 7. Multi-repository integration sets

A cross-repository change is planned and judged as an **integration set**: one task per repository — never one task touching several repositories, enforced structurally, not just by convention — each pinned at plan time to its repository's exact base commit, not whatever that branch has since moved to, with its own integration branch and worktree. Same-repository merges still serialize through the same file lock the single-repo engine already uses; different repositories in the same set integrate concurrently, since planning already refuses a set where two members share a repository.

Readiness is all-or-nothing: a set is `setReady` only when every member integrated cleanly. A member that integrates fine while a sibling is refused is not rolled back — there is no cross-repository transaction that could do that — but it is also never reported as a plain success: its reason becomes `advanced-but-set-blocked`, so nothing downstream mistakes a set-blocked branch for something ready. A reviewer finding that can't be pinned to exactly one member repository (no `repositoryId`, more than one candidate, or an id outside the set) is meant to fail closed and block the *whole* set, never guessed at — the helper that implements that attribution rule, `scopeFinding`, is written and tested, but as noted in the `set` command reference above, nothing currently calls it, because `set` has no reviewer integration yet.

This is implemented in `scripts/integration-set.mjs` (`planIntegrationSet`, `integrateSet`, `scopeFinding`) and exposed from the command line as `devharmonics set` (see above) — a real change from this factory's earlier state, when the only way to use it was as a library. What `set` does **not** do is run workers: every member's `workerBranch` must already carry a real commit (from a separate `devharmonics run`, `devharmonics worker`, or manual work) before you plan and integrate a set.

## 8. Known limitations

This section exists to be read before you trust this tool with something that matters.

- **The ACP lane's receipt does not record what it stripped.** As covered above: `acp-worker.mjs` strips the same credential-shaped variables and session markers from its child's environment as the subprocess lane does, but it never carries the list of removed names into its own receipt — `strippedEnv` is always `null` there, even on a run where real stripping happened. The subprocess lane's receipt does carry the list.
- **An http-lane review never sees the real `--check` result.** The subprocess and acp lanes now thread the validator's real exit code and output into the reviewer's prompt. The http lane does not: `runPipeline` never populates `stages.validator` for that lane (its check happens inside `local-patch.mjs` instead), so a `--lane http --reviewer ...` run always tells the reviewer "No check receipts were supplied to this review" — even though a check did run, and its result is known to the pipeline.
- **`--check` is effectively required for `--lane http`, not optional.** Omitting it does not gracefully skip the validator step the way it does for the subprocess and acp lanes; `local-patch.mjs`'s own task validation throws before any worktree is created, which surfaces as a hard error (exit 2).
- **`--timeout-minutes` has no effect on `--lane http`.** Both the model call and the check command use `local-patch.mjs`'s own fixed internal timeout (5 minutes) regardless of what you pass.
- **`devharmonics set` has no `--reviewer` and no `--check`.** A multi-repository set gets only the empty-diff and tampercheck gates plus the merge, once per member; there is no validator step and no independent-review step at the CLI level, even though the library-level `scopeFinding` helper needed to attribute a review finding to one member already exists and is tested.
- **Antigravity (`agy`) has several rough edges, found live and worked around rather than solved:** no verified model-pinning flag, so DevHarmonics never tells it which model to use; headless `agy` does not treat its process's working directory as its workspace, so `--add-dir` must name it explicitly, or `agy` silently edits its own scratch directory instead while still reporting success; and command/tool execution in headless mode auto-denies unless the owner has already added a permission rule to `agy`'s own `settings.json` — DevHarmonics deliberately does not reach for a skip-all-permissions flag to work around that.
- **A resolved model from an ACP session is usually null.** ACP v1 has no top-level "which model actually ran" field; DevHarmonics reads a `session/new` `configOptions` entry of category `model` (or a `_meta.model` extension) when an adapter happens to offer one, and otherwise honestly reports `resolutionVerified: false` rather than trusting the requested model name.
- **Usage and cost reporting genuinely differs per provider**, not by choice but by what each one's own output actually contains: Codex's JSON events carry token counts; Claude's `--output-format json` carries a `total_cost_usd` figure (recorded as `usage.costUsd`); HTTP-lane local models report input/output token counts (no cost); `agy`'s output has not been found to carry any usage information at all, so its receipts always show `usage: null`.
- **`deterministic-detector` is part of the *stated* verification plane but is not wired into any command.** `docs/SPEC.md` §2.4 describes it as qualifying each target repository's test suite (randomized order, pollution detection, diff-scoped mutation), which is what would establish that a passing `--check` is actually *sensitive* to breakage. No script invokes it today, so a `validated` assurance level means "a check ran and exited 0", not "a check proven capable of failing". Treat validator evidence accordingly until this is wired or the spec claim is withdrawn.
- **`tampercheck` covers Python and JavaScript/TypeScript patterns only.** Rust — needed before some of the owner's other repositories can lean on this gate — is a named, not-yet-built gap (tracked in `docs/SPEC.md` as an explicitly deferred item, not something this codebase can verify or fix on its own — `tampercheck` is a separate tool this factory depends on and pins).
- **A config file's `budgets.maxWorkerMinutes` is validated but not enforced anywhere.** No command currently reads it; the timeouts that actually apply are each command's own `--timeout-minutes` flag (or, for the http lane, `local-patch.mjs`'s fixed internal one). Separately, a whole budget-ledger library exists (`scripts/admission.mjs` — `reservePaidUsage`, `reserveUnpaidTaskUsage`, `summarizeLedger`, ported with its own passing tests) but is not called by any command either; spend tracking across runs is a capability that currently has no CLI surface at all.
- **No restart or reconstruction of an interrupted run or set.** If the process is killed mid-run, there is no saved state to resume from — a re-run starts over from scratch. This is explicit by design for multi-repository sets (`docs/INTEGRATION-SETS.md`) and is equally true of the single-repository pipeline, which cleans up its temporary worktree unconditionally and keeps no resumable state file.
- **No automatic merge-conflict repair.** A conflicting merge is aborted back to the pre-merge state and refused; resolving it is a human's job.
- **One repository per task, always** — enforced structurally: planning a multi-repo set rejects two members that resolve to the same repository or share a `repositoryId`, and a single `run` invocation only ever targets one `--repository`.
- **No dashboard, no routing/ranking optimizer, no campaign kernel.** These are deliberate scope brakes, not oversights: qualification is stated to be an admission gate only ("never a ranking engine"), and staged rollouts, pilots, and promotion are explicitly out of scope for v1. A separate, third-party app is the intended human cockpit; this factory's own output is CLI text or JSON.

## 9. Troubleshooting

These are the refusal reasons `run`, `set`, and the integration engine actually produce, and what each means.

| Reason | Stage | Meaning |
|---|---|---|
| `worker-failed` / `worker-timeout` / `worker-interrupted` | worker | The worker didn't finish cleanly; nothing was committed or integrated. Check its receipt for why. On the http lane, this reason (specifically `worker-failed`) is also what you'll see if the model simply echoed a file back unchanged — read the receipt's `detail` field to tell the two apart. |
| `worker-empty-diff` | after the worker (subprocess/acp only) | The worker completed but staged nothing. Different from `empty-diff` below — this fires before integration is even attempted. The http lane never produces this exact reason; see `worker-failed` above. |
| `validator-unresolvable` | `--check` | The command named in `--check` couldn't be found on `PATH` at all. |
| `validator-failed` | `--check` | The `--check` command was found and ran, but exited nonzero or timed out. |
| `commit-failed` | commit | `git commit` itself failed inside the worker's worktree after a nonempty diff was staged — rare. |
| `empty-diff` | integration gate 1 | The worker branch has no changes relative to the pinned merge-base. |
| `tampercheck-findings` | integration gate 2 | `tampercheck` ran and reported findings (exit 1). Read `tampercheck-output.txt` in the evidence bundle. |
| `tampercheck-unavailable` | integration gate 2 | `tampercheck` couldn't be trusted to answer at all: not on `PATH`, it crashed, it timed out, or it didn't self-report a real-looking version to the (now default-on) identity check. Never treated as a pass. |
| `merge-conflict` | merge | The `--no-ff` merge conflicted and was aborted automatically. The listed conflicting paths need a human. |
| `review-not-ready` | review | The run **did** integrate (exit code is still 0) but the optional reviewer came back NOT READY. (The deterministic claims-vs-diff divergence check could also force this, but for a `run` today it is reported as "not checked" — see step 7 and finding M-1 — so in practice this reason comes from the model reviewer's own verdict.) Read the review evidence bundle. |
| `advanced-but-set-blocked` | `set` only | This member integrated cleanly, but a sibling in the same set did not, so the set overall isn't ready. This member is not rolled back. |
| `integration-error` | `set` only | The integration engine threw for this one member (for example, its repository changed underneath a planned set). Recorded as refused; never allowed to take down the rest of the set. |
