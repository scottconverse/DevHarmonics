# DevHarmonics Canonical Product Specification

Document status: **Canonical product direction**
Specification version: **1.11**
Written: **2026-07-13**
Revised: **2026-07-15**
Current implementation baseline: **DevHarmonics v0.5.1**
Google Doc: [DevHarmonics Canonical Product Specification](https://docs.google.com/document/d/1rd-_gqHHPZHhTkrULJR9tHcbAVUOGONsbuEFCV-8pRQ/edit?usp=drivesdk)

Revision history: **v1.11 (2026-07-15)** — Made visible working-state feedback a required product capability rather than deferred polish. Every DevHarmonics-owned operation must acknowledge immediately, expose truthful lifecycle and elapsed activity, distinguish active/waiting/retrying/stalled states, persist across navigation and refresh, and end visibly. Progress indicators must be evidence-based rather than fabricated. Each remaining workflow must ship its own complete feedback states so UI/UX debt is not deferred into a later retrofit.

Prior revision: **v1.10 (2026-07-15)** — Reconciled the canonical baseline with the v0.5 verified-implementation line: durable objectives and exact plan approval, Workbench, bounded local-model write tools, product/repository intelligence, exact multi-repository integration sets, structured reviewer fix/re-review, and cryptographic review binding to the exact plan, checks, diff, and repository base/HEAD set. Locked the next capability sequence as approved branch/draft-PR delivery, a real single-repository CivicSuite implementation, live run steering, real provider/local fallback, a real cross-repository CivicSuite implementation, and reusable Git-versioned development workflows.

Prior revision: **v1.9 (2026-07-15)** — Fixed the product boundary around a locally operated software factory for a solo product owner or very small product team. Added live run steering, GitHub/Linear and bounded local triggers, approved PR/delivery handoff, evidence-based analytics and evaluation loops, and Git-versioned workflows/skills. Explicitly rejected a DevHarmonics cloud-hosting platform, remote workers that continue while the user's computer is off, enterprise workforce/IAM/compliance administration, and message-driven execution from arbitrary email or chat.

Prior revision: **v1.8 (2026-07-15)** — Established the canonical product-category positioning: DevHarmonics is a local-first, provider-neutral software factory for product owners managing AI agents as development teams.

Prior revision: **v1.7 (2026-07-15)** — Clarified provider-neutral identity and quota boundaries for Google Antigravity: one authenticated subscription connection may expose Google, Anthropic, and OpenAI model vendors; its Gemini and Claude/GPT quota groups are scheduled independently; and requested model identity is never reported as actual execution identity unless the runtime verifies it.

Earlier revision: **v1.6 (2026-07-15)** — Added the first named local specialist policy: Mellum2 Instruct and Thinking as separate exact-model upgrade tracks, benchmark-gated specialist scheduling, a narrow low-risk economy implementation lane, enforced task-capability matching, and no automatic download, activation, promotion, or universal-default behavior.

Earlier revision: **v1.5 (2026-07-15)** — Reconciled the current implementation baseline with the accepted v0.4.0 adaptive workforce: exact-model qualification, fair cross-provider scheduling, workload-specific worker and reviewer observations, explicit manual tier overrides, retained CivicSuite acceptance evidence, and verified full/compact cockpit behavior.

Earlier revision: **v1.4 (2026-07-14)** — Added campaign-scale development orchestration: pilot-to-scale promotion, staged fan-out/fan-in execution, adversarial review quorums, enforced command policy, diagnostic partitioning, anti-shortcut and test-integrity gates, differential validation, resource-aware sharding, regression accounting, and restart-safe campaign recovery.

Earlier revision: **v1.3 (2026-07-14)** — Reconciled the canonical specification with the implemented v0.3.0 model fleet, enforceable per-run Observe mode, substantive diagnostic evidence gates, bounded local report review, and classified reviewer fallback.

Earlier revision: **v1.2 (2026-07-14)** — Made live provider-catalog refresh, fingerprint-based qualification invalidation, controlled family upgrades, and governed OpenRouter paid routing immediate product requirements.

## 1. Purpose and authority

This document defines what DevHarmonics is intended to become, who it is for, how it must behave, and how the product will be judged. It is the canonical source for product scope and priorities.

The documentation hierarchy is:

1. This specification defines the intended product.
2. `README.md` and `docs/USER_MANUAL.md` define what a user can do in the current release.
3. `docs/ARCHITECTURE.md` describes the current implementation.
4. `CHANGELOG.md` records what has shipped.

When those documents differ, the difference is a roadmap gap unless this specification has been explicitly superseded. This document must not be used to imply that unimplemented features already ship.

The words **MUST**, **SHOULD**, and **MAY** identify required, preferred, and optional behavior.

## 2. Product definition

**DevHarmonics is a local-first, provider-neutral software factory for product owners managing AI agents as development teams.**

It provides the product-development control plane for directing a heterogeneous team of AI development agents across one repository, many repositories, and an ongoing product program.

The user supplies product intent, constraints, priorities, and approval. DevHarmonics turns that direction into a dependency-aware execution program; selects suitable providers, models, reasoning levels, agents, and tools; runs work concurrently in isolated environments; validates and reviews the result; preserves evidence and decisions; and returns changes for human approval.

DevHarmonics is not simply a chat interface and not merely a wrapper around several model APIs. Its defining capability is **model-aware workforce orchestration**:

- knowing which models and tools are actually available;
- understanding their capabilities, costs, limits, health, and demonstrated strengths;
- assigning different models independently to coordination, planning, implementation, research, review, and validation roles;
- scheduling as many agents as the work, machine, and provider capacity can safely support;
- switching or falling back when quota, availability, or quality changes;
- qualifying new model releases before trusting them with production work; and
- recording exactly who did what, with which model and settings, and what evidence proved the result.

The concise product promise is:

> Give DevHarmonics a product objective. It assembles, coordinates, and verifies the best available AI development crew while keeping the human product owner in control.

## 3. Primary design customer

DevHarmonics is designed first for **Scott Converse as an owner-operator product manager running real software-development programs with AI agents as the development team**.

The primary user:

- manages multiple active products and repositories;
- thinks in outcomes, requirements, priorities, release readiness, and risk;
- wants to direct work at the product level without manually operating every agent session;
- already pays for Codex, Claude, and Gemini subscriptions and wants to use those entitlements;
- also wants local LLMs for privacy, resilience, bulk work, and cost control;
- may optionally enable paid API access later without making it a prerequisite;
- expects the system to keep working across long efforts, interruptions, quota windows, model upgrades, and machine reboots; and
- needs trustworthy evidence before merging or releasing anything.

Secondary users may include technical product managers, founders, solo developers, and very small AI-native product teams. Their needs must not displace the primary owner-operator workflow until that workflow is excellent.

### 3.1 Product boundary

DevHarmonics is a locally operated product, not a hosted DevHarmonics cloud service. The control plane, ledger, scheduler, worktrees, policy enforcement, evidence, workflows, and primary UI run on the user's computer. Subscription providers, optional APIs, GitHub, Linear, and other configured services may be contacted as external capabilities, but they do not become the product's hosting layer.

The primary operating model is one product owner directing an AI development workforce. A very small team may exchange approved objectives, workflow definitions, evidence bundles, and delivery handoffs, but DevHarmonics is not intended to manage a corporate engineering organization. It will not become an enterprise identity provider, centralized secrets-administration platform, compliance suite, or remote-worker service.

When the computer is off, DevHarmonics work stops. Durable state allows safe local resume after restart; the roadmap does not include DevHarmonics-hosted sandboxes that keep running in the cloud or seamless local-to-cloud migration of active agents.

## 4. Primary target environment: CivicSuite

[CivicSuite](https://github.com/CivicSuite) is the first major real-world proving ground for DevHarmonics.

CivicSuite is a particularly valuable target because it combines:

- an [umbrella repository](https://github.com/CivicSuite/civicsuite) containing suite-wide specifications, governance, architectural decisions, compatibility information, installer scaffolding, and release truth;
- many sibling module repositories with different maturity levels;
- a shared `civiccore` platform dependency;
- Python services, Rust/Tauri desktop packaging, PostgreSQL, tests, documentation, and Windows installation paths;
- local Ollama-hosted models as part of the delivered product;
- module/version compatibility requirements;
- clean-machine installation and release-verification gates; and
- a strong requirement that documentation, claims, artifacts, versions, and actual readiness agree.

DevHarmonics MUST support CivicSuite without requiring CivicSuite to collapse into a monorepo or abandon its existing repository-level governance.

### 4.1 CivicSuite pilot scenarios

The product must grow toward these concrete scenarios:

1. **Single-module change:** implement a bounded feature or fix in one CivicSuite module, run its native checks, review the diff, and produce a merge-ready branch or pull request.
2. **Shared-platform change:** change `civiccore`, identify affected modules, test compatible consumers, and report impact before integration.
3. **Cross-repository feature:** coordinate a feature spanning the umbrella specification, shared platform, one or more modules, desktop shell, installer metadata, and user documentation.
4. **Release-truth audit:** compare source, versions, dependency pins, compatibility matrices, status documents, installer metadata, release notes, and generated artifacts; identify contradictions with evidence.
5. **Local-model change:** evaluate or upgrade an Ollama model or serving configuration, test affected AI workflows, and preserve exact model/digest/settings evidence.
6. **Clean-machine release gate:** prepare and monitor the ordered checks needed for a Windows installer evaluation, while requiring human approval for installation, signing, publication, or other consequential actions.
7. **Long-running module completion:** take one module from an approved specification through implementation, validation, documentation, integration, and release-candidate evidence across multiple resumable runs.

The first production milestone is not “DevHarmonics can open a CivicSuite repository.” It is:

> DevHarmonics can safely complete a useful, bounded CivicSuite objective, preserve all evidence, survive interruption or provider exhaustion, and return a result Scott is comfortable reviewing and merging.

## 5. Product principles

### 5.1 The human owns intent and authority

The product owner decides what outcome matters, what constraints apply, and what consequential actions are allowed. Agents may recommend and execute within granted scope; they do not silently expand it.

### 5.2 Best available model, not favorite provider

Routing must be based on task fit, demonstrated quality, availability, privacy, latency, resource use, and user policy. No provider is permanently the boss, planner, implementor, or reviewer.

### 5.3 Subscriptions first, local always available, APIs optional

The default product should make full use of provider subscriptions through official authenticated software. Local models should become a first-class execution pool. API-key cloud access may be enabled explicitly but must not be required for core use.

### 5.4 Evidence over agent confidence

An agent saying work is complete is not proof. Completion requires configured checks, inspected artifacts, review, and durable receipts appropriate to the risk.

### 5.5 Isolation before parallelism

Concurrent agents must receive separate workspaces, explicit scopes, and integration rules. Increasing agent count must not mean allowing uncontrolled edits to the same checkout.

### 5.6 Durable state over chat history

Goals, plans, decisions, attempts, model assignments, checks, artifacts, approvals, and handoffs belong in a structured ledger. A terminal closing or computer reboot must not erase program state.

### 5.7 Honest status

The UI and generated reports must distinguish planned, attempted, passing, integrated, approved, released, and production-verified work. DevHarmonics must never turn partial technical evidence into a stronger product claim.

### 5.8 Reversible automation

The system should automate aggressively inside safe boundaries and pause at consequential boundaries. It must prefer branches, worktrees, drafts, and reviewable proposals over irreversible actions.

### 5.9 Extensible protocols, stable product semantics

Provider CLIs, ACP, MCP, local runtimes, and APIs are transports. DevHarmonics must normalize them into stable concepts—agents, models, tools, tasks, evidence, permissions, and results—without reducing every provider to the lowest common denominator.

### 5.10 Pilot before scale

Large transformations must prove their workflow on a small representative slice before DevHarmonics expands it across a product. Promotion from pilot to broad execution requires retained evidence, measured resource behavior, and explicit policy or human approval.

### 5.11 Layered proof, not test-green theater

Tests are necessary executable evidence but are not correctness by themselves. Readiness combines the acceptance contract, test-integrity evidence, deterministic checks, behavioral comparison, independent review, repository state, runtime evidence, applicable nonfunctional gates, and human acceptance. DevHarmonics must detect attempts to make checks green by weakening the evidence rather than fixing the product.

### 5.12 Local control plane, external capabilities

Local-first is an architectural commitment. DevHarmonics owns orchestration and evidence locally while invoking subscription models, optional APIs, source-control services, issue systems, and approved tools as bounded external capabilities. No normal feature may require a DevHarmonics-hosted account, server, or remote execution fleet.

### 5.13 Product-owner operation before organization administration

The interface and workflow model must optimize for a product owner directing AI agents, not for engineering-department staffing, corporate role hierarchies, or compliance administration. Small-team handoff may be supported through explicit, portable artifacts without turning team management into the product center.

## 6. User experience

### 6.1 Product hierarchy

The UI should organize work as:

```text
Portfolio
  Product / Program
    Workspace (one or more repositories)
      Objective
        Campaign
          Stage
            Shard
              Run
                Task
                  Attempt
                    Agent + model + tools + evidence
```

This hierarchy lets Scott move between a high-level portfolio view and the exact command receipt for one failed check.

### 6.2 Primary surfaces

#### Portfolio

Shows active products, repository health, current objectives, blocked work, model/provider capacity, approvals waiting, and recent outcomes.

#### Setup and providers

Guides installation, provider-owned authentication, runtime checks, entitlement discovery, Ollama setup, and troubleshooting. Provider connections and individual models must be separate concepts in both setup and navigation.

#### Product cockpit

Shows product constitution, repositories, roadmap/objectives, open risks, decisions, releases, compatibility relationships, and recent execution history.

#### Objective composer

Accepts a plain-language outcome plus optional acceptance criteria, constraints, target repositories, deadline/priority, risk level, and autonomy policy. It should help refine ambiguous objectives without forcing the user to write an agent prompt.

#### Plan and dependency view

Shows the proposed work breakdown, repository boundaries, dependencies, validation gates, expected artifacts, assigned agent classes, and estimated resource pressure before work begins. The user can edit or approve it.

#### Campaign control room

Shows stage gates, pilot results, shards, synchronization barriers, reviewer quorums, diagnostic artifacts, resource pressure, regression budgets, recovery state, and promotion decisions for large or long-running objectives. It distinguishes useful verified throughput from raw agent, token, commit, or line counts.

#### Live run board

Shows queued, ready, working, verifying, blocked, integrating, and completed tasks; active agents; worktrees; provider/model assignments; quota pressure; retries; and dependency consequences.

#### Model fleet

Shows every discovered subscription, local, and optional API model with its status, capabilities, qualification results, current availability, quota state, installed/runtime requirements, aliases, and upgrade recommendations.

#### Workbench

Provides a non-mutating repository scratchpad for exploring ideas, asking a model about the codebase, comparing two model responses, drafting acceptance criteria, or refining an objective before converting it into a verified run. The Workbench must remain visibly distinct from execution and receive no repository-write authority.

#### Analytics and settings

Shows model/role performance, fallback history, local-versus-subscription workload, health-check behavior, run retention, logging/redaction controls, experimental adapters, model cache controls, and user routing preferences.

#### Evidence and review center

Collects diffs, commits, validator receipts, screenshots, test reports, reviewer findings, security results, decisions, and unresolved concerns. It culminates in a release or merge recommendation rather than a generic success message.

#### Approval inbox

Presents only decisions requiring human authority, with enough context to approve, reject, modify, or defer them. Examples include widening scope, downloading a large local model, changing a dependency, resolving a policy conflict, opening a pull request, merging, publishing, signing, deploying, or spending through an API provider.

### 6.3 Interaction standard

The default experience must feel like directing a competent product and engineering organization:

- state the outcome;
- inspect or adjust the proposed plan;
- approve the scope and autonomy level;
- watch meaningful progress rather than raw terminal noise;
- intervene only when judgment or authority is needed; and
- receive an evidence-backed result and clear next actions.

Raw logs remain available, but they are supporting detail rather than the primary interface.

### 6.4 Visible working-state feedback

DevHarmonics must never leave the user guessing whether an operation it owns is working, waiting, stalled, or finished. Every user-initiated or background operation visible in the product must:

- acknowledge input immediately with a disabled or stateful control, concise status text, and an accessible busy indication;
- expose a truthful lifecycle such as queued, starting, running, waiting for capacity, waiting for approval, retrying, blocked, stalled, succeeded, failed, or cancelled;
- show the current meaningful stage, elapsed time, latest retained activity, and responsible agent/model/provider when known;
- provide a continuing heartbeat or last-update timestamp during quiet work so slow operations are distinguishable from a disconnected or stalled process;
- remain visible through a global activity surface when the user navigates away from the initiating screen;
- reconstruct its state after browser refresh or reconnection from durable control-plane evidence rather than browser memory alone;
- end with a visible result, failure explanation, recovery or retry action, and retained evidence link when applicable; and
- respect accessibility requirements including `aria-live`, keyboard operation, sufficient contrast, and reduced-motion preferences.

Spinners are appropriate only for genuinely indeterminate work. Progress bars and percentages require a real numerator/denominator, bounded stage sequence, or provider-reported measure; DevHarmonics must never invent completion percentages from elapsed time. When exact progress is unknowable, show the active stage, elapsed time, last activity, and honest indeterminate state.

This contract applies to provider discovery and sign-in checks, catalog refresh, model qualification and benchmarking, Workbench consultation, product/repository scans, plan generation and revision, run execution, validation, review and repair, delivery, exports, settings changes, and every future workflow. DevHarmonics cannot report external work performed outside its control plane, such as a separate Codex or Computer Use session, and must not imply that it can.

## 7. Core product capabilities

### 7.1 Portfolio and multi-repository workspaces

DevHarmonics MUST:

- register multiple products and local repository clones;
- support a product workspace containing one or many Git repositories;
- understand repository roles such as umbrella, shared platform, module, desktop shell, installer, documentation, or infrastructure;
- record dependency and compatibility relationships between repositories;
- ingest repository-native instructions, contribution rules, architecture documents, validators, and ownership boundaries;
- allow an objective to target one repository, an explicit set, or a discovered impact set;
- preserve separate branch, review, and merge boundaries for every repository; and
- provide an organization-level view without assuming all repositories share the same language, toolchain, release cycle, or permissions.

For CivicSuite, the umbrella repository’s specifications and compatibility data should inform planning, but sibling runtime repositories remain the authoritative locations for their code.

### 7.2 Product constitution and context system

Every product workspace SHOULD have a versioned product constitution containing durable rules such as:

- product purpose and users;
- architectural invariants;
- security, privacy, and accessibility requirements;
- repository ownership and dependency rules;
- approved technology choices;
- release definitions;
- validation requirements;
- documentation truth sources; and
- actions that always require human approval.

DevHarmonics must assemble task-specific context packs rather than dumping the entire product history into every agent. A context pack may include the objective, relevant constitution sections, repository instructions, dependency summaries, prior decisions, acceptance criteria, affected files, and evidence from predecessor tasks.

Context packs MUST be recorded or reproducibly referenced in the ledger.

Every active run SHOULD also maintain a structured shared blackboard containing the current goal, constraints, approved plan, assignments, project facts, architectural decisions, accepted assumptions, open questions, files changed, dependency changes, artifacts, validator receipts, failed approaches, integration conflicts, security constraints, user decisions, and current synthesis. Agents receive only the relevant blackboard projection for their role; they do not receive an unrestricted transcript dump.

Context assembly must be token-aware. It must reserve space for the goal, constraints, current task, response contract, and recent failures; select relevant files and predecessor evidence; summarize older material; prefer validator evidence over agent narrative; and adapt to each model's context capacity. Truncation must never silently remove the response schema or the end of the current task instructions.

### 7.3 Objective planning and dynamic decomposition

A coordinator or architect must convert the objective into a typed execution graph containing:

- task identifier and outcome;
- repository and workspace scope;
- dependencies;
- expected files or artifacts;
- acceptance criteria;
- required validators;
- risk and permission class;
- preferred agent capabilities;
- context needs;
- integration target; and
- stop/escalation conditions.

Plans must be schema-validated and checked for dependency cycles, missing repositories, unavailable validators, incompatible permissions, and impossible model requirements.

The plan is dynamic. DevHarmonics SHOULD be able to add diagnostic tasks, split an oversized task, replan blocked downstream work, or request a decision while preserving the original plan and the reason for every change.

### 7.4 Agent team composition

DevHarmonics must support specialized agents rather than one repeated generalist. Roles include:

- coordinator or boss;
- product analyst;
- architect;
- planner;
- researcher;
- implementor;
- test engineer;
- security reviewer;
- accessibility reviewer;
- UX/design reviewer;
- documentation writer;
- integrator;
- release auditor; and
- adversarial or independent final reviewer.

Roles are templates, not provider assignments. Any eligible provider/model may fill a role if its qualification, permissions, and current capacity fit.

The coordinator must be able to create multiple implementors of the same class—for example, several fast Codex workers, several Claude workers, several Gemini workers, or several local Qwen/Gemma workers—when independent ready tasks exist.

There is no arbitrary product-level agent-count ceiling. Effective concurrency is bounded by:

- dependency-ready work;
- user or administrator policy;
- CPU, RAM, GPU/VRAM, disk, and process capacity;
- repository isolation capacity;
- provider concurrency and quota;
- validator/integration bottlenecks; and
- observed failure or contention rates.

### 7.5 Provider and transport layer

DevHarmonics must support four connection classes.

#### Subscription-backed provider applications

Primary subscription transports are Codex, Claude Code, and Google Antigravity through their official authenticated tools. Antigravity is one signed-in connection that may expose models from Google, Anthropic, and OpenAI; transport, connection, model vendor, model identity, and quota group MUST remain separate concepts. DevHarmonics:

- uses existing provider-owned login sessions;
- never asks for provider email passwords;
- does not copy or expose OAuth/session tokens;
- detects installation, version, authentication, and available capabilities;
- invokes providers through structured noninteractive modes where available; and
- isolates provider-specific arguments and output parsing inside versioned adapters.

#### Agent Client Protocol

ACP SHOULD be supported where a provider or agent exposes it reliably. ACP is an additional transport, not the definition of the product and not assumed to be the authentication mechanism for every subscription.

#### Local model runtimes

Ollama is the first required local runtime. The adapter must discover installed models, model details, digests, supported capabilities, running state, context configuration, and resource behavior. Additional local runtimes may be added behind the same normalized interface.

Compatible local models may fill read-only or mutating agent roles, including planning, documentation, test generation, diff review, run reporting, private/offline work, and bounded implementation. Tool-enabled local agents remain confined to their assigned worktree, receive only explicitly scoped file/search/patch/validator tools, never receive unrestricted shell access, and cannot commit or integrate outside orchestrator control.

Mellum2 is the first named local specialist family. The registry and scheduler MUST treat Instruct and Thinking as separate exact-model tracking families and qualify them independently. Published capabilities MAY seed a provisional profile for code, structured output, tool use, routing, context preparation, and—only for Thinking—reasoning, but MUST NOT establish schedulability by themselves. Before assignment, Mellum2 requires the role-compatible qualification plus a current specialist benchmark covering strict structured output, contradiction detection, and requirement/feature counting. Instruct initially targets narrow, low-risk economy work; Thinking MAY target standard reasoning work after independent qualification. Neither variant may become the coordinator, final authority, universal local default, or replacement for independent review merely because of its name, size, or published benchmark results. DevHarmonics MUST NOT download, activate, or promote either variant without user action and passing evidence.

#### Optional API gateways

OpenRouter is the preferred first implementation for API-based cloud breadth. It is disconnected and paid routing is disabled by default. Connection uses OAuth and OS-protected credential storage so a user never manually handles an API key. OAuth connection does not authorize spending: paid fallback separately requires project and OpenRouter policy gates, positive per-run and monthly limits, explicit model activation, current qualification, and live credit/limit verification. The rest of DevHarmonics remains usable with no model API keys.

Direct provider APIs MAY be added later when they provide a material capability not available through subscriptions, local runtimes, or OpenRouter.

### 7.6 Live model registry

The live model registry is a defining product subsystem.

It must distinguish:

1. **Known:** published or present in a provider/runtime catalog.
2. **Visible:** exposed to the connected account or local runtime.
3. **Verified:** accessible through a successful compatibility probe.
4. **Qualified:** passed DevHarmonics auditions for one or more roles.
5. **Active:** eligible for live assignment under current policy.
6. **Degraded:** temporarily rate-limited, unhealthy, or underperforming.
7. **Retired:** removed, deprecated, inaccessible, or administratively disabled.

Each registry entry should retain:

- provider and connection class;
- account or runtime identity without copying credentials;
- canonical model identifier;
- aliases and alias-resolution history;
- display name and model family;
- first-seen, last-seen, and last-verified timestamps;
- entitlement/visibility status;
- context limits and modalities;
- tool use, structured output, vision, reasoning, and other capabilities;
- supported reasoning/effort settings;
- local parameter size, quantization, digest, disk size, RAM/VRAM observations, and license metadata where applicable;
- provider quota pool and observed rate-limit behavior, including connection-internal quota groups;
- adapter and minimum CLI/runtime compatibility;
- qualification results by role and workload class;
- quality, latency, reliability, and resource observations from actual runs;
- deprecation/replacement information;
- user pins, exclusions, and routing preferences; and
- provenance for every catalog fact.

#### Discovery sources

The registry should reconcile four sources:

- what the signed-in provider or local runtime reports;
- official public provider catalogs and release metadata;
- a signed, versioned DevHarmonics compatibility catalog; and
- empirical results from the user’s own machine and workloads.

Provider announcements alone do not prove subscription entitlement. A model is not “available” for scheduling until account visibility or a safe verification probe confirms it.

Registry refreshes SHOULD occur:

- during startup;
- after sign-in or account changes;
- after provider CLI/runtime upgrades;
- on manual request;
- on a lightweight periodic schedule; and
- after an unknown-model or retired-model failure.

The product must not depend on scraping interactive UI text when a structured provider mechanism is available.

#### Health-check queue and cooldowns

Runtime readiness must extend beyond installed/authenticated checks. DevHarmonics should maintain a prioritized, concurrency-controlled health-check queue with cached results, retry policy, latency observations, failure counters, rate-limit classification, and provider/model cooldowns. Observable states should include ready, slow, busy, cooling down, rate-limited, locked, incompatible, and unavailable.

Ollama checks may verify server reachability, installation, model load, structured output, tool calling when needed, latency, context behavior, RAM/VRAM pressure, and current runtime queue/load. Subscription checks should remain inexpensive: prefer authentication, catalog state, cached recent success, and real-run observations over wasteful probe calls.

Capacity management queues excess work rather than imposing a global agent limit. For example, a user may request 30 agents while policy allows only two concurrent local generations; other ready work can wait or route to qualified capacity elsewhere.

#### Empirical capability profiles

Model role recommendations should combine published metadata, capability probes, user overrides, and observed ledger performance. Useful dimensions include coding, reasoning, research, instruction following, synthesis, context handling, speed, reliability, structured output, and tool use.

Observed role fitness should draw from first-attempt validator pass rate, average retries, build/test outcomes, invalid-envelope frequency, median latency, merge-conflict frequency, reviewer rejection, fallback frequency, and performance by task category. Name keywords or parameter count may seed an unknown model's profile, but they must not remain the primary evidence once real results exist.

### 7.7 New-model qualification and upgrades

New models must enter an audition lifecycle:

```text
discovered
  -> entitlement verified
  -> adapter compatibility tested
  -> capability probes passed
  -> role-specific auditions completed
  -> upgrade recommendation produced
  -> user/policy approval
  -> active for new assignments
```

Auditions should use small, representative, non-destructive tasks and historical evaluation fixtures. A model may qualify for one role but not another. A small local model might qualify for classification, repository mapping, documentation cleanup, or bulk test generation without qualifying as an architect or final reviewer.

For named local specialists, a marker-echo probe is insufficient. Qualification SHOULD include machine-checked task properties that can expose feature blindness or internal contradiction. A local implementation candidate MUST retain independent evidence for bounded tool use and specialist fidelity; one qualification cannot silently confer the other.

Users need two auditable upgrade policies:

- **Pinned:** retain an exact model identifier until explicitly changed.
- **Track family:** evaluate the newest observed member of the selected Sol/Terra/Luna, Fable/Opus/Sonnet/Haiku, Gemini, exact local variant, or API family and promote it only after exact-ID invocation qualification and configured benchmarks pass. Variant contracts such as Mellum2 Instruct and Thinking cannot cross-promote.

Provider moving aliases may inform discovery, but they cannot silently change the model used by a run.

DevHarmonics must record the concrete model identifier and settings used for every attempt whenever the provider exposes them. When a runtime confirms only the requested model or alias but does not report the model that actually executed, the receipt MUST retain that request and mark actual resolution unverified; it MUST NOT promote the requested identifier into an observed fact. Moving aliases may be used for discovery or preference, but must not erase reproducibility.

A routine model release should require only a registry/catalog update when the existing adapter supports it. A DevHarmonics adapter or application update is required only when authentication, invocation, tool semantics, reasoning controls, output formats, or minimum provider versions change.

Cloud subscription models are not downloaded. “Upgrade” means qualifying and changing routing/default policy. Local-model downloads require explicit approval because they consume disk/network resources and may introduce license or hardware constraints.

Catalogs are rechecked at every application launch, automatically every 24 hours while running, on forced **Refresh fleet**, and before a run when stale or when a CLI/runtime version changed. The qualification fingerprint contains provider, exact model identifier, model/capability metadata, CLI/runtime version, adapter version, and fixture-suite version. A changed fingerprint invalidates prior schedulability until requalification. Newly introduced and removed models are recorded, but retirement requires at least three consecutive missing observations. Only active, pinned, family-tracked, or scheduler-selected candidates are probed.

Anthropic's official models overview is authoritative for Claude candidate discovery; third-party trackers are advisory. Because Claude Code lacks a complete model-list command, a real exact-ID Claude Code invocation is required to establish subscription entitlement.

### 7.8 Model-aware routing and scheduling

The scheduler must make independent selections for every role and task. The coordinator’s model does not force subagents to inherit the same provider, family, model, or effort level.

A scheduling decision should consider:

- task type and risk;
- required capabilities and tools;
- model qualification for that role;
- historical performance on this product and similar tasks;
- context size and context locality;
- subscription entitlement and current quota window;
- local CPU/GPU/RAM/VRAM capacity;
- estimated latency and opportunity cost;
- privacy/data-boundary policy;
- desired provider/model diversity;
- retry history;
- downstream dependencies and critical path; and
- user pins, exclusions, and preferences.

The scheduler should optimize for the objective and current policy, not simply round-robin providers.

Examples:

- use a high-capability subscription model for architecture;
- assign several mid-tier subscription implementors to independent critical-path tasks;
- use local models for repository indexing, classification, repetitive documentation checks, or draft tests;
- reserve a separate provider/model family for independent review;
- avoid consuming scarce premium quota on low-risk bulk work; and
- delay GPU-heavy local work if it would starve validation or another critical process.

The scheduler must explain material routing decisions in plain language and record the full machine-readable decision.

### 7.9 Quota, capacity, and fallback management

Provider availability has at least three independent dimensions:

- **entitlement:** the account is allowed to use the model;
- **health:** the provider/model is technically responding; and
- **capacity:** the current quota, rate limit, concurrency, or usage window permits work.

Running out of a five-hour or weekly subscription allowance must not permanently mark a model unavailable.

Capacity scope may be narrower than a connection. In Google Antigravity, the **Gemini Models** quota group and the **Claude and GPT Models** quota group share one authenticated connection but have independent capacity windows. Exhausting either group MUST cool only that group until its provider-reported reset, leaving qualified models in the other group eligible. The internal legacy configuration key `gemini` MAY remain as a compatibility alias, but it MUST NOT be shown or persisted as proof that an Anthropic or OpenAI model executed.

The scheduler should classify failures such as:

- transient network failure;
- provider outage;
- rate limit;
- short-window quota exhaustion;
- long-window quota exhaustion;
- concurrency restriction;
- context overflow;
- unsupported capability;
- authentication expiration;
- model retirement; and
- content/policy refusal.

Fallback policy may select:

1. another model within the same subscription;
2. another subscription provider;
3. a qualified local model;
4. an explicitly enabled API model; or
5. a pause with a clear resumption condition.

Fallback is not blind substitution. The replacement must meet the task’s capability, privacy, and quality requirements. If it does not, the task pauses or is replanned.

DevHarmonics must preserve the worktree, context pack, attempt history, and exact handoff reason so another agent can continue rather than restarting from scratch. A model change during a task must appear in the run timeline.

### 7.10 Tool, skill, and connector coordination

Models are only part of the workforce. DevHarmonics must maintain a tool registry covering:

- local commands and validators;
- MCP servers and tools;
- provider-native tools;
- browser and computer-use capabilities;
- Git and GitHub operations;
- issue/project systems;
- reusable skills, recipes, and workflows; and
- product-specific scripts and release gates.

Each tool entry should specify permissions, trust level, input/output contract, side effects, secrets exposure, supported environments, and validation expectations.

The coordinator may assign tools to an agent only when both the task and the current approval policy permit them. Tool output is untrusted input until validated or corroborated.

Reusable workflows should be parameterized and versioned. Examples include dependency upgrade, issue-to-PR, accessibility audit, release-truth audit, clean-machine checklist, module finishing, and documentation consistency review.

### 7.11 Git isolation and integration

Every mutating task MUST run in an isolated branch/worktree or an equivalently strong sandbox. The system must:

- start from a known commit;
- record base and resulting commits;
- prevent unrelated work from being overwritten;
- inspect dirty worktrees before starting;
- serialize integrations that target the same branch;
- validate the combined result after integration;
- retain failed work for diagnosis according to cleanup policy; and
- never silently merge into the user’s checked-out or protected branch.

For multi-repository objectives, DevHarmonics must create an integration set containing the exact branch/commit for each repository. Cross-repository readiness is judged against that set, not against whichever branches happen to be checked out.

Automatic conflict repair may be offered as a bounded, separately validated task. Unbounded or ambiguous conflict resolution requires human review.

### 7.12 Verification and independent review

Verification has layers:

1. task acceptance criteria;
2. repository-native deterministic validators;
3. changed-area tests and static checks;
4. integration checks on the combined branch or integration set;
5. artifact inspection, including visual inspection where relevant;
6. independent model review;
7. security, privacy, accessibility, or release gates appropriate to risk; and
8. human approval for merge, release, or other consequential action.

Validators must be selected from trusted configuration or an explicitly approved workflow. Agent-generated shell commands must not automatically become trusted validators.

The final reviewer should normally differ from the primary implementor in provider, model family, or both. High-risk work may require adversarial review or consensus from multiple independent reviewers.

DevHarmonics must also verify the integrity of verification itself. It records an expected-versus-actual test census, detects deleted or skipped tests and weakened assertions where practical, retains test selection and coverage changes, and reports filtered or silently missing execution. It must inspect for prohibited shortcuts such as new stubs, placeholders, unconditional success paths, swallowed errors, disabled checks, unjustified unsafe operations, scope reduction, or long comments used to rationalize a workaround. These signals create findings; they do not replace engineering judgment.

For ports, migrations, framework replacements, and other equivalence-sensitive work, the prior implementation or approved baseline should become a behavioral oracle. DevHarmonics can execute representative inputs against old and new systems, compare outputs, errors, side effects, files, logs, performance, and platform behavior, and turn unexplained mismatches into bounded repair tasks.

Every check receipt should include:

- command/tool identity and configuration;
- working directory and repository commit;
- start/end time and duration;
- exit status;
- stdout/stderr or artifact references;
- environment information needed for interpretation;
- pass/fail/indeterminate classification; and
- any truncation or missing-evidence warning.

### 7.13 Durable ledger, memory, and provenance

The ledger must persist:

- products, workspaces, repositories, and relationships;
- objectives and acceptance criteria;
- plans and plan revisions;
- tasks, dependencies, states, and assignments;
- provider, model, settings, adapter, and tool versions;
- context-pack references;
- prompts/instructions subject to privacy policy;
- attempts and handoffs;
- commits, diffs, artifacts, and integration sets;
- check and review receipts;
- approvals and authority changes;
- decisions, rationale, and unresolved risks;
- quota/capacity observations;
- costs when API use is enabled; and
- final outcomes and follow-up work.

The ledger must support restart and resume. After a crash or reboot, DevHarmonics should reconcile recorded state with live processes, worktrees, branches, and repositories; identify interrupted attempts; and offer safe resume, retry, archive, or abandon actions.

Summaries and memory may be generated from the ledger, but generated prose never replaces the underlying evidence.

### 7.14 Approvals and autonomy policy

Every product and objective should choose an autonomy profile. At minimum:

- **Observe:** inspect and report only.
- **Prepare:** plan, research, and draft without repository mutation.
- **Implement:** edit isolated worktrees and run approved validators.
- **Integrate:** create and update run integration branches after checks pass.
- **Propose externally:** create draft issues or pull requests with approval.
- **Consequential action:** merge, publish, deploy, sign, spend, delete, or change external state only with explicit authorization.

Policies may narrow access by repository, path, command, tool, provider, model, data class, or action type.

DevHarmonics must show why an approval is required, what will happen, what evidence supports it, and whether the action is reversible.

### 7.15 Development triggers and external integration

DevHarmonics SHOULD connect product intent with existing work systems without forcing migration. GitHub and Linear are the first trigger and work-item priorities. It should be able to:

- read GitHub repositories, issues, pull requests, checks, releases, and Projects;
- read and link Linear issues when a user configures Linear;
- map an objective to an approved work item or create a proposed issue set;
- preserve links between objectives, tasks, commits, pull requests, decisions, releases, and originating work items;
- react to explicitly configured events such as an approved issue, CI failure, requested PR change, or milestone transition;
- run local scheduled maintenance, catalog, audit, and validation workflows while DevHarmonics and the computer are available;
- accept monitoring events as evidence for a bounded diagnostic objective, not as authority to modify production;
- prepare draft pull requests and delivery handoffs with evidence summaries;
- update product status only after approved evidence thresholds are met; and
- operate across a GitHub organization such as CivicSuite while respecting repository permissions and governance.

External writes require the corresponding autonomy level and approval policy. Trigger rules are allowlisted, attributable, deduplicated, and visible before activation. Email and Slack may eventually deliver notifications or approval links, but arbitrary messages MUST NOT start mutating development work by default. Linear, email, Slack, or monitoring integrations must remain optional; none may be required for normal local use.

### 7.16 Installation and operations

The intended Windows experience is a friendly local application/launcher, even if the UI remains web technology served on loopback.

The installer/launcher should:

- install or package the DevHarmonics runtime;
- create Start Menu/Desktop launch paths where appropriate;
- detect Git, Node/runtime dependencies, provider CLIs, and Ollama;
- guide provider-owned sign-in without collecting credentials;
- explain unusual provider onboarding steps;
- verify authentication and model discovery;
- start/stop the local service cleanly;
- reopen the dashboard;
- preserve data across upgrades;
- provide logs, diagnostics, backup/export, and safe uninstall; and
- clearly distinguish stopping DevHarmonics from signing out of providers.

Provider CLI and local-model updates should be recommended with compatibility information. Automatic updates must be opt-in and recoverable.

### 7.17 Structured agent results and run reporting

Architects, workers, reviewers, and specialists should return typed result envelopes appropriate to their role. A worker envelope should include:

- concise result summary;
- files or artifacts changed;
- assumptions and unresolved issues;
- missing information or requested user input;
- checks believed necessary;
- tool failures;
- suggested retry or next action; and
- whether the task is complete, blocked, or needs follow-up.

Self-reported confidence may be recorded as diagnostic data but never determines correctness or readiness. Repository state, validators, reviews, and human approvals remain authoritative.

After verification, a read-only Run Reporter should create the human-facing outcome from structured ledger evidence: what changed, why, affected components, checks and results, branches/commits, assumptions, risks, and recommended next action. The reporter may use an inexpensive qualified local model, but it cannot modify the verdict, evidence, or repository.

### 7.18 Live event delivery and reconnection

The dashboard should consume persisted server-sent events or an equivalently resumable event stream with durable event IDs/cursors, automatic reconnection, resume after browser refresh, live provider/model state, and live validator progress. Closing the browser connection must not cancel the run. Cancellation is a separate control-plane action that terminates scheduling and active processes and records the transition in the ledger.

### 7.19 Live run steering

The product owner must be able to redirect work while a run is active without editing the ledger or agent terminal manually. Steering controls should support:

- pausing new task admission while preserving active evidence;
- changing task priority or redirecting queued work;
- adding a clarification or constraint at a safe task/attempt boundary;
- stopping an active invocation and creating an attributed continuation attempt with the new direction;
- reassigning a queued or interrupted task to another qualified model or provider;
- approving, rejecting, or requesting disposition of a reviewer finding; and
- seeing whether a steering instruction is pending, applied, rejected by policy, or superseded.

DevHarmonics must not pretend every provider can accept mid-response instruction injection. When an adapter cannot steer an invocation safely, the control plane interrupts it, retains its partial evidence, and starts a new attempt with an explicit handoff. Steering cannot silently widen repository scope, permissions, spending, deployment authority, or acceptance criteria.

### 7.20 Factory analytics, evaluation, and improvement

DevHarmonics should learn which models, workflows, and team shapes work best from retained evidence. Analytics should cover cycle time, verified throughput, first-pass acceptance, retries, validator and reviewer findings, fallback, quota effects, human intervention, local-resource use, and provider/model participation. Exact API tokens and cost are recorded when available; subscription utilization and equivalent cost estimates must be labeled as estimates rather than false precision. ROI is calculated only from explicit user-supplied value or time assumptions.

Evaluation fixtures, workflow experiments, routing policies, prompts, skill versions, and benchmark versions are retained and comparable. Candidate improvements must be evaluated against historical or representative workloads before promotion. DevHarmonics may recommend a new routing rule, workflow revision, skill revision, or model promotion, but it must not silently rewrite its own policy, validators, evaluation fixtures, or user authority. Promotion is versioned, reviewable, and reversible.

### 7.21 Campaign-scale development orchestration

DevHarmonics must support large engineering objectives as governed campaigns rather than one enormous prompt or undifferentiated task list.

A campaign contains versioned stages with explicit entry criteria, permitted work, agent topology, resource policy, synchronization rules, exit evidence, and promotion authority. Typical stages include analysis, transformation specification, representative pilot, adversarial review, fan-out implementation, integration or compilation, diagnostic classification, repair, smoke validation, full validation, cross-platform or release validation, and human acceptance. The exact stages remain configurable by product and objective.

Before broad fan-out, DevHarmonics should select a representative pilot slice and execute the complete implement-review-fix-validate loop. It records quality, latency, cost, resource use, failure modes, and human corrections. A failed pilot revises the workflow; a successful pilot may be promoted into a versioned reusable campaign template only after its promotion gate passes.

Material tasks support configurable team shapes, including one implementor, one or more independent adversarial reviewers, a finding adjudication step, a fixer, re-review, and deterministic validation. Reviewer count and diversity depend on risk. Reviewers receive the task contract, diff, relevant source, and evidence rather than uncritically inheriting the implementor's reasoning. Reviewer disagreement remains visible and may require another reviewer or human judgment.

Command and tool restrictions must be enforced by the runtime rather than only requested in prompts. Policies can prohibit destructive or cross-worktree Git actions, control expensive shared builds, require locks for exclusive operations, and allow different commands by stage. Every attempted and executed command receives a policy decision and receipt.

Expensive diagnostics should normally run once at a synchronization point. DevHarmonics stores the complete diagnostic artifact, classifies findings, groups them by file, subsystem, dependency, or ownership, and creates non-overlapping repair shards. Agents receive bounded diagnostic slices. Revalidation occurs at controlled barriers to prevent a thundering herd of redundant builds or inconsistent snapshots.

Shard planning accounts for repository overlap, dependency boundaries, disk, CPU, memory, process count, local-model VRAM, provider concurrency, expected artifact growth, exclusive commands, and integration bottlenecks. The resource broker may reduce concurrency, pause admission, clean approved temporary artifacts, or request intervention before the machine becomes unstable. Campaign checkpoints survive process and machine restarts without repeating accepted work.

Campaign-specific transformation artifacts—such as source-to-target pattern mappings, lifetime or ownership tables, dependency maps, API equivalence tables, architecture-preservation rules, known exceptions, and unsafe-operation policy—are versioned inputs to context packs and review. Faithful equivalence and later idiomatic cleanup are separate campaign goals unless the approved objective explicitly combines them.

Readiness accounting includes expected and actual tests, behavioral equivalence, known defects fixed, regressions introduced, unresolved incompatibilities, performance and memory movement, unsafe or provisional code remaining, platform coverage, review findings, cost, elapsed time, and human interventions. Agent count, token volume, commit rate, and lines changed are operational measurements, never success criteria by themselves.

DevHarmonics may recommend a full rewrite, incremental migration, strangler transition, shadow implementation, or no change, but it must record the alternatives and evidence. It must not generalize an all-at-once rewrite or any fixed number of agents into a default policy.

## 8. Coordinator behavior

The coordinator is a product-management control function, not necessarily one permanent model process.

It must:

- maintain the objective, constraints, and acceptance criteria;
- understand the portfolio and workspace state;
- propose and revise the execution graph;
- choose campaign strategy, stage boundaries, representative pilots, shard topology, synchronization barriers, and promotion evidence for large objectives;
- choose or delegate agent/model/tool assignments;
- manage the critical path and concurrency;
- respond to new evidence, failures, and quota changes;
- prevent duplicated or conflicting work;
- centralize expensive diagnostics and partition their findings rather than allowing redundant worker execution;
- reduce admission or pause stages when host or provider resource pressure threatens safe operation;
- keep agents within context and permission boundaries;
- request human judgment when product intent is ambiguous;
- maintain an explicit risk register;
- ensure evidence requirements are met; and
- return a concise outcome, unresolved issues, and recommended next work.

The coordinator may itself switch models between planning cycles. The ledger, not the coordinator model’s conversational memory, is the source of continuity.

## 9. Normalized data model

The implementation should expose stable domain objects independent of provider transport:

- `Product`
- `Workspace`
- `Repository`
- `RepositoryRelationship`
- `Constitution`
- `Objective`
- `AcceptanceCriterion`
- `Plan`
- `PlanRevision`
- `Task`
- `Dependency`
- `AgentRole`
- `AgentInstance`
- `ProviderConnection`
- `Model`
- `ModelAliasResolution`
- `ModelQualification`
- `CapacityObservation`
- `Tool`
- `PermissionPolicy`
- `Attempt`
- `ContextPack`
- `Worktree`
- `Commit`
- `IntegrationSet`
- `CheckReceipt`
- `Review`
- `Artifact`
- `Decision`
- `Approval`
- `Risk`
- `Event`
- `ReleaseCandidate`
- `Campaign`
- `CampaignStage`
- `Shard`
- `PromotionGate`
- `DiagnosticArtifact`
- `VerificationBaseline`
- `ReviewQuorum`
- `RegressionBudget`

All identifiers referenced in a run receipt must remain resolvable after provider catalogs, aliases, or local installations change.

## 10. Functional requirements

### Product and program control

- **FR-001:** The user can register and switch among multiple products.
- **FR-002:** A product can contain multiple repositories with typed relationships.
- **FR-003:** The user can define a product-level objective spanning selected repositories.
- **FR-004:** DevHarmonics can import relevant repository instructions and validators without silently changing them.
- **FR-005:** Objectives, plans, runs, decisions, risks, and evidence remain available across restarts.

### Models and providers

- **FR-100:** DevHarmonics discovers installed and authenticated provider connections.
- **FR-101:** The product maintains a live, provenance-aware model registry.
- **FR-102:** Subscription, local, and optional API models appear in one normalized fleet view without hiding their different economics or trust boundaries.
- **FR-103:** The user can pin, exclude, prefer, qualify, or retire models by role.
- **FR-104:** Newly discovered models enter audition status before production assignment unless an explicit policy says otherwise.
- **FR-105:** Every attempt records concrete provider/model/settings when obtainable.
- **FR-106:** The scheduler can select different models for coordinator, architect, implementor, reviewer, and specialist roles.
- **FR-107:** Multiple agents using the same or different models may run concurrently.
- **FR-108:** The system detects and classifies quota, throttling, health, authentication, and retirement failures.
- **FR-109:** Qualified fallback can continue work across model/provider classes while preserving handoff state.
- **FR-110:** Local-model downloads and API spending require explicit enabling and policy.
- **FR-111:** Runtime health checks are queued, cached, concurrency-controlled, and capable of placing models/providers into explicit cooldown states.
- **FR-112:** Role recommendations incorporate empirical validation outcomes rather than relying solely on model-name heuristics.

### Planning and execution

- **FR-200:** An objective becomes a schema-validated dependency graph.
- **FR-201:** Tasks declare repository, scope, acceptance criteria, validators, risk, and capability requirements.
- **FR-202:** The scheduler launches ready tasks up to the safe effective concurrency, without an arbitrary built-in agent cap.
- **FR-203:** Every mutating task uses an isolated workspace.
- **FR-204:** Failed work can receive exact validator feedback and bounded retries.
- **FR-205:** Plans may be revised without losing revision history or rationale.
- **FR-206:** Interrupted runs can be reconciled and resumed.
- **FR-207:** Cross-repository runs produce an exact integration set.
- **FR-208:** Each run maintains a structured shared blackboard and produces model-specific, token-budgeted context packs.
- **FR-209:** Agent roles return schema-validated result envelopes with unresolved issues and requested next actions.

### Verification and delivery

- **FR-300:** Only trusted or explicitly approved validators execute automatically.
- **FR-301:** Check outputs and artifacts are preserved as receipts.
- **FR-302:** Combined changes receive integration-level validation.
- **FR-303:** Final review is independent of implementation when capacity permits.
- **FR-304:** DevHarmonics reports readiness levels honestly and never equates a commit with a release.
- **FR-305:** Merge, release, signing, deployment, and publication respect explicit approval boundaries.
- **FR-306:** The user can inspect and export the complete evidence package.
- **FR-307:** A read-only Run Reporter summarizes ledger evidence without changing the verified verdict.

### Campaign-scale execution

- **FR-500:** A large objective can be represented as a versioned campaign of stages, shards, synchronization barriers, and promotion gates.
- **FR-501:** DevHarmonics can run a representative pilot through the complete target workflow before broad fan-out.
- **FR-502:** Promotion from pilot to scale requires recorded quality, resource, failure, and approval evidence.
- **FR-503:** A task may require a configurable independent reviewer quorum, structured findings, a fixer, and re-review.
- **FR-504:** Command policy is enforced outside model prompts and records allowed, denied, attempted, and executed operations.
- **FR-505:** One diagnostic artifact can be classified and partitioned into non-overlapping bounded repair tasks.
- **FR-506:** Shard admission and concurrency account for repository overlap, dependencies, disk, CPU, memory, process count, VRAM, provider capacity, and exclusive operations.
- **FR-507:** Verification integrity detects missing, skipped, deleted, filtered, or materially weakened tests and prohibited implementation shortcuts where practical.
- **FR-508:** Equivalence-sensitive campaigns can compare old and new behavior and retain unexplained mismatches as repair evidence.
- **FR-509:** Campaign readiness reports regressions, provisional code, nonfunctional movement, platform coverage, cost, interventions, and unresolved evidence—not merely passing tests.
- **FR-510:** Campaign checkpoints survive restart and do not repeat accepted work or consequential actions.
- **FR-511:** Successful campaign procedures can become versioned reusable templates without silently widening future authority.

### Experience and operations

- **FR-400:** A local dashboard provides portfolio, product, run, model fleet, evidence, and approval views.
- **FR-401:** Setup guides users through official provider authentication without receiving credentials.
- **FR-402:** Diagnostics distinguish installation, authentication, entitlement, model availability, capacity, and compatibility.
- **FR-403:** The UI explains fallback, replanning, and routing decisions.
- **FR-404:** Closing and reopening the application does not lose durable work state.
- **FR-405:** The user can cancel, pause, resume, archive, and inspect runs safely.
- **FR-406:** Persisted live events reconnect from a cursor after navigation, refresh, or transient disconnection.
- **FR-407:** A non-mutating Workbench can turn exploratory product/repository conversations into proposed verified-run objectives.
- **FR-408:** Model analytics expose role assignments, latency, retries, malformed outputs, validator outcomes, fallback history, and local-versus-subscription workload.
- **FR-409:** The user can pause admission, redirect queued work, interrupt and continue an active attempt with new direction, and reassign eligible work without losing attribution or evidence.

### Triggers, workflows, and learning

- **FR-600:** Explicitly configured GitHub or Linear events can create or update bounded objective drafts without silently authorizing execution.
- **FR-601:** Local schedules can start approved maintenance or audit workflows only while the local machine and DevHarmonics runtime are available.
- **FR-602:** Monitoring events create diagnostic evidence and proposed work; they do not authorize production mutation.
- **FR-603:** Email and chat integrations, if added, default to notification and approval-link delivery rather than message-driven code execution.
- **FR-604:** DevHarmonics can prepare a draft pull request and evidence-backed delivery handoff under explicit external-write approval.
- **FR-605:** Merge, deployment, signing, publication, and production changes retain separate explicit approval boundaries.
- **FR-606:** Workflows, agent skills, evaluation fixtures, and product-specific packs are version-controlled and historical runs retain the exact revision used.
- **FR-607:** Analytics report verified throughput, cycle time, quality, human intervention, provider/model utilization, and exact or clearly labeled estimated cost.
- **FR-608:** Workflow, routing, prompt, skill, and model improvements require retained evaluation evidence and an explicit, reversible promotion decision.

## 11. Non-functional requirements

### Local-first privacy

- Product state and source orchestration run locally by default.
- The dashboard binds to loopback unless the user deliberately configures otherwise.
- Normal use has no dependency on a DevHarmonics-hosted account, server, control plane, or remote execution fleet.
- When the local computer is off, scheduled and active DevHarmonics work does not continue elsewhere.
- Source or context crosses a provider boundary only when that provider is selected and policy allows it.
- Secrets are minimized, redacted from logs, and never placed in model prompts without explicit need and permission.
- Redaction occurs at the ledger boundary before provider output, validator receipts, events, errors, or tool logs are persisted or displayed. If optional integrations require secrets, credentials belong in the operating-system credential store rather than DevHarmonics data files.

### Safety

- Destructive or consequential actions require explicit authority.
- Provider output is treated as untrusted.
- Work is isolated and recoverable.
- The product defaults to reviewable branches and drafts.

### Reproducibility and auditability

- A completed run can identify exact source commits, model assignments, settings, tools, checks, artifacts, and approvals.
- Alias changes do not rewrite historical records.
- Missing or unverifiable evidence is reported, not inferred.

### Resilience

- Runs survive application restarts and machine reboots.
- Provider or model failure does not corrupt other tasks.
- Quota exhaustion supports pause, fallback, or rescheduling.
- SQLite or successor persistence has backup, migration, and integrity-check paths.
- Campaign stage, shard, diagnostic, review, and promotion state survives interruption and reconciles without duplicating accepted work.
- Resource pressure can stop admission or reduce concurrency before disk, memory, process, or VRAM exhaustion destabilizes the host.

### Performance and scale

- The control plane remains responsive with many queued tasks and agents.
- Event delivery should move beyond polling when needed.
- Large logs and artifacts are streamed or referenced rather than loaded indiscriminately.
- Scheduling accounts for local resource pressure.
- Expensive shared diagnostics execute at deliberate barriers and are partitioned instead of redundantly invoked by every worker.
- Scale is measured as verified useful throughput; raw agent count, commit rate, token volume, and lines changed are not completion metrics.
- Scale targets one owner-operator or a very small product team directing AI agents, not a corporate engineering workforce or multi-tenant service.

### Extensibility

- Providers, transports, tools, validators, workflows, and model catalogs are versioned adapters/plugins with explicit contracts.
- Provider-specific capabilities remain accessible through typed extensions.
- Compatibility failures fail closed with useful diagnostics.

### Accessibility and usability

- The dashboard must be keyboard navigable, screen-reader understandable, responsive, and visually clear.
- Status must not be communicated by color alone.
- Technical evidence must have plain-language summaries without hiding details.

## 12. Security and trust boundaries

DevHarmonics coordinates powerful software and must make boundaries visible.

Trust zones include:

- the user and local operating system;
- target repositories and configured local executables;
- DevHarmonics control-plane data;
- provider CLI processes and subscription sessions;
- local model runtimes;
- optional external APIs;
- external tools/connectors; and
- GitHub or other remote systems.

Required controls include:

- provider-owned authentication;
- credential/environment scrubbing for child processes;
- path and repository-scope enforcement;
- command allowlists and typed tool contracts;
- per-agent permissions;
- approval gates for side effects;
- same-origin and loopback protections for the local UI;
- tamper-evident or integrity-verifiable receipts where practical;
- dependency and adapter provenance;
- prompt-injection-aware treatment of repository and tool content; and
- clear incident diagnostics and revocation paths.

## 13. What makes DevHarmonics different

Many products provide one agent, multiple chat tabs, a provider switcher, or a generic subagent function. DevHarmonics is differentiated by combining:

- PM-level control of ongoing product-development programs;
- heterogeneous subscription, local, and optional API model pools;
- live discovery and qualification of newly released models;
- independent per-role and per-task model selection;
- resource-, quota-, quality-, and dependency-aware scheduling;
- unlimited-by-product-design concurrent agent composition;
- durable cross-agent memory and handoff;
- multi-repository integration sets;
- deterministic evidence and independent review;
- pilot-to-scale campaign control, adversarial review quorums, verification-integrity checks, and differential evidence;
- resource-aware sharding, diagnostic fan-out, restart-safe stage gates, and honest regression accounting;
- explicit human authority boundaries; and
- a local-first operating model.

The moat is not access to any one model. It is the accumulated operational intelligence that learns which available models, settings, tools, and team structures reliably accomplish particular kinds of work on the user’s real products.

## 14. Current baseline and delivery roadmap

### 14.1 Current implementation baseline: v0.5.1

The current release already provides:

- a local dashboard and CLI;
- subscription-backed Codex, Claude Code, and Gemini/Antigravity adapters;
- provider installation/authentication checks;
- typed dependency planning;
- manual or architect-selected concurrency with no built-in ceiling;
- isolated Git worktrees;
- allowlisted validators and receipts;
- bounded retries and provider rotation;
- serial integration branches;
- read-only final review;
- SQLite run/task/attempt/check/event persistence; and
- active-run cancellation;
- durable Observe, Supervised, and Bounded run modes;
- fail-closed Observe task contracts and substantive diagnostic-result validation;
- live subscription, Ollama, Claude-catalog, Antigravity, and OpenRouter model discovery;
- qualification fingerprints, history, pins, exclusions, family tracking, and health cooldowns;
- explicit model-tier routing for Codex Sol/Terra/Luna and profiled Claude, Gemini, Antigravity, Ollama, and OpenRouter candidates;
- uncapped adaptive capacity brokering, blackboard handoffs, and bounded context packs;
- guarded OpenRouter connection and paid-routing policy with catalog, cost, and limit controls;
- chunked local-model review of diffs and diagnostic reports with fail-closed verdict aggregation; and
- a successful no-write CivicSuite Observe pilot with three parallel cited diagnostics and local Qwen review;
- scheduler-time exact-model qualification and fair independent selection across Codex, Claude, Gemini/Antigravity, Ollama, and explicitly enabled OpenRouter candidates;
- replayable routing-score explanations, workload-specific empirical worker and reviewer observations, and user-controlled observation baselines; and
- retained CivicSuite v0.4 acceptance evidence plus verified full-width and compact cockpit behavior.
- durable structured objectives, immutable plan revisions, exact-revision approval, and read-only multi-model Workbench discussions;
- bounded qualified local-model implementation through scoped read/search/hash-checked-patch tools;
- a product/repository registry, source-backed product intelligence, cross-repository impact planning, and exact multi-repository integration sets;
- configured independent review quorums with repository-scoped fixer tasks, revalidation, invalidation, and re-review; and
- review receipts cryptographically bound to the exact plan, check evidence, task reports, diff, and repository base/HEAD set.

It does not yet provide the complete product defined here. Approved branch/draft-PR delivery, a completed real CivicSuite implementation, live run steering, proven in-run provider/local fallback, restart reconstruction for interrupted multi-repository integration sets, reusable development workflows, campaign orchestration/recovery, and ACP runtimes remain active roadmap work.

### 14.2 Milestone A: Personal production cockpit

Goal: make DevHarmonics reliable enough for Scott’s recurring daily development work.

Priorities:

1. restart-safe run reconciliation and resume;
2. explicit per-role provider/model/effort configuration;
3. live model registry for existing subscription providers;
4. model qualification states and routing explanations;
5. quota/error classification and safe fallback;
6. Ollama discovery, capability inspection, resource inventory, and local-worker execution;
7. health-check queue, cooldowns, and runtime capacity states;
8. shared run blackboard, token-aware context budgets, and structured agent envelopes;
9. empirical model/role analytics and a read-only Run Reporter;
10. improved evidence, diff, and approval views;
11. reusable product/workspace registration;
12. persisted live events and browser reconnection;
13. friendlier Windows launcher/installer and provider onboarding; and
14. one successful bounded CivicSuite single-repository pilot.

### 14.3 Milestone B: CivicSuite multi-repository pilot

Goal: safely coordinate real work across the CivicSuite program.

Priorities:

1. multi-repository workspace and typed repository relationships;
2. umbrella/specification/compatibility context ingestion;
3. cross-repository impact analysis and integration sets;
4. durable decisions, risks, and plan revisions;
5. product-level dashboard and objective history;
6. independent specialist reviews and evidence packages;
7. GitHub issue, pull-request, CI, and release read integration;
8. approved draft PR creation and cross-repository delivery summaries;
9. CivicSuite release-truth audit workflow; and
10. repository Workbench and objective refinement; and
11. one successful bounded cross-repository CivicSuite objective.

### 14.4 Milestone C: Adaptive AI workforce

Goal: make model coordination and scheduling the product’s standout capability.

Priorities:

1. automated model-catalog refresh and signed compatibility metadata;
2. role-specific audition harnesses and historical fixtures;
3. empirical performance profiles from real runs;
4. capacity-aware scheduling across subscriptions and local hardware;
5. critical-path and quota-window optimization;
6. controlled automatic model upgrades and rollback;
7. dynamic task splitting, replanning, and handoff;
8. ACP transport where it improves interoperability;
9. broader MCP/tool/skill registry; and
10. coordinator policies that learn from validated outcomes without silently changing user authority;
11. campaign stages, representative pilots, promotion gates, and resource-aware shards;
12. configurable adversarial review/fix/re-review topologies; and
13. diagnostic partitioning, test-integrity controls, differential evidence, and regression accounting.

### 14.5 Milestone D: Optional API and ecosystem breadth

Goal: expand the locally operated factory's available models, tools, and integrations without creating a DevHarmonics cloud platform.

Priorities:

1. opt-in OpenRouter with explicit OAuth connection, activated model, privacy, and spending policy;
2. cost-aware routing and budgets;
3. additional local runtimes and direct APIs where justified;
4. ACP and ecosystem packaging for providers, tools, workflows, skills, and qualification suites;
5. GitHub and optional Linear triggers under local policy;
6. portable workflow, objective, evidence, and delivery-handoff bundles for a very small team when useful; and
7. local analytics and evaluation-driven workflow/model improvement.

Milestone D does not include DevHarmonics-hosted execution, remote workers that continue while the computer is off, enterprise IAM/compliance/secrets administration, or a mandatory team service.

## 15. CivicSuite acceptance ladder

DevHarmonics becomes CivicSuite-ready incrementally.

### Level 1: Observe

- Register the organization’s local repositories.
- Map repository roles and dependencies.
- Read umbrella status, architecture, compatibility, and repository instructions.
- Produce a cited impact report without changes.

### Level 2: Single-repository implementation

- Complete a bounded task in one module worktree.
- Run repository-native validation.
- Preserve exact agent/model/check receipts.
- Return a reviewable integration branch.

### Level 3: Resilient execution

- Continue a task after one subscription provider becomes quota-limited.
- Hand off to another qualified subscription or local model without losing state.
- Record why the switch occurred and how equivalence was verified.

### Level 4: Cross-repository delivery

- Plan and execute a bounded change across at least two repositories.
- Validate each repository and the combined integration set.
- Identify version, compatibility, documentation, and release implications.
- Prepare reviewable branches or draft pull requests without merging them.

### Level 5: Release evidence

- Run a defined CivicSuite release-truth or installer-readiness workflow.
- Correlate commits, pins, versions, artifacts, documentation, and tests.
- Report what is proven, what is not proven, and which human approvals remain.

The immediate target is Levels 1–2, followed by Level 3. Levels 4–5 define the product’s proof of maturity.

## 16. Success measures

The product should measure outcomes that improve Scott’s work rather than vanity activity.

Key measures include:

- time from objective to approved plan;
- time from plan approval to evidence-backed result;
- percentage of tasks passing on first attempt;
- percentage recovered through useful feedback or fallback;
- human interventions required per objective;
- critical-path idle time caused by scheduling;
- duplicated/conflicting agent work avoided;
- provider quota wasted on unsuitable tasks;
- local-model work successfully offloaded;
- validation and independent-review defect catch rate;
- live steering actions applied without losing accepted work or evidence;
- resume success after interruption;
- cross-repository consistency defects found before release;
- workflow, skill, routing, and model experiment recommendations accepted, rejected, or rolled back;
- triggered objective drafts that become useful approved work rather than duplicate or noisy runs;
- model-upgrade recommendations accepted, rejected, or rolled back; and
- percentage of final claims backed by complete evidence.

The north-star measure is:

> Useful product objectives completed to Scott’s acceptance with less coordination effort and no reduction in safety, traceability, or release honesty.

## 17. Non-goals

DevHarmonics is not intended to:

- become a general-purpose consumer chatbot;
- become a cloud hosting platform, hosted control plane, or remote sandbox provider;
- continue active or scheduled work on DevHarmonics infrastructure while the user's computer is off;
- manage a corporate engineering workforce or become an enterprise IAM, compliance, or centralized secrets-administration product;
- replace Git, repository-native tests, CI, code review, or release governance;
- collect or centrally manage provider passwords;
- require API keys or cloud hosting for normal use;
- treat all models as interchangeable;
- silently merge, deploy, publish, sign, spend, or delete;
- guarantee that a subscription provider exposes a stable automation interface forever;
- hide provider or model failures behind a false success state;
- infer production readiness from passing unit tests alone; or
- optimize for the maximum possible number of agents when fewer agents produce a safer or faster result.

## 18. Product decisions and open questions

### Decided

- Product name: DevHarmonics.
- Primary design customer: Scott Converse.
- Primary proving ground: CivicSuite.
- Local-first control plane and dashboard for a solo product owner or very small product team; no DevHarmonics cloud-hosting platform.
- Active work stops when the user's computer is off and resumes from the durable local ledger after restart.
- Enterprise workforce management, IAM, compliance administration, and centralized secrets administration are out of scope.
- Subscription-backed Codex, Claude, and Gemini are first-class.
- Ollama/local models are first-class target capability.
- OpenRouter/API access is optional and disabled until explicitly configured.
- No arbitrary built-in agent-count ceiling.
- Models are selected independently per role/task.
- Live model discovery, qualification, scheduling, fallback, and upgrade coordination are core differentiation.
- Health-aware capacity queues, empirical role scoring, blackboard/context management, structured result envelopes, persisted event reconnection, run reporting, analytics, and ledger-boundary redaction are required parts of that coordination layer.
- Live run steering, GitHub/Linear development triggers, approved draft-PR handoff, version-controlled workflows/skills, and evaluation-driven improvement are required product capabilities.
- Email and chat integrations, if ever added, default to notifications or approval links and do not authorize arbitrary message-driven development runs.
- Git isolation, deterministic validation, durable evidence, and human approval boundaries are mandatory.

### Open

- Which provider/agent transports should use ACP first, based on stable real-world support?
- Which subscription model-catalog mechanisms are sufficiently structured and supported for production adapters?
- What initial audition suite best predicts success on Scott’s and CivicSuite’s actual workloads?
- How should historical prompts and model outputs be retained, redacted, or compacted by privacy policy?
- What Windows packaging approach provides the best upgrade and recovery experience?
- When should DevHarmonics offer automatic provider CLI updates versus instructions only?
- What licensing model best supports public adoption while protecting sustainable development?
- Which GitHub write actions should first be available under approval: draft issues, draft pull requests, comments, or project updates?

Open questions are design work, not permission to weaken the decided principles.

## 19. Definition of a great DevHarmonics result

A great run ends with more than “the agents finished.” It provides:

- the objective and approved scope;
- the plan and every material revision;
- the tasks completed, blocked, deferred, or rejected;
- the exact repositories, branches, worktrees, and commits;
- every provider, model, reasoning setting, agent role, and handoff;
- the tools used and permissions exercised;
- validator, review, and artifact evidence;
- quota or fallback events;
- unresolved risks and honest readiness status;
- a concise explanation of what changed and why; and
- explicit choices for review, merge, follow-up, release, or abandonment.

If Scott can trust that package, understand it quickly, and use it to move CivicSuite or another product forward, DevHarmonics is doing its job.
