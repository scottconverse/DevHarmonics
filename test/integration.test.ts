import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, loadConfig, ringerDirectory } from "../src/config.js";
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

async function createFakeCli(root: string): Promise<string> {
  const script = path.join(root, "fake-cli.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
input += " " + process.argv.slice(2).join(" ");
if (process.argv.includes("--version")) {
  console.log("fake 1.0");
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
