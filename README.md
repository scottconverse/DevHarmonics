# DevHarmonics

**A local-first, host-agnostic software factory.** Any agent app you're sitting in can coordinate. Any qualified model — subscription CLI, ACP agent, or local model over HTTP — can work. Every target repository carries its own independent enforcement. Every consequential action waits for the owner. Every claim carries a receipt.

The design test applied to every decision: **the factory must survive any single vendor, app, or model disappearing.**

[Website](site/index.html) · [User manual](docs/USER_MANUAL.md) · [Architecture](docs/ARCHITECTURE.md) · [Quick start](#quick-start) · [Falsification record](docs/FALSIFICATION.md)

## Quick start

There is no published package yet — install from source:

```
git clone https://github.com/scottconverse/DevHarmonics.git
cd DevHarmonics
npm ci
node scripts/cli.mjs doctor
```

`doctor` probes every capability the factory depends on — provider CLIs, local model endpoints, the tampercheck integrity gate — and reports PASS/FAIL/SKIPPED for each, honestly, even on a machine with nothing installed yet. See [docs/USER_MANUAL.md](docs/USER_MANUAL.md) for the full command reference, including how to put a `devharmonics` command on your `PATH` with `npm link`.

## Status

**All eight spec slices implemented and live-fire accepted** (2026-08-05). CI green on Windows and Ubuntu; 243 tests (1 skipped on Windows — a POSIX-only probe). Every slice was accepted against real tools on a real machine — real provider CLIs, real local model endpoints, real diffs independently verified — never shim-only green.

Read [docs/USER_MANUAL.md](docs/USER_MANUAL.md) to use it, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to see how it fits together, and [docs/FALSIFICATION.md](docs/FALSIFICATION.md) before trusting it. An adversarial GauntletGate pass put the gates through their paces: a real command-injection (RCE), a symlink escape that wrote outside the repo, and a credential-leak path were each reproduced against the code and closed — every fix with a regression test and a re-verification against a frozen build. The attack surface those passes did *not* cover is named rather than omitted, and the manual's Known Limitations section is complete and unflattering by design.

## The shape of it

- **Coordinator plane** — coordination is judgment plus a CLI. The factory is plain Node scripts driven from whichever agent app the owner is in (Claude/Cowork, Codex, Antigravity), via one thin skill file per host.
- **Three worker lanes** — ACP sessions (`@agentclientprotocol/sdk` + per-provider adapters), Anthropic-Messages-format HTTP (Ollama, LM Studio, LiteLLM, optional Claude API), and supervised headless subprocesses (`codex exec`, `claude -p`, `agy -p` — subscription auth, no API keys). One receipt schema across all three.
- **Verification plane** — the [rigor-suite](https://github.com/scottconverse/rigor-suite): tampercheck at every integration boundary and pinned in every target repo's CI, deterministic-detector to qualify test suites, dev-rigor-stack-lite as coordinator discipline. The factory builds no verification code of its own.
- **The novel piece** — multi-repository integration sets: per-repo exact base pins, isolated integration worktrees, readiness judged as a set.

## Lineage

This is the second DevHarmonics architecture. The first (v0.6.1, a single-process orchestrator with its own UI, adapters, and verification layer) is preserved privately as `devharmonics-v1`; its live-fire-tested modules and its hardest-won lessons — fail-closed evidence, verification-integrity gating, owner-approval boundaries, and the cost of a 482-row spec — are carried forward here. Portions of the spine are ported from [codex-factory](https://github.com/scottconverse/codex-factory).

## License

[Apache License 2.0](LICENSE)
