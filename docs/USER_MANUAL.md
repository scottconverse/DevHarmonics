# DevHarmonics User Manual

Manual version: **0.4.0**<br>
Product release: **v0.4.0**

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

Expected version output is `DevHarmonics 0.4.0`.

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

### Register a product and its local repositories

1. Open **Products** and select **Register product**.
2. Enter a stable product ID, display name, organization URL, and description.
3. Select **Add local repository**, choose the product, and enter the local Git checkout.
4. Assign its role, expected branch, owners, dependency repository IDs, governance sources, and optional validator commands in `name = command` form.
5. Click **Inspect & register repository**. DevHarmonics records the current branch, HEAD, origin, dirty state, and compatibility issues without modifying the checkout.
6. Use **Rescan** after local Git state changes.

Register CivicSuite repositories independently. Use roles such as **Umbrella**, **Shared platform**, **Module**, **Desktop**, **Installer**, **Documentation**, and **Release truth** so cross-repository planning can preserve their distinct governance and delivery boundaries.

## 5. Start a run in the dashboard

1. Confirm the **Project folder** points to the intended Git repository.
2. Optionally choose a registered product and select one or more **Repositories in scope**. Selecting a single local repository also aligns the project folder with that checkout.
3. Describe a concrete, testable result in **What should the team accomplish?**
4. Choose a **Run mode**:
   - **Observe only** permits diagnostic, read-only, low-risk tasks and rejects plans or results that attempt implementation.
   - **Supervised** prepares repository changes after the configured plan-approval gate.
   - **Bounded autonomy** executes within the configured repository, tool, spending, and external-write policies.
5. Choose **Architect decides** or enter a manual concurrency count.
6. Enable the authenticated providers you want in the worker pool.
7. Add acceptance criteria, constraints, risk, priority, an optional deadline, and any policy notes.
8. Click **Build plan preview**. This saves a durable objective draft but starts no run.
9. Review every proposed task and dependency plus the affected/excluded repository impact map, repository rationale, integration conditions, permissions, checks, model assignments, and capacity estimate. For a multi-repository run, every task must name exactly one affected repository.
10. Enter requested changes and click **Revise plan**, or click **Approve revision & start**. DevHarmonics retains every revision and its rationale, and execution uses the exact revision you approved without asking the architect to silently produce another plan.

Multi-repository execution is available as the first DH-720 vertical slice. Every affected repository must have a compatible registered local checkout, every task must target exactly one affected repository, and the plan must retain explicit integration conditions. DevHarmonics then creates a separate integration branch/worktree per repository at an exact base commit, gives each task a repository-local branch/worktree, and runs repository-local validators. Work in different repositories can proceed concurrently; merges into the same repository are serialized. Final review receives aggregate, repository-prefixed diff evidence without write access. The run's **Exact integration set** card and evidence export retain every repository's base and integration HEAD commit, branch, worktree, status, error, and the integration conditions. The primary checkouts remain untouched.

This first slice does not yet let one task mutate several repositories, reconstruct an interrupted integration set after restart, clean up retained worktrees automatically, push branches, open pull requests, or automatically fix and re-review a failed multi-repository result. It supports one aggregate reviewer; when project policy requires more than one reviewer or provider, the run remains **NOT READY** rather than weakening that policy.

### Explore in Workbench first

Use **Workbench** when you want to investigate a project, compare approaches, or ask several qualified models before defining executable work.

1. Open **Workbench** and create a scratchpad with a project folder and title.
2. Enter a question, select one or more active qualified models, and click **Consult selected models**.
3. Compare the retained answers. Each response shows the provider/model identity and available duration or cost information.
4. Open **Convert this discussion into an objective draft**, refine the outcome, acceptance criteria, constraints, risk, priority, and run mode, then create the draft.
5. Review the objective in **Runs** before building a plan preview.

Workbench is discussion-only. It cannot change the repository, start a run, or treat a model suggestion as approved work. The converted objective retains a durable link back to its source discussion.

Good goals specify the observable result and important verification. Example:

> Add CSV export to the customer report, preserve current filters, add automated coverage, and verify the download behavior.

The agent count is not artificially capped. High settings can consume substantial CPU, memory, disk space, provider quota, and rate-limit capacity. The actual number of simultaneous workers cannot exceed the number of dependency-ready tasks.

## 6. Understand the run board

- **Plan**: tasks waiting for dependencies or an available worker.
- **Working**: an agent is editing, or a failed task is retrying.
- **Verifying**: configured validators are running.
- **Resolved**: the task passed, failed, was blocked, or was cancelled.

The metrics show task count, passed checks, attempts, and currently active agents. Select a task to inspect its validator receipts. The activity panel records durable run events; refreshing the browser does not erase them.

For a multi-repository run, the **Exact integration set** card shows the overall set status and one card per affected repository, including its exact base-to-HEAD commit range and integration branch. Repository IDs also appear on task cards and in the task drawer so evidence cannot be mistaken for a monorepo change.

For an Observe run, DevHarmonics stores the selected mode with the run, requires every planned task to be `diagnostic`, `read_only`, and `low` risk, and rejects a worker that asks for approval again or omits contracted path-and-line evidence. Accepted findings are retained in the evidence package and reviewed independently; an empty Git diff alone is not sufficient for success.

## 7. Cancel a run

Select an active run and click **Cancel run**. DevHarmonics stops scheduling new tasks, aborts active provider processes, and marks live tasks and the run as cancelled. Already-created branches, worktrees, commits, and ledger receipts remain available for inspection.

Closing the DevHarmonics server terminal also stops the local server. Prefer **Cancel run** first when work is active so the ledger records the explicit cancellation.

Refreshing or reconnecting the browser preserves ledger evidence, but the first DH-720 slice does not yet reconstruct and resume an interrupted multi-repository integration set after a server or machine restart. Cancel active work before a planned restart and inspect the retained branches/worktrees afterward.

## 8. Review the result

Passing task commits are merged into a run-specific integration branch. A standalone or single-repository run uses:

```text
devharmonics/<run-prefix>
```

DevHarmonics deliberately does not merge that branch into your checked-out branch. Review it with normal Git tools, run any additional checks, and merge it only when satisfied.

A multi-repository run creates a separate integration branch and worktree for every affected repository. Use the **Exact integration set** card or exported evidence to copy the precise branch name and base-to-HEAD commit range for each repository. DevHarmonics does not push those branches, open pull requests, or merge them into any primary checkout.

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
- `runPolicy.autonomy`: default run mode used by the dashboard and CLI
- `providers.*.timeoutMs`: provider-process timeout
- `validators`: commands the architect may select by name

Validator commands are trusted local configuration. Models can request a configured validator name but cannot invent a command for execution.

### Local Ollama specialists and reviewers

Use the Models view to qualify a discovered Ollama model before activating or pinning it. Local review is read-only: the model receives the combined integration diff as bounded per-file chunks or each accepted Observe report as an independent evidence chunk, plus bounded goal, task-contract, and validator context. A local implementor must separately pass **Qualify bounded write tools**. Its tool loop exposes only scoped file reads, searches, and hash-checked patches inside the assigned worktree—never unrestricted shell, commits, merges, or arbitrary paths. DevHarmonics records tool and chunk receipts and fails closed on missing or contradictory results. CPU-only work can take substantially longer than subscription-backed work.

Mellum2 appears automatically when its exact tag is installed in an enabled Ollama runtime; DevHarmonics does not download it. Mellum2 Instruct and Thinking are separate model and upgrade tracks. Use **Benchmark specialist** to run the additional strict-JSON, contradiction-detection, and requirement-count fixture. Mellum2 is not schedulable until that benchmark and the role-appropriate analysis or bounded-tool qualification are both current. Instruct begins in the economy lane for narrow, low-risk work; Thinking is evaluated separately for standard reasoning work. Neither becomes the coordinator, final reviewer, or universal default from its name or published benchmarks alone.

### Refreshing and qualifying the fleet

The application performs a complete catalog check at launch and repeats it every 24 hours. **Refresh fleet** forces a complete rediscovery. Starting a run also refreshes when the last catalog check is stale or a Codex, Claude, or Antigravity CLI version changed.

Each model card shows family, capabilities, available parameter/quantization metadata, current qualification state, **Requalify**, local bounded-tool and specialist-benchmark actions where applicable, plus recent **Qualification history**. Model selectors are role-aware and show only models with current qualification evidence compatible with that role. A previously configured incompatible model remains visible as a disabled warning until you select a qualified replacement or the provider default. Activating an unqualified or stale subscription/local model runs the required first-use qualification when selected. DevHarmonics probes only active, pinned, family-tracked, or scheduler-selected candidates; it does not invoke every model in a provider catalog.

When adaptive routing first selects a concrete Codex, Claude, Gemini/Antigravity, or explicitly assigned Ollama candidate, DevHarmonics runs the smallest role-compatible fixture before giving it real work. Local writes require the disposable bounded read/patch fixture; named specialists such as Mellum2 also require their current specialist benchmark. A pass is recorded and the model becomes active; a failure cools that exact model and allows another qualified provider/model to be selected. A changed CLI/runtime, adapter, model identifier, capability profile, or fixture fingerprint makes the old result stale and triggers the same checks at the next scheduled use. Paid OpenRouter probes remain excluded from this automatic path and still require explicit cost confirmation.

Read-only attempts also have workload-aware watchdogs so a stalled subscription CLI can be classified and retried in useful time: three minutes for a simple diagnostic, ten minutes for standard analysis, and fifteen minutes for complex read-only work, or the provider's shorter configured timeout. Workspace-write tasks retain their provider-configured timeout because legitimate implementation runs can take longer.

Open a task and review **Why this model** to see the exact selected model, classified workload tier, total routing score, every non-zero score contribution, and the plain-language selection factors. The Models view separately shows completion, first-pass success, latency, billed cost when available, validator failures, attempt-linked integration conflicts, workload slices, sample count, and uncertainty for each exact model. A NOT READY count means the model participated in a run that did not pass final review; it is explicitly non-causal and does not penalize the model without task-linked findings. Fewer than 5 observations are **insufficient**, 5–19 are **emerging**, and 20 or more are **established**. Only established workload evidence can influence reliability or latency. Use **Reset observation baseline** to ignore older observations without deleting ledger evidence, or **Exclude empirical history** to disable adaptive use for that model.

**Pinned exact model** keeps the selected identifier. **Track qualified family** evaluates the newest discovered member of the same tier family and promotes it only after exact-ID qualification and the baseline benchmark pass. Newly published or temporarily missing models are therefore never silently substituted.

### Optional OpenRouter setup

1. In **Setup**, select **Connect OpenRouter with OAuth** and approve the provider-owned browser flow. DevHarmonics stores the returned credential with Windows current-user encryption; there is no key to paste into the app.
2. OAuth connection alone permits no paid routing. Save **Enable OpenRouter connection**, **Allow paid API runtimes for this project**, and **Allow paid API fallback**, plus positive per-run and monthly USD limits.
3. In **Models**, search the public OpenRouter catalog and import only the exact candidates you want. Importing is inventory only.
4. Select **Qualify paid model**. The app displays an estimated probe cost and requires confirmation. The provider's current credit/limit status is checked before the probe.
5. Activate the qualified model. DevHarmonics may now choose that exact model for compatible read-only work or context-injected review, including fallback after a subscription capacity failure.

DevHarmonics sends one exact `model` identifier and disables OpenRouter provider fallback. If spending or key limits cannot be verified, paid routing stops. Actual provider, resolved model, tokens, cost, and fallback reason are retained in the run ledger.

## 10. Command reference

```text
devharmonics serve [--project PATH] [--port 4317] [--open false]
devharmonics init [--project PATH]
devharmonics doctor [--project PATH]
devharmonics run --goal "..." [--project PATH] [--agents auto|N]
                   [--autonomy observe|supervised|bounded]
                   [--providers codex,claude,gemini]
devharmonics --version
```

- `serve` initializes the target project and starts the dashboard.
- `init` creates local configuration without starting a run.
- `doctor` inspects provider installation and sign-in state.
- `run` performs a noninteractive run and prints the final ledger record as JSON.

### Advanced: inspect or seed the model registry API

While the dashboard is running, `GET /api/connections` and `GET /api/models` expose the local provider-neutral registry. `POST /api/models` can add or update a manual model record for an existing connection. A manual entry is inventory only: it does not make model selection available or qualify the model for work. The request is schema-validated, cannot replace a discovery-managed record, and must not contain credentials.

```json
{
  "id": "manual:codex:example",
  "connectionId": "subscription-cli:codex",
  "canonicalName": "example-model",
  "displayName": "Example Model",
  "lifecycle": "known",
  "metadata": { "note": "Awaiting visibility and qualification" }
}
```

## 11. Troubleshooting

### A provider says Sign-in required

Run the login and status commands in a separate terminal, finish every browser/terminal step, then click **Refresh sign-in status**. Installing a CLI does not sign it in.

The setup status separates configuration, installation, authentication, account visibility, model entitlement, control-plane health, capacity, and final availability. `Unknown` for entitlement or capacity is expected when a subscription CLI does not expose that fact; it does not mean DevHarmonics has detected a failure.

### Antigravity browser says sign-in failed but also shows a code

Return to the exact `agy` terminal that opened the browser. If it is still waiting for an authorization code, paste the newly generated code there and continue onboarding. If the terminal is no longer waiting, discard the code and restart `agy`; never reuse or publish it.

### The browser closed or the dashboard is unavailable

Check whether the server terminal is still open. Relaunch:

```powershell
devharmonics serve --project C:\path\to\your\project
```

Provider sign-ins are cached by their CLIs and normally survive this restart.

Refreshing or temporarily disconnecting the dashboard resumes activity from its last durable event cursor. It does not cancel the run. If the stream is interrupted, the Activity indicator shows **Reconnecting** while the browser retries.

### DevHarmonics requires a clean working tree

Commit, stash, or otherwise resolve your own pending changes before starting parallel work. DevHarmonics will not overwrite or hide them.

### A task failed validation

Open the task drawer and inspect the exact command receipt. After bounded retries, the task remains failed so you can diagnose it without a false success state.

### A merge conflict stopped a task

Automatic conflict repair is not available in v0.4.0. Inspect the task and integration branches, resolve manually if appropriate, and start a new run for remaining work.

### A provider is throttled

Reduce concurrency, use fewer providers, or wait for the subscription allowance to recover. DevHarmonics cannot increase provider-controlled quotas.

## 12. Security and privacy

- The dashboard listens only on the local loopback interface.
- Authentication remains inside official provider tools.
- DevHarmonics strips common model API-key and cloud-credential variables from child processes.
- DevHarmonics redacts common API keys, bearer/OAuth tokens, passwords, private keys, credential-bearing URLs, and sensitive structured fields before prompts, outputs, errors, checks, reviews, or events are persisted.
- Work is isolated with Git branches and worktrees.
- Commands run by validators are allowlisted in local configuration.
- Redaction is defense in depth, not a reason to place credentials in goals, prompts, repository files, or validator output. Treat the runtime directory as potentially sensitive.
- When DevHarmonics upgrades an existing ledger schema, it creates a pre-migration `.sqlite` backup beside `devharmonics.db`. Keep that backup until the upgraded application and run history have been verified. Because it preserves data exactly as it existed before migration, it can contain values stored by an older version before ledger-boundary redaction was available.

Report security issues using the private process in [SECURITY.md](../SECURITY.md), not a public issue or Discussion.

## 13. Uninstall

If globally linked, remove the link:

```powershell
npm.cmd unlink -g devharmonics-local
```

Then delete the source checkout when no longer needed. Delete `.devharmonics/` in a target project only if you no longer need its configuration, run history, or receipts. Provider logouts must be performed through each provider's own CLI.
