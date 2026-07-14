# DevHarmonics Architecture

Architecture version: **0.1.0**

DevHarmonics is a local orchestration layer over official subscription-authenticated coding-agent CLIs. It does not proxy provider HTTP APIs.

```text
Goal + project
      |
      v
Read-only architect -> typed task DAG -> dependency scheduler
                                           |
                           +---------------+---------------+
                           |               |               |
                      Codex worker    Claude worker   Gemini worker
                           |               |               |
                           +------- isolated worktrees ----+
                                           |
                                allowlisted validators
                                           |
                                serial integration branch
                                           |
                                  read-only final reviewer
                                           |
                              verdict + SQLite run ledger
```

## Components

- `src/cli.ts`: command entry point for `serve`, `init`, `doctor`, and `run`.
- `src/server.ts`: loopback-only HTTP server and static dashboard delivery.
- `src/doctor.ts`: provider installation and authentication inspection.
- `src/providers.ts`: provider-specific process adapters and credential stripping.
- `src/orchestrator.ts`: planning, dependency scheduling, retries, integration, review, and cancellation.
- `src/worktrees.ts`: integration branch and isolated task worktree lifecycle.
- `src/validators.ts`: execution of user-configured validator allowlists.
- `src/ledger.ts`: SQLite-backed run, task, attempt, check, and event receipts.
- `src/ui/`: dependency-free browser interface.

## Trust boundaries

Provider authentication is outside DevHarmonics. Provider prompts and project content cross into the selected provider process. Model output is untrusted: plans are schema-validated, task dependencies are checked, and requested validators must already exist in local configuration.

Workers can edit only within their assigned worktrees using the selected CLI's restricted editing mode. Architect and reviewer calls are read-only. Git and configured validators remain local trusted executables.

## Persistence

Each target project receives `.devharmonics/config.json`, `.devharmonics/constitution.md`, and `.devharmonics/devharmonics.db`. Temporary worktrees live below the operating system's temporary directory under `devharmonics/<run-id>`.

## Deliberate non-features in v0.1.0

- No model API-key transport
- No remote DevHarmonics service
- No automatic merge into the user's checked-out branch
- No automatic conflict repair
- No Ollama or generic local-model adapter yet
- No Agent Client Protocol transport yet
