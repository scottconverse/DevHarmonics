import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { initializeProject, loadConfig, devHarmonicsDirectory } from "../src/config.js";
import { inspectProviders } from "../src/doctor.js";
import { Ledger } from "../src/ledger.js";
import { Orchestrator, repositoryTaskIds } from "../src/orchestrator.js";
import { syncOllamaRuntimes } from "../src/ollama.js";
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
    "user.name=DevHarmonics Tests",
    "-c",
    "user.email=devharmonics-tests@local",
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
    `import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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
} else if (input.includes("DevHarmonics non-destructive") || input.includes("DevHarmonics deterministic baseline")) {
  const marker = input.includes("deterministic baseline") ? "DEVHARMONICS_BENCHMARK_QUALIFIED|17|BLUE" : (input.match(/DEVHARMONICS_[A-Z]+_QUALIFIED/) || ["DEVHARMONICS_GENERAL_QUALIFIED"])[0];
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:marker}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:marker}));
  else console.log(marker);
} else if (input.includes("You are the architect")) {
  const observe = input.includes("This is an OBSERVE run");
  const task = observe
    ? {id:"observe",title:"Audit fixture",description:"Report the README heading",dependencies:[],preferredProvider:"codex",checks:["diff-check"],kind:"diagnostic",repositoryScope:["README.md"],permission:"read_only",risk:"low",capabilityNeeds:["analysis"],acceptanceCriteria:["Cite the README heading"],expectedArtifacts:["evidence report"]}
    : input.includes("High-risk fixture")
      ? {id:"one",title:"Create critical result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"],kind:"implementation",repositoryScope:["result.txt"],permission:"workspace_write",risk:"high",capabilityNeeds:["implementation"],acceptanceCriteria:["Create result.txt"],expectedArtifacts:["result.txt"]}
      : input.includes("Fixer fixture")
        ? {id:"one",title:"Create repairable result",description:"Create needs-fix.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"],kind:"implementation",repositoryScope:["needs-fix.txt","result.txt"],permission:"workspace_write",risk:"medium",capabilityNeeds:["implementation"],acceptanceCriteria:["Create a reviewable result"],expectedArtifacts:["result.txt"]}
      : input.includes("Shortcut fixture")
        ? {id:"one",title:"Add a shortcut test",description:"Add a skipped test",dependencies:[],preferredProvider:"codex",checks:["diff-check"],kind:"implementation",repositoryScope:["test/shortcut.test.ts"],permission:"workspace_write",risk:"medium",capabilityNeeds:["implementation","testing"],acceptanceCriteria:["Add verification"],expectedArtifacts:["test/shortcut.test.ts"]}
      : input.includes("Local orchestrator fixture")
        ? {id:"one",title:"Create local result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"],kind:"implementation",repositoryScope:["result.txt"],permission:"workspace_write",risk:"medium",capabilityNeeds:["implementation"],acceptanceCriteria:["Create result.txt"],expectedArtifacts:["result.txt"]}
      : {id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"]};
  const plan = input.includes("Cross repository fixture")
    ? {
        summary:"cross-repository fixture plan",
        recommendedConcurrency:2,
        repositoryImpact:[
          {repositoryId:"repo:core",disposition:"affected",rationale:"The product implementation changes here."},
          {repositoryId:"repo:docs",disposition:"affected",rationale:"The user documentation must describe the change."}
        ],
        integrationConditions:["The documentation must describe the behavior implemented in the core repository."],
        tasks:[
          {id:"core",title:"Implement the product change",description:"Update the core repository",dependencies:[],preferredProvider:"codex",checks:input.includes("automatic fixer")?["diff-check","defect-free"]:["diff-check"],repositoryIds:["repo:core"]},
          {id:"docs",title:"Document the product change",description:"Update the documentation repository",dependencies:["core"],preferredProvider:"codex",checks:["diff-check"],repositoryIds:["repo:docs"]}
        ]
      }
    : {summary:"fixture plan",recommendedConcurrency:1,tasks:[task]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are reviewing bounded") || (args.includes("--new-project") && process.cwd().includes("integration"))) {
  const review = input.includes("repo:core/needs-fix.txt")
    ? "NOT READY\\n\\nA retained defect marker remains.\\n" + JSON.stringify({findings:[{id:"remove-core-defect-marker",severity:"high",location:"repo:core/needs-fix.txt:1",rationale:"The core repository still contains the defect marker.",suggestedCorrection:"Remove needs-fix.txt and create the corrected result.txt in repo:core.",disposition:"open"}]})
    : "READY\\n\\nThe supplied repository diff chunk matches the approved task scope.";
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:review}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:review}));
  else console.log(review);
} else if (input.includes("You are the final reviewer")) {
  const review = input.includes("Audit fixture") && !input.includes("README.md:1 contains the heading Fixture")
    ? "NOT READY\\n\\nDiagnostic report was not supplied."
    : input.includes("Fixer fixture") && existsSync("needs-fix.txt")
      ? "NOT READY\\n\\nA retained defect marker remains.\\n" + JSON.stringify({findings:[{id:"remove-defect-marker",severity:"high",location:"needs-fix.txt:1",rationale:"The defect marker remains in the integration set.",suggestedCorrection:"Remove needs-fix.txt and create the corrected result.txt.",disposition:"open"}]})
      : "READY\\n\\nFixture integration is valid.";
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:review}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:review}));
  else console.log(review);
} else if (input.includes("diagnostic investigator")) {
  const report = input.includes("Fabricated fixture")
    ? "config.yaml:3 states the fixture version, user_manual.md:2 confirms it, and README.md:99 repeats the same value. These three sources agree with each other, and the read-only inspection found no contradictory statement anywhere else in the repository."
    : "README.md:1 contains the heading Fixture. This directly satisfies the assigned diagnostic criterion, and the read-only inspection identified no contradictory heading elsewhere. No files were changed.";
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:report}}));
} else if (input.includes("Correct only these retained review findings")) {
  if (existsSync("needs-fix.txt")) unlinkSync("needs-fix.txt");
  writeFileSync("result.txt", "corrected by independent fixer\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Removed needs-fix.txt and created corrected result.txt"}}));
} else if (input.includes("Fixer fixture")) {
  writeFileSync("needs-fix.txt", "defect marker\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Created needs-fix.txt for review"}}));
} else if (input.includes("Cross repository fixture with automatic fixer") && input.includes("Implement the product change")) {
  writeFileSync("needs-fix.txt", "cross-repository defect marker\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Created the repository-scoped defect marker for review"}}));
} else if (input.includes("Shortcut fixture")) {
  mkdirSync("test", {recursive:true});
  writeFileSync("test/shortcut.test.ts", "test.skip('important behavior', () => {});\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Added shortcut test"}}));
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

async function startFakeOllama(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const beforeHash = createHash("sha256").update("DEVHARMONICS_LOCAL_TOOL_BEFORE\n").digest("hex");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/version") {
      response.end(JSON.stringify({ version: "fixture-1.0" }));
      return;
    }
    if (url.pathname === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "fixture-writer:14b", model: "fixture-writer:14b", size: 1_000, digest: "fixture" }] }));
      return;
    }
    if (url.pathname === "/api/show") {
      response.end(JSON.stringify({ capabilities: ["completion"], details: { parameter_size: "14B", family: "fixture" } }));
      return;
    }
    if (url.pathname === "/api/chat") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.[0]?.content ?? "";
      const toolResultCount = (prompt.match(/TOOL RESULTS FOR STEP/g) ?? []).length;
      let content: string;
      if (prompt.includes("bounded local-tool qualification")) {
        content = toolResultCount === 0
          ? JSON.stringify({ toolRequests: [{ id: "qualification-read", toolId: "file.read", arguments: { path: "fixture.txt" } }] })
          : toolResultCount === 1
            ? JSON.stringify({ toolRequests: [{ id: "qualification-patch", toolId: "file.patch", arguments: { path: "fixture.txt", expectedSha256: beforeHash, content: "DEVHARMONICS_LOCAL_TOOL_AFTER\n" } }] })
            : JSON.stringify({ final: "Bounded qualification completed." });
      } else {
        content = toolResultCount === 0
          ? JSON.stringify({ toolRequests: [{ id: "result-patch", toolId: "file.patch", arguments: { path: "result.txt", expectedSha256: null, content: "created by bounded local tools\n" } }] })
          : JSON.stringify({ final: "Created result.txt through the approved file.patch tool." });
      }
      response.end(JSON.stringify({ message: { content }, prompt_eval_count: 20, eval_count: 10 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake Ollama did not bind a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
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
} else if (input.includes("DevHarmonics non-destructive") || input.includes("DevHarmonics deterministic baseline")) {
  const marker = input.includes("deterministic baseline") ? "DEVHARMONICS_BENCHMARK_QUALIFIED|17|BLUE" : (input.match(/DEVHARMONICS_[A-Z]+_QUALIFIED/) || ["DEVHARMONICS_GENERAL_QUALIFIED"])[0];
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:marker}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:marker}));
  else console.log(marker);
} else if (input.includes("You are the architect")) {
  await delay(1_000);
  const plan = {summary:"late plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  const review = "READY\\n\\nShould not review after cancellation.";
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:review}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:review}));
  else console.log(review);
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
} else if (input.includes("DevHarmonics non-destructive") || input.includes("DevHarmonics deterministic baseline")) {
  const marker = input.includes("deterministic baseline") ? "DEVHARMONICS_BENCHMARK_QUALIFIED|17|BLUE" : (input.match(/DEVHARMONICS_[A-Z]+_QUALIFIED/) || ["DEVHARMONICS_GENERAL_QUALIFIED"])[0];
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:marker}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:marker}));
  else console.log(marker);
} else if (input.includes("You are the architect")) {
  const plan = {summary:"cancel plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["diff-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  const review = "READY\\n\\nFixture integration is valid.";
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:review}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:review}));
  else console.log(review);
} else {
  // Worker prompt: hang until the orchestrator kills us on cancel or interrupt.
  // The bound must OUTLIVE the assertion window of every test that interrupts
  // this invocation, or a natural exit can supply the handoff the test means to
  // attribute to the interrupt — an audit flagged exactly that, with the bound
  // at 4s and a comment claiming 10s. It stays bounded so a killed-but-orphaned
  // grandchild (the Windows .cmd wrapper spawns node, and killing cmd.exe does
  // not reap it) still self-exits and releases the worktree for cleanup.
  const until = Date.now() + 45_000;
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
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-auth-gate-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root, false);
  await initializeProject(project);
  const config = await loadConfig(project);
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
  }
  await writeFile(
    path.join(devHarmonicsDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const statuses = await inspectProviders(config, project);
  assert.ok(statuses.every((provider) => provider.installed));
  assert.ok(statuses.every((provider) => !provider.authenticated));
  assert.ok(statuses.every((provider) => provider.authStatus.includes("Sign-in required")));
  assert.ok(statuses.every((provider) => !provider.visible));
  assert.ok(statuses.every((provider) => !provider.healthy));
  assert.ok(statuses.every((provider) => !provider.available));
  assert.ok(statuses.every((provider) => provider.entitlement === "unknown"));
  assert.ok(statuses.every((provider) => provider.capacity === "unknown"));
  assert.ok(statuses.every((provider) =>
    provider.diagnostics.find((diagnostic) => diagnostic.layer === "authentication")?.state === "fail"
  ));
  assert.ok(statuses.every((provider) =>
    provider.diagnostics.find((diagnostic) => diagnostic.layer === "capacity")?.state === "unknown"
  ));

  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
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
    assert.match(run?.finalReview ?? "", /codex: Sign-in required; run 'codex login'/);
    assert.equal(run?.events.some((event) => event.kind === "worktree.created"), false);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator completes a verified run through fake subscription CLIs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-e2e-"));
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
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
    config.connections[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(devHarmonicsDirectory(project), "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
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
    assert.equal(run?.delivery?.repositories.length, 1);
    assert.equal(run?.delivery?.repositories[0]?.baseBranch, "main");
    assert.equal(run?.delivery?.repositories[0]?.branch, `devharmonics/${runId.slice(0, 8)}`);
    assert.notEqual(run?.delivery?.repositories[0]?.headCommit, run?.delivery?.repositories[0]?.baseCommit);
    const reviews = ledger.listReviewReceipts(runId);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.verdict, "READY");
    assert.notEqual(reviews[0]!.provider, "codex", "the reviewer should be independent from the implementor when another provider is available");
    assert.equal(reviews[0]!.integrationSha256.length, 64);
    assert.equal(reviews[0]!.invalidatedAt, null);
    assert.ok(run?.events.some((event) => event.message === "Scheduler using concurrency 37"));
    const toolReceipts = ledger.listToolPolicyReceipts(runId);
    assert.deepEqual(
      toolReceipts.map((receipt) => `${receipt.toolId}:${receipt.outcome}`),
      ["validator:diff-check:allow", "git.commit:allow", "git.merge:allow", "validator:diff-check:allow"],
    );
    assert.ok(toolReceipts.every((receipt) => receipt.actorRole === "coordinator"));
    assert.ok(toolReceipts.every((receipt) => receipt.lockKeys.length === 1));
    assert.ok(toolReceipts.filter((receipt) => receipt.toolId.startsWith("git.")).every((receipt) => receipt.attemptId !== null));
    const receiptDatabase = new DatabaseSync(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
    try {
      const attempt = receiptDatabase
        .prepare(
          `SELECT connection_id, model_id, model_resolution, adapter_version, runtime_version,
                  model_settings_json, failure_kind
           FROM attempts WHERE run_id = ? AND task_id = 'one' ORDER BY id LIMIT 1`,
        )
        .get(runId) as Record<string, unknown>;
      assert.deepEqual({ ...attempt }, {
        connection_id: "subscription-cli:codex",
        model_id: "subscription-cli:codex:model:gpt-5-6-terra",
        model_resolution: "concrete",
        adapter_version: "0.5.1",
        runtime_version: "fake 1.0",
        model_settings_json: '{"effort":"medium"}',
        failure_kind: null,
      });
    } finally {
      receiptDatabase.close();
    }
    const shown = await git(project, ["show", `devharmonics/${runId.slice(0, 8)}:result.txt`]);
    assert.equal(shown.stdout, "created by worker\n");
    assert.equal(
      await readFile(
        path.join(os.tmpdir(), "devharmonics", runId, "integration", "node_modules", "shared-marker.txt"),
        "utf8",
      ),
      "shared\n",
    );
  } finally {
    ledger.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "tasks", "one")], cwd: project, timeoutMs: 30_000 });
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "integration")], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("high-risk orchestration requires two independent provider reviews", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-review-quorum-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.routing.reviewer.preferredTier = "standard";
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
    config.connections[provider].timeoutMs = 30_000;
  }
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  try {
    const runId = await new Orchestrator(ledger).run({ goal: "High-risk fixture", projectPath: project, agents: 1 });
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "ready", run?.finalReview ?? "missing final review");
    const reviews = ledger.listReviewReceipts(runId);
    assert.equal(reviews.length, 2);
    assert.equal(new Set(reviews.map((review) => review.provider)).size, 2);
    assert.ok(reviews.every((review) => review.provider !== "codex"), "both reviewers must be independent from the implementor provider");
    assert.ok(reviews.every((review) => review.verdict === "READY"));
    assert.ok(run?.events.some((event) => event.kind === "review.quorum_passed"));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("review fixer changes evidence, invalidates the rejected receipt, and requires re-review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-review-fixer-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
    config.connections[provider].timeoutMs = 30_000;
  }
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  try {
    const runId = await new Orchestrator(ledger).run({ goal: "Fixer fixture", projectPath: project, agents: 1 });
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "ready", run?.finalReview ?? "missing final review");
    const reviews = ledger.listReviewReceipts(runId);
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0]!.verdict, "NOT_READY");
    assert.ok(reviews[0]!.invalidatedAt, "the rejected review must remain retained but invalidated");
    assert.equal(reviews[1]!.verdict, "READY");
    assert.equal(reviews[1]!.invalidatedAt, null);
    assert.notEqual(reviews[0]!.integrationSha256, reviews[1]!.integrationSha256);
    assert.equal(run?.tasks.find((task) => task.id === "__review_fix_1")?.status, "passed");
    assert.ok(run?.events.some((event) => event.kind === "review.invalidated"));
    assert.ok(run?.events.some((event) => event.kind === "fixer.completed"));
    assert.ok(run?.events.some((event) => event.kind === "review.quorum_passed"));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("green validators cannot hide a verification-integrity shortcut", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-integrity-shortcut-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  try {
    const runId = await new Orchestrator(ledger).run({ goal: "Shortcut fixture", projectPath: project, agents: 1 });
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "not_ready");
    const integration = run?.tasks.find((task) => task.id === "__integration__");
    assert.equal(integration?.checks.find((check) => check.name === "diff-check")?.passed, true);
    const integrity = integration?.checks.find((check) => check.name === "verification-integrity");
    assert.equal(integrity?.passed, false);
    assert.match(integrity?.stdout ?? "", /test-skipped/);
    assert.match(run?.finalReview ?? "", /^READY/, "the reviewer may pass while the independent integrity gate still blocks readiness");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("qualified Ollama implementor completes a bounded receipted local-tool change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-tool-orchestration-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  const ollama = await startFakeOllama();
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.localRuntimes.ollama = [{ id: "system", displayName: "Fixture Ollama", baseUrl: ollama.baseUrl, enabled: true }];
  config.routing.worker.modelId = "ollama:fixture-writer:14b";
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  let runId = "";
  try {
    runId = await new Orchestrator(ledger).run({ goal: "Local orchestrator fixture", projectPath: project, agents: 1 });
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "ready", run?.finalReview ?? "missing final review");
    assert.equal(run?.tasks.find((task) => task.id === "one")?.provider, "ollama");
    const localQualifications = ledger.listModelQualifications("ollama:fixture-writer:14b");
    assert.ok(localQualifications.some((qualification) => qualification.role === "local_tools" && qualification.passed));
    const receipts = ledger.listToolPolicyReceipts(runId);
    assert.ok(receipts.some((receipt) => receipt.toolId === "file.patch" && receipt.actorRole === "worker" && receipt.outcome === "allow"));
    assert.ok(receipts.some((receipt) => receipt.toolId === "git.commit" && receipt.outcome === "allow"));
    const integrationRoot = path.join(os.tmpdir(), "devharmonics", runId, "integration");
    assert.equal((await readFile(path.join(integrationRoot, "result.txt"), "utf8")).replace(/\r\n/g, "\n"), "created by bounded local tools\n");
  } finally {
    ledger.close();
    await ollama.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "tasks", "one")], cwd: project, timeoutMs: 30_000 });
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "integration")], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("observe run completes from diagnostic reports without repository changes or integration task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-observe-e2e-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.runPolicy.requirePlanApproval = false;
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  let runId = "";
  try {
    const orchestrator = new Orchestrator(ledger);
    runId = await orchestrator.run({ goal: "Audit fixture without changing it", projectPath: project, autonomy: "observe", agents: 1 });
    const run = ledger.getRun(runId);
    assert.equal(run?.status, "ready", JSON.stringify(run, null, 2));
    assert.equal(run?.autonomy, "observe");
    assert.deepEqual(run?.tasks.map((task) => task.id), ["observe"]);
    assert.equal(run?.tasks[0]?.kind, "diagnostic");
    assert.equal(run?.tasks[0]?.permission, "read_only");
    assert.equal(run?.tasks[0]?.risk, "low");
    assert.match(run?.finalReview ?? "", /^READY/);
    const evidence = ledger.getRunEvidence(runId);
    assert.ok(evidence?.blackboard.some((entry) => entry.kind === "finding" && entry.content.includes("README.md:1 contains the heading Fixture")));
    assert.equal((await git(project, ["status", "--porcelain"])).stdout, "");
    assert.equal((await git(project, ["diff", `main...devharmonics/${runId.slice(0, 8)}`])).stdout, "");
  } finally {
    ledger.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "tasks", "observe")], cwd: project, timeoutMs: 30_000 });
      await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(runRoot, "integration")], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard serves its UI and bootstrap data on localhost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-server-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const seedLedger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  const serverSecret = "sk-proj-serversecret123456789";
  const runId = seedLedger.createRun(`Replay through the API ${serverSecret}`, project);
  const longGoal = `Long objective ${"x".repeat(500)}`;
  const longRunId = seedLedger.createRun(longGoal, project);
  const firstCursor = seedLedger.listEvents(runId)[0]!.cursor;
  seedLedger.addEvent(runId, "scheduler.started", "Scheduler using concurrency 3", {
    concurrency: 3,
  });
  seedLedger.close();
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Assemble a verified agent team/);
    assert.match(pageText, /aria-label="Agent count"/);
    assert.match(pageText, /id="run-autonomy"/);
    assert.match(pageText, /id="delivery-panel"/);
    const appText = await fetch(`${dashboard.url}/app.js`).then((response) => response.text());
    assert.match(appText, /create_draft_pr/);
    assert.match(appText, /Approve &amp; push branch/);
    assert.match(appText, /Approve &amp; create draft PR/);
    assert.doesNotMatch(appText, /data-delivery-action=["']merge|action:\s*["']merge/i, "the delivery UI must expose no merge action");
    const bootstrap = await fetch(`${dashboard.url}/api/bootstrap`);
    const value = (await bootstrap.json()) as {
      product: { name: string; version: string };
      defaultProject: string;
      providers: Array<{ name: string; setupSteps: string[] }>;
    };
    assert.deepEqual(value.product, { name: "DevHarmonics", version: "0.5.1" });
    assert.equal(value.defaultProject, project);
    assert.equal(value.providers.length, 3);
    assert.ok(value.providers.find((provider) => provider.name === "gemini")?.setupSteps.some((step) => step.includes("one-time code")));
    const configResponse = await fetch(`${dashboard.url}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(await loadConfig(project)),
        product: { architect: "codex", reviewer: "claude", workers: ["codex", "gemini"] },
      }),
    });
    assert.equal(configResponse.status, 200);
    assert.equal((await loadConfig(project)).product.reviewer, "claude");
    const invalidConfigResponse = await fetch(`${dashboard.url}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    });
    assert.equal(invalidConfigResponse.status, 500);
    assert.match(await invalidConfigResponse.text(), /application/);
    const connectionsResponse = await fetch(`${dashboard.url}/api/connections`);
    const connectionsValue = (await connectionsResponse.json()) as {
      connections: Array<{ id: string; entitlement: string; capacity: string }>;
    };
    assert.equal(connectionsValue.connections.length, 5);
    assert.ok(connectionsValue.connections.some((connection) => connection.id === "subscription-cli:codex"));
    assert.ok(connectionsValue.connections.some((connection) => connection.id === "local:ollama"));
    assert.ok(connectionsValue.connections.some((connection) => connection.id === "api:openrouter"));
    assert.ok(connectionsValue.connections.filter((connection) => connection.id.startsWith("subscription-cli:" )).every((connection) => connection.entitlement === "unknown"));
    assert.ok(connectionsValue.connections.filter((connection) => connection.id.startsWith("subscription-cli:" )).every((connection) => connection.capacity === "unknown"));
    assert.equal(connectionsValue.connections.find((connection) => connection.id === "local:ollama")?.entitlement, "local");

    const modelSecret = "sk-proj-modelapisecret123456789";
    const createdModelResponse = await fetch(`${dashboard.url}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "manual:codex:test-model",
        connectionId: "subscription-cli:codex",
        canonicalName: "test-model",
        displayName: "Test Model",
        lifecycle: "known",
        metadata: { api_key: modelSecret },
      }),
    });
    assert.equal(createdModelResponse.status, 201);
    const createdModelText = await createdModelResponse.text();
    assert.equal(createdModelText.includes(modelSecret), false);
    assert.match(createdModelText, /\[REDACTED\]/);
    const modelsResponse = await fetch(
      `${dashboard.url}/api/models?connectionId=${encodeURIComponent("subscription-cli:codex")}`,
    );
    const modelsValue = (await modelsResponse.json()) as { models: Array<{ id: string }> };
    const modelIds = modelsValue.models.map((model) => model.id);
    assert.ok(modelIds.includes("manual:codex:test-model"));
    assert.ok(modelIds.includes("subscription-cli:codex:model:gpt-5-6-luna"));
    assert.ok(modelIds.includes("subscription-cli:codex:model:gpt-5-6-sol"));
    assert.ok(modelIds.includes("subscription-cli:codex:model:gpt-5-6-terra"));

    const performanceResponse = await fetch(`${dashboard.url}/api/model-performance`);
    assert.equal(performanceResponse.status, 200);
    const performanceValue = await performanceResponse.json() as { profiles: unknown[]; policies: unknown[] };
    assert.ok(Array.isArray(performanceValue.profiles));
    assert.ok(Array.isArray(performanceValue.policies));
    const performancePolicyResponse = await fetch(`${dashboard.url}/api/model-performance/${encodeURIComponent("manual:codex:test-model")}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ excluded: true }),
    });
    assert.equal(performancePolicyResponse.status, 200);

    const invalidModelResponse = await fetch(`${dashboard.url}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "manual:invalid",
        connectionId: "subscription-cli:codex",
        canonicalName: "invalid",
        displayName: "Invalid",
        lifecycle: "active",
        active: true,
      }),
    });
    assert.equal(invalidModelResponse.status, 400);
    const malformedProductResponse = await fetch(`${dashboard.url}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformedProductResponse.status, 400);
    assert.deepEqual(await malformedProductResponse.json(), { error: "Request body must contain valid JSON" });
    const runsResponse = await fetch(`${dashboard.url}/api/runs`);
    const runsText = await runsResponse.text();
    assert.equal(runsText.includes(serverSecret), false);
    assert.match(runsText, /\[REDACTED\]/);
    const runsValue = JSON.parse(runsText) as { runs: Array<{ id: string; goal: string; goalSummary?: string }> };
    const longRun = runsValue.runs.find((run) => run.id === longRunId);
    assert.equal(longRun?.goal, longGoal);
    assert.ok(longRun?.goalSummary);
    assert.ok(longRun.goalSummary.length <= 180, longRun.goalSummary);
    assert.match(longRun.goalSummary, /…$/);
    const reportResponse = await fetch(`${dashboard.url}/api/runs/${runId}/report`);
    assert.equal(reportResponse.status, 200);
    const reportValue = await reportResponse.json() as { runId: string; verdict: string; evidenceHash: string };
    assert.equal(reportValue.runId, runId);
    assert.equal(reportValue.verdict, "INCONCLUSIVE");
    assert.equal(reportValue.evidenceHash.length, 64);
    const exportResponse = await fetch(`${dashboard.url}/api/runs/${runId}/evidence/export`);
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-disposition") ?? "", new RegExp(`attachment; filename="devharmonics-${runId}-evidence\\.json"`));
    const exportValue = await exportResponse.json() as { version: number; evidenceVersion: number; integritySha256: string; report: { runId: string } };
    assert.equal(exportValue.version, 1);
    assert.equal(exportValue.evidenceVersion, 5);
    assert.equal(exportValue.integritySha256, reportValue.evidenceHash);
    assert.equal(exportValue.report.runId, runId);
    const reporterMutation = await fetch(`${dashboard.url}/api/runs/${runId}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(reporterMutation.status, 404, "the read-only reporter must expose no mutation route");
    const replay = await fetch(`${dashboard.url}/api/runs/${runId}/events?after=${firstCursor}&limit=1`);
    assert.equal(replay.status, 200);
    const replayValue = (await replay.json()) as {
      nextCursor: number;
      events: Array<{ cursor: number; kind: string; data: Record<string, unknown> }>;
    };
    assert.equal(replayValue.events.length, 1);
    assert.equal(replayValue.events[0]?.kind, "scheduler.started");
    assert.deepEqual(replayValue.events[0]?.data, { concurrency: 3 });
    assert.equal(replayValue.nextCursor, replayValue.events[0]?.cursor);

    const streamController = new AbortController();
    const stream = await fetch(`${dashboard.url}/api/events`, {
      headers: { "last-event-id": String(firstCursor) },
      signal: streamController.signal,
    });
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    for (let readCount = 0; readCount < 5 && !streamText.includes("scheduler.started"); readCount++) {
      const chunk = await Promise.race([
        reader.read(),
        delay(2_000).then(() => { throw new Error("timed out waiting for SSE replay"); }),
      ]);
      if (chunk.done) break;
      streamText += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    streamController.abort();
    assert.match(streamText, new RegExp(`id: ${replayValue.nextCursor}`));
    assert.match(streamText, /event: run-event/);
    assert.match(streamText, /"kind":"scheduler.started"/);

    const indexResponse = await fetch(`${dashboard.url}/`);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /\/app\.css\?v=0\.5\.1/);
    assert.match(indexHtml, /\/app\.js\?v=0\.5\.1/);
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");
    assert.equal(indexResponse.headers.get("expires"), "0");

    const appScript = await fetch(`${dashboard.url}/app.js?v=0.5.1`).then((response) => response.text());
    assert.match(appScript, /new EventSource/);
    assert.doesNotMatch(appScript, /setInterval\(refreshRuns/);
    assert.match(appScript, /autonomy:\s*\$\("#run-autonomy"\)\.value/);
    assert.match(appScript, /window\.scrollTo\(\{\s*top:\s*0/);
    assert.match(appScript, /\/api\/runs\/\$\{runId\}\/report/);
    assert.match(appScript, /\/api\/runs\/\$\{runId\}\/evidence\/export/);
    assert.match(appScript, /data-qualify-benchmark/);
    assert.match(appScript, /model\.qualified\s*&&\s*!model\.qualificationStale\s*&&\s*!model\.excluded/);
    assert.match(appScript, /Specialist scheduling requires the benchmark pass/);
    assert.match(appScript, /function isModelSchedulable\(model\)/);
    assert.match(appScript, /function hasCurrentOperationalQualification\(model\)/);
    assert.match(appScript, /function hasCurrentQualificationForUiRole\(model, role\)/);
    assert.match(appScript, /hasCurrentQualificationForUiRole\(model, role\)/);
    assert.match(appScript, /not currently role-qualified/);
    assert.match(appScript, /isModelSchedulable\(qualifiedModel\)\s*\?\s*"It is active and schedulable\."/);
    assert.match(appScript, /Role-qualified models/);
    assert.match(appScript, /Qualified only for passing roles; failed roles remain unschedulable/);
    assert.match(appScript, /No current role qualification; not schedulable/);

    // DH-632 visible operation feedback: shared acknowledgement helper, honest busy
    // state, global activity surface, evidence-based elapsed/heartbeat, no fabricated progress.
    assert.match(appScript, /function withOperation\(/, "DH-632 requires the shared operation acknowledgement helper");
    assert.ok((appScript.match(/await withOperation\(/g) || []).length >= 15, "DH-632 requires the acknowledgement helper to wrap the dashboard actions, not exist as dead code");
    assert.match(appScript, /withOperation\(\$\("#refresh-provider-status"\)/, "the sign-in refresh must acknowledge through the shared helper");
    assert.match(appScript, /setAttribute\("aria-busy", "true"\)/, "DH-632 requires an accessible busy state on acknowledged controls");
    assert.match(appScript, /function renderActivityStrip\(/, "DH-632 requires the global activity surface");
    assert.match(appScript, /renderActivityStrip\(\);/, "the activity strip must be rendered by live code paths");
    assert.match(appScript, /function operationElapsed\(/, "DH-632 requires evidence-based elapsed time");
    assert.match(appScript, /\$\{quietMarkup\(lastActivityAt\)\}/, "the quiet heartbeat must be wired into rendered markup");
    assert.match(appScript, /quiet for/, "DH-632 requires heartbeat/stall wording for quiet long work");
    assert.match(appScript, /class="op-quiet-time" aria-hidden="true"/, "the ticking quiet duration must stay outside the accessibility tree");
    assert.doesNotMatch(appScript, /aria-valuenow|<progress|progress-bar/i, "DH-632 forbids fabricated progress bars until a real measure exists");
    assert.match(pageText, /id="activity-strip"/, "DH-632 requires the activity strip in the shell");
    assert.match(pageText, /aria-live="polite"[^>]*id="activity-strip"|id="activity-strip"[^>]*aria-live="polite"/, "the activity strip must be a polite live region");

    const appStyles = await fetch(`${dashboard.url}/app.css?v=0.5.1`).then((response) => response.text());
    assert.match(appStyles, /@media \(max-width:\s*1200px\)[\s\S]*?\.board\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(appStyles, /@media \(max-width:\s*950px\)[\s\S]*?\.run-list\s*\{[\s\S]*?display:\s*flex/);
    assert.match(appStyles, /\.app-shell\s*\{[^}]*overflow-x:\s*clip/);
    assert.match(appStyles, /\.run-list\s*\{[^}]*max-width:\s*100%/);
    assert.match(appStyles, /\.op-spinner/, "DH-632 requires the busy indicator style");
    assert.match(appStyles, /prefers-reduced-motion/, "DH-632 requires reduced-motion support");
  } finally {
    await dashboard.close();
    // ponytail: Windows releases the just-closed SQLite handle asynchronously; retry rmdir on EBUSY.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("objective preview creates no run and exact approved revision executes without replanning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-objective-preview-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.runPolicy.requirePlanApproval = true;
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  let runId = "";
  try {
    const created = await fetch(`${dashboard.url}/api/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "Local orchestrator fixture: create the exact approved result",
        acceptanceCriteria: ["Create result.txt"],
        constraints: ["Use the configured validator"],
        projectPath: project,
        repositoryIds: [],
        risk: "medium",
        autonomy: "supervised",
        priority: "normal",
        policyNotes: [],
      }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const objective = (await created.json()) as { objective: { id: string } };
    const before = await fetch(`${dashboard.url}/api/runs`).then((response) => response.json() as Promise<{ runs: unknown[] }>);
    assert.equal(before.runs.length, 0, "saving an objective draft must not create a run");

    const proposed = await fetch(`${dashboard.url}/api/objectives/${objective.objective.id}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledProviders: ["codex", "claude", "gemini"] }),
    });
    assert.equal(proposed.status, 201, await proposed.clone().text());
    const proposal = (await proposed.json()) as { revision: { revision: number; plan: { summary: string } }; preview: { assignments: unknown[] } };
    assert.equal(proposal.revision.revision, 1);
    assert.equal(proposal.revision.plan.summary, "fixture plan");
    assert.ok(proposal.preview.assignments.length > 0);
    const afterPreview = await fetch(`${dashboard.url}/api/runs`).then((response) => response.json() as Promise<{ runs: unknown[] }>);
    assert.equal(afterPreview.runs.length, 0, "plan preview must not create a run");

    const started = await fetch(`${dashboard.url}/api/objectives/${objective.objective.id}/plans/1/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: 1, enabledProviders: ["codex", "claude", "gemini"] }),
    });
    assert.equal(started.status, 202, await started.clone().text());
    runId = ((await started.json()) as { runId: string }).runId;
    const getRun = () => fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{
      status: string;
      objectiveId: string | null;
      approvedPlanRevision: number | null;
      plan: { summary: string } | null;
      events: Array<{ kind: string }>;
    }>);
    const run = await poll(getRun, (value) => ["ready", "not_ready", "failed"].includes(value.status), 30_000);
    assert.ok(["ready", "not_ready"].includes(run.status), JSON.stringify(run, null, 2));
    assert.equal(run.objectiveId, objective.objective.id);
    assert.equal(run.approvedPlanRevision, 1);
    assert.equal(run.plan?.summary, "fixture plan");
    assert.ok(run.events.some((event) => event.kind === "scheduler.started"), "approved plan must reach execution");
    assert.ok(!run.events.some((event) => event.kind === "architect.started"), "execution must not replan an approved revision");
  } finally {
    await dashboard.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      for (const worktree of [path.join(runRoot, "tasks", "one"), path.join(runRoot, "integration")]) {
        await runProcess({ command: "git", args: ["worktree", "remove", "--force", worktree], cwd: project, timeoutMs: 30_000 });
      }
      await rm(runRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a run whose subscription worker is exhausted falls back to a qualified local model", async () => {
  // The central claim of the local-fallback work, end to end. Every gate on the
  // path — objective planning, run start, and the attempt loop — used to refuse
  // on subscription health alone, before local execution was ever considered,
  // so fallback was reachable in routing and unreachable in practice. An audit
  // showed the production wiring could be removed with the suite still green.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-local-fallback-e2e-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  let localInvocations = 0;
  const ollama = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "local-analyst:7b" }] }));
    if (request.url === "/api/show") return response.end(JSON.stringify({ capabilities: ["completion"] }));
    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      localInvocations += 1;
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
      const prompt = parsed.messages?.[0]?.content ?? "";
      const text = prompt.includes("qualification fixture")
        ? "DEVHARMONICS_QUALIFIED"
        : "README.md:1 contains the heading Fixture. This directly satisfies the assigned diagnostic criterion, and the read-only inspection identified no contradictory heading elsewhere. No files were changed.";
      return response.end(JSON.stringify({ message: { role: "assistant", content: text }, done_reason: "stop", prompt_eval_count: 20, eval_count: 12 }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  const address = ollama.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.runPolicy.requirePlanApproval = false;
  config.localRuntimes.ollama = [{ id: "fixture", displayName: "Fixture runtime", baseUrl, enabled: true }];
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}
`, "utf8");

  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  let runId = "";
  try {
    // Register and qualify the local fleet the way a prior run would have, then
    // exhaust the only subscription worker. Nothing but the local model is left
    // that can carry a task.
    await syncOllamaRuntimes(ledger, config.localRuntimes.ollama);
    const localModel = ledger.listModels("local:ollama:fixture")[0];
    assert.ok(localModel, `the fixture runtime registered no model: ${JSON.stringify(ledger.listConnections().map((item) => item.id))}`);
    ledger.recordModelQualification({ modelId: localModel.id, fixtureVersion: "local-analysis-v1", role: "analysis", passed: true, score: 1, evidence: {}, fingerprint: localModel.qualificationFingerprint });
    ledger.setModelPreference(localModel.id, { active: true });
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    ledger.recordConnectionOutcome("subscription-cli:codex", { success: false, failureKind: "quota_exhausted", detail: "usage limit reached" });
    assert.equal(ledger.isConnectionEligible("subscription-cli:codex"), false, "the only subscription worker is cooling");

    // The subscription worker is not merely cooling — it is SIGNED OUT, which
    // run start used to refuse on outright, before asking whether anything could
    // actually run. An approved run needs no architect, so a qualified local
    // fleet must be able to carry it. Planning keeps that refusal deliberately;
    // starting an approved run does not.
    const signedOut = await createFakeCli(await mkdtemp(path.join(os.tmpdir(), "devharmonics-signed-out-")), false);
    const signedOutConfig = structuredClone(config);
    signedOutConfig.connections.codex.command = signedOut;
    await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(signedOutConfig, null, 2)}
`, "utf8");

    const before = localInvocations;
    runId = await new Orchestrator(ledger).run({ goal: "Audit fixture without changing it", projectPath: project, autonomy: "observe", agents: 1 });
    const run = ledger.getRun(runId);
    // The run must not be refused before it starts, and the task must not be
    // failed for lack of a subscription.
    assert.ok(localInvocations > before, "the local runtime carried the work");
    const task = run?.tasks.find((item) => item.id === "observe");
    assert.equal(task?.status, "passed", `the local model must be able to complete the task: ${JSON.stringify(run?.events?.map((event) => event.message))}`);
    assert.equal(run?.status, "ready", JSON.stringify(run?.finalReview));
  } finally {
    ledger.close();
    await new Promise<void>((resolve) => ollama.close(() => resolve()));
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      await runProcess({ command: "git", args: ["worktree", "prune"], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

test("one signed-out provider does not block planning that a healthy architect can do", async () => {
  // Planning genuinely needs a subscription architect, but it was refusing
  // whenever ANY enabled provider was signed out — so one unused signed-out
  // subscription blocked planning that a different, healthy architect could do.
  // The requirement is one healthy architect, not that everything is signed in.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-partial-signin-"));
  const project = await createRepository(root);
  const healthy = await createFakeCli(root);
  const signedOut = await createFakeCli(await mkdtemp(path.join(os.tmpdir(), "devharmonics-signedout-cli-")), false);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  // codex is a configured worker, but signed out. claude can architect and work.
  config.product.workers = ["claude", "codex"];
  config.connections.claude.command = healthy;
  config.connections.gemini.command = healthy;
  config.connections.codex.enabled = true;
  config.connections.codex.command = signedOut;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}
`, "utf8");

  // Precondition: the fixture really does present a signed-out provider.
  // Without this the test can pass for the wrong reason.
  const statuses = await inspectProviders(await loadConfig(project), project);
  assert.equal(statuses.find((provider) => provider.name === "codex")?.available, false, "codex must be signed out for this test to mean anything");

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const created = await fetch(`${dashboard.url}/api/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "Local orchestrator fixture: create the exact approved result",
        acceptanceCriteria: ["Create result.txt"],
        constraints: ["Use the configured validator"],
        projectPath: project,
        repositoryIds: [],
        risk: "medium",
        autonomy: "supervised",
        priority: "normal",
        policyNotes: [],
      }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const objective = (await created.json()) as { objective: { id: string } };

    // Planning must succeed on the healthy architect, with codex signed out.
    const proposed = await fetch(`${dashboard.url}/api/objectives/${objective.objective.id}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledProviders: ["codex", "claude", "gemini"] }),
    });
    const text = await proposed.clone().text();
    assert.doesNotMatch(text, /sign-in required/i, "planning must not refuse for a signed-out provider it does not need");
    assert.equal(proposed.status, 201, text);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

test("a task no model can route settles the task instead of crashing the run", async () => {
  // The pre-plan gate and the per-task question are different questions, and an
  // audit showed the suite could not tell whether the code still knew that.
  // Here they genuinely diverge: an analysis-qualified local model satisfies the
  // read-only worker-class probe at run start, but cannot take a workspace_write
  // task, which needs the local tool qualification. Routing therefore fails
  // INSIDE the attempt. It must settle that task honestly; it used to throw out
  // of executeTask and fail the whole run.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-route-settle-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  const ollama = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/version") return response.end(JSON.stringify({ version: "fixture-1" }));
    if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "local-analyst:7b" }] }));
    if (request.url === "/api/show") return response.end(JSON.stringify({ capabilities: ["completion"] }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  const address = ollama.address();
  assert.ok(address && typeof address === "object");

  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.runPolicy.requirePlanApproval = false;
  config.localRuntimes.ollama = [{ id: "fixture", displayName: "Fixture runtime", baseUrl: `http://127.0.0.1:${address.port}`, enabled: true }];
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}
`, "utf8");

  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  let runId = "";
  try {
    await syncOllamaRuntimes(ledger, config.localRuntimes.ollama);
    const localModel = ledger.listModels("local:ollama:fixture")[0];
    assert.ok(localModel);
    // Qualified for ANALYSIS only — read-only work, never writes.
    ledger.recordModelQualification({ modelId: localModel.id, fixtureVersion: "local-analysis-v1", role: "analysis", passed: true, score: 1, evidence: {}, fingerprint: localModel.qualificationFingerprint });
    ledger.setModelPreference(localModel.id, { active: true });
    ledger.upsertConnection({ id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription", displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
    ledger.recordConnectionOutcome("subscription-cli:codex", { success: false, failureKind: "quota_exhausted", detail: "usage limit reached" });

    // The run must START — the worker class exists — and then settle the task it
    // cannot route, rather than dying.
    runId = await new Orchestrator(ledger).run({ goal: "Local orchestrator fixture", projectPath: project, agents: 1 });
    const run = ledger.getRun(runId);
    const task = run?.tasks.find((item) => item.id === "one");
    assert.ok(["failed", "blocked"].includes(task?.status ?? ""), `the unroutable task settles honestly, got '${task?.status}'`);
    assert.ok(
      !(run?.events ?? []).some((event) => /Invalid task status transition/.test(event.message)),
      "settling must not go through an illegal transition",
    );
    assert.ok(
      (run?.events ?? []).some((event) => /No eligible model or provider default is available/.test(event.message)),
      `the run must record why nothing could take the task: ${JSON.stringify((run?.events ?? []).map((event) => event.message))}`,
    );
  } finally {
    ledger.close();
    await new Promise<void>((resolve) => ollama.close(() => resolve()));
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      await runProcess({ command: "git", args: ["worktree", "prune"], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

test("a diagnostic whose citations do not resolve is rejected by the run, not just by the checker", async () => {
  // The citation verifier had unit coverage, but nothing proved it was WIRED:
  // an audit showed the gate could be deleted from executeTask and the suite
  // would stay green. This is the end-to-end claim — a worker that invents
  // well-formed citations must not produce a ready run. The positive case is
  // the observe run above, whose report cites README.md:1 and passes.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-fabricated-citations-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.runPolicy.requirePlanApproval = false;
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}
`, "utf8");

  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  let runId = "";
  try {
    runId = await new Orchestrator(ledger).run({ goal: "Fabricated fixture audit", projectPath: project, autonomy: "observe", agents: 1 });
    const run = ledger.getRun(runId);
    assert.notEqual(run?.status, "ready", `a run built on citations that do not exist must not be ready: ${JSON.stringify(run?.tasks)}`);
    const task = run?.tasks.find((item) => item.id === "observe");
    assert.ok(["failed", "blocked"].includes(task?.status ?? ""), `the fabricating task must not pass, got '${task?.status}'`);
    const rejections = (run?.events ?? []).filter((event) => /cites evidence that does not exist/.test(event.message));
    assert.ok(rejections.length > 0, `the run must say the citations did not resolve: ${JSON.stringify((run?.events ?? []).map((event) => event.message))}`);
    // ...and it must name what was wrong, not merely that something was.
    assert.match(rejections[0]!.message, /config\.yaml:3|user_manual\.md:2|README\.md:99/);
    // The report never becomes a finding other agents can build on.
    const evidence = ledger.getRunEvidence(runId);
    assert.ok(
      !(evidence?.blackboard ?? []).some((entry) => entry.kind === "finding" && entry.content.includes("config.yaml")),
      "a rejected report must not be recorded as a finding",
    );
  } finally {
    ledger.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      await runProcess({ command: "git", args: ["worktree", "prune"], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

test("cross-repository objective planning maps impact without starting an unsupported multi-repository run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-cross-repository-plan-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const productResponse = await fetch(`${dashboard.url}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fixture-product",
        name: "Fixture Product",
        organizationUrl: "https://github.com/fixture-product",
        description: "Cross-repository planning fixture",
        repositories: [
          {
            id: "repo:core",
            name: "core",
            fullName: "fixture-product/core",
            url: "https://github.com/fixture-product/core",
            cloneUrl: "https://github.com/fixture-product/core.git",
            defaultBranch: "main",
            visibility: "public",
            archived: false,
            sizeKb: 100,
            language: "TypeScript",
            description: "Core product",
            intelligence: { role: "module" },
          },
          {
            id: "repo:docs",
            name: "docs",
            fullName: "fixture-product/docs",
            url: "https://github.com/fixture-product/docs",
            cloneUrl: "https://github.com/fixture-product/docs.git",
            defaultBranch: "main",
            visibility: "public",
            archived: false,
            sizeKb: 50,
            language: null,
            description: "Product documentation",
            intelligence: { role: "documentation" },
          },
        ],
      }),
    });
    assert.equal(productResponse.status, 201, await productResponse.clone().text());

    const objectiveResponse = await fetch(`${dashboard.url}/api/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "Cross repository fixture: implement and document the product change",
        acceptanceCriteria: ["Implementation and documentation remain aligned"],
        constraints: ["Plan before changing either repository"],
        projectPath: project,
        productId: "fixture-product",
        repositoryIds: ["repo:core", "repo:docs"],
        risk: "medium",
        autonomy: "supervised",
        priority: "normal",
        policyNotes: [],
      }),
    });
    assert.equal(objectiveResponse.status, 201, await objectiveResponse.clone().text());
    const objective = await objectiveResponse.json() as { objective: { id: string } };

    const planResponse = await fetch(`${dashboard.url}/api/objectives/${objective.objective.id}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledProviders: ["codex", "claude", "gemini"] }),
    });
    assert.equal(planResponse.status, 201, await planResponse.clone().text());
    const proposal = await planResponse.json() as {
      revision: { revision: number; plan: { repositoryImpact: Array<{ repositoryId: string; disposition: string }>; integrationConditions: string[]; tasks: Array<{ repositoryIds: string[] }> } };
      preview: { execution: { supported: boolean; reason: string } };
    };
    assert.deepEqual(
      proposal.revision.plan.repositoryImpact.map((impact) => [impact.repositoryId, impact.disposition]),
      [["repo:core", "affected"], ["repo:docs", "affected"]],
    );
    assert.deepEqual(proposal.revision.plan.tasks.flatMap((task) => task.repositoryIds).sort(), ["repo:core", "repo:docs"]);
    assert.equal(proposal.revision.plan.integrationConditions.length, 1);
    assert.equal(proposal.preview.execution.supported, false);
    assert.match(proposal.preview.execution.reason, /register local checkouts|multi-repository/i);

    const startResponse = await fetch(`${dashboard.url}/api/objectives/${objective.objective.id}/plans/1/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: 2, enabledProviders: ["codex", "claude", "gemini"] }),
    });
    assert.equal(startResponse.status, 409, await startResponse.clone().text());
    const runs = await fetch(`${dashboard.url}/api/runs`).then((response) => response.json()) as { runs: unknown[] };
    assert.equal(runs.runs.length, 0, "planning must not start a run before multi-repository execution exists");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("DH-720 automatically fixes a repository-scoped finding and independently re-reviews the exact integration set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-integration-set-"));
  const core = await createRepository(path.join(root, "core"));
  const docs = await createRepository(path.join(root, "docs"));
  await git(core, ["remote", "add", "origin", "https://github.com/fixture-product/core.git"]);
  await git(docs, ["remote", "add", "origin", "https://github.com/fixture-product/docs.git"]);
  const coreBase = (await git(core, ["rev-parse", "HEAD"])).stdout.trim();
  const docsBase = (await git(docs, ["rev-parse", "HEAD"])).stdout.trim();
  const command = await createFakeCli(root);
  await initializeProject(core);
  const config = await loadConfig(core);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.reviewPolicy.reviewerCountByRisk.medium = 2;
  config.reviewPolicy.minimumDistinctProvidersByRisk.medium = 2;
  config.reviewPolicy.requireImplementorIndependenceByRisk.medium = true;
  config.repository.validators["defect-free"] = { command: "node", args: ["-e", "const p=require('path');process.exit(!process.cwd().includes(p.sep+'tasks'+p.sep)&&require('fs').existsSync('needs-fix.txt')?1:0)"], timeoutMs: 60_000 };
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(core), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const dashboard = await startDashboard({ projectPath: core, port: 0, open: false });
  type IntegrationSetFixture = { repositories: Array<{ repositoryId: string; localPath: string; baseCommit: string; headCommit: string; integrationBranch: string; integrationWorktreePath: string }> };
  let runId = "";
  let integrationSet: IntegrationSetFixture | null = null;
  try {
    const productResponse = await fetch(`${dashboard.url}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fixture-product",
        name: "Fixture Product",
        organizationUrl: "https://github.com/fixture-product",
        description: "Two-repository execution fixture",
        repositories: [
          { id: "repo:core", name: "core", fullName: "fixture-product/core", url: "https://github.com/fixture-product/core", cloneUrl: "https://github.com/fixture-product/core.git", defaultBranch: "main", visibility: "public", archived: false, sizeKb: 100, language: "TypeScript", description: "Core product", intelligence: {} },
          { id: "repo:docs", name: "docs", fullName: "fixture-product/docs", url: "https://github.com/fixture-product/docs", cloneUrl: "https://github.com/fixture-product/docs.git", defaultBranch: "main", visibility: "public", archived: false, sizeKb: 50, language: null, description: "Product documentation", intelligence: {} },
        ],
      }),
    });
    assert.equal(productResponse.status, 201, await productResponse.clone().text());
    for (const [localPath, role] of [[core, "module"], [docs, "documentation"]] as const) {
      const response = await fetch(`${dashboard.url}/api/products/fixture-product/repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localPath, role, expectedBranch: "main", owners: ["fixture"], dependencyRepositoryIds: [], governanceSources: ["README.md"], validators: role === "module" ? { "diff-check": "git diff --check", "defect-free": `node -e "const p=require('path');process.exit(!process.cwd().includes(p.sep+'tasks'+p.sep)&&require('fs').existsSync('needs-fix.txt')?1:0)"` } : { "diff-check": "git diff --check" } }),
      });
      assert.equal(response.status, 201, await response.clone().text());
    }

    const objectiveResponse = await fetch(`${dashboard.url}/api/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "Cross repository fixture with automatic fixer: implement and document the product change",
        acceptanceCriteria: ["Both repositories contain the approved result"],
        constraints: ["Keep the primary checkouts unchanged"],
        projectPath: core,
        productId: "fixture-product",
        repositoryIds: ["repo:core", "repo:docs"],
        risk: "medium",
        autonomy: "supervised",
        priority: "normal",
        policyNotes: [],
      }),
    });
    assert.equal(objectiveResponse.status, 201, await objectiveResponse.clone().text());
    const objective = await objectiveResponse.json() as { objective: { id: string } };
    const planResponse = await fetch(`${dashboard.url}/api/objectives/${objective.objective.id}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledProviders: ["codex", "claude", "gemini"] }),
    });
    assert.equal(planResponse.status, 201, await planResponse.clone().text());
    const proposal = await planResponse.json() as { preview: { execution: { supported: boolean; reason: string } } };
    assert.equal(proposal.preview.execution.supported, true, proposal.preview.execution.reason);

    const startResponse = await fetch(`${dashboard.url}/api/objectives/${objective.objective.id}/plans/1/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: 2, enabledProviders: ["codex", "claude", "gemini"] }),
    });
    assert.equal(startResponse.status, 202, await startResponse.clone().text());
    runId = ((await startResponse.json()) as { runId: string }).runId;
    const run = await poll(
      () => fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{ status: string; finalReview: string | null }>),
      (candidate) => ["ready", "not_ready", "failed"].includes(candidate.status),
      45_000,
    );
    assert.equal(run.status, "ready", run.finalReview ?? "run did not become ready");
    assert.match(run.finalReview ?? "", /repo:core .* -> .*repo:docs/s);

    const integrationResponse = await fetch(`${dashboard.url}/api/runs/${runId}/integration-set`);
    assert.equal(integrationResponse.status, 200, await integrationResponse.clone().text());
    integrationSet = await integrationResponse.json() as IntegrationSetFixture;
    assert.ok(integrationSet);
    assert.equal(integrationSet.repositories.length, 2);
    const byId = new Map(integrationSet.repositories.map((repository) => [repository.repositoryId, repository]));
    assert.equal(byId.get("repo:core")?.baseCommit, coreBase);
    assert.equal(byId.get("repo:docs")?.baseCommit, docsBase);
    assert.notEqual(byId.get("repo:core")?.headCommit, coreBase);
    assert.notEqual(byId.get("repo:docs")?.headCommit, docsBase);
    assert.equal((await readFile(path.join(byId.get("repo:core")!.integrationWorktreePath, "result.txt"), "utf8")).replace(/\r\n/g, "\n"), "corrected by independent fixer\n");
    assert.equal((await readFile(path.join(byId.get("repo:docs")!.integrationWorktreePath, "result.txt"), "utf8")).replace(/\r\n/g, "\n"), "created by worker\n");
    await assert.rejects(readFile(path.join(byId.get("repo:core")!.integrationWorktreePath, "needs-fix.txt"), "utf8"));
    await assert.rejects(readFile(path.join(core, "result.txt"), "utf8"));
    await assert.rejects(readFile(path.join(docs, "result.txt"), "utf8"));
    assert.equal((await git(core, ["status", "--porcelain"])).stdout.trim(), "");
    assert.equal((await git(docs, ["status", "--porcelain"])).stdout.trim(), "");
    const ledger = new Ledger(path.join(devHarmonicsDirectory(core), "devharmonics.db"));
    try {
      const reviews = ledger.listReviewReceipts(runId);
      assert.equal(reviews.length, 4);
      assert.ok(reviews.slice(0, 2).every((review) => review.invalidatedAt), "every receipt from the rejected multi-repository quorum must be retained but invalidated");
      assert.ok(reviews.slice(0, 2).some((review) => review.verdict === "NOT_READY"), "the rejected quorum must retain its blocking review");
      assert.ok(reviews.slice(2).every((review) => review.verdict === "READY" && review.invalidatedAt === null));
      assert.equal(new Set(reviews.slice(2).map((review) => review.provider)).size, 2, "the replacement quorum must use distinct providers");
      assert.notEqual(reviews[0]!.integrationSha256, reviews[2]!.integrationSha256);
      const retained = ledger.getRun(runId);
      const integrationTaskId = repositoryTaskIds("__integration__", ["repo:core"]).get("repo:core")!;
      const repairTaskId = repositoryTaskIds("__review_fix_1", ["repo:core"]).get("repo:core")!;
      assert.equal(retained?.tasks.find((task) => task.id === integrationTaskId)?.checks.find((check) => check.name === "defect-free")?.passed, false, "the initial repository validator must detect the defect marker");
      assert.equal(retained?.tasks.find((task) => task.id === repairTaskId)?.status, "passed");
      assert.ok(retained?.tasks.find((task) => task.id === repairTaskId)?.checks.filter((check) => check.name === "defect-free").some((check) => check.passed), "the fixed integration branch must pass the same repository validator");
      assert.ok(retained?.events.some((event) => event.kind === "review.invalidated"));
      assert.ok(retained?.events.some((event) => event.kind === "fixer.completed"));
      assert.ok(retained?.events.some((event) => event.kind === "review.quorum_passed"));
      assert.deepEqual(retained?.delivery?.repositories.map((repository) => repository.repositoryId), ["repo:core", "repo:docs"]);
      assert.equal(retained?.delivery?.repositories.find((repository) => repository.repositoryId === "repo:core")?.baseCommit, coreBase);
      assert.equal(retained?.delivery?.repositories.find((repository) => repository.repositoryId === "repo:docs")?.baseCommit, docsBase);
    } finally {
      ledger.close();
    }
    const evidenceExport = await fetch(`${dashboard.url}/api/runs/${runId}/evidence/export`).then((response) => response.json()) as { evidence: { integrationSet: IntegrationSetFixture } };
    assert.deepEqual(evidenceExport.evidence.integrationSet.repositories.map((repository) => repository.repositoryId), ["repo:core", "repo:docs"]);
  } finally {
    await dashboard.close();
    if (integrationSet) {
      for (const repository of integrationSet.repositories) {
        const taskId = repository.repositoryId === "repo:core" ? "core" : "docs";
        const repositoryRoot = repository.repositoryId === "repo:core" ? core : docs;
        await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(path.dirname(repository.integrationWorktreePath), "tasks", taskId)], cwd: repositoryRoot, timeoutMs: 30_000 });
        if (repository.repositoryId === "repo:core") await runProcess({ command: "git", args: ["worktree", "remove", "--force", path.join(path.dirname(repository.integrationWorktreePath), "tasks", "__review_fix_1_repo-core")], cwd: repositoryRoot, timeoutMs: 30_000 });
        await runProcess({ command: "git", args: ["worktree", "remove", "--force", repository.integrationWorktreePath], cwd: repositoryRoot, timeoutMs: 30_000 });
      }
    }
    if (runId) await rm(path.join(os.tmpdir(), "devharmonics", runId), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("Workbench creates a durable read-only discussion and converts it to an objective without starting a run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-workbench-api-"));
  const project = await createRepository(root);
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const pageText = await fetch(dashboard.url).then((response) => response.text());
    assert.match(pageText, /Multi-model Workbench/);
    assert.match(pageText, /Read-only by design/);

    const createdResponse = await fetch(`${dashboard.url}/api/workbench`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: project, title: "Explore a safe migration" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { session: { id: string; mode: string } };
    assert.equal(created.session.mode, "read_only");

    const detail = await fetch(`${dashboard.url}/api/workbench/${created.session.id}`).then((response) => response.json()) as { messages: unknown[] };
    assert.deepEqual(detail.messages, []);
    const beforeRuns = await fetch(`${dashboard.url}/api/runs`).then((response) => response.json()) as { runs: unknown[] };
    assert.equal(beforeRuns.runs.length, 0);

    const convertedResponse = await fetch(`${dashboard.url}/api/workbench/${created.session.id}/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "Prepare the safe migration",
        acceptanceCriteria: ["Migration plan is reviewable"],
        constraints: ["Do not change the repository during discovery"],
        projectPath: project,
        repositoryIds: [],
        risk: "medium",
        autonomy: "supervised",
        priority: "normal",
        policyNotes: [],
      }),
    });
    assert.equal(convertedResponse.status, 201);
    const converted = await convertedResponse.json() as { objective: { id: string }; session: { objectiveId: string } };
    assert.equal(converted.session.objectiveId, converted.objective.id);
    const afterRuns = await fetch(`${dashboard.url}/api/runs`).then((response) => response.json()) as { runs: unknown[] };
    assert.equal(afterRuns.runs.length, 0);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("product registry inspects and retains a local repository without changing or running it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-product-registry-api-"));
  const project = await createRepository(root);
  await writeFile(path.join(project, "local-note.txt"), "uncommitted\n", "utf8");
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const productResponse = await fetch(`${dashboard.url}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "civicsuite", name: "CivicSuite", organizationUrl: "https://github.com/civicsuite", description: "Fixture product", repositories: [] }),
    });
    assert.equal(productResponse.status, 201);

    const repositoryResponse = await fetch(`${dashboard.url}/api/products/civicsuite/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        localPath: project,
        role: "umbrella",
        expectedBranch: "main",
        owners: ["product-platform"],
        dependencyRepositoryIds: [],
        governanceSources: ["README.md"],
        validators: { test: "npm test" },
      }),
    });
    assert.equal(repositoryResponse.status, 201);
    const registered = await repositoryResponse.json() as { repository: { role: string; localPath: string; inspection: { dirty: boolean; currentBranch: string } } };
    assert.equal(registered.repository.role, "umbrella");
    assert.equal(registered.repository.localPath, path.resolve(project));
    assert.equal(registered.repository.inspection.dirty, true);
    assert.equal(registered.repository.inspection.currentBranch, "main");

    const portfolio = await fetch(`${dashboard.url}/api/products`).then((response) => response.json()) as { products: Array<{ repositories: Array<{ owners: string[]; validators: Record<string, { command: string }> }> }> };
    assert.deepEqual(portfolio.products[0]?.repositories[0]?.owners, ["product-platform"]);
    assert.equal(portfolio.products[0]?.repositories[0]?.validators.test?.command, "npm");
    const runs = await fetch(`${dashboard.url}/api/runs`).then((response) => response.json()) as { runs: unknown[] };
    assert.equal(runs.runs.length, 0);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel during planning does not save a late plan or restart the run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-cancel-planning-"));
  const project = await createRepository(root);
  const command = await createSlowArchitectCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
    config.connections[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(devHarmonicsDirectory(project), "config.json"),
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
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
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
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-cancel-"));
  const project = await createRepository(root);
  const command = await createHangingCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
    config.connections[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(devHarmonicsDirectory(project), "config.json"),
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
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
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
} else if (input.includes("DevHarmonics non-destructive") || input.includes("DevHarmonics deterministic baseline")) {
  const marker = input.includes("deterministic baseline") ? "DEVHARMONICS_BENCHMARK_QUALIFIED|17|BLUE" : (input.match(/DEVHARMONICS_[A-Z]+_QUALIFIED/) || ["DEVHARMONICS_GENERAL_QUALIFIED"])[0];
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:marker}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:marker}));
  else console.log(marker);
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
  const review = "READY\\n\\nFixture integration is valid.";
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:review}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:review}));
  else console.log(review);
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
} else if (input.includes("DevHarmonics non-destructive") || input.includes("DevHarmonics deterministic baseline")) {
  const marker = input.includes("deterministic baseline") ? "DEVHARMONICS_BENCHMARK_QUALIFIED|17|BLUE" : (input.match(/DEVHARMONICS_[A-Z]+_QUALIFIED/) || ["DEVHARMONICS_GENERAL_QUALIFIED"])[0];
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:marker}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:marker}));
  else console.log(marker);
} else if (input.includes("You are the architect")) {
  const plan = {summary:"validator plan",recommendedConcurrency:1,tasks:[{id:"one",title:"Create result",description:"Create result.txt",dependencies:[],preferredProvider:"codex",checks:["slow-check"]}]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the final reviewer")) {
  const review = "READY\\n\\nFixture integration is valid.";
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:review}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:review}));
  else console.log(review);
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
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-cancel-planning-a-"));
  const project = await createRepository(root);
  const startedFile = path.join(root, "started.marker");
  const completedFile = path.join(root, "completed.marker");
  const command = await createPlanningHangingCli(root, startedFile, completedFile);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
    config.connections[provider].timeoutMs = 30_000;
  }
  await writeFile(
    path.join(devHarmonicsDirectory(project), "config.json"),
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
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
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
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-cancel-validator-b-"));
  const project = await createRepository(root);
  const command = await createValidatorTestCli(root);
  const slowCheckCommand = await createSlowCheckScript(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) {
    config.connections[provider].command = command;
    config.connections[provider].timeoutMs = 30_000;
  }
  config.repository.validators["slow-check"] = {
    command: slowCheckCommand,
    args: [],
    timeoutMs: 30_000,
  };
  await writeFile(
    path.join(devHarmonicsDirectory(project), "config.json"),
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
      args: ["show", `devharmonics/${runId.slice(0, 8)}:result.txt`],
      cwd: project,
      timeoutMs: 30_000,
    });
    assert.notEqual(shown.exitCode, 0, `result.txt should not be present on integration branch`);
  } finally {
    await dashboard.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
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

test("owner steering interrupts a live attempt and hands off to an attributed continuation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-e2e-"));
  const project = await createRepository(root);
  // A hanging CLI keeps attempt 1 genuinely in flight so the interrupt has to
  // terminate a real child process rather than racing a fast fixture.
  const hanging = await createHangingCli(root);
  const fixture = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.runPolicy.requirePlanApproval = false;
  config.connections.codex.command = hanging;
  config.connections.claude.command = fixture;
  config.connections.gemini.command = fixture;
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].timeoutMs = 60_000;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  let runId = "";
  try {
    const started = await fetch(`${dashboard.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Create the fixture result", projectPath: project, agents: 1 }),
    });
    assert.equal(started.status, 202);
    runId = ((await started.json()) as { runId: string }).runId;

    const getRun = () => fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{
      status: string;
      tasks: Array<{ id: string; status: string; attemptCount: number }>;
      events: Array<{ kind: string }>;
    }>);
    // 'working' alone is no longer a precise precondition for "an attempt is
    // live". A task is now marked working before first-use qualification, so
    // that the interrupt the product offers at that moment is genuinely
    // watched for. attemptCount only rises once qualification and routing are
    // done and the provider invocation is about to start, so waiting on it is
    // what this test actually means. Waiting on 'working' alone let the
    // interrupt land in the qualification window under load, which exercised a
    // different (also correct) code path and made this test intermittent.
    await poll(getRun, (run) => run.tasks.some((task) => task.id === "one" && task.status === "working" && task.attemptCount >= 1), 30_000);

    // Steering that tries to carry authority must be refused outright.
    const escalation = await fetch(`${dashboard.url}/api/runs/${runId}/steering`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "clarify", targetTaskId: "one", payload: { clarification: "go", permission: "workspace_write" } }),
    });
    assert.equal(escalation.status, 400, "steering cannot carry a permission field");

    // A directive that names no task can never be matched to one, so it must be
    // refused rather than accepted and left pending forever.
    const untargeted = await fetch(`${dashboard.url}/api/runs/${runId}/steering`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "interrupt", targetTaskId: null, payload: {} }),
    });
    assert.equal(untargeted.status, 400, "a task-scoped directive must name its task");

    // The hanging CLI is configured with a 60s timeout and this test asserts the
    // interrupt lands far inside that window, so a second attempt appearing
    // cannot be explained by the attempt timing out on its own.
    const interruptedAt = Date.now();
    const interrupted = await fetch(`${dashboard.url}/api/runs/${runId}/steering`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "interrupt", targetTaskId: "one", payload: { clarification: "Use the shorter approach" } }),
    });
    assert.equal(interrupted.status, 201);

    // The interrupt must terminate the hanging attempt and start a second one.
    await poll(getRun, (run) => (run.tasks.find((task) => task.id === "one")?.attemptCount ?? 0) >= 2, 30_000);
    const elapsedMs = Date.now() - interruptedAt;
    assert.ok(
      elapsedMs < 20_000,
      `the second attempt must follow the interrupt promptly (took ${elapsedMs}ms); a 60s provider timeout could not have produced it`,
    );
    const afterInterrupt = await getRun();
    assert.ok(afterInterrupt.events.some((event) => event.kind === "steering.interrupted"), "the interrupt is recorded as run evidence");
    assert.notEqual(afterInterrupt.status, "cancelled", "interrupting one attempt must not cancel the run");

    // The directive is applied and linked to the exact attempt it stopped.
    const directives = await fetch(`${dashboard.url}/api/runs/${runId}/steering`).then((r) => r.json() as Promise<{
      directives: Array<{ kind: string; disposition: string; appliedAttemptId: number | null; targetTaskId: string | null }>;
    }>);
    const applied = directives.directives.find((directive) => directive.kind === "interrupt");
    assert.equal(applied?.disposition, "applied");
    assert.equal(applied?.targetTaskId, "one");
    assert.ok(applied?.appliedAttemptId, "an applied interrupt links to the attempt it stopped");

    // The interrupted attempt is retained as evidence, not erased.
    const evidence = await fetch(`${dashboard.url}/api/runs/${runId}/evidence`).then((r) => r.json() as Promise<{
      attempts: Array<{ status: string; error: string | null }>;
      blackboard: Array<{ kind: string; content: string }>;
    }>);
    assert.ok(evidence.attempts.some((attempt) => (attempt.error ?? "").includes("Interrupted by owner steering")), "the stopped attempt is retained");
    assert.ok(evidence.blackboard.some((entry) => entry.kind === "handoff" && entry.content.includes("Owner interrupted")), "the continuation receives a handoff");
  } finally {
    await fetch(`${dashboard.url}/api/runs/${runId}/cancel`, { method: "POST", headers: { "content-type": "application/json" } }).catch(() => undefined);
    await delay(500);
    await dashboard.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
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

test("the steering panel reports requested admission changes honestly before they take effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-steering-ui-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const appScript = await fetch(`${dashboard.url}/app.js`).then((response) => response.text());
    // A directive is only in force once the scheduler consumes it, so a merely
    // requested hold must never render as an applied one.
    assert.match(appScript, /Hold requested/, "a pending hold is reported as requested, not as held");
    assert.match(appScript, /takes effect at the next admission boundary/, "the panel says when a request takes effect");
    assert.match(appScript, /admissionState === "held" \|\| admissionState === "holding"/, "hold is disabled while its own request is still in flight");
    assert.match(appScript, /admissionState === "admitting" \|\| admissionState === "resuming"/, "resume is disabled while its own request is still in flight");
    // The interrupt confirmation must not promise mid-response injection.
    assert.match(appScript, /cannot change an answer already being written/, "the interrupt copy stays honest about what it does");
    assert.doesNotMatch(appScript, /inject|mid-response/i, "the UI never claims to inject direction into a running response");

    // renderSteering once called ready(), a helper local to renderProviders, which
    // threw on every render and silently froze the whole panel. Module-scope-only
    // references are the property that keeps it renderable.
    // Which states are steerable is one rule owned by the ledger and served to
    // the browser. A second hard-coded copy in the UI is what let the paused-run
    // rule drift between layers, so the copy must not come back.
    const bootstrap = await fetch(`${dashboard.url}/api/bootstrap`).then((response) => response.json()) as {
      steering: { steerableRunStatuses: string[]; steerableTaskStatuses: string[] };
    };
    assert.deepEqual(bootstrap.steering.steerableRunStatuses, ["planning", "running", "awaiting_approval"], "the server publishes the steerable run states");
    assert.ok(!bootstrap.steering.steerableRunStatuses.includes("paused"), "a paused run is never steerable: recovery continues in a new run");
    assert.deepEqual(bootstrap.steering.steerableTaskStatuses, ["queued", "working", "verifying", "retry"], "the server publishes the steerable task states");
    assert.match(appScript, /state\.bootstrap\?\.steering\?\.steerableRunStatuses/, "the browser reads the served rule");
    assert.doesNotMatch(appScript, /const STEERABLE_RUN_STATUSES\s*=\s*\[/, "the browser must not keep its own copy of the rule");

    const steeringRender = appScript.slice(appScript.indexOf("function renderSteering("), appScript.indexOf("function renderSteeringDirectives("));
    assert.ok(steeringRender.length > 0, "renderSteering must exist");
    assert.doesNotMatch(steeringRender, /\bready\(/, "renderSteering must not call helpers scoped to another render function");
    assert.match(steeringRender, /provider\.available/, "provider eligibility comes from the bootstrap payload");

    // Every capability the plan claims for DH-635 must be reachable in the UI,
    // not merely implemented in the backend.
    for (const control of ["steering-hold", "steering-resume", "steering-clarify", "steering-interrupt", "steering-reassign", "steering-reprioritize"]) {
      assert.match(appScript, new RegExp(`#${control}`), `${control} must be wired`);
    }

    const page = await fetch(dashboard.url).then((response) => response.text());
    assert.match(page, /id="steering-panel"/);
    for (const control of ["steering-hold", "steering-resume", "steering-interrupt", "steering-reassign", "steering-reprioritize", "steering-order", "steering-provider"]) {
      assert.match(page, new RegExp(`id="${control}"`), `${control} must exist in the shell`);
    }
    assert.match(page, /cannot change a task's permissions, risk, acceptance criteria, or repository scope/, "the panel states the containment boundary to the user");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a first-attempt qualification failure retries the task instead of crashing the run", async () => {
  // Found by a real fallback proving run against an exhausted subscription.
  // Scheduler-time qualification runs before the task is marked 'working', so
  // its failure path asked for queued -> retry, which the task state machine
  // forbids. The thrown transition failed the entire RUN — exactly when a
  // provider is degraded and resilience matters most.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-qual-retry-"));
  const project = await createRepository(root);
  // Authenticates and reports a version like a healthy CLI, but never returns
  // the qualification marker, so every worker qualification attempt fails.
  const script = path.join(root, "unqualifiable.mjs");
  await writeFile(script, `const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.0 fixture"); process.exit(0); }
if ((args[0] === "auth" && args[1] === "status") || args[0] === "models" || (args[0] === "login" && args[1] === "status")) { console.log("Authenticated fixture"); process.exit(0); }
console.log("I am unable to comply with that request.");
process.exit(0);
`, "utf8");
  const unqualifiable = path.join(root, "unqualifiable.cmd");
  await writeFile(unqualifiable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  const fixture = await createFakeCli(root);

  await initializeProject(project);
  const config = await loadConfig(project);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  config.runPolicy.requirePlanApproval = false;
  config.connections.codex.command = unqualifiable;
  config.connections.claude.command = fixture;
  config.connections.gemini.command = fixture;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  let runId = "";
  try {
    runId = await new Orchestrator(ledger).run({ goal: "Create the fixture result", projectPath: project, agents: 1 });
    const run = ledger.getRun(runId);
    // The run may legitimately end not-ready — no worker could be qualified —
    // but it must not die on an internal state-machine violation.
    assert.doesNotMatch(
      `${run?.finalReview ?? ""}`,
      /Invalid task status transition/,
      "a failed qualification must not crash the run with an invalid transition",
    );
    assert.ok(
      !(run?.events ?? []).some((event) => event.kind === "run.failed" && /Invalid task status transition/.test(event.message)),
      "no invalid-transition failure event",
    );
    // The task itself must reach an honest terminal state.
    const task = run?.tasks.find((item) => item.id !== "__integration__");
    assert.ok(["failed", "blocked", "passed"].includes(task?.status ?? ""), `task settled, got '${task?.status}'`);
  } finally {
    ledger.close();
    if (runId) {
      const runRoot = path.join(os.tmpdir(), "devharmonics", runId);
      await runProcess({ command: "git", args: ["worktree", "prune"], cwd: project, timeoutMs: 30_000 });
      await rm(runRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});
