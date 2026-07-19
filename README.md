# DevHarmonics

**One objective. A verified AI development crew.**

Current release: **v0.5.1**

**DevHarmonics is a local-first, provider-neutral software factory for product owners managing AI agents as development teams.**

It coordinates the official Codex, Claude Code, and Google Antigravity CLIs; turns a goal into a dependency-aware task graph; gives parallel workers isolated Git worktrees; validates their changes; and records durable execution receipts in SQLite.

Normal subscription and local-model use requires no model API keys. Each subscription provider uses the account session already established by its official CLI, and API-key environment variables are removed from child processes. Optional OpenRouter access is separately connected through OAuth, disabled for paid routing by default, and never requires pasting a key into DevHarmonics.

[Product specification](docs/PRODUCT_SPEC.md) · [Spec Google Doc](https://docs.google.com/document/d/1rd-_gqHHPZHhTkrULJR9tHcbAVUOGONsbuEFCV-8pRQ/edit?usp=drivesdk) · [Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [Plan Google Doc](https://docs.google.com/document/d/1cVTT2v6H0z6j5NMSPcdwpoWNuuawxB-FdRUj1SYLwns/edit?usp=drivesdk) · [User manual](docs/USER_MANUAL.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Landing page](https://scottconverse.github.io/DevHarmonics/)

## What works today

- Local browser dashboard at `http://127.0.0.1:4317`
- Separate installation and sign-in checks for Codex, Claude Code, and Google Antigravity
- Layered connection diagnostics that keep model entitlement and remaining subscription capacity explicitly unknown until verified
- Manual or architect-selected concurrency, with no built-in agent-count ceiling
- Typed, dependency-aware task planning
- One temporary Git worktree and branch per task
- Allowlisted validators with stdout, stderr, exit code, and duration receipts
- Provider rotation and exact validator feedback on retries
- Serial integration into a dedicated run branch
- Read-only final review with `READY` or `NOT READY` verdicts
- Durable run, task, attempt, check, and event records in SQLite
- Multi-product repository registry with read-only local Git inspection, repository roles, ownership, dependencies, validators, governance sources, and dirty/incompatible-state reporting
- Product-aware objective planning with selected repository scope, affected/excluded impact rationale, repository-scoped tasks, and explicit cross-repository integration conditions
- Exact multi-repository integration sets with separate per-repository branches/worktrees, retained base and integration HEAD commits, repository-local validation, configured independent review quorums, automatic repository-scoped fix/re-review, and visible/exportable evidence
- Durable read-only Workbench with exact selected-model comparison and explicit conversion into an objective draft
- Transactional ledger migrations with automatic pre-upgrade backups and integrity checks
- Provider-neutral assignment identities layered over the current subscription CLI providers
- One runtime contract for subscription CLI, future local, optional API, and ACP transports, with classified invocation failures
- Attempt receipts that retain connection/model resolution plus adapter and detected CLI versions
- Persistent provider-neutral connection/model registry with guarded manual model entries
- Validated run/task lifecycle transitions and replayable typed event cursors
- Persisted server-sent events with cursor reconnection and event-driven dashboard refresh
- Ledger-boundary redaction of common credentials in prompts, outputs, errors, checks, reviews, and events
- Active-run cancellation from the dashboard

The development branch after v0.5.1 also includes owner-approved delivery for READY runs: the run board shows exact reviewed commits, separately confirms an exact-SHA GitHub branch push and draft pull-request creation, retains both receipts, and never merges automatically. It also adds the first wave of visible operation feedback: immediate acknowledgement on every dashboard action, a global activity strip that keeps running work visible across screens, and evidence-based elapsed/heartbeat times on working tasks. These capabilities will ship with the v0.6 increment after its CivicSuite acceptance gates pass.

## Requirements

- Windows, macOS, or Linux
- Node.js 24 or newer
- Git
- At least one installed and subscription-authenticated provider CLI. This is
  required to PLAN: no local model is qualified for the architect role, so
  planning needs a signed-in subscription. An already-approved plan does not —
  it can execute and be reviewed entirely by qualified local models. Providers:
  - Codex: `codex login`
  - Claude Code: `claude auth login`
  - Google Antigravity (Gemini, Claude, and GPT models exposed by the signed-in account): launch `agy` and complete first-run sign-in

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

The current release is source-distributed; it does not yet include a packaged Windows installer.

## First-run sign-in

Run the provider's own login command, complete its browser flow, then return to DevHarmonics and click **Refresh sign-in status**.

A signed-out provider is removed from the pool rather than treated as a reason to stop. Planning still needs one healthy subscription architect, but one signed-out provider does not block planning that another healthy provider can do — and an approved run proceeds whenever a qualified worker and reviewer can be routed, including local ones.

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

Google Antigravity is one subscription connection, not a synonym for Gemini. Its catalog may contain Google, Anthropic, and OpenAI models. DevHarmonics schedules Antigravity's **Gemini Models** and **Claude and GPT Models** quota groups independently: an observed exhaustion cools only that group until the reported reset, so qualified capacity in the other group can continue. The `gemini` configuration key remains an internal compatibility alias for existing projects.

OpenRouter is disconnected and paid routing is disabled by default. OAuth stores its generated credential under Windows current-user protection; DevHarmonics never asks the user to paste an API key. Connecting does not authorize spending. Paid fallback additionally requires the project paid-API gate, the OpenRouter fallback gate, positive per-run and monthly limits, an activated and qualified exact model, and a live key-limit check. DevHarmonics disables OpenRouter's own model fallback and records the exact provider, model, tokens, cost, and fallback reason itself.

## Workbench

Workbench is a durable, read-only project scratchpad for questions, tradeoff analysis, draft planning, and side-by-side consultation of selected qualified models. Every answer retains its connection, requested model, runtime-verified actual model when available, usage, cost, duration, and failure state. A provider that does not report actual execution identity remains explicitly unresolved; DevHarmonics does not relabel the request as proof. Workbench cannot start a run or change a repository. A useful discussion can be explicitly converted into a linked objective draft; planning and execution still require their normal approval steps.

## Product and repository registry

The **Products** surface groups independent repositories into a product without turning them into a monorepo. Register a product, then add each local Git checkout with its role, expected branch, owners, dependencies, validator commands, and governance sources. DevHarmonics inspects repository identity and status using read-only Git commands and retains the current branch, HEAD, origin, dirty state, and compatibility issues. Registry inspection does not create a run or change the checkout.

Use **Canonical intelligence sources** to identify the governance, architecture, version, status, compatibility, and release files that matter in each local repository, then choose **Scan intelligence**. DevHarmonics creates an immutable source-backed snapshot with exact repository revisions, content hashes, working-tree state, explicit claims, unavailable-source findings, and subject-aware conflicts with path/line citations. It never infers maturity from Git tags. The latest bounded findings are included in product-aware planning.

In the objective composer, optionally select a registered product and one or more repositories. The read-only planner uses their registry roles and dependencies to produce an affected/excluded repository impact map, repository-scoped tasks, and any required cross-repository integration conditions. A multi-repository plan can execute when every affected repository has a compatible registered local checkout, every task targets exactly one affected repository, and the plan includes explicit integration conditions. Single-repository plans continue through the normal approval flow when the selected checkout matches the objective project folder and has no compatibility issues.

The DH-720 execution path creates an exact integration set rather than treating the product as a monorepo. Every affected repository gets an independent run integration branch and worktree pinned to its retained base commit, and every task gets a repository-local branch/worktree. Tasks in different repositories can run concurrently; merges into the same repository's integration branch remain serialized. DevHarmonics runs each repository's configured validators and verification-integrity check, then applies the configured independent review quorum to aggregate, repository-prefixed diff evidence. Blocking findings must identify exactly one repository. DevHarmonics assigns them to repository-scoped fixer tasks, revalidates the changed integration branches, invalidates the superseded review evidence, and requires a fresh independent quorum before reporting `READY`. The run card and evidence export retain each base/HEAD commit, branch, worktree, status, error, and the cross-repository integration conditions. The primary checkouts are untouched.

## Run lifecycle

1. Save a structured objective draft containing the outcome, acceptance criteria, constraints, risk, priority, deadline, policy, run mode, and optional product/repository scope. Saving or refining a draft starts no run.
2. Ask a read-only architect for an immutable plan revision and preview its dependency graph, affected/excluded repository map, repository-scoped tasks, integration conditions, permissions, checks, proposed model assignments, and capacity.
3. Revise the plan or approve an exact revision. Execution uses that stored revision without silently replanning it.
4. Require clean affected Git working trees, and a routable worker and reviewer. Once a plan is approved, a subscription for each is not required — qualified local models can carry and review the work. A standalone or single-repository run creates `devharmonics/<run-prefix>`; a multi-repository run creates a distinct integration branch/worktree for every affected repository and records its base commit.
5. Assign each ready task a repository-local task branch and temporary worktree. One task targets one repository; tasks in different repositories may execute concurrently.
6. Run a worker in that isolated worktree and execute only allowlisted validators.
7. Return failed check receipts to a worker for a bounded retry.
8. For writable tasks, commit passing work and merge it serially into the target repository's integration branch; Observe tasks retain reports without commits.
9. Start dependent tasks only after their dependencies merge.
10. Ask a read-only reviewer to evaluate the combined diff or each accepted diagnostic report. Multi-repository evidence is aggregated with repository-prefixed paths while preserving exact per-repository commits.

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

- Merge conflicts still fail the affected task; the automatic fixer handles structured reviewer findings, not Git merge conflicts.
- Temporary worktrees are retained for inspection until explicit archival/cleanup is added.
- Multi-repository execution still supports one repository per task. It does not yet reconstruct an interrupted integration set after restart, clean retained worktrees automatically, push branches, open pull requests, or let one task mutate several repositories.
- Provider quotas and throttling originate with each subscription; DevHarmonics classifies observed failures and can cool and reroute qualified workers/reviewers, but provider-supplied remaining-quota telemetry is not consistently available. Antigravity's observed Gemini and Claude/GPT quota groups are tracked separately rather than cooling the entire connection.
- Ollama models are discovered locally and remain unschedulable until their exact runtime fingerprint passes the qualifications required for the assigned work. Read-only local reviewers receive bounded per-file diff or per-report chunks with progress receipts and fail-closed aggregation. Qualified local implementors can use only DevHarmonics' scoped `file.read`, `file.search`, and hash-checked `file.patch` loop inside their assigned worktree; they receive no unrestricted shell, commit, merge, or external-write authority. ACP remains future work.
- Mellum2 is the first named local specialist family. Instruct and Thinking are separate upgrade tracks; neither is downloaded, activated, promoted, or made the universal default automatically. In addition to analysis or bounded-tool qualification, Mellum2 must pass the current structured-output, contradiction-detection, and requirement-count benchmark before scheduling. Instruct is initially eligible only for narrow, low-risk specialist work; Thinking is evaluated independently for standard reasoning work.
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

DevHarmonics v0.5.1 is an early public preview. The repository is public for evaluation and collaboration.

DevHarmonics is released under the [Apache License 2.0](LICENSE). You may use, modify, and redistribute it under that license's terms, which include a patent grant and require preserving attribution and change notices.
