# Integration Sets

An **integration set** is the unit a cross-repository change is judged as: an
exact, per-repository `{repository, baseCommit, workerBranch,
integrationBranch}` tuple for every repository the change touches, planned
together and integrated together. A set is never partially "ready" — it is
READY only when every member repository integrated cleanly; otherwise the
whole set is not ready, no matter how many members individually succeeded.

`scripts/integration-set.mjs` is the multi-repo orchestration layer over the
existing single-repo engine (`scripts/integrate.mjs`, spec: `docs/SPEC.md`
§2.3 / §4 slice 7). It plans which repositories/commits/branches are in play
and fans work out across them; it never re-implements a gate. Every member's
empty-diff check, tampercheck run, and merge are the SAME
`integrateWorkerBranch` call `integrate.mjs` already proves out for one
repository — this module only decides which repositories, which commits, and
how to read the combined result.

## Invariants

- **One repository per task.** A single planned unit of work touches exactly
  one repository. A cross-repo change is expressed as several tasks — one per
  repository — bound into one set, never as one task editing several repos.
- **Per-repository integration branch + worktree, pinned to a retained base
  commit.** `planIntegrationSet` resolves and freezes each member's base
  commit at PLAN time (`baseCommit`). Integration runs against that exact
  pinned commit, never whatever the base ref has since moved to — a set is
  judged against the world as it looked when it was planned.
- **Same-repository merges serialize; different repositories proceed
  concurrently.** `integrateSet` runs every member through `Promise.all`. Safe
  only because (a) `planIntegrationSet` refuses a plan where two members
  share a repository, and (b) `integrateWorkerBranch` already serializes any
  contention on one repository via its own file lock (`scripts/slots.mjs`).
  Nothing here adds, needs, or duplicates a lock.
- **Readiness is judged as a set: all-or-nothing.** `setReady` is `true` only
  when every member's `integrated` is `true` — no partial-READY state. A
  member that integrates cleanly while a sibling is refused is not rolled
  back (no cross-repo transaction exists to do that) and not reported as a
  plain success either: its `reason` becomes `advanced-but-set-blocked`, so
  nothing downstream mistakes a set-blocked branch for owner-ready state.
  Honest partial truth, not fake atomicity.
- **A blocking finding must name exactly one repository, or the set fails
  closed.** `scopeFinding` resolves a finding to one `repositoryId` via an
  explicit field or a recognized `"<repositoryId>:"` prefix on
  `finding.location`. Zero matches, more than one, or an id outside the set
  all refuse (`scoped: false`); the caller must then treat that finding as
  blocking the whole set. This function never guesses.

## What v1 deliberately does NOT do

- **No cross-repo atomic merge or rollback beyond refusing to advance.**
  Members that already integrated stay integrated when a sibling is refused.
- **No restart/reconstruction of an interrupted set.** If the process dies
  mid-`integrateSet` there is no saved-set-state to resume; a re-run re-plans
  and re-integrates from scratch, it does not reconstruct a prior attempt.
- **No single task mutating several repositories** — enforced structurally
  (one repository per member), not left as a convention.
- **No cross-repo dependency ordering.** All members integrate concurrently;
  v1 has no notion of "integrate A before B."

## Failure modes and refusal reasons

| Stage | Reason | Meaning |
|---|---|---|
| `planIntegrationSet` | throws (fail closed) | Empty/non-array `members`; duplicate `repositoryId`; two `repositoryId`s resolving to the same repository root; `repository` missing, not a directory, or not a git root; `workerBranch` or an explicit `baseRef` that doesn't resolve to a commit. A malformed plan is refused before anything runs. |
| per member (`integrateWorkerBranch`, reused) | `empty-diff` / `tampercheck-findings` / `tampercheck-unavailable` / `merge-conflict` | Unchanged from `scripts/integrate.mjs` — see that module. |
| per member, set-level annotation | `advanced-but-set-blocked` | This member integrated cleanly, but a sibling member did not, so the set overall is not ready. |
| per member, defensive | `integration-error` | `integrateWorkerBranch` threw for this member (e.g. the repository changed underneath a planned set between plan and integrate). Never allowed to crash the other members' results; recorded as refused, never as a pass. |
| `scopeFinding` | `scoped: false` | The finding names no repository, names more than one (an explicit `repositoryId` disagreeing with a location prefix counts as two), or names one outside this set. |

## Evidence

`integrateSet` always writes `set.json` at `evidenceRoot` — for every outcome,
including a fully refused set — recording `setId`, `setReady`, `blockedBy`,
and per member: `repositoryId`, `baseCommit`, `workerBranch`,
`integrationBranch`, `integrationHead` (or `null`), gate results, and reason.
Each member's own `integrateWorkerBranch` evidence bundle (`integration.json`
+ `tampercheck-output.txt`) lives nested under
`evidenceRoot/members/<repositoryId>/`.
