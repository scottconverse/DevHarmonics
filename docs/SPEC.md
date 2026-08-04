# DevHarmonics — Specification & Implementation Plan

**Name:** DevHarmonics (second architecture; designed under the working name AnythingFactory). The first architecture is preserved privately as `devharmonics-v1`.
**Date:** 2026-08-04 · **License:** Apache-2.0 · **Owner:** Scott Converse

---

## 0. Compatibility research findings (asked and answered)

**Antigravity (agy):** No native ACP as of mid-2026 — confirmed by an open feature request ([antigravity-cli #31](https://github.com/google-antigravity/antigravity-cli/issues/31)) and a Google AI forum thread complaining about exactly this. But `agy -p "prompt"` Command Mode is a real headless one-shot (pure Go, replaced Gemini CLI June 2026, works fine in headless environments). Two community ACP adapters exist ([agy-acp](https://github.com/jiridanek/agy-acp), [antigravity-acp](https://github.com/shubzkothekar/antigravity-acp)) — treat as unvetted third-party until qualified. **Verdict: subprocess lane today, ACP lane when Google ships it officially.**

**LM Studio / Bionic:** LM Studio has a **native Anthropic-compatible `/v1/messages` endpoint** ([official docs](https://lmstudio.ai/docs/developer/anthropic-compat)) at `http://localhost:1234` — and this machine already runs it (Gemma-4-12B). Bionic (launched 2026-07-16) is LM Studio's standalone desktop agent for repo-aware coding on open models, with optional Secure Cloud offload. **Verdict: LM Studio joins the HTTP lane immediately — identical client to Ollama, different port. Bionic is a candidate coordinator host later; its headless story is unverified and not a v1 dependency.**

**AnythingLLM:** An orchestration/RAG app that *delegates* model execution to Ollama/LM Studio/cloud — workspaces, multi-step agents, developer API, MCP compatibility. It is **not a repo-aware coding agent** (no worktrees, no diffs), so it is not a worker lane. **Verdict: peaceful coexistence on the same local model pool; optional future integration is exposing factory status over MCP so AnythingLLM (or any MCP client) can query it. Not a v1 concern.** Its real significance is as evidence: the Anthropic/OpenAI-compatible HTTP surface has become the universal join point for local AI apps — which is exactly the bet the HTTP lane makes.

---

## 1. What DevHarmonics is

A **local-first, host-agnostic software factory**: any agent app the owner is sitting in can coordinate; any qualified model, over any of three lanes, can work; every target repository carries its own independent enforcement (rigor-suite); every consequential action waits for the owner; all evidence lands in append-only local receipts.

The one-sentence test for every design decision: **the factory must survive any single vendor, app, or model disappearing.**

### What it is not (scope brake — binding)

- **Not a UI.** Emdash (Apache-2.0, 35 providers, Windows) is the human cockpit. The factory is scripts, receipts, and skills. At most a read-only status export.
- **Not a router-optimizer.** Qualification is an *admission gate* (may this model do this role at all), never a ranking engine. No maintainability indexes, no cost counterfactuals, no empirical-profile routing. (Manifest deprecated theirs; DevHarmonics' rewarded green-ness. Both lessons are priced in.)
- **Not a campaign platform** in v1. No stages/pilots/shards/promotion. That's a later decision, made only if real use demands it.
- **Not a 482-row spec.** This document is the whole spec. Growth requires deleting something of equal weight or an explicit owner decision.

---

## 2. Architecture

```
┌─ COORDINATOR (judgment) ── whichever app the owner is in ──────────────┐
│  Cowork/Claude · Codex app · Antigravity · (Bionic later)              │
│  thin per-host skill file → drives the same factory CLI                │
└────────────────────────────┬───────────────────────────────────────────┘
                             │  plain Node scripts (the factory)
┌────────────────────────────┴───────────────────────────────────────────┐
│  SPINE: intake · qualification · slots · budget ledger · dispatch ·    │
│         worktrees · integration sets · receipts · doctor               │
└──────┬──────────────────┬──────────────────────┬───────────────────────┘
       │ LANE A: ACP      │ LANE B: HTTP          │ LANE C: subprocess
       │ @agentclient-    │ Anthropic Messages    │ headless CLIs
       │ protocol/sdk     │ format, base-URL-     │ codex exec ·
       │ + adapters       │ switched:             │ claude -p ·
       │ (claude, codex,  │ Ollama :11434 ✓       │ agy -p
       │  ~20 more)       │ LM Studio :1234 ✓     │ (subscription auth,
       │                  │ LiteLLM :4000         │  no API keys)
       │                  │ Claude API (opt-in)   │
┌──────┴──────────────────┴──────────────────────┴───────────────────────┐
│  CONSCIENCE (rigor-suite — already shipped, factory-independent):      │
│  tampercheck at every integration boundary + pinned in each repo's CI  │
│  deterministic-detector qualifies each repo's test suite               │
│  dev-rigor-stack-lite skills = coordinator discipline, all hosts       │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Coordinator plane

Coordination is judgment plus a CLI. The factory ships as plain Node 24 scripts (the codex-factory pattern, proven this week) with one thin skill file per host app telling that app's model how to drive them. The owner never writes factory JSON; the coordinator creates the internal plan from a natural-language request via an intake command.

**Proven already:** this session drove codex-factory's full pipeline (intake → qualify → campaign preview → live worker attempts) from Cowork. Coordination is not vendor-gated.

### 2.2 Worker lanes

| Lane | Transport | Covers | Auth | Status |
|---|---|---|---|---|
| A: ACP | `@agentclientprotocol/sdk` 1.3.0 (npm, verified) over stdio to per-provider adapters | Claude (`@zed-industries/claude-code-acp` 0.16.2, `@agentclientprotocol/claude-agent-acp` 0.64.2 — both on npm, verified), Codex (codex-acp binary), ~20 more per Emdash's registry | Provider-owned | SDK verified on npm; adapters to qualify per-provider |
| B: HTTP | One Anthropic Messages client, base URL + model as config | Every Ollama model (:11434 — **proven live on this box**), every LM Studio model (:1234 — official docs, server already running here), LiteLLM bridge (:4000), real Claude API (explicit opt-in only) | None locally; API key only for the opt-in cloud case | Text path proven; tool-use through compat layers is a qualification item, not an assumption (Ollama ignores `tool_choice`, drops `cache_control`) |
| C: Subprocess | Supervised child process, prompt over stdin, JSON output parsed | `codex exec` (ChatGPT/20x-Pro auth — **proven live**), `claude -p` non-bare (claude.ai OAuth from keychain — flags verified: `--output-format json`, `--model`, `--max-turns`, `--max-budget-usd`, `--permission-mode dontAsk` + `--allowedTools` + `--add-dir`), `agy -p` (Command Mode) | Subscription CLIs, no API keys | The default lane; carries everything ACP doesn't cover yet |

All three lanes emit **one receipt schema**: requested model, resolved model (or explicitly `unverified`), lane, args/base-URL, prompt hash, events, final artifact, usage (tokens and/or `total_cost_usd` — the schema holds both, since Codex reports tokens and Claude reports USD), exit/stop reason, timestamps, duration.

### 2.3 Spine (ported, not reinvented)

From **codex-factory** (`factory-fleet.mjs`, `factory-admission.mjs`, `factory-slots.mjs`, `factory-process.mjs` — Scott's code, Apache-2.0, live-fire tested this week):

- **Qualification:** SHA-256 fingerprint over candidate ID + runtime/adapter versions + capabilities + model digest + tier + reasoning effort + versioned role-harness ID. Role-scoped (analysis / benchmark / structured_write / workspace_write). A write role requires *both* its own harness pass *and* the reasoning benchmark (the gemma4:e4b lesson: passing one narrow test ≠ trustworthy). Fingerprint change ⇒ stale ⇒ requalify. Fail closed.
- **Admission:** append-only `usage.jsonl`, reservation before spawn, terminal reconciliation after, unknown paid usage closes the paid lane, `reconcilePaidUsage` (never hand-editing) for honest corrections. Local models: wall-time/concurrency caps; tokens are telemetry, not budget.
- **Slots & supervision:** file-lock worker slots, single-use task IDs, owned process trees, wall-clock timeout, dead-PID reclaim only.
- **Windows lessons (all three found live this week, fixes specified in the codex-factory directive):** real PATH+PATHEXT resolution with extensions-before-bare-name ordering; `.cmd`/`.bat` spawn needs the explicit `ComSpec /d /s /c` wrap (not `shell:true` — DEP0190); per-CLI trust flags like `--skip-git-repo-check` for scratch fixtures. **Every lane gets live-fire testing on Windows before it's called supported. Shims lie.**

From **DevHarmonics** (frozen, private, Scott's code — port the *designs*):

- **Integration sets** (the genuinely novel piece — §4 slice 7): per-repository exact base commit, isolated integration branch + worktree per repo, serialized same-repo merges, readiness judged **as a set**, blocking findings must name exactly one repository or fail closed.
- **Empty-diff gate:** a write task whose branch changed nothing does not pass; one bounded retry with the fact stated plainly.
- **Review decorrelation (pragmatic subset):** an artifact-lens reviewer (sees diff + receipts, never worker narration) plus a deterministic claims-vs-diff comparison. The full two-lens quorum machinery only if real use shows the subset leaking.

### 2.4 Conscience (rigor-suite — zero new build)

- **tampercheck** (PyPI 0.1.1, pinned): runs at every integration boundary — `tampercheck --from <base>`; exit 1 blocks acceptance and routes findings to fixer/reviewer; **exit 2 never counts as a pass**. Also pinned into each target repo's CI as a promotable required check, so the gate holds even when the factory is bypassed entirely. Worker prompts state that the diff will be tamperchecked; legitimate test removals are self-justified inline (`tampercheck: allow <file> <reason>`) and the justification flows into the receipt.
- **deterministic-detector** (0.4.0): qualifies target *repos* the way the factory qualifies models — randomized order, pollution detection, diff-scoped mutation. A repo whose suite hasn't been proven sensitive gets its validator-green labeled accordingly in receipts.
- **dev-rigor-stack-lite**: the coordinator's operating discipline (lanes, gates, receipts), installed per host. **Doctor asserts skill-version parity across all coordinator hosts** — the `.claude` 0.4.3 vs `.codex` 0.5.1 drift is a known live bug class.
- **rigor-suite installer**: the repo-onboarding ceremony for every new portfolio member (CivicSuite modules, CivicNewspaper, CivicLibrary).
- **Known gap:** tampercheck speaks Python + JS today; Rust patterns (CivicSuite Tauri desktop) are a pattern-table addition needed before the factory leans on it for those repos.

### 2.5 Boundaries (non-negotiable, inherited from everything that worked)

- Dry-run default; `--execute` explicit. No auto-merge, no auto-tag, no standing approvals — push ≠ PR ≠ merge ≠ tag.
- Nothing leaves the machine without a per-action owner approval. External writes off by default.
- Credential-shaped env vars stripped from worker child processes; provider auth stays provider-owned.
- Evidence over confidence: `process_completed` ≠ acceptance; a reviewer's READY ≠ merge; only the owner closes a loop.
- Fail closed on missing evidence, always. A crashed check is never a passed check.

---

## 3. Host compatibility matrix (v1 targets)

| App | As coordinator | As worker | Notes |
|---|---|---|---|
| Cowork / Claude | ✓ skill file | ✓ `claude -p` (C), ✓ ACP (A) | Both ACP adapters on npm; `-p` non-bare uses claude.ai OAuth |
| Codex app | ✓ SKILL.md (pattern exists) | ✓ `codex exec` (C — proven), ACP via codex-acp (A) | ChatGPT/20x-Pro auth proven live |
| Antigravity | ✓ skill file | ✓ `agy -p` (C) | ACP pending official; community adapters unvetted |
| Ollama models | — | ✓ HTTP (B — proven) | Anthropic `/v1/messages`, port 11434 |
| LM Studio models | — | ✓ HTTP (B) | Anthropic compat, port 1234, already running here |
| Bionic | future candidate | via LM Studio HTTP today | Headless story unverified; not a v1 dependency |
| Emdash | — (it's the cockpit) | — | Human UI alongside; packages not on npm, not a code dependency |
| AnythingLLM | — | — | Coexists on the model pool; optional MCP status surface later |

---

## 4. Implementation plan

**Ground rules:** New repo (leave codex-factory intact — Codex is fixing its Windows bugs per the standing directive; harvest modules from it with their tests once merged). Node 24, plain `.mjs`, dependency budget: `@agentclientprotocol/sdk` and nothing else without an owner decision. **CI runs the full suite on Windows + Ubuntu from slice 0** — the codex-factory lesson (its CI ran only the website build; three shippable bugs hid behind a shim for its whole life). Every slice ends with a **live-fire acceptance** against real tools on this machine, receipts verbatim, `proved:` line — never shim-only green. Slices are sequential; each is independently useful; stopping after any slice leaves a working tool.

**Slice 0 — Skeleton + doctor.**
Repo scaffold, receipt/config schemas, CI (both OSes, full suite, from the first commit). `doctor`: detect each provider CLI via real PATH+PATHEXT resolution, probe HTTP endpoints (11434 / 1234 / 4000) with a real Messages request, report rigor-suite presence + skill-version parity per host, each capability PASS/FAIL/SKIPPED — never inferred.
*Accept: doctor output on this machine matches reality, including one deliberately broken probe reporting FAIL.*

**Slice 1 — Subprocess lane (C).**
Generic supervised headless adapter: per-provider arg templates (codex / claude / agy), prompt over stdin or argv per provider contract, JSON/stream parsing, receipts, wall-clock + turn/budget caps where the CLI supports them, Windows spawn hardening baked in.
*Accept: the same bounded task (implement `add()` against a failing test in a scratch repo) executed by all three CLIs live, three receipts, diffs real.*

**Slice 2 — HTTP lane (B).**
One Anthropic Messages client, base-URL-switched. Tool-use qualification probe per endpoint (don't assume compat layers translate tools). The structured-file patch path (model returns complete file text, factory validates paths, writes in isolated worktree, runs check, commits only on green) as the write mode for models that fail agentic tool use.
*Accept: same task via Ollama and LM Studio; tool-use probe result recorded per endpoint per model.*

**Slice 3 — Qualification + admission port.**
`factory-fleet` + `factory-admission` + `factory-slots` ported with their tests, extended to all three lanes (an HTTP endpoint+model is a candidate like any CLI). Benchmark-gate rule preserved.
*Accept: full qualification sweep on this machine's real fleet (3+ Ollama models, LM Studio, codex, claude, agy) producing an honest mixed pass/fail table like this week's — with at least one candidate correctly refused a write role.*

**Slice 4 — Single-repo pipeline.**
Intake (natural language → private plan; clean-worktree refusal; pinned base commit) → dispatch through slots → per-task validators → **tampercheck gate** → empty-diff gate → serial integration → receipt bundle → owner approval boundary. Emdash usable alongside as the observation cockpit.
*Accept: a real bounded CivicCast task lands on an integration branch with the full receipt chain, tampercheck receipt included, and one seeded gate-weakening worker attempt is caught and blocked.*

**Slice 5 — ACP lane (A).**
SDK client; Claude adapter first (both npm packages evaluated, one chosen with reason recorded), codex-acp second. Same receipt schema; ACP permission requests surface to the coordinator.
*Accept: slice-1's task via ACP-Claude with structured events in the receipt; a permission request round-trips.*

**Slice 6 — Review.**
Artifact-lens reviewer (independent model, sees diff + receipts, never narration) + deterministic claims-vs-diff divergence + bounded fixer round (fix invalidates prior review receipts, forces re-review).
*Accept: a seeded narrated-but-not-made change fails on divergence, mechanically; a real reviewed task reaches READY with the quorum receipt.*

**Slice 7 — Multi-repo integration sets.** *(The novel piece — design doc first, sized as its own unit.)*
Exact per-repo base pins, per-repo integration worktrees, cross-repo readiness as a set, one-repo-per-task, serialized same-repo merges, unscoped findings fail closed.
*Accept: a real two-repo CivicSuite change (umbrella + one module) reaches set-READY with per-repo receipts; a seeded breaking cross-repo change is refused.*

**Slice 8 — Portfolio onboarding + hardening.**
rigor-suite install as the intake ceremony for unonboarded repos; doctor asserts it; one hardening pass over the whole factory (falsification-focused: try to make each gate lie); user manual honest about every limitation.
*Accept: a never-onboarded repo goes zero-to-governed in one command; the falsification list and outcomes published in the repo.*

**Explicitly deferred (owner decision required to promote):** campaign kernel, Bionic as coordinator, MCP status surface for AnythingLLM/others, community Antigravity ACP adapters, Rust tampercheck patterns (needed before CivicSuite desktop repos lean on the gate), Emdash deep integration, and any *factory-built* dashboard — Emdash is the UI (its diff/branch/PR review works on the factory's worktrees and integration branches today, no integration needed); if live run-state in a UI is ever genuinely needed, the answer is a small read-only status export feeding an existing UI, never a web app of our own (DevHarmonics spent ~a fifth of its code on exactly that).

---

## 5. Decision record (why, in one line each)

- **New repo, not a codex-factory fork** — codex-factory stays a working, Codex-native tool with a fix in flight; the factory harvests proven modules instead of inheriting a Codex-shaped skeleton.
- **Three lanes, not one** — ACP is the future but partial (Antigravity absent); subprocess is the present and subscription-native; HTTP is the only lane local models actually speak. Any two would strand a real provider on this machine today.
- **Emdash as cockpit, not dependency** — its packages aren't on npm; its app is excellent; coupling to a YC startup's internals contradicts the survive-any-vendor test.
- **rigor-suite as the verification plane, no new verification code** — it shipped, it's pinned, it's factory-independent; building a second integrity layer inside the factory would recreate the DevHarmonics welding mistake.
- **Qualification ≠ routing** — admission gates are cheap and fail-closed; ranking engines are the documented failure mode of two products reviewed this week.
- **Spec stays this size** — DevHarmonics' spec hit 482 normative rows and became the reason "done" receded; this one fits in a sitting and changes only by trade or owner decision.
