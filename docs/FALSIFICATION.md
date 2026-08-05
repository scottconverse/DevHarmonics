# Falsification pass — 2026-08-05

An adversarial attempt to make each gate lie, run against the real code on the
development machine. Published whether or not the results are flattering: a
gate nobody has tried to deceive is not a proven gate.

Method: for each gate, construct the cheapest realistic deception and observe
what the gate actually does. Every result below was executed, not reasoned about.

| # | Attack | Result | Disposition |
|---|---|---|---|
| F-1 | Substitute an always-`exit 0` `tampercheck` earlier on `PATH`, then integrate a branch that skips a failing test | **Gate deceived** — the weakening integrated | Fixed (below) |
| F-2 | Can a worker reach the `PATH` that F-1 exploits? | Held — a child process cannot alter its parent's environment | Bounds F-1's threat model |
| F-3 | Forge a receipt claiming success (negative token usage; `resolutionVerified: true` with no resolved model) | Held — both refused at `validateReceipt` | No change |
| F-4 | Bypass the empty-diff gate with `git commit --allow-empty` | Held — refused `empty-diff` | No change |

## F-1 in detail

The integration gate resolves `tampercheck` from `PATH`. A binary earlier on
`PATH` that prints a clean line and exits 0 was accepted as authoritative, and
a branch that added `@pytest.mark.skip` to a failing test was integrated.

**Threat model, honestly bounded.** F-2 establishes that a *worker* cannot
mount this attack: workers run as child processes and cannot modify the
parent's `PATH`, and their sandbox is confined to a worktree that is not on
`PATH`. So F-1 is an operator-environment compromise, not a worker escape. That
distinction lowers the severity; it does not make the finding go away, because
a gate that cannot say *which* tool answered is not evidence.

**Fix.** `integrateWorkerBranch` accepts `expectedTampercheckVersion`. When set,
the resolved binary must self-report that version via `--version` before its
verdict is trusted; a mismatch refuses as `tampercheck-unavailable` and records
the resolved path plus what it actually reported. Verified after the fix:

- substituted stub with the check armed → **refused**, `tampercheck-unavailable`
- real `tampercheck` with the check armed → identity `pass` (`verified 0.1.1 at
  C:\Users\scott\.local\bin\tampercheck.EXE`), then correctly refused the
  weakening on its own merits (`tampercheck-findings`)

It is **off by default**, deliberately: an operator legitimately pinning a
different version should not be silently locked out. Turning it on is a
one-argument decision the owner makes.

**Defense in depth that already existed.** `devharmonics onboard` installs a
repo-side CI workflow that does `pip install tampercheck==0.1.1` — a second,
independent copy of the gate that a locally substituted binary cannot influence.
The factory-side check and the repo-side check would both have to be defeated.

## What this pass did not cover

- No attempt to defeat the review divergence gate by manipulating git plumbing
  directly (the gate compares `git diff --name-only` output; an attacker able to
  rewrite git's own output has already won more than this gate).
- No concurrency-race attack on the per-repository integration lock.
- No attempt against the ACP permission policy from a hostile adapter.

These are named rather than silently omitted. They are the next falsification
pass, not a claim of coverage.
