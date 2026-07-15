# Changelog

All notable DevHarmonics changes are documented here.

## [Unreleased]

### Added

- Durable structured objective drafts and immutable plan revisions with approval rationale, exact-revision run linkage, and restart-safe persistence.
- A two-step objective composer that previews task dependencies, repository scope, permissions, checks, proposed model assignments, and capacity before execution.
- Bounded Ollama implementation through scoped `file.read`, `file.search`, and hash-checked `file.patch` tools inside the assigned worktree, with typed policy and execution receipts.
- Mellum2 Instruct and Thinking profiles as separate local specialist upgrade tracks, with published capability provenance and no automatic download or activation.
- A machine-checked local specialist benchmark covering strict structured output, contradiction detection, and requirement counting; Mellum2 scheduling requires this benchmark in addition to its role qualification.
- A visible **Benchmark specialist** model action plus family, capability, parameter-size, and quantization details in the model fleet.

### Changed

- Narrow, low-risk single-scope implementation tasks can use the economy specialist lane; standard, high-risk, architectural, and release work retain stronger tier requirements.
- Manual assignments and adaptive routing now enforce declared code, tool, vision, and structured-output capability needs.
- Stale models are excluded from role selectors, and local family-tracked workers must pass bounded-tool qualification before promotion.
- Routing model selectors are role-aware; incompatible existing choices remain visible as disabled warnings instead of appearing usable for roles they have not passed.

### Fixed

- Approved objective runs execute the exact stored plan revision without invoking the architect again or depending on an in-memory approval callback.
- Explicit local model assignment can no longer turn a read-only qualification into workspace-write authority.

## [0.4.0] - 2026-07-15

### Added

- Scheduler-time qualification of the exact subscription or local model selected for a role and workload tier, including automatic fingerprint-based requalification after runtime changes.
- Durable qualification pass/fail events with selected model, provider, role, activation result, and routing rationale.
- Fair first-use selection across concrete Codex, Claude, Gemini/Antigravity, and explicitly assigned Ollama candidates without probing an entire catalog.
- Workload-aware read-only attempt watchdogs: three minutes for simple diagnostics, ten for standard analysis, and fifteen for complex read-only work, bounded further by provider configuration.
- Machine-readable routing-score decomposition retained in run events and a task-drawer **Why this model** explanation.
- Empirical exact-model profiles for completion, first-pass success, retries, latency, malformed result envelopes, and classified failure kinds.
- Low-sample uncertainty labels and a 20-observation minimum before empirical reliability can influence adaptive routing.
- Workload-specific empirical slices with validator-failure, attempt-linked integration-conflict, actual billed-cost, and non-causal NOT READY participation evidence.
- Observation-baseline reset and empirical-history exclusion controls that preserve the immutable run ledger.
- Explainable established-latency weights, relative catalog-price scoring among comparable paid candidates, and independent-provider reviewer preference.
- Failure-scope routing that distinguishes account-wide quota/authentication/rate limits from exact-model quota, context overflow, resource exhaustion, incompatibility, and timeout.
- Reviewer invocation observations, including bounded Ollama review chunks, in the same workload-specific empirical profiles used for scheduler learning.

### Changed

- Concrete provider catalogs now suppress unresolved provider-default routing; selected exact models must qualify before protected work.
- Ordinary stale active or pinned models are requalified when actually selected, while family-tracked upgrade candidates retain their pre-promotion qualification and benchmark gate.
- Explicit model assignments, including pinned local reviewers, override inferred tier mismatch while retaining permission and qualification checks.
- Run-level NOT READY participation is never treated as causal model evidence; task-linked reviewer attribution remains a structured-review responsibility.
- Manually assigned models now disclose explicit tier overrides when their inferred tier is below the workload requirement.

### Fixed

- Diagnostic evidence validation now recognizes a repository file link followed by a nearby explicit line number, matching citation formats emitted by Antigravity.
- Versioned dashboard assets and explicit no-cache headers prevent stale cockpit code after an upgrade.
- View changes reset to the top, retained evidence reports are collapsed by default, and compact layouts keep Recent Runs available without page-level horizontal overflow.
- Compact run boards and metrics collapse to two columns, then one column, instead of forcing a four-column canvas.
- Graceful server shutdown pauses and awaits active orchestrator work before closing SQLite, preventing cancellation callbacks from racing a closed ledger.

## [0.3.0] - 2026-07-14

### Added

- Versioned, ordered SQLite ledger migrations with recorded migration history.
- Consistent pre-migration ledger backups and startup integrity validation.
- Provider-neutral domain identifiers and v0.1 provider-to-connection/model compatibility projections.
- Validated run and task lifecycle state machines.
- Typed event payloads with durable cursor replay through the local API.
- Central ledger-boundary redaction for prompts, outputs, errors, reviews, checks, and events.
- Qualified Ollama discovery and read-only local inference, including bounded per-file integration-diff review, chunk timing/token receipts, and fail-closed verdict aggregation.
- Primary-checkout isolation guards around every worker invocation and fresh sandboxed Antigravity projects rooted at the assigned worktree.
- A transport-neutral runtime contract for connections, model receipts, invocation events/results, usage, permissions, and classified failures.
- Attempt receipts for connection/model resolution, model settings, adapter/CLI versions, and failure classification.
- Layered provider diagnostics for configuration, installation, authentication, visibility, entitlement, control-plane health, capacity, and availability.
- Persistent provider-neutral connection and model registry tables plus validated manual-model APIs.
- Persisted server-sent events with durable replay cursors, automatic browser reconnection, duplicate suppression, and event-driven run refresh.
- Durable per-run Observe, Supervised, and Bounded autonomy modes exposed in the run composer and CLI.
- Fail-closed Observe planning contracts requiring diagnostic, read-only, low-risk tasks and substantive evidence reports.
- Live subscription, Ollama, Antigravity, Claude-catalog, and OpenRouter model discovery with freshness tracking.
- Fingerprint-based qualification invalidation, qualification history, exact-model pins, exclusions, and family-tracking policies.
- Model profiles and task-tier routing for Codex Sol/Terra/Luna, Claude families, Gemini/Antigravity models, Ollama, and activated OpenRouter candidates.
- Model and connection health cooldowns plus classified worker and final-review fallback routing.
- Adaptive capacity brokering without a built-in agent-count ceiling, durable blackboard handoffs, and token-bounded context packs.
- Governed OpenRouter OAuth connection, catalog search, exact-model activation, paid-fallback gates, spending limits, and cost receipts.
- Product and repository registry foundations for CivicSuite and future multi-repository operation.

### Changed

- Ledger upgrades now run transactionally, roll back on schema validation failure, and refuse databases created by newer schema versions.
- Existing run summaries retain their v0.1 fields while exposing explicit provider-neutral assignment metadata.
- Codex, Claude Code, and Antigravity orchestration now runs through the common runtime contract while retaining the v0.1 provider facade.
- Local reviewers evaluate bounded diff or diagnostic-report chunks and fall back to another qualified reviewer after classified runtime failure.
- Read-only worker results must satisfy their evidence contract before validators can mark a task passed.

### Fixed

- The new-run composer now remains open while background run polling continues.
- The manual agent-count control now has an accessible label.
- Never-qualified models are no longer mislabeled as having stale qualifications.
- Long run objectives use bounded summaries in the sidebar and run header, with the full objective available on demand.
- Model requalification now reports when an already-active model is immediately schedulable.
- Closed task details are inert and removed from keyboard navigation.
- Local environment files are ignored while preserving a safe `.env.example` template.
- Observe workers no longer repeat the already-approved plan instead of executing their assigned diagnostics.
- Markdown and Windows-path `file:line` citations are recognized by diagnostic evidence validation.
- READY review aggregation preserves risks found in accepted reports instead of claiming the target has none.

## [0.1.0] - 2026-07-13

### Added

- Local dashboard for composing and monitoring verified multi-agent runs.
- Subscription-session support for Codex, Claude Code, and Gemini through Antigravity.
- Provider installation and authentication gating with first-run guidance.
- Dependency-aware task planning and configurable, uncapped agent concurrency.
- Isolated Git worktrees, allowlisted validators, retries, integration, and final review.
- SQLite execution ledger with task, attempt, check, and event receipts.
- Active-run cancellation from the dashboard.

### Documentation

- DevHarmonics product rename across the package, CLI, dashboard, runtime paths, and Git branches.
- Source installation, complete user manual, architecture, security policy, and published landing page.
- Detailed Antigravity browser-code handoff and multi-screen onboarding instructions.

[0.1.0]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.1.0
[0.4.0]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.4.0
[0.3.0]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.3.0
