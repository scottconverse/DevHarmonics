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

## Second pass — 2026-08-05 (the GauntletGate blockers, reproduced and closed)

The GauntletGate run (`docs/GAUNTLET-2026-08-05.md`) raised four blocking
findings via a subagent whose reproductions the coordinator never re-ran. This
pass reproduced each one against the real, unmodified modules — then fixed it and
re-verified the fix against a frozen clone of the committed code. Every result
below was executed, not reasoned about. (The original one-off exploit scripts
live in a local evidence directory on the owner's machine, outside this repo;
the *portable, re-runnable* proof against real tools now ships in-repo as the
`livefire/` lane — see `livefire/README.md` for what it proves and the
retained results.)

| # | Attack | Result before | Disposition |
|---|---|---|---|
| B-1 | Odd-quote-parity `&` in a `claude` prompt, delivered via argv through `claude.CMD` (an npm `%*` shim), to launch a second process | **Gate deceived** — a second, attacker-chosen process ran from one `-p <prompt>` argument, through the real `runWorker`→`superviseProcess` path (RCE) | Fixed — prompt moved to stdin |
| B-2r | Committed mode-`120000` symlink in `readPaths`, target outside the worktree | **Escaped** — outside file content reached the model prompt | Fixed — realpath containment |
| B-2w | Committed symlink in `writePaths`, target outside the worktree | **Escaped** — an out-of-repo host file was overwritten while the receipt reported "empty diff / nothing changed" | Fixed — realpath containment |
| C-2 | A worker plants a file the `--check` validator executes; does the validator see the operator's credentials? | **Leaked** — a fake `OPENAI_API_KEY` appeared in `stages.validator.stdoutTail` and the run reached `ready-for-owner-review` | Fixed — validator env stripped |
| C-1 | Embedded newline in an argv argument | Silently truncated the command line at the first CR/LF (dropping trailing safety flags) — but **failed closed**, no RCE or bypass, and it *masked* the B-1 worker→review capstone | Fixed (fail-loud refusal) + re-characterized to a reliability defect |

### B-1 in detail

`escapeCmdArg` is the cross-spawn recipe with a **single** caret pass, and it is
only ever reached for a `.cmd`/`.bat` target — which cmd.exe parses **twice**
(the `cmd /c` line, then the shim's `%*` re-expansion). A single caret survives
only the first parse; the metacharacter goes live in the second (the BatBadBut /
CVE-2024-27980 class). An empirical harness proved there is **no** cmd-arg
escaping that is both injection-safe for a `%*` shim and compatible with the
`%~1` de-quoting idiom the tampercheck fixtures use — double-escaping the
arguments broke 20 fixture tests. So the fix does not fight the escaping: it
keeps untrusted content off the command line entirely. `claude`'s prompt now
rides **stdin** (verified live: `claude -p --output-format json` reads its prompt
from stdin, including through the ComSpec wrap). `agy` is a native `.exe` that
never takes the wrap; `codex` already delivered via stdin. As defense in depth,
`escapeCmdArg` now refuses any argument containing a raw newline rather than
letting cmd.exe silently truncate the line (C-1).

### B-2 in detail

`assertRelativeRepoPath` validated path *strings* only — it never resolved the
real filesystem target, so a git-committed symlink (a legitimate mode-`120000`
object) was followed transparently by both `readFileSync` and `writeFileSync`.
The write side is the dangerous one: the write lands on the outside target
*before* the empty-diff check runs, and because git tracks the unchanged symlink
object rather than the resolved target, `git diff --cached` sees nothing — an
out-of-repo write reported as "nothing happened", exactly the false negative this
product exists to prevent. Verified live on Windows that `git worktree add`
materialises the committed symlink as a real NTFS symlink here (admin +
`core.symlinks=true`). Fix: `local-patch.mjs` resolves the real path of the
deepest existing prefix (collapsing every symlink, including intermediate
directory symlinks) plus any not-yet-created tail, and refuses anything that
lands outside the worktree — before reading and before writing.

### C-2 in detail

`workerEnv()` was correctly wired for the worker child and the ACP adapter, but
**not** for the `--check` validator in either lane. The validator executes inside
the very worktree the untrusted worker just committed to, so one planted line in
a test file (or a `pretest` hook) ran with every credential on the box, and the
leak propagated into `stdoutTail` → the receipt → the reviewer prompt. Fix: route
the validator's environment through `workerEnv()` in both `run-command.mjs` and
`local-patch.mjs`; `PATH` survives so the command still resolves and runs.

### Re-verification method

All fixes were re-verified against a **frozen clone** at commit `76a0576` in a
separate directory (`git clone` + checkout, so HEAD could not move underneath the
audit — the methodology weakness the first gate honestly flagged). A
self-contained script built fresh fixtures, imported only the clone's modules,
and re-ran all four attacks: all four reported BLOCKED. The full test suite is
green in the clone (bar one flaky ~50s real-probe `doctor` timeout under parallel
load, green in isolation).

### What this pass still did not cover

- No attempt against the ACP permission policy from a hostile adapter (still the
  next pass, as in the first pass above).
- The divergence gate's *positive* direction (a real worker-claims manifest vs
  the diff) is untested end-to-end because the subprocess lane emits no such
  manifest — the gate is now honestly reported as "not checked" rather than fed a
  self-comparison (finding M-1).

## Third pass — 2026-08-05, independent adversarial agents (round 2)

Two independent agents attacked the round-1 fixes and the surfaces the first gate
never touched, against a frozen clone; every finding was reproduced by the
coordinator before being accepted. Two real holes in the round-1 fixes were
found and closed:

| # | Attack | Result before | Disposition |
|---|---|---|---|
| B-2b | Committed symlink to a not-yet-existing file in an *existing* outside dir | **Escaped** — `existsSync` follows the link, so a dangling link was skipped, containment wrongly passed, and a file was written outside the worktree ("empty diff" reported) | Fixed — lstat-based existence, fails closed |
| M-1b | `run-command.mjs` passes `claimedPaths:null`, but `review.mjs` returned `[]` not `null` | **False green persisted** — pipeline still printed "0 divergence" despite round 1 claiming "not checked" | Fixed — return `null`; verified end-to-end the pipeline prints "not checked" |

Hardening also closed: agy argv-prompt to a `.cmd` shim (fail closed);
up-front `taskId` validation in the worker and integration layers (no
run-then-crash-with-no-receipt, no evidence-path escape); tampercheck env
stripped for consistency; the opt-in tampercheck version pin made exact (a
substring let `12.1.0` satisfy `2.1.0`); ACP `allow-edits` refuses an edit whose
location escapes cwd; more credential names stripped; a negative ledger
reservation rejected in the sum.

**Held under this pass** (reproduced, surface stood): the per-repository
integration lock (3 concurrent OS processes, no interleave); `acquireWorkerSlot`
(20 processes for 4 slots, never exceeded, no double-occupancy, dead-PID reclaim
TOCTOU); 27 distinct receipt-forgery shapes (all refused); the ACP permission
*core* (19 scenarios via a hand-rolled hostile adapter); the empty-diff gate
against `--allow-empty`/whitespace/mode-only tricks; and the
hardlink/junction/directory-symlink-in-prefix/traversal matrix.

### Still not covered (named, not claimed)

- A malicious ACP adapter beyond the `allow-edits` path check (the operator
  installs the adapter; the location check is best-effort on the declared ACP
  `locations` and does not cover an adapter that omits them).
- `reconcilePaidUsage` accepting a terminal charge with no matching reservation
  (the admission ledger library is not wired into any command today).
- Receipt cross-field usage consistency (each field is well-typed; the sum is
  not checked against the parts).
