# Live-fire lane (opt-in, costs real tokens)

`npm test` proves the engine against fixtures. These scripts prove it against the
**real** things: the installed `tampercheck` binary, a validator that genuinely
executes a test suite, and a real model reviewer over the subprocess lane.

They are **not** part of `npm test` — they spawn a metered provider call per member
and take about a minute. Run them deliberately.

An independent audit (2026-08-05) noted that no retained real-provider /
real-integrity-gate proof existed and that the passing suite relied on fixtures for
exactly those boundaries. This lane is the answer, and the observed results below are
the retained receipts.

## Running

```bash
node livefire/set-advance-path.mjs            # expect exit 0
node livefire/set-refusal-path.mjs            # expect exit 0 (a refusal is the pass)
node livefire/budget-cap.mjs                  # expect exit 0 (two small claude calls)
```

Optional arguments: `<repoPath> <model>` — both default sensibly (the repo this
script ships in, and a small fast model). Prerequisites: `git`, a real `tampercheck`
on `PATH`, and a signed-in `claude` CLI. Each script builds throwaway git
repositories under the OS temp directory and removes them afterwards.

## What each one proves

**`set-advance-path.mjs` — the advance path.** Two self-contained JavaScript
repositories (an umbrella API plus a module client that takes its dependency by
injection, so each repo's tests pass alone) make a coordinated change. Runs with
`--check "node --test"` and `--require-evidence validator,review`, i.e. the strict
floor. Asserts `setReady === true`, both integration refs advanced to real merge
commits (two parents), and every member reports `assurance: validated+reviewed`.

**`set-refusal-path.mjs` — the refusal path.** Same shape, but the change is
incomplete relative to its stated goal. Asserts the reviewer refuses, the set is
blocked, and **no integration ref moves in any repository** — the two-phase
atomicity guarantee, verified with real components rather than fakes.

**`budget-cap.mjs` — the `--max-budget-usd` spend ceiling (audit residual R-1).**
Two real subprocess-lane worker runs against the installed `claude` CLI: a
generous cap that must complete with the flag recorded in the receipt's args
(proving the real CLI accepts it), and a $0.000001 cap to observe the real
enforcement behavior rather than assume it.

## Observed results (retained)

`set-advance-path.mjs`, 2026-08-05, `claude-haiku-4-5-20251001`, ~47s:

```
umbrella: validator=pass(exit 0) tampercheck=pass finalArtifact=pass review=READY(0 findings)
          assurance=validated+reviewed  ref advanced, parents=2
module:   validator=pass(exit 0) tampercheck=pass finalArtifact=pass review=READY(0 findings)
          assurance=validated+reviewed  ref advanced, parents=2
setReady=true blockedBy=[]            => PROVEN
```

`set-refusal-path.mjs`, 2026-08-05, same model: both members' gates passed
(`tampercheck` against the real `C:\Users\scott\.local\bin\tampercheck.EXE`,
sha256 recorded in the evidence), the reviewer returned `NOT_READY`, and both
integration refs stayed at their pinned base commits. (Re-run 2026-08-05
evening on a fresh session with the same result: reviewer refused with a real
finding, `advanced=false` in both repositories, exit 0.)

`budget-cap.mjs`, 2026-08-05, `claude-haiku-4-5-20251001`:

```
run 1 (cap $0.50):     status=completed exit=0 --max-budget-usd 0.5 costUsd=0.0266
run 2 (cap $0.000001): status=failed exit=1 --max-budget-usd 0.000001 costUsd=0.0006
LIVE-FIRE VERDICT: --max-budget-usd was emitted to and accepted by the real claude CLI
```

Observed enforcement semantics, worth knowing before relying on it: the ceiling
is enforced by the CLI as an **overage stop, not a pre-flight guarantee** — the
$0.000001 run still spent $0.0006 before the CLI failed it (exit 1). So the flag
genuinely bounds a runaway worker, but a single small call's cost can land
before the stop triggers.

## Two real defects this lane caught that fixtures did not

Worth stating, because it is the argument for keeping the lane:

1. **Per-member reviewers were blind to their siblings.** Each reviewer saw one
   repository while being judged against a set-wide goal, so a real model refused
   with *"client.py calls get_user(include_email=...) but api.py shows zero
   changes"*. Every coordinated change would have been blocked. Members now receive
   a scoped goal plus their siblings' diffstats.
2. **The reviewer's prompt lacked the validator result**, so it refused for "no proof
   the tests ran" even when a check had run. The real check receipt is now threaded
   through.

It also independently flagged check-theater — refusing a change whose validator was
`node -e process.exit(0)`, a no-op against a Python suite. A passing check is not
evidence unless the check actually exercises the code.
