# Changelog

All notable DevHarmonics changes are documented here.

## [Unreleased]

## [0.6.1] - 2026-07-22

### Added

- Tag-truth gate: tagging a delivery now reads the version the target repository declares about itself from the exact immutable commit that will be tagged — resolved with `git show <merge-commit>:package.json`, then `:pyproject.toml`, never from the mutable checkout — and refuses a contradicting tag with both values shown; the cockpit takes an explicit second owner confirmation before a mismatched tag is ever minted. The `pyproject.toml` lookup reads only the PEP 621 `[project].version`, so another table's `version` key can neither trip nor bypass the gate. The delivery payload carries each repository's declared version, and the cockpit's tag field pre-fills with it as an editable value — with a caption stating plainly that an empty field creates no tag. Before merge the version is resolved from the reviewed commit; once the pull request is merged the prefill follows the exact merge commit the tag gate judges — resolved and, if needed, repaired at read time, never the reviewed head once merged — so it can never propose a version the gate would then reject. If a transient GitHub or network failure at merge time left the merge commit unrecorded or unfetched, the read path re-resolves the merge commit from the live pull request and fetches its object, and if the merge version genuinely cannot be resolved right now it reports "merge version temporarily unavailable — retry" rather than a silently-wrong version. Declining the mismatch confirmation is reported as a declined operation, not a success.

### Changed

- The Evidence page's derived verdict now leads with what the verdict means and the exact reasons behind it (an INCONCLUSIVE names its missing or inconsistent evidence instead of implying breakage), followed by a scannable per-target list — one collapsible row per reviewed file with its own READY/NOT READY chip — in place of the previous single unbroken wall of review text.
- Delivery card buttons carry emphasis by state: the next available step is the primary action; completed steps demote to "Branch pushed ✓ / Draft PR created ✓ / Merged ✓ / Tagged ✓".

## [0.6.0] - 2026-07-22

### Added

- Owner-approved delivery for READY runs, complete from the dashboard. DevHarmonics retains each repository's exact reviewed base, HEAD, branch, and local path, and the owner can run the entire delivery without leaving the cockpit: an exact-SHA branch push, draft pull-request creation, pull-request merge, release tagging, and a one-step complete flow. Every step requires its own explicit external-write approval and records a tool-policy receipt — there is no automatic merge and no automatic tag. The merge verifies live pull-request state and refuses conflicts, pending or failing status checks, and a head commit that is no longer the reviewed commit. Tagging validates the tag name, tags the actual merge commit, persists the applied tag, recovers an interrupted tag push by reusing the local tag, and refuses a second, different tag on an already-tagged delivery. Completed steps reconcile idempotently, concurrent operations on one repository are refused server-side, and the delivery card locks while a step is in flight.
- Review evidence lenses (DH-460). Reviewer decorrelation gains a second axis: what a reviewer is shown. An artifact-lens reviewer judges the diff and repository without seeing the workers' reports; a claims-lens reviewer judges the reports without seeing the code and must return a structured claimed-changes manifest, which a deterministic gate compares against the integrated diff — a worker that narrates changes it never made fails mechanically. Claims-lens isolation is structural: a fresh working directory outside any repository, full tool shutdown for providers that support it, capability-gated routing away from providers that cannot prove denial, and fail-closed managed-policy detection behind an explicit owner attestation.
- Per-run cost counterfactual (DH-650). A run shows its actual spend beside what the same work would have cost on the priciest qualified candidate mix, from like-for-like pairable receipts, with unpairable and unknown-cost receipts reported rather than silently dropped.
- Cheapest-at-established-parity routing preference (DH-320). Among candidates whose quality guards all pass (tier fit, reasoning fit, established empirical latency, user pins, provider diversity for review), routing prefers the cheaper candidate at score parity; preference nudges cannot override a quality guard, and a directed provider remains a hard constraint.
- DH-810 reusable workflows. A workflow is a versioned, parameterized JSON document in the repository's tracked `workflows/` directory, identified by canonical-JSON content hash and parsed fail-closed: ungated external writes, duplicate input names, outcome-template placeholders naming no declared input, and empty evidence requirements are refused at parse time with named issues. Instantiating a workflow with typed inputs (an empty or whitespace-only string does not satisfy a required input) creates an ordinary objective through the existing composer — no second execution engine — and the objective carries the workflow revision hash as structural provenance. Starting it pins the revision into the run record once, immutably, derived server-side; no client-supplied pin exists, and hand-editing an objective clears its provenance. Recording a revision promoted from a pilot refuses permission widening: external writes switching on, autonomy escalation, or removal of an approval point the pilot required. Two workflows-of-record ship (`documentation-consistency`, `release-truth-audit`) and a Workflows dashboard view lists, inspects, and instantiates revisions.
- A write task whose branch changed nothing against its base commit does not pass. The worker is told its attempt produced no repository change and gets one bounded retry to make the edit or explain why no change is needed.
- Read-only diagnostics must carry verifiable path/line citations where the task contract requires them, and reviewer prompts carry the explicit duty to judge whether cited lines support the conclusions drawn from them.
- Validator commands support a `${repoRoot}` token so per-repository toolchains stay portable across checkouts.
- Local Thinking-track model qualification; a local model timeout now cools that model rather than the whole local connection.
- DH-635 live run steering. An owner can redirect a running run from the dashboard instead of editing an agent terminal, without losing completed evidence. Task admission can be held and resumed while active work finishes; queued tasks can be reprioritised or reassigned to another available provider; a clarification is delivered to a task at its next attempt boundary; and an active attempt can be interrupted, which stops that attempt, retains it as evidence, and continues in a new attributed attempt. Steering is deliberately unable to widen scope, permissions, spending, deployment authority, or acceptance criteria: the directive payload has no such fields, interrupt grants are capped so repeated interrupts cannot extend a task's invocation budget, and directives that could never be applied are rejected with a reason rather than left pending. Every directive records its actor, target, timestamp, disposition, and the exact attempt it steered, and the run board shows pending, applied, rejected, and superseded states. Ledger schema 28.
- DH-632 visible operation feedback, first wave. Every dashboard-initiated action now acknowledges immediately through one shared operation helper: the control disables, exposes an accessible busy state, shows a busy label and an honest indeterminate spinner, and reports explicit done/failed end states with the failure reason. A global activity strip (a polite live region) keeps active run tasks and local operations visible across screen changes, with the responsible provider/model, evidence-based elapsed time, and a "quiet for…" heartbeat warning when a long provider call has produced no events. Task cards show live elapsed/last-activity times reconstructed from durable ledger events, so refresh or reconnection rebuilds feedback truthfully. Progress bars remain deliberately absent until a real completed/total measure exists, and reduced-motion preferences replace animation with a static indicator.

### Fixed

- A stale qualification no longer blocks a provider's default model from being scheduled.
- Cross-repository architect proposals use each repository's own validator names.
- Plan-validation vocabulary errors surface the exact accepted values instead of a generic refusal.
- Managed-fleet configuration reflects each connection's actual schedulable roles.
- Reviewer-independence diagnosis reports the requirement an operation actually has rather than a proxy for it.
- Run-list rows no longer clip their bottom edge in the dashboard.

### Changed

- Ledger schema advances to 33 (review-receipt lens metadata, delivery merge/tag state, release-tag persistence, workflow revisions, objective workflow provenance) through ordered transactional migrations with byte-consistent pre-upgrade backups; a documented rollback path to v0.5.1 uses those backups (docs/ROLLBACK.md).
- Run evidence packages advance to version 5 so approved delivery coordinates and results survive restarts and exports.
- DevHarmonics is now released under the Apache License 2.0. Added the canonical `LICENSE` file and updated the README, contributor terms, package metadata, the lockfile's root license metadata, and the canonical product specification (v1.12, licensing open question resolved); the version-consistency check now requires the Apache-2.0 license file and matching package/lockfile metadata.
- The README is rewritten as the repository's landing page: what the product structurally guarantees, how a run works, the delivery line ("nothing external without a per-action owner approval"), and an honest status/limitations section.
- The user manual records the Windows environment facts (temp relocation, Docker host) that otherwise produce false failures and false greens, documents the full cockpit delivery flow, and adds the saved-workflow walkthrough.

## [0.5.1] - 2026-07-15

### Fixed

- Corrected the published user manual's security-reporting link so it resolves to the repository's private-reporting instructions instead of a missing GitHub Pages path.

## [0.5.0] - 2026-07-15

### Added

- Immutable source-backed product-intelligence snapshots over configured canonical repository files, retaining exact HEAD revisions, blob/content hashes, working-tree state, explicit subject-aware claims, cited contradictions, and missing/unsafe-source findings without modifying repositories.
- Products-page **Scan intelligence** controls and planning-context injection of the latest bounded snapshot findings; Git tags are deliberately excluded as maturity evidence.
- Multi-repository final review now performs first-use premium reviewer qualification before adaptive routing, closing a live-run sequencing gap that could leave an available model unschedulable for review.
- A local product/repository registry that preserves multi-repository boundaries and records repository roles, owners, dependencies, validator commands, governance sources, branch/HEAD/remote identity, dirty state, and compatibility issues through read-only Git inspection.
- Product-aware objective composition and cross-repository planning with explicit repository selection, affected/excluded impact rationale, repository-scoped tasks, required integration conditions, and fail-closed topology checks before execution.
- The first DH-720 exact integration-set execution slice: one repository per task; isolated per-repository integration/task branches and worktrees pinned to retained base commits; concurrent work across repositories with serialized same-repository merges; repository-local validators and verification-integrity checks; aggregate context-only review; exact base/HEAD evidence in the ledger, export, API, and run UI; and no mutation of primary checkouts.
- Configured multi-repository review quorums with implementor independence and distinct-provider requirements, exact repository-scoped finding assignment, automatic fixer tasks in the affected repository worktrees, repository-local revalidation, review-evidence invalidation, and mandatory independent re-review.
- A durable, discussion-only Workbench for project questions and side-by-side consultation of selected qualified models, with exact provider/model/usage attribution and explicit conversion into a linked objective draft without starting a run.
- Durable structured objective drafts and immutable plan revisions with approval rationale, exact-revision run linkage, and restart-safe persistence.
- A two-step objective composer that previews task dependencies, repository scope, permissions, checks, proposed model assignments, and capacity before execution.
- Bounded Ollama implementation through scoped `file.read`, `file.search`, and hash-checked `file.patch` tools inside the assigned worktree, with typed policy and execution receipts.
- Mellum2 Instruct and Thinking profiles as separate local specialist upgrade tracks, with published capability provenance and no automatic download or activation.
- A machine-checked local specialist benchmark covering strict structured output, contradiction detection, and requirement counting; Mellum2 scheduling requires this benchmark in addition to its role qualification.
- A visible **Benchmark specialist** model action plus family, capability, parameter-size, and quantization details in the model fleet.

### Changed

- Google Antigravity is now represented as one subscription connection exposing Google, Anthropic, and OpenAI model vendors rather than being presented as synonymous with Gemini. The legacy `gemini` configuration key remains an internal compatibility alias.
- Attempt and Workbench attribution now distinguishes the requested Antigravity model from runtime-verified actual identity; an unverified request is no longer reported as proof that the requested model executed.
- Supported multi-repository plans can now start when all affected repositories have compatible local checkouts, every task targets exactly one repository, and explicit integration conditions are present. Resume reconstruction, cleanup, pushes/pull requests, and one task spanning repositories remain deferred and fail closed where policy requires them.
- Narrow, low-risk single-scope implementation tasks can use the economy specialist lane; standard, high-risk, architectural, and release work retain stronger tier requirements.
- Manual assignments and adaptive routing now enforce declared code, tool, vision, and structured-output capability needs.
- Stale models are excluded from role selectors, and local family-tracked workers must pass bounded-tool qualification before promotion.
- Routing model selectors are role-aware; incompatible existing choices remain visible as disabled warnings instead of appearing usable for roles they have not passed.

### Fixed

- Review receipts are now cryptographically bound to the exact plan, check evidence, task reports, diff, and repository base/HEAD set; the immutable reporter fails closed when retained evidence no longer matches.
- Architect qualification now tries the next eligible exact model on the same provider before abandoning that provider.
- Internal multi-repository integration and repair task IDs retain readable slugs plus collision-resistant repository hashes.
- Cancellation and shutdown now settle every concurrent active attempt before returning.
- Malformed JSON requests return a stable HTTP 400 response instead of an internal-server error.
- Repository validators cannot escape their assigned worktree through a relative working directory.
- OpenRouter spending gates now atomically reserve concurrent Workbench and run spend in the shared SQLite ledger. Durable lifecycle state and reservation-bound receipts reclaim expired pre-invocation leases and settle the final receipt atomically, while ambiguous invoked failures remain reserved. Unknown prices fail closed, and accepted API requests carry a hard completion-token ceiling used for their conservative maximum-cost reservation.
- Landing-page manual links now open rendered documentation, the illustrated run console reflows on compact screens, and public architecture/identity copy matches the v0.5 multi-repository reviewer-quorum topology.
- A task retry can no longer report success while an existing task-branch commit remains unmerged.
- Antigravity quota exhaustion is scoped to the provider-reported **Gemini Models** or **Claude and GPT Models** group, so one exhausted group no longer cools the entire connection or blocks qualified fallback through the other group.
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

## 0.3.0 - 2026-07-14

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

[0.6.1]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.6.1
[0.6.0]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.6.0
[0.1.0]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.1.0
[0.5.1]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.5.1
[0.5.0]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.5.0
[0.4.0]: https://github.com/scottconverse/DevHarmonics/releases/tag/v0.4.0
