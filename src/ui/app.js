const savedEventCursor = Number(sessionStorage.getItem("devharmonics-event-cursor") || 0);
const state = {
  bootstrap: null,
  runs: [],
  selectedRunId: null,
  composing: false,
  eventCursor: Number.isSafeInteger(savedEventCursor) && savedEventCursor >= 0 ? savedEventCursor : 0,
  eventSource: null,
  refreshScheduled: false,
  cursorInitialized: false,
  view: "runs",
  connections: [],
  models: [],
  resources: null,
  evidence: null,
  products: [],
  qualifications: [],
  performanceProfiles: [],
  performancePolicies: [],
  openRouter: { connected: false, key: null },
};
const $ = (selector) => document.querySelector(selector);

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || `Request failed (${response.status})`);
    error.data = value;
    throw error;
  }
  return value;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function initialize() {
  $("#models-view").insertBefore($("#openrouter-panel"), $("#model-filter-bar"));
  state.bootstrap = await api("/api/bootstrap");
  $("#project-path").value = state.bootstrap.defaultProject;
  renderProviders();
  await refreshFleet();
  renderSettings();
  await refreshRuns();
  connectEventStream();
}

async function refreshFleet() {
  const [connections, models, resources, qualifications, performance, openRouter] = await Promise.all([
    api("/api/connections"),
    api("/api/models"),
    api("/api/resources"),
    api("/api/qualifications"),
    api("/api/model-performance"),
    api("/api/openrouter/status"),
  ]);
  state.connections = connections.connections;
  state.models = models.models;
  state.resources = resources.resources;
  state.qualifications = qualifications.qualifications;
  state.performanceProfiles = performance.profiles;
  state.performancePolicies = performance.policies;
  state.openRouter = openRouter;
  renderConnections();
  renderModels();
  renderOpenRouterStatus();
}

async function refreshProducts() {
  const result = await api("/api/products");
  state.products = result.products;
  const repositories = state.products.flatMap((product) => product.repositories);
  $("#product-summary").innerHTML = `<div class="metric"><span>Products</span><strong>${state.products.length}</strong></div><div class="metric"><span>Repositories</span><strong>${repositories.length}</strong></div><div class="metric"><span>Active repositories</span><strong>${repositories.filter((repository) => !repository.archived).length}</strong></div><div class="metric"><span>Private repositories</span><strong>${repositories.filter((repository) => repository.visibility === "private").length}</strong></div>`;
  $("#products-empty").classList.toggle("hidden", state.products.length > 0);
  $("#product-list").innerHTML = state.products.map((product) => `<article class="panel product-card">
    <div class="product-head"><div><span class="connection-kind">Observed product</span><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.description || "Registered product context")}</p></div><a href="${escapeHtml(product.organizationUrl)}" target="_blank" rel="noreferrer">Open organization</a></div>
    <div class="repository-list">${product.repositories.map((repository) => `<a class="repository-row" href="${escapeHtml(repository.url)}" target="_blank" rel="noreferrer"><span><strong>${escapeHtml(repository.name)}</strong><small>${escapeHtml(repository.defaultBranch)} · ${escapeHtml(repository.visibility)} · ${Number(repository.sizeKb).toLocaleString()} KB</small></span><span class="lifecycle ${repository.archived ? "retired" : "qualified"}">${repository.archived ? "archived" : "observed"}</span></a>`).join("")}</div>
  </article>`).join("");
}

function renderConnections() {
  $("#connection-cards").innerHTML = state.connections.map((connection) => {
    const diagnostics = connection.metadata?.diagnostics || [];
    const firstProblem = diagnostics.find((item) => item.state === "fail" || item.state === "unknown");
    return `<article class="connection-card ${connection.available ? "ready" : "attention"}">
      <div class="connection-head"><div><span class="connection-kind">${escapeHtml(connection.transport.replaceAll("_", " "))}</span><h3>${escapeHtml(connection.displayName)}</h3></div><span class="auth-label ${connection.available ? "ready" : "required"}">${connection.available ? "Ready" : "Setup"}</span></div>
      <p>${escapeHtml(firstProblem?.detail || connection.metadata?.summary || "Connection is ready")}</p>
      <dl><div><dt>Runtime</dt><dd>${escapeHtml(connection.runtimeVersion || "Not detected")}</dd></div><div><dt>Entitlement</dt><dd>${escapeHtml(connection.entitlement)}</dd></div><div><dt>Capacity</dt><dd>${escapeHtml(connection.capacity)}</dd></div></dl>
      ${connection.transport === "subscription_cli" ? `<label class="connection-enable"><input type="checkbox" data-connection-provider="${escapeHtml(connection.provider)}" ${connection.enabled ? "checked" : ""}> Eligible for runs</label>` : `<span class="muted">${connection.transport === "api" ? "Controlled by the paid API policy below" : "Controlled from the local runtime configuration"}</span>`}
    </article>`;
  }).join("");
}

function renderSettings() {
  const config = state.bootstrap.config;
  const options = state.bootstrap.providers.map((provider) => `<option value="${provider.name}">${escapeHtml(provider.name)}</option>`).join("");
  $("#setting-architect").innerHTML = options;
  $("#setting-reviewer").innerHTML = options;
  $("#setting-architect").value = config.product.architect;
  $("#setting-reviewer").value = config.product.reviewer;
  $("#setting-agents").value = config.application.concurrency.agents;
  $("#setting-autonomy").value = config.runPolicy.autonomy;
  $("#run-autonomy").value = config.runPolicy.autonomy;
  renderRunAutonomyHelp();
  $("#setting-plan-approval").checked = config.runPolicy.requirePlanApproval;
  $("#setting-external-writes").checked = config.runPolicy.allowExternalWrites;
  $("#setting-paid-api").checked = config.runPolicy.allowPaidApi;
  $("#setting-fallback").checked = config.routing.allowFallback;
  $("#setting-routing-mode").value = config.routing.mode || "adaptive";
  $("#openrouter-enabled").checked = config.openRouter.enabled;
  $("#openrouter-paid-fallback").checked = config.openRouter.allowPaidFallback;
  $("#openrouter-run-limit").value = config.openRouter.perRunLimitUsd;
  $("#openrouter-month-limit").value = config.openRouter.monthlyLimitUsd;
  const modelOptions = ['<option value="">Configured provider default</option>', ...state.models.filter((model) => model.qualified && !model.excluded).map((model) => {
    const connection = state.connections.find((item) => item.id === model.connectionId);
    return `<option value="${escapeHtml(model.id)}">${escapeHtml(connection?.displayName || model.connectionId)} / ${escapeHtml(model.displayName)}</option>`;
  })].join("");
  const effortOptions = ["low", "medium", "high", "xhigh", "max"].map((effort) => `<option value="${effort}">${effort}</option>`).join("");
  const tierOptions = [["auto", "Automatic"], ["economy", "Economy"], ["standard", "Standard"], ["premium", "Premium"]].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  for (const role of ["architect", "worker", "reviewer"]) {
    $(`#setting-${role}-model`).innerHTML = modelOptions;
    $(`#setting-${role}-model`).value = config.routing[role].modelId || "";
    $(`#setting-${role}-effort`).innerHTML = effortOptions;
    $(`#setting-${role}-effort`).value = config.routing[role].effort;
    $(`#setting-${role}-tier`).innerHTML = tierOptions;
    $(`#setting-${role}-tier`).value = config.routing[role].preferredTier || "auto";
    $(`#setting-${role}-upgrade`).value = config.routing[role].upgradePolicy || "pinned";
  }
  $("#setting-workers").innerHTML = state.bootstrap.providers.map((provider) =>
    `<label class="toggle"><input type="checkbox" name="setting-worker" value="${provider.name}" ${config.product.workers.includes(provider.name) ? "checked" : ""}><span>${escapeHtml(provider.name)}</span></label>`
  ).join("");
}

function renderOpenRouterStatus() {
  const status = $("#openrouter-status");
  if (!status) return;
  status.textContent = state.openRouter.connected
    ? `Connected. Provider credit/limit status is checked before paid routing.`
    : "Disconnected. No paid API request can run.";
  $("#openrouter-connect").classList.toggle("hidden", state.openRouter.connected);
  $("#openrouter-disconnect").classList.toggle("hidden", !state.openRouter.connected);
}

function renderRunAutonomyHelp() {
  const help = {
    observe: "Read-only diagnostics and evidence. No repository changes.",
    supervised: "Agents may prepare repository changes after you approve the plan.",
    bounded: "Agents may execute within the configured tool and repository boundaries.",
  };
  $("#run-autonomy-help").textContent = help[$("#run-autonomy").value] || help.supervised;
}

function renderModels() {
  const allCurrentModels = state.models.filter((model) => !model.retired);
  const query = $("#model-filter")?.value.trim().toLowerCase() || "";
  const statusFilter = $("#model-status-filter")?.value || "all";
  const currentModels = allCurrentModels.filter((model) => {
    const matchesQuery = !query || `${model.displayName} ${model.canonicalName} ${model.connectionId}`.toLowerCase().includes(query);
    const isStale = model.qualified && model.qualificationStale;
    const matchesStatus = statusFilter === "all" || statusFilter === "active" && model.active && !isStale || statusFilter === "qualified" && model.qualified && !isStale || statusFilter === "stale" && isStale || statusFilter === "unqualified" && !model.qualified;
    return matchesQuery && matchesStatus;
  });
  const qualified = allCurrentModels.filter((model) => model.qualified && !model.qualificationStale).length;
  const active = allCurrentModels.filter((model) => model.active && !model.qualificationStale).length;
  $("#model-summary").innerHTML = `<div class="metric"><span>Current</span><strong>${allCurrentModels.length}</strong></div><div class="metric"><span>Currently qualified</span><strong>${qualified}</strong></div><div class="metric"><span>Schedulable active</span><strong>${active}</strong></div><div class="metric"><span>Advisory local slots</span><strong>${state.resources?.advisoryLocalSlots ?? "?"}</strong></div>`;
  const runtimes = state.bootstrap.config.localRuntimes?.ollama || [];
  $("#runtime-list").innerHTML = runtimes.map((runtime) => {
    const connection = state.connections.find((item) => item.metadata?.runtimeId === runtime.id);
    const status = connection?.available ? "Ready" : connection?.installed ? "No installed models" : "Not reachable";
    return `<article class="connection-card"><span class="connection-kind">LOCAL RUNTIME</span><h3>${escapeHtml(runtime.displayName)}</h3><p>${escapeHtml(runtime.baseUrl)}</p><span class="status ${connection?.available ? "ready" : "warning"}">${status}</span></article>`;
  }).join("");
  $("#model-list").innerHTML = currentModels.length ? currentModels.map((model) => {
    const connection = state.connections.find((item) => item.id === model.connectionId);
    const profile = model.metadata?.devHarmonicsProfile || {};
    const tier = profile.tier || "unclassified";
    const effort = profile.reasoningEffort ? ` · reasoning: ${profile.reasoningEffort}` : "";
    const confidence = profile.confidence ? ` · evidence: ${profile.confidence}` : "";
    const qualify = `<button class="secondary small" data-qualify-model="${escapeHtml(model.id)}">${model.qualified ? "Requalify" : connection?.transport === "local" ? "Qualify locally" : connection?.provider === "openrouter" ? "Qualify paid model" : "Verify subscription model"}</button>`;
    const activate = `<button class="secondary small" data-activate-model="${escapeHtml(model.id)}">${model.active ? "Deactivate" : "Activate"}</button>`;
    const health = model.health?.state && model.health.state !== "ready" ? ` · ${model.health.state}` : "";
    const history = state.qualifications.filter((item) => item.modelId === model.id).slice(0, 5);
    const performance = state.performanceProfiles.find((item) => item.modelId === model.id);
    const performancePolicy = state.performancePolicies.find((item) => item.modelId === model.id);
    const empiricalHtml = performance
      ? `<p class="empirical-profile"><strong>Observed performance:</strong> ${Math.round(performance.successRate * 100)}% completed · ${Math.round(performance.firstAttemptSuccessRate * 100)}% first-pass · ${performance.averageLatencyMs == null ? "latency unavailable" : `${formatDuration(performance.averageLatencyMs)} average`} · ${performance.averageCostUsd == null ? "cost unavailable" : `$${Number(performance.averageCostUsd).toFixed(4)} average billed cost (${performance.billedSampleCount} billed)`} · ${performance.validatorFailureCount} validator failures · ${performance.integrationConflictCount} integration conflicts · ${performance.notReadyRunCount} NOT READY runs (non-causal) · ${performance.sampleSize} samples · <span class="uncertainty ${escapeHtml(performance.uncertainty)}">${escapeHtml(performance.uncertainty)} evidence</span>${performance.observationsExcluded ? " · excluded by user" : performance.eligibleForAdaptiveWeighting ? " · eligible for adaptive weighting" : " · not used for adaptive weighting yet"}</p>`
      : `<p class="empirical-profile"><strong>Observed performance:</strong> No observations in the current baseline; published capabilities only.${performancePolicy?.ignoredBefore ? ` Baseline reset ${escapeHtml(new Date(performancePolicy.ignoredBefore).toLocaleString())}.` : ""}</p>`;
    const workloadHtml = performance && Object.keys(performance.workloads || {}).length
      ? `<details class="qualification-history workload-history"><summary>Workload evidence (${Object.keys(performance.workloads).length})</summary>${Object.entries(performance.workloads).map(([workload, slice]) => `<p><strong>${escapeHtml(workload.replace(":", " / "))}</strong> · ${Math.round(slice.successRate * 100)}% completed · ${Math.round(slice.firstAttemptSuccessRate * 100)}% first-pass · ${slice.averageCostUsd == null ? "cost unavailable" : `$${Number(slice.averageCostUsd).toFixed(4)} average billed cost`} · ${slice.validatorFailureCount} validator failures · ${slice.integrationConflictCount} integration conflicts · ${slice.notReadyRunCount} NOT READY runs (non-causal) · ${slice.sampleSize} samples · ${escapeHtml(slice.uncertainty)}</p>`).join("")}</details>`
      : "";
    const performanceActions = `<button class="secondary small" data-reset-performance="${escapeHtml(model.id)}">Reset observation baseline</button><button class="secondary small" data-exclude-performance="${escapeHtml(model.id)}">${performancePolicy?.excluded ? "Include empirical history" : "Exclude empirical history"}</button>`;
    const historyHtml = `<details class="qualification-history"><summary>Qualification history (${history.length})</summary>${history.length ? history.map((item) => `<p><strong>${escapeHtml(item.passed ? "PASS" : "FAIL")}</strong> ${escapeHtml(item.role)} · ${escapeHtml(item.fixtureVersion)} · ${escapeHtml(new Date(item.createdAt).toLocaleString())}</p>`).join("") : "<p>No probes recorded.</p>"}</details>`;
    const isStale = model.qualified && model.qualificationStale;
    const stateText = isStale ? "Qualification stale; it will not be scheduled until requalified" : model.excluded ? "Excluded from scheduling" : model.active ? "Active for adaptive scheduling" : model.qualified ? "Qualified; activate to make it available to the adaptive scheduler" : "Not schedulable until runtime verification and qualification pass";
    return `<article class="model-card"><div><span class="connection-kind">${escapeHtml(connection?.displayName || model.connectionId)}</span><h3>${escapeHtml(model.displayName)}</h3><code>${escapeHtml(model.canonicalName)}</code></div><span class="lifecycle ${isStale ? "degraded" : escapeHtml(model.lifecycle)}">${isStale ? "stale" : escapeHtml(model.lifecycle)}</span><p>Tier: ${escapeHtml(tier + effort + confidence)}${escapeHtml(health)}. ${stateText}. Upgrade policy: ${model.upgradePolicy === "track_family" ? "track family" : "pinned exact"}.</p>${empiricalHtml}${workloadHtml}<div class="model-actions">${qualify}${activate}<button class="secondary small" data-pin-model="${escapeHtml(model.id)}">${model.pinned ? "Unpin" : "Pin"}</button><button class="secondary small" data-track-model="${escapeHtml(model.id)}">${model.upgradePolicy === "track_family" ? "Pin exact" : "Track family"}</button><button class="secondary small" data-exclude-model="${escapeHtml(model.id)}">${model.excluded ? "Include" : "Exclude"}</button>${performanceActions}</div>${historyHtml}</article>`;
  }).join("") : '<div class="panel empty-state">No current models match this filter.</div>';
  $("#model-connection").innerHTML = state.connections.map((connection) => `<option value="${escapeHtml(connection.id)}">${escapeHtml(connection.displayName)}</option>`).join("");
}

function showView(view) {
  closeTask();
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#setup-view").classList.toggle("hidden", view !== "setup");
  $("#models-view").classList.toggle("hidden", view !== "models");
  $("#evidence-view").classList.toggle("hidden", view !== "evidence");
  $("#products-view").classList.toggle("hidden", view !== "products");
  if (view === "runs") {
    $("#composer").classList.toggle("hidden", Boolean(state.selectedRunId) && !state.composing);
    $("#run-view").classList.toggle("hidden", !state.selectedRunId || state.composing);
    $("#page-title").textContent = state.selectedRunId && !state.composing ? "Verified agent run" : "Assemble a verified agent team";
  } else {
    $("#composer").classList.add("hidden");
    $("#run-view").classList.add("hidden");
    $("#page-title").textContent = view === "setup" ? "Configure the control plane" : view === "models" ? "Manage the model fleet" : view === "products" ? "Operate across real products" : "Inspect retained evidence";
  }
}

async function refreshEvidence() {
  const runId = state.selectedRunId || state.runs[0]?.id;
  if (!runId) {
    $("#evidence-empty").classList.remove("hidden");
    $("#evidence-content").classList.add("hidden");
    return;
  }
  state.selectedRunId = runId;
  state.evidence = await api(`/api/runs/${runId}/evidence`);
  const evidence = state.evidence;
  $("#evidence-empty").classList.add("hidden");
  $("#evidence-content").classList.remove("hidden");
  $("#evidence-metrics").innerHTML = `<div class="metric"><span>Tasks</span><strong>${evidence.run.tasks.length}</strong></div><div class="metric"><span>Attempts</span><strong>${evidence.attempts.length}</strong></div><div class="metric"><span>Checks</span><strong>${evidence.run.tasks.flatMap((task) => task.checks).length}</strong></div><div class="metric"><span>Blackboard entries</span><strong>${evidence.blackboard.length}</strong></div>`;
  $("#evidence-hash").textContent = evidence.integritySha256;
  $("#evidence-attempts").innerHTML = evidence.attempts.length ? evidence.attempts.map((attempt) => `<article><div><strong>${escapeHtml(attempt.task_id)}</strong><span>${escapeHtml(attempt.provider)} / ${escapeHtml(attempt.model_id || "provider default")}</span></div><span class="lifecycle ${attempt.status === "completed" ? "qualified" : ""}">${escapeHtml(attempt.status)}</span><details class="evidence-report"><summary>View normalized report</summary><p>${escapeHtml(attempt.result_envelope?.summary || attempt.error || "No normalized summary")}</p></details></article>`).join("") : '<div class="empty-state">No attempts were started.</div>';
}

function renderProviders() {
  const providers = state.bootstrap.providers;
  const ready = (provider) => provider.available;
  const statusLabel = (provider) => ready(provider)
    ? "Ready"
    : !provider.enabled
      ? "Disabled"
      : !provider.installed
        ? "Install required"
        : !provider.authenticated
          ? "Sign-in required"
          : "Unavailable";
  $("#provider-status").innerHTML = providers
    .map((provider) => `<span class="provider-chip ${ready(provider) ? "online" : ""}" title="${escapeHtml(provider.summary)}"><i></i>${escapeHtml(provider.name)}</span>`)
    .join("");
  $("#provider-toggles").innerHTML = providers
    .map((provider) => `<label class="toggle" title="${escapeHtml(provider.summary)}"><input type="checkbox" name="provider" value="${provider.name}" ${ready(provider) ? "checked" : "disabled"}><span>${escapeHtml(provider.name)}</span></label>`)
    .join("");
  $("#provider-help-content").innerHTML = providers
    .map((provider) => `<section class="provider-help-card"><div><strong>${escapeHtml(provider.name)} <span class="auth-label ${ready(provider) ? "ready" : "required"}">${statusLabel(provider)}</span></strong><code>${escapeHtml(provider.loginCommand)}</code></div><p class="muted">${escapeHtml(provider.summary)}</p><ol>${provider.setupSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section>`)
    .join("");
  const unavailable = providers.filter((provider) => !ready(provider));
  $("#provider-auth-gate").classList.toggle("hidden", unavailable.length === 0);
  $("#provider-auth-message").textContent = unavailable.length
    ? unavailable.map((provider) => `${provider.name}: ${provider.summary}`).join(" · ")
    : "";
}

async function refreshProviderStatus() {
  const button = $("#refresh-provider-status");
  button.disabled = true;
  try {
    state.bootstrap = await api("/api/bootstrap");
    renderProviders();
    showError("");
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refreshRuns() {
  const result = await api("/api/runs");
  state.runs = result.runs;
  if (!state.composing && !state.selectedRunId && state.runs.length) {
    state.selectedRunId = state.runs[0].id;
  }
  const observedCursor = state.runs
    .flatMap((run) => run.events)
    .reduce((highest, event) => Math.max(highest, event.cursor || event.id || 0), 0);
  if (!state.cursorInitialized) {
    if (state.eventCursor > observedCursor) {
      state.eventCursor = observedCursor;
      sessionStorage.setItem("devharmonics-event-cursor", String(observedCursor));
    }
    state.cursorInitialized = true;
  }
  rememberEventCursor(observedCursor);
  renderRunList();
  renderSelectedRun();
}

function connectEventStream() {
  state.eventSource?.close();
  const source = new EventSource(`/api/events?after=${state.eventCursor}`);
  state.eventSource = source;
  source.addEventListener("open", () => setLiveState("Live", true));
  source.addEventListener("run-event", (message) => {
    const cursor = Number(message.lastEventId);
    if (!Number.isSafeInteger(cursor) || cursor <= state.eventCursor) return;
    rememberEventCursor(cursor);
    scheduleRunRefresh();
  });
  source.addEventListener("error", () => setLiveState("Reconnecting", false));
}

function rememberEventCursor(cursor) {
  if (!Number.isSafeInteger(cursor) || cursor <= state.eventCursor) return;
  state.eventCursor = cursor;
  sessionStorage.setItem("devharmonics-event-cursor", String(cursor));
}

function scheduleRunRefresh() {
  if (state.refreshScheduled) return;
  state.refreshScheduled = true;
  setTimeout(async () => {
    try {
      await refreshRuns();
    } catch (error) {
      showError(error.message);
    } finally {
      state.refreshScheduled = false;
    }
  }, 50);
}

function setLiveState(label, online) {
  const indicator = document.querySelector(".live");
  if (!indicator) return;
  indicator.classList.toggle("offline", !online);
  indicator.lastChild.textContent = ` ${label}`;
}

function renderRunList() {
  $("#run-list").innerHTML = state.runs
    .map((run) => `<button class="run-link ${run.id === state.selectedRunId ? "active" : ""}" data-run-id="${run.id}" title="${escapeHtml(run.goal)}">${escapeHtml(run.goalSummary || run.goal)}<small>${escapeHtml(run.status.replaceAll("_", " "))}</small></button>`)
    .join("");
}

function renderSelectedRun() {
  const run = state.runs.find((item) => item.id === state.selectedRunId);
  if (!run) return;
  if (state.view !== "runs") return;
  $("#composer").classList.add("hidden");
  $("#run-view").classList.remove("hidden");
  $("#page-title").textContent = "Verified agent run";
  const autonomyLabel = run.autonomy === "observe" ? "Observe only" : run.autonomy === "bounded" ? "Bounded autonomy" : "Supervised";
  $("#run-project").textContent = `${run.projectPath} · ${autonomyLabel}`;
  const goalSummary = run.goalSummary || run.goal;
  $("#run-goal").textContent = goalSummary;
  $("#run-goal-full").textContent = run.goal;
  $("#run-objective").hidden = goalSummary === run.goal;
  $("#run-status").textContent = run.status.replaceAll("_", " ");
  $("#run-status").className = `status-pill ${run.status}`;
  $("#pause-run").classList.toggle("hidden", !["planning", "running", "awaiting_approval"].includes(run.status));
  $("#approve-run").classList.toggle("hidden", run.status !== "awaiting_approval");
  $("#resume-run").classList.toggle("hidden", run.status !== "paused");
  $("#cancel-run").classList.toggle("hidden", !["planning", "running", "awaiting_approval", "paused"].includes(run.status));
  $("#metric-tasks").textContent = run.tasks.length;
  $("#metric-checks").textContent = run.tasks.flatMap((task) => task.checks).filter((check) => check.passed).length;
  $("#metric-attempts").textContent = run.tasks.reduce((sum, task) => sum + task.attemptCount, 0);
  $("#metric-active").textContent = run.tasks.filter((task) => ["working", "verifying", "retry"].includes(task.status)).length;
  renderBoard(run);
  renderActivity(run);
  renderVerdict(run);
}

function renderBoard(run) {
  const columns = [
    ["Plan", ["queued"]],
    ["Working", ["working", "retry"]],
    ["Verifying", ["verifying"]],
    ["Resolved", ["passed", "paused", "failed", "blocked", "cancelled"]],
  ];
  $("#board").innerHTML = columns.map(([title, statuses]) => {
    const tasks = run.tasks.filter((task) => statuses.includes(task.status));
    return `<section class="column"><div class="column-head"><span>${title}</span><b>${tasks.length}</b></div>${tasks.map(taskCard).join("") || '<div class="empty-state">No tasks</div>'}</section>`;
  }).join("");
}

function taskCard(task) {
  const passed = task.checks.filter((check) => check.passed).length;
  return `<button class="task-card ${task.status}" data-task-id="${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong><div class="task-contract"><span>${escapeHtml(task.permission.replaceAll("_", " "))}</span><span>${escapeHtml(task.risk)} risk</span></div><div class="task-meta"><span class="provider-tag">${escapeHtml(task.provider || "unassigned")}</span><span>${passed}/${task.checks.length} checks · ${task.attemptCount} tries</span></div></button>`;
}

function renderActivity(run) {
  $("#activity").innerHTML = run.events.length
    ? run.events.map((event) => `<div class="event"><time>${new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>${escapeHtml(event.message)}</span></div>`).join("")
    : '<div class="empty-state">Waiting for the first event…</div>';
}

function renderVerdict(run) {
  if (!run.finalReview) {
    $("#verdict").className = "empty-state";
    $("#verdict").textContent = "The reviewer’s verdict will appear after integration.";
    return;
  }
  const ready = run.finalReview.trimStart().startsWith("READY");
  $("#verdict").className = `verdict ${ready ? "ready" : "not-ready"}`;
  $("#verdict").textContent = run.finalReview;
}

function openTask(taskId) {
  const run = state.runs.find((item) => item.id === state.selectedRunId);
  const task = run?.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const routingEvent = [...run.events].reverse().find((event) => event.kind === "task.started" && event.data?.taskId === taskId && event.data?.routing);
  const routing = routingEvent?.data?.routing;
  $("#drawer-content").innerHTML = `
    <p class="drawer-kicker">${escapeHtml(task.status)}</p>
    <h2 class="drawer-title">${escapeHtml(task.title)}</h2>
    <p class="drawer-meta">${escapeHtml(task.provider || "Unassigned")} · ${task.attemptCount} attempts</p>
    <h3>Task contract</h3>
    <dl class="contract-details">
      <div><dt>Permission</dt><dd>${escapeHtml(task.permission.replaceAll("_", " "))}</dd></div>
      <div><dt>Risk</dt><dd>${escapeHtml(task.risk)}</dd></div>
      <div><dt>Kind</dt><dd>${escapeHtml(task.kind)}</dd></div>
      <div><dt>Repository scope</dt><dd>${task.repositoryScope.map(escapeHtml).join("<br>")}</dd></div>
    </dl>
    <p>${escapeHtml(task.description)}</p>
    ${routingEvidenceMarkup(routing)}
    <h3>Acceptance criteria</h3>
    ${task.acceptanceCriteria.length ? `<ul>${task.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<div class="empty-state">No acceptance criteria supplied.</div>'}
    <h3>Expected artifacts</h3>
    ${task.expectedArtifacts.length ? `<ul>${task.expectedArtifacts.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<div class="empty-state">No expected artifacts supplied.</div>'}
    <h3>Verification receipts</h3>
    ${task.checks.length ? task.checks.map(checkMarkup).join("") : '<div class="empty-state">No checks have run yet.</div>'}
  `;
  $("#task-drawer").scrollTop = 0;
  $("#drawer-backdrop").classList.remove("hidden");
  $("#task-drawer").classList.add("open");
  $("#task-drawer").setAttribute("aria-hidden", "false");
  $("#task-drawer").removeAttribute("inert");
}

function checkMarkup(check) {
  const output = [check.stdout, check.stderr].filter(Boolean).join("\n") || "No output";
  return `<div class="check"><div class="check-head"><strong>${escapeHtml(check.name)}</strong><span class="${check.passed ? "pass" : "fail"}">${check.passed ? "PASS" : `FAIL ${check.exitCode}`}</span></div><pre>${escapeHtml(output)}</pre></div>`;
}

function closeTask() {
  $("#drawer-backdrop").classList.add("hidden");
  $("#task-drawer").classList.remove("open");
  $("#task-drawer").setAttribute("aria-hidden", "true");
  $("#task-drawer").setAttribute("inert", "");
}

async function startRun() {
  const goal = $("#goal").value.trim();
  const enabledProviders = [...document.querySelectorAll('input[name="provider"]:checked')].map((input) => input.value);
  if (!goal) return showError("Describe the outcome first.");
  if (!enabledProviders.length) return showError("Sign in to and enable at least one provider.");
  const mode = $("#agent-mode").value;
  const agents = mode === "auto" ? "auto" : Number($("#agent-count").value);
  $("#start-run").disabled = true;
  showError("");
  try {
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, projectPath: $("#project-path").value, autonomy: $("#run-autonomy").value, agents, enabledProviders }),
    });
    state.composing = false;
    state.selectedRunId = result.runId;
    await refreshRuns();
  } catch (error) {
    showError(error.message);
  } finally {
    $("#start-run").disabled = false;
  }
}

function showError(message) { $("#composer-error").textContent = message; }
function showComposer() {
  closeTask();
  showView("runs");
  state.composing = true;
  state.selectedRunId = null;
  $("#composer").classList.remove("hidden");
  $("#run-view").classList.add("hidden");
  $("#page-title").textContent = "Assemble a verified agent team";
  renderRunList();
  $("#goal").focus();
}

$("#agent-mode").addEventListener("change", (event) => { $("#agent-count").disabled = event.target.value === "auto"; });
$("#run-autonomy").addEventListener("change", renderRunAutonomyHelp);
$("#start-run").addEventListener("click", startRun);
$("#refresh-provider-status").addEventListener("click", refreshProviderStatus);
$("#cancel-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  const button = $("#cancel-run");
  button.disabled = true;
  showError("");
  try {
    await api(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await refreshRuns();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#new-run").addEventListener("click", showComposer);
document.querySelector(".app-nav").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  showView(button.dataset.view);
  if (button.dataset.view === "setup" || button.dataset.view === "models") await refreshFleet();
  if (button.dataset.view === "evidence") await refreshEvidence();
  if (button.dataset.view === "products") await refreshProducts();
});
$("#refresh-products").addEventListener("click", refreshProducts);
$("#refresh-evidence").addEventListener("click", refreshEvidence);
$("#pause-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  const button = $("#pause-run");
  button.disabled = true;
  try {
    await api(`/api/runs/${runId}/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await refreshRuns();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#approve-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  const button = $("#approve-run");
  button.disabled = true;
  try {
    await api(`/api/runs/${runId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await refreshRuns();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#resume-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  const button = $("#resume-run");
  button.disabled = true;
  try {
    const result = await api(`/api/runs/${runId}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    state.selectedRunId = result.runId;
    await refreshRuns();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#refresh-setup").addEventListener("click", async () => {
  state.bootstrap = await api("/api/bootstrap");
  renderProviders();
  renderSettings();
  await refreshFleet();
});
$("#refresh-models").addEventListener("click", async () => {
  const button = $("#refresh-models");
  button.disabled = true;
  try {
    const refreshed = await api("/api/catalog/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    state.bootstrap = { ...state.bootstrap, config: refreshed.config, providers: refreshed.providers, ollama: refreshed.ollama, catalog: { refreshedAt: refreshed.refreshedAt, refreshes: refreshed.refreshes } };
    await refreshFleet();
    $("#model-message").textContent = `Fleet refreshed at ${new Date(refreshed.refreshedAt).toLocaleString()}.`;
  } catch (error) {
    $("#model-message").textContent = error.message;
    await refreshFleet();
  } finally {
    button.disabled = false;
  }
});

$("#openrouter-connect").addEventListener("click", async () => {
  try {
    const result = await api("/api/openrouter/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    $("#openrouter-status").textContent = error.message;
  }
});

$("#openrouter-disconnect").addEventListener("click", async () => {
  await api("/api/openrouter/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await refreshFleet();
});

$("#openrouter-search").addEventListener("click", searchOpenRouterCatalog);
$("#model-filter").addEventListener("input", renderModels);
$("#model-status-filter").addEventListener("change", renderModels);
$("#openrouter-model-query").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void searchOpenRouterCatalog(); } });
async function searchOpenRouterCatalog() {
  const query = $("#openrouter-model-query").value.trim();
  const result = await api(`/api/openrouter/catalog?q=${encodeURIComponent(query)}`);
  $("#openrouter-catalog").innerHTML = result.models.map((model) => `<article class="model-card"><div><span class="connection-kind">OPENROUTER CATALOG</span><h3>${escapeHtml(model.displayName)}</h3><code>${escapeHtml(model.canonicalName)}</code></div><p>Context: ${Number(model.metadata.contextLength || 0).toLocaleString()} · estimated qualification: ${model.estimatedQualificationCostUsd == null ? "unknown" : `$${Number(model.estimatedQualificationCostUsd).toFixed(5)}`}</p>${model.exact ? `<button class="secondary small" data-import-openrouter="${escapeHtml(model.canonicalName)}">Import exact candidate</button>` : '<span class="muted">Moving alias · discovery only</span>'}</article>`).join("") || '<div class="empty-state">No matching catalog models.</div>';
}

function routingEvidenceMarkup(routing) {
  if (!routing) return '<h3>Why this model</h3><div class="empty-state">Routing evidence is not available for this earlier attempt.</div>';
  const labels = {
    manualAssignment: "Manual assignment",
    baseEligibility: "Eligible candidate",
    tierFit: "Workload tier fit",
    reasoningFit: "Reasoning fit",
    userPin: "User pin",
    preferredProvider: "Preferred provider",
    fallbackProvider: "Fallback affinity",
    empiricalReliability: "Empirical reliability",
    empiricalLatency: "Workload latency",
    providerDiversity: "Independent provider",
    costAwareness: "Relative paid-model cost",
  };
  const scoreRows = Object.entries(routing.scoreBreakdown || {}).filter(([, value]) => Number(value) !== 0)
    .map(([key, value]) => `<div><dt>${escapeHtml(labels[key] || key)}</dt><dd>${Number(value) > 0 ? "+" : ""}${escapeHtml(value)}</dd></div>`).join("");
  const modelName = routing.model?.alias || routing.model?.requestedModelId || "provider default";
  return `<h3>Why this model</h3><p>${escapeHtml(routing.provider)} / ${escapeHtml(modelName)} was selected for a ${escapeHtml(routing.workload?.complexity || "classified")} task requiring the ${escapeHtml(routing.workload?.requiredTier || "configured")} tier.</p><dl class="contract-details routing-score">${scoreRows}<div><dt>Total routing score</dt><dd>${escapeHtml(routing.score)}</dd></div></dl>${routing.factors?.length ? `<ul>${routing.factors.map((factor) => `<li>${escapeHtml(factor)}</li>`).join("")}</ul>` : ""}`;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}
$("#openrouter-catalog").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-import-openrouter]");
  if (!button) return;
  await api("/api/openrouter/models/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId: button.dataset.importOpenrouter }) });
  $("#model-message").textContent = "OpenRouter candidate imported. It remains inactive until you explicitly qualify and activate it.";
  await refreshFleet();
});
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = structuredClone(state.bootstrap.config);
  const workers = [...document.querySelectorAll('input[name="setting-worker"]:checked')].map((input) => input.value);
  if (!workers.length) {
    $("#settings-message").textContent = "Choose at least one worker runtime.";
    return;
  }
  config.product = { architect: $("#setting-architect").value, reviewer: $("#setting-reviewer").value, workers };
  config.application.concurrency.agents = Number($("#setting-agents").value);
  config.runPolicy = {
    autonomy: $("#setting-autonomy").value,
    requirePlanApproval: $("#setting-plan-approval").checked,
    allowExternalWrites: $("#setting-external-writes").checked,
    allowPaidApi: $("#setting-paid-api").checked,
  };
  config.routing = {
    mode: $("#setting-routing-mode").value,
    architect: { modelId: $("#setting-architect-model").value || null, effort: $("#setting-architect-effort").value, preferredTier: $("#setting-architect-tier").value, upgradePolicy: $("#setting-architect-upgrade").value },
    worker: { modelId: $("#setting-worker-model").value || null, effort: $("#setting-worker-effort").value, preferredTier: $("#setting-worker-tier").value, upgradePolicy: $("#setting-worker-upgrade").value },
    reviewer: { modelId: $("#setting-reviewer-model").value || null, effort: $("#setting-reviewer-effort").value, preferredTier: $("#setting-reviewer-tier").value, upgradePolicy: $("#setting-reviewer-upgrade").value },
    allowFallback: $("#setting-fallback").checked,
  };
  config.openRouter = {
    ...config.openRouter,
    enabled: $("#openrouter-enabled").checked,
    allowPaidFallback: $("#openrouter-paid-fallback").checked,
    perRunLimitUsd: Number($("#openrouter-run-limit").value),
    monthlyLimitUsd: Number($("#openrouter-month-limit").value),
  };
  document.querySelectorAll("[data-connection-provider]").forEach((input) => {
    if (config.connections[input.dataset.connectionProvider]) config.connections[input.dataset.connectionProvider].enabled = input.checked;
  });
  try {
    const saved = await api("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
    state.bootstrap.config = saved.config;
    $("#settings-message").textContent = "Settings saved.";
    state.bootstrap = await api("/api/bootstrap");
    renderProviders();
    renderSettings();
    await refreshFleet();
  } catch (error) {
    $("#settings-message").textContent = error.message;
  }
});
$("#runtime-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = structuredClone(state.bootstrap.config);
  const runtime = { id: $("#runtime-id").value.trim(), displayName: $("#runtime-display").value.trim(), baseUrl: $("#runtime-url").value.trim(), enabled: true };
  config.localRuntimes ||= { ollama: [] };
  config.localRuntimes.ollama = [...config.localRuntimes.ollama.filter((item) => item.id !== runtime.id), runtime];
  try {
    const saved = await api("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
    state.bootstrap.config = saved.config;
    $("#model-message").textContent = `Added ${runtime.displayName}; refreshing local discovery.`;
    $("#runtime-form").reset();
    $("#runtime-url").value = "http://127.0.0.1:15434";
    state.bootstrap = await api("/api/bootstrap");
    await refreshFleet();
  } catch (error) {
    $("#model-message").textContent = error.message;
  }
});
$("#model-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    id: $("#model-id").value.trim(),
    connectionId: $("#model-connection").value,
    canonicalName: $("#model-canonical").value.trim(),
    displayName: $("#model-display").value.trim(),
    lifecycle: "known",
  };
  try {
    await api("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    $("#model-form").reset();
    $("#model-message").textContent = "Model added as known; it is not yet schedulable.";
    await refreshFleet();
  } catch (error) {
    $("#model-message").textContent = error.message;
  }
});
$("#model-list").addEventListener("click", async (event) => {
  const qualify = event.target.closest("[data-qualify-model]");
  const activate = event.target.closest("[data-activate-model]");
  const pin = event.target.closest("[data-pin-model]");
  const track = event.target.closest("[data-track-model]");
  const exclude = event.target.closest("[data-exclude-model]");
  const resetPerformance = event.target.closest("[data-reset-performance]");
  const excludePerformance = event.target.closest("[data-exclude-performance]");
  const button = qualify || activate || pin || track || exclude || resetPerformance || excludePerformance;
  if (!button) return;
  button.disabled = true;
  let qualifiedModelId = null;
  let preferenceModelId = null;
  try {
    if (resetPerformance || excludePerformance) {
      const modelId = resetPerformance?.dataset.resetPerformance || excludePerformance.dataset.excludePerformance;
      const policy = state.performancePolicies.find((item) => item.modelId === modelId);
      if (resetPerformance && !window.confirm("Reset this model's empirical baseline? Existing attempt evidence stays in the ledger but will no longer affect its profile.")) return;
      await api(`/api/model-performance/${encodeURIComponent(modelId)}/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resetPerformance ? { reset: true } : { excluded: !policy?.excluded }),
      });
      preferenceModelId = modelId;
    } else if (qualify) {
      const model = state.models.find((item) => item.id === qualify.dataset.qualifyModel);
      const connection = state.connections.find((item) => item.id === model.connectionId);
      const role = connection?.transport === "local" ? "analysis" : "general";
      $("#model-message").textContent = `Running a small, read-only ${role} qualification for ${model.displayName}...`;
      try {
        await api(`/api/models/${encodeURIComponent(model.id)}/qualify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
      } catch (error) {
        if (!error.data?.requiresCostConfirmation || !window.confirm(`This paid qualification is estimated to cost ${error.data.estimatedCostUsd == null ? "an unknown amount" : `$${Number(error.data.estimatedCostUsd).toFixed(5)}`}. Continue?`)) throw error;
        await api(`/api/models/${encodeURIComponent(model.id)}/qualify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, confirmPaidCost: true }) });
      }
      qualifiedModelId = model.id;
    } else {
      const modelId = activate?.dataset.activateModel || pin?.dataset.pinModel || track?.dataset.trackModel || exclude.dataset.excludeModel;
      const model = state.models.find((item) => item.id === modelId);
      const body = activate ? { active: !model.active } : pin ? { pinned: !model.pinned } : track ? { upgradePolicy: model.upgradePolicy === "track_family" ? "pinned" : "track_family" } : { excluded: !model.excluded };
      $("#model-message").textContent = "";
      try {
        await api(`/api/models/${encodeURIComponent(modelId)}/preference`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch (error) {
        if (!error.data?.requiresCostConfirmation || !window.confirm(`Activation requires a paid qualification estimated at ${error.data.estimatedCostUsd == null ? "an unknown amount" : `$${Number(error.data.estimatedCostUsd).toFixed(5)}`}. Continue?`)) throw error;
        await api(`/api/models/${encodeURIComponent(modelId)}/preference`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirmPaidCost: true }) });
      }
      preferenceModelId = modelId;
    }
    await refreshFleet();
    if (qualifiedModelId) {
      const qualifiedModel = state.models.find((model) => model.id === qualifiedModelId);
      $("#model-message").textContent = `${qualifiedModel?.displayName || "Model"} passed qualification. ${qualifiedModel?.active ? "It is active and schedulable." : "Activate it to schedule it."}`;
    } else if (preferenceModelId) {
      const preferenceModel = state.models.find((model) => model.id === preferenceModelId);
      $("#model-message").textContent = `${preferenceModel?.displayName || "Model"} scheduling preference updated.`;
    }
  } catch (error) {
    $("#model-message").textContent = error.message;
    await refreshFleet();
  } finally {
    button.disabled = false;
  }
});
$("#run-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-run-id]");
  if (button) {
    state.composing = false;
    state.selectedRunId = button.dataset.runId;
    renderRunList();
    renderSelectedRun();
  }
});
$("#board").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-id]");
  if (button) openTask(button.dataset.taskId);
});
$("#close-drawer").addEventListener("click", closeTask);
$("#drawer-backdrop").addEventListener("click", closeTask);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTask(); });

initialize().catch((error) => showError(error.message));
