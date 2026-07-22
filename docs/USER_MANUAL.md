# DevHarmonics User Manual

Manual version: **0.6.0**<br>
Product release: **v0.6.0**

DevHarmonics is a local-first, provider-neutral software factory for product owners managing AI agents as development teams. It turns one software-development objective into a planned, parallel, validated run across Codex, Claude Code, and the Google Antigravity model catalog. It runs locally and uses the subscription sessions cached by the providers' official command-line tools.

## 1. Before you begin

You need:

- Node.js 24 or newer
- Git
- A Git repository for the project you want to change
- At least one supported provider CLI installed and signed in. This is what
  PLANNING needs: no local model is qualified to act as the architect. Running
  a plan you have already approved does not need one — qualified local models
  can carry the work and review it.

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

Expected version output is `DevHarmonics 0.6.0`.

## 3. Sign in to providers

Provider sign-in belongs to each official CLI. DevHarmonics checks both installation and authentication and removes a signed-out provider from the pool it chooses from.

Being signed out of one provider is not by itself a reason to stop. Planning needs one healthy subscription architect, so it stops only when none is left. Starting a plan you have already approved needs a worker and a reviewer that can actually be routed — and those may be local models, so an approved run can proceed with every subscription signed out.

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

### Google Antigravity

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

Antigravity is one signed-in connection that may expose Gemini, Claude, and GPT models. DevHarmonics keeps each model's vendor visible and treats Antigravity's **Gemini Models** and **Claude and GPT Models** quota groups independently. If one group reports exhaustion, models in that group wait until its reported reset while qualified models in the other group can remain eligible. Existing project files may still use the internal provider key `gemini`; that is a compatibility alias, not a claim that every Antigravity task uses a Gemini model.

## 4. Check readiness

Run:

```powershell
devharmonics doctor --project C:\path\to\your\project
```

Each provider is shown as `READY` or `SETUP`, with its detected version, authentication state, and login command. At least one provider must be ready in order to plan. Once a plan is approved, what matters is whether a worker and a reviewer can be routed, which qualified local models can satisfy.

### Register a product and its local repositories

1. Open **Products** and select **Register product**.
2. Enter a stable product ID, display name, organization URL, and description.
3. Select **Add local repository**, choose the product, and enter the local Git checkout.
4. Assign its role, expected branch, owners, dependency repository IDs, governance sources, and optional validator commands in `name = command` form.
5. Click **Inspect & register repository**. DevHarmonics records the current branch, HEAD, origin, dirty state, and compatibility issues without modifying the checkout.
6. Use **Rescan** after local Git state changes.

Register CivicSuite repositories independently. Use roles such as **Umbrella**, **Shared platform**, **Module**, **Desktop**, **Installer**, **Documentation**, and **Release truth** so cross-repository planning can preserve their distinct governance and delivery boundaries.

For every attached local repository, configure **Canonical intelligence sources**. These are relative paths to the files DevHarmonics should treat as evidence—such as `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `STATUS.md`, `pyproject.toml`, `package.json`, a compatibility matrix, or release documentation. Then select **Scan intelligence** on the product card.

The scan is read-only and creates an immutable snapshot. It records each repository's exact HEAD, every source content hash, whether the source is uncommitted, explicit version/release/status/maturity claims, missing or unsafe sources, and subject-aware contradictions with `repository:path:line` citations. Different repositories may legitimately have different package versions; DevHarmonics flags a conflict only when sources disagree about the same named subject. Git tags are never used as maturity evidence. The newest snapshot is supplied to future product-aware planning, while older snapshots remain in the local ledger.

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

Multi-repository execution is available through DH-720. Every affected repository must have a compatible registered local checkout, every task must target exactly one affected repository, and the plan must retain explicit integration conditions. DevHarmonics then creates a separate integration branch/worktree per repository at an exact base commit, gives each task a repository-local branch/worktree, and runs repository-local validators. Work in different repositories can proceed concurrently; merges into the same repository are serialized. Final review receives aggregate, repository-prefixed diff evidence without write access and must satisfy the configured reviewer count, distinct-provider, and implementor-independence rules. A blocking finding must use a repository-prefixed location such as `repo:core/src/service.ts:7`; an unscoped or ambiguous finding fails closed. Scoped findings become automatic fixer tasks only in the affected repository worktrees. DevHarmonics revalidates those branches, invalidates the old review receipts while retaining them in the ledger, and requires a fresh independent quorum before reporting `READY`. The run's **Exact integration set** card and evidence export retain every repository's base and integration HEAD commit, branch, worktree, status, error, and the integration conditions. The primary checkouts remain untouched.

This path does not yet let one task mutate several repositories, reconstruct an interrupted integration set after restart, clean up retained worktrees automatically, push branches, or open pull requests.

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

### Run a saved workflow (v0.6)

A **workflow** is a reusable, versioned job description — for example "audit the documentation for stale version claims" — stored as a JSON document in the install's tracked `workflows/` directory and recorded in the ledger by content hash, so every revision is permanent and identifiable. Two ship with DevHarmonics — `documentation-consistency` and `release-truth-audit` — and they are recorded automatically the first time the server starts, so a fresh cockpit already lists them.

1. Open **Workflows** and select a recorded revision. The full document is shown — inputs, acceptance criteria, required evidence, approval points, and permissions — so you can review exactly what will run before anything moves. The evidence, approval-point, and completion-contract fields are advisory in this release: they travel into the objective as policy notes that inform planning, while actual gating still comes from your run policy and review policy in Setup.
2. Fill in the typed inputs (an empty value does not count for a required input). To scope repositories, select the owning product and tick its repositories — repository scope always belongs to a product, exactly as in the objective composer; leave it on Standalone to run against the server project folder. Then click **Create objective**.
3. The workflow becomes a normal objective in **Runs**: propose a plan, approve the exact revision, and start it like any other run.

The run permanently records which workflow revision it executed. Editing a workflow never changes what a past run did — an edit is a new revision beside the old one — and a revision recorded as a promotion of an earlier pilot is refused if it tries to widen the pilot's permissions (turning on external writes, escalating autonomy, or dropping an approval point). To record a new workflow or revision, POST its document to `/api/workflows`.

## 6. Understand the run board

- **Plan**: tasks waiting for dependencies or an available worker.
- **Working**: an agent is editing, or a failed task is retrying.
- **Verifying**: configured validators are running.
- **Resolved**: the task passed, failed, was blocked, or was cancelled.

The metrics show task count, passed checks, attempts, and currently active agents. Select a task to inspect its validator receipts. The activity panel records durable run events; refreshing the browser does not erase them.

### Live feedback while work runs (v0.6)

Every dashboard action acknowledges immediately: the button you pressed disables, shows a busy label with a small spinner, and announces an explicit done or failed result. A floating **activity strip** at the bottom of the screen lists everything DevHarmonics is doing right now — active run tasks with the responsible provider and model, plus local operations like fleet refreshes — and stays visible when you change screens, so navigation never hides work. Working tasks show how long they have been active; when a long provider call has produced no new events for several minutes, the card and strip say so ("quiet for 6m — the provider call may still be running") instead of pretending progress. These times are rebuilt from the durable ledger, so refreshing the page shows honest elapsed values, not reset ones. DevHarmonics does not draw percentage bars for work it cannot measure, and it never displays activity from tools running outside its own control plane. If you use reduced-motion settings, the spinner is replaced with a static indicator.

For a multi-repository run, the **Exact integration set** card shows the overall set status and one card per affected repository, including its exact base-to-HEAD commit range and integration branch. Repository IDs also appear on task cards and in the task drawer so evidence cannot be mistaken for a monorepo change.

For an Observe run, DevHarmonics stores the selected mode with the run, requires every planned task to be `diagnostic`, `read_only`, and `low` risk, and rejects a worker that asks for approval again or omits contracted path-and-line evidence. Accepted findings are retained in the evidence package and reviewed independently; an empty Git diff alone is not sufficient for success.

### Steer a run while it is working (v0.6)

The **Steer this run** panel lets you redirect live work without opening an agent terminal. Nothing you do here loses completed evidence.

- **Hold new tasks** stops DevHarmonics starting anything new while tasks already running finish normally. **Resume admission** releases the queue. The panel distinguishes a request you just made from one the scheduler has actually applied, so you always know whether a hold is in force yet.
- **Reassign** moves a queued task to a different signed-in provider, and **Set order** chooses which queued tasks are admitted first. Both apply only to work that has not started, and neither can start a task whose dependencies are unfinished.
- **Send clarification** delivers extra direction to one task. It is applied at that task's next attempt boundary rather than mid-answer, and the record shows exactly which attempt received it.
- **Interrupt & hand off** stops whatever a task is currently doing and starts a fresh attempt carrying your direction. DevHarmonics does not claim to change an answer already being written — it stops and hands off. The button is available while the task is *working*, which covers two situations, and it is honest about both. If a provider call is in flight, that partial attempt is kept as evidence and the new attempt is attributed to it. If the task is still qualifying a model for first use — which happens before any provider call — the interrupt stops that instead, and there is no attempt record to keep, because none had been created yet. It is unavailable while validators run or during a retry gap, because there is nothing to stop. An interrupted attempt uses one of the task's approved attempts, so interrupting repeatedly can exhaust the task's budget and fail it — steering redirects work, it never buys extra provider usage.

Steering guides work inside the plan you approved. It cannot change a task's permissions, risk, acceptance criteria, or repository scope, and it cannot enable external writes or paid API use — those remain plan and policy decisions. Every steering request is recorded with who made it, what it targeted, and whether it was applied, rejected, or superseded by a later request, so a run's history explains every redirection after the fact.

## 7. Cancel a run

Select an active run and click **Cancel run**. DevHarmonics stops scheduling new tasks, aborts active provider processes, and marks live tasks and the run as cancelled. Already-created branches, worktrees, commits, and ledger receipts remain available for inspection.

Closing the DevHarmonics server terminal also stops the local server. Prefer **Cancel run** first when work is active so the ledger records the explicit cancellation.

Refreshing or reconnecting the browser preserves ledger evidence, but DH-720 does not yet reconstruct and resume an interrupted multi-repository integration set after a server or machine restart or clean retained worktrees automatically. Cancel active work before a planned restart and inspect the retained branches/worktrees afterward.

## 8. Review the result

Passing task commits are merged into a run-specific integration branch. A standalone or single-repository run uses:

```text
devharmonics/<run-prefix>
```

DevHarmonics deliberately does not merge that branch into your checked-out branch. Review it with normal Git tools, run any additional checks, and merge it only when satisfied.

### Approved delivery, complete from the cockpit (v0.6)

When a non-Observe run reaches **READY**, the **Approved delivery** card shows the exact base branch, base commit, reviewed HEAD commit, and delivery branch for each repository. External writes are off by default. To deliver through GitHub, entirely from the dashboard:

1. Enable **Allow external writes** in Setup.
2. Confirm **Approve & push branch** for the exact repository and HEAD shown. DevHarmonics pushes that exact commit without force-updating a conflicting remote branch.
3. Separately confirm **Approve & create draft PR**.
4. When you are satisfied the change should land, confirm **Approve & merge PR**. DevHarmonics checks the live pull-request state first and refuses to merge a conflict, a pull request with pending or failing status checks, or a head commit that is no longer the reviewed commit.
5. Optionally confirm **Approve & tag release** with a version tag. The tag lands on the actual merge commit and is recorded on the delivery; a failed tag push can be retried and reuses the already-created local tag.

A **Complete delivery** control runs the remaining steps in order — still one explicit approval per consequential action. There is no automatic merge and no automatic tag: nothing external happens without your approval of that specific step. Each confirmation creates its own external-write approval and tool-policy receipt. Completed steps reconcile safely if you click them again, a second operation on the same repository is refused while one is in flight, and the card locks while a step runs. If the reviewed HEAD no longer matches the card, refresh instead of approving stale evidence. This capability is part of v0.6; it is not present in the earlier v0.5.1 release.

A multi-repository run creates a separate integration branch and worktree for every affected repository. Use the **Exact integration set** card or exported evidence to copy the precise branch name and base-to-HEAD commit range for each repository. The earlier v0.5.1 release does not push those branches or open pull requests; v0.6 performs the separately approved delivery flow above. No version merges them into a primary checkout automatically.

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

For every attempt, the run detail distinguishes the model DevHarmonics requested from the model the runtime verified as actually used. Some subscription CLIs accept an exact model request without returning execution identity. In that case, the requested model remains visible but actual resolution is marked unverified; it is not counted or described as a confirmed execution by that model.

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

Git merge conflicts are not repaired automatically in v0.6.0. The automatic fixer addresses structured reviewer findings after integration; it does not guess through conflicting branch edits. Inspect the task and integration branches, resolve manually if appropriate, and start a new run for remaining work.

### A provider is throttled

Reduce concurrency, use fewer providers, or wait for the subscription allowance to recover. DevHarmonics cannot increase provider-controlled quotas.

### A Docker-gated validator skips, or fails only inside DevHarmonics

Two environment facts matter on Windows, and both were learned the hard way on a real machine. They belong here rather than in anyone's session notes.

**Task worktrees live under the system temp directory.** DevHarmonics creates its run worktrees under `os.tmpdir()`. In a packaged (MSIX-container) shell, `%TEMP%` is redirected, and some toolchains — notably a validator that reaches a Docker daemon to run a real database migration — fail there with connection errors while passing anywhere else. The result is a FALSE task failure that has nothing to do with the change under test. The fix is to point `TEMP` and `TMP` at a normal directory before launching DevHarmonics:

```powershell
$env:TEMP = "C:\dev\dh-runs"; $env:TMP = "C:\dev\dh-runs"
```

`os.tmpdir()` honours these, so no configuration option is needed.

**Validators inherit DevHarmonics' environment.** A validator that needs Docker must be able to reach a daemon from the environment DevHarmonics was launched in. With Docker Engine running inside WSL and exposed on loopback TCP (not Docker Desktop), that means:

```powershell
$env:DOCKER_HOST = "tcp://127.0.0.1:2375"
```

Without it, a Docker-dependent test typically *skips* rather than fails — which is worse, because a migration-compatibility check that silently skips makes an incompatible dependency bump look green. If a validator's own output says it skipped for want of Docker, treat that as environment, not evidence.

**Validators that need a repository's own toolchain** — a virtualenv interpreter, a repo-local binary — should be registered with the `${repoRoot}` token rather than an absolute path:

```json
{ "tests": { "command": "${repoRoot}/.venv/Scripts/python.exe", "args": ["-m", "pytest", "-q"], "timeoutMs": 900000 } }
```

The token expands to the repository's primary root on whatever machine the run happens to be on. An absolute path breaks on every other machine; a bare `python` runs whatever interpreter is first on PATH, which is usually not the repository's own environment.

## 12. Security and privacy

- The dashboard listens only on the local loopback interface.
- Authentication remains inside official provider tools.
- DevHarmonics strips common model API-key and cloud-credential variables from child processes.
- DevHarmonics redacts common API keys, bearer/OAuth tokens, passwords, private keys, credential-bearing URLs, and sensitive structured fields before prompts, outputs, errors, checks, reviews, or events are persisted.
- Work is isolated with Git branches and worktrees.
- Commands run by validators are allowlisted in local configuration.
- Redaction is defense in depth, not a reason to place credentials in goals, prompts, repository files, or validator output. Treat the runtime directory as potentially sensitive.
- When DevHarmonics upgrades an existing ledger schema, it creates a pre-migration `.sqlite` backup beside `devharmonics.db`. Keep that backup until the upgraded application and run history have been verified. Because it preserves data exactly as it existed before migration, it can contain values stored by an older version before ledger-boundary redaction was available.

Report security issues using the private process in [SECURITY.md](https://github.com/scottconverse/DevHarmonics/blob/main/SECURITY.md), not a public issue or Discussion.

## 13. Uninstall

If globally linked, remove the link:

```powershell
npm.cmd unlink -g devharmonics-local
```

Then delete the source checkout when no longer needed. Delete `.devharmonics/` in a target project only if you no longer need its configuration, run history, or receipts. Provider logouts must be performed through each provider's own CLI.
