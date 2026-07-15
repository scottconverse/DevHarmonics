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
- `src/worktrees.ts` and `src/integration-sets.ts`: repository-local integration/task worktrees plus exact multi-repository integration-set coordination.
- `src/validators.ts`: execution of user-configured validator allowlists.
- `src/repository-intelligence.ts`: non-mutating local Git identity, branch, remote, dirty-state, and compatibility inspection.
- `src/ledger.ts`: SQLite-backed Workbench discussions, objective drafts, immutable plan revisions, approved run linkage, exact integration-set state, and run/task/attempt/check/event receipts.
- `src/reporter.ts`: immutable evidence export, including exact per-repository integration-set commits and status.
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

Objective planning is a durable pre-run control plane. Saving or updating a structured objective creates no run. Each architect proposal is appended as an immutable numbered plan revision with its human or system rationale. Approval marks one exact revision and a linked run copies that plan into its own ledger projection; the orchestrator skips architecture planning and executes the approved graph. This keeps restarts and later evidence tied to what the user actually authorized rather than an in-memory callback or a silently regenerated plan.

Workbench is a separate read-only consultation plane. A durable session contains ordered user questions and attributed model responses, but it has no run or tool-execution linkage. Each assistant response records the provider connection, requested and resolved model, terminal status, error, token usage, cost, and duration. The only transition out of Workbench is an explicit conversion that creates and links an objective draft; it does not create a plan or run. Runtime invocations use exact active, current-qualified models with `read_only` permission, and paid API models remain subject to the project's explicit spending policy.

The product registry preserves repository boundaries rather than treating a product as a monorepo. Each repository can retain a local path, functional role, expected branch, owners, dependency repository IDs, validator definitions, and governance sources/rules. A separate inspection projection records the observed branch, HEAD, origin, dirty flag, compatibility issues, and check time. Inspection uses only read-only Git and filesystem operations; registration and rescan do not create a run, checkout a branch, fetch, reset, stash, or modify files. Remote-only observations migrate forward with neutral defaults until a local checkout is explicitly attached.

An objective may reference one product and an explicit set of its repositories. Before the architect invocation, the orchestrator assembles read-only registry context for the selected repositories, their dependencies and dependents, and relevant umbrella, shared-platform, documentation, installer, and release-truth repositories. The validated plan records each considered repository as affected or excluded with rationale, scopes every task to affected repository IDs, and requires explicit integration conditions whenever several repositories are affected. This analysis remains a pre-run control-plane operation.

The first DH-720 execution slice accepts a multi-repository plan only when every affected repository has a compatible local checkout, every task targets exactly one affected repository, and integration conditions are explicit. `IntegrationSetManager` preflights the Git roots, rejects duplicate roots, and creates a separate `WorktreeManager` per repository. Each manager pins a base commit, creates a repository-specific integration branch/worktree, creates task branches/worktrees, and serializes merges targeting that repository; schedulable tasks targeting different repositories can run concurrently. Each repository loads its own constitution and validator map. Repository-local validators and verification-integrity checks run before an aggregate context-only review receives repository-prefixed diff chunks. Ledger schema 21 retains the exact base and integration HEAD commits, branch/worktree paths, status, errors, and integration conditions; the API, evidence export, and run UI project that same record. No operation checks out or merges into a registered primary checkout.

This slice deliberately fails closed outside that topology. It has no automatic multi-repository fixer/re-review, and it supports one aggregate reviewer only; a policy requiring a quorum or more than one provider leaves the run `NOT READY`. It also does not reconstruct interrupted integration sets, clean worktrees automatically, push branches, open pull requests, or allow one task to mutate several repositories.

The ledger uses ordered, transactional schema migrations tracked by SQLite's `user_version` and a `schema_migrations` table. Before upgrading an existing schema, DevHarmonics creates a consistent SQLite backup beside the ledger using the filename pattern `devharmonics.db.backup-v<from>-to-v<to>-<timestamp>-<id>.sqlite`. It validates the required table shape, SQLite integrity, foreign keys, and migration history before accepting the upgraded database. Failed migrations roll back and retain the pre-migration backup; databases from newer DevHarmonics schema versions are rejected instead of being modified.

Provider connections and models have normalized registry tables separate from legacy task/provider fields. Dashboard bootstrap and run preflight upsert the three subscription connections without creating concrete model records. Manual model entries require an existing connection, retain provenance and lifecycle flags, enforce visible/verified/qualified/active consistency at the API boundary, and cannot overwrite discovery-managed records. Registry metadata is redacted before persistence.

Ollama discovery registers installed local models without credentials. A local model must pass current, exact-fingerprint qualifications before it can be scheduled. Read-only local review remains context-injected: DevHarmonics supplies bounded per-file diff chunks or independent accepted diagnostic-report chunks with bounded goal, task-contract, and check context. Bounded local implementation uses an orchestrator-managed loop exposing only scoped `file.read`, `file.search`, and hash-checked `file.patch`; the model cannot escape its worktree or repository scope and never receives unrestricted shell, commit, merge, or external-write authority. DevHarmonics records each tool execution and completed review chunk and fails closed on missing, contradictory, deferred, or `NOT READY` evidence. A classified failure cools the exact model or connection and reroutes to the next eligible qualified candidate.

Mellum2 has an explicit local specialist profile. Instruct (`mellum2-instruct`) and Thinking (`mellum2-thinking`) are distinct tracking families so an upgrade cannot silently change the reasoning contract. Both expose code, tool, structured-output, routing, and context-preparation capabilities; Thinking additionally exposes reasoning. Published metadata is only provisional routing evidence: scheduling also requires the appropriate analysis or bounded-tool qualification plus a current `local-specialist-v2` benchmark that verifies strict JSON, contradiction detection, and requirement counting without exposing the accepted answer. Discovery never downloads or activates either variant.

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
- Multi-repository execution does not yet provide automatic fixing or review quorums greater than one, restart reconstruction, cleanup, pushes/pull requests, or one task spanning several repositories
- Local Ollama models cannot inspect or write arbitrary repository paths; reviewers receive orchestrator-supplied context, while qualified implementors receive only scoped read/search/hash-checked-patch tools inside the assigned worktree
- Large CPU-only local reviews can be materially slower than subscription reviewers, so capacity-aware background scheduling and stronger local-model profiles remain follow-up work
- No Agent Client Protocol transport yet
