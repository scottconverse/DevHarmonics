# Audit Lite — Mellum2 scheduler integration
**Date:** 2026-07-15
**Scope:** Current uncommitted Mellum2 model-profile, qualification, routing, family-tracking, dashboard, tests, and related documentation changes.
**Reviewer:** AI agent (audit-lite)

## TL;DR
The scoped Mellum2 scheduler unit is ready to advance to its remaining live-machine and release gates. The final pass found no unresolved severity-ranked defects: role evidence is current-fingerprint specific, manual assignment cannot bypass it, specialist evidence is independent and non-leading, Instruct and Thinking cannot cross-promote, repository-wide writes stay out of the economy lane, and the dashboard now exposes only role-compatible choices.

## Severity rollup
- Blocker: 0
- Critical: 0
- Major: 0
- Minor: 0
- Nit: 0

## Findings

No unresolved findings in the audited scope.

## What's working
- Mellum2 Instruct and Thinking receive distinct families and capability profiles, preventing cross-variant family promotion (`src/model-intelligence.ts:181`, `src/model-intelligence.ts:206`; regression coverage at `test/core.test.ts:677`).
- The economy implementation lane now requires one non-root, non-glob scope whose single expected artifact matches that scope; repository-wide writes are excluded (`src/model-intelligence.ts:102-111`).
- `local-specialist-v2` does not expose the accepted answer, validates exact structured fields, rejects a reversed dimensional relationship, and checks the required hole count (`src/ollama.ts:323-349`; positive and adversarial coverage at `test/core.test.ts:708-810`).
- Scheduler first-use qualification requires both current role evidence and a current specialist benchmark, while final routing independently enforces current-fingerprint role evidence, capability compatibility, and the Mellum benchmark (`src/qualification.ts:53-99`, `src/routing.ts:183-203`).
- Manual assignment and family promotion no longer reuse stale role history; family-track prequalification calls the same current-role predicate (`src/server.ts:565-569`; regression coverage at `test/core.test.ts:846-869`).
- Local read-only tasks that require tools fail closed until a read-only tool loop exists, while mutating local work still requires the separate bounded-tool fixture (`src/qualification.ts:170-178`, `src/routing.ts:196`; regression coverage at `test/core.test.ts:935-959`).
- Activation cannot treat a benchmark-only model as operationally qualified, and dashboard counts, messages, and Settings selectors distinguish operational, specialist-benchmark, stale, and role-specific states (`src/server.ts:316-329`, `src/ui/app.js:122-149`, `src/ui/app.js:189-216`). Incompatible previously configured choices remain visible but disabled with an explicit warning.
- README, architecture, manual, product spec v1.6, implementation plan v1.8, and changelog consistently describe bounded local tools, separate Mellum variants, benchmark gating, and the still-pending live/release gates (`README.md:182`, `docs/ARCHITECTURE.md:73`, `docs/USER_MANUAL.md:178-186`, `docs/PRODUCT_SPEC.md:353`, `docs/IMPLEMENTATION_PLAN.md:693-706`, `CHANGELOG.md:10-17`).
- Independent verification passed: `npm.cmd run build` followed by the focused core/integration command completed with **11 tests, 11 passed, 0 failed**. This included Mellum profiles, non-leading specialist validation, stale-role rejection, benchmark gating, root-scope exclusion, local read-only tool rejection, and dashboard source assertions.

## Watch items
- This Audit Lite did not independently repeat the live installed-model qualification or black-box UI walkthrough. Those are correctly retained as explicit remaining v0.5 gates in `docs/IMPLEMENTATION_PLAN.md:1111` and should remain required before release.

## Escalation recommendation
No escalation needed. The scoped defects surfaced during the review were fixed with regression coverage before this final report; the remaining work is planned live acceptance and release-gate evidence, not an architectural audit blocker.
