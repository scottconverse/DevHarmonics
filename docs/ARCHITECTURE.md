# DevHarmonics Architecture

Architecture version: **0.4.0**

DevHarmonics is a local orchestration layer over official subscription-authenticated coding-agent CLIs. It does not proxy provider HTTP APIs.

```text
Goal + project
      |
      v
Read-only architect -> typed task DAG -> dependency scheduler
                                           |
                           +---------------+---------------+
                           |               |               |
                      Codex worker    Claude worker   Gemini worker
                           |               |               |
                           +------- isolated worktrees ----+
                                           |
                                allowlisted validators
                                           |
                                serial integration branch
                                           |
                                  read-only final reviewer
                                           |
                              verdict + SQLite run ledger
```

## Components

- `src/cli.ts`: command entry point for `serve`, `init`, `doctor`, and `run`.
- `src/server.ts`: loopback-only HTTP server and static dashboard delivery.
- `src/doctor.ts`: provider installation and authentication inspection.
- `src/providers.ts`: provider-specific process adapters and credential stripping.
- `src/runtime.ts`: transport-neutral connection, model-selection, invocation, event, result, usage, and classified-failure contracts.
- `src/domain.ts`: provider-neutral identifiers, lifecycle state machines, event contracts, and policy records.
- `src/compatibility.ts`: lossless projections from v0.1 provider fields to stable connection/model identities.
- `src/orchestrator.ts`: planning, dependency scheduling, retries, integration, review, and cancellation.
- `src/catalog.ts`, `src/qualification.ts`, and `src/model-fingerprint.ts`: discovery freshness, exact-model invocation qualification, and stale-evidence detection.
- `src/model-intelligence.ts`, `src/model-performance.ts`, and `src/routing.ts`: task complexity, model tiers, empirical observations with uncertainty gates, replayable score decomposition, adaptive selection, health exclusions, and fallback decisions.
- `src/ollama.ts` and `src/openrouter.ts`: qualified read-only local inference and governed opt-in API inference.
- `src/worktrees.ts`: integration branch and isolated task worktree lifecycle.
- `src/validators.ts`: execution of user-configured validator allowlists.
- `src/ledger.ts`: SQLite-backed run, task, attempt, check, and event receipts.
- `src/redaction.ts`: centralized secret scrubbing before data crosses the ledger or UI-error boundary.
- `src/ui/`: dependency-free browser interface.

## Trust boundaries

Provider authentication is outside DevHarmonics. Provider prompts and project content cross into the selected provider process. Model output is untrusted: plans are schema-validated, task dependencies are checked, and requested validators must already exist in local configuration.

Connection diagnostics retain separate configuration, installation, authentication, account-visibility, model-entitlement, control-plane-health, capacity, and assignment-availability layers. Subscription model entitlement and remaining quota stay `unknown` until supported discovery or classified execution evidence exists; a successful login is not presented as proof of either.

Run and task lifecycle changes pass through validated state machines before persistence. Legacy `codex`, `claude`, and `gemini` task assignments are projected into stable subscription-CLI connection IDs and explicit unresolved provider-default model IDs. This preserves v0.1 receipts without pretending the old ledger captured a concrete model that it did not record.

The orchestrator invokes every current provider through the same `RuntimeAdapter` contract. Codex, Claude Code, and Antigravity are subscription-CLI transports; Ollama is local; and OpenRouter is an OAuth-backed, explicitly funded API transport. ACP remains contract-defined future work. Invocation receipts normalize connection identity, model resolution, permissions, output, duration, usage when available, tool requests, lifecycle events, cost, fallback reason, and failure classification. Worker-attempt rows persist the stable connection ID, resolved or unresolved model ID, resolution status, model settings, DevHarmonics adapter version, detected CLI/runtime version, and classified failure kind. Exact model/settings requests are sent only through adapters that implement and qualify them; unsupported controls fail as incompatible rather than being silently ignored.

Each run persists an autonomy mode. Observe planning is fail-closed: every task must be diagnostic, read-only, and low risk. Read-only worker output must be substantive, cannot defer back to an already-completed approval gate, and must contain path/line evidence when the task contract requires it. Only accepted findings enter the run blackboard and final review.

Every concrete routing decision retains its individual score sources rather than only a total. The dashboard replays those sources as **Why this model** evidence, including workload tier, qualification, pins, established reliability and latency, relative catalog price among comparable paid candidates, and provider independence for review. Attempt receipts are aggregated by exact model and workload class across completion, first-pass success, retries, latency, billed cost, malformed envelopes, classified failures, validator failures, and attempt-linked integration conflicts. Run-level NOT READY participation is displayed as non-causal evidence and cannot penalize a model without task-linked findings. Profiles below 5 observations are insufficient, 5–19 are emerging, and 20 or more are established; only established workload slices may alter reliability or latency routing. Users can advance an observation baseline or exclude empirical history without deleting the ledger evidence.

Workers can edit only within their assigned worktrees using the selected CLI's restricted editing mode. Architect and reviewer calls are read-only. Git and configured validators remain local trusted executables.

## Persistence

Each target project receives `.devharmonics/config.json`, `.devharmonics/constitution.md`, and `.devharmonics/devharmonics.db`. Temporary worktrees live below the operating system's temporary directory under `devharmonics/<run-id>`.

The ledger uses ordered, transactional schema migrations tracked by SQLite's `user_version` and a `schema_migrations` table. Before upgrading an existing schema, DevHarmonics creates a consistent SQLite backup beside the ledger using the filename pattern `devharmonics.db.backup-v<from>-to-v<to>-<timestamp>-<id>.sqlite`. It validates the required table shape, SQLite integrity, foreign keys, and migration history before accepting the upgraded database. Failed migrations roll back and retain the pre-migration backup; databases from newer DevHarmonics schema versions are rejected instead of being modified.

Provider connections and models have normalized registry tables separate from legacy task/provider fields. Dashboard bootstrap and run preflight upsert the three subscription connections without creating concrete model records. Manual model entries require an existing connection, retain provenance and lifecycle flags, enforce visible/verified/qualified/active consistency at the API boundary, and cannot overwrite discovery-managed records. Registry metadata is redacted before persistence.

Ollama discovery registers installed local models without credentials. A local model must pass a qualification fixture before it can be activated or pinned. Local adapters are read-only and have no provider-managed repository tools. When one is assigned as final reviewer, DevHarmonics supplies bounded per-file diff chunks or independent accepted diagnostic-report chunks with bounded goal, task-contract, and check context. It records each completed chunk verdict and timing and fails closed on missing, contradictory, deferred, or `NOT READY` verdicts. A classified review failure cools the exact model or connection and reroutes final review to the next eligible qualified candidate.

Catalog reconciliation is a separate control plane from model invocation. Launch, periodic, manual, and pre-run refreshes update provider/runtime observations; they do not spend tokens. Fingerprints join exact model metadata to CLI/runtime, adapter, and qualification-suite versions. A fingerprint change makes qualification stale. Three consecutive missing observations are required before retirement.

The adaptive scheduler qualifies only the concrete candidate it is about to use. It independently selects an exact model for architect, worker, and reviewer roles; applies task-tier and capability fit; honors explicit assignments and pins; records the qualification decision; activates successful subscription/local candidates; and cools failed candidates before fallback. Provider catalogs suppress unresolved provider-default execution once concrete choices are known. Family-tracked upgrades remain separately gated by exact-model qualification plus the deterministic benchmark. OpenRouter is never automatically probed because paid qualification requires explicit cost confirmation.

Worker invocation timeouts are workload-aware for read-only work: simple diagnostics are bounded at three minutes, standard analysis at ten, and complex analysis at fifteen, always respecting a shorter provider-configured timeout. A timeout enters the same classified model/connection cooldown and retry path as other runtime failures. Workspace-write tasks retain the provider timeout because their legitimate execution window can be substantially longer.

Claude candidates are watched from Anthropic's official models overview because Claude Code does not expose a complete models command. Third-party trackers are advisory only. An exact Claude Code invocation is the entitlement proof for the signed-in subscription.

OpenRouter is an API transport with OAuth-backed, OS-protected credential storage. Its full public catalog is retained separately from the schedulable model registry so hundreds of models are never probed. Only user-imported models can be qualified. Paid execution requires three independent policy gates and two budget caps; the adapter always requests one exact model and sets provider fallback off. Provider, requested/resolved model, tokens, cost, and fallback reason are normalized into invocation receipts.

Events are typed, append-only ledger records. Their monotonic SQLite IDs are durable cursors; `GET /api/runs/<run-id>/events?after=<cursor>&limit=<n>` replays one run oldest-first and returns `nextCursor`. The dashboard uses `GET /api/events` as a persisted server-sent event stream, stores its last cursor for refresh/reconnection, ignores duplicate delivery, and fetches a fresh run projection only after a new durable event. The local server polls SQLite behind the stream; closing or reconnecting a browser never controls run execution.

On a controlled server shutdown, the orchestrator pauses and aborts active runs, waits for their background execution to settle, and only then closes the SQLite ledger. Startup reconciliation remains the recovery path after an uncontrolled process or machine termination.

Prompts, provider output, validator stdout/stderr, errors, reviews, event messages, and event payloads are redacted before persistence. Migration backups are byte-consistent snapshots of pre-existing data, so a backup may contain sensitive values written by an older version and must be protected like the original ledger.

## Deliberate non-features in v0.4.0

- No general API-key configuration; OpenRouter OAuth is the only API transport and paid use remains separately opt-in
- No remote DevHarmonics service
- No automatic merge into the user's checked-out branch
- No automatic conflict repair
- Local Ollama models cannot write or inspect arbitrary repository paths; they receive orchestrator-supplied context only
- Large CPU-only local reviews can be materially slower than subscription reviewers, so capacity-aware background scheduling and stronger local-model profiles remain follow-up work
- No Agent Client Protocol transport yet
