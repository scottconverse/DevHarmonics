# DevHarmonics

**One objective. A verified AI development crew.**

Current release: **v0.4.0**

DevHarmonics is a local, subscription-backed multi-agent orchestrator for software work. It coordinates the official Codex, Claude Code, and Google Antigravity CLIs; turns a goal into a dependency-aware task graph; gives parallel workers isolated Git worktrees; validates their changes; and records durable execution receipts in SQLite.

Normal subscription and local-model use requires no model API keys. Each subscription provider uses the account session already established by its official CLI, and API-key environment variables are removed from child processes. Optional OpenRouter access is separately connected through OAuth, disabled for paid routing by default, and never requires pasting a key into DevHarmonics.

[Product specification](docs/PRODUCT_SPEC.md) · [Spec Google Doc](https://docs.google.com/document/d/1rd-_gqHHPZHhTkrULJR9tHcbAVUOGONsbuEFCV-8pRQ/edit?usp=drivesdk) · [Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [Plan Google Doc](https://docs.google.com/document/d/1cVTT2v6H0z6j5NMSPcdwpoWNuuawxB-FdRUj1SYLwns/edit?usp=drivesdk) · [User manual](docs/USER_MANUAL.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Landing page](https://scottconverse.github.io/DevHarmonics/)

## What works today

- Local browser dashboard at `http://127.0.0.1:4317`
- Separate installation and sign-in checks for Codex, Claude, and Gemini
- Layered connection diagnostics that keep model entitlement and remaining subscription capacity explicitly unknown until verified
- Manual or architect-selected concurrency, with no built-in agent-count ceiling
- Typed, dependency-aware task planning
- One temporary Git worktree and branch per task
- Allowlisted validators with stdout, stderr, exit code, and duration receipts
- Provider rotation and exact validator feedback on retries
- Serial integration into a dedicated run branch
- Read-only final review with `READY` or `NOT READY` verdicts
- Durable run, task, attempt, check, and event records in SQLite
- Transactional ledger migrations with automatic pre-upgrade backups and integrity checks
- Provider-neutral assignment identities layered over the current subscription CLI providers
- One runtime contract for subscription CLI, future local, optional API, and ACP transports, with classified invocation failures
- Attempt receipts that retain connection/model resolution plus adapter and detected CLI versions
- Persistent provider-neutral connection/model registry with guarded manual model entries
- Validated run/task lifecycle transitions and replayable typed event cursors
- Persisted server-sent events with cursor reconnection and event-driven dashboard refresh
- Ledger-boundary redaction of common credentials in prompts, outputs, errors, checks, reviews, and events
- Active-run cancellation from the dashboard

## Requirements

- Windows, macOS, or Linux
- Node.js 24 or newer
- Git
- At least one installed and subscription-authenticated provider CLI:
  - Codex: `codex login`
  - Claude Code: `claude auth login`
  - Gemini through Google Antigravity: launch `agy` and complete first-run sign-in

DevHarmonics never asks for an OpenAI, Anthropic, or Google email password. Authentication happens only in provider-owned terminals and browser pages.

## Install from source

```powershell
git clone https://github.com/scottconverse/DevHarmonics.git
Set-Location DevHarmonics
npm.cmd ci
npm.cmd run build
node dist/src/cli.js doctor
node dist/src/cli.js serve --project C:\path\to\your\repository
```

The last command opens the dashboard. To make the command available globally from this checkout:

```powershell
npm.cmd link
devharmonics --version
devharmonics serve --project C:\path\to\your\repository
```

This first release is source-distributed; it does not yet include a packaged Windows installer.

## First-run sign-in

Run the provider's own login command, complete its browser flow, then return to DevHarmonics and click **Refresh sign-in status**. Installed-but-signed-out providers remain disabled and cannot start work.

Antigravity has a less obvious first-run flow:

1. Run `agy` and choose Google sign-in with the account tied to your Gemini subscription.
2. Complete browser sign-in. The browser displays a one-time authorization code.
3. Copy that code, return to the Antigravity terminal, paste it at the authorization prompt, and press **Enter**. Treat it as a short-lived credential; never paste it into DevHarmonics, a chat, or a document.
4. Complete every terminal onboarding screen, including color scheme and preferences. Use the navigation instructions shown at the bottom.
5. Wait for the normal Antigravity prompt showing the account, subscription tier, model, project path, and a `>` input line.
6. Exit the standalone session with `Ctrl+C`, run `agy models` to verify the cached login, and refresh DevHarmonics.

The dashboard includes this provider-specific guide. See the [user manual](docs/USER_MANUAL.md) for troubleshooting.

## CLI

```text
devharmonics serve [--project PATH] [--port 4317] [--open false]
devharmonics init [--project PATH]
devharmonics doctor [--project PATH]
devharmonics run --goal "..." [--project PATH] [--agents auto|N]
                   [--providers codex,claude,gemini]
devharmonics --version
```

Example:

```powershell
devharmonics run --project C:\repos\shop --agents auto `
  --providers codex,claude,gemini `
  --goal "Add CSV export, cover it with tests, and verify the download"
```

DevHarmonics does not clamp the requested agent count. Effective parallelism is still bounded by ready tasks, machine resources, provider throttling, and subscription limits.

## Project configuration

The first `init`, `serve`, or `run` creates a local runtime directory in the target project:

```text
.devharmonics/
  config.json
  constitution.md
  devharmonics.db
```

DevHarmonics adds `.devharmonics/` to that repository's private `.git/info/exclude`; it does not edit the shared `.gitignore`. For Node projects it discovers existing `test`, `lint`, `build`, and `typecheck` scripts. Every project also receives a built-in `diff-check` validator.

Example `.devharmonics/config.json`:

```json
{
  "version": 1,
  "architect": "claude",
  "reviewer": "codex",
  "workers": ["codex", "claude", "gemini"],
  "concurrency": { "mode": "auto", "agents": 20, "ceiling": null },
  "retry": { "maxAttempts": 3, "backoffMs": 1500 },
  "providers": {
    "codex": { "enabled": true, "command": "codex", "timeoutMs": 1800000 },
    "claude": { "enabled": true, "command": "claude", "timeoutMs": 1800000 },
    "gemini": { "enabled": true, "command": "agy", "timeoutMs": 1800000 }
  },
  "validators": {
    "diff-check": { "command": "git", "args": ["diff", "--check"], "timeoutMs": 60000 }
  }
}
```

Models select validators by name; they cannot supply a shell command for DevHarmonics to execute.

### Model catalog and qualification policy

DevHarmonics refreshes provider and Ollama catalogs at application launch, every 24 hours while running, on **Refresh fleet**, and before a run when the catalog is stale or a provider CLI version changed. A qualification fingerprint covers the provider, exact model ID, capability metadata, runtime version, adapter version, and qualification-suite version. Fingerprint changes make prior evidence stale and prevent scheduling until requalification.

Models can be pinned to an exact identifier or configured to track a Sol/Terra/Luna, Fable/Opus/Sonnet/Haiku, or Gemini family. A newly discovered family member is never promoted until its exact identifier passes invocation qualification and the deterministic baseline benchmark. A model is retired only after three consecutive authoritative missing observations.

OpenRouter is disconnected and paid routing is disabled by default. OAuth stores its generated credential under Windows current-user protection; DevHarmonics never asks the user to paste an API key. Connecting does not authorize spending. Paid fallback additionally requires the project paid-API gate, the OpenRouter fallback gate, positive per-run and monthly limits, an activated and qualified exact model, and a live key-limit check. DevHarmonics disables OpenRouter's own model fallback and records the exact provider, model, tokens, cost, and fallback reason itself.

## Run lifecycle

1. Require a clean Git working tree and authenticated providers.
2. Persist the selected Observe, Supervised, or Bounded run mode and ask a read-only architect to emit a compatible typed task DAG.
3. Create `devharmonics/<run-prefix>` as the integration branch.
4. Assign each ready task a `devharmonics/<run-prefix>-task-<task>` branch and temporary worktree.
5. Run a worker in that isolated worktree.
6. Execute only allowlisted validators.
7. Return failed check receipts to a worker for a bounded retry.
8. For writable tasks, commit passing work and merge it serially into the integration branch; Observe tasks retain reports without commits.
9. Start dependent tasks only after their dependencies merge.
10. Ask a read-only reviewer to evaluate the combined diff or each accepted diagnostic report; reroute after a classified reviewer runtime failure.

DevHarmonics does not merge the integration branch into your checked-out branch. You review and merge it yourself.

## Safety boundaries

- The dashboard binds only to `127.0.0.1`.
- Mutation endpoints require same-origin JSON requests.
- Architect and reviewer calls use provider read-only or plan modes.
- Workers use restricted editing modes rather than unrestricted bypass modes.
- Prompts are launched without shell interpolation.
- Validator commands come only from local user-controlled configuration.
- Common API-key and cloud-credential variables are stripped from provider environments.
- Common credential formats are redacted before run content and execution receipts are persisted or returned through the dashboard API.
- Parallel work requires a clean Git working tree.

## MVP limitations

- Merge conflicts fail the affected task; automatic conflict repair is not implemented.
- Temporary worktrees are retained for inspection until explicit archival/cleanup is added.
- Provider quotas and throttling originate with each subscription; DevHarmonics classifies observed failures and can cool and reroute qualified workers/reviewers, but provider-supplied remaining-quota telemetry is not consistently available.
- Ollama models are discovered locally, explicitly qualified before scheduling, and restricted to read-only inference. Tool-less local reviewers receive bounded per-file diff or per-report chunks with progress receipts and fail-closed aggregation. Local repository writes and Agent Client Protocol transports remain future work.
- Exact-model/settings routing is active for qualified models. Scheduler-selected Codex, Claude, Gemini/Antigravity, and explicitly assigned Ollama candidates are qualified on first use, requalified when their fingerprint changes, and selected independently by role/task tier. Durable **Why this model** evidence explains workload fit, qualification, pins, reliability, latency, relative paid-model cost, and independent-review preference. Empirical profiles are sliced by workload and expose validator failures, integration conflicts, billed cost, uncertainty, reset, and exclusion controls; only established evidence with at least 20 observations can affect reliability or latency. Account-wide failures fall back at connection scope while exact-model quota, context, resource, compatibility, and timeout failures can fall back at model scope.
- Manual registry entries are inventory records only; they do not imply account visibility, verification, qualification, or schedulability.

## Development

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run dev -- serve --project C:\path\to\repository
```

The automated suite covers configuration, credential stripping, provider parsing, plan validation, cancellation, SQLite receipts, local-model qualification and chunked review, workspace-isolation guards, the dashboard server, and full fake-provider orchestration through Git worktrees and final review.

## Project status and licensing

DevHarmonics v0.4.0 is an early public preview. The repository is public for evaluation and collaboration. No open-source license has been selected yet, so public visibility alone does not grant reuse rights. License selection is intentionally open for community discussion.
