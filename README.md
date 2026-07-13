# Ringer Local

Ringer is a local, subscription-backed agent orchestrator. It coordinates the official Codex, Claude Code, and Google Antigravity command-line tools, gives parallel workers isolated Git worktrees, runs allowlisted validators, retries failures with exact feedback, and records every result in SQLite. The dashboard calls the Google provider **Gemini** because Antigravity supplies the Gemini models.

It does **not** use model API keys. Provider processes have API-key and cloud-credential environment variables removed so they use the login cached by each official CLI.

## What you get

- A local browser dashboard at `http://127.0.0.1:4317`
- A goal composer with manual or architect-selected concurrency
- Codex, Claude, and Gemini worker toggles
- Dependency-aware parallel task scheduling with no built-in agent ceiling
- One Git worktree and branch per task
- Allowlisted command validators with execution receipts
- Provider rotation and specific failure feedback on retries
- A final integration branch and read-only reviewer verdict
- A durable SQLite task, attempt, check, and event ledger

## Requirements

- Node.js 24 or newer
- Git
- At least one of the official subscription-authenticated CLIs:
  - `codex` — sign in with `codex login`
  - `claude` — sign in with `claude auth login`
- `agy` — run `agy` and sign in with the Google account associated with your Gemini subscription

> Google ended consumer Google AI Pro/Ultra access through Gemini CLI on June 18, 2026. Ringer therefore uses the supported Antigravity CLI (`agy`) for subscription-backed Gemini access. Gemini CLI remains relevant only for supported enterprise/API configurations, which Ringer does not use.

### First-time Antigravity sign-in

Antigravity's first login has two handoffs and an onboarding sequence that are easy to mistake for a failed or unfinished login:

1. Run `agy` and choose Google sign-in with the account tied to your Gemini subscription.
2. Finish the browser sign-in. The browser then displays a one-time authorization code instead of returning automatically to the CLI.
3. Click **Copy to Clipboard**, return to the Antigravity terminal, paste the code at its authorization prompt, and press **Enter**. Treat the code as a short-lived credential: never paste it into Ringer, a chat, or a document.
4. Antigravity opens first-run onboarding. On the color-scheme screen, use ↑/↓, then press **Enter**. Continue through each **Next** screen with Enter.
5. When the normal Antigravity prompt appears, exit with `Ctrl+C` and verify the cached login with `agy models`.

Ringer's dashboard repeats these instructions under **First-time provider sign-in guide**.

Ringer never asks for your email password and never reads or copies provider OAuth tokens.

## Install and launch

```powershell
npm.cmd install
npm.cmd run build
node dist/src/cli.js doctor
node dist/src/cli.js serve --project C:\path\to\your\repository
```

The last command opens the dashboard. To install the `ringer` command globally from this checkout:

```powershell
npm.cmd link
ringer serve --project C:\path\to\your\repository
```

## CLI

```text
ringer serve [--project PATH] [--port 4317] [--open false]
ringer init [--project PATH]
ringer doctor [--project PATH]
ringer run --goal "..." [--project PATH] [--agents auto|N]
           [--providers codex,claude,gemini]
```

Examples:

```powershell
# Let the architect select concurrency from the task graph
ringer run --project C:\repos\shop --agents auto `
  --goal "Add CSV export, test it, and verify the browser download"

# Request 40 concurrent slots with all three providers
ringer run --project C:\repos\shop --agents 40 `
  --providers codex,claude,gemini `
  --goal "Implement the approved backlog"
```

Ringer does not clamp the configured agent count. Actual parallelism is bounded naturally by the number of ready tasks, machine resources, and provider throttling or subscription limits.

## Project configuration

The first `init`, `serve`, or `run` creates:

```text
.ringer/
  config.json
  constitution.md
  ringer.db
```

`.ringer/` is added to the repository-local `.git/info/exclude`, leaving the shared `.gitignore` untouched. For Node projects, Ringer automatically registers existing `test`, `lint`, `build`, and `typecheck` package scripts. Every project also receives the built-in `diff-check` validator.

Example `.ringer/config.json`:

```json
{
  "version": 1,
  "architect": "claude",
  "reviewer": "codex",
  "workers": ["codex", "claude", "gemini"],
  "concurrency": {
    "mode": "auto",
    "agents": 20,
    "ceiling": null
  },
  "retry": {
    "maxAttempts": 3,
    "backoffMs": 1500
  },
  "providers": {
    "codex": { "enabled": true, "command": "codex", "timeoutMs": 1800000 },
    "claude": { "enabled": true, "command": "claude", "timeoutMs": 1800000 },
    "gemini": { "enabled": true, "command": "agy", "timeoutMs": 1800000 }
  },
  "validators": {
    "diff-check": {
      "command": "git",
      "args": ["diff", "--check"],
      "timeoutMs": 60000
    },
    "test": {
      "command": "npm",
      "args": ["test"],
      "timeoutMs": 600000
    }
  }
}
```

Models can only select validator names from this file. They cannot provide a shell command for Ringer to execute.

## Run lifecycle

1. Ringer requires a clean Git working tree.
2. The architect inspects the repository in read-only mode and emits a typed task DAG.
3. Ringer creates an integration branch named `ringer/<run-prefix>`.
4. Each ready task receives its own `ringer/<run-prefix>-task-<task>` branch and temporary worktree.
5. A worker edits only its task worktree.
6. Ringer executes the task's allowlisted validators.
7. Failures return to a worker with stdout, stderr, and the exit code.
8. Successful work is committed and merged serially into the integration branch.
9. Dependent tasks begin only after their dependencies merge.
10. The final reviewer inspects the integration worktree without write access and returns `READY` or `NOT READY`.

Ringer does not merge its integration branch into your checked-out branch. Review and merge that branch yourself.

## Safety boundaries

- Dashboard binds only to `127.0.0.1`.
- Mutation endpoints accept same-origin JSON requests only.
- Architect and reviewer runs use each provider's read-only or plan mode.
- Workers use restricted edit modes, not unrestricted bypass/YOLO modes.
- Codex and Claude prompts are sent over stdin. Antigravity requires its prompt as the value of `--print`; Ringer launches it directly without shell interpolation.
- Validators come from user-controlled configuration, never model output.
- API-key variables are removed from child process environments.
- A clean Git working tree is required before parallel work begins.

## Current MVP limitations

- Git merge conflicts stop the affected task with a precise failure; automatic conflict repair is not implemented yet.
- There is no run cancellation button yet. Stop the Ringer process to halt scheduling; provider processes retain their own timeout.
- Temporary worktrees are retained after real runs so you can inspect them. Git worktree cleanup will be added alongside explicit run archival.
- Subscription quotas are provider-controlled. Ringer records throttling failures and retries, but it cannot expand an account's allowance.
- The dashboard polls SQLite rather than using push events; this keeps the server dependency-free and durable across browser refreshes.

## Development

```powershell
npm.cmd test
npm.cmd run dev -- serve --project C:\path\to\repository
```

The automated suite covers configuration, credential stripping, output parsing, plan validation, SQLite receipts, the dashboard server, and a complete fake-provider orchestration run through Git worktrees and final review.
