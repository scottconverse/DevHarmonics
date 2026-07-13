import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { initializeProject, loadConfig, ringerDirectory } from "../src/config.js";
import { inspectProviders } from "../src/doctor.js";
import { Ledger } from "../src/ledger.js";
import { Orchestrator } from "../src/orchestrator.js";
import { runProcess } from "../src/process.js";
import { startDashboard } from "../src/server.js";

async function git(cwd: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

async function createRepository(root: string): Promise<string> {
  const project = path.join(root, "project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(project, { recursive: true }));
  await git(project, ["init", "-b", "main"]);
  await writeFile(path.join(project, "README.md"), "# Fixture\n", "utf8");
  await writeFile(path.join(project, ".gitignore"), "node_modules/\n", "utf8");
  await git(project, ["add", "."]);
  await git(project, [
    "-c",
    "user.name=Ringer Tests",
    "-c",
    "user.email=ringer-tests@local",
    "commit",
    "-m",
    "fixture",
  ]);
  return project;
}

async function createFakeCli(root: string, authenticated = true): Promise<string> {
  const script = path.join(root, "fake-cli.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
input += " " + process.argv.slice(2).join(" ");
const args = process.argv.slice(2);
const authCheck = args[0] === "models" ||
  (args[0] === "login" && args[1] === "status") ||
  (args[0] === "auth" && args[1] === "status");
if (process.argv.includes("--version")) {
  console.log("fake 1.0");
} else if (authCheck) {
  ${authenticated ? 'console.log("Authenticated fixture");' : 'console.error("Sign-in required"); process.exitCode = 1;'}
} else if (input.includes("You are the architect")) {
  const plan = {summary:"fixture plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  console.log("READY\\n\\nFixture integration is valid.");
} else {
  writeFileSync("result.txt", "created by worker\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Created result.txt"}}));
}
`,
    "utf8",
  );

  if (process.platform === "win32") {
    const wrapper = path.join(root, "fake-cli.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(root, "fake-cli.sh");
  await writeFile(wrapper, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function createSlowArchitectCli(root: string): Promise<string> {
  const script = path.join(root, "slow-architect-cli.mjs");
  await writeFile(
    script,
    `import { setTimeout as delay } from "node:timers/promises";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
input += " " + process.argv.slice(2).join(" ");
if (process.argv.includes("--version")) {
  console.log("fake 1.0");
} else if (process.argv[2] === "models" || process.argv[2] === "login" || process.argv[2] === "auth") {
  console.log("Authenticated fixture");
} else if (input.includes("You are the architect")) {
  await delay(1_000);
  const plan = {summary:"late plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  console.log("READY\\n\\nShould not review after cancellation.");
} else {
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Should not work after cancellation"}}));
}
`,
    "utf8",
  );

  if (process.platform === "win32") {
    const wrapper = path.join(root, "slow-architect-cli.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(root, "slow-architect-cli.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
}

// Like createFakeCli, but the worker prompt HANGS in a bounded sleep loop so a
// task is genuinely in-flight while cancellation lands. Architect still returns
// a one-task plan and the reviewer still returns READY, so nothing else stalls.
async function createHangingCli(root: string): Promise<string> {
  const script = path.join(root, "hanging-cli.mjs");
  await writeFile(
    script,
    `let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
input += " " + process.argv.slice(2).join(" ");
if (process.argv.includes("--version")) {
  console.log("fake 1.0");
} else if (process.argv[2] === "models" || process.argv[2] === "login" || process.argv[2] === "auth") {
  console.log("Authenticated fixture");
} else if (input.includes("You are the architect")) {
  const plan = {summary:"cancel plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  console.log("READY\\n\\nFixture integration is valid.");
} else {
  // Worker prompt: hang until the orchestrator kills us on cancel. Bounded to
  // ~10s so a killed-but-orphaned grandchild (the Windows .cmd wrapper spawns
  // node, and killing cmd.exe does not reap it) self-exits and releases the
  // worktree directory for cleanup instead of leaking. Upgrade path: parent-
  // death detection if the bound ever proves too short for a slow poll.
  const until = Date.now() + 4_000;
  while (Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
}
`,
    "utf8",
  );

  if (process.platform === "win32") {
    const wrapper = path.join(root, "hanging-cli.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(root, "hanging-cli.sh");
  // exec so the shell process becomes node; killing it reaps node directly.
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function poll<T>(fetchValue: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fetchValue();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("poll timed out waiting for condition");
    await delay(50);
  }
}

test("signed-out providers are detected and blocked before a run starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-auth-gate-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root, false);
  await initializeProject(project);
  const config = await loadConfig(project);
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.providers[provider].command = command;
  }
  await writeFile(
    path.join(ringerDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const statuses = await inspectProviders(config, project);
  assert.ok(statuses.every((provider) => provider.installed));
  assert.ok(statuses.every((provider) => !provider.authenticated));
  assert.ok(statuses.every((provider) => provider.authStatus.includes("Sign-in required")));

  const ledger = new Ledger(path.join(ringerDirectory(project), "ringer.db"));
  try {
    const orchestrator = new Orchestrator(ledger);
    const runId = await orchestrator.run({
      goal: "This must not start",
      projectPath: project,
      agents: 1,
      enabledProviders: ["codex"],
    });
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "failed");
    assert.match(run?.finalReview ?? "", /codex: run 'codex login'/);
    assert.equal(run?.events.some((event) => event.kind === "worktree.created"), false);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator completes a verified run through fake subscription CLIs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-e2e-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  const sharedDependencies = path.join(root, "shared-node-modules");
  await mkdir(sharedDependencies, { recursive: true });
  await writeFile(path.join(sharedDependencies, "shared-marker.txt"), "shared\n", "utf8");
  await symlink(
    sharedDependencies,
    path.join(project, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await initializeProject(project);
  const config = await loadConfig(project);
  config.architect = "claude";
  config.reviewer = "gemini";
  config.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.providers[provider].command = command;
    config.providers[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(ringerDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const ledger = new Ledger(path.join(ringerDirectory(project), "ringer.db"));
  let runId = "";
  try {
    const orchestrator = new Orchestrator(ledger);
    runId = await orchestrator.run({ goal: "Create the fixture result", projectPath: project, agents: 37 });
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "ready", JSON.stringify(run, null, 2));
    assert.equal(run?.tasks[0]?.status, "passed");
    assert.equal(run?.tasks[0]?.checks[0]?.passed, true);
    assert.equal(run?.tasks.find((task) => task.id === "__integration__")?.status, "passed");
    assert.match(run?.finalReview ?? "", /^READY/);
    assert.ok(run?.events.some((event) => event.message === "Scheduler using concurrency 37"));
    const shown = await git(project, ["show", `ringer/${runId.slice(0, 8)}:result.txt`]);
    assert.equal(shown.stdout, "created by worker\n");
    assert.equal(
      await readFile(
        path.join(os.tmpdir(), "ringer", runId, "integration", "node_modules", "shared-marker.txt"),
        "utf8",
      ),
      "shared\n",
    );
  } finally {
    ledger.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "ringer", runId);
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "tasks", "one")], cwd: project, timeoutMs: 30_000 });
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "integration")], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard serves its UI and bootstrap data on localhost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-server-"));
  const project = await createRepository(root);
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Assemble a verified agent team/);
    const bootstrap = await fetch(`${dashboard.url}/api/bootstrap`);
    const value = (await bootstrap.json()) as {
      defaultProject: string;
      providers: Array<{ name: string; setupSteps: string[] }>;
    };
    assert.equal(value.defaultProject, project);
    assert.equal(value.providers.length, 3);
    assert.ok(value.providers.find((provider) => provider.name === "gemini")?.setupSteps.some((step) => step.includes("one-time code")));
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel during planning does not save a late plan or restart the run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-cancel-planning-"));
  const project = await createRepository(root);
  const command = await createSlowArchitectCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.architect = "claude";
  config.reviewer = "gemini";
  config.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.providers[provider].command = command;
    config.providers[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(ringerDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  let runId = "";
  try {
    const started = await fetch(`${dashboard.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Cancel while planning", projectPath: project, agents: 1 }),
    });
    assert.equal(started.status, 202);
    runId = ((await started.json()) as { runId: string }).runId;
    assert.ok(runId);

    const getRun = () => fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{
      status: string;
      finalReview: string | null;
      tasks: Array<{ id: string; status: string }>;
      events: Array<{ kind: string }>;
    }>);

    await poll(getRun, (run) => run.events.some((event) => event.kind === "architect.started"), 20_000);
    const cancelled = await fetch(`${dashboard.url}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { status: "cancelled" });

    await delay(1_500);
    const run = await getRun();
    assert.equal(run.status, "cancelled", JSON.stringify(run, null, 2));
    assert.deepEqual(run.tasks, []);
    assert.equal(run.finalReview, null);
    const afterCancelEvents = ["plan.created", "scheduler.started", "review.started", "run.ready", "run.not_ready"];
    assert.ok(!run.events.some((event) => afterCancelEvents.includes(event.kind)), JSON.stringify(run.events));
  } finally {
    await dashboard.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "ringer", runId);
      for (const worktree of [path.join(runRoot, "integration")]) {
        for (let attempt = 0; attempt < 60; attempt++) {
          const result = await runProcess({ command: "git", args: ["worktree", "remove", "--force", worktree], cwd: project, timeoutMs: 30_000 });
          if (result.exitCode === 0) break;
          await delay(250);
        }
      }
      await rm(runRoot, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  }
});

test("cancel stops the scheduler and marks the run and in-flight task cancelled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-cancel-"));
  const project = await createRepository(root);
  const command = await createHangingCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.architect = "claude";
  config.reviewer = "gemini";
  config.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.providers[provider].command = command;
    config.providers[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(ringerDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  let runId = "";
  try {
    // Start the run through the real endpoint (non-blocking, returns 202 + runId).
    const started = await fetch(`${dashboard.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Create the fixture result", projectPath: project, agents: 1 }),
    });
    assert.equal(started.status, 202);
    runId = ((await started.json()) as { runId: string }).runId;
    assert.ok(runId);

    const getRun = () => fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{
      status: string;
      finalReview: string | null;
      tasks: Array<{ id: string; status: string }>;
      events: Array<{ kind: string }>;
    }>);

    // Wait until the worker is genuinely in-flight (its CLI is hanging).
    await poll(getRun, (run) => run.tasks.some((task) => task.id === "one" && task.status === "working"), 20_000);

    // Trigger cancellation via the real endpoint; it must abort the scheduler,
    // terminate the active provider process, and transition the ledger.
    const cancelled = await fetch(`${dashboard.url}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { status: "cancelled" });

    // Give the aborted background run a moment to unwind, then confirm the
    // reviewer/integration phase never ran and never overwrote the cancelled state.
    await delay(300);
    const run = await getRun();
    assert.equal(run.status, "cancelled", JSON.stringify(run, null, 2));
    assert.equal(run.tasks.find((task) => task.id === "one")?.status, "cancelled");
    assert.ok(run.events.some((event) => event.kind === "run.cancelled"));
    assert.equal(run.tasks.some((task) => task.id === "__integration__"), false);
    assert.equal(run.finalReview, null);
    const overwrote = ["review.started", "run.ready", "run.not_ready", "integration.passed", "integration.failed"];
    assert.ok(!run.events.some((event) => overwrote.includes(event.kind)), JSON.stringify(run.events));
  } finally {
    await dashboard.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "ringer", runId);
      // The killed worker may briefly orphan a grandchild holding the worktree
      // cwd on Windows; retry until it exits so no worktrees or temp dirs leak.
      for (const worktree of [path.join(runRoot, "tasks", "one"), path.join(runRoot, "integration")]) {
        for (let attempt = 0; attempt < 60; attempt++) {
          const result = await runProcess({ command: "git", args: ["worktree", "remove", "--force", worktree], cwd: project, timeoutMs: 30_000 });
          if (result.exitCode === 0) break;
          await delay(250);
        }
      }
      await rm(runRoot, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  }
});

async function createPlanningHangingCli(root: string, startedFile: string, completedFile: string): Promise<string> {
  const script = path.join(root, "planning-hanging-cli.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
input += " " + process.argv.slice(2).join(" ");
if (process.argv.includes("--version")) {
  console.log("fake 1.0");
} else if (process.argv[2] === "models" || process.argv[2] === "login" || process.argv[2] === "auth") {
  console.log("Authenticated fixture");
} else if (input.includes("You are the architect")) {
  writeFileSync(${JSON.stringify(startedFile)}, "started\\n", "utf8");
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      process.kill(process.ppid, 0);
    } catch {
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  writeFileSync(${JSON.stringify(completedFile)}, "completed\\n", "utf8");
  const plan = {summary:"fixture plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  console.log("READY\\n\\nFixture integration is valid.");
} else {
  writeFileSync("result.txt", "created by worker\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Created result.txt"}}));
}
`,
    "utf8",
  );

  if (process.platform === "win32") {
    const wrapper = path.join(root, "planning-hanging-cli.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(root, "planning-hanging-cli.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function createValidatorTestCli(root: string): Promise<string> {
  const script = path.join(root, "validator-test-cli.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
input += " " + process.argv.slice(2).join(" ");
if (process.argv.includes("--version")) {
  console.log("fake 1.0");
} else if (process.argv[2] === "models" || process.argv[2] === "login" || process.argv[2] === "auth") {
  console.log("Authenticated fixture");
} else if (input.includes("You are the architect")) {
  const plan = {summary:"validator plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["slow-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  console.log("READY\\n\\nFixture integration is valid.");
} else {
  writeFileSync("result.txt", "created by worker\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Created result.txt"}}));
}
`,
    "utf8",
  );

  if (process.platform === "win32") {
    const wrapper = path.join(root, "validator-test-cli.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(root, "validator-test-cli.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function createSlowCheckScript(root: string): Promise<string> {
  const script = path.join(root, "slow-check.mjs");
  await writeFile(
    script,
    `const until = Date.now() + 3500;
while (Date.now() < until) {
  try {
    process.kill(process.ppid, 0);
  } catch {
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
process.exit(0);
`,
    "utf8",
  );

  if (process.platform === "win32") {
    const wrapper = path.join(root, "slow-check.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(root, "slow-check.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
}

test("cancel during planning terminates the architect child process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-cancel-planning-a-"));
  const project = await createRepository(root);
  const startedFile = path.join(root, "started.marker");
  const completedFile = path.join(root, "completed.marker");
  const command = await createPlanningHangingCli(root, startedFile, completedFile);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.architect = "claude";
  config.reviewer = "gemini";
  config.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.providers[provider].command = command;
    config.providers[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(ringerDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  let runId = "";
  try {
    const started = await fetch(`${dashboard.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Cancel during planning", projectPath: project, agents: 1 }),
    });
    assert.equal(started.status, 202);
    runId = ((await started.json()) as { runId: string }).runId;
    assert.ok(runId);

    const getRun = () => fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{
      status: string;
      finalReview: string | null;
      tasks: Array<{ id: string; status: string }>;
      events: Array<{ kind: string }>;
    }>);

    await poll(getRun, (run) => run.events.some((event) => event.kind === "architect.started") || run.status === "planning", 20_000);

    const cancelled = await fetch(`${dashboard.url}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { status: "cancelled" });

    await delay(1000);
    const run = await getRun();
    assert.equal(run.status, "cancelled");

    const forbiddenEvents = ["plan.created", "scheduler.started", "task.started", "review.started"];
    assert.ok(!run.events.some((event) => forbiddenEvents.includes(event.kind)), `Found forbidden event: ${JSON.stringify(run.events)}`);
    assert.ok(!run.tasks.some((task) => task.id !== "__integration__"));
    assert.equal(run.finalReview, null);

    let completedExists = false;
    try {
      await readFile(completedFile);
      completedExists = true;
    } catch {
      completedExists = false;
    }
    assert.equal(completedExists, false, "Architect 'completed' marker file should not exist");
  } finally {
    await dashboard.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "ringer", runId);
      for (const worktree of [path.join(runRoot, "integration")]) {
        for (let attempt = 0; attempt < 60; attempt++) {
          const result = await runProcess({ command: "git", args: ["worktree", "remove", "--force", worktree], cwd: project, timeoutMs: 30_000 });
          if (result.exitCode === 0) break;
          await delay(250);
        }
      }
      await rm(runRoot, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  }
});

test("cancel during validator verification marks task cancelled and avoids merge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ringer-cancel-validator-b-"));
  const project = await createRepository(root);
  const command = await createValidatorTestCli(root);
  const slowCheckCommand = await createSlowCheckScript(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.architect = "claude";
  config.reviewer = "gemini";
  config.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.providers[provider].command = command;
    config.providers[provider].timeoutMs = 30_000;
  }
  config.validators["slow-check"] = {
    command: slowCheckCommand,
    args: [],
    timeoutMs: 30_000,
  };
  await writeFile(
    path.join(ringerDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  let runId = "";
  try {
    const started = await fetch(`${dashboard.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Cancel during validator", projectPath: project, agents: 1 }),
    });
    assert.equal(started.status, 202);
    runId = ((await started.json()) as { runId: string }).runId;
    assert.ok(runId);

    const getRun = () => fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{
      status: string;
      finalReview: string | null;
      tasks: Array<{ id: string; status: string }>;
      events: Array<{ kind: string }>;
    }>);

    await poll(getRun, (run) => run.tasks.some((task) => task.id === "one" && task.status === "verifying"), 20_000);

    const cancelled = await fetch(`${dashboard.url}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { status: "cancelled" });

    await delay(4500);
    const run = await getRun();
    assert.equal(run.status, "cancelled");

    const taskOne = run.tasks.find((task) => task.id === "one");
    assert.ok(taskOne, "Task 'one' should exist");
    assert.equal(taskOne.status, "cancelled");

    assert.ok(!run.events.some((event) => event.kind === "task.passed"));
    assert.ok(!run.tasks.some((task) => task.id === "__integration__"));

    const forbiddenEvents = ["review.started", "run.ready", "run.not_ready"];
    assert.ok(!run.events.some((event) => forbiddenEvents.includes(event.kind)));

    const shown = await runProcess({
      command: "git",
      args: ["show", `ringer/${runId.slice(0, 8)}:result.txt`],
      cwd: project,
      timeoutMs: 30_000,
    });
    assert.notEqual(shown.exitCode, 0, `result.txt should not be present on integration branch`);
  } finally {
    await dashboard.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "ringer", runId);
      for (const worktree of [path.join(runRoot, "tasks", "one"), path.join(runRoot, "integration")]) {
        for (let attempt = 0; attempt < 60; attempt++) {
          const result = await runProcess({ command: "git", args: ["worktree", "remove", "--force", worktree], cwd: project, timeoutMs: 30_000 });
          if (result.exitCode === 0) break;
          await delay(250);
        }
      }
      await rm(runRoot, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  }
});
