# DevHarmonics

**A local-first, host-agnostic software factory.** Any agent app you're sitting in can coordinate. Any qualified model — subscription CLI, ACP agent, or local model over HTTP — can work. Every target repository carries its own independent enforcement. Every consequential action waits for the owner. Every claim carries a receipt.

The design test applied to every decision: **the factory must survive any single vendor, app, or model disappearing.**

## Status

**Specification stage. No code yet.** The complete spec and slice-by-slice implementation plan live in [docs/SPEC.md](docs/SPEC.md). Implementation begins at Slice 0 (skeleton + doctor) and every slice ends with a live-fire acceptance against real tools — never shim-only green.

## The shape of it

- **Coordinator plane** — coordination is judgment plus a CLI. The factory is plain Node scripts driven from whichever agent app the owner is in (Claude/Cowork, Codex, Antigravity), via one thin skill file per host.
- **Three worker lanes** — ACP sessions (`@agentclientprotocol/sdk` + per-provider adapters), Anthropic-Messages-format HTTP (Ollama, LM Studio, LiteLLM, optional Claude API), and supervised headless subprocesses (`codex exec`, `claude -p`, `agy -p` — subscription auth, no API keys). One receipt schema across all three.
- **Verification plane** — the [rigor-suite](https://github.com/scottconverse/rigor-suite): tampercheck at every integration boundary and pinned in every target repo's CI, deterministic-detector to qualify test suites, dev-rigor-stack-lite as coordinator discipline. The factory builds no verification code of its own.
- **The novel piece** — multi-repository integration sets: per-repo exact base pins, isolated integration worktrees, readiness judged as a set.

## Lineage

This is the second DevHarmonics architecture. The first (v0.6.1, a single-process orchestrator with its own UI, adapters, and verification layer) is preserved privately as `devharmonics-v1`; its live-fire-tested modules and its hardest-won lessons — fail-closed evidence, verification-integrity gating, owner-approval boundaries, and the cost of a 482-row spec — are carried forward here. Portions of the spine are ported from [codex-factory](https://github.com/scottconverse/codex-factory).

## License

[Apache License 2.0](LICENSE)
