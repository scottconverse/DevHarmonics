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
  report: null,
  products: [],
  productIntelligence: {},
  qualifications: [],
  performanceProfiles: [],
  performancePolicies: [],
  openRouter: { connected: false, key: null },
  objective: null,
  planRevision: null,
  planPreview: null,
  workbenchSessions: [],
  workbenchSession: null,
  workbenchMessages: [],
  steering: {},
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

// DH-632 visible operation feedback: one shared acknowledgement/lifecycle layer for
// every DevHarmonics-owned asynchronous action. Local UI operations register here;
// run tasks are projected into the same activity strip from durable ledger events,
// so refresh/navigation reconstructs run feedback while a page-local fetch that died
// with the page is honestly absent rather than faked.
const OPERATION_QUIET_WARNING_MS = 5 * 60 * 1000;
let operationSequence = 0;
const operations = new Map();

// A declined confirmation is neither a success nor a failure: the owner said
// "No" and nothing broke (MINOR gate finding, 2026-07-22). An action returns
// this sentinel so withOperation ends the shared operation as CANCELLED with
// honest copy, instead of the "done" that a plain return would have implied.
const OPERATION_CANCELLED = Symbol("dh-operation-cancelled");
function cancelledOperation(detail = "") {
  return { [OPERATION_CANCELLED]: true, detail };
}

// The end-state decision for an operation action that RESOLVED. A thrown error
// is a "failed" end state, handled separately in withOperation's catch, so this
// classifier only ever returns "cancelled" or "succeeded" — never "failed". A
// returned cancellation sentinel ends the operation as "cancelled" (the owner
// declined and nothing broke), carrying its own detail; every other resolved
// value is a plain "succeeded". Pulled out as a PURE seam so the shipped wrapper
// and its regression test classify identically (MINOR gate finding, 2026-07-22).
function classifyOperationOutcome(result) {
  if (result && result[OPERATION_CANCELLED]) {
    return { status: "cancelled", detail: result.detail || "" };
  }
  return { status: "succeeded", detail: "" };
}

function beginOperation(label) {
  const id = `op-${++operationSequence}`;
  operations.set(id, { id, label, status: "running", startedAt: Date.now(), detail: "" });
  renderActivityStrip();
  return id;
}

function endOperation(id, status, detail = "") {
  const operation = operations.get(id);
  if (!operation) return;
  operation.status = status;
  operation.detail = detail;
  operation.endedAt = Date.now();
  renderActivityStrip();
  const lingerMs = status === "failed" ? 12_000 : 4_000;
  setTimeout(() => { operations.delete(id); renderActivityStrip(); }, lingerMs);
}

function operationElapsed(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

async function withOperation(button, label, action, { onError = showError, busyLabel = null } = {}) {
  const id = beginOperation(label);
  const restore = button ? { html: button.innerHTML } : null;
  const hadFocus = Boolean(button) && document.activeElement === button;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (busyLabel) button.innerHTML = `<span class="op-spinner" aria-hidden="true"></span>${escapeHtml(busyLabel)}`;
    else button.insertAdjacentHTML("afterbegin", '<span class="op-spinner" aria-hidden="true"></span>');
  }
  try {
    const result = await action();
    const outcome = classifyOperationOutcome(result);
    if (outcome.status === "cancelled") {
      endOperation(id, outcome.status, outcome.detail);
      return undefined;
    }
    endOperation(id, outcome.status);
    return result;
  } catch (error) {
    endOperation(id, "failed", error.message);
    try {
      await onError(error.message, error);
    } catch {
      // the error surface itself failed; the strip already carries the failure
    }
    return undefined;
  } finally {
    if (button && restore) {
      button.innerHTML = restore.html;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      // disabling the control dropped keyboard focus; give it back
      if (hadFocus && button.isConnected && (document.activeElement === document.body || document.activeElement === null)) button.focus();
    }
  }
}

function taskActivityTimes(task, run) {
  const events = run?.events || [];
  let startedAt = null;
  let lastActivityAt = null;
  for (const event of events) {
    if (event.data?.taskId !== task.id) continue;
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at)) continue;
    if (event.kind === "task.started") startedAt = at;
    if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
  }
  return { startedAt, lastActivityAt };
}

const ACTIVE_TASK_STATUSES = ["working", "verifying", "retry"];

function activeRunOperations() {
  const items = [];
  for (const run of state.runs) {
    if (!["planning", "running"].includes(run.status)) continue;
    for (const task of run.tasks || []) {
      if (!ACTIVE_TASK_STATUSES.includes(task.status)) continue;
      const { startedAt, lastActivityAt } = taskActivityTimes(task, run);
      items.push({ run, task, startedAt, lastActivityAt });
    }
    if (!(run.tasks || []).length) {
      items.push({ run, task: null, startedAt: Date.parse(run.createdAt) || null, lastActivityAt: null });
    }
  }
  return items;
}

function quietMarkup(lastActivityAt) {
  if (!lastActivityAt) return "";
  const quietMs = Date.now() - lastActivityAt;
  const warn = quietMs >= OPERATION_QUIET_WARNING_MS;
  // The ticking duration stays permanently aria-hidden so the polite live region
  // never announces a clock; the warning note is separate, static text that is
  // announced once when it appears.
  return `<span class="op-quiet ${warn ? "warn" : ""}" data-quiet-since="${lastActivityAt}" title="DevHarmonics doesn't get progress updates while an AI provider is generating a reply — &quot;quiet&quot; just means we're still waiting on them, not that anything has stalled. This note appears after 5 minutes of silence."><span class="op-quiet-time" aria-hidden="true">quiet for ${operationElapsed(lastActivityAt)}</span>${warn ? '<span class="op-quiet-note"> — the provider call may still be running</span>' : ""}</span>`;
}

let activityStripSignature = "";

function renderActivityStrip() {
  const strip = $("#activity-strip");
  if (!strip) return;
  const local = [...operations.values()].map((operation) => {
    const stateLabel = operation.status === "running"
      ? `<span class="op-spinner" aria-hidden="true"></span>working · <span data-elapsed-since="${operation.startedAt}" aria-hidden="true">${operationElapsed(operation.startedAt)}</span>`
      : operation.status === "succeeded" ? "done"
        : operation.status === "cancelled" ? `declined — ${escapeHtml(operation.detail || "you declined this step; nothing was changed")}`
          : `failed — ${escapeHtml(operation.detail || "see the error message")}`;
    return `<div class="strip-item ${operation.status}"><strong>${escapeHtml(operation.label)}</strong><span>${stateLabel}</span></div>`;
  });
  const runItems = activeRunOperations().map(({ run, task, startedAt, lastActivityAt }) => {
    const title = task ? task.title : "Planning";
    const identity = task ? routingIdentity(taskRouting(run, task.id), task.provider) : "read-only architect";
    const elapsed = startedAt ? `<span data-elapsed-since="${startedAt}" aria-hidden="true">${operationElapsed(startedAt)}</span>` : "";
    return `<div class="strip-item running"><span class="op-spinner" aria-hidden="true"></span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(identity)}</span><span>${task ? escapeHtml(task.status) : "planning"}${elapsed ? " · " : ""}${elapsed}</span>${quietMarkup(lastActivityAt)}</div>`;
  });
  const items = [...runItems, ...local];
  // Re-render only when non-time content changes, so the polite live region
  // announces state transitions rather than every SSE-driven refresh; ticking
  // time spans stay aria-hidden and update in place via the interval below.
  const signature = items.join("").replace(/data-(elapsed|quiet)-since="\d+"[^<]*/g, "").replace(/quiet for [^<]*/g, "");
  if (signature === activityStripSignature) return;
  activityStripSignature = signature;
  strip.classList.toggle("hidden", !items.length);
  // Gap fixed (Slice A): the floating strip had no heading of its own — a
  // reader seeing it appear had no visible cue what it was without the
  // screen-reader-only aria-label.
  strip.innerHTML = items.length ? `<p class="strip-label">Working now</p>${items.join("")}` : "";
}

setInterval(() => {
  const now = Date.now();
  for (const element of document.querySelectorAll("[data-elapsed-since]")) {
    element.textContent = operationElapsed(Number(element.dataset.elapsedSince), now);
  }
  for (const element of document.querySelectorAll("[data-quiet-since]")) {
    const lastActivityAt = Number(element.dataset.quietSince);
    const warn = now - lastActivityAt >= OPERATION_QUIET_WARNING_MS;
    element.classList.toggle("warn", warn);
    const time = element.querySelector(".op-quiet-time");
    if (time) time.textContent = `quiet for ${operationElapsed(lastActivityAt, now)}`;
    if (warn && !element.querySelector(".op-quiet-note")) {
      element.insertAdjacentHTML("beforeend", '<span class="op-quiet-note"> — the provider call may still be running</span>');
    }
  }
}, 1_000);

function providerDisplayName(provider) {
  // Slice A: readers who signed in under the name "Gemini" (Google's own name
  // for it) would not recognize "Google Antigravity" as the same product —
  // the familiar name stays visible alongside the current product name.
  return provider === "gemini" ? "Google Antigravity (Gemini)" : provider || "Unassigned";
}

// Slice A pattern #1: every view gets exactly one title and one purpose
// sentence, rendered from this single source instead of a page-title ternary
// that used to carry different, inconsistent copy per branch.
const VIEW_DESCRIPTIONS = {
  runs: { title: "Runs", purpose: "Define an objective, approve the team's plan, and watch the work happen." },
  workbench: { title: "Workbench", purpose: "Ask one or more models questions about a project — read-only, nothing runs, nothing changes. Turn a good discussion into an objective when you're ready." },
  products: { title: "Products", purpose: "Register the real products and repositories the team works on, and see what DevHarmonics has verified about them." },
  workflows: { title: "Workflows", purpose: "Reusable, versioned job descriptions. Pick one, fill in its inputs, and it becomes a normal run." },
  setup: { title: "Setup", purpose: "The rules every run follows: who plans, who builds, who reviews, and what the team may do without asking you." },
  models: { title: "Models", purpose: "Every model DevHarmonics can use, what each has proven it can do, and why work gets routed where it does." },
  evidence: { title: "Evidence", purpose: "The permanent record of a run: what was done, what was checked, who reviewed it, and whether it all still holds together." },
};

function connectionDisplayName(connectionId, provider) {
  return state.connections.find((connection) => connection.id === connectionId)?.displayName || providerDisplayName(provider);
}

function modelDisplayName(modelId) {
  return state.models.find((model) => model.id === modelId)?.displayName || modelId || "provider default";
}

function taskRouting(run, taskId) {
  return [...(run?.events || [])].reverse().find((event) => event.kind === "task.started" && event.data?.taskId === taskId && event.data?.routing)?.data?.routing || null;
}

// Slice A pattern #4: one canonical phrase for unverified model identity,
// used everywhere DevHarmonics shows a model it asked for but hasn't had
// confirmed back — "the provider did not report which exact model ran;
// DevHarmonics shows what was requested and never claims more."
function routingIdentity(routing, fallbackProvider) {
  if (!routing) return providerDisplayName(fallbackProvider);
  const connection = connectionDisplayName(routing.connectionId, routing.provider || fallbackProvider);
  const requestedModelId = routing.model?.requestedModelId;
  return requestedModelId ? `${connection} / ${modelDisplayName(requestedModelId)} — requested model (identity unverified)` : `${connection} / provider default — requested model (identity unverified)`;
}

function recordedModelIdentity(provider, modelId, resolution, connectionId) {
  const connection = connectionDisplayName(connectionId, provider);
  const model = modelDisplayName(modelId);
  if (resolution === "requested_unverified") return `${connection} / ${model} — requested model (identity unverified)`;
  if (resolution === "provider_default_unresolved") return `${connection} / provider default — requested model (identity unverified)`;
  return `${connection} / ${model}`;
}

// Slice A: "can edit files" / "read-only" is used at every place a task
// shows its write permission — plan preview, board card, and task drawer.
function permissionLabel(permission) {
  return permission === "workspace_write" ? "can edit files" : permission === "read_only" ? "read-only" : String(permission || "").replaceAll("_", " ");
}

function eventDisplayMessage(event) {
  const routing = event.data?.routing;
  if (routing?.provider && event.message.startsWith(routing.provider)) {
    return `${routingIdentity(routing, routing.provider)}${event.message.slice(routing.provider.length)}`;
  }
  if (event.data?.provider === "gemini" && event.message.startsWith("gemini")) {
    const identity = recordedModelIdentity(event.data.provider, event.data.modelId, "requested_unverified", event.data.connectionId);
    return `${identity}${event.message.slice("gemini".length)}`;
  }
  return event.message.replace(/\bgemini\b/g, "Google Antigravity");
}

async function initialize() {
  showView(state.view);
  $("#models-view").insertBefore($("#openrouter-panel"), $("#model-filter-bar"));
  state.bootstrap = await api("/api/bootstrap");
  $("#project-path").value = state.bootstrap.defaultProject;
  $("#workbench-project").value = state.bootstrap.defaultProject;
  renderProviders();
  await refreshFleet();
  renderSettings();
  await refreshProducts();
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
  state.productIntelligence = Object.fromEntries(await Promise.all(state.products.map(async (product) => {
    const response = await fetch(`/api/products/${encodeURIComponent(product.id)}/intelligence`);
    if (response.status === 404) return [product.id, null];
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Could not load intelligence for ${product.name}`);
    return [product.id, value];
  })));
  const repositories = state.products.flatMap((product) => product.repositories);
  $("#repository-product").innerHTML = state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join("");
  const noProducts = state.products.length === 0;
  $("#add-local-repository").disabled = noProducts;
  $("#add-local-repository-help").classList.toggle("hidden", !noProducts);
  $("#product-summary").innerHTML = `<div class="metric"><span>Products</span><strong>${state.products.length}</strong></div><div class="metric"><span>Repositories</span><strong>${repositories.length}</strong></div><div class="metric"><span>Active repositories</span><strong>${repositories.filter((repository) => !repository.archived).length}</strong></div><div class="metric"><span>Private repositories</span><strong>${repositories.filter((repository) => repository.visibility === "private").length}</strong></div>`;
  $("#products-empty").classList.toggle("hidden", state.products.length > 0);
  $("#product-list").innerHTML = state.products.map((product) => {
    const intelligence = state.productIntelligence[product.id];
    const localSources = product.repositories.reduce((sum, repository) => sum + (repository.localPath ? repository.governanceSources.length : 0), 0);
    const conflicts = intelligence?.findings.filter((finding) => finding.kind === "conflicting_claim").length || 0;
    const intelligenceMarkup = intelligence ? `<details class="product-intelligence" ${conflicts ? "open" : ""}>
      <summary><strong>Intelligence scan: ${escapeHtml(intelligence.status)}</strong><span>Read ${intelligence.sources.filter((source) => source.status === "read").length} of the product's key documents, found ${intelligence.claims.length} factual statements, and ${conflicts} of them contradict each other across repositories.</span></summary>
      <p class="muted">Scanned ${escapeHtml(new Date(intelligence.createdAt).toLocaleString())} (result #${escapeHtml(intelligence.id.slice(0, 8))}) — each scan is saved permanently and never edited; if the repositories change, scan again rather than overwrite this result.</p>
      ${intelligence.findings.length ? `<ul>${intelligence.findings.map((finding) => `<li class="${escapeHtml(finding.severity)}"><strong>${escapeHtml(finding.kind.replaceAll("_", " "))}</strong> ${escapeHtml(finding.message)}${finding.citations.length ? `<small>${finding.citations.map(escapeHtml).join(" · ")}</small>` : ""}</li>`).join("")}</ul>` : '<p class="muted">No conflicts or unavailable sources were found.</p>'}
    </details>` : `<div class="product-intelligence empty"><strong>No scan has run yet</strong><span>${localSources ? `${localSources} tracked files are ready to scan.` : "Attach a local repository and list its key documents first."}</span></div>`;
    return `<article class="panel product-card">
    <div class="product-head"><div><span class="connection-kind">Registered product</span><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.description || "Registered product context")}</p></div><div class="product-actions"><a href="${escapeHtml(product.organizationUrl)}" target="_blank" rel="noreferrer">Open organization</a><button class="secondary small" type="button" data-scan-product="${escapeHtml(product.id)}" title="Reads this product's tracked documents across all its repositories and flags outdated or conflicting information.">Scan intelligence</button></div></div>
    ${intelligenceMarkup}
    <div class="repository-list">${product.repositories.map((repository) => {
      const local = repository.inspection || null;
      const issues = local?.compatibilityIssues || [];
      const facts = [repository.role ? repository.role.replaceAll("_", " ") : null, local?.currentBranch || repository.defaultBranch, local ? local.dirty ? "dirty" : "clean" : null, ...issues.slice(0, 2)].filter(Boolean);
      const scanTitle = local ? "Checks again, in case the repository changed since the last check." : "Checks this repository's real files on disk and updates its status.";
      return `<div class="repository-row ${repository.localPath ? "local" : ""}"><span><strong>${escapeHtml(repository.name)}</strong><small>ID: <code>${escapeHtml(repository.id)}</code> · ${escapeHtml(repository.localPath || repository.fullName)} · ${escapeHtml(repository.visibility)}${local?.headSha ? ` · ${escapeHtml(local.headSha.slice(0, 10))}` : ""}</small><span class="repository-facts">${facts.map((fact) => `<em class="${issues.includes(fact) ? "issue" : ""}">${escapeHtml(fact)}</em>`).join("")}</span></span><div class="repository-actions"><span class="lifecycle ${issues.length || local?.dirty ? "degraded" : repository.archived ? "retired" : "qualified"}">${issues.length ? `${issues.length} issues` : local?.dirty ? "dirty" : local ? "ready" : "observed"}</span>${repository.localPath ? `<button class="secondary small" type="button" data-refresh-repository="${escapeHtml(repository.id)}" data-product-id="${escapeHtml(product.id)}" title="${scanTitle}">${local ? "Rescan" : "Scan"}</button>` : ""}</div></div>`;
    }).join("")}</div>
  </article>`;
  }).join("");
  renderObjectiveRepositoryPicker();
}

function renderObjectiveRepositoryPicker() {
  const currentProductId = $("#objective-product").value;
  const selectedRepositoryIds = new Set([...document.querySelectorAll('input[name="objective-repository"]:checked')].map((input) => input.value));
  $("#objective-product").innerHTML = ['<option value="">Standalone repository</option>', ...state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`)].join("");
  if (state.products.some((product) => product.id === currentProductId)) $("#objective-product").value = currentProductId;
  const product = state.products.find((item) => item.id === $("#objective-product").value);
  $("#objective-repositories-field").classList.toggle("hidden", !product);
  $("#objective-repositories").innerHTML = product ? product.repositories.map((repository) => {
    const localState = repository.localPath ? repository.inspection ? repository.inspection.dirty ? "local · dirty" : "local · ready" : "local · not scanned" : "remote metadata only";
    return `<label class="repository-picker"><input type="checkbox" name="objective-repository" value="${escapeHtml(repository.id)}" ${selectedRepositoryIds.has(repository.id) ? "checked" : ""} ${repository.archived ? "disabled" : ""}><span><strong>${escapeHtml(repository.name)}</strong><small>${escapeHtml((repository.role || "other").replaceAll("_", " "))} · ${escapeHtml(localState)}</small></span></label>`;
  }).join("") : "";
}

function syncProjectPathFromRepositorySelection() {
  const product = state.products.find((item) => item.id === $("#objective-product").value);
  const selected = [...document.querySelectorAll('input[name="objective-repository"]:checked')].map((input) => product?.repositories.find((repository) => repository.id === input.value)).filter(Boolean);
  if (selected.length === 1 && selected[0].localPath) $("#project-path").value = selected[0].localPath;
}

// Slice A: "unknown"/"unmeasured" are placeholder values the backend has
// never actually verified — never print them with the same visual weight as
// a real, checked fact (doctor.ts:16-17, openrouter.ts:318-319, ollama.ts:127-128).
function measuredValueMarkup(value) {
  if (value === "unknown" || value === "unmeasured") return '<span class="muted">not yet measured</span>';
  return escapeHtml(value);
}

const CONNECTION_KIND_LABELS = {
  subscription_cli: "Subscription tool",
  api: "Pay-per-use API",
  local: "Local model",
};

function renderConnections() {
  $("#connection-cards").innerHTML = state.connections.map((connection) => {
    const diagnostics = connection.metadata?.diagnostics || [];
    const firstProblem = diagnostics.find((item) => item.state === "fail" || item.state === "unknown");
    return `<article class="connection-card ${connection.available ? "ready" : "attention"}">
      <div class="connection-head"><div><span class="connection-kind">${escapeHtml(CONNECTION_KIND_LABELS[connection.transport] || connection.transport.replaceAll("_", " "))}</span><h3>${escapeHtml(connection.displayName)}</h3></div><span class="auth-label ${connection.available ? "ready" : "required"}">${connection.available ? "Ready" : "Needs sign-in"}</span></div>
      <p>${escapeHtml(firstProblem?.detail || connection.metadata?.summary || "Connection is ready")}</p>
      <dl><div><dt>Installed version</dt><dd>${escapeHtml(connection.runtimeVersion || "Not detected")}</dd></div><div><dt>Entitlement</dt><dd>${measuredValueMarkup(connection.entitlement)}</dd></div><div><dt>Capacity</dt><dd>${measuredValueMarkup(connection.capacity)}</dd></div></dl>
      ${connection.transport === "subscription_cli" ? `<label class="connection-enable"><input type="checkbox" data-connection-provider="${escapeHtml(connection.provider)}" ${connection.enabled ? "checked" : ""}> Allow this tool to work on runs</label><p class="field-help">Unchecked tools are skipped everywhere — as architect, reviewer, or worker — even if they're signed in.</p>` : `<span class="muted">${connection.transport === "api" ? "Turned on/off using the OpenRouter settings further down this page" : "Managed on the Models page, not here"}</span>`}
    </article>`;
  }).join("");
}

function renderSettings() {
  const config = state.bootstrap.config;
  const options = state.bootstrap.providers.map((provider) => `<option value="${provider.name}">${escapeHtml(providerDisplayName(provider.name))}</option>`).join("");
  $("#setting-architect").innerHTML = options;
  $("#setting-reviewer").innerHTML = options;
  $("#setting-architect").value = config.product.architect;
  $("#setting-reviewer").value = config.product.reviewer;
  $("#setting-agents").value = config.application.concurrency.agents;
  $("#setting-autonomy").value = config.runPolicy.autonomy;
  $("#run-autonomy").value = config.runPolicy.autonomy;
  renderRunAutonomyHelp();
  renderRunAutonomyHelp("setting-autonomy", "setting-autonomy-help");
  $("#setting-plan-approval").checked = config.runPolicy.requirePlanApproval;
  $("#setting-external-writes").checked = config.runPolicy.allowExternalWrites;
  $("#setting-paid-api").checked = config.runPolicy.allowPaidApi;
  $("#setting-fallback").checked = config.routing.allowFallback;
  $("#setting-routing-mode").value = config.routing.mode || "adaptive";
  $("#openrouter-enabled").checked = config.openRouter.enabled;
  $("#openrouter-paid-fallback").checked = config.openRouter.allowPaidFallback;
  $("#openrouter-run-limit").value = config.openRouter.perRunLimitUsd;
  $("#openrouter-month-limit").value = config.openRouter.monthlyLimitUsd;
  const effortOptions = ["low", "medium", "high", "xhigh", "max"].map((effort) => `<option value="${effort}">${effort}</option>`).join("");
  const tierOptions = [["auto", "Automatic"], ["economy", "Economy"], ["standard", "Standard"], ["premium", "Premium"]].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  for (const role of ["architect", "worker", "reviewer"]) {
    const eligibleModels = state.models.filter((model) => model.qualified
      && !model.qualificationStale
      && !model.excluded
      && hasCurrentOperationalQualification(model)
      && hasCurrentSpecialistBenchmark(model)
      && hasCurrentQualificationForUiRole(model, role));
    const configuredModel = state.models.find((model) => model.id === config.routing[role].modelId);
    const configuredModelIsEligible = eligibleModels.some((model) => model.id === configuredModel?.id);
    const configuredConnection = state.connections.find((item) => item.id === configuredModel?.connectionId);
    const unavailableConfiguredOption = configuredModel && !configuredModelIsEligible
      ? `<option value="${escapeHtml(configuredModel.id)}" disabled>${escapeHtml(configuredConnection?.displayName || configuredModel.connectionId)} / ${escapeHtml(configuredModel.displayName)} (not currently role-qualified — hasn't passed the check for this role; see Models)</option>`
      : "";
    const modelOptions = [
      '<option value="">Let the tool choose its own default model</option>',
      ...eligibleModels.map((model) => {
        const connection = state.connections.find((item) => item.id === model.connectionId);
        return `<option value="${escapeHtml(model.id)}">${escapeHtml(connection?.displayName || model.connectionId)} / ${escapeHtml(model.displayName)}</option>`;
      }),
      unavailableConfiguredOption,
    ].join("");
    $(`#setting-${role}-model`).innerHTML = modelOptions;
    $(`#setting-${role}-model`).value = config.routing[role].modelId || "";
    $(`#setting-${role}-effort`).innerHTML = effortOptions;
    $(`#setting-${role}-effort`).value = config.routing[role].effort;
    $(`#setting-${role}-tier`).innerHTML = tierOptions;
    $(`#setting-${role}-tier`).value = config.routing[role].preferredTier || "auto";
    $(`#setting-${role}-upgrade`).value = config.routing[role].upgradePolicy || "pinned";
  }
  $("#setting-workers").innerHTML = state.bootstrap.providers.map((provider) =>
    `<label class="toggle"><input type="checkbox" name="setting-worker" value="${provider.name}" ${config.product.workers.includes(provider.name) ? "checked" : ""}><span>${escapeHtml(providerDisplayName(provider.name))}</span></label>`
  ).join("");
}

function renderOpenRouterStatus() {
  const status = $("#openrouter-status");
  if (!status) return;
  status.textContent = state.openRouter.connected
    ? `Connected. DevHarmonics checks your OpenRouter balance and limits before spending.`
    : "Disconnected. No paid API request can run.";
  $("#openrouter-connect").classList.toggle("hidden", state.openRouter.connected);
  $("#openrouter-disconnect").classList.toggle("hidden", !state.openRouter.connected);
}

// Slice A: the composer's "Run mode" and Setup's "Default run mode" are the
// identical control — the same live consequence line is reused for both
// instead of leaving Setup's copy unexplained (DESIGN-DECISIONS.md).
function renderRunAutonomyHelp(selectId = "run-autonomy", helpId = "run-autonomy-help") {
  // Slice A: the first clause is bolded so the consequence can't be skimmed
  // past — this is the single highest-stakes control on the page.
  const help = {
    observe: "<strong>Nothing is changed.</strong> The AI only reads your code and reports back.",
    supervised: "<strong>AI workers can write code,</strong> but a change only reaches your repository after you approve the plan.",
    bounded: "<strong>AI workers can commit changes on their own,</strong> limited to the permissions and repositories you've allowed in Setup. Change what's allowed under Setup → Default team setup → policy checkboxes.",
  };
  const select = $(`#${selectId}`);
  const helpElement = $(`#${helpId}`);
  if (!select || !helpElement) return;
  helpElement.innerHTML = help[select.value] || help.supervised;
}

function requiresSpecialistBenchmark(model) {
  return String(model?.metadata?.devHarmonicsProfile?.family || "").startsWith("mellum2");
}

function hasCurrentSpecialistBenchmark(model) {
  if (!requiresSpecialistBenchmark(model)) return true;
  return state.qualifications.some((item) => item.modelId === model.id
    && item.role === "benchmark"
    && item.passed
    && item.fingerprint === model.qualificationFingerprint);
}

function hasCurrentOperationalQualification(model) {
  return state.qualifications.some((item) => item.modelId === model.id
    && item.role !== "benchmark"
    && item.passed
    && item.fingerprint === model.qualificationFingerprint);
}

function hasCurrentQualificationForUiRole(model, role) {
  const connection = state.connections.find((item) => item.id === model.connectionId);
  const currentPasses = state.qualifications.filter((item) => item.modelId === model.id
    && item.role !== "benchmark"
    && item.passed
    && item.fingerprint === model.qualificationFingerprint);
  if (connection?.transport === "local") {
    if (role === "architect") return false;
    if (role === "worker") return currentPasses.some((item) => item.role === "local_tools");
    return currentPasses.some((item) => item.role === "analysis" || item.role === "reviewer");
  }
  return currentPasses.some((item) => item.role === "general" || item.role === role);
}

function isModelSchedulable(model) {
  return Boolean(model?.active
    && model.qualified
    && !model.qualificationStale
    && !model.excluded
    && hasCurrentOperationalQualification(model)
    && hasCurrentSpecialistBenchmark(model));
}

// Slice A: translate the raw model-availability/quota enums the backend
// reports (runtime.ts / registry.ts) into plain English wherever they reach
// the page — never print a raw snake_case token to the PM.
const HEALTH_STATE_LABELS = {
  ready: "ready",
  degraded: "temporarily slow",
  cooling: "cooling down after an error",
  quota_exhausted: "over its usage limit",
  rate_limited: "rate-limited",
  authentication: "signed out",
  unavailable: "unavailable",
};
function healthStateLabel(state) {
  return HEALTH_STATE_LABELS[state] || String(state).replaceAll("_", " ");
}

const ROLE_LABELS = {
  general: "general capability",
  architect: "planner",
  worker: "worker",
  reviewer: "reviewer",
  analysis: "analysis",
  benchmark: "accuracy benchmark",
  local_tools: "file-editing permissions",
};
function roleLabel(role) {
  return ROLE_LABELS[role] || String(role).replaceAll("_", " ");
}

const CONFIDENCE_LABELS = { insufficient: "low", emerging: "medium", established: "high" };

function workloadLabel(workload) {
  const [complexity, tier] = String(workload).split(":");
  const complexityLabel = complexity ? complexity[0].toUpperCase() + complexity.slice(1) : "Unclassified";
  return tier ? `${complexityLabel}, ${tier}-tier tasks` : `${complexityLabel} tasks`;
}

// Shared list-item formatter for both the model-wide "Observed performance"
// summary and the per-workload "Performance by task type" slices — same
// plain-English labels either way (DH inventory-02, app.js:514-518).
function performanceSummaryItems(stats, { includeLatency }) {
  const items = [
    `Completed: ${Math.round(stats.successRate * 100)}%`,
    `Succeeded on the first try: ${Math.round(stats.firstAttemptSuccessRate * 100)}%`,
  ];
  if (includeLatency) items.push(stats.averageLatencyMs == null ? "Typical time: unavailable" : `Typical time: ${formatDuration(stats.averageLatencyMs)}`);
  items.push(stats.averageCostUsd == null ? "Typical cost: unavailable" : `Typical cost: $${Number(stats.averageCostUsd).toFixed(4)}${includeLatency ? ` (${stats.billedSampleCount} billed runs)` : ""}`);
  items.push(`Editing conflicts: ${stats.integrationConflictCount}`, `Test/check failures: ${stats.validatorFailureCount}`, `Runs that didn't finish (not the model's fault): ${stats.notReadyRunCount}`, `Based on ${stats.sampleSize} real runs`);
  return items;
}

function renderModels() {
  const allCurrentModels = state.models.filter((model) => !model.retired);
  const query = $("#model-filter")?.value.trim().toLowerCase() || "";
  const statusFilter = $("#model-status-filter")?.value || "all";
  const currentModels = allCurrentModels.filter((model) => {
    const matchesQuery = !query || `${model.displayName} ${model.canonicalName} ${model.connectionId}`.toLowerCase().includes(query);
    const isStale = model.qualified && model.qualificationStale;
    const operationallyQualified = hasCurrentOperationalQualification(model);
    const matchesStatus = statusFilter === "all" || statusFilter === "active" && isModelSchedulable(model) || statusFilter === "qualified" && operationallyQualified && !isStale || statusFilter === "stale" && isStale || statusFilter === "unqualified" && !operationallyQualified;
    return matchesQuery && matchesStatus;
  });
  const qualified = allCurrentModels.filter((model) => hasCurrentOperationalQualification(model) && !model.qualificationStale).length;
  const active = allCurrentModels.filter(isModelSchedulable).length;
  $("#model-summary").innerHTML = `<div class="metric"><span>Known models</span><strong>${allCurrentModels.length}</strong></div><div class="metric"><span>Passed a role check</span><strong>${qualified}</strong></div><div class="metric"><span>Ready to be used</span><strong>${active}</strong></div><div class="metric"><span>Estimated local capacity</span><strong>${state.resources?.advisoryLocalSlots ?? "?"}</strong></div>`;
  const runtimes = state.bootstrap.config.localRuntimes?.ollama || [];
  $("#runtime-list").innerHTML = runtimes.map((runtime) => {
    const connection = state.connections.find((item) => item.metadata?.runtimeId === runtime.id);
    const status = connection?.available ? "Ready" : connection?.installed ? "No installed models" : "Can't connect";
    return `<article class="connection-card"><span class="connection-kind">LOCAL MODEL SERVER</span><h3>${escapeHtml(runtime.displayName)}</h3><p>${escapeHtml(runtime.baseUrl)}</p><span class="status ${connection?.available ? "ready" : "warning"}">${status}</span>${status === "Can't connect" ? `<p class="field-help">DevHarmonics couldn't reach this address. Check that the local model server is running and the Base URL is correct.</p>` : ""}</article>`;
  }).join("");
  $("#model-list").innerHTML = currentModels.length ? currentModels.map((model) => {
    const connection = state.connections.find((item) => item.id === model.connectionId);
    const profile = model.metadata?.devHarmonicsProfile || {};
    const tier = profile.tier || "unclassified";
    const family = profile.family || "unclassified";
    const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
    const effort = profile.reasoningEffort ? ` · thinking effort: ${profile.reasoningEffort}` : "";
    const confidence = profile.confidence ? ` · model info: ${profile.confidence}` : "";
    const allHistory = state.qualifications.filter((item) => item.modelId === model.id);
    const history = allHistory.slice(0, 5);
    const hasAnyOperationalAttempt = allHistory.some((item) => item.role !== "benchmark");
    const currentRoleQualifications = allHistory.filter((item) => item.fingerprint === model.qualificationFingerprint);
    const hasCurrentRoleFailure = currentRoleQualifications.some((item) => !item.passed);
    const operationallyQualified = hasCurrentOperationalQualification(model);
    const specialistBenchmarkRequired = requiresSpecialistBenchmark(model);
    const specialistBenchmarkPassed = hasCurrentSpecialistBenchmark(model);
    const qualify = `<button class="secondary small" data-qualify-model="${escapeHtml(model.id)}">${operationallyQualified ? "Requalify" : connection?.transport === "local" ? "Qualify locally" : connection?.provider === "openrouter" ? "Qualify (may cost money)" : "Qualify"}</button>`;
    const qualifyTools = connection?.transport === "local" ? `<button class="secondary small" data-qualify-local-tools="${escapeHtml(model.id)}">Test file-editing permissions</button>` : "";
    const qualifyBenchmark = connection?.transport === "local" ? `<button class="secondary small" data-qualify-benchmark="${escapeHtml(model.id)}">Run accuracy test</button>` : "";
    const activate = `<button class="secondary small" data-activate-model="${escapeHtml(model.id)}">${model.active ? "Deactivate" : "Activate"}</button>`;
    const health = model.health?.state && model.health.state !== "ready" ? ` · ${healthStateLabel(model.health.state)}` : "";
    const performance = state.performanceProfiles.find((item) => item.modelId === model.id);
    const performancePolicy = state.performancePolicies.find((item) => item.modelId === model.id);
    const confidenceLabel = performance ? (CONFIDENCE_LABELS[performance.uncertainty] || performance.uncertainty) : "";
    const empiricalHtml = performance
      ? `<p class="empirical-profile"><strong>Observed performance:</strong> ${performanceSummaryItems(performance, { includeLatency: true }).join(" · ")} · <span class="uncertainty ${escapeHtml(performance.uncertainty)}">Confidence: ${escapeHtml(confidenceLabel)}</span>${performance.observationsExcluded ? " · excluded by user" : performance.eligibleForAdaptiveWeighting ? " · eligible for adaptive weighting" : " · not used for adaptive weighting yet"}</p>`
      : `<p class="empirical-profile"><strong>Observed performance:</strong> No real-run data yet — this shows only the provider's published specs.${performancePolicy?.ignoredBefore ? ` Performance history was reset on ${escapeHtml(new Date(performancePolicy.ignoredBefore).toLocaleString())}.` : ""}</p>`;
    const workloadHtml = performance && Object.keys(performance.workloads || {}).length
      ? `<details class="qualification-history workload-history"><summary>Performance by task type (${Object.keys(performance.workloads).length})</summary>${Object.entries(performance.workloads).map(([workload, slice]) => `<p><strong>${escapeHtml(workloadLabel(workload))}</strong> · ${performanceSummaryItems(slice, { includeLatency: false }).join(" · ")}</p>`).join("")}</details>`
      : "";
    const performanceActions = `<button class="secondary small" data-reset-performance="${escapeHtml(model.id)}">Reset performance history</button><button class="secondary small" data-exclude-performance="${escapeHtml(model.id)}">${performancePolicy?.excluded ? "Resume using past results for scheduling" : "Stop using past results for scheduling"}</button>`;
    const historyHtml = `<details class="qualification-history"><summary>Qualification history (${history.length})</summary>${history.length ? history.map((item) => `<p><strong>${escapeHtml(item.passed ? "PASS" : "FAIL")}</strong> for ${escapeHtml(roleLabel(item.role))}, tested ${escapeHtml(new Date(item.createdAt).toLocaleString())}</p>`).join("") : "<p>No checks run yet.</p>"}</details>`;
    const isStale = model.qualified && model.qualificationStale;
    const stateText = isStale ? "This model's check is out of date — the provider changed it since it last passed. It won't be used again until you re-run the check."
      : model.excluded ? "You've excluded this model from being used"
      : specialistBenchmarkRequired && !specialistBenchmarkPassed ? "This model needs an extra accuracy test before it can be used"
      : !operationallyQualified ? "Hasn't passed a role check yet — can't be used"
      : hasCurrentRoleFailure ? "Passed some roles, failed others — see qualification history below"
      : model.active ? "Active — DevHarmonics can use this model"
      : "Passed its check but turned off — click Activate to make it usable";
    // Slice A: "you turned this off on purpose" (deliberate) reads and colors
    // differently from "something needs attention" (degraded) — see the
    // .lifecycle.deliberate / .lifecycle.degraded split in app.css.
    // model.excluded is checked first in both the chip text and its color
    // class so a deliberately-excluded model never shows an amber "needs
    // attention" chip with a grey/deliberate meaning underneath, or vice versa.
    const lifecycleText = model.excluded ? "Excluded"
      : isStale ? "Needs re-checking"
      : specialistBenchmarkRequired && !specialistBenchmarkPassed ? "Needs benchmark"
      : !operationallyQualified ? (hasAnyOperationalAttempt ? "Not qualified" : "Not checked yet")
      : hasCurrentRoleFailure ? "Not qualified"
      : model.active ? "Active"
      : "Qualified (inactive)";
    const lifecycleClass = model.excluded ? "deliberate"
      : (isStale || !operationallyQualified || hasCurrentRoleFailure || (specialistBenchmarkRequired && !specialistBenchmarkPassed)) ? "degraded"
      : model.active ? "active" : "qualified";
    const detailParts = [
      `Made by: ${model.metadata?.modelVendor || "unknown"}`,
      `Shares usage limit with: ${model.metadata?.quotaGroupDisplayName || model.metadata?.quotaGroup || "nothing tracked"}`,
      model.quotaGroupHealth ? `Usage limit status: ${healthStateLabel(model.quotaGroupHealth.state)}${model.quotaGroupHealth.cooldownUntil ? `, back at ${new Date(model.quotaGroupHealth.cooldownUntil).toLocaleString()}` : ""}` : "",
      `Model line: ${family === "unclassified" ? "unknown" : family}`,
      `Capabilities: ${capabilities.length ? capabilities.join(", ") : "not declared"}`,
      model.metadata?.details?.parameter_size ? `Model size: ${model.metadata.details.parameter_size}` : "",
      model.metadata?.details?.quantization_level ? `Compression level: ${model.metadata.details.quantization_level}` : "",
    ].filter(Boolean).join(" · ");
    return `<article class="model-card"><div><span class="connection-kind">${escapeHtml(connection?.displayName || model.connectionId)}</span><h3>${escapeHtml(model.displayName)}</h3><code>${escapeHtml(model.canonicalName)}</code></div><span class="lifecycle ${escapeHtml(lifecycleClass)}">${escapeHtml(lifecycleText)}</span><p>Tier: ${escapeHtml(tier + effort + confidence)}${escapeHtml(health)}. ${stateText}. Update policy: ${model.upgradePolicy === "track_family" ? "auto-upgrading within its model line" : "staying on this exact version"}.</p><p class="model-profile">${escapeHtml(detailParts)}.</p>${empiricalHtml}${workloadHtml}<div class="model-actions">${qualify}${qualifyTools}${qualifyBenchmark}${activate}<button class="secondary small" data-pin-model="${escapeHtml(model.id)}">${model.pinned ? "Stop preferring this model" : "Always prefer this model"}</button><button class="secondary small" data-track-model="${escapeHtml(model.id)}">${model.upgradePolicy === "track_family" ? "Stay on this exact version" : "Auto-upgrade within this model line"}</button><button class="secondary small" data-exclude-model="${escapeHtml(model.id)}">${model.excluded ? "Include in automatic scheduling" : "Exclude from automatic scheduling"}</button>${performanceActions}</div>${historyHtml}</article>`;
  }).join("") : '<div class="panel empty-state">No current models match this filter.</div>';
  $("#model-connection").innerHTML = state.connections.map((connection) => `<option value="${escapeHtml(connection.id)}">${escapeHtml(connection.displayName)}</option>`).join("");
}

function workbenchEligibleModels() {
  return state.models.filter((model) => isModelSchedulable(model) && hasCurrentQualificationForUiRole(model, "reviewer"));
}

async function refreshWorkbench(preferredSessionId = state.workbenchSession?.id) {
  const result = await api("/api/workbench");
  state.workbenchSessions = result.sessions;
  const selectedId = preferredSessionId && state.workbenchSessions.some((item) => item.id === preferredSessionId)
    ? preferredSessionId
    : state.workbenchSessions[0]?.id;
  if (selectedId) {
    const detail = await api(`/api/workbench/${selectedId}`);
    state.workbenchSession = detail.session;
    state.workbenchMessages = detail.messages;
  } else {
    state.workbenchSession = null;
    state.workbenchMessages = [];
    $("#workbench-new-form").classList.remove("hidden");
  }
  renderWorkbench();
}

function renderWorkbench() {
  $("#workbench-count").textContent = `${state.workbenchSessions.length} saved discussions`;
  $("#workbench-session-list").innerHTML = state.workbenchSessions.length
    ? state.workbenchSessions.map((session) => `<button class="workbench-session ${session.id === state.workbenchSession?.id ? "active" : ""}" type="button" data-workbench-session="${escapeHtml(session.id)}"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.projectPath)}</span></button>`).join("")
    : '<div class="empty-state">No discussions yet.</div>';
  $("#workbench-empty").classList.toggle("hidden", Boolean(state.workbenchSession));
  $("#workbench-active").classList.toggle("hidden", !state.workbenchSession);
  if (!state.workbenchSession) return;
  $("#workbench-active-title").textContent = state.workbenchSession.title;
  $("#workbench-active-project").textContent = state.workbenchSession.projectPath;
  $("#workbench-messages").innerHTML = state.workbenchMessages.length
    ? state.workbenchMessages.map((message) => {
      const isUser = message.role === "user";
      const model = message.requestedModelId ? state.models.find((item) => item.id === message.requestedModelId) : null;
      const identity = isUser ? "You" : recordedModelIdentity(message.provider, model?.id || message.resolvedModelId || message.requestedModelId, message.provider === "gemini" ? "requested_unverified" : null, message.connectionId);
      const detail = [message.status, message.durationMs ? formatDuration(message.durationMs) : null, message.costUsd != null ? `$${Number(message.costUsd).toFixed(4)}` : null].filter(Boolean).join(" · ");
      const body = message.status === "failed" ? message.error || "Consultation failed" : message.content;
      return `<article class="workbench-message ${isUser ? "user" : message.status === "failed" ? "failed" : "assistant"}"><div class="workbench-message-head"><strong>${escapeHtml(identity)}</strong><span>${escapeHtml(detail || new Date(message.createdAt).toLocaleString())}</span></div><p>${escapeHtml(body || "")}</p></article>`;
    }).join("")
    : '<div class="empty-state">This discussion is empty. Ask one or more models the first question.</div>';
  const eligible = workbenchEligibleModels();
  $("#workbench-models").innerHTML = eligible.length
    ? eligible.map((model, index) => {
      const connection = state.connections.find((item) => item.id === model.connectionId);
      return `<label class="workbench-model"><input type="checkbox" name="workbench-model" value="${escapeHtml(model.id)}" ${index < Math.min(2, eligible.length) ? "checked" : ""}><span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(connection?.displayName || model.connectionId)} · ${escapeHtml(model.canonicalName)}</small></span></label>`;
    }).join("")
    : '<div class="empty-state">No models are ready to answer questions yet. Go to Models, turn one on, and run its quick qualification test — that\'s a one-time check that the model can handle this kind of task. (Qualifying a model runs a short test before DevHarmonics trusts it for a given job.)</div>';
  $("#workbench-consult").disabled = eligible.length === 0;
  if (!$("#workbench-outcome").value && state.workbenchMessages.length) {
    const lastQuestion = [...state.workbenchMessages].reverse().find((message) => message.role === "user");
    $("#workbench-outcome").value = lastQuestion?.content || state.workbenchSession.title;
  }
  renderRunAutonomyHelp("workbench-autonomy", "workbench-autonomy-help");
}

async function selectWorkbench(sessionId) {
  const detail = await api(`/api/workbench/${sessionId}`);
  state.workbenchSession = detail.session;
  state.workbenchMessages = detail.messages;
  renderWorkbench();
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
  $("#workbench-view").classList.toggle("hidden", view !== "workbench");
  $("#workflows-view").classList.toggle("hidden", view !== "workflows");
  if (view === "runs") {
    $("#composer").classList.toggle("hidden", Boolean(state.selectedRunId) && !state.composing);
    $("#run-view").classList.toggle("hidden", !state.selectedRunId || state.composing);
  } else {
    $("#composer").classList.add("hidden");
    $("#run-view").classList.add("hidden");
  }
  const description = VIEW_DESCRIPTIONS[view] || VIEW_DESCRIPTIONS.runs;
  $("#page-title").textContent = description.title;
  $("#page-purpose").textContent = description.purpose;
}

async function refreshWorkflows() {
  const { workflows } = await api("/api/workflows");
  state.workflows = workflows;
  $("#workflow-list").innerHTML = workflows.length
    ? workflows.map((workflow) => `<button class="connection-card" style="text-align:left;cursor:pointer" data-workflow-hash="${escapeHtml(workflow.revisionHash)}">
        <strong>${escapeHtml(workflow.name)}</strong>
        <p class="field-help" title="Workflows can be edited over time; this is the exact version you're looking at.">version ${escapeHtml(workflow.revisionHash.slice(0, 12))} · saved ${escapeHtml(workflow.createdAt.slice(0, 10))}</p>
      </button>`).join("")
    : `<p class="field-help">The two built-in workflows appear here when the server starts. If this list stays empty, restart the DevHarmonics server.</p>`;
  $("#workflow-detail").classList.add("hidden");
}

// DH810-AUD-009: each input renders as its actual type — a number field for
// numbers and an explicit true/false selector for booleans — so a typo can
// never silently become `false`.
function workflowInputControl(input) {
  const shared = `data-workflow-input="${escapeHtml(input.name)}" data-workflow-input-type="${escapeHtml(input.type)}"`;
  if (input.type === "number") return `<input type="number" step="any" ${shared} placeholder="number">`;
  if (input.type === "boolean") return `<select ${shared}><option value="">(not set)</option><option value="true">true</option><option value="false">false</option></select>`;
  return `<input type="text" ${shared} placeholder="text">`;
}

// DH810-AUD-004: repository scope requires a product (the server refuses
// repository IDs without one), so the form offers the same product-scoped
// repository picker as the objective composer instead of a bare text field.
function renderWorkflowScope() {
  const product = state.products.find((candidate) => candidate.id === $("#workflow-product")?.value) || null;
  const container = $("#workflow-repositories");
  if (!container) return;
  container.innerHTML = product
    ? product.repositories.map((repository) => `<label class="field-help"><input type="checkbox" name="workflow-repository" value="${escapeHtml(repository.id)}"> ${escapeHtml(repository.name)}${repository.localPath ? "" : " (not downloaded locally)"}</label>`).join("") || '<p class="field-help">This product has no attached repositories yet.</p>'
    : '<p class="field-help">No product selected — this will run against the default project folder on this machine. Pick a product above to limit it to specific repositories instead.</p>';
}

async function showWorkflowDetail(revisionHash) {
  const { revision } = await api(`/api/workflows/${revisionHash}`);
  if (!state.products.length) {
    try { await refreshProducts(); } catch { /* products are optional for a standalone instantiation */ }
  }
  state.selectedWorkflow = revision;
  $("#workflow-detail-name").textContent = `Workflow: ${revision.name} (version ${revision.revisionHash.slice(0, 12)})`;
  $("#workflow-detail-description").textContent = revision.workflow.description;
  $("#workflow-detail-json").textContent = JSON.stringify(revision.workflow, null, 2);
  $("#workflow-detail-inputs").innerHTML = [
    ...revision.workflow.inputs.map((input) => `<label class="field-help">${escapeHtml(input.name)}${input.required ? " (required)" : ""} — ${escapeHtml(input.description)}
      ${workflowInputControl(input)}
    </label>`),
    `<label class="field-help">Product
      <select id="workflow-product"><option value="">No product — use default folder</option>${state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join("")}</select>
    </label>`,
    `<div id="workflow-repositories"></div>`,
  ].join("");
  renderWorkflowScope();
  $("#workflow-instantiate-result").textContent = "";
  $("#workflow-error").innerHTML = "";
  $("#workflow-detail").classList.remove("hidden");
}

$("#workflow-detail-inputs").addEventListener("change", (event) => {
  if (event.target.id === "workflow-product") renderWorkflowScope();
});

$("#workflow-list").addEventListener("click", async (event) => {
  const card = event.target.closest("[data-workflow-hash]");
  if (card) await showWorkflowDetail(card.dataset.workflowHash);
});

$("#workflow-instantiate").addEventListener("click", async (event) => {
  const revision = state.selectedWorkflow;
  if (!revision) return;
  const inputs = {};
  const inputErrors = [];
  for (const element of document.querySelectorAll("[data-workflow-input]")) {
    const raw = element.value.trim();
    if (!raw) continue;
    const type = element.dataset.workflowInputType;
    if (type === "number") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) inputErrors.push(`${element.dataset.workflowInput} must be a number`);
      inputs[element.dataset.workflowInput] = parsed;
    } else if (type === "boolean") {
      inputs[element.dataset.workflowInput] = raw === "true";
    } else {
      inputs[element.dataset.workflowInput] = raw;
    }
  }
  if (inputErrors.length) { $("#workflow-error").innerHTML = inputErrors.map((issue) => escapeHtml(issue)).join("<br>"); return; }
  const productId = $("#workflow-product")?.value || "";
  const repositoryIds = [...document.querySelectorAll('input[name="workflow-repository"]:checked')].map((input) => input.value);
  $("#workflow-error").innerHTML = "";
  await withOperation(event.currentTarget, "Creating the task from the workflow", async () => {
    const result = await api(`/api/workflows/${revision.revisionHash}/instantiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs, repositoryIds, ...(productId ? { productId } : {}) }),
    });
    $("#workflow-instantiate-result").textContent = `Task ${result.objective.id.slice(0, 8)} created from this workflow. Go to Runs → New run to review and approve its plan — it will run using exactly this version of the workflow.`;
  }, {
    // DH810-AUD-009: the API names the offending inputs — surface every named
    // issue, not just the top-level message.
    onError: (message, error) => {
      const issues = Array.isArray(error?.data?.issues) ? error.data.issues : [];
      $("#workflow-error").innerHTML = [escapeHtml(message), ...issues.map((issue) => `<br>· ${escapeHtml(String(issue))}`)].join("");
    },
    busyLabel: "Creating…",
  });
});

async function refreshEvidence() {
  const runId = state.selectedRunId || state.runs[0]?.id;
  if (!runId) {
    $("#evidence-empty").classList.remove("hidden");
    $("#evidence-content").classList.add("hidden");
    return;
  }
  state.selectedRunId = runId;
  [state.evidence, state.report] = await Promise.all([
    api(`/api/runs/${runId}/evidence`),
    api(`/api/runs/${runId}/report`),
  ]);
  const evidence = state.evidence;
  const report = state.report;
  $("#evidence-empty").classList.add("hidden");
  $("#evidence-content").classList.remove("hidden");
  $("#evidence-metrics").innerHTML = `<div class="metric"><span>Tasks</span><strong>${report.counts.tasks}</strong></div><div class="metric"><span>Attempts</span><strong>${report.counts.attempts}</strong></div><div class="metric"><span>Checks</span><strong>${report.counts.checks}</strong></div><div class="metric"><span>Reviews</span><strong>${report.counts.reviews}</strong></div><div class="metric"><span>Tool decisions</span><strong>${report.counts.toolReceipts}</strong></div>`;
  $("#evidence-verdict").innerHTML = derivedVerdictMarkup(report);
  $("#evidence-hash").textContent = evidence.integritySha256;
  $("#evidence-review-count").textContent = `${evidence.reviews.length} retained`;
  $("#evidence-reviews").innerHTML = evidence.reviews.length ? evidence.reviews.map((review) => `<article><div><strong>Round ${review.round}</strong><span>${escapeHtml(recordedModelIdentity(review.provider, review.modelId, review.provider === "gemini" ? "requested_unverified" : null, review.connectionId))} · reviewed at commit ${escapeHtml(review.integrationSha256.slice(0, 12))}</span></div><span class="lifecycle ${review.invalidatedAt ? "retired" : review.verdict === "READY" ? "qualified" : "degraded"}">${review.invalidatedAt ? "invalidated" : escapeHtml(review.verdict.replaceAll("_", " "))}</span><p class="evidence-report">${escapeHtml(review.summary)}${review.findings.length ? `\n${review.findings.map((finding) => `${finding.severity.toUpperCase()} ${finding.location || "no location"}: ${finding.rationale} — Status: ${finding.disposition}`).join("\n")}` : ""}${review.invalidationReason ? `\nInvalidated: ${escapeHtml(review.invalidationReason)}` : ""}</p></article>`).join("") : '<div class="empty-state">No independent reviews have been recorded for this run yet.</div>';
  const evidenceRun = state.runs.find((item) => item.id === runId);
  $("#evidence-attempts").innerHTML = evidence.attempts.length ? evidence.attempts.map((attempt) => `<article><div><strong>${escapeHtml(evidenceRun?.tasks.find((task) => task.id === attempt.task_id)?.title || attempt.task_id)}</strong><span>${escapeHtml(recordedModelIdentity(attempt.provider, attempt.model_id, attempt.model_resolution, attempt.connection_id))}</span></div><span class="lifecycle ${attempt.status === "completed" ? "qualified" : ""}">${escapeHtml(attempt.status)}</span><details class="evidence-report"><summary>View summary</summary><p>${escapeHtml(attempt.result_envelope?.summary || attempt.error || "No summary recorded")}</p></details></article>`).join("") : '<div class="empty-state">No attempts were started.</div>';
  $("#evidence-tool-count").textContent = `${evidence.toolReceipts.length} retained`;
  $("#evidence-tools").innerHTML = evidence.toolReceipts.length ? evidence.toolReceipts.map((receipt) => `<article><div><strong>${escapeHtml(receipt.actorRole)} tried to ${escapeHtml(receipt.sideEffect.replaceAll("_", " "))} during ${escapeHtml(receipt.stage)}</strong><span class="muted">${escapeHtml(receipt.toolId)}</span></div><span class="lifecycle ${receipt.outcome === "allow" ? "qualified" : receipt.outcome === "deny" ? "retired" : "degraded"}">${escapeHtml(receipt.outcome.replaceAll("_", " "))}</span><p class="evidence-report">${escapeHtml(receipt.reason)}${receipt.lockKeys.length ? `\nLocks: ${escapeHtml(receipt.lockKeys.join(", "))} — prevents another agent from touching the same file or resource at the same time.` : ""}</p></article>`).join("") : '<div class="empty-state">No tool permission decisions have been recorded for this run yet.</div>';
}

// Owner-reported (2026-07-22): the derived verdict rendered the entire review
// as one collapsed paragraph — an unreadable wall — with the verdict's actual
// REASONS below it and no answer to "now what do I do?". This block leads with
// the verdict, what it means, and the reasons; the review body becomes a
// scannable per-target list; the full text stays one click away.
function evidenceInline(text) {
  // Escape first, then allow exactly two safe inline forms from the
  // reviewer's markdown habits: **bold** and `code`.
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

// Owner/gate finding (2026-07-22): the historical-READY wording must be earned
// by a RETAINED READY verdict, not merely by "there is at least one issue". An
// ordinary in-progress or never-reviewed run is INCONCLUSIVE with issues too,
// and telling the owner "the review passed at the time it ran" for a run that
// was never reviewed is a false trust claim. Base the wording on report
// CONTENT: the reporter records the absence of a review as the missingEvidence
// strings "final review" / "machine-readable final verdict" (see reporter.ts).
// A retained READY verdict is present only when NEITHER of those is missing —
// and within an INCONCLUSIVE report a retained machine-readable verdict can
// only be READY (a NOT_READY one would make the verdict NOT_READY). So reserve
// the historical wording for a retained READY invalidated by later inconsistency.
function verdictGuidance(report) {
  if (report.verdict === "READY") return "The run is reviewed and its retained evidence is internally consistent. Deliver when you are ready.";
  if (report.verdict === "NOT_READY") return "The review or the run itself did not pass. Open the review findings below — they name what must change.";
  const missing = report.missingEvidence || [];
  const retainedReadyVerdict = !missing.includes("final review") && !missing.includes("machine-readable final verdict");
  const wentInconsistent = (report.inconsistencies || []).length > 0;
  if (retainedReadyVerdict && wentInconsistent) {
    return "The review passed at the time it ran, but the retained evidence no longer lines up — the reasons are listed below. This commonly happens when the repository moved after review (for example, the delivery was merged). Treat the READY as historical; re-run the review if you need a current verdict.";
  }
  return "The run has not reached a reviewed state yet, so no verdict can be derived. Let the run finish, or open the run board to see what it is waiting on.";
}

function parseReviewTargets(summary) {
  // The reporter's own grammar: per-target bullets of the form
  // "- <target>: READY — <evidence...>". Everything before the first bullet is
  // the header (integration set, quorum, reviewers); anything after the last
  // bullet's evidence is the footer.
  // Targets may themselves contain colons (github:owner/repo/path) — the
  // reliable anchor is the ": VERDICT — " token, so the target match is lazy.
  const pattern = /- (\S.*?): (READY|NOT[ _]READY|INCONCLUSIVE) — /g;
  const matches = [...summary.matchAll(pattern)];
  if (!matches.length) return null;
  const header = summary.slice(0, matches[0].index).replace(/\s*Evidence:\s*$/, "").trim();
  const targets = matches.map((match, index) => {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = index + 1 < matches.length ? matches[index + 1].index : summary.length;
    return { target: match[1].trim(), verdict: match[2].replace(" ", "_"), body: summary.slice(bodyStart, bodyEnd).trim() };
  });
  // A trailing reporter note (e.g. "Material risks: ...") rides inside the
  // last body; split it out when present so it reads as the footer it is.
  let footer = "";
  const last = targets[targets.length - 1];
  const footerIndex = last.body.search(/(?:^|\n)\s*Material risks:/);
  if (footerIndex >= 0) {
    footer = last.body.slice(footerIndex).trim();
    last.body = last.body.slice(0, footerIndex).trim();
  }
  return { header, targets, footer };
}

function derivedVerdictMarkup(report) {
  const reportIssues = [...report.missingEvidence.map((item) => `Missing: ${item}`), ...report.inconsistencies];
  const verdictLabel = escapeHtml(report.verdict.replaceAll("_", " "));
  const headline = `<div><span class="connection-kind">OVERALL VERDICT</span><h3>${verdictLabel}</h3><p>${escapeHtml(verdictGuidance(report))}</p><p class="field-help">DevHarmonics' own check of whether the evidence kept for this run is complete and consistent — separate from what each individual reviewer concluded below.</p></div>
    <span class="status-pill report-${escapeHtml(report.verdict.toLowerCase())}">${verdictLabel}</span>
    ${reportIssues.length ? `<ul class="verdict-reasons">${reportIssues.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<p class="report-consistent">No missing or contradictory retained evidence detected.</p>'}`;
  const parsed = parseReviewTargets(report.summary || "");
  if (!parsed) {
    return `${headline}<details class="review-full"><summary>Full review text</summary><p class="review-body">${evidenceInline(report.summary || "No final review has been retained.")}</p></details>`;
  }
  const targetRows = parsed.targets.map((item) => `
    <details class="review-target">
      <summary><span class="status-pill report-${escapeHtml(item.verdict.toLowerCase())}">${escapeHtml(item.verdict.replaceAll("_", " "))}</span><code>${escapeHtml(item.target)}</code></summary>
      <p class="review-body">${evidenceInline(item.body)}</p>
    </details>`).join("");
  const readyCount = parsed.targets.filter((item) => item.verdict === "READY").length;
  return `${headline}
    <div class="review-structure">
      <p class="field-help">${escapeHtml(parsed.header)}</p>
      <p class="review-target-count">${readyCount}/${parsed.targets.length} reviewed targets READY — expand any target for its evidence.</p>
      ${targetRows}
      ${parsed.footer ? `<p class="field-help review-footer">${evidenceInline(parsed.footer)}</p>` : ""}
    </div>`;
}

// Slice A pattern #3: these five words are a status system used throughout
// the provider strip and worker pool, so each gets a one-line definition a
// reader can find instead of guessing "Disabled" (you turned it off) apart
// from "Unavailable" (something is actually broken).
const PROVIDER_STATUS_DEFINITIONS = {
  Ready: "Connected and usable right now.",
  Disabled: "You've turned this provider off — flip it back on above.",
  "Install required": "The provider's software isn't on this computer yet.",
  "Sign-in required": "Installed but not logged in.",
  Unavailable: "Installed and signed in, but something else is stopping it — check the detail line below the name.",
};

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
    .map((provider) => `<span class="provider-chip ${ready(provider) ? "online" : ""}" title="${escapeHtml(provider.summary)}"><i></i>${escapeHtml(providerDisplayName(provider.name))}</span>`)
    .join("");
  // Gap fixed (Slice A): the reason a toggle is greyed out used to live only
  // in a hover `title` — invisible on touch devices and easy to miss on
  // desktop. It now prints as small visible text under the toggle too.
  $("#provider-toggles").innerHTML = providers
    .map((provider) => {
      const label = statusLabel(provider);
      const reason = ready(provider) ? "" : `<small class="toggle-reason">${escapeHtml(label)} — ${escapeHtml(provider.summary)}</small>`;
      return `<label class="toggle" title="${escapeHtml(provider.summary)}"><input type="checkbox" name="provider" value="${provider.name}" ${ready(provider) ? "checked" : "disabled"}><span>${escapeHtml(providerDisplayName(provider.name))}</span>${reason}</label>`;
    })
    .join("");
  $("#provider-help-content").innerHTML = providers
    .map((provider) => {
      const label = statusLabel(provider);
      return `<section class="provider-help-card"><div><strong>${escapeHtml(providerDisplayName(provider.name))} <span class="auth-label ${ready(provider) ? "ready" : "required"}" title="${escapeHtml(PROVIDER_STATUS_DEFINITIONS[label] || "")}">${escapeHtml(label)}</span></strong></div><p class="muted">${escapeHtml(PROVIDER_STATUS_DEFINITIONS[label] || "")}</p><p class="muted">${escapeHtml(provider.summary)}</p><p class="field-help">Copy this exact line into a terminal window and press Enter:</p><code>${escapeHtml(provider.loginCommand)}</code><ol>${provider.setupSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section>`;
    })
    .join("");
  const unavailable = providers.filter((provider) => !ready(provider));
  $("#provider-auth-gate").classList.toggle("hidden", unavailable.length === 0);
  $("#provider-auth-message").textContent = unavailable.length
    ? unavailable.map((provider) => `${providerDisplayName(provider.name)}: ${provider.summary}`).join(" · ")
    : "";
}

async function refreshProviderStatus() {
  await withOperation($("#refresh-provider-status"), "Refreshing sign-in status", async () => {
    state.bootstrap = await api("/api/bootstrap");
    renderProviders();
    showError("");
  }, { busyLabel: "Refreshing sign-in status…" });
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
  // Steering history must track the scheduler, not freeze at what this tab last
  // posted: dispositions change when the run applies or rejects a directive.
  if (state.selectedRunId) await refreshSteering(state.selectedRunId);
  renderRunList();
  renderSelectedRun();
  renderActivityStrip();
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
  renderIntegrationSet(run);
  renderSteering(run);
  renderDelivery(run);
  void fillDeclaredTagVersions(run);
  renderBoard(run);
  renderActivity(run);
  renderVerdict(run);
}

// Which runs and tasks can still be steered is the ledger's rule, served in the
// bootstrap payload. The browser must never keep its own copy: a duplicated
// list is exactly how the paused-run rule drifted between layers before. If the
// payload is somehow unavailable, steer nothing rather than guess.
const steerableRunStatuses = () => state.bootstrap?.steering?.steerableRunStatuses ?? [];
const steerableTaskStatuses = () => state.bootstrap?.steering?.steerableTaskStatuses ?? [];

function renderSteering(run) {
  const panel = $("#steering-panel");
  const steerable = steerableRunStatuses().includes(run.status);
  panel.classList.toggle("hidden", !steerable);
  const directives = state.steering[run.id] || [];
  if (!steerable) {
    // A finished run's evidence is immutable; show history without controls.
    if (directives.length) renderSteeringDirectives(directives);
    return;
  }

  // Admission has three honest states, not two: a directive is only in force
  // once the scheduler consumes it at its next admission boundary. Reporting a
  // requested hold as "held" would claim an effect that has not happened yet.
  const admissionDirectives = directives.filter((directive) => ["hold_admission", "resume_admission"].includes(directive.kind));
  const held = admissionDirectives.filter((directive) => directive.disposition === "applied").at(-1)?.kind === "hold_admission";
  const requested = admissionDirectives.filter((directive) => directive.disposition === "pending").at(-1) ?? null;
  const admissionState = requested
    ? requested.kind === "hold_admission" ? "holding" : "resuming"
    : held ? "held" : "admitting";
  const admissionLabel = {
    holding: "Pause requested — takes effect once the current task finishes",
    resuming: "Resume requested — takes effect once the current task finishes",
    held: "New tasks are paused",
    admitting: "New tasks are starting normally",
  }[admissionState];
  $("#steering-admission").textContent = admissionLabel;
  $("#steering-admission").className = `lifecycle ${admissionState === "held" ? "warn" : admissionState === "admitting" ? "" : "pending"}`;
  // Never leave a control that would only queue a duplicate of what is already in flight.
  $("#steering-hold").disabled = admissionState === "held" || admissionState === "holding";
  $("#steering-resume").disabled = admissionState === "admitting" || admissionState === "resuming";

  const select = $("#steering-task");
  const previous = select.value;
  // Finished tasks are excluded by the same rule the ledger enforces, so the
  // panel never offers direction the server would refuse.
  const steerableTasks = run.tasks.filter((task) => !task.id.startsWith("__") && steerableTaskStatuses().includes(task.status));
  // Gate finding UX-F6: zero steerable tasks previously rendered an empty,
  // unlabeled dropdown — worded like every other empty state instead.
  select.innerHTML = steerableTasks.length
    ? steerableTasks
      .map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)} — ${escapeHtml(task.status)}</option>`)
      .join("")
    : '<option value="">No tasks can be steered right now — they\'re either finished or not yet queued.</option>';
  if (steerableTasks.some((task) => task.id === previous)) select.value = previous;
  // Only 'working' means a provider invocation is actually in flight. 'verifying'
  // runs DevHarmonics' own validators and 'retry' is a backoff gap — offering
  // interrupt there would invite the owner to stop work that is not running, and
  // would instead abort a later replacement attempt.
  const selectedTask = steerableTasks.find((task) => task.id === select.value);
  $("#steering-interrupt").disabled = selectedTask?.status !== "working";

  // Reassign and reprioritize act at the admission boundary, so they only apply
  // to work that has not started. Offer them only when that is true.
  const queued = steerableTasks.filter((task) => task.status === "queued");
  const providerSelect = $("#steering-provider");
  const previousProvider = providerSelect.value;
  providerSelect.innerHTML = (state.bootstrap?.providers || [])
    .filter((provider) => provider.available)
    .map((provider) => `<option value="${escapeHtml(provider.name)}">${escapeHtml(providerDisplayName(provider.name))}</option>`)
    .join("");
  if ([...providerSelect.options].some((option) => option.value === previousProvider)) providerSelect.value = previousProvider;
  const selectedIsQueued = Boolean(selectedTask && selectedTask.status === "queued");
  providerSelect.disabled = !selectedIsQueued;
  $("#steering-reassign").disabled = !selectedIsQueued || !providerSelect.options.length;
  $("#steering-order").disabled = queued.length < 2;
  $("#steering-order").placeholder = queued.length ? queued.map((task) => task.id).join(", ") : "No queued tasks";
  $("#steering-reprioritize").disabled = queued.length < 2;

  renderSteeringDirectives(directives);
}

const STEERING_DISPOSITION_DEFINITIONS = {
  applied: "This instruction has taken effect.",
  pending: "Queued — takes effect at the next safe point.",
  rejected: "DevHarmonics could not apply this — see the reason next to it.",
  superseded: "A later instruction replaced this one before it took effect.",
};

function renderSteeringDirectives(directives) {
  const container = $("#steering-directives");
  if (!directives.length) {
    container.innerHTML = '<div class="empty-state">No steering has been requested for this run.</div>';
    return;
  }
  container.innerHTML = [...directives]
    .reverse()
    .map((directive) => {
      const detail = directive.payload?.clarification || directive.payload?.taskOrder?.join(" → ") || directive.payload?.provider || "";
      return `<article class="steering-directive ${escapeHtml(directive.disposition)}">
        <div class="steering-directive-head">
          <strong>${escapeHtml(directive.kind.replaceAll("_", " "))}${directive.targetTaskId ? ` · ${escapeHtml(directive.targetTaskId)}` : ""}</strong>
          <span class="steering-disposition ${escapeHtml(directive.disposition)}" title="${escapeHtml(STEERING_DISPOSITION_DEFINITIONS[directive.disposition] || "")}">${escapeHtml(directive.disposition)}</span>
        </div>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
        <small>${escapeHtml(directive.actor)} · ${new Date(directive.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${directive.dispositionReason ? ` · ${escapeHtml(directive.dispositionReason)}` : ""}${directive.appliedAttemptId ? ` · attempt ${directive.appliedAttemptId}` : ""}</small>
      </article>`;
    })
    .join("");
}

async function refreshSteering(runId) {
  if (!runId) return;
  try {
    const result = await api(`/api/runs/${runId}/steering`);
    state.steering[runId] = result.directives;
  } catch {
    // Steering history is supplementary; a fetch failure must not blank the run view.
  }
}

async function submitSteering(button, runId, body, label) {
  await withOperation(button, label, async () => {
    await api(`/api/runs/${runId}/steering`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await refreshSteering(runId);
    await refreshRuns();
  }, { onError: (message) => { $("#steering-error").textContent = message; }, busyLabel: "Sending…" });
}

const DELIVERY_STATUS_DEFINITIONS = {
  pending: "Nothing has been pushed for this repository yet.",
  branch_pushed: "Your reviewed code is on GitHub, but not yet in a pull request.",
  draft_pr_created: "A pull request exists on GitHub but hasn't been merged.",
  merged: "The change is now in the base branch.",
  tagged: "The change is merged and the release is tagged.",
  failed: "The last delivery step for this repository didn't complete — see the error below.",
};

function renderDelivery(run) {
  const panel = $("#delivery-panel");
  const delivery = run.delivery;
  panel.classList.toggle("hidden", !delivery);
  if (!delivery) return;
  const externalWritesAllowed = Boolean(state.bootstrap?.config?.runPolicy?.allowExternalWrites);
  const done = ["merged", "tagged"];
  $("#delivery-status").textContent = delivery.status.replaceAll("_", " ");
  $("#delivery-status").className = `lifecycle ${done.includes(delivery.status) || delivery.status === "draft_pr_created" ? "qualified" : delivery.status === "failed" ? "degraded" : ""}`;
  $("#delivery-guidance").textContent = externalWritesAllowed
    ? "Every step is your approval — push, draft PR, merge, and tag all run from here, and nothing happens without your click. DevHarmonics never merges or tags on its own."
    : "Delivery is turned off. Turn on \"Allow GitHub delivery actions\" in Setup before you can push a branch or open a pull request.";
  $("#delivery-repositories").innerHTML = delivery.repositories.map((repository) => {
    const pushed = ["branch_pushed", "draft_pr_created", "merged", "tagged"].includes(repository.status);
    const created = ["draft_pr_created", "merged", "tagged"].includes(repository.status);
    const merged = ["merged", "tagged"].includes(repository.status);
    const tagged = repository.status === "tagged";
    const settled = tagged;
    return `<article class="integration-repository-card delivery-repository-card">
      <header><strong>${escapeHtml(repository.repositoryId)}</strong><span class="lifecycle ${created ? "qualified" : repository.status === "failed" ? "degraded" : ""}" title="${escapeHtml(DELIVERY_STATUS_DEFINITIONS[repository.status] || "")}">${escapeHtml(repository.status.replaceAll("_", " "))}</span></header>
      <small class="muted">commit range</small>
      <code class="integration-commit-range">${escapeHtml(repository.baseBranch)}: ${escapeHtml(repository.baseCommit)} → ${escapeHtml(repository.headCommit)}</code>
      <code>${escapeHtml(repository.branch)}</code>
      ${repository.remoteUrl ? `<a href="${escapeHtml(repository.remoteUrl)}" target="_blank" rel="noreferrer">${escapeHtml(repository.remoteUrl)}</a>` : ""}
      ${repository.pullRequestUrl ? `<a class="delivery-pr-link" href="${escapeHtml(repository.pullRequestUrl)}" target="_blank" rel="noreferrer">${merged ? "View merged pull request" : "Open draft pull request"}</a>` : ""}
      ${repository.error ? `<p class="error">${escapeHtml(repository.error)}</p>` : ""}
      ${tagged ? `<p class="delivery-done">Delivered, merged, and tagged${repository.releaseTag ? ` as ${escapeHtml(repository.releaseTag)}` : ""} — this repository is fully shipped.</p>` : merged ? `<p class="delivery-done">Merged under your approval. Tag the release below when you are ready.</p>` : ""}
      <div class="plan-actions">
        <button class="secondary small" type="button" data-delivery-action="push_branch" data-repository-id="${escapeHtml(repository.repositoryId)}" data-head-commit="${escapeHtml(repository.headCommit)}" ${!externalWritesAllowed || pushed ? "disabled" : ""}>${pushed ? "Branch pushed ✓" : "Approve &amp; push branch"}</button>
        <button class="secondary small" type="button" data-delivery-action="create_draft_pr" data-repository-id="${escapeHtml(repository.repositoryId)}" data-head-commit="${escapeHtml(repository.headCommit)}" ${!externalWritesAllowed || !pushed || created ? "disabled" : ""}>${created ? "Draft PR created ✓" : "Approve &amp; create draft pull request"}</button>
        <button class="${merged ? "secondary" : "primary"} small" type="button" data-delivery-action="merge_pr" data-repository-id="${escapeHtml(repository.repositoryId)}" data-head-commit="${escapeHtml(repository.headCommit)}" ${!externalWritesAllowed || !created || merged ? "disabled" : ""}>${merged ? "Merged ✓" : "Approve &amp; merge"}</button>
      </div>
      <div class="plan-actions delivery-tag-row">
        <input class="delivery-tag-input" type="text" placeholder="leave blank to skip tagging" aria-label="Release tag for ${escapeHtml(repository.repositoryId)}" data-tag-for="${escapeHtml(repository.repositoryId)}" ${!externalWritesAllowed || !merged || tagged ? "disabled" : ""}>
        <button class="${merged && !tagged ? "primary" : "secondary"} small" type="button" data-delivery-action="tag_release" data-repository-id="${escapeHtml(repository.repositoryId)}" data-head-commit="${escapeHtml(repository.headCommit)}" ${!externalWritesAllowed || !merged || tagged ? "disabled" : ""}>${tagged ? "Tagged ✓" : "Approve &amp; tag release"}</button>
        ${merged ? "" : `<button class="primary small" type="button" data-delivery-action="complete_delivery" data-repository-id="${escapeHtml(repository.repositoryId)}" data-head-commit="${escapeHtml(repository.headCommit)}" ${!externalWritesAllowed ? "disabled" : ""}>Do everything at once (push, open PR, merge, tag)</button>`}
      </div>
      <p class="field-help delivery-tag-help" data-tag-help-for="${escapeHtml(repository.repositoryId)}">${tagged ? `Tagged ${escapeHtml(repository.releaseTag || "")}.` : "Empty tag field = no tag is created. Reading this repository's declared version…"}</p>
    </article>`;
  }).join("");
}

// Owner finding (2026-07-22): the tag field showed decorative "v1.0.0" ghost
// text that read exactly like the value about to be applied. The field now
// carries the repository's REAL declared version as its editable value, and
// the caption states plainly what an empty field means.
//
// PR #38 finding R4-002 (2026-07-22): GET /api/runs/:id/delivery started
// returning `mergeVersionUnavailable: true` for a repository whose merged
// version could not be re-resolved (transient GitHub/network failure), but
// this caption logic never checked the flag — the `declaredVersion === null`
// branch fired instead and told the owner the repository "declares no
// version", which is false during an outage and directly contradicts the
// CHANGELOG's promised retry copy. mergeVersionUnavailable is now checked
// FIRST, before the generic null branch, and never prefills a tag in that
// state. Pulled out as a pure function of the repository record so it can be
// tested without the DOM.
function deliveryTagCaption(repository) {
  if (repository.mergeVersionUnavailable) {
    return {
      prefill: null,
      help: "The merged version can't be read right now (GitHub or network hiccup). Refresh to retry — the tag field will fill in once it's readable.",
    };
  }
  if (repository.declaredVersion) {
    return {
      prefill: `v${repository.declaredVersion.replace(/^v/i, "")}`,
      help: `This repository declares version ${repository.declaredVersion} — the field is pre-filled to match. Edit it to tag differently (you will be asked to confirm a mismatch), or clear it to skip tagging.`,
    };
  }
  if (repository.declaredVersion === null) {
    return {
      prefill: null,
      help: "This repository declares no version in its own files. Enter a tag to create one, or leave empty to skip tagging.",
    };
  }
  // The field is absent entirely — a server built before version enrichment.
  // Say that, never "declares no version" (which would be a claim about the
  // repository this client cannot back).
  return {
    prefill: null,
    help: "We can't check this repository's declared version right now — ask an engineer to restart the server. Until then: empty tag field = no tag is created.",
  };
}

async function fillDeclaredTagVersions(run) {
  if (!run?.delivery?.repositories?.length) return;
  try {
    const { delivery } = await api(`/api/runs/${run.id}/delivery`);
    for (const repository of delivery?.repositories ?? []) {
      const input = document.querySelector(`[data-tag-for="${CSS.escape(repository.repositoryId)}"]`);
      const help = document.querySelector(`[data-tag-help-for="${CSS.escape(repository.repositoryId)}"]`);
      if (!input || input.disabled) {
        if (help && repository.status === "tagged") help.textContent = `Tagged ${repository.releaseTag || ""}.`;
        continue;
      }
      const caption = deliveryTagCaption(repository);
      if (caption.prefill && !input.value && document.activeElement !== input) input.value = caption.prefill;
      if (help) help.textContent = caption.help;
    }
  } catch {
    // Enrichment is a nicety; the buttons stay honest without it.
  }
}

function renderIntegrationSet(run) {
  const panel = $("#integration-set-panel");
  const integrationSet = run.integrationSet;
  panel.classList.toggle("hidden", !integrationSet);
  if (!integrationSet) return;
  $("#integration-set-status").textContent = integrationSet.status.replaceAll("_", " ");
  $("#integration-set-status").className = `lifecycle ${integrationSet.status === "ready" ? "qualified" : integrationSet.status === "failed" || integrationSet.status === "not_ready" ? "degraded" : ""}`;
  $("#integration-set-conditions").textContent = integrationSet.integrationConditions.length
    ? `Sync rules: ${integrationSet.integrationConditions.join(" · ")}`
    : "No extra rules were needed to keep these repositories in sync.";
  $("#integration-set-repositories").innerHTML = integrationSet.repositories.map((repository) => `
    <article class="integration-repository-card">
      <header><strong>${escapeHtml(repository.repositoryId)}</strong><span class="lifecycle ${repository.status === "ready" ? "qualified" : repository.status === "failed" ? "degraded" : ""}">${escapeHtml(repository.status)}</span></header>
      <code class="integration-commit-range">${escapeHtml(repository.baseCommit.slice(0, 12))} → ${escapeHtml((repository.headCommit || "pending").slice(0, 12))}</code>
      <code>${escapeHtml(repository.integrationBranch)}</code>
      <code>${escapeHtml(repository.localPath)}</code>
      ${repository.error ? `<p class="error">${escapeHtml(repository.error)}</p>` : ""}
    </article>`).join("");
}

function renderBoard(run) {
  // Slice A: "Plan" as a column name collided with the separate "plan
  // preview" step earlier in the flow — "Queued" says what's actually true
  // (waiting to start) without reusing an already-loaded word.
  const columns = [
    ["Queued", ["queued"]],
    ["Working", ["working", "retry"]],
    ["Verifying", ["verifying"]],
    ["Resolved", ["passed", "paused", "failed", "blocked", "cancelled"]],
  ];
  $("#board").innerHTML = columns.map(([title, statuses]) => {
    const tasks = run.tasks.filter((task) => statuses.includes(task.status));
    return `<section class="column"><div class="column-head"><span>${title}</span><b>${tasks.length}</b></div>${tasks.map((task) => taskCard(task, run)).join("") || '<div class="empty-state">No tasks in this column yet</div>'}</section>`;
  }).join("");
}

function taskCard(task, run) {
  const passed = task.checks.filter((check) => check.passed).length;
  let timing = "";
  if (ACTIVE_TASK_STATUSES.includes(task.status)) {
    const { startedAt, lastActivityAt } = taskActivityTimes(task, run);
    const elapsed = startedAt ? `<span class="op-spinner" aria-hidden="true"></span>active <span data-elapsed-since="${startedAt}" aria-hidden="true">${operationElapsed(startedAt)}</span>` : `<span class="op-spinner" aria-hidden="true"></span>starting`;
    timing = `<div class="task-timing">${elapsed}${quietMarkup(lastActivityAt)}</div>`;
  }
  return `<button class="task-card ${task.status}" data-task-id="${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong>${task.repositoryIds?.length ? `<small>${escapeHtml(task.repositoryIds.join(", "))}</small>` : ""}<div class="task-contract"><span>${escapeHtml(permissionLabel(task.permission))}</span><span>${escapeHtml(task.risk)} risk</span></div><div class="task-meta"><span class="provider-tag">${escapeHtml(routingIdentity(taskRouting(run, task.id), task.provider))}</span><span>${passed}/${task.checks.length} checks · ${task.attemptCount} tries</span></div>${timing}</button>`;
}

function renderActivity(run) {
  $("#activity").innerHTML = run.events.length
    ? run.events.map((event) => `<div class="event"><time>${new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>${escapeHtml(eventDisplayMessage(event))}</span></div>`).join("")
    : '<div class="empty-state">Waiting for the first event…</div>';
}

function renderVerdict(run) {
  if (!run.finalReview) {
    $("#verdict").className = "empty-state";
    $("#verdict").textContent = "The independent reviewer's verdict will appear here once the run finishes and its changes are combined.";
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
  const routing = taskRouting(run, taskId);
  $("#drawer-content").innerHTML = `
    <p class="drawer-kicker" title="Queued: waiting to start. Working: an AI is actively writing code. Verifying: DevHarmonics is running its own checks on the result. Passed / failed / blocked / cancelled: finished.">${escapeHtml(task.status)}</p>
    <h2 class="drawer-title">${escapeHtml(task.title)}</h2>
    <p class="drawer-meta">${escapeHtml(routingIdentity(routing, task.provider))} · ${task.attemptCount} attempts</p>
    <h3>What this task is allowed to do</h3>
    <dl class="contract-details">
      <div><dt>Permission</dt><dd>${escapeHtml(permissionLabel(task.permission))}</dd></div>
      <div><dt>Risk</dt><dd>${escapeHtml(task.risk)}</dd></div>
      <div><dt>Type of work</dt><dd>${escapeHtml(task.kind)}</dd></div>
      <div><dt>Repositories</dt><dd>${task.repositoryIds?.length ? task.repositoryIds.map(escapeHtml).join("<br>") : "Current project"}</dd></div>
      <div><dt>Exactly what files it can touch</dt><dd>${task.repositoryScope.map(escapeHtml).join("<br>")}</dd></div>
    </dl>
    <p class="field-help">Permission = can this task change files, or only look. Risk = how closely the result gets checked before it's accepted. Type of work = what category of task this is (e.g. write code, run tests, review). "Exactly what files it can touch" is the specific paths this task is restricted to — even in Bounded autonomy, it cannot write outside this list.</p>
    <p>${escapeHtml(task.description)}</p>
    ${routingEvidenceMarkup(routing)}
    <h3>Acceptance criteria</h3>
    ${task.acceptanceCriteria.length ? `<ul>${task.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<div class="empty-state">No acceptance criteria supplied.</div>'}
    <h3>Files this task should produce</h3>
    ${task.expectedArtifacts.length ? `<ul>${task.expectedArtifacts.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<div class="empty-state">No expected artifacts supplied.</div>'}
    <h3>Checks run so far</h3>
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
  return `<div class="check"><div class="check-head"><strong>${escapeHtml(check.name)}</strong><span class="${check.passed ? "pass" : "fail"}" title="Exit code: the number the check command returned — 0 always means pass; anything else is the check's own failure signal.">${check.passed ? "PASS" : `FAIL (code ${check.exitCode})`}</span></div><pre>${escapeHtml(output)}</pre></div>`;
}

function closeTask() {
  $("#drawer-backdrop").classList.add("hidden");
  $("#task-drawer").classList.remove("open");
  $("#task-drawer").setAttribute("aria-hidden", "true");
  $("#task-drawer").setAttribute("inert", "");
}

function linesFrom(selector) {
  return $(selector).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function namedCommandsFrom(selector) {
  return Object.fromEntries(linesFrom(selector).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1 || !line.slice(separator + 1).trim()) throw new Error(`Validator must use "name = command": ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

function objectiveInput() {
  const deadline = $("#objective-deadline").value;
  const productId = $("#objective-product").value;
  return {
    outcome: $("#goal").value.trim(),
    acceptanceCriteria: linesFrom("#acceptance-criteria"),
    constraints: linesFrom("#constraints"),
    projectPath: $("#project-path").value,
    ...(productId ? { productId } : {}),
    repositoryIds: productId ? [...document.querySelectorAll('input[name="objective-repository"]:checked')].map((input) => input.value) : [],
    risk: $("#objective-risk").value,
    autonomy: $("#run-autonomy").value,
    priority: $("#objective-priority").value,
    ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
    policyNotes: linesFrom("#policy-notes"),
  };
}

async function saveObjectiveDraft() {
  const input = objectiveInput();
  if (!input.outcome) throw new Error("Describe the outcome first.");
  if (input.productId && !input.repositoryIds.length) throw new Error("Select at least one repository for this product objective.");
  const result = state.objective
    ? await api(`/api/objectives/${state.objective.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, expectedRevision: state.objective.revision }),
    })
    : await api("/api/objectives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  state.objective = result.objective;
  return result.objective;
}

async function previewPlan({ revise = false } = {}) {
  const enabledProviders = [...document.querySelectorAll('input[name="provider"]:checked')].map((input) => input.value);
  if (!enabledProviders.length) return showError("Enable at least one provider in the worker pool — and sign in first if none are available.");
  const feedback = $("#revision-feedback").value.trim();
  if (revise && !feedback) return showError("Describe what should change before requesting another revision.");
  const button = revise ? $("#revise-plan") : $("#preview-plan");
  showError("");
  await withOperation(button, revise ? "Requesting a plan revision" : "Asking the architect for a plan", async () => {
    const objective = await saveObjectiveDraft();
    const result = await api(`/api/objectives/${objective.id}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabledProviders, ...(feedback ? { revisionFeedback: feedback, rationale: feedback } : {}) }),
    });
    state.planRevision = result.revision;
    state.planPreview = result.preview;
    renderPlanPreview();
    $("#revision-feedback").value = "";
  }, { busyLabel: revise ? "Requesting revision…" : "Planning…" });
}

function renderPlanPreview() {
  if (!state.planRevision || !state.planPreview) return;
  const plan = state.planRevision.plan;
  $("#plan-preview").classList.remove("hidden");
  $("#plan-revision").textContent = `Revision ${state.planRevision.revision}`;
  $("#plan-summary").textContent = plan.summary;
  const writeTasks = plan.tasks.filter((task) => task.permission === "workspace_write").length;
  const highRisk = plan.tasks.filter((task) => task.risk === "high").length;
  const impacts = plan.repositoryImpact || [];
  const affectedRepositories = impacts.filter((impact) => impact.disposition === "affected").length;
  $("#plan-metrics").innerHTML = `<div class="metric"><span>Tasks</span><strong>${plan.tasks.length}</strong></div><div class="metric"><span>Affected repositories</span><strong>${affectedRepositories}</strong></div><div class="metric"><span>Tasks that change files</span><strong>${writeTasks}</strong></div><div class="metric"><span>High risk</span><strong>${highRisk}</strong></div><div class="metric"><span>AI workers planned</span><strong>${state.planPreview.capacity.effectiveConcurrency}</strong></div>`;
  $("#plan-repository-impact").innerHTML = impacts.map((impact) => `<article class="repository-impact ${escapeHtml(impact.disposition)}"><strong>${escapeHtml(impact.repositoryId)} · ${escapeHtml(impact.disposition)}</strong><span>${escapeHtml(impact.rationale)}</span></article>`).join("");
  $("#plan-task-list").innerHTML = plan.tasks.map((task) => {
    const assignment = state.planPreview.assignments.find((item) => item.taskId === task.id);
    const dependencyText = task.dependencies.length ? `After ${task.dependencies.join(", ")}` : "No dependencies";
    const identity = recordedModelIdentity(assignment?.provider || "unassigned", assignment?.modelId, assignment?.modelId ? "requested_unverified" : "provider_default_unresolved", assignment?.connectionId);
    return `<article class="plan-task"><h3>${escapeHtml(task.title)}</h3><div class="plan-task-meta"><span>${escapeHtml(permissionLabel(task.permission))}</span><span>${escapeHtml(task.risk)} risk</span><span title="The quality/cost tier of AI model assigned — higher tiers cost more and are used for harder tasks.">${escapeHtml(assignment?.tier || "unassigned")}</span></div><p>${escapeHtml(task.description)}</p><details><summary>${escapeHtml(dependencyText)} · ${escapeHtml(identity)} · ${task.checks.length} checks</summary><p>Repositories: ${(task.repositoryIds || []).map(escapeHtml).join(", ") || "Current workspace"}<br>Exactly what it can touch: ${task.repositoryScope.map(escapeHtml).join(", ")}<br>Acceptance: ${task.acceptanceCriteria.map(escapeHtml).join("; ") || "Not supplied"}<br>What the AI needs to be able to do: ${task.capabilityNeeds.map(escapeHtml).join(", ") || "Nothing beyond a normal file edit"}</p></details></article>`;
  }).join("");
  const execution = state.planPreview.execution || { supported: true, reason: "Single workspace execution is available." };
  $("#plan-execution-note").textContent = execution.supported ? `Execution available: ${execution.reason}` : `Planning only: ${execution.reason}`;
  $("#approve-plan-start").disabled = !execution.supported;
  $("#plan-preview").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function approvePlanAndStart() {
  if (!state.objective || !state.planRevision) return showError("Build a plan preview first.");
  if (state.planPreview?.execution && !state.planPreview.execution.supported) return showError(state.planPreview.execution.reason);
  const enabledProviders = [...document.querySelectorAll('input[name="provider"]:checked')].map((input) => input.value);
  const mode = $("#agent-mode").value;
  const agents = mode === "auto" ? "auto" : Number($("#agent-count").value);
  showError("");
  await withOperation($("#approve-plan-start"), "Approving the plan and starting the run", async () => {
    const result = await api(`/api/objectives/${state.objective.id}/plans/${state.planRevision.revision}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents, enabledProviders }),
    });
    state.composing = false;
    state.selectedRunId = result.runId;
    await refreshRuns();
  }, { busyLabel: "Starting…" });
}

function showError(message) { $("#composer-error").textContent = message; }
function showComposer() {
  closeTask();
  showView("runs");
  state.composing = true;
  state.selectedRunId = null;
  state.objective = null;
  state.planRevision = null;
  state.planPreview = null;
  $("#objective-product").value = "";
  renderObjectiveRepositoryPicker();
  $("#plan-preview").classList.add("hidden");
  $("#composer").classList.remove("hidden");
  $("#run-view").classList.add("hidden");
  renderRunList();
  $("#goal").focus();
}

$("#agent-mode").addEventListener("change", (event) => { $("#agent-count").disabled = event.target.value === "auto"; });
$("#run-autonomy").addEventListener("change", () => renderRunAutonomyHelp());
$("#setting-autonomy").addEventListener("change", () => renderRunAutonomyHelp("setting-autonomy", "setting-autonomy-help"));
$("#workbench-autonomy").addEventListener("change", () => renderRunAutonomyHelp("workbench-autonomy", "workbench-autonomy-help"));
$("#objective-product").addEventListener("change", () => {
  renderObjectiveRepositoryPicker();
});
$("#objective-repositories").addEventListener("change", syncProjectPathFromRepositorySelection);
$("#preview-plan").addEventListener("click", () => previewPlan());
$("#revise-plan").addEventListener("click", () => previewPlan({ revise: true }));
$("#approve-plan-start").addEventListener("click", approvePlanAndStart);
$("#refresh-provider-status").addEventListener("click", refreshProviderStatus);
$("#cancel-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  // Gap fixed (Slice A): every other consequential action in this view
  // (delivery push/merge/tag, steering interrupt) already confirms before
  // acting — cancel was the one stray click that could not be undone.
  if (!window.confirm("Cancel this run? Work in progress stops; evidence already recorded is kept.")) return;
  showError("");
  await withOperation($("#cancel-run"), "Cancelling the run", async () => {
    await api(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await refreshRuns();
  }, { busyLabel: "Cancelling…" });
});
$("#new-run").addEventListener("click", showComposer);
document.querySelector(".app-nav").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  showView(button.dataset.view);
  if (button.dataset.view === "setup" || button.dataset.view === "models") await refreshFleet();
  if (button.dataset.view === "evidence") await refreshEvidence();
  if (button.dataset.view === "products") await refreshProducts();
  if (button.dataset.view === "workbench") await refreshWorkbench();
  if (button.dataset.view === "workflows") await refreshWorkflows();
});
$("#refresh-products").addEventListener("click", refreshProducts);
$("#register-product").addEventListener("click", () => {
  $("#product-form").classList.toggle("hidden");
  if (!$("#product-form").classList.contains("hidden")) $("#product-id").focus();
});
$("#add-local-repository").addEventListener("click", () => {
  $("#repository-form").classList.toggle("hidden");
  if (!$("#repository-form").classList.contains("hidden")) $("#repository-path").focus();
});
$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("#product-form-error").textContent = "";
  await withOperation(form.querySelector('button[type="submit"]'), "Registering the product", async () => {
    const result = await api("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: $("#product-id").value.trim(),
        name: $("#product-name").value.trim(),
        organizationUrl: $("#product-organization").value.trim(),
        description: $("#product-description").value.trim(),
        repositories: [],
      }),
    });
    form.reset();
    form.classList.add("hidden");
    await refreshProducts();
    $("#repository-product").value = result.product.id;
  }, { onError: (message) => { $("#product-form-error").textContent = message; }, busyLabel: "Registering…" });
});
$("#repository-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const productId = $("#repository-product").value;
  const form = event.currentTarget;
  $("#repository-form-error").textContent = "";
  await withOperation(form.querySelector('button[type="submit"]'), "Attaching the local repository", async () => {
    await api(`/api/products/${encodeURIComponent(productId)}/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: $("#repository-path").value.trim(),
        role: $("#repository-role").value,
        expectedBranch: $("#repository-branch").value.trim() || null,
        owners: linesFrom("#repository-owners"),
        dependencyRepositoryIds: linesFrom("#repository-dependencies"),
        governanceSources: linesFrom("#repository-governance"),
        validators: namedCommandsFrom("#repository-validators"),
      }),
    });
    form.reset();
    $("#repository-role").value = "module";
    form.classList.add("hidden");
    await refreshProducts();
  }, { onError: (message) => { $("#repository-form-error").textContent = message; }, busyLabel: "Inspecting…" });
});
$("#product-list").addEventListener("click", async (event) => {
  const scanButton = event.target.closest("[data-scan-product]");
  const registryError = (message) => {
    $("#repository-form-error").textContent = message;
    $("#repository-form").classList.remove("hidden");
  };
  if (scanButton) {
    await withOperation(scanButton, "Scanning product intelligence sources", async () => {
      await api(`/api/products/${encodeURIComponent(scanButton.dataset.scanProduct)}/intelligence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await refreshProducts();
    }, { onError: registryError, busyLabel: "Scanning…" });
    return;
  }
  const button = event.target.closest("[data-refresh-repository]");
  if (!button) return;
  await withOperation(button, "Re-inspecting the repository", async () => {
    await api(`/api/products/${encodeURIComponent(button.dataset.productId)}/repositories/${encodeURIComponent(button.dataset.refreshRepository)}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await refreshProducts();
  }, { onError: registryError, busyLabel: "Inspecting…" });
});
$("#new-workbench").addEventListener("click", () => {
  $("#workbench-project").value = state.bootstrap.defaultProject;
  $("#workbench-title-input").value = "";
  $("#workbench-new-error").textContent = "";
  $("#workbench-new-form").classList.toggle("hidden");
  if (!$("#workbench-new-form").classList.contains("hidden")) $("#workbench-title-input").focus();
});
$("#workbench-new-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#workbench-new-error").textContent = "";
  await withOperation(event.currentTarget.querySelector('button[type="submit"]'), "Creating the Workbench discussion", async () => {
    const result = await api("/api/workbench", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: $("#workbench-project").value, title: $("#workbench-title-input").value.trim() || "Untitled discussion" }),
    });
    $("#workbench-new-form").classList.add("hidden");
    await refreshWorkbench(result.session.id);
  }, { onError: (message) => { $("#workbench-new-error").textContent = message; }, busyLabel: "Creating…" });
});
$("#workbench-session-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-workbench-session]");
  if (button) await selectWorkbench(button.dataset.workbenchSession);
});
$("#workbench-consult-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.workbenchSession) return;
  const question = $("#workbench-question").value.trim();
  const modelIds = [...document.querySelectorAll('input[name="workbench-model"]:checked')].map((input) => input.value);
  if (!question) return $("#workbench-error").textContent = "Ask a question first.";
  if (!modelIds.length) return $("#workbench-error").textContent = "Select at least one model.";
  $("#workbench-error").textContent = "";
  await withOperation($("#workbench-consult"), `Consulting ${modelIds.length} model${modelIds.length === 1 ? "" : "s"}`, async () => {
    await api(`/api/workbench/${state.workbenchSession.id}/consult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, modelIds }),
    });
    $("#workbench-question").value = "";
    await refreshWorkbench(state.workbenchSession.id);
  }, { onError: (message) => { $("#workbench-error").textContent = message; }, busyLabel: `Consulting ${modelIds.length} model${modelIds.length === 1 ? "" : "s"}…` });
});
$("#workbench-convert-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.workbenchSession) return;
  const input = {
    outcome: $("#workbench-outcome").value.trim(),
    acceptanceCriteria: linesFrom("#workbench-criteria"),
    constraints: linesFrom("#workbench-constraints"),
    projectPath: state.workbenchSession.projectPath,
    repositoryIds: [],
    risk: $("#workbench-risk").value,
    autonomy: $("#workbench-autonomy").value,
    priority: $("#workbench-priority").value,
    policyNotes: [`Source Workbench discussion: ${state.workbenchSession.id}`],
  };
  await withOperation(event.currentTarget.querySelector('button[type="submit"]'), "Converting the discussion into an objective draft", async () => {
    const result = await api(`/api/workbench/${state.workbenchSession.id}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    showComposer();
    state.objective = result.objective;
    $("#project-path").value = result.objective.projectPath;
    $("#goal").value = result.objective.outcome;
    $("#acceptance-criteria").value = result.objective.acceptanceCriteria.join("\n");
    $("#constraints").value = result.objective.constraints.join("\n");
    $("#objective-risk").value = result.objective.risk;
    $("#objective-priority").value = result.objective.priority;
    $("#run-autonomy").value = result.objective.autonomy;
    $("#policy-notes").value = result.objective.policyNotes.join("\n");
    renderRunAutonomyHelp();
  }, { onError: (message) => { $("#workbench-error").textContent = message; }, busyLabel: "Converting…" });
});
$("#refresh-evidence").addEventListener("click", refreshEvidence);
$("#export-evidence").addEventListener("click", () => {
  const runId = state.selectedRunId || state.runs[0]?.id;
  if (!runId) return;
  const link = document.createElement("a");
  link.href = `/api/runs/${runId}/evidence/export`;
  link.download = `devharmonics-${runId}-evidence.json`;
  document.body.append(link);
  link.click();
  link.remove();
});
$("#pause-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  await withOperation($("#pause-run"), "Pausing the run", async () => {
    await api(`/api/runs/${runId}/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await refreshRuns();
  }, { busyLabel: "Pausing…" });
});
$("#approve-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  await withOperation($("#approve-run"), "Approving the requested action", async () => {
    await api(`/api/runs/${runId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await refreshRuns();
  }, { busyLabel: "Approving…" });
});
$("#resume-run").addEventListener("click", async () => {
  const runId = state.selectedRunId;
  if (!runId) return;
  await withOperation($("#resume-run"), "Resuming the run", async () => {
    const result = await api(`/api/runs/${runId}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    state.selectedRunId = result.runId;
    await refreshRuns();
  }, { busyLabel: "Resuming…" });
});
$("#refresh-setup").addEventListener("click", async (event) => {
  await withOperation(event.currentTarget, "Refreshing setup status", async () => {
    state.bootstrap = await api("/api/bootstrap");
    renderProviders();
    renderSettings();
    await refreshFleet();
  }, { busyLabel: "Refreshing…" });
});
$("#refresh-models").addEventListener("click", async () => {
  await withOperation($("#refresh-models"), "Refreshing the model fleet", async () => {
    try {
      const refreshed = await api("/api/catalog/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      state.bootstrap = { ...state.bootstrap, config: refreshed.config, providers: refreshed.providers, ollama: refreshed.ollama, catalog: { refreshedAt: refreshed.refreshedAt, refreshes: refreshed.refreshes } };
      await refreshFleet();
      $("#model-message").textContent = `Fleet refreshed at ${new Date(refreshed.refreshedAt).toLocaleString()}.`;
    } catch (error) {
      await refreshFleet();
      throw error;
    }
  }, { onError: (message) => { $("#model-message").textContent = message; }, busyLabel: "Refreshing fleet…" });
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
  $("#openrouter-catalog").innerHTML = result.models.map((model) => `<article class="model-card"><div><span class="connection-kind">OPENROUTER CATALOG</span><h3>${escapeHtml(model.displayName)}</h3><code>${escapeHtml(model.canonicalName)}</code></div><p>Reads up to ${Number(model.metadata.contextLength || 0).toLocaleString()} tokens at once · Estimated cost to test: ${model.estimatedQualificationCostUsd == null ? "unknown" : `$${Number(model.estimatedQualificationCostUsd).toFixed(5)}`}</p>${model.exact ? `<button class="secondary small" data-import-openrouter="${escapeHtml(model.canonicalName)}">Add to known models</button>` : '<span class="muted" title="OpenRouter sometimes points a name at whichever model is newest, so DevHarmonics can\'t lock a version to it. Search for the specific version name instead.">Not an exact match — can\'t be added yet</span>'}</article>`).join("") || '<div class="empty-state">No matching catalog models.</div>';
}

// Slice A: this is the same "why a model was picked" concept as the Models
// view's Observed performance / Workload evidence blocks — one vocabulary
// for both, and no raw scoring-system point values shown to a PM.
function routingEvidenceMarkup(routing) {
  if (!routing) return '<h3>Why this model</h3><div class="empty-state">We don\'t have a record of why this model was picked for this earlier run.</div>';
  const reasons = {
    manualAssignment: "Manually assigned",
    baseEligibility: "Qualified for this task",
    tierFit: "Right capability level for the task's difficulty",
    reasoningFit: "Matched the effort setting needed",
    userPin: "You pinned this model",
    preferredProvider: "Preferred provider for this task",
    fallbackProvider: "Used as a fallback preference",
    empiricalReliability: "Historically reliable on similar tasks",
    empiricalLatency: "Historically fast on similar tasks",
    providerDiversity: "Chosen from a different provider than the one that wrote the code, for independent review",
    costAwareness: "Reasonable cost compared to similar models",
  };
  const reasonRows = Object.entries(routing.scoreBreakdown || {}).filter(([, value]) => Number(value) !== 0)
    .map(([key]) => `<li>${escapeHtml(reasons[key] || key)}</li>`).join("");
  const modelName = routing.model?.alias || routing.model?.requestedModelId || "provider default";
  return `<h3>Why this model</h3><p>${escapeHtml(connectionDisplayName(routing.connectionId, routing.provider))} / ${escapeHtml(modelName)} was requested for a ${escapeHtml(routing.workload?.complexity || "classified")} task that needed ${escapeHtml(routing.workload?.requiredTier || "configured")}-level capability. DevHarmonics only counts a model as confirmed once the tool itself reports back which model it actually used.</p>${reasonRows ? `<ul>${reasonRows}</ul>` : ""}${routing.factors?.length ? `<ul>${routing.factors.map((factor) => `<li>${escapeHtml(factor)}</li>`).join("")}</ul>` : ""}`;
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
    $("#settings-message").textContent = "Turn on at least one subscription tool under \"Subscription workers.\"";
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
  const qualifyLocalTools = event.target.closest("[data-qualify-local-tools]");
  const qualifyBenchmark = event.target.closest("[data-qualify-benchmark]");
  const activate = event.target.closest("[data-activate-model]");
  const pin = event.target.closest("[data-pin-model]");
  const track = event.target.closest("[data-track-model]");
  const exclude = event.target.closest("[data-exclude-model]");
  const resetPerformance = event.target.closest("[data-reset-performance]");
  const excludePerformance = event.target.closest("[data-exclude-performance]");
  const button = qualify || qualifyLocalTools || qualifyBenchmark || activate || pin || track || exclude || resetPerformance || excludePerformance;
  if (!button) return;
  const operationLabel = qualify || qualifyLocalTools || qualifyBenchmark ? "Qualifying the model" : resetPerformance ? "Resetting performance history" : excludePerformance ? "Updating whether past results count" : "Updating this model's settings";
  // Confirm before the operation begins, so cancelling never registers a
  // started (let alone succeeded) operation.
  if (resetPerformance && !window.confirm("Reset this model's performance history? Past runs are still kept on record — they just won't count toward future scheduling decisions anymore.")) return;
  let qualifiedModelId = null;
  let preferenceModelId = null;
  await withOperation(button, operationLabel, async () => {
    if (resetPerformance || excludePerformance) {
      const modelId = resetPerformance?.dataset.resetPerformance || excludePerformance.dataset.excludePerformance;
      const policy = state.performancePolicies.find((item) => item.modelId === modelId);
      await api(`/api/model-performance/${encodeURIComponent(modelId)}/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resetPerformance ? { reset: true } : { excluded: !policy?.excluded }),
      });
      preferenceModelId = modelId;
    } else if (qualify || qualifyLocalTools || qualifyBenchmark) {
      const model = state.models.find((item) => item.id === (qualify?.dataset.qualifyModel || qualifyLocalTools?.dataset.qualifyLocalTools || qualifyBenchmark.dataset.qualifyBenchmark));
      const connection = state.connections.find((item) => item.id === model.connectionId);
      const role = qualifyLocalTools ? "local_tools" : qualifyBenchmark ? "benchmark" : connection?.transport === "local" ? "analysis" : "general";
      $("#model-message").textContent = role === "local_tools" ? `Testing ${model.displayName}'s ability to safely edit files, in a throwaway test copy of your project...` : role === "benchmark" ? `Testing ${model.displayName}'s accuracy on structured answers, spotting contradictions, and counting requirements...` : `Running a quick, read-only check to see if ${model.displayName} qualifies as a ${roleLabel(role)}...`;
      try {
        await api(`/api/models/${encodeURIComponent(model.id)}/qualify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
      } catch (error) {
        if (!error.data?.requiresCostConfirmation || !window.confirm(`This test uses a paid model. Estimated cost: ${error.data.estimatedCostUsd == null ? "couldn't be estimated — check OpenRouter's pricing page before continuing" : `$${Number(error.data.estimatedCostUsd).toFixed(5)}`}. Continue?`)) throw error;
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
        if (!error.data?.requiresCostConfirmation || !window.confirm(`Activation requires a paid qualification. Estimated cost: ${error.data.estimatedCostUsd == null ? "couldn't be estimated — check OpenRouter's pricing page before continuing" : `$${Number(error.data.estimatedCostUsd).toFixed(5)}`}. Continue?`)) throw error;
        await api(`/api/models/${encodeURIComponent(modelId)}/preference`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirmPaidCost: true }) });
      }
      preferenceModelId = modelId;
    }
    await refreshFleet();
    if (qualifiedModelId) {
      const qualifiedModel = state.models.find((model) => model.id === qualifiedModelId);
      const nextStep = isModelSchedulable(qualifiedModel) ? "It's active and ready to be used."
        : requiresSpecialistBenchmark(qualifiedModel) && !hasCurrentSpecialistBenchmark(qualifiedModel) ? "It still needs the extra accuracy test before it can be used — see \"Run accuracy test\" below."
          : !hasCurrentOperationalQualification(qualifiedModel) ? "It still needs to pass a role check before it can be used."
          : qualifiedModel?.active ? "It's turned on but not currently usable — check its status above."
            : "Click Activate to start using it.";
      $("#model-message").textContent = `${qualifiedModel?.displayName || "Model"} passed its check. ${nextStep}`;
    } else if (preferenceModelId) {
      const preferenceModel = state.models.find((model) => model.id === preferenceModelId);
      $("#model-message").textContent = `${preferenceModel?.displayName || "Model"}'s settings were updated.`;
    }
  }, { onError: async (message) => { $("#model-message").textContent = message; await refreshFleet(); } });
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
$("#delivery-repositories").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delivery-action]");
  if (!button) return;
  const action = button.dataset.deliveryAction;
  const repositoryId = button.dataset.repositoryId;
  const tagInput = document.querySelector(`[data-tag-for="${CSS.escape(repositoryId)}"]`);
  const tag = tagInput?.value.trim() || undefined;
  const labels = {
    push_branch: { confirm: "push this exact reviewed branch to GitHub", op: "Pushing the exact reviewed branch", busy: "Pushing…" },
    create_draft_pr: { confirm: "create a draft pull request for this exact reviewed branch", op: "Creating the draft pull request", busy: "Creating draft PR…" },
    merge_pr: { confirm: `mark the pull request ready and MERGE it into its base branch — only if GitHub still shows the exact reviewed commit ${(button.dataset.headCommit || "").slice(0, 12)}, no conflicts, and green checks`, op: "Merging the approved pull request", busy: "Merging…" },
    tag_release: { confirm: `create and push release tag ${tag ?? "(enter a tag name first)"} on the merge commit`, op: "Tagging the release", busy: "Tagging…" },
    complete_delivery: { confirm: `run the complete delivery of reviewed commit ${(button.dataset.headCommit || "").slice(0, 12)}: push, draft PR, merge${tag ? `, and tag ${tag}` : ""} — one approval covering each named step; the merge step still refuses to run if there's a conflict, a red check, or if the pull request has changed since you approved it`, op: "Completing the delivery", busy: "Delivering…" },
  };
  const label = labels[action] ?? labels.push_branch;
  if (action === "tag_release" && !tag) { $("#delivery-error").textContent = "Enter a release tag name first."; return; }
  if (!window.confirm(`Approve DevHarmonics to ${label.confirm}? Your click is the approval receipt; nothing here happens without it.`)) return;
  $("#delivery-error").textContent = "";
  // Whole-card lockout: while ANY action on this repository is in flight,
  // every sibling control is disabled too — overlapping operations should be
  // unreachable from honest clicking, not merely survivable.
  const card = button.closest(".delivery-repository-card");
  const siblings = card ? [...card.querySelectorAll("button, input")].filter((element) => element !== button) : [];
  for (const element of siblings) element.disabled = true;
  card?.classList.add("delivery-busy");
  try {
    await withOperation(button, label.op, async () => {
      const submit = (confirmVersionMismatch) => api(`/api/runs/${state.selectedRunId}/delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId, action, expectedHeadCommit: button.dataset.headCommit, ...(tag ? { tag } : {}), ...(confirmVersionMismatch ? { confirmVersionMismatch: true } : {}) }),
      });
      try {
        await submit(false);
      } catch (error) {
        // Tag-truth gate: the repository's own files disagree with the typed
        // tag — show both and take an explicit second owner confirmation.
        const mismatch = error?.data?.versionMismatch;
        if (!mismatch) throw error;
        if (!window.confirm(`Hold on — this repository's own files declare version ${mismatch.declaredVersion}, but you typed ${mismatch.requestedTag}. A tag the repo contradicts is public and hard to undo.\n\nTag it as ${mismatch.requestedTag} anyway?`)) {
          // The owner declined the override: nothing was tagged and nothing
          // broke. Report it as a declined operation, not a success (and not a
          // failure) so the shared activity strip stays honest.
          $("#delivery-error").textContent = `Tag not applied: the repository declares ${mismatch.declaredVersion}. Re-tag with the matching version, or confirm the mismatch deliberately.`;
          return cancelledOperation(`Tag not applied — you declined tagging ${mismatch.requestedTag} over the declared ${mismatch.declaredVersion}.`);
        }
        await submit(true);
      }
      await refreshRuns();
    }, { onError: (message) => { $("#delivery-error").textContent = message; }, busyLabel: label.busy });
  } finally {
    card?.classList.remove("delivery-busy");
    // refreshRuns re-renders the panel with true state; this restore only
    // matters when the operation failed before a re-render.
    for (const element of siblings) element.disabled = false;
  }
});
$("#steering-hold").addEventListener("click", async (event) => {
  const runId = state.selectedRunId;
  if (!runId) return;
  $("#steering-error").textContent = "";
  await submitSteering(event.currentTarget, runId, { kind: "hold_admission", targetTaskId: null, payload: {} }, "Holding task admission");
});
$("#steering-resume").addEventListener("click", async (event) => {
  const runId = state.selectedRunId;
  if (!runId) return;
  $("#steering-error").textContent = "";
  await submitSteering(event.currentTarget, runId, { kind: "resume_admission", targetTaskId: null, payload: {} }, "Resuming task admission");
});
$("#steering-clarify-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const runId = state.selectedRunId;
  const clarification = $("#steering-clarification").value.trim();
  const targetTaskId = $("#steering-task").value;
  if (!runId || !targetTaskId) return;
  $("#steering-error").textContent = "";
  if (!clarification) {
    $("#steering-error").textContent = "Describe the clarification before sending it.";
    return;
  }
  await submitSteering($("#steering-clarify"), runId, { kind: "clarify", targetTaskId, payload: { clarification } }, "Sending clarification");
  $("#steering-clarification").value = "";
});
$("#steering-interrupt").addEventListener("click", async (event) => {
  const runId = state.selectedRunId;
  const targetTaskId = $("#steering-task").value;
  if (!runId || !targetTaskId) return;
  const clarification = $("#steering-clarification").value.trim();
  if (!window.confirm(`Interrupt the active attempt for '${targetTaskId}'? DevHarmonics stops that attempt, keeps its evidence, and starts a new attempt with your direction. It cannot change an answer already being written.`)) return;
  $("#steering-error").textContent = "";
  await submitSteering(event.currentTarget, runId, { kind: "interrupt", targetTaskId, payload: clarification ? { clarification } : {} }, "Interrupting the active attempt");
  $("#steering-clarification").value = "";
});
$("#steering-reassign").addEventListener("click", async (event) => {
  const runId = state.selectedRunId;
  const targetTaskId = $("#steering-task").value;
  const provider = $("#steering-provider").value;
  if (!runId || !targetTaskId || !provider) return;
  $("#steering-error").textContent = "";
  await submitSteering(event.currentTarget, runId, { kind: "reassign", targetTaskId, payload: { provider } }, `Reassigning ${targetTaskId}`);
});
$("#steering-reprioritize").addEventListener("click", async (event) => {
  const runId = state.selectedRunId;
  if (!runId) return;
  const taskOrder = $("#steering-order").value.split(",").map((entry) => entry.trim()).filter(Boolean);
  $("#steering-error").textContent = "";
  if (!taskOrder.length) {
    $("#steering-error").textContent = "List the queued task IDs in the order you want them admitted.";
    return;
  }
  await submitSteering(event.currentTarget, runId, { kind: "reprioritize", targetTaskId: null, payload: { taskOrder } }, "Setting admission order");
  $("#steering-order").value = "";
});
$("#steering-task").addEventListener("change", () => {
  const run = state.runs.find((item) => item.id === state.selectedRunId);
  if (run) renderSteering(run);
});
$("#close-drawer").addEventListener("click", closeTask);
$("#drawer-backdrop").addEventListener("click", closeTask);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTask(); });

initialize().catch((error) => showError(error.message));
