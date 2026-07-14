# DevHarmonics User Manual

Manual version: **0.1.0**<br>
Product release: **v0.1.0**

DevHarmonics turns one software-development objective into a planned, parallel, validated run across Codex, Claude Code, and Gemini through Google Antigravity. It runs locally and uses the subscription sessions cached by the providers' official command-line tools.

## 1. Before you begin

You need:

- Node.js 24 or newer
- Git
- A Git repository for the project you want to change
- At least one supported provider CLI installed and signed in

DevHarmonics does not accept API keys or provider passwords. If a prompt asks you for an OpenAI, Anthropic, or Google password inside the DevHarmonics dashboard, stop: that is not an authentic product flow.

## 2. Install and launch

From PowerShell:

```powershell
git clone https://github.com/scottconverse/DevHarmonics.git
Set-Location DevHarmonics
npm.cmd ci
npm.cmd run build
node dist/src/cli.js doctor
node dist/src/cli.js serve --project C:\path\to\your\project
```

The server binds to `127.0.0.1` and opens `http://127.0.0.1:4317`. Leave that terminal open while using the dashboard. Closing it stops DevHarmonics but does not sign you out of any provider.

Optional global command for this checkout:

```powershell
npm.cmd link
devharmonics --version
```

Expected version output is `DevHarmonics 0.1.0`.

## 3. Sign in to providers

Provider sign-in belongs to each official CLI. DevHarmonics checks both installation and authentication, disables unavailable providers, and will not begin a run with a signed-out selection.

### Codex / OpenAI

1. Open a separate terminal.
2. Run `codex login`.
3. Complete the official OpenAI/ChatGPT browser sign-in.
4. Return to the terminal and wait for completion.
5. Verify with `codex login status`.
6. In DevHarmonics, click **Refresh sign-in status**.

Your ChatGPT/Codex subscription session is used by the Codex CLI. DevHarmonics never receives your password or copies its OAuth tokens.

### Claude Code / Anthropic

1. Open a separate terminal.
2. Run `claude auth login`.
3. Complete Anthropic's official sign-in flow.
4. Verify with `claude auth status --text`.
5. Click **Refresh sign-in status** in DevHarmonics.

### Gemini / Google Antigravity

The first Antigravity login requires both a browser-to-terminal code handoff and several terminal onboarding screens.

1. Open a separate terminal and run `agy`.
2. Choose Google sign-in with the account connected to your Gemini subscription.
3. Complete Google's browser sign-in.
4. The browser displays a one-time authorization code. Click **Copy to Clipboard**.
5. Return to the same Antigravity terminal, paste the code at its authorization prompt, and press **Enter**.
6. Complete every onboarding screen. The first may ask for a color scheme; use the displayed arrow-key and Enter controls. Continue through all preference screens.
7. Setup is complete only when the normal Antigravity prompt appears. It shows the signed-in account and tier, selected Gemini model, current path, and a `>` input line.
8. Press `Ctrl+C` to exit that standalone session.
9. Run `agy models` to confirm the cached session.
10. Click **Refresh sign-in status** in DevHarmonics.

The one-time authorization code is a short-lived credential. Paste it only into the Antigravity terminal that requested it. Do not paste it into DevHarmonics, chat, documentation, screenshots, or issue reports.

## 4. Check readiness

Run:

```powershell
devharmonics doctor --project C:\path\to\your\project
```

Each provider is shown as `READY` or `SETUP`, with its detected version, authentication state, and login command. At least one provider must be ready.

## 5. Start a run in the dashboard

1. Confirm the **Project folder** points to the intended Git repository.
2. Describe a concrete, testable result in **What should the team accomplish?**
3. Choose **Architect decides** or enter a manual concurrency count.
4. Enable the authenticated providers you want in the worker pool.
5. Click **Start verified run**.

Good goals specify the observable result and important verification. Example:

> Add CSV export to the customer report, preserve current filters, add automated coverage, and verify the download behavior.

The agent count is not artificially capped. High settings can consume substantial CPU, memory, disk space, provider quota, and rate-limit capacity. The actual number of simultaneous workers cannot exceed the number of dependency-ready tasks.

## 6. Understand the run board

- **Plan**: tasks waiting for dependencies or an available worker.
- **Working**: an agent is editing, or a failed task is retrying.
- **Verifying**: configured validators are running.
- **Resolved**: the task passed, failed, was blocked, or was cancelled.

The metrics show task count, passed checks, attempts, and currently active agents. Select a task to inspect its validator receipts. The activity panel records durable run events; refreshing the browser does not erase them.

## 7. Cancel a run

Select an active run and click **Cancel run**. DevHarmonics stops scheduling new tasks, aborts active provider processes, and marks live tasks and the run as cancelled. Already-created branches, worktrees, commits, and ledger receipts remain available for inspection.

Closing the DevHarmonics server terminal also stops the local server. Prefer **Cancel run** first when work is active so the ledger records the explicit cancellation.

## 8. Review the result

Passing task commits are merged into a run-specific integration branch:

```text
devharmonics/<run-prefix>
```

DevHarmonics deliberately does not merge that branch into your checked-out branch. Review it with normal Git tools, run any additional checks, and merge it only when satisfied.

Useful commands:

```powershell
git branch --list "devharmonics/*"
git log --oneline --decorate --graph --all
git diff main...devharmonics/<run-prefix>
```

## 9. Project files and configuration

DevHarmonics creates the following inside each target project:

```text
.devharmonics/
  config.json
  constitution.md
  devharmonics.db
```

This directory is added to `.git/info/exclude`, which is local to that clone. It contains runtime state and should not be committed.

Key settings in `config.json`:

- `architect`: provider that creates the task graph
- `reviewer`: provider that gives the final read-only verdict
- `workers`: providers eligible for task work
- `concurrency.mode`: `auto` or `manual`
- `concurrency.agents`: default manual count
- `concurrency.ceiling`: optional administrator limit; `null` means no configured limit
- `retry.maxAttempts`: maximum attempts per task
- `providers.*.timeoutMs`: provider-process timeout
- `validators`: commands the architect may select by name

Validator commands are trusted local configuration. Models can request a configured validator name but cannot invent a command for execution.

## 10. Command reference

```text
devharmonics serve [--project PATH] [--port 4317] [--open false]
devharmonics init [--project PATH]
devharmonics doctor [--project PATH]
devharmonics run --goal "..." [--project PATH] [--agents auto|N]
                   [--providers codex,claude,gemini]
devharmonics --version
```

- `serve` initializes the target project and starts the dashboard.
- `init` creates local configuration without starting a run.
- `doctor` inspects provider installation and sign-in state.
- `run` performs a noninteractive run and prints the final ledger record as JSON.

## 11. Troubleshooting

### A provider says Sign-in required

Run the login and status commands in a separate terminal, finish every browser/terminal step, then click **Refresh sign-in status**. Installing a CLI does not sign it in.

### Antigravity browser says sign-in failed but also shows a code

Return to the exact `agy` terminal that opened the browser. If it is still waiting for an authorization code, paste the newly generated code there and continue onboarding. If the terminal is no longer waiting, discard the code and restart `agy`; never reuse or publish it.

### The browser closed or the dashboard is unavailable

Check whether the server terminal is still open. Relaunch:

```powershell
devharmonics serve --project C:\path\to\your\project
```

Provider sign-ins are cached by their CLIs and normally survive this restart.

### DevHarmonics requires a clean working tree

Commit, stash, or otherwise resolve your own pending changes before starting parallel work. DevHarmonics will not overwrite or hide them.

### A task failed validation

Open the task drawer and inspect the exact command receipt. After bounded retries, the task remains failed so you can diagnose it without a false success state.

### A merge conflict stopped a task

Automatic conflict repair is not available in v0.1.0. Inspect the task and integration branches, resolve manually if appropriate, and start a new run for remaining work.

### A provider is throttled

Reduce concurrency, use fewer providers, or wait for the subscription allowance to recover. DevHarmonics cannot increase provider-controlled quotas.

## 12. Security and privacy

- The dashboard listens only on the local loopback interface.
- Authentication remains inside official provider tools.
- DevHarmonics strips common model API-key and cloud-credential variables from child processes.
- Work is isolated with Git branches and worktrees.
- Commands run by validators are allowlisted in local configuration.
- Run prompts, paths, model output, and validation receipts are stored locally in SQLite; treat the runtime directory as potentially sensitive.

Report security issues using the private process in [SECURITY.md](../SECURITY.md), not a public issue or Discussion.

## 13. Uninstall

If globally linked, remove the link:

```powershell
npm.cmd unlink -g devharmonics-local
```

Then delete the source checkout when no longer needed. Delete `.devharmonics/` in a target project only if you no longer need its configuration, run history, or receipts. Provider logouts must be performed through each provider's own CLI.
