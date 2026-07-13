const state = { bootstrap: null, runs: [], selectedRunId: null };
const $ = (selector) => document.querySelector(selector);

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
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
  state.bootstrap = await api("/api/bootstrap");
  $("#project-path").value = state.bootstrap.defaultProject;
  renderProviders();
  await refreshRuns();
  setInterval(refreshRuns, 1500);
}

function renderProviders() {
  const providers = state.bootstrap.providers;
  $("#provider-status").innerHTML = providers
    .map((provider) => `<span class="provider-chip ${provider.installed ? "online" : ""}" title="${escapeHtml(provider.version || provider.loginCommand)}"><i></i>${escapeHtml(provider.name)}</span>`)
    .join("");
  $("#provider-toggles").innerHTML = providers
    .map((provider) => `<label class="toggle"><input type="checkbox" name="provider" value="${provider.name}" ${provider.installed ? "checked" : "disabled"}><span>${escapeHtml(provider.name)}</span></label>`)
    .join("");
  $("#provider-help-content").innerHTML = providers
    .map((provider) => `<section class="provider-help-card"><div><strong>${escapeHtml(provider.name)}</strong><code>${escapeHtml(provider.loginCommand)}</code></div><ol>${provider.setupSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section>`)
    .join("");
}

async function refreshRuns() {
  const result = await api("/api/runs");
  state.runs = result.runs;
  if (!state.selectedRunId && state.runs.length) state.selectedRunId = state.runs[0].id;
  renderRunList();
  renderSelectedRun();
}

function renderRunList() {
  $("#run-list").innerHTML = state.runs
    .map((run) => `<button class="run-link ${run.id === state.selectedRunId ? "active" : ""}" data-run-id="${run.id}">${escapeHtml(run.goal)}<small>${escapeHtml(run.status.replaceAll("_", " "))}</small></button>`)
    .join("");
}

function renderSelectedRun() {
  const run = state.runs.find((item) => item.id === state.selectedRunId);
  if (!run) return;
  $("#composer").classList.add("hidden");
  $("#run-view").classList.remove("hidden");
  $("#page-title").textContent = "Verified agent run";
  $("#run-project").textContent = run.projectPath;
  $("#run-goal").textContent = run.goal;
  $("#run-status").textContent = run.status.replaceAll("_", " ");
  $("#run-status").className = `status-pill ${run.status}`;
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
    ["Resolved", ["passed", "failed", "blocked"]],
  ];
  $("#board").innerHTML = columns.map(([title, statuses]) => {
    const tasks = run.tasks.filter((task) => statuses.includes(task.status));
    return `<section class="column"><div class="column-head"><span>${title}</span><b>${tasks.length}</b></div>${tasks.map(taskCard).join("") || '<div class="empty-state">No tasks</div>'}</section>`;
  }).join("");
}

function taskCard(task) {
  const passed = task.checks.filter((check) => check.passed).length;
  return `<button class="task-card ${task.status}" data-task-id="${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong><div class="task-meta"><span class="provider-tag">${escapeHtml(task.provider || "unassigned")}</span><span>${passed}/${task.checks.length} checks · ${task.attemptCount} tries</span></div></button>`;
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
  $("#drawer-content").innerHTML = `
    <p class="drawer-kicker">${escapeHtml(task.status)}</p>
    <h2 class="drawer-title">${escapeHtml(task.title)}</h2>
    <p class="drawer-meta">${escapeHtml(task.provider || "Unassigned")} · ${task.attemptCount} attempts</p>
    <h3>Verification receipts</h3>
    ${task.checks.length ? task.checks.map(checkMarkup).join("") : '<div class="empty-state">No checks have run yet.</div>'}
  `;
  $("#drawer-backdrop").classList.remove("hidden");
  $("#task-drawer").classList.add("open");
  $("#task-drawer").setAttribute("aria-hidden", "false");
}

function checkMarkup(check) {
  const output = [check.stdout, check.stderr].filter(Boolean).join("\n") || "No output";
  return `<div class="check"><div class="check-head"><strong>${escapeHtml(check.name)}</strong><span class="${check.passed ? "pass" : "fail"}">${check.passed ? "PASS" : `FAIL ${check.exitCode}`}</span></div><pre>${escapeHtml(output)}</pre></div>`;
}

function closeTask() {
  $("#drawer-backdrop").classList.add("hidden");
  $("#task-drawer").classList.remove("open");
  $("#task-drawer").setAttribute("aria-hidden", "true");
}

async function startRun() {
  const goal = $("#goal").value.trim();
  const enabledProviders = [...document.querySelectorAll('input[name="provider"]:checked')].map((input) => input.value);
  if (!goal) return showError("Describe the outcome first.");
  if (!enabledProviders.length) return showError("Enable at least one installed provider.");
  const mode = $("#agent-mode").value;
  const agents = mode === "auto" ? "auto" : Number($("#agent-count").value);
  $("#start-run").disabled = true;
  showError("");
  try {
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, projectPath: $("#project-path").value, agents, enabledProviders }),
    });
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
  state.selectedRunId = null;
  $("#composer").classList.remove("hidden");
  $("#run-view").classList.add("hidden");
  $("#page-title").textContent = "Assemble a verified agent team";
  renderRunList();
  $("#goal").focus();
}

$("#agent-mode").addEventListener("change", (event) => { $("#agent-count").disabled = event.target.value === "auto"; });
$("#start-run").addEventListener("click", startRun);
$("#new-run").addEventListener("click", showComposer);
$("#run-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-run-id]");
  if (button) { state.selectedRunId = button.dataset.runId; renderRunList(); renderSelectedRun(); }
});
$("#board").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-id]");
  if (button) openTask(button.dataset.taskId);
});
$("#close-drawer").addEventListener("click", closeTask);
$("#drawer-backdrop").addEventListener("click", closeTask);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTask(); });

initialize().catch((error) => showError(error.message));
