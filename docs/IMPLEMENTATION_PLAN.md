# DevHarmonics Detailed Implementation Plan

Document status: **Build-ready execution plan**
Plan version: **1.33**
Written: **2026-07-14**
Revised: **2026-07-22**
Product specification baseline: **DevHarmonics Product Specification v1.12**
Current implementation baseline: **DevHarmonics v0.5.1**
Google Doc: [DevHarmonics Detailed Implementation Plan](https://docs.google.com/document/d/1cVTT2v6H0z6j5NMSPcdwpoWNuuawxB-FdRUj1SYLwns/edit?usp=drivesdk)

Revision history: **v1.33 (2026-07-22)** — Item-6 (DH-810) implemented. A workflow is a **versioned, parameterized document stored in Git** in the tracked `workflows/` directory of the repository (`.devharmonics/` is gitignored run state and deliberately NOT where workflows-of-record live), identified by content hash — the same content-addressed discipline the ledger already applies to review evidence bindings (plan revisions, by contrast, use per-objective counters; the shared property is immutability of the record, not the identifier scheme). An objective created by instantiation carries the revision hash as structural provenance, and starting that objective pins the hash into the run record once, immutably (idempotent-or-refuse), so a later edit can never rewrite what a historical run executed; a client cannot supply the pin directly, and hand-editing an objective clears its provenance. Execution REUSES the objective composer: instantiating a workflow with typed inputs produces an objective draft through the existing propose/approve/start path — no second execution engine. Approval points map to the existing approval machinery; recording a revision promoted from a pilot refuses any permission widening (external writes switching on, autonomy escalation, or removal of an approval point the pilot required). First two concrete workflows ship as fixtures-of-record: documentation-consistency and release-truth audit. Ledger migration 32 adds workflow revision persistence and run linkage; migration 33 adds objective workflow provenance. Deferred from this increment, explicitly: campaign templates, agent-skill packs, per-product workflow scoping, approval-point taxonomy beyond plan/external_write/spending/destructive, and automatic discovery of workflow files from the repository (revisions are recorded through the API, not scanned).

**v1.32 (2026-07-22)** — Added the review **evidence-lens** axis to DH-460, after external evidence (Cursor's agent-swarm study: independent review lenses reading different information sources catch what any one lens misses) and our own defect #22 converged on the same failure shape: reviewers who all see the same evidence share the same blind spot. Reviewer decorrelation now has two axes — capability (what a reviewer can do, v1.25) and lens (what a reviewer is shown). Quorum policy gains required lens coverage by risk: an **artifact lens** that never sees implementor narration, and a **claims lens** that never sees the artifact and must return a structured claimed-changes manifest, which is then compared mechanically against the integrated diff so a claims/artifact divergence is a fail-closed finding rather than a reviewer's optional catch (generalizing the write-task-must-change-something rule from defect #22). DH-320 gains cheapest-at-established-parity preference among qualified candidates. DH-650 gains a per-run cost counterfactual (the actual mix versus the priciest qualified mix). This scope is inserted ahead of the item-5 delivery rerun by owner decision (2026-07-22); the rerun then serves as the lens machinery's proving ground.

**v1.31 (2026-07-19)** — v0.6 follow-ups closing item 4's deferred scope: every read-only diagnostic requires at least one verifiable citation (a vacuous report no longer passes), reviewer prompts carry the explicit duty to judge whether cited lines support the conclusions drawn from them, a local model timeout cools that model rather than the whole local connection, validator commands support a `${repoRoot}` token so per-repository toolchains are registered portably, and the user manual records the Windows environment facts (temp relocation, Docker host) that otherwise produce false failures and false greens.

**v1.30 (2026-07-18)** — Item 4 closed GREEN after eight independent audit rounds. Recorded the lesson that outlasted the fixes: the recurring defect was in verification, not in the product. Four fixes shipped with tests structurally unable to fail, and mutation testing rather than a green suite caught every one. DH-330 now states that a test never watched to fail is not evidence, and that "this cannot be tested deterministically" is a conclusion to distrust.

**v1.29 (2026-07-18)** — Recorded two further rules from the second audit round of the item-4 fixes, both learned by getting them wrong first: a control action (interrupt, cancel) is never evidence about a model, and a gate should refuse on the requirement an operation actually has rather than on a proxy for it. Both are in DH-330. Scope and the locked sequence are unchanged.

**v1.28 (2026-07-18)** — Recorded two rules that an independent audit of the item-4 fixes established, both in the same shape: a second implementation of a decision drifts from the first, and the gap between them is the defect. DH-470 now states that an evidence gate and its verifier must share one grammar, after the citation verifier turned out to be bypassable by writing the evidence in a form the gate accepted but the verifier could not parse. DH-330 now states that code needing to know whether work can run must ask the component that will run it, after a liveness predicate that re-derived routing eligibility was proven wrong in both directions. Scope and the locked sequence are unchanged.

**v1.27 (2026-07-18)** — Added DH-647 decision records and comparative option analysis, after a container-runtime choice recorded with evidence eight days earlier was made again from scratch because nothing surfaced the original. DevHarmonics can prove what it did but cannot retain what it considered and rejected, so a killed approach is re-proposed at full cost and each rediscovery looks like fresh analysis. The work package covers durable decision records with rejected alternatives and their reasons, supersession that preserves history, a planning-time obligation to state options and the deciding constraint for consequential choices, and retrieval by subject.

**v1.26 (2026-07-18)** — Promoted the approval inbox from an implicit bullet inside DH-600 to DH-645, a named work package scheduled immediately after the locked capability sequence, after the first real CivicSuite delivery showed an owner decision sitting unsurfaced in the product. DH-645 covers the approval inbox, a program-scope view across products and runs, delivered-versus-observed reconciliation against the external forge, and an exportable status page that does not depend on the DevHarmonics ledger or on DevHarmonics running. The locked sequence is unchanged.

Prior revision: **v1.25 (2026-07-18)** — Refined DH-460 with reviewer capability tiers (context, executing, falsifying) after DH-635's review produced direct evidence that a large same-family context-review quorum missed both critical defects that a single executing-and-falsifying reviewer found. Quorum policy gains a required-tier dimension, review receipts record the tier and the evidence produced, and a quorum met only by context reviewers must be reported as unfalsified rather than as a passed independent review.

Prior revision: **v1.24 (2026-07-18)** — Implemented DH-635 live run steering, the third item in the locked capability sequence: durable steering directives with full disposition and attempt linkage, admission-boundary hold/resume/reprioritise/reassign across both scheduler loops, attempt-boundary clarifications, and interrupt-and-handoff that retains evidence. Containment of scope, permission, spending, and acceptance authority is structural, and every directive ends with a disposition. Remaining sequence items are unchanged: real provider/local fallback during a CivicSuite task, a real cross-repository CivicSuite implementation, then Git-versioned reusable workflows.

Prior revision: **v1.23 (2026-07-16)** — Added DH-825, an experimental Open Interpreter worker adapter, to the integrations roadmap by owner decision: provider-neutral access to local and alternative coding models (Ollama/LM Studio, Kimi, DeepSeek, Qwen/GLM), qualified per exact model + harness + pinned Open Interpreter version, with DevHarmonics retaining exclusive control over task contracts, Git, validation, evidence, and integration, and never collecting provider credentials. The adapter does not alter the locked capability sequence; Open Interpreter also becomes the first conformance target for the DH-820 ACP transport.

Prior revision: **v1.22 (2026-07-16)** — Completed the first real bounded single-repository CivicSuite implementation (DH-740 pilot level 2): CivicCode's pinned CivicCore dependency, CI workflow, tests, and documentation were aligned from the v1.2.0 to the published v1.2.1 release wheel through the full objective → plan → approve → implement → validate → integrate → independent-review path, closing READY with a prepared exact-SHA delivery awaiting owner approval; the primary checkout was never modified. Implemented the first DH-632 wave exercised by that workflow: a shared operation acknowledgement helper across all dashboard actions (disabled/stateful controls, accessible busy state, honest indeterminate spinner, explicit done/failed end states with reasons), a global activity-strip live region that survives navigation, task-card elapsed/last-activity heartbeat with a truthful quiet-work warning reconstructed from durable ledger events, reduced-motion support, and deliberately no fabricated progress bars. Also adopted the Apache-2.0 license decision across the repository's license surfaces.

Prior revision: **v1.21 (2026-07-15)** — Added DH-632 as a cross-cutting visible-operation-feedback requirement. Every DevHarmonics-owned asynchronous action must have immediate acknowledgement, truthful lifecycle and stage feedback, elapsed activity and heartbeat, durable refresh/navigation recovery, accessible success/failure/retry states, and evidence-based rather than fabricated progress. The first real CivicSuite implementation must deliver the feedback states it exercises, and every later workflow must extend the same contract instead of deferring a UI/UX retrofit.

Prior revision: **v1.20 (2026-07-15)** — Implemented the approved branch/draft-PR delivery handoff: immutable exact reviewed repository coordinates, separate external-write approvals for an exact-SHA branch push and draft pull-request creation, retained policy receipts and results, ledger/evidence integration, and no merge surface. The first real bounded single-repository CivicSuite implementation is now next; later sequence items remain unchanged.

Prior revision: **v1.19 (2026-07-15)** — Reconciled the v0.5 release candidate with the implemented verified-development capabilities and locked the owner-approved next sequence: approved branch/draft-PR delivery; a real bounded single-repository CivicSuite implementation; live run steering; real provider/local fallback during that work; a real cross-repository CivicSuite implementation; and reusable Git-versioned development workflows. Restart reconstruction, cleanup, analytics, triggers, and campaign breadth remain in the plan but may not displace this capability sequence.

Prior revision: **v1.18 (2026-07-15)** — Re-scoped the roadmap around a locally operated factory for a solo product owner or very small product team. Added live run steering, bounded GitHub/Linear/local-schedule/monitoring triggers, approved PR handoff, evidence-based analytics and evaluation promotion, and Git-versioned workflows/skills. Removed remote workers, DevHarmonics cloud hosting, enterprise workforce/IAM/compliance/secrets administration, and arbitrary email/chat-driven execution from the roadmap. Product release numbering remains unchanged.

Prior revision: **v1.17 (2026-07-15)** — Implemented DH-720's automatic multi-repository correction loop: risk-configured independent review quorums, exact repository-scoped finding assignment, per-repository fixer tasks, repository-local revalidation, changed-evidence hashing and receipt invalidation, and mandatory independent re-review. Unscoped or ambiguous findings fail closed. Product release numbering remains unchanged.

Prior revision: **v1.16 (2026-07-15)** — Reconciled the plan with Product Specification v1.8 and its canonical positioning of DevHarmonics as a local-first, provider-neutral software factory for product owners managing AI agents as development teams. Corrected the immediate recommendation to reflect that Increment 4 feature scope is implemented and Increment 5 multi-repository operation is now in progress; this does not change release numbering.

Prior revision: **v1.15 (2026-07-15)** — Corrected the Antigravity scheduler boundary: one authenticated Antigravity connection can expose Google, Anthropic, and OpenAI model vendors; Gemini and Claude/GPT quota groups retain independent cooldowns and reset windows; exhausting one group leaves the other eligible; and run receipts distinguish requested model identity from runtime-verified actual identity. The legacy `gemini` configuration key remains an internal compatibility alias only.

Earlier revision: **v1.14 (2026-07-15)** — Implemented the first DH-730 vertical slice: immutable source-backed product-intelligence snapshots over configured canonical local files, exact repository HEAD/content-hash/working-tree provenance, explicit version/release/status/maturity claim extraction, subject-aware contradiction detection, missing/unsafe/dirty-source findings, planning-context injection, and Products-page scan/readback controls. Git tags are never treated as maturity evidence. CivicCore and CivicCode are attached as the first current CivicSuite repository set, and their live snapshot identifies the CivicCore 1.2.0 versus 1.2.1 dependency conflict with cited sources. The live Observe proof also exposed and closed DH-720's reviewer first-use qualification ordering gap.

Prior revision: **v1.13 (2026-07-15)** — Implemented the first DH-720 vertical slice: exact multi-repository integration sets with one repository per task, isolated per-repository integration/task branches and worktrees, retained base/HEAD commit evidence, repository-local validators, concurrent work across repositories, serialized same-repository merges, aggregate context-only review, evidence export, and a visible run-board integration-set card. Primary checkouts remain untouched.

Prior revision: **v1.12 (2026-07-15)** — Implemented DH-710 cross-repository objective planning: explicit product/repository selection, registry-informed dependency context, affected/excluded repository impact maps, repository-scoped tasks, cross-repository integration conditions, and a fail-closed execution gate pending the first DH-720 integration-set slice.

Earlier revision: **v1.11 (2026-07-15)** — Implemented the DH-700 product/repository registry core: local checkout registration without monorepo collapse, typed repository roles/owners/dependencies/validators/governance, non-mutating Git inspection, durable branch/HEAD/remote/dirty state, and compatibility issue reporting.

Earlier revision: **v1.10 (2026-07-15)** — Implemented the DH-640 Workbench core: durable read-only project scratchpads, exact selected-model comparison, provider/model/usage attribution, visible separation from execution, and explicit provenance-preserving conversion into an objective draft without starting a run.

Earlier revision: **v1.9 (2026-07-15)** — Implemented the single-workspace DH-620 core: durable structured objective drafts, immutable plan revisions and rationale, exact-revision approval/run linkage, pre-run task/model/capacity/permission preview, and revise-or-start controls. At that revision, product/repository selection remained with the v0.6 multi-repository registry.

Earlier revision: **v1.8 (2026-07-15)** — Added Mellum2 as the first named local specialist milestone: separate Instruct/Thinking tracks, strict specialist-fidelity benchmark, bounded-tool plus benchmark scheduling gates, hard task-capability matching, a narrow low-risk economy implementation lane, live installed-model proof, and explicit no-download/no-silent-promotion policy.

Prior revision: **v1.7 (2026-07-15)** — Closed the v0.4 adaptive-workforce release gate with a successful CivicSuite acceptance run, full automated and dependency audits, a Computer Use UI/UX walkthrough, reviewer-invocation empirical observations, explicit manual tier-override evidence, cache-safe dashboard assets, and responsive cockpit fixes.

Earlier revision: **v1.6 (2026-07-14)** — Recorded workload-specific empirical profiles, validator and integration-conflict attribution, non-causal NOT READY participation evidence, observation reset/exclusion policy, established latency weighting, relative paid-model cost scoring, independent-reviewer provider preference, and expanded failure-scope fallback classification.

Earlier revision: **v1.5 (2026-07-14)** — Added the campaign-scale delivery program: stage orchestration, pilot promotion, resource-aware sharding, centralized diagnostics, review quorums, enforced command policy, verification-integrity and differential gates, regression accounting, and campaign recovery.

Earlier revision: **v1.4 (2026-07-14)** — Recorded replayable routing-score decomposition, dashboard model-selection explanations, baseline empirical model profiles, low-sample safeguards, and established-evidence routing weights.

Older revision: **v1.3 (2026-07-14)** — Recorded scheduler-time exact-model qualification, fingerprint-triggered first-use requalification, fair Codex/Claude/Gemini task selection, explicit local-reviewer override semantics, workload-aware read-only watchdogs, and the remaining empirical-profile work before the v0.4 gate can close.

Foundational revision: **v1.2 (2026-07-14)** — Recorded completion of the v0.2 cockpit and v0.3 model-fleet gates, added the enforceable Observe/evidence-review acceptance path proven on CivicSuite, and clarified the remaining v0.4 scheduler work for automatic candidate qualification and cross-provider selection.

## 1. Purpose

This plan converts the canonical product specification into an incremental engineering program. It identifies the target architecture, work packages, dependencies, release increments, validation gates, CivicSuite pilot sequence, and concrete starting backlog.

The plan is intentionally designed around two facts:

1. DevHarmonics v0.5.1 has a working subscription/local execution path, durable adaptive model fleet, verified local implementation, exact multi-repository integration foundations, and a passed CivicSuite Observe acceptance workflow.
2. Scott needs the product to become useful on real work before every long-term capability is complete.

The implementation therefore MUST evolve the current system without a big-bang rewrite. Every release increment must leave a working product, preserve durable evidence, and provide a safe rollback path.

## 2. Outcomes

The implementation is complete when DevHarmonics can:

- manage a portfolio of products and multi-repository workspaces;
- discover and qualify subscription, local, and API-backed models;
- independently select the coordinator, planner, implementors, specialists, and reviewers;
- launch as many parallel agents as the task graph and available resources safely support;
- route work based on role fit, health, quota, latency, privacy, cost, and user policy;
- continue work across provider quota exhaustion or runtime failure through qualified fallback;
- provide bounded tool access to subscription and local models;
- preserve task context, structured results, evidence, decisions, and handoffs across restarts;
- validate and independently review changes before presenting them for human approval;
- coordinate changes across multiple repositories without weakening repository-specific governance;
- expose a product-manager-oriented cockpit rather than requiring terminal supervision;
- support OpenRouter/API access as a built capability whose use remains explicitly opt-in;
- support ACP and additional runtimes through stable adapter contracts;
- prove these capabilities against bounded, increasingly difficult CivicSuite work.

## 3. Delivery strategy

### 3.1 Preserve the working spine

The following v0.1 components remain the initial production spine:

- the Node.js and TypeScript runtime;
- official CLI process invocation;
- subscription credential scrubbing;
- typed architect plans;
- dependency-aware scheduling;
- isolated Git worktrees;
- allowlisted validators;
- serial integration;
- independent final review;
- cancellation through AbortSignal;
- SQLite run persistence;
- the loopback-only local dashboard.

They will be refactored behind stable interfaces, not discarded.

### 3.2 Build vertical slices

Each release increment must deliver an end-to-end user outcome. A database-only or adapter-only phase does not count as a release unless the corresponding capability is visible, testable, documented, and recoverable.

### 3.3 Introduce complexity behind feature flags

New scheduling, local-model tools, multi-repository execution, API access, and external writes begin behind explicit capability or policy flags. Flags are removed after the replacement path has passed its release gate.

### 3.4 Separate availability from permission

A model, provider, or tool being installed does not authorize its use. Every assignment must pass:

- discovery;
- authentication or runtime readiness;
- model visibility;
- qualification for the requested role;
- current health and capacity checks;
- project and data-boundary policy;
- task-level permission checks;
- spending policy when paid APIs are involved.

### 3.5 No arbitrary agent ceiling

The scheduler will not contain a product-level maximum agent count. Effective concurrency is derived from:

- ready tasks in the dependency graph;
- user policy;
- provider concurrency and quota;
- CPU, RAM, GPU or VRAM, disk, and process capacity;
- repository integration bottlenecks;
- observed failure and contention rates.

### 3.6 Local owner-operator boundary

The control plane, ledger, scheduler, worktrees, workflows, evidence, and UI remain local. External providers and product systems are bounded integrations, not a DevHarmonics hosting layer. When the computer is off, work stops and later resumes from durable local state.

Implementation targets one product owner or a very small product team directing AI agents. Do not build remote-worker hosting, multi-tenant infrastructure, enterprise role administration, compliance administration, or centralized secrets management. Small-team support, if needed, uses explicit portable objectives, workflow revisions, evidence bundles, and delivery handoffs.

## 4. Target architecture

The target system is a local control plane with replaceable execution transports:

    Product cockpit and approval inbox
                    |
            Application service layer
                    |
      Objective planner and execution graph
                    |
      Policy-aware scheduler and capacity broker
          /             |              \
    subscription      local          API/ACP
      adapters       runtimes        adapters
          \             |              /
          model registry and qualification
                    |
      context, tools, blackboard, and results
                    |
        isolated repository workspaces
                    |
       validators, integration, and review
                    |
       durable ledger, artifacts, and events

### 4.1 Architectural boundaries

The implementation will introduce these boundaries:

| Boundary | Responsibility |
| --- | --- |
| Domain | Stable product objects and state transitions independent of providers |
| Application | Use cases such as register product, plan objective, run task, approve action, and resume run |
| Runtime | Provider connections, transports, model discovery, invocation, streaming, and cancellation |
| Scheduling | Model selection, capacity, fallback, retry, dependency readiness, and fairness |
| Context | Product constitution, repository instructions, context packs, blackboard, and handoffs |
| Tools | Typed tool contracts, permissions, side-effect classification, and invocation receipts |
| Workspace | Repository graph, worktrees, integration sets, commits, and conflict handling |
| Evidence | Checks, artifacts, reviews, verdicts, provenance, and export |
| Persistence | Versioned SQLite schema, migrations, redaction, recovery, and query projections |
| Experience | Setup, portfolio, objective composer, run board, fleet, workbench, analytics, and approvals |

### 4.2 Proposed source layout

The current files can remain while the following modules are introduced incrementally:

- src/domain: normalized entities, value objects, state machines, and policies;
- src/application: use-case services and command handlers;
- src/runtime: transport contracts and adapters for Codex, Claude, Gemini, Ollama, ACP, and OpenRouter;
- src/models: catalog, discovery, aliases, qualification, health, and capability profiles;
- src/scheduler: execution graph, routing, capacity, fallback, retry, and fairness;
- src/context: constitution, repository intelligence, context packs, token budgets, and blackboard;
- src/tools: tool registry, permission evaluation, invocation, and receipts;
- src/workspace: product, repository graph, worktrees, integration sets, and Git operations;
- src/evidence: validators, reviews, artifacts, reports, and release packages;
- src/persistence: migrations, repositories, projections, backup, and recovery;
- src/api: local HTTP API, server-sent events, request validation, and error contracts;
- src/ui: cockpit surfaces and client-side state;
- src/security: redaction, credential references, policy enforcement, and audit helpers.

The existing modules will become compatibility facades until their callers have migrated.

## 5. Core data model

The first architectural milestone is a normalized model that does not assume provider equals model or provider equals role.

### 5.1 Primary entities

- Product: a long-lived product or program such as CivicSuite.
- Workspace: one objective boundary containing one or more repositories.
- Repository: local checkout, remote identity, role, default branch, validators, and governance.
- RepositoryRelationship: dependency, shared platform, umbrella, installer, documentation, or release relationship.
- Constitution: versioned product and repository rules.
- Objective: user outcome, constraints, scope, acceptance criteria, risk, and autonomy.
- Campaign: a long-running objective delivery program with a selected migration/execution strategy and durable readiness accounting.
- CampaignStage: a versioned phase with entry criteria, allowed work, team topology, resource policy, synchronization barriers, exit evidence, and promotion authority.
- Shard: a bounded, non-overlapping partition of campaign work with resource estimates and integration ownership.
- PromotionGate: the evidence and authority decision that advances a pilot or stage.
- DiagnosticArtifact: one retained compiler, test, scanner, or runtime result that can be classified and partitioned into repair work.
- VerificationBaseline: expected tests, behavior, performance, artifacts, and platform coverage used to detect weakened evidence or regressions.
- ReviewQuorum: reviewer count, independence/diversity policy, structured findings, adjudication, fixer, and re-review state.
- RegressionBudget: accepted and observed defect, compatibility, performance, memory, unsafe-code, and platform movement.
- Plan and PlanRevision: typed task graph plus revision rationale.
- Task: bounded unit of work with dependencies, repositories, capability needs, tools, and checks.
- AgentRole: coordinator, planner, implementor, reviewer, specialist, or reporter.
- AgentInstance: one role assignment for one task or decision cycle.
- ProviderConnection: a signed-in CLI session, local runtime, ACP endpoint, or API account.
- Model: provider-neutral identity, family, release, aliases, capabilities, and context limits.
- ModelAvailability: the relationship between a connection and a model.
- ModelQualification: evidence that a model can perform a role or workload class.
- CapacityObservation: health, quota state, concurrency, latency, local resource pressure, and cooldown.
- Tool: typed capability with permissions, side effects, and receipts.
- ContextPack: reproducible set of source material given to an agent.
- BlackboardEntry: structured run state, decision, assumption, handoff, result, or unresolved issue.
- Attempt: exact agent, model, settings, context, tools, output, timing, and status.
- ResultEnvelope: structured outcome returned by an agent.
- CheckReceipt: deterministic or explicitly approved verification result.
- Review: independent assessment tied to exact commits and evidence.
- IntegrationSet: exact repository branches and commits that form a candidate result.
- Artifact: files, patches, reports, screenshots, logs, or release packages.
- Approval: requested consequential action, decision, actor, and rationale.
- Event: append-only lifecycle fact with a durable cursor.
- ReleaseCandidate: a reviewed integration set and its readiness status.

### 5.2 Required invariants

- ProviderConnection, Model, AgentRole, and AgentInstance are separate records.
- Every task attempt resolves to an exact model or a recorded unresolved provider alias.
- Every model or tool assignment records the policy and evidence used to choose it.
- Result envelopes never determine correctness; validators, repository state, reviews, and approvals do.
- A final verdict is bound to an exact integration set.
- Cancellation changes durable scheduling state even if a client stream disconnects.
- Secrets are redacted before data crosses the ledger boundary.
- A failed migration cannot leave the only ledger copy unusable.
- Cross-repository readiness is evaluated against an integration set, not the currently checked-out branches.

## 6. Work packages

Effort classes describe relative engineering breadth, not calendar commitments:

- S: bounded change with limited interfaces;
- M: multi-file feature with tests and one integration boundary;
- L: new subsystem or cross-cutting change;
- XL: multiple subsystems plus migration and end-to-end acceptance.

### 6.1 Foundation and persistence

#### DH-100: Domain kernel — L

Deliverables:

- introduce provider-neutral domain types;
- replace string status handling with validated state machines;
- define identifiers, timestamps, revisions, and policy decision records;
- retain adapters that translate the v0.1 structures into the new model.

Acceptance:

- current v0.1 orchestration tests run through the compatibility layer;
- invalid state transitions fail before persistence;
- no domain type imports provider-specific CLI argument structures.

#### DH-110: Versioned ledger and migrations — L

Deliverables:

- add schema version and ordered transactional migrations;
- create normalized tables for products, workspaces, repositories, connections, models, qualifications, capacity, plans, agent instances, blackboard entries, artifacts, approvals, and integration sets;
- preserve existing runs, tasks, attempts, checks, and events;
- add automatic backup before migration and an integrity check after migration.

Acceptance:

- a v0.1 database upgrades without data loss;
- migration interruption restores or resumes safely;
- old run summaries remain readable;
- foreign keys and integrity checks pass.

#### DH-120: Configuration v2 — M

Deliverables:

- split global application settings, provider connections, product settings, repository settings, and run policy;
- add explicit schema migration from config version 1;
- support user overrides without copying provider credentials;
- preserve the current simple project initialization path.

Acceptance:

- an existing project starts without manual config edits;
- invalid settings produce field-specific diagnostics;
- settings changes are recorded without leaking secrets.

#### DH-130: Durable event bus — M

Deliverables:

- make the ledger event table the source of durable event cursors;
- publish typed events after successful state transactions;
- support replay from a cursor;
- ensure event delivery is at-least-once and UI consumers are idempotent.

Acceptance:

- browser refresh resumes from the last event;
- duplicated delivery does not duplicate UI state;
- run execution continues when no browser is connected.

#### DH-140: Redaction and data-boundary policy — M

Deliverables:

- centralize secret and credential-pattern redaction;
- redact prompts, stdout, stderr, events, errors, and tool receipts before persistence;
- classify project content, provider-bound content, and external-write data;
- add retention and export controls.

Acceptance:

- seeded secret values never appear in SQLite, logs, exports, or UI payloads;
- redaction has unit, fuzz, and integration coverage;
- diagnostic usefulness remains sufficient to resolve failures.

### 6.2 Provider, transport, and model fleet

#### DH-200: Runtime adapter contract — L

Deliverables:

- replace the fixed ProviderAdapter contract with transport, connection, model, and invocation contracts;
- normalize structured output, streaming events, tool requests, errors, usage, and cancellation;
- retain Codex, Claude, and Gemini CLI behavior through adapters;
- record adapter and CLI versions on every attempt.

Acceptance:

- existing fake-CLI integration tests pass through the new contract;
- provider-specific capabilities remain accessible through typed extensions;
- malformed provider output produces a classified failure.

#### DH-210: Connection registry and setup diagnostics — M

Deliverables:

- discover installed runtimes and signed-in subscription connections;
- separate installed, authenticated, entitled, healthy, and capacity states;
- expose actionable setup flows for Codex, Claude, Gemini/Antigravity, Ollama, ACP, and OpenRouter;
- never request subscription passwords.

Acceptance:

- setup clearly identifies the exact failing layer;
- closing a provider terminal after completed authentication does not invalidate DevHarmonics;
- a signed-out connection cannot start a task.

#### DH-220: Live model registry — L

Deliverables:

- persist provider-neutral model identities and connection-specific availability;
- reconcile provider catalogs, signed compatibility data, runtime discovery, and empirical observations;
- retain requested identifiers, aliases, runtime-verified resolved identifiers, and an explicit unresolved state when actual execution identity is not observable;
- mark models known, visible, verified, qualified, active, degraded, or retired.

Acceptance:

- new models appear without a DevHarmonics code release when an adapter can enumerate them;
- a provider announcement alone never marks a model usable;
- every attempt receipt distinguishes the requested model from runtime-verified actual resolution; an unverified request is never presented as the model that executed.

#### DH-230: Health, quota, and cooldown manager — L

Deliverables:

- maintain a prioritized health-check queue;
- implement cached inexpensive probes;
- classify ready, slow, busy, cooling, rate-limited, quota-exhausted, incompatible, and unavailable states;
- model subscription five-hour and weekly exhaustion as observed capacity windows without pretending providers expose exact counters;
- model quota groups below connection scope, including Antigravity's independent **Gemini Models** and **Claude and GPT Models** pools;
- probe Ollama reachability, model load, context behavior, and local resource pressure.

Acceptance:

- repeated failures trigger bounded cooldown rather than probe storms;
- an exhausted connection or quota group is not repeatedly assigned new work before its observed reset;
- exhausting one Antigravity quota group does not cool its other group or the whole signed-in connection;
- health recovery automatically returns qualified capacity to the pool.

#### DH-240: Qualification harness — L

Deliverables:

- create versioned role and workload fixtures;
- test planning, implementation, review, structured output, tool use, context handling, instruction following, and speed;
- support conservative, qualified-automatic, alias-tracking, and pinned upgrade policies;
- record qualification evidence and recommendation rationale.

Acceptance:

- a newly discovered model cannot enter protected roles before policy allows it;
- qualification results are reproducible from fixture and configuration versions;
- upgrades can be accepted, deferred, or rejected by the user.

#### DH-250: Empirical capability profiles — M

Status: **Implemented and accepted in v0.4.0.** Worker attempts and reviewer invocations are sliced by exact model and workload class and include completion, first-pass success, retries, latency where retained, billed cost, malformed envelopes, classified failures, validator failures, and attempt-linked integration conflicts. NOT READY participation is retained once per run as explicitly non-causal evidence and does not penalize a model until structured reviewer findings identify a responsible task. The Models view provides uncertainty labels, workload details, observation-baseline reset, and empirical-history exclusion. Only established slices with at least 20 observations affect reliability or latency routing.

Deliverables:

- aggregate first-attempt pass rate, retry count, invalid envelopes, validator failures, review rejection, latency, context overflow, and conflict frequency by model and workload class;
- separate published capability metadata from observed performance;
- prevent sparse data from overpowering explicit policy.

Acceptance:

- the scheduler can explain how much of a score came from metadata, qualification, history, and user preference;
- low-sample profiles are visibly uncertain;
- users can reset or exclude observations.

### 6.3 Scheduling, fallback, and execution

#### DH-300: Execution graph service — L

Deliverables:

- promote the task DAG into a versioned execution graph;
- add repository scope, expected artifacts, acceptance criteria, risk, permissions, capability needs, and integration conditions;
- support bounded replanning with recorded rationale;
- represent diagnostic, repair, review, and release tasks explicitly.

Acceptance:

- every task is executable or rejected with a specific missing field;
- graph revisions preserve their predecessors;
- replanning cannot silently widen scope or permissions.

#### DH-310: Capacity broker — L

Deliverables:

- combine ready tasks, provider capacity, local resources, user policy, and integration bottlenecks;
- expose effective concurrency without a built-in agent ceiling;
- queue excess work fairly;
- apply provider and model cooldowns.

Acceptance:

- launching more implementors is limited by measured resources rather than a fixed constant;
- the broker avoids assigning more local models than GPU or RAM policy permits;
- capacity decisions are visible in the run timeline.

#### DH-320: Model-aware router — L

Deliverables:

- score eligible candidates independently for every role and task;
- support different coordinator, planner, implementor, specialist, and reviewer models;
- allow multiple workers of the same or different provider/model;
- include capability, qualification, health, quota, latency, privacy, cost, diversity, and user pins.

Refinement (2026-07-22): within a workload class, when two or more qualified candidates have **established** empirical slices (per DH-250's ≥20-observation threshold) whose success rates are at parity within the uncertainty the sample supports, prefer the cheaper candidate rather than the higher tier. External evidence (Cursor's agent-swarm study) and DH's own receipts agree that quality parity across mixes is common while cost spread is large; paying the tier premium is justified only where the empirical record does not yet show parity. Manual pins and qualification requirements still override; a parity preference never routes to an unqualified or cooling model, and the routing explanation must name parity as the reason when it decides the selection. Quality considerations (tier fit, reasoning fit, established latency, pins, provider independence) must be identical before a swap; provider-preference nudges (preferred or fallback provider) deliberately do not shield a pricier selection — with relative cost already nudging the adaptive score, a preference-protected top is precisely where the parity rule earns its keep, and guarding on preferences would make the rule unreachable (an audit proved the first version was exactly that: dead code).

Acceptance:

- the coordinator is not forced onto subagents;
- Claude, Codex, Gemini, local models, and API models can each be selected at their own available model and effort settings;
- given two qualified candidates with established slices at parity, the cheaper one is selected and the decision explanation says so;
- parity preference never overrides qualification, pins, health, or cooldown;
- the UI explains every material routing decision.

#### DH-330: Classified failure and fallback engine — L

Refinement (2026-07-18, from a real run and the independent audit of its fix): local fallback was reachable in routing and unreachable in practice. Four separate gates — objective planning, run start, the attempt loop, and both automatic-repair paths — decided whether work could proceed by looking at subscription provider health, which is not where local models live. A run whose subscription quota closed was refused before the router, the only component that considers a local model, was ever consulted.

The first fix answered the question with a predicate that checked generic model lifecycle flags. The audit proved that predicate wrong in both directions: it kept a task alive for a model qualified only as an architect, and routing then threw out of the attempt and failed the entire run; and it refused a manually assigned inactive model that the router would in fact have selected, because explicit assignment does not require `active`.

The rule this establishes: **when code needs to know whether work can run, it must ask the component that will run it.** A predicate that re-derives eligibility from underlying state is a second implementation of routing, and it will drift from the first. `ModelRouter.tryRoute` now returns a decision or a typed reason, so every gate asks the exact question execution will ask; a genuine error is still raised rather than being swallowed as "cannot route". Route failure inside a task settles that task rather than failing the run, because a cooling window can reopen.

Second refinement (2026-07-18, from the independent audit of the fix above): two further rules, both learned by getting them wrong first.

**A control action is not evidence.** Threading an abort signal into first-use qualification made interrupt and cancel real, but qualification caught every throw and turned it into a failed result. An owner interrupt was therefore persisted as a failed qualification and recorded as `incompatible`, which carries a thirty-minute cooldown — so exercising the product's own interrupt could make the only local worker ineligible for its own retry. This is the same durable misclassification that made truncated output mark capable models incompatible, re-entered through a different door. An abort now propagates on the error's own identity, judged by what the error IS rather than by which caller is asking, so a concurrent caller sharing an in-flight probe cannot record a failure for an abort it did not request.

**Refuse on the requirement, not on the proxy.** Planning genuinely requires a subscription: no local model is architect-qualified, so without one there is nothing that can produce a plan. That refusal is correct and is now documented in the code as a deliberate, narrow exception. It is narrow in a second way as well: the requirement is ONE healthy architect, so a single signed-out provider must not block planning that another healthy provider can do — refusing whenever any enabled provider was signed out was itself the overbroad form of this mistake. Everything downstream — starting an approved run, executing its tasks, repairing, and reviewing — was refusing on the same subscription facts even though an approved plan needs no architect. A signed-out subscription is now an input to routing rather than a gate in front of it. The general form: state the requirement the operation actually has, and let the component that satisfies it answer.

Third refinement (2026-07-18, after eight audit rounds closed this item GREEN): the defect pattern was not in the product, it was in how the fixes were verified. Four separate times the code was wrong AND its test was structurally incapable of noticing — a seam was injected that honoured a signal the real adapter dropped; a seam was injected that ignored a signal, so both mutations passed against it; a precondition asserted a CLI was signed out without asserting the orchestrator could see it. Every one of those tests passed. Mutation testing caught all four; a green suite caught none.

The rule this establishes, and the reason it belongs in the plan rather than in a commit message: **a test that has never been watched to fail is not evidence.** For anything guarding an invariant this product actually sells — evidence integrity, honest cancellation, local fallback — the fix is not done when the test passes. It is done when removing the production change makes that test fail by name. Where the reversion merely hangs, give the wait an explicit deadline so the contract is named rather than left to a CI watchdog.

One corollary, learned by getting it wrong: "this cannot be tested deterministically" is a conclusion to distrust. It was written into this module about the post-probe cancellation window, with the gap documented in a comment as considered judgement. The window was stageable in a few lines by scheduling the cancellation from a getter that runs while the result is read. Documenting a coverage gap honestly is better than faking coverage, and worse than closing it.

A fourth, smaller lesson worth keeping: marking a task `working` before qualification is what makes an interrupt honest, but it also means `working` no longer implies a provider invocation is in flight. Any check that meant the latter must say so — a stale precondition of exactly this kind turned into an intermittent test failure rather than an obvious one.

Deliverables:

- classify network, provider outage, rate limit, short-window quota, long-window quota, concurrency, authentication, unsupported capability, model retirement, context overflow, tool denial, validator failure, and content-policy refusal;
- choose a qualified fallback within the same subscription, another subscription, local runtime, or opt-in API pool;
- scope Antigravity capacity failures to the provider-reported Gemini or Claude/GPT quota group and honor its reset window;
- preserve the worktree, context pack, attempt history, and handoff;
- require replanning when substitution would change quality or permissions materially.

Acceptance:

- a simulated subscription quota exhaustion continues on a qualified fallback;
- simulated Antigravity Gemini-group exhaustion can continue through a qualified Claude/GPT-group model on the same connection;
- a model change is visible and reproducible;
- fallback never bypasses privacy, spending, role qualification, or approval policy.

#### DH-340: Restart, resume, and reconciliation — XL

Deliverables:

- reconcile durable state with live processes, worktrees, branches, and repositories after restart;
- classify interrupted tasks as resumable, retryable, abandoned, or awaiting approval;
- avoid duplicate commits, validators, or external writes;
- support pause, resume, retry, archive, and abandon.

Acceptance:

- terminating DevHarmonics during planning, implementation, validation, integration, and review produces a recoverable state;
- reboot recovery is tested;
- resumed execution cannot overwrite a later human change without detection.

#### DH-350: Campaign and stage orchestrator — XL

Deliverables:

- introduce Campaign, CampaignStage, Shard, PromotionGate, and synchronization-barrier state machines;
- support configurable analysis, specification, pilot, fan-out, integration, diagnostic, repair, smoke, full-validation, platform, and acceptance stages;
- record strategy alternatives including full rewrite, incremental migration, strangler, shadow, and no-change;
- checkpoint stage and shard state so restart does not repeat accepted work or consequential actions.

Acceptance:

- one objective can span multiple resumable runs without losing its stage contract;
- every stage has explicit entry, exit, evidence, resource, and authority requirements;
- the UI never presents raw task completion as campaign promotion;
- a reboot during any stage reconciles to a safe, non-duplicating state.

#### DH-360: Pilot-to-scale promotion — L

Deliverables:

- select a representative pilot slice from file, subsystem, risk, dependency, and workload evidence;
- execute the intended implement-review-fix-validate topology on the pilot;
- record quality, latency, cost, resources, failure modes, and human corrections;
- create an explicit promotion, revise, or abandon decision and version the promoted workflow.

Acceptance:

- broad fan-out cannot begin until the pilot gate passes or an authorized policy explicitly waives it;
- a failed pilot changes the campaign revision without erasing its evidence;
- promoted workflow parameters remain inspectable and reusable.

#### DH-370: Diagnostic partitioner and shard barriers — L

Deliverables:

- run expensive compiler, test, scanner, or runtime diagnostics once at controlled barriers;
- retain complete DiagnosticArtifacts and classify findings by file, subsystem, dependency, ownership, and failure class;
- create non-overlapping bounded repair shards with exact diagnostic slices;
- coordinate fan-in, integration ownership, and barrier revalidation.

Acceptance:

- workers do not independently launch prohibited shared diagnostics;
- every repair task traces to exact diagnostic findings;
- overlapping ownership is detected before parallel admission;
- revalidation uses one consistent integration snapshot.

### 6.4 Context, agents, tools, and evidence

#### DH-400: Product constitution and repository intelligence — L

Deliverables:

- ingest product rules, repository instructions, architecture, compatibility matrices, validators, ownership, and release policies;
- record source and revision for every rule;
- distinguish suite-wide rules from repository-local rules;
- detect conflicting instructions and request resolution.

Acceptance:

- a task receives every applicable rule and no unrelated repository content by default;
- conflicting governance blocks execution rather than being silently merged;
- rule changes are reflected in later context packs without rewriting old evidence.

#### DH-410: Context assembler and token budgets — L

Deliverables:

- build role-specific, task-specific context packs;
- reserve space for objective, constraints, task, response contract, and recent failures;
- summarize or omit lower-priority material;
- adapt to exact model context limits and modalities;
- retain reproducible references to source material.

Acceptance:

- context overflow is prevented or classified before destructive retries;
- reviewers receive evidence rather than implementor narration;
- context packs can be inspected and exported.

#### DH-420: Shared run blackboard — M

Deliverables:

- persist decisions, assumptions, findings, changed dependencies, risks, handoffs, and unresolved questions as structured entries;
- project only role-relevant entries into each context pack;
- prevent blackboard content from becoming an unbounded transcript.

Acceptance:

- a fallback worker can continue from a predecessor without replaying the full conversation;
- contradictory entries remain attributable and resolvable;
- restart does not erase handoff state.

#### DH-430: Structured result envelopes — M

Deliverables:

- define role-specific schemas for planners, implementors, reviewers, specialists, and reporters;
- include artifacts changed, assumptions, unresolved issues, requested tools, checks believed necessary, failures, next action, and completion claim;
- validate and retry malformed envelopes without treating the self-report as truth.

Acceptance:

- every agent role returns a schema-valid result or a classified adapter failure;
- malformed results affect empirical model scoring;
- repository state and validation remain authoritative.

#### DH-440: Tool registry and policy engine — XL

Deliverables:

- register local commands, validators, MCP tools, provider-native tools, browser/computer use, Git, GitHub, issue systems, and reusable workflows;
- specify input/output schema, trust level, permissions, side effects, secrets policy, and receipt requirements;
- evaluate tool requests against task scope and autonomy;
- enforce stage-specific command allow/deny policy outside prompts, including destructive and cross-worktree Git operations;
- classify expensive and exclusive commands, acquire repository/resource locks, and retain denied attempts;
- provide human approval for consequential actions.

Acceptance:

- agents see only tools allowed for their role and task;
- tool invocations are typed and receipted;
- prompt instructions cannot bypass a denied command or exclusive-operation lock;
- external writes, installs, signing, publishing, deployment, spending, and destructive operations require appropriate approval.

#### DH-450: Evidence center and immutable Run Reporter — L

Deliverables:

- collect commits, diffs, checks, artifacts, screenshots, reviews, decisions, and approvals;
- bind final review to an exact integration set;
- create a read-only Run Reporter that explains outcomes without modifying the verdict or repository;
- export a portable evidence package.

Acceptance:

- the same evidence produces the same displayed verdict;
- the reporter cannot edit technical evidence;
- missing or inconclusive evidence remains visible.

#### DH-460: Adversarial review quorum and fixer loop — L

Refinement (2026-07-18, from observed evidence): reviewer independence must be graded by **capability**, not only by provider or model diversity. DH-635's review produced a direct comparison. Fifteen same-family reviewers reading the diff, each with an independent verification pass, raised ten findings of which nine were real — and missed both critical defects. A single different-vendor reviewer with execution access found both, because it did things reading cannot do: it extracted a disputed loop calculation into a standalone script and ran it to show an interrupt could widen a task's invocation budget; it wrote direct ledger probes and drove a live dashboard over HTTP to reproduce directives that stayed pending forever; and it reverted a fix inside a disposable worktree to demonstrate that the accompanying tests stayed green, proving they could not fail.

Reviewer capability therefore has three distinct tiers, and the ledger should record which tier produced each review rather than treating all independent reviewers as equivalent:

1. **Context review** — reads the task contract, diff, and evidence. What DevHarmonics performs today. Finds contradictions, missing cases, and unsupported claims.
2. **Executing review** — additionally builds and runs the candidate, runs its checks, and writes fresh probes against it. Distinguishes what the code claims from what it does.
3. **Falsifying review** — additionally mutates the candidate to test whether its own verification can fail, and reports any guard whose removal leaves the suite green.

A tier-1 reviewer cannot substitute for tier 3 no matter how many of them are convened, because the failure they miss is a property of the evidence rather than of the code. Quorum policy should express a required tier by risk — high-risk and release-boundary work requiring a falsifying reviewer — and a quorum satisfied only by tier-1 reviewers must be reported as such rather than as a passed independent review. This also constrains scheduling: a falsifying reviewer needs an isolated worktree, a build, and the ability to run and revert, which is a materially different resource profile from a read-only context reviewer.

Second refinement (2026-07-22): reviewer decorrelation has a second axis — the **evidence lens**, what a reviewer is shown, orthogonal to capability. Every current reviewer receives the same bundle, and that bundle includes the implementors' task reports, so worker narration can anchor every reviewer's reading of the artifact at once; reviewers that share one bundle share one blind spot. Two lenses are distinguished:

1. **Artifact lens** — task contracts, integrated diff, check receipts, repository state; **no implementor narration**. Judges what exists. (This finally implements DH-410's "reviewers receive evidence rather than implementor narration" at the review boundary.)
2. **Claims lens** — task contracts, implementor envelopes and reports, check receipts; **no diff or worktree access**. Its duty is to extract the concrete claims made — files changed, behaviors added, checks run — into a structured **claimed-changes manifest**, and to judge whether the claims cohere and are backed by named receipts.

The manifest is then compared mechanically against the integrated diff: a claimed file change absent from the diff, or a diff change no task claimed, is a fail-closed **divergence finding** requiring disposition before quorum can pass. (This increment implements the mechanical comparison for single-repository integrations, where claim paths and diff paths share one grammar; multi-repository path mapping — reports do not reliably carry repository prefixes — is deliberately deferred to the item-5 cross-repository rerun that proves this machinery. A multi-repository quorum still enforces lens coverage and the manifest requirement.) This generalizes the defect-#22 rule (a write task that changed nothing does not pass): narration without artifacts is caught even when other tasks' diffs make the integration nonempty, and it is caught deterministically rather than depending on a reviewer noticing. Lens coverage becomes a quorum dimension by risk alongside count, provider diversity, implementor independence, and capability tier; a quorum whose reviews all shared one lens is reported as single-lens, not as a decorrelated review.

The claims lens's isolation is enforced at three layers, none of them prompt wording: a fresh empty working directory that is never an ancestor of any worktree; a per-invocation tool shutdown passed to the adapter (Claude Code: an empty built-in tool set via `--tools ""`, ambient MCP rejected via `--strict-mcp-config`, ordinary customization — plugins, hooks, skills — disabled via `--safe-mode`; an enumerated deny list is not a closed set; tool-less transports trivially comply); and — because an adapter that cannot deny its tools cannot be constrained — claims-lens review slots route only to adapters with that capability. **Stated boundary:** Claude Code's admin-managed POLICY settings survive `--safe-mode` — policy-configured hooks still run — and managed policy can arrive through tiers no client can enumerate (server-managed settings, MDM), so neither argv nor a filesystem check can prove its absence. Claude is therefore admitted to claims slots only when BOTH hold: the OWNER has explicitly attested in configuration (`reviewPolicy.attestNoManagedClaudePolicy`, default false — fail closed) that no managed Claude policy governs the machine, AND the client-visible delivery mechanisms (base managed-settings.json, managed-settings.d drop-ins, and on Windows the HKLM/HKCU Policies registry keys) are checked clear at slot time as defense in depth. `--bare` is additionally passed (its help: skip hooks, plugin sync, auto-memory, CLAUDE.md discovery) as belt-and-suspenders, not as the proof. Follow-on recorded for DH-240: the qualification harness should prove the shutdown against the REAL installed CLI — keyed to BOTH the CLI fingerprint and the effective policy/configuration fingerprint — with an auto-run hook sentinel and an ambient MCP/tool sentinel that a claims invocation must provably neither see nor trigger, so the capability map's claims are re-verified whenever the CLI or its policy environment changes (Codex CLI's sandbox modes govern writes rather than read scope, and Gemini's directory boundary is undemonstrated; both are excluded until proven by execution). A configuration whose eligible reviewer fleet has no denial-capable adapter fails the claims slot as reviewer-unavailable rather than degrading. Follow-on recorded here: policies can still be arithmetically satisfiable yet impossible for the CURRENT fleet (provider minimums above the number of eligible qualified reviewer providers, independence with no non-implementor left); run admission should diagnose the concrete unsatisfied fleet requirement before work begins rather than failing at review time.

Observe runs are the stated exception to the claims lens's no-repository rule: an observe run produces no artifact diff, its reports ARE the review subject, and the citation duty requires inspecting the repository the reports cite — so an observe reviewer keeps read-only repository access, its receipt still records the claims lens (what it reviewed), and it is not required to return a claimed-changes manifest (there are no changes to claim). The boundary the lens enforces — implementor narration must not anchor the artifact judgment — has no artifact to protect on an observe run.

Deliverables:

- configure reviewer count, independence, provider/model diversity, **required reviewer capability tier**, and required expertise by risk;
- record the capability tier and the evidence each reviewer actually produced (commands run, probes written, mutations attempted) on the review receipt;
- report a quorum met only by context reviewers as an unfalsified result rather than a passed independent review;
- provide reviewers the task contract, diff, relevant source, and evidence without inheriting implementor reasoning as fact;
- configure required lens coverage by risk, assign each review slot a lens, and record the lens on the review receipt;
- build lens-specific evidence bundles — the artifact lens excludes implementor narration, the claims lens excludes the artifact — and require the claims lens to return a structured claimed-changes manifest;
- cross-check the claimed-changes manifest against the integrated diff deterministically and fail closed on divergence;
- normalize findings with severity, location, rationale, suggested correction, and disposition;
- adjudicate disagreements, assign an independent fixer, and require bounded re-review after changes.

Acceptance:

- high-risk tasks can require two or more independent passing reviews;
- a reviewer cannot silently review its own unqualified work;
- an artifact-lens bundle contains no implementor narration and a claims-lens bundle contains no diff, proven by tests on the assembled bundles rather than on prompt wording;
- a run whose implementors claim changes the integrated diff does not contain fails with a divergence finding even when the diff is nonempty;
- a quorum satisfied by a single lens is reported as single-lens;
- conflicting findings remain visible until resolved or explicitly accepted;
- fixer changes invalidate prior review receipts and trigger the configured re-review gate.

#### DH-470: Verification-integrity and anti-shortcut gates — XL

Refinement (2026-07-18, from a real run): a read-only diagnostic produces no repository change, so validators have nothing to judge and the report's own citations become the evidence. Those citations were only ever checked for shape — a regex confirmed something resembling `file.ext:12` was present — so a worker that invents well-formed citations passed. During the item-4 proving run a local model produced five reports citing files that do not exist, a line whose real content is unrelated, and a version string absent from the repository entirely; all five tasks recorded `passed read-only verification`. Only the independent reviewer caught it, and only because it re-inspected the repository itself rather than reading the reports.

Citations are checkable facts and are now verified mechanically: each cited path must exist inside the assigned worktree and the cited line must exist within it. This is deterministic, needs no model, and costs milliseconds. Two consequences are recorded rather than assumed. First, verification establishes that a citation *resolves*, not that the cited line supports the conclusion drawn from it — that remains a review question, and a report citing a real line with misattributed content still verifies. Second — closed 2026-07-19 — a report containing no citations at all used to have none to reject, because the gate only demanded line evidence when a task's acceptance criteria asked for it. Every read-only diagnostic now requires at least one verifiable citation regardless of criteria phrasing: its citations are its evidence, and a report grounded in nothing is not a diagnostic. The reviewer prompts additionally state the division of labour outright — the mechanical gate proves cited lines exist, and judging whether they SUPPORT the conclusions drawn from them is the reviewer's duty, with a real-but-unsupporting citation named a finding.

Second refinement (2026-07-18, from an independent audit of the fix): the first version of this verification could be bypassed by writing the evidence a different way. The verifier had its own citation grammar, narrower than the one the evidence gate accepts, so `[missing.md](missing.md), line 2` satisfied the gate and produced nothing for the verifier to check. Range ends were discarded, an empty file counted as having one line, `../` traversal was silently normalized away, and a legitimate absolute path inside the worktree was rejected outright.

The rule this establishes: **a gate and its verifier must share one grammar.** Two independent implementations of "what counts as evidence" will diverge, and the gap between them is the hole. Both now call the same extractor, containment is decided once on the canonical target so a symlink cannot point out of the worktree, and each of these behaviours was proven load-bearing by reverting it and watching a test fail.

The wider lesson for this milestone: where a workflow produces no artefact to validate, evidence integrity depends entirely on the report and the reviewer, and a context-only reviewer reading a plausible, well-formatted fabrication is unlikely to catch it. This is the same capability distinction recorded in DH-460.


Deliverables:

- capture expected-versus-actual test census, selection filters, skips, coverage, and changed test files;
- detect deleted or weakened tests, disabled checks, stubs, placeholders, unconditional success, swallowed errors, unjustified unsafe operations, and scope-reducing workarounds where practical;
- retain findings as evidence without pretending heuristic signals prove correctness;
- prevent a green validator from satisfying a gate when material verification evidence disappeared.

Acceptance:

- fixtures that delete tests, filter discovery, weaken assertions, or stub failing code fail closed;
- legitimate test changes can be approved with rationale and replacement evidence;
- the evidence center distinguishes test results from test-integrity results.

#### DH-480: Differential validation and regression accounting — XL

Deliverables:

- define VerificationBaselines and behavioral oracles for ports, migrations, rewrites, and replacements;
- compare outputs, errors, side effects, files, logs, performance, memory, and platform behavior;
- turn unexplained mismatches into bounded repair tasks;
- track defects fixed, regressions introduced, incompatibilities, unsafe/provisional code, platform coverage, costs, and interventions against a RegressionBudget.

Acceptance:

- equivalent inputs can be replayed against old and new implementations reproducibly;
- intentional differences require an approved recorded rationale;
- readiness cannot hide regressions behind aggregate passing-test counts;
- faithful translation and later idiomatic cleanup can be managed as separate campaigns.

### 6.5 Local models

#### DH-500: Ollama runtime adapter — L

Status: **Core adapter complete; Mellum2 named-specialist profile implemented in the v0.5 development line.**

Deliverables:

- discover the Ollama server and installed models;
- query model metadata, context limits, templates, and capabilities;
- invoke chat and structured-output modes;
- stream events and cancel requests;
- support configurable remote Ollama only under explicit policy.

Acceptance:

- installed Gemma and Qwen variants appear as separate model candidates;
- installed Mellum2 Instruct and Thinking variants appear as separate exact-model tracking families and preserve runtime metadata;
- the user can pin or exclude each model;
- local inference works without cloud credentials.

#### DH-510: Local-model tool execution — XL

Status: **Bounded read/search/hash-checked-patch loop, permission-specific qualification, and Mellum2 specialist benchmark implemented in the v0.5 development line; live acceptance and release gate remain.**

Deliverables:

- expose approved file, search, patch, Git, and validator tools through DevHarmonics rather than unrestricted shell access;
- execute tools only inside the assigned worktree and path scope;
- loop tool results back through the model adapter;
- enforce command allowlists, timeouts, output limits, and receipts.

Acceptance:

- a qualified local model completes a bounded code change and validator cycle;
- Mellum2 requires both current bounded-tool evidence and the structured-output/contradiction/requirement-count specialist benchmark before scheduling;
- narrow low-risk work may select qualified Mellum2 Instruct, while standard/high-risk work and Mellum2 Thinking remain independently tiered and qualified;
- path traversal, unrestricted shell, and out-of-scope writes are blocked;
- DevHarmonics, not the model, controls commit and integration.

#### DH-520: Local resource broker — M

Deliverables:

- observe RAM, GPU or VRAM where available, model load, queue depth, and latency;
- observe disk, CPU, process count, worktree/artifact growth, and expensive or exclusive command occupancy;
- choose safe local concurrency and model eviction policy;
- forecast campaign shard pressure, stop admission, reduce concurrency, or request cleanup before host exhaustion;
- let users reserve resources for normal workstation use.

Acceptance:

- resource pressure queues or reroutes work instead of destabilizing the machine;
- decisions remain user-configurable;
- unsupported GPU telemetry degrades gracefully.
- simulated disk, memory, process, and VRAM pressure pauses admission before the host becomes unstable.

### 6.6 Product cockpit

#### DH-600: Application shell and navigation — L

Deliverables:

- implement Portfolio, Setup, Models, Runs, Campaigns, Workbench, Analytics, Settings, Evidence, and Approvals surfaces;
- preserve keyboard navigation, screen-reader semantics, responsive layout, and non-color status cues;
- distinguish configuration concepts from live run concepts.

Acceptance:

- a new user can reach a verified first run without terminal guesswork;
- provider connections and models are separate in both terminology and UI;
- every status has plain-language meaning and technical detail.

#### DH-610: Setup and model fleet — L

Deliverables:

- guided provider installation and authentication;
- special Antigravity code-paste and first-run sequence;
- Ollama discovery and model management;
- model qualification, pins, exclusions, aliases, and upgrade recommendations;
- API credential setup through operating-system secure storage.

Acceptance:

- setup never asks DevHarmonics to receive subscription passwords;
- the user can tell whether a failure is installation, authentication, entitlement, model availability, health, capacity, or policy;
- OpenRouter remains unusable until explicitly enabled and configured.

#### DH-620: Objective composer and plan approval — M

Status: **Single-workspace core implemented in the v0.5 development line.** Structured drafts are saved without starting a run; planning produces immutable revisions with rationale and previews task scope, permissions, checks, proposed assignments, and capacity. Execution links to and uses the exact approved revision without replanning. Product/repository pickers remain dependent on DH-700 in v0.6.

Deliverables:

- select product/workspace and repositories;
- capture outcome, acceptance criteria, constraints, risk, autonomy, deadlines, and policy;
- preview task graph, repository impact, model assignments, tools, checks, and estimated capacity;
- approve or revise before execution.

Acceptance:

- ambiguous objectives can be refined without starting a run;
- consequential permissions are explicit;
- approved plans are versioned and reproducible.

#### DH-630: Live run board and SSE — L

Deliverables:

- persisted server-sent events with cursor reconnection;
- task dependency graph, active agents, capacity, quota, retries, model changes, checks, and approvals;
- true pause, cancel, resume, and retry controls;
- task, attempt, context, tool, and receipt detail drawers.

Acceptance:

- refresh or transient disconnect does not lose progress;
- Cancel affects the scheduler and active processes rather than only the browser stream;
- the run board does not rely on polling for active updates.

#### DH-632: Visible operation feedback — M

Status: **First wave implemented in the v0.6 development line and proven against the first real CivicSuite run.** All dashboard-initiated actions acknowledge through one shared helper (disabled control, `aria-busy`, busy label, honest indeterminate spinner, explicit done/failed end states with the failure reason routed to the surface-local error area). A global activity strip — a polite live region fixed to the shell — keeps active run tasks and local operations visible across screen changes with the responsible provider/model identity, evidence-based elapsed time, and a "quiet for…" last-activity warning for long provider calls. Task cards carry the same elapsed/heartbeat feedback reconstructed from durable ledger events, so refresh/reconnection rebuilds live-state truthfully; a page-local request that died with its page is honestly absent rather than faked. Reduced-motion preferences disable the spinner animation. Progress bars remain deliberately unimplemented until a real stage sequence or completed/total measure exists. Remaining scope: per-stage lifecycle detail (implementing → validating → merging → reviewing) on cards, waiting-for-capacity/waiting-for-approval distinct visual states, and feedback for exports/settings surfaces not yet exercised by a real workflow.

Deliverables:

- a shared operation-state model for queued, starting, running, waiting-for-capacity, waiting-for-approval, retrying, blocked, stalled, succeeded, failed, and cancelled work;
- immediate per-control acknowledgement with disabled/stateful controls, concise status text, accessible busy state, and an appropriate spinner for indeterminate work;
- a global activity surface that keeps background operations visible when the user changes screens;
- meaningful stage, elapsed-time, latest-activity, responsible agent/model/provider, and heartbeat or last-update feedback for long operations;
- durable reconstruction of operation state from ledger events and receipts after navigation, browser refresh, reconnect, or restart where the underlying workflow itself is restart-capable;
- evidence-based progress bars only where a real stage sequence, completed/total count, or provider-reported measure exists; otherwise use an honest indeterminate state;
- explicit success, failure, cancellation, timeout/stall, retry, recovery, and evidence-link end states; and
- accessible live regions, keyboard behavior, contrast, and reduced-motion support.

Acceptance:

- every DevHarmonics-owned action acknowledges the initiating input immediately and never leaves a clickable control appearing inert;
- an operation lasting more than a moment shows what is happening, how long it has been active, and when meaningful activity was last observed;
- the user can distinguish active work from waiting, retrying, disconnected, stalled, failed, and completed work without reading a terminal;
- changing screens or refreshing does not hide or falsely reset an active operation;
- progress bars and percentages are backed by retained measurable evidence and never inferred from elapsed time;
- failures and stalls provide a visible reason and a safe next action;
- feedback is present for provider/catalog/model operations, Workbench, repository scans, planning, execution, validation, review/repair, delivery, exports, and settings changes; and
- external work outside the DevHarmonics control plane is not presented as DevHarmonics activity.

Implementation rule: DH-632 is not a later cleanup phase. The first real CivicSuite implementation must include feedback for every operation and state it exercises, and each subsequent capability must extend this shared contract before that capability is accepted.

#### DH-635: Live run steering — L

Status: **Implemented in the v0.6 development line.** Steering directives are durable evidence carrying actor, target, payload, disposition, and disposition reason; attempt-steering directives (clarify, interrupt) also record the exact attempt they steered, while admission-state directives (hold, resume, reprioritise, reassign) link a task because no attempt exists when they apply; a newer directive supersedes a still-pending peer of the same kind and target, and terminal runs refuse steering. The scheduler resolves admission-scoped directives (hold, resume, reprioritise, reassign) at the task-admission boundary in both the single- and multi-repository loops, against the dependency-satisfied ready queue — so reordering cannot start blocked work — and fails closed with a reason when a directive names something inadmissible. Clarifications are consumed at the attempt boundary into worker feedback. An interrupt stops one attempt through a per-attempt abort chained to the run signal, retains the partial attempt and a handoff entry as evidence, and continues in a new attributed attempt; DevHarmonics never claims to inject direction into a response already in flight. Containment is structural rather than a semantic filter: the payload schema has no permission, risk, acceptance-criteria, repository-scope, or run-policy fields, and an interrupted attempt consumes one attempt from the single approved retry budget — steering adds no attempts, so it cannot increase the provider invocations or paid spend a task may make. Directives are validated and inserted in one transaction against live run and task state, and a task reaching a terminal status dispositions its outstanding direction in that same transition — so both interleavings are closed: direction recorded just before a task finishes is rejected when it finishes, and direction attempted after it is refused on submission. The same applies when a task is blocked by a failed dependency or the run is cancelled, terminalised, or paused. Which run and task states are steerable is one rule owned by the ledger and served to the browser, rather than duplicated per layer.

Remaining scope: reassignment validates provider eligibility for the run, with exact-model qualification still enforced downstream at task start rather than at directive submission, and the payload's `modelId` field is not yet honoured — exact-model steering is not supported. Steering also has no DOM-level automated test harness: the panel's interrupt affordance and disposition rendering are covered by API-level state tests plus a live browser walkthrough, and a source-assertion-only approach has already been shown insufficient here, so UI behaviour changes need the walkthrough until a harness exists.

Deliverables:

- pause new task admission while retaining active state and evidence;
- redirect, reprioritize, or reassign queued tasks;
- interrupt an active invocation and start an attributed continuation attempt with updated direction when provider-native steering is unavailable;
- apply clarifications and constraints only at safe task/attempt boundaries;
- show pending, applied, policy-rejected, and superseded steering instructions;
- prohibit steering from silently widening scope, permissions, spending, deployment authority, or acceptance criteria.

Acceptance:

- a user can redirect a live run without editing an agent terminal or losing completed evidence;
- unsupported mid-response injection becomes an explicit interrupt-and-handoff rather than a false steering claim;
- every steering action has an actor, timestamp, target, and a terminal disposition — no directive may remain pending once no execution path for it exists;
- attempt-steering directives (clarify, interrupt) additionally link the exact attempt they steered. Admission-state directives (hold, resume, reprioritise, reassign) act at the admission boundary and link a task rather than an attempt, because no attempt exists at the moment they are applied.

#### DH-640: Workbench — M

Status: **Core implemented in the v0.5 development line.** Workbench sessions and attributed consultation results persist across restarts; the user can compare exact active qualified models under read-only runtime permission and explicitly convert the retained discussion into a linked objective draft. Conversion creates no plan or run, and paid API models remain subject to project spending policy.

Deliverables:

- non-mutating project scratchpad for questions, comparison, draft planning, and model consultation;
- explicit conversion of a Workbench discussion into a proposed objective;
- visible separation from verified execution.

Acceptance:

- Workbench interaction cannot silently change a repository;
- converted objectives retain source context without inheriting unapproved actions;
- users can compare selected models.

#### DH-645: Approval inbox and program status — M

Status: **Named work package, owner-approved 2026-07-18. Scheduled immediately after the locked capability sequence; it does not displace any sequence item.**

The target architecture names a "product cockpit and approval inbox" as the top layer, and `Approval` is a primary domain entity, but no inbox exists. Every surface today is scoped to one run, so an owner learns that something needs them only by opening the right run — or by being told. The first real CivicSuite delivery demonstrated the gap concretely: a READY run held a prepared delivery awaiting the owner's external-write approval, and nothing in the product surfaced it. For a product whose thesis is that the owner directs a crew and owns the consequential decisions, the owner having no queue of decisions is a structural gap rather than a missing convenience.

An important boundary distinguishes this from a general dashboard. DevHarmonics' own ledger is written by the system being observed, so a status view sourced only from it can restate what DevHarmonics believes and cannot detect where that belief is wrong. The distinctive contribution is therefore not activity display but **reconciliation**: DevHarmonics is the only component holding both the local run record and the external result of what it delivered, and disagreement between them is the signal worth surfacing.

Deliverables:

- an approval inbox listing every decision genuinely waiting on the owner — plan approvals, external-write and draft-PR approvals, paid-spend confirmations, blocked runs awaiting direction — with the exact evidence each decision rests on and a direct route to act;
- a program view spanning products and runs rather than one run, distinguishing work that is moving from work that is waiting, retrying, stalled, or finished, using the DH-632 heartbeat evidence at program scope;
- delivered-versus-observed reconciliation for external results DevHarmonics produced: whether a pushed branch still exists at the reviewed commit, whether a draft pull request is still open, and whether its checks passed, with disagreement between the ledger and the observed remote state reported as an explicit finding rather than silently reconciled;
- an exportable standalone status page that reads the external forge directly in the owner's browser and does not depend on DevHarmonics running or on the DevHarmonics ledger, so that the owner retains an independent view of delivered work when the control plane is off.

Acceptance:

- an owner can see, without opening a run, every decision waiting on them and what each one would authorise;
- an approval acted on from the inbox is indistinguishable in evidence and policy from the same approval given in its run surface — the inbox is a route to the decision, never a second, weaker gate;
- an item leaves the inbox only when it is genuinely resolved, and an expired or superseded request states which;
- a delivered result whose remote state has diverged — branch deleted, pull request closed, checks failed — is reported as a divergence, and DevHarmonics never presents its own ledger record as confirmation of external state it has not observed;
- the exported status page renders correct current information with DevHarmonics stopped, and contains no value written by an agent.

#### DH-647: Decision records and comparative option analysis — M

Status: **Named work package, owner-approved 2026-07-18. Scheduled with DH-645, after the locked capability sequence.**

DevHarmonics records what was done and can prove it, but it cannot record what was **considered and rejected, and why**. The blackboard holds decisions and assumptions for the life of a run; the constitution holds standing rules. Neither retains the shape of a choice: the options weighed, the constraint that decided it, and the alternatives killed with their reasons. An approach rejected for a good reason in one run is therefore re-proposed in the next, and the second attempt has no way to know the first ever happened.

This is not hypothetical. A container runtime was selected for this machine on evidence, with its gotchas recorded, and eight days later the same decision was made again from scratch — reaching a defensible answer by defaulting rather than comparing, duplicating a tool that was already installed, and accepting a worse isolation posture that the original decision had specifically avoided. The original record existed; nothing pointed at it, so nothing loaded it.

The failure generalises beyond tooling. Any long-running product accumulates rejected designs, and an agent crew that cannot see them will re-litigate them at full cost every time, while presenting each rediscovery as fresh analysis.

Deliverables:

- a durable DecisionRecord entity holding the question, the options considered, the deciding constraint, the selected option, each rejected option **with the reason it was rejected**, the evidence relied on, the accepted cost of the choice, and its scope (run, product, or machine);
- records that outlive the run that produced them, are attached to the product rather than to a single execution, and are surfaced into planning context so an architect proposing an approach sees whether that approach was already killed and why;
- explicit supersession: a later decision links to the one it replaces and states what changed, so the trail reads as one history rather than contradicting notes;
- a planning-time obligation for consequential choices — introducing a dependency, selecting a runtime or transport, choosing between architectures — to state the options weighed and the deciding constraint before the work is approved, so the comparison is a plan input rather than a retrospective justification;
- retrieval by subject rather than only by run, since the reader is usually asking "has this been decided before?" without knowing which run decided it.

Acceptance:

- a rejected approach cannot be silently re-proposed: planning context for an objective surfaces prior decisions on the same subject, including rejections, with their reasons;
- a decision record states what it gave up, not only what it chose;
- superseding a decision preserves the original and its reasoning rather than overwriting it;
- a consequential choice made without recorded alternatives is visible as such, rather than being indistinguishable from one that was properly compared;
- decision records survive restarts and are included in the exported evidence package.

#### DH-650: Analytics — M

Deliverables:

- model and role performance;
- latency, retries, validator outcomes, fallback history, quota and cooldown behavior;
- local-versus-subscription-versus-API workload;
- human intervention, review rejection, duplicated work, and critical-path idle time;
- a per-run **cost counterfactual**: the run's actual billed cost beside what the same invocation volume would have cost on the priciest qualified candidate per role, computed from ledger receipts and catalog unit prices — the stratification saving made visible per run.

Acceptance:

- analytics use ledger evidence rather than provider self-report;
- the counterfactual is labeled an estimate, names the comparison model per role, and shows nothing when catalog prices are unknown rather than inventing a number;
- low-sample uncertainty is visible;
- reports can be filtered by product, repository, role, model, and time.

#### DH-660: Evaluation and improvement loop — L

Deliverables:

- versioned evaluation fixtures and representative historical workloads;
- comparable workflow, prompt, routing-policy, skill, and model experiments;
- promotion recommendations backed by quality, latency, intervention, fallback, and regression evidence;
- exact API cost when observable and clearly labeled subscription/equivalent-cost estimates otherwise;
- reversible promotion records that retain the prior configuration.

Acceptance:

- evaluations cannot rewrite their own fixtures, validators, or pass criteria during the evaluated run;
- a candidate improvement is never silently promoted from model self-report or one successful example;
- historical runs retain the exact workflow, skill, prompt, model, policy, and fixture revisions used.

### 6.7 Multi-repository products and CivicSuite

#### DH-700: Product and repository registry — L

Status: **Core implemented in the v0.5 development line as the first v0.6 vertical slice.** Products can retain independent remote and local repositories with roles, owners, dependency IDs, validator mappings, governance sources/rules, and expected branches. Read-only Git inspection records branch, HEAD, origin, dirty state, and compatibility issues. CivicSuite's observed remote inventory remains intact while local checkouts can be attached incrementally. DH-710 now consumes this registry during objective planning.

Deliverables:

- register multiple products and local repositories;
- map remotes, branches, roles, ownership, dependencies, validators, and governance;
- support umbrella, shared-platform, module, desktop, installer, documentation, and release-truth repository roles;
- detect dirty worktrees and incompatible local state.

Acceptance:

- CivicSuite can be represented without collapsing its repositories into a monorepo;
- repository-local rules remain authoritative;
- a product health view shows missing, stale, dirty, or incompatible repositories.

#### DH-710: Cross-repository planning — L

Status: **Implemented in the v0.5 development line.** The objective composer can target a registered product and selected repositories. Read-only planning expands the relevant registry context, records affected or excluded repositories with rationale, scopes tasks to repository IDs, and requires integration conditions for multi-repository plans. Planning creates no run. The first DH-720 slice can now execute a supported multi-repository plan when every affected repository has a compatible local checkout, every task targets exactly one affected repository, and explicit integration conditions are present.

Deliverables:

- let an objective target several repositories;
- analyze dependency and compatibility impact;
- create repository-scoped tasks and cross-repository integration conditions;
- preserve separate branch and review boundaries.

Acceptance:

- plans identify every affected repository or state why it is excluded;
- shared-platform changes identify dependent modules;
- documentation, version, installer, and release impacts are explicit tasks rather than afterthoughts.

#### DH-720: Integration sets — XL

Status: **Automatic fixer/re-review and configured review quorums implemented in the v0.5 development line; milestone remains in progress.** A supported approved plan creates an exact integration set across compatible local repositories. Each repository receives its own run integration branch and worktree pinned to a retained base commit; each task targets one repository and receives its own branch/worktree. Tasks in different repositories may run concurrently, while merges targeting the same repository use that repository's serialized merge queue. Repository-local validators and verification-integrity checks run against each integration branch. Final review is read-only and context-only across aggregate, repository-prefixed diff evidence and must satisfy the risk-configured reviewer count, distinct-provider, and implementor-independence rules. Blocking findings are assigned only by an exact repository-ID path prefix. DevHarmonics creates repository-scoped fixer tasks, revalidates the affected integration branches, requires the reviewed evidence hash to change, invalidates superseded review receipts while retaining their history, and runs a fresh independent quorum. Unscoped or ambiguous findings fail closed. The ledger, evidence export, API, and run-board card retain every repository's base commit, integration HEAD, branch, worktree, status, error, integration conditions, fixer tasks, and review receipts. The registered primary checkouts are not checked out, merged, reset, or otherwise changed.

Still deferred: restart/resume reconstruction, automatic worktree cleanup, pushing branches or opening pull requests, and a single task mutating more than one repository.

Deliverables:

- maintain one worktree and branch per task and repository;
- create an exact multi-repository integration set;
- serialize same-branch integration while allowing independent repositories to progress concurrently;
- validate combined compatibility and produce per-repository delivery branches.

Acceptance:

- readiness references exact commits in every repository;
- a failure in one repository does not corrupt the others;
- conflict repair is bounded, reviewable, and never silently destructive.

#### DH-730: CivicSuite repository intelligence — L

Status: **First vertical slice implemented and proven on the v0.5 development line; milestone remains in progress.** Products can now retain immutable, source-backed intelligence snapshots over each local repository's configured canonical sources. Every readable source retains the repository ID, exact HEAD revision, tracked blob identity when available, SHA-256 content hash, and working-tree status. Only explicit, subject-aware version, release, status, maturity, and tier claims enter the snapshot; contradictions cite exact repository paths and lines. Missing, unreadable, unsafe, symlink-escaping, oversized, binary, and dirty sources fail visibly. The latest bounded claims/findings enter cross-repository planning context, and the Products view exposes scan status, counts, conflicts, unavailable evidence, citations, and snapshot identity. Tags are not scanned and cannot become maturity evidence.

The first current CivicSuite set attaches `civiccore` as the shared platform and `civiccode` as a dependent module without changing either checkout. The retained snapshot over nine configured canonical files identifies one actionable compatibility conflict: CivicCode pins and documents CivicCore 1.2.0 while CivicCore's current `pyproject.toml` declares 1.2.1. The stale umbrella checkout remains deliberately excluded until refreshed.

The source-backed snapshot then informed real Observe run `5f70b82c-0e18-4d5e-8d61-da7d3e05c89d`. The run closed honestly as **NOT READY**: Gemini exhausted its subscription quota after two citation-gate retries on one diagnostic, the remaining seven bounded reports completed, GPT-5.5 passed first-use reviewer qualification, and aggregate review retained the concrete version, migration-head, stale release-claim, and clean-wheel validation gaps requiring follow-up. CivicCore and CivicCode remained clean at their original exact commits throughout. This is an accepted proof of detection and fail-closed review behavior, not a compatibility approval.

The initial CivicSuite inventory should recognize:

- the civicsuite umbrella repository as suite-wide governance, architecture, compatibility, installer, desktop, and release truth;
- civiccore as the shared platform;
- civicrecords-ai, civicclerk, civiccode, civicnotice, and civicaccess as current city-core modules;
- queued and foundation-tier modules as different maturity classes;
- the Windows Tauri/WebView2 desktop and installer path;
- local PostgreSQL, Ollama, and Gemma dependencies;
- strict evidence, local-first, human-review, version, compatibility, and release-readiness policies.

The current public organization exposes 28 repositories. Its public text and latest-release display also provide a useful real-world consistency test: release and status surfaces can temporarily disagree and DevHarmonics should detect that rather than choose one silently.

Acceptance:

- suite-wide instructions and repository-local instructions are reconciled with source links and revisions;
- version and release claims are checked across canonical surfaces;
- no module maturity claim is inferred from a tag alone.

Remaining DH-730 scope: remote-only canonical-source acquisition; semantic compatibility-matrix parsing; explicit PostgreSQL/Ollama/Gemma dependency discovery; installer/Tauri architecture analysis; deeper governance reconciliation; and a complete release-truth workflow spanning refreshed umbrella, module, installer, and release surfaces.

#### DH-740: CivicSuite pilot ladder — XL

Status: **Level 2 passed on 2026-07-16.** The first real bounded single-repository implementation ran end to end on CivicCode: the objective aligned the pinned CivicCore shared-ingestion dependency, CI workflow, tests, and documentation from the v1.2.0 release wheel to the published v1.2.1 wheel (sha256 verified against the live release). A read-only Claude architect produced the approved plan revision; Claude workers completed both tasks first-try in isolated worktrees; pin, docs, and diff validators passed with receipts; integration merged serially; and an independent Codex reviewer returned READY under the configured quorum. The run retained a prepared exact-SHA delivery (branch `devharmonics/7f1c39f5`) that stops at the owner's external-write approval, and the registered primary checkout was never modified. Level 3 (resilient execution) is the next rung.

Pilot levels:

1. Observe: inventory repositories, rules, compatibility, validators, versions, release truth, and risks without mutation.
2. Single repository: implement a bounded change, validate it, and return a reviewable branch with evidence.
3. Resilient execution: continue a task across provider exhaustion or local/cloud fallback without losing state.
4. Cross repository: coordinate a shared-platform or suite-consistency change across at least two repositories.
5. Release evidence: run a bounded readiness workflow covering versions, artifacts, documentation, tests, and unresolved risks.

Each level must pass before the next level can authorize more autonomy.

### 6.8 Integrations and ecosystem breadth

#### DH-800: GitHub integration — L

Deliverables:

- read repositories, issues, pull requests, checks, releases, and projects;
- map objectives to existing work items;
- create draft issues or pull requests only with approval;
- monitor CI and convert failures into bounded tasks;
- preserve repository permissions and branch protection.

Acceptance:

- read-only use works without authorizing writes;
- every external write has an approval and receipt;
- DevHarmonics never treats a pull request as merged until GitHub confirms it.

#### DH-805: Development triggers — M

Deliverables:

- allowlisted GitHub and optional Linear event triggers with attribution, deduplication, and visible activation state;
- local schedules for approved maintenance, catalog, audit, and validation workflows;
- monitoring-event intake that creates bounded diagnostic evidence or objective drafts without production-write authority;
- optional email/chat notification and approval-link adapters that cannot authorize arbitrary message-driven implementation;
- per-trigger repository, workflow, autonomy, permission, and rate policies.

Acceptance:

- a trigger can draft or update an objective without silently starting mutating work;
- schedules run only while the local computer and DevHarmonics runtime are available;
- monitoring, email, and chat input cannot bypass plan approval or consequential-action gates;
- duplicate external events do not create duplicate runs.

#### DH-810: Reusable workflow engine — L

Status: **v0.6 core implemented (v1.33): content-hash workflow revisions, fail-closed parsing, typed-input instantiation through the objective composer, structural objective provenance, immutable run pinning, promotion permission-widening refusal, two workflows-of-record in the tracked `workflows/` directory, and a cockpit Workflows view. Still open within this package: campaign templates, agent-skill packs, per-product workflow scoping, and the broader workflow library listed below.**

Deliverables:

- versioned parameterized workflows for dependency upgrades, issue-to-PR, accessibility audit, release-truth audit, clean-machine checklist, module finishing, and documentation consistency;
- typed inputs, required evidence, approval points, and completion contracts;
- versioned campaign templates whose pilot-proven stage, shard, reviewer, command, diagnostic, and resource policies remain inspectable;
- product-specific workflow and agent-skill packs stored in Git.

Acceptance:

- workflows are reviewable before execution;
- workflow updates do not rewrite historical runs;
- promoting a pilot creates a new template revision without silently widening permissions;
- historical runs retain the exact workflow and skill revisions used;
- CivicSuite can maintain approved suite-specific workflows.

#### DH-820: ACP transport — L

Deliverables:

- implement ACP as a transport where provider support is stable;
- preserve DevHarmonics domain semantics and evidence;
- negotiate capabilities rather than assuming parity;
- keep provider authentication outside DevHarmonics where ACP does not own it.

Acceptance:

- an ACP agent can plan or implement through the same task and result contracts;
- unsupported capabilities fail closed;
- the user can see which transport performed each attempt.

#### DH-825: Experimental Open Interpreter worker adapter — M

Status: **Roadmap, owner-approved 2026-07-16. Experimental; feature-flagged; does not displace the locked capability sequence.**

Open Interpreter (github.com/openinterpreter/openinterpreter, Apache-2.0, a Rust Codex-fork agent runtime at 0.0.x) exposes many local and alternative coding models — Ollama and LM Studio without authentication, plus Kimi, DeepSeek, Qwen/GLM and others — behind one noninteractive CLI with newline-delimited JSON events, JSON-Schema-constrained results, sandbox modes, and an ACP mode. Its role in DevHarmonics is an optional leaf worker runtime under the scheduler: a "long tail of models" adapter. It is never the orchestrator, never embedded, and never a replacement for the first-class Codex, Claude Code, and Antigravity integrations.

Deliverables:

- an `OpenInterpreterCliAdapter` behind an explicit feature flag, initially supporting only `interpreter exec --json` with `--output-schema`, `--sandbox`, `--ephemeral`, and adapter-owned timeouts;
- credential boundary preserved: DevHarmonics never requests, receives, stores, forwards, or displays provider secrets, and the dashboard gains no credential fields; the user configures authentication in Open Interpreter directly and DevHarmonics only detects readiness (the claimed Kimi subscription sign-in path must be verified at implementation time, not assumed);
- worker fingerprint covering the pinned Open Interpreter version, provider, exact model ID, emulated harness, model-catalog revision, configuration profile, skills/MCP configuration, sandbox and permission policy, adapter version, and task-contract version — an emulated-harness change (for example Kimi + kimi-code versus Kimi + generic) is a different qualified worker;
- Git-authority enforcement as evidence, not instruction: the adapter snapshots the assigned worktree's commit state before each attempt and fails the attempt if the worker created branches, commits, merges, resets, stashes, or worktrees, or wrote outside its assigned worktree; validators remain launched exclusively by DevHarmonics;
- Open Interpreter's self-verification turn (`--verify`) is retained only as a worker claim and can never satisfy a check or gate;
- network disabled unless the selected provider requires it and policy permits it; reviewers run read-only; no automatic fallback to another model or harness inside the adapter.

Initial qualification targets: one Ollama local model, Kimi subscription (if the no-key sign-in verifies), and one inexpensive API-backed model for development testing — each through the standard anti-gaming qualification fixtures, admitted first to read-only analysis and secondary review, and graduated to mutating work only after repository-specific pilot qualification.

Acceptance:

- with the flag off, DevHarmonics behavior is byte-identical to today;
- a qualified Open Interpreter worker completes a bounded change in its assigned worktree with schema-valid results and receipts, and a worker-created Git operation fails the attempt with a classified receipt;
- reviewer-independence rules recognize Open Interpreter-backed model families as distinct providers for quorum diversity;
- an Open Interpreter version bump invalidates prior qualification until requalification passes;
- DH-820's later generic ACP adapter uses Open Interpreter as its first conformance target without inheriting adapter-specific assumptions.

#### DH-830: OpenRouter and API runtime — L

Status: **OpenRouter foundation implemented in v0.3.0 and accepted in v0.4.0; broader API-provider support remains planned.**

Deliverables:

- implement the OpenRouter adapter and provider-neutral API invocation contract;
- store API credentials in the operating-system credential store;
- require explicit enablement, allowed models, spending ceiling, privacy/data policy, and fallback position;
- collect normalized usage and cost receipts;
- allow future direct API providers behind the same contract.

Acceptance:

- the capability ships, but a default installation makes no authenticated or paid API calls; public catalog synchronization may run without activating models;
- enabling it is a guided setup rather than a code change;
- spending and data-boundary violations fail before invocation;
- disabling it removes all API candidates from scheduling.

#### DH-840: Small-team handoff — M (deferred)

Deliverables:

- export and import approved objective, workflow, evidence, and delivery-handoff bundles;
- explicit bundle provenance, revisions, checksums, and authority boundaries;
- simple attribution for a very small product team without corporate role hierarchy or a hosted DevHarmonics service.

Acceptance:

- solo local operation remains the complete primary product;
- sharing a bundle never transfers provider credentials, local secrets, or unapproved authority;
- no remote worker, multi-tenant control plane, enterprise IAM, compliance-administration, or centralized secrets-management infrastructure is introduced.

### 6.9 Packaging, diagnostics, and release

#### DH-900: Launcher and installer — L

Deliverables:

- friendly Windows launcher or installer for the local application;
- dependency inspection for Node/runtime, Git, provider CLIs, Ollama, and optional integrations;
- start/stop/reopen behavior without signing users out of providers;
- upgrade, backup, export, repair, and uninstall paths.

Acceptance:

- a clean supported Windows machine reaches the setup cockpit without manual source commands;
- application closure and provider sign-out are clearly distinct;
- upgrade preserves configuration and ledger data.

#### DH-910: Diagnostics and support bundle — M

Deliverables:

- health summary for application, database, Git, repositories, providers, models, local resources, event stream, and migrations;
- redacted support bundle;
- corrective guidance linked to the failing layer.

Acceptance:

- common failures can be diagnosed without exposing credentials;
- support exports pass secret-seeding tests;
- every degraded status has a recommended action.

#### DH-920: Release engineering — L

Deliverables:

- deterministic build and version consistency checks;
- signed release artifacts when distribution begins;
- migration compatibility tests;
- upgrade and rollback tests;
- changelog, manual, landing page, and Google Doc synchronization gates.

Acceptance:

- release claims match tested artifacts;
- documentation distinguishes shipped, planned, and experimental behavior;
- no version surface drifts unnoticed.

## 7. Release increments

The work packages are delivered in the following order. Some packages overlap, but an increment does not exit until its gate passes.

Implementation status as of 2026-07-14:

- Increment 0 (v0.1.x stabilization): complete.
- Increment 1 (v0.2 cockpit): complete in the v0.3.0 release line.
- Increment 2 (v0.3 model fleet and Ollama): complete; the CivicSuite pilot proved local Qwen review using three bounded diagnostic-report chunks.
- Increment 3 (v0.4 adaptive workforce): complete and accepted. The representative CivicSuite Observe run `c13f39e7-3f0c-45e5-95ae-b37d78beadfb` independently selected Codex Terra, Claude Sonnet, and Gemini 3.5 Flash for three bounded diagnostics, passed every evidence check on the first attempt, and completed three context-only final-review chunks with local Ollama `qwen2.5:7b`. The full 68-test gate, version audit, dependency audit, routing-evidence inspection, model-fleet walkthrough, evidence-view walkthrough, and full/compact responsive passes all succeeded. Reviewer invocations now participate in empirical profiles, manual tier overrides are explicit, and stale assets cannot silently preserve an older cockpit. Task-linked structured reviewer findings remain part of DH-460 rather than being inferred from a run-level verdict.
- Increment 4 (v0.5 verified local implementation): feature scope and automated verification complete; release publication gate in progress.
- Increment 5 (v0.6 CivicSuite operation): in progress, with registry, planning, intelligence, exact integration sets, and automatic fix/re-review foundations implemented.
- Increments 6 through 8: planned, with selected foundations already present where noted by the work-package evidence.

### Increment 0: Stabilized baseline — v0.1.x

Work:

- DH-100 compatibility types;
- DH-110 migration framework;
- DH-130 durable events foundation;
- DH-140 redaction boundary;
- expand cancellation, migration, and security tests.

Exit gate:

- all v0.1 behavior still passes;
- a copied real v0.1 ledger upgrades and reads correctly;
- seeded credentials never persist;
- interrupted migrations recover.

### Increment 1: Personal production cockpit — v0.2

Work:

- DH-120 configuration v2;
- DH-200 runtime contract;
- DH-210 connections and diagnostics;
- DH-600 application shell;
- DH-610 setup;
- DH-630 persisted live events, reconnection, pause, cancel, and resume;
- DH-900 launcher foundation.

Exit gate:

- Scott can install, reopen, authenticate providers, configure a project, launch a run, refresh the browser, cancel, restart, and inspect evidence without losing durable state.

### Increment 2: Model fleet and Ollama — v0.3

Work:

- DH-220 live registry;
- DH-230 health and cooldowns;
- DH-240 initial qualification harness;
- DH-500 Ollama adapter;
- DH-520 local resource broker;
- Models UI and manual role assignments.

Exit gate:

- DevHarmonics discovers Scott's installed local models and subscription-visible models;
- a user can qualify, pin, exclude, and manually assign them;
- a local model completes a read-only analysis task;
- unhealthy or exhausted candidates are not scheduled.

### Increment 3: Adaptive agent workforce — v0.4

Work:

- DH-250 empirical profiles;
- DH-300 execution graph;
- DH-310 capacity broker;
- DH-320 model-aware routing;
- DH-330 fallback;
- DH-410 context budgets;
- DH-420 blackboard;
- DH-430 structured results.

Exit gate:

- coordinator and subagents select models independently;
- several implementors can run concurrently without a product-level cap;
- simulated quota exhaustion falls back cleanly;
- routing and fallback decisions are explainable and replayable.

### Increment 4: Verified local implementation — v0.5

Status: **Feature scope and automated verification complete; release publication gate in progress.** DH-440 through DH-470 foundations, DH-510's bounded local tool loop, Mellum2 scheduling, DH-620's durable single-workspace objective/plan approval core, DH-640's read-only multi-model Workbench, exact review-evidence binding, collision-proof internal task IDs, same-provider architect qualification fallback, complete concurrent-abort settling, and bounded OpenRouter spending enforcement are implemented on the v0.5 development branch.

Work:

- DH-440 tool registry;
- DH-450 evidence center and Run Reporter;
- DH-460 adversarial review quorum and fixer loop;
- DH-470 verification-integrity and anti-shortcut gates;
- DH-510 secure local-model tool execution;
- DH-620 objective and plan approval;
- DH-640 Workbench.

Exit gate:

- a qualified local model can complete a bounded worktree change using only approved tools;
- subscription and local agents produce the same normalized evidence contract;
- high-risk work can require independent review, repair, and re-review;
- a green validator cannot pass when the campaign materially weakened its own tests or implementation contract;
- the Run Reporter cannot mutate results.

### Increment 5: CivicSuite single- and multi-repository operation — v0.6

Status: **In progress.** DH-700's registry/local Git inspection, DH-710's product-aware repository selection and impact planning, DH-720's exact multi-repository execution plus automatic fixer/re-review quorum loop, and DH-800's first approved-delivery slice are implemented. The first bounded real CivicSuite implementation is next and must include the DH-632 feedback states exercised by that workflow. Restart reconstruction and cleanup remain follow-on reliability work and do not displace the owner-locked capability sequence.

Work:

- DH-400 product and repository intelligence;
- DH-632 visible operation feedback for every workflow exercised by the pilot;
- DH-350 campaign and stage orchestrator;
- DH-360 pilot-to-scale promotion;
- DH-700 product registry;
- DH-710 cross-repository planning;
- DH-720 integration sets;
- DH-730 CivicSuite intelligence;
- DH-740 pilot Levels 1 through 4.

Exit gate:

- DevHarmonics completes a reviewed CivicSuite single-repository change;
- the complete workflow is proven on a representative pilot before campaign fan-out;
- it survives a provider fallback;
- it completes one bounded cross-repository objective with exact commits, checks, documentation impacts, and unresolved risks.

### Increment 6: Product-development workflows — v0.7

Work:

- DH-635 live run steering;
- DH-650 analytics;
- DH-660 evaluation and improvement;
- DH-370 diagnostic partitioner and shard barriers;
- DH-480 differential validation and regression accounting;
- DH-800 GitHub;
- DH-805 development triggers;
- DH-810 reusable workflows;
- DH-740 CivicSuite Level 5;
- release and consistency workflow packs.

Exit gate:

- Scott can move from objective through draft PR and evidence-backed review;
- Scott can redirect, reprioritize, interrupt-and-handoff, or reassign live work with durable attribution;
- CivicSuite release truth and compatibility workflows produce actionable, reviewable evidence;
- an allowlisted GitHub or Linear event can create a bounded objective draft without silently authorizing execution;
- one campaign centralizes an expensive diagnostic, partitions non-overlapping repairs, and reports equivalence plus regressions honestly;
- analytics and versioned evaluations identify routing and workflow improvements without silently promoting them.

### Increment 7: Ecosystem breadth — v0.8

Work:

- DH-820 ACP;
- DH-830 OpenRouter/API hardening and additional API-provider support;
- additional runtime adapters selected by demonstrated need;
- policy, privacy, cost, and compatibility hardening.

Exit gate:

- ACP and API models participate through the same scheduler and evidence contracts;
- OpenRouter can be enabled through setup without code changes;
- default installations make no paid API calls;
- fallback cannot bypass spending or privacy policy.

### Increment 8: Production hardening — v1.0

Work:

- DH-340 full recovery and reconciliation;
- DH-910 diagnostics;
- DH-920 release engineering;
- performance, accessibility, security, upgrade, and clean-machine gates;
- portable small-team handoff bundles without hosted infrastructure.

Exit gate:

- routine use on CivicSuite is stable;
- restart and upgrade paths are proven;
- all shipped claims have automated or retained acceptance evidence;
- unresolved high-risk security or data-loss defects are zero.

### Later expansion: Small-team handoff

DH-840 is implemented only when Scott's personal workflow is stable and a concrete need exists to exchange approved work with a very small team. It remains an artifact-handoff capability, not a hosted team service, remote-worker platform, or enterprise administration layer.

## 8. Dependency map and parallelism

Critical sequence:

    domain and migrations
        -> runtime contract
        -> connection and model registry
        -> health and qualification
        -> capacity, routing, and fallback
        -> structured context, tools, and evidence
        -> durable visible operation feedback
        -> multi-repository integration
        -> CivicSuite release workflows
        -> ACP and API breadth

Useful parallel tracks after DH-100 and DH-110:

- Experience: application shell, setup flows, SSE client, and the shared DH-632 operation-feedback contract;
- Runtime: subscription adapters, Ollama, and model discovery;
- Intelligence: repository ingestion, context packs, and qualification fixtures;
- Assurance: redaction, migration tests, scheduler simulation, and evidence export;
- CivicSuite: repository inventory, governance mapping, and pilot fixture design.

Parallel implementation must not allow two work packages to redefine the same domain contract independently. Domain and migration changes require a single integration owner and compatibility review.

## 9. Testing strategy

### 9.1 Unit tests

- state transitions and policy decisions;
- model eligibility and scoring;
- failure classification and fallback;
- token budgeting and blackboard projection;
- schema validation;
- redaction;
- repository relationship and integration-set logic.
- campaign/stage/promotion transitions, representative pilot selection, review quorum, diagnostic partitioning, regression budgets, and command policy.

### 9.2 Contract tests

Each adapter gets recorded and synthetic fixtures for:

- installation and authentication checks;
- model discovery;
- exact invocation arguments;
- streaming and structured output;
- cancellation;
- rate limits and quota exhaustion;
- malformed output;
- tool requests;
- version changes and retired aliases.

No live provider subscription is required for the default automated suite.

### 9.3 Persistence and migration tests

- every supported schema upgrade path;
- rollback and interrupted migration;
- WAL recovery;
- foreign-key and integrity checks;
- event cursor replay;
- secret absence;
- backup and restore.

### 9.4 Scheduler simulation

A deterministic fake clock and fake fleet will simulate:

- hundreds of ready tasks;
- multiple models per provider;
- concurrent subscription and local capacity;
- five-hour and weekly quota events;
- model cooldown and recovery;
- context overflow;
- GPU or RAM pressure;
- retries, replanning, and dependency blocking;
- coordinator and reviewer diversity requirements.
- pilot failure and workflow revision before fan-out;
- shard overlap and exclusive-command barriers;
- disk, CPU, memory, process, VRAM, and artifact-growth pressure;
- centralized diagnostic fan-out and consistent barrier snapshots;
- reviewer disagreement, fixer invalidation, and re-review.

### 9.5 Integration tests

- fake Codex, Claude, Gemini, Ollama, ACP, and OpenRouter runtimes;
- real Git repositories and worktrees;
- single- and multi-repository integration sets;
- validators and artifact capture;
- browser event reconnection;
- restart during every lifecycle phase;
- GitHub read and approval-controlled write through fixtures or isolated test repositories.
- stage-specific command denial including stash, destructive reset, cross-worktree mutation, and redundant expensive diagnostics;
- expected-versus-actual test census, deleted/weakened-test fixtures, stubs, disabled checks, and swallowed-error fixtures;
- differential old/new behavior with intentional and unexplained mismatches.
- operation-state transitions, quiet-work heartbeats, stall/timeout classification, screen navigation, browser refresh/reconnect, and accessible feedback for every asynchronous control.

### 9.6 End-to-end acceptance

- clean Windows setup;
- existing-user upgrade;
- authenticated subscription setup;
- Ollama and several installed local models;
- bounded code change;
- quota fallback;
- multi-repository CivicSuite objective;
- evidence export;
- application restart and machine reboot recovery.
- representative-pilot promotion into a multi-shard campaign;
- adversarial implement-review-fix-re-review execution;
- resource-pressure admission reduction and restart-safe stage recovery;
- regression and behavioral-equivalence report that remains not-ready when material evidence is missing.
- a complete newcomer pass proving every exercised action acknowledges immediately, stays visibly active or waiting, survives navigation/refresh, and ends with an actionable success, failure, cancellation, or recovery state without fabricated percentage progress.

### 9.7 Non-functional gates

- no known persisted secrets;
- no path escape from a worktree;
- no external write without required approval;
- keyboard and screen-reader coverage for core flows;
- loopback-only default binding;
- deterministic version and documentation consistency;
- acceptable UI responsiveness with large run histories;
- bounded database, log, and context growth.
- no host destabilization under simulated disk, memory, process, or VRAM pressure;
- no campaign promotion from raw commit, token, line, agent, or test-pass counts alone.

## 10. Definition of done

Every work package must include:

- approved domain and interface changes;
- tests that fail without the behavior and pass with it;
- migration or compatibility handling where applicable;
- diagnostics and error classification;
- security and redaction review;
- user-visible status and recovery guidance;
- immediate, durable, accessible working-state feedback for every asynchronous operation introduced or exercised by the work package, without fabricated progress;
- documentation of shipped behavior;
- retained acceptance evidence;
- verification-integrity evidence proving expected tests and gates actually ran and were not materially weakened;
- independent review appropriate to risk, with fixer changes invalidating prior review when configured;
- behavioral, runtime, security, accessibility, performance, visual, migration, or human-acceptance evidence required by the task contract;
- no regression in the current full check suite.

A feature is not done because one model successfully demonstrated it once or because one test command returned green. Tests are necessary evidence; the applicable layered evidence contract determines readiness.

## 11. CivicSuite as the proving ground

CivicSuite is unusually valuable because it combines:

- an umbrella repository and many module repositories;
- shared-platform dependency rules;
- current city-core and lower-maturity modules;
- strict version, compatibility, provenance, and honest-status requirements;
- Python services, a Rust/Tauri desktop shell, PostgreSQL, tests, documentation, and Windows packaging;
- local Ollama and Gemma operation;
- clean-machine and release-evidence workflows;
- high consequences for overstated readiness.

The first production target should be a low-risk, high-evidence objective such as repository inventory, release-truth consistency, compatibility checking, documentation alignment, or a bounded test-backed module correction. DevHarmonics should not begin by autonomously changing the installer, signing, deployment, authentication, or public-release state.

The pilot must use local clones and the exact repository governance present at execution time. Public GitHub information is discovery input, not authorization to write.

## 12. Initial engineering backlog

The first implementation sequence is:

1. Add schema-version tracking, backup, and transactional migration scaffolding.
2. Add provider-neutral identifiers and compatibility projections for current ProviderName records.
3. Add typed durable events and cursor queries without changing the UI transport yet.
4. Add centralized redaction at every ledger write entry point.
5. Define RuntimeAdapter, ProviderConnection, Model, InvocationRequest, InvocationEvent, and InvocationResult contracts.
6. Port Codex, Claude, and Gemini adapters behind the new runtime contract.
7. Add connection diagnostics that distinguish installed, authenticated, visible, healthy, and available.
8. Add the model registry tables and manual model entries.
9. Add persisted SSE with reconnect cursors and replace active-run polling.
10. Build Setup and Models cockpit surfaces against the new connection and model APIs.
11. Add Ollama discovery and read-only invocation.
12. Add the health-check queue and cooldown state machine.
13. Add the first qualification fixtures and manual qualification workflow.
14. Add execution-graph repository scope, capability needs, and result contracts.
15. Add the capacity broker and explainable manual routing before automatic scoring.
16. Add classified fallback using fake providers and quota simulation.
17. Add blackboard, context packs, and structured result envelopes.
18. Add secure local-model tools after the policy engine exists.
19. Register CivicSuite as the first multi-repository product and complete Observe.
20. Select and complete the first bounded CivicSuite implementation objective.
21. Enforce stage-specific command policy outside model prompts and retain denied-operation receipts.
22. Add representative-pilot selection and promotion evidence before campaign fan-out.
23. Add configurable adversarial review quorums, fixer disposition, and re-review invalidation.
24. Add expected-versus-actual test census, anti-shortcut fixtures, and differential behavior baselines.
25. Add campaign stages, resource-aware shards, centralized diagnostic partitioning, regression budgets, and restart-safe promotion gates.
26. Add live run steering with pause-admission, redirect, interrupt-and-handoff, reprioritization, and reassignment receipts.
27. **Implemented:** Add approved branch/draft-PR delivery handoff with exact evidence and no implicit merge or deployment.
28. Add Git-versioned reusable workflow and agent-skill packs with exact historical revision retention.
29. Add allowlisted GitHub/Linear and local schedule/monitoring triggers that create bounded drafts without bypassing approval.
30. Add evidence-based analytics and evaluation promotion with honest subscription-cost uncertainty and reversible configuration changes.

This order deliberately produces inspectable user value after items 9 through 13 while the deeper scheduler and multi-repository work continues.

## 13. Decisions that must be made during implementation

These decisions should be resolved with prototypes and evidence rather than speculation:

- which subscription adapters can enumerate models reliably and which need compatibility catalogs;
- which Claude, Codex, and Gemini model or effort controls remain stable enough for direct selection;
- whether ACP should be preferred for any provider over its official CLI;
- the safe minimum local tool set for each qualified model family;
- the best cross-platform GPU and RAM telemetry path;
- whether the current dependency-free UI remains maintainable as the cockpit grows;
- the exact secure-storage implementation on Windows, macOS, and Linux;
- the first CivicSuite repository set and bounded objective;
- which GitHub writes should be available first;
- which portable small-team handoff artifacts are useful after solo operation is proven.

These are not permission to weaken the product principles. When an integration cannot meet the trust, evidence, or recovery contract, it remains unavailable or experimental.

## 14. Progress reporting

Implementation progress should be reported by accepted capability, not percentage complete.

Each increment should publish:

- work packages accepted;
- user outcome now possible;
- automated and retained acceptance evidence;
- migrations introduced;
- experimental features and restrictions;
- unresolved risks;
- next exit gate;
- current CivicSuite pilot level.

The product specification remains the authority for product scope. This implementation plan controls execution order and may be revised when evidence changes dependencies, but revisions must retain rationale and must not silently remove committed capabilities.

## 15. Immediate recommendation

Increment 4 shipped as v0.5.1. Continue Increment 5 in this exact capability order:

1. **Approved branch/draft-PR delivery — implemented.** Present the exact resulting commits and evidence, require explicit approval before pushing a delivery branch or creating a draft pull request, and never merge automatically.
2. **First real CivicSuite implementation — next.** Select one bounded, useful single-repository change and run it from objective through implementation, validation, review, repair, and approved delivery. Include DH-632 feedback for every operation and state exercised by this workflow. Fix only blockers actually encountered in that run.
3. **Live run steering.** Pause task admission; redirect, reprioritize, or reassign queued work; interrupt an active attempt; continue with new instructions; and retain exactly what changed.
4. **Real provider/local fallback.** Continue an interrupted CivicSuite task through another subscription model or qualified local model while preserving context, evidence, and task state.
5. **Real cross-repository CivicSuite implementation.** Make and deliver one coordinated change across at least two registered repositories with exact integration evidence.
6. **Reusable development workflows.** Save proven issue-to-PR, dependency-upgrade, module-finishing, compatibility-checking, and release-truth-review processes as Git-versioned workflows.

Restart reconstruction, automatic worktree cleanup, analytics, triggers, and campaign-scale orchestration remain planned. They must not be pulled ahead of this sequence unless a real run exposes one as a direct blocker or Scott explicitly changes the plan.

DH-632 is a cross-cutting acceptance obligation, not an additional roadmap detour: each item above must ship its own complete immediate acknowledgement, working/waiting/retry/stall, completion/failure, and refresh-safe feedback before that item is accepted.

## Sources

- [DevHarmonics Canonical Product Specification](PRODUCT_SPEC.md)
- [DevHarmonics Architecture](ARCHITECTURE.md)
- [CivicSuite GitHub organization](https://github.com/CivicSuite)
- [CivicSuite umbrella repository](https://github.com/CivicSuite/civicsuite)
