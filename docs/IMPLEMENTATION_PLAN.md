# DevHarmonics Detailed Implementation Plan

Document status: **Build-ready execution plan**
Plan version: **1.14**
Written: **2026-07-14**
Revised: **2026-07-15**
Product specification baseline: **DevHarmonics Product Specification v1.6**
Current implementation baseline: **DevHarmonics v0.4.0**
Google Doc: [DevHarmonics Detailed Implementation Plan](https://docs.google.com/document/d/1cVTT2v6H0z6j5NMSPcdwpoWNuuawxB-FdRUj1SYLwns/edit?usp=drivesdk)

Revision history: **v1.14 (2026-07-15)** — Implemented the first DH-730 vertical slice: immutable source-backed product-intelligence snapshots over configured canonical local files, exact repository HEAD/content-hash/working-tree provenance, explicit version/release/status/maturity claim extraction, subject-aware contradiction detection, missing/unsafe/dirty-source findings, planning-context injection, and Products-page scan/readback controls. Git tags are never treated as maturity evidence. CivicCore and CivicCode are attached as the first current CivicSuite repository set, and their live snapshot identifies the CivicCore 1.2.0 versus 1.2.1 dependency conflict with cited sources. The live Observe proof also exposed and closed DH-720's reviewer first-use qualification ordering gap.

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

1. DevHarmonics v0.4.0 has a working subscription/local execution path, durable adaptive model fleet, and a passed CivicSuite Observe acceptance workflow.
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
- retain aliases and exact resolved model identifiers;
- mark models known, visible, verified, qualified, active, degraded, or retired.

Acceptance:

- new models appear without a DevHarmonics code release when an adapter can enumerate them;
- a provider announcement alone never marks a model usable;
- exact model resolution is visible in every attempt receipt.

#### DH-230: Health, quota, and cooldown manager — L

Deliverables:

- maintain a prioritized health-check queue;
- implement cached inexpensive probes;
- classify ready, slow, busy, cooling, rate-limited, quota-exhausted, incompatible, and unavailable states;
- model subscription five-hour and weekly exhaustion as observed capacity windows without pretending providers expose exact counters;
- probe Ollama reachability, model load, context behavior, and local resource pressure.

Acceptance:

- repeated failures trigger bounded cooldown rather than probe storms;
- an exhausted provider is not repeatedly assigned new work;
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

Acceptance:

- the coordinator is not forced onto subagents;
- Claude, Codex, Gemini, local models, and API models can each be selected at their own available model and effort settings;
- the UI explains every material routing decision.

#### DH-330: Classified failure and fallback engine — L

Deliverables:

- classify network, provider outage, rate limit, short-window quota, long-window quota, concurrency, authentication, unsupported capability, model retirement, context overflow, tool denial, validator failure, and content-policy refusal;
- choose a qualified fallback within the same subscription, another subscription, local runtime, or opt-in API pool;
- preserve the worktree, context pack, attempt history, and handoff;
- require replanning when substitution would change quality or permissions materially.

Acceptance:

- a simulated subscription quota exhaustion continues on a qualified fallback;
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

Deliverables:

- configure reviewer count, independence, provider/model diversity, and required expertise by risk;
- provide reviewers the task contract, diff, relevant source, and evidence without inheriting implementor reasoning as fact;
- normalize findings with severity, location, rationale, suggested correction, and disposition;
- adjudicate disagreements, assign an independent fixer, and require bounded re-review after changes.

Acceptance:

- high-risk tasks can require two or more independent passing reviews;
- a reviewer cannot silently review its own unqualified work;
- conflicting findings remain visible until resolved or explicitly accepted;
- fixer changes invalidate prior review receipts and trigger the configured re-review gate.

#### DH-470: Verification-integrity and anti-shortcut gates — XL

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

#### DH-650: Analytics — M

Deliverables:

- model and role performance;
- latency, retries, validator outcomes, fallback history, quota and cooldown behavior;
- local-versus-subscription-versus-API workload;
- human intervention, review rejection, duplicated work, and critical-path idle time.

Acceptance:

- analytics use ledger evidence rather than provider self-report;
- low-sample uncertainty is visible;
- reports can be filtered by product, repository, role, model, and time.

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

Status: **First vertical slice implemented in the v0.5 development line; milestone remains in progress.** A supported approved plan creates an exact integration set across compatible local repositories. Each repository receives its own run integration branch and worktree pinned to a retained base commit; each task targets one repository and receives its own branch/worktree. Tasks in different repositories may run concurrently, while merges targeting the same repository use that repository's serialized merge queue. Repository-local validators and verification-integrity checks run against each integration branch. Final review is read-only and context-only across the aggregate, repository-prefixed diff evidence. The scheduler now qualifies an eligible premium reviewer before multi-repository review routing, rather than allowing an architect-only qualification to block an otherwise available reviewer. The ledger, evidence export, API, and run-board card retain every repository's base commit, integration HEAD, branch, worktree, status, error, and integration conditions. The registered primary checkouts are not checked out, merged, reset, or otherwise changed.

Deferred from this first slice: automatic multi-repository fixer/re-review and review quorums greater than one; runs remain `NOT READY` when review policy requires more than the single supported reviewer. Restart/resume reconstruction, automatic worktree cleanup, pushing branches or opening pull requests, and a single task mutating more than one repository also remain unimplemented.

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

#### DH-810: Reusable workflow engine — L

Deliverables:

- versioned parameterized workflows for dependency upgrades, issue-to-PR, accessibility audit, release-truth audit, clean-machine checklist, module finishing, and documentation consistency;
- typed inputs, required evidence, approval points, and completion contracts;
- versioned campaign templates whose pilot-proven stage, shard, reviewer, command, diagnostic, and resource policies remain inspectable;
- product-specific workflow packs.

Acceptance:

- workflows are reviewable before execution;
- workflow updates do not rewrite historical runs;
- promoting a pilot creates a new template revision without silently widening permissions;
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

#### DH-840: Optional team operating mode — XL

Deliverables:

- shared workspace state, role-based approvals, remote workers, and team audit;
- keep personal local-first mode fully functional;
- separate user identity from provider credentials.

Acceptance:

- team infrastructure is not required for Scott's use;
- enabling team mode does not weaken local evidence or permission boundaries;
- provider sessions remain attributable and revocable.

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
- Increments 4 through 8: planned, with selected foundations already present where noted by the work-package evidence.

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

Status: **Feature scope implemented; integration gate pending.** DH-440 through DH-470 foundations, DH-510's bounded local tool loop, Mellum2 scheduling, DH-620's durable single-workspace objective/plan approval core, and DH-640's read-only multi-model Workbench are implemented on the v0.5 development branch. The aggregate release gate remains before v0.5 can ship.

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

Status: **In progress.** DH-700's registry/local Git inspection, DH-710's product-aware repository selection and impact planning, and the first DH-720 exact multi-repository execution slice are implemented. DH-720 still needs automatic multi-repository fixing/quorum support, restart reconstruction, cleanup, and delivery automation; the bounded CivicSuite pilot also remains.

Work:

- DH-400 product and repository intelligence;
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

- DH-650 analytics;
- DH-370 diagnostic partitioner and shard barriers;
- DH-480 differential validation and regression accounting;
- DH-800 GitHub;
- DH-810 reusable workflows;
- DH-740 CivicSuite Level 5;
- release and consistency workflow packs.

Exit gate:

- Scott can move from objective through draft PR and evidence-backed review;
- CivicSuite release truth and compatibility workflows produce actionable, reviewable evidence;
- one campaign centralizes an expensive diagnostic, partitions non-overlapping repairs, and reports equivalence plus regressions honestly;
- analytics identify routing and workflow improvements.

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
- team-mode architecture seams without requiring team deployment.

Exit gate:

- routine use on CivicSuite is stable;
- restart and upgrade paths are proven;
- all shipped claims have automated or retained acceptance evidence;
- unresolved high-risk security or data-loss defects are zero.

### Later expansion: Team operation

DH-840 is implemented when Scott's personal workflow is stable and a real multi-user need exists. The architecture supports it, but personal local-first operation remains a complete product mode.

## 8. Dependency map and parallelism

Critical sequence:

    domain and migrations
        -> runtime contract
        -> connection and model registry
        -> health and qualification
        -> capacity, routing, and fallback
        -> structured context, tools, and evidence
        -> multi-repository integration
        -> CivicSuite release workflows
        -> ACP and API breadth

Useful parallel tracks after DH-100 and DH-110:

- Experience: application shell, setup flows, and SSE client;
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
- when team operation has enough real demand to justify its infrastructure.

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

Increment 3 is complete. The next meaningful delivery target is Increment 4 campaign safety:

> Safely extend the accepted adaptive workforce into long-running, multi-stage product campaigns with enforced command policy, representative-pilot promotion, adversarial review/fix/re-review, verification-integrity checks, and host resource admission.

The v0.4.0 release closes the adaptive-workforce gate with retained CivicSuite evidence and verified full/compact cockpit behavior. Automatic first-use qualification, cross-provider scheduling, routing-score decomposition, workload-specific worker and reviewer evidence, validator/conflict attribution, observation controls, latency/cost/diversity signals, and classified fallback scope are now the accepted foundation. Structured task-linked review findings continue in DH-460; run-level NOT READY participation remains deliberately non-causal.

Immediately after that gate, implement campaign safety before attempting very large autonomous efforts: enforced command policy, representative-pilot promotion, configurable adversarial review/fix/re-review, verification-integrity checks, and host resource admission. Campaign stage orchestration, centralized diagnostic partitioning, differential validation, and regression accounting then become the path to scaling those proven workflows across CivicSuite rather than simply increasing agent count.

## Sources

- [DevHarmonics Canonical Product Specification](PRODUCT_SPEC.md)
- [DevHarmonics Architecture](ARCHITECTURE.md)
- [CivicSuite GitHub organization](https://github.com/CivicSuite)
- [CivicSuite umbrella repository](https://github.com/CivicSuite/civicsuite)
