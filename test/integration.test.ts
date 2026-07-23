import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { initializeProject, loadConfig, devHarmonicsDirectory } from "../src/config.js";
import { inspectProviders } from "../src/doctor.js";
import { Ledger } from "../src/ledger.js";
import { profileMetadata } from "../src/model-intelligence.js";
import { Orchestrator, repositoryTaskIds } from "../src/orchestrator.js";
import { syncOllamaRuntimes } from "../src/ollama.js";
import { runProcess } from "../src/process.js";
import { startDashboard } from "../src/server.js";
import { ModelCatalogCoordinator } from "../src/catalog.js";

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
  if (process.env.DH_CAPTURE_ARCHITECT_PROMPT) { const fs = await import("node:fs"); fs.writeFileSync(process.env.DH_CAPTURE_ARCHITECT_PROMPT, input, "utf8"); }
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
          {id:"core",title:"Implement the product change",description:"Update the core repository",dependencies:[],preferredProvider:"codex",checks:input.includes("automatic fixer")?["diff-check","defect-free"]:(input.includes("repo-only-lint")?["repo-only-lint"]:["diff-check"]),repositoryIds:["repo:core"]},
          {id:"docs",title:"Document the product change",description:"Update the documentation repository",dependencies:["core"],preferredProvider:"codex",checks:["diff-check"],repositoryIds:["repo:docs"]}
        ]
      }
    : {summary:"fixture plan",recommendedConcurrency:1,tasks:[task]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
} else if (input.includes("You are the claims-lens reviewer")) {
  const manifest = JSON.stringify({findings:[],claimedChanges:[{path:"result.txt",kind:"created",taskId:"one"}]});
  const toolsIndex = process.argv.indexOf("--tools");
  const toolsFlag = toolsIndex >= 0 && process.argv[toolsIndex + 1] === "" && process.argv.includes("--strict-mcp-config") && process.argv.includes("--safe-mode") && process.argv.includes("--bare") ? "denied" : "undenied";
  const review = "READY\\n\\nClaims reviewed from cwd=" + process.cwd().replace(/\\\\/g, "/") + " toolsFlag=" + toolsFlag + " and they cohere with the receipts.\\n" + manifest;
  if (process.argv.includes("--json")) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:review}}));
  else if (process.argv.includes("--output-format")) console.log(JSON.stringify({result:review}));
  else console.log(review);
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
} else if (input.includes("No-op fixture")) {
  // Reports success without touching the repository, exactly as a real worker
  // did on the first cross-repository run: it narrated its intentions and
  // changed nothing at all.
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"I inspected the files and applied the corrections. The changes are complete."}}));
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
        adapter_version: "0.6.1",
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
  // The owner attestation is what admits a Claude CLI reviewer to a claims
  // slot at all; this fixture machine is its test double.
  config.reviewPolicy.attestNoManagedClaudePolicy = true;
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
    assert.deepEqual(reviews.map((review) => review.lens).sort(), ["artifact", "claims"], "high risk covers both lenses");
    // Codex F-001: the claims reviewer's effective working directory — as the
    // reviewer process itself observed it — must be a fresh claims-review
    // directory that is NOT an ancestor of the run's integration worktree.
    // (The temp ROOT is such an ancestor; running there hands the reviewer a
    // route to the repository.)
    const claimsReceipt = reviews.find((review) => review.lens === "claims")!;
    const observedCwd = claimsReceipt.rawText.match(/cwd=([^\s]+)/)?.[1];
    assert.ok(observedCwd, `the claims fixture must report its cwd: ${claimsReceipt.rawText.slice(0, 200)}`);
    assert.match(path.basename(observedCwd!), /^dh-claims-/, "claims reviews run from a dedicated empty directory");
    const integrationRoot = path.join(os.tmpdir(), "devharmonics", runId);
    const relation = path.relative(path.resolve(observedCwd!), integrationRoot);
    assert.ok(relation.startsWith(".."), `the claims cwd must not be an ancestor of the integration worktree (relation: ${relation})`);
    // Codex R2-001: tool denial must be structural. The claims slot may only
    // route to an adapter that can deny its tools (here: claude), and the
    // reviewer process must actually receive the denial in its effective argv.
    assert.equal(claimsReceipt.provider, "claude", "claims reviews route only to tool-denial-capable adapters");
    assert.match(claimsReceipt.rawText, /toolsFlag=denied/, "the claims reviewer's effective invocation must carry the tool denial");
    assert.ok(run?.events.some((event) => event.kind === "review.quorum_passed"));
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the run cost endpoint serves a mix-aware counterfactual from ledger evidence", async () => {
  // Codex F-006: the endpoint had no regression test — it could be deleted
  // with the suite green, and its comparator picked by summed rate card
  // (F-003) instead of the run's observed token mix.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-cost-endpoint-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const seedLedger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  seedLedger.upsertConnection({
    id: "subscription-cli:codex", provider: "codex", transport: "subscription_cli", authentication: "subscription",
    displayName: "Codex", enabled: true, installed: true, authenticated: true, visible: true, healthy: true,
    available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "t", runtimeVersion: "t", metadata: {},
  });
  const seedModel = (id: string, promptPrice: number, completionPrice: number) => {
    seedLedger.addManualModel({
      id, connectionId: "subscription-cli:codex", canonicalName: id, displayName: id, lifecycle: "verified",
      visible: true, verified: true, qualified: true, active: true,
      metadata: { devHarmonicsProfile: { tier: "premium", family: "fixture", capabilities: ["text"], source: "catalog" }, promptPrice, completionPrice },
    });
  };
  seedModel("manual:codex:input-expensive", 0.0001, 0);   // 100 USD/MTok in, 0 out
  seedModel("manual:codex:output-expensive", 0, 0.00009); // 0 in, 90 USD/MTok out
  // The dashboard refreshes the catalog at startup, which stamps model
  // fingerprints; qualify AGAINST the refreshed fingerprint so the
  // qualification is current in the server process, exactly as a real
  // qualified fleet would be.
  const seedCatalog = new ModelCatalogCoordinator(seedLedger, project);
  await seedCatalog.refresh(true, "application_launch");
  seedCatalog.stop();
  for (const id of ["manual:codex:input-expensive", "manual:codex:output-expensive"]) {
    seedLedger.recordModelQualification({ modelId: id, fixtureVersion: "t", role: "general", passed: true, score: 1, evidence: {}, fingerprint: seedLedger.getModel(id)!.qualificationFingerprint });
  }
  const runId = seedLedger.createRun("Cost endpoint fixture", project);
  seedLedger.recordInvocationReceipt({
    runId, role: "worker", provider: "codex", connectionId: "subscription-cli:codex",
    requestedModelId: null, resolvedModelId: "fixture-worker", inputTokens: 0, outputTokens: 1_000_000, costUsd: 0.1,
    durationMs: 10, workloadClass: "standard:standard",
  });
  const emptyRunId = seedLedger.createRun("No receipts", project);
  seedLedger.close();
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    const missing = await fetch(`${dashboard.url}/api/runs/aaaaaaaa-0000-0000-0000-000000000000/cost`);
    assert.equal(missing.status, 404);
    const empty = await fetch(`${dashboard.url}/api/runs/${emptyRunId}/cost`).then((response) => response.json()) as { cost: unknown };
    assert.equal(empty.cost, null, "a run with no receipts shows nothing, not zero");
    const value = await fetch(`${dashboard.url}/api/runs/${runId}/cost`).then((response) => response.json()) as {
      cost: { estimate: boolean; actualUsd: number; counterfactualUsd: number; byRole: Array<{ role: string; comparisonModelId: string }> };
    };
    assert.equal(value.cost.estimate, true);
    assert.equal(value.cost.actualUsd, 0.1);
    // The priciest model FOR THIS MIX (all output tokens) is the
    // output-expensive one, not the higher summed rate card.
    assert.equal(value.cost.byRole[0]!.comparisonModelId, "manual:codex:output-expensive");
    assert.equal(value.cost.counterfactualUsd, 90);
  } finally {
    await dashboard.close();
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

test("workflow provenance cannot be forged at the HTTP boundary and shipped workflows seed a fresh cockpit", async () => {
  // Audit DH810-AUD-001/005/006 at the PUBLIC boundary: a fresh server seeds
  // the shipped workflows-of-record, no objective route accepts a client
  // provenance pin, and the promotion API refuses with typed statuses instead
  // of silent downgrades or generic 500s.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-provenance-http-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });
  try {
    // AUD-005: the two shipped documents are recorded in a FRESH ledger.
    const listed = await fetch(`${dashboard.url}/api/workflows`).then((response) => response.json()) as { workflows: Array<{ name: string; revisionHash: string }> };
    assert.deepEqual(listed.workflows.map((workflow) => workflow.name).sort(), ["documentation-consistency", "release-truth-audit"], "a fresh cockpit contains the shipped workflows-of-record");
    const knownHash = listed.workflows.find((workflow) => workflow.name === "documentation-consistency")!.revisionHash;

    const objectiveBody = {
      outcome: "Forge a pedigree",
      acceptanceCriteria: ["none"],
      constraints: [],
      projectPath: project,
      repositoryIds: [],
      risk: "low",
      autonomy: "observe",
      priority: "normal",
      policyNotes: [],
    };
    // AUD-001: a KNOWN hash is refused the same as an unknown one — the field
    // itself is privileged, not merely validated.
    for (const forged of [knownHash, "a".repeat(64)]) {
      const refused = await fetch(`${dashboard.url}/api/objectives`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...objectiveBody, workflowRevisionHash: forged }),
      });
      assert.equal(refused.status, 400, "a client-supplied provenance pin refuses");
      assert.match(((await refused.json()) as { error: string }).error, /structural provenance/i);
    }
    const afterForgeries = await fetch(`${dashboard.url}/api/objectives`).then((response) => response.json()) as { objectives: unknown[] };
    assert.equal(afterForgeries.objectives.length, 0, "the refused forgeries created no objective");

    // The update route refuses the pin too (hand-editing clears provenance;
    // it can never set it).
    const legit = await fetch(`${dashboard.url}/api/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(objectiveBody),
    });
    assert.equal(legit.status, 201);
    const legitObjective = ((await legit.json()) as { objective: { id: string; workflowRevisionHash: string | null } }).objective;
    assert.equal(legitObjective.workflowRevisionHash, null, "a hand-authored objective has explicit null provenance");
    for (const forged of [knownHash, "a".repeat(64)]) {
      const forgedUpdate = await fetch(`${dashboard.url}/api/objectives/${legitObjective.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...objectiveBody, expectedRevision: 1, workflowRevisionHash: forged }),
      });
      assert.equal(forgedUpdate.status, 400, "an objective update cannot inject provenance");
    }

    // DH810-R3-002: the public run route refuses the reserved field the same
    // way — never a silent 202 that ignores it.
    for (const forged of [knownHash, "a".repeat(64)]) {
      const forgedRun = await fetch(`${dashboard.url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "Forge a run pedigree", projectPath: project, workflowRevisionHash: forged }),
      });
      assert.equal(forgedRun.status, 400, "a run request cannot supply the reserved provenance field");
    }
    const runsAfterForgeries = await fetch(`${dashboard.url}/api/runs`).then((response) => response.json()) as { runs: unknown[] };
    assert.equal(runsAfterForgeries.runs.length, 0, "the refused run forgeries created no run");

    // The Workbench conversion route refuses the pin as well.
    const session = ((await (await fetch(`${dashboard.url}/api/workbench`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: project, title: "Provenance probe" }),
    })).json()) as { session: { id: string } }).session;
    for (const forged of [knownHash, "a".repeat(64)]) {
      const forgedConvert = await fetch(`${dashboard.url}/api/workbench/${session.id}/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...objectiveBody, workflowRevisionHash: forged }),
      });
      assert.equal(forgedConvert.status, 400, "Workbench conversion cannot inject provenance");
    }

    // DH810-R3-001: both supported server layouts must resolve the shipped
    // fixtures — src/../workflows (the tracked directory) and
    // dist/src/../workflows (copied by the build). A missing copy would make
    // `npm run dev` seed nothing while the compiled product seeds two.
    for (const layoutDirectory of [path.join(process.cwd(), "workflows"), path.join(process.cwd(), "dist", "workflows")]) {
      for (const fixture of ["documentation-consistency.json", "release-truth-audit.json"]) {
        await stat(path.join(layoutDirectory, fixture));
      }
    }

    // The ONLY path that sets provenance: instantiation of a stored revision.
    const instantiated = await fetch(`${dashboard.url}/api/workflows/${knownHash}/instantiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: { repositoryId: "repo:docs" }, repositoryIds: [] }),
    });
    assert.equal(instantiated.status, 201);
    assert.equal(((await instantiated.json()) as { objective: { workflowRevisionHash: string | null } }).objective.workflowRevisionHash, knownHash, "instantiation is the privileged provenance path");

    // AUD-006: promotion statuses are typed — malformed 400, unknown 404,
    // widening 409 — and an attempted promotion is never quietly recorded as
    // an ordinary revision.
    const before = ((await (await fetch(`${dashboard.url}/api/workflows`)).json()) as { workflows: unknown[] }).workflows.length;
    const baseDocument = {
      name: "promotion-probe",
      description: "Pilot for promotion status checks.",
      inputs: [],
      objective: { outcomeTemplate: "Probe promotions.", acceptanceCriteria: ["typed statuses"], risk: "low" },
      evidenceRequirements: ["status transcript"],
      approvalPoints: ["plan"],
      completionContract: { deliverable: "statuses", reviewLenses: ["artifact"] },
      permissions: { autonomy: "observe", allowExternalWrites: false },
    };
    const malformed = await fetch(`${dashboard.url}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: baseDocument, promotedFrom: "not-a-hash" }),
    });
    assert.equal(malformed.status, 400, "a malformed promotion base refuses");
    const unknownBase = await fetch(`${dashboard.url}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: baseDocument, promotedFrom: "0".repeat(64) }),
    });
    assert.equal(unknownBase.status, 404, "an unknown promotion base is 404");
    const after = ((await (await fetch(`${dashboard.url}/api/workflows`)).json()) as { workflows: unknown[] }).workflows.length;
    assert.equal(after, before, "refused promotions record nothing");

    const recordedBase = await fetch(`${dashboard.url}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: baseDocument }),
    });
    assert.equal(recordedBase.status, 201);
    const baseHash = ((await recordedBase.json()) as { revision: { revisionHash: string } }).revision.revisionHash;
    const widened = await fetch(`${dashboard.url}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: { ...baseDocument, description: "Widened.", permissions: { autonomy: "bounded", allowExternalWrites: false } },
        promotedFrom: baseHash,
      }),
    });
    assert.equal(widened.status, 409, "a widening promotion is a 409 conflict, not a 500");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the delivery HTTP route serializes per repository, types its refusals, and completes end to end", async () => {
  // Gate findings ENG-1 / TEST-1 / QA-1 / QA-2 (2026-07-22): the route that
  // fronts irreversible external writes had zero HTTP-level coverage. This
  // exercises the per-repository concurrency lock (one 200, one 409, lock
  // released after), typed refusals (409 with the honest reason, not 500),
  // the complete_delivery composite, and the client-error classification the
  // whole API now uses.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-delivery-http-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.runPolicy.allowExternalWrites = true;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const seedLedger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  const runId = seedLedger.createRun("Deliver over HTTP", project);
  seedLedger.setRunStatus(runId, "running");
  seedLedger.setRunStatus(runId, "ready", "READY");
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:http", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), branch: "devharmonics/http1" });
  seedLedger.close();

  let prState = "OPEN";
  let holdFirstPush: (() => void) | null = null;
  const firstPushHeld = new Promise<void>((resolve) => { holdFirstPush = resolve; });
  let pushCalls = 0;
  const runner = async (request: { command: string; args: string[] }) => {
    const joined = request.args.join(" ");
    if (request.command === "git" && joined === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/http.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    // The tag-truth gate and the GET enrichment now read the version from the
    // IMMUTABLE commit via `git show <oid>:package.json`, not the checkout. This
    // fixture's commits (reviewed head and merge commit) declare 9.9.9.
    if (request.command === "git" && request.args[0] === "show" && joined.endsWith(":package.json")) {
      return { stdout: JSON.stringify({ name: "fixture", version: "9.9.9" }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "push" && !joined.includes("refs/tags/")) {
      pushCalls += 1;
      if (pushCalls === 1) await firstPushHeld; // hold the lock long enough for the racing request to arrive
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "create") {
      return { stdout: "https://github.com/civicsuite/http/pull/9\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("state,isDraft,mergeable")) {
      return { stdout: JSON.stringify({ state: prState, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "b".repeat(40), statusCheckRollup: [] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("mergeCommit")) {
      return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "c".repeat(40) } }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "merge") prState = "MERGED";
    if (request.command === "git" && request.args[0] === "rev-parse" && joined.includes("refs/tags/")) {
      return { stdout: "", stderr: "", exitCode: 1, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false, deliveryRunner: runner as never });
  try {
    const deliver = (body: Record<string, unknown>) => fetch(`${dashboard.url}/api/runs/${runId}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: "repo:http", expectedHeadCommit: "b".repeat(40), ...body }),
    });

    // Client-error classification (QA-1/QA-2): a JSON `null` body is a 400,
    // not a TypeError-500; a wrong content type is a 400; a wrong method on a
    // real collection path is a 405.
    const nullBody = await fetch(`${dashboard.url}/api/objectives`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" });
    assert.equal(nullBody.status, 400, "a JSON null body is a client error");
    const wrongType = await fetch(`${dashboard.url}/api/objectives`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(wrongType.status, 400, "a wrong content type is a client error");
    const noGoal = await fetch(`${dashboard.url}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noGoal.status, 400, "a run without a goal is a client error");
    const wrongMethod = await fetch(`${dashboard.url}/api/objectives`, { method: "DELETE" });
    assert.equal(wrongMethod.status, 405, "a wrong method on a known path is 405, not 404");

    // A refusal grounded in delivery state is a typed 409 with the honest
    // reason (ENG-1) — merging before the draft PR exists.
    const premature = await deliver({ action: "merge_pr" });
    assert.equal(premature.status, 409, "an out-of-order merge is a conflict, not a server fault");
    assert.match(((await premature.json()) as { error: string }).error, /draft pull request first/i);

    // Concurrency lock (TEST-1): two racing pushes — exactly one enters, the
    // other is refused 409, and the lock releases after settlement.
    const raceA = deliver({ action: "push_branch" });
    await delay(150); // let the first request take the lock and block in the held runner
    const raceB = await deliver({ action: "push_branch" });
    assert.equal(raceB.status, 409, "an overlapping delivery operation on the same repository is refused");
    assert.match(((await raceB.json()) as { error: string }).error, /already in progress/i);
    holdFirstPush!();
    assert.equal((await raceA).status, 200, "the first request completes normally");
    const afterRelease = await deliver({ action: "push_branch" });
    assert.equal(afterRelease.status, 200, "the lock releases after the operation settles (idempotent reconcile)");

    // The composite completes the rest under one approval id (no tag yet —
    // the tag-truth gate is probed explicitly below).
    const complete = await deliver({ action: "complete_delivery" });
    assert.equal(complete.status, 200, JSON.stringify(await complete.clone().json()));
    const completed = (await complete.json()) as { delivery: { status: string }; completedSteps: string[]; approvalId: string };
    assert.equal(completed.delivery.status, "merged");
    assert.deepEqual(completed.completedSteps, ["push_branch", "create_draft_pr", "merge_pr"]);
    assert.ok(completed.approvalId, "the composite carries its single approval id");

    // Tag-truth gate (owner-requested, 2026-07-22): the reviewed/merge COMMIT
    // declares 9.9.9 about itself (supplied by the fake runner's `git show`, not
    // the mutable checkout); a contradicting tag refuses with BOTH values, and
    // only an explicit owner confirmation mints it anyway.
    // The delivery payload carries the declared version, so the cockpit's tag
    // field can show the REAL proposed tag instead of decorative ghost text
    // (owner finding, 2026-07-22).
    const enriched = await fetch(`${dashboard.url}/api/runs/${runId}/delivery`).then((response) => response.json()) as { delivery: { repositories: Array<{ repositoryId: string; declaredVersion: string | null }> } };
    assert.equal(enriched.delivery.repositories.find((repository) => repository.repositoryId === "repo:http")?.declaredVersion, "9.9.9", "the delivery payload names the version the repository declares");
    const contradicted = await deliver({ action: "tag_release", tag: "v1.0.0" });
    assert.equal(contradicted.status, 409, "a tag the repository contradicts refuses");
    const contradictedBody = (await contradicted.json()) as { error: string; versionMismatch?: { declaredVersion: string; requestedTag: string } };
    assert.match(contradictedBody.error, /declare version 9\.9\.9/);
    assert.deepEqual(contradictedBody.versionMismatch, { declaredVersion: "9.9.9", requestedTag: "v1.0.0" }, "the refusal carries both values so the cockpit can show the evidence");
    // A MATCHING tag passes without any confirmation ("v" prefix is
    // presentation, not identity).
    const agreed = await deliver({ action: "tag_release", tag: "v9.9.9" });
    assert.equal(agreed.status, 200, JSON.stringify(await agreed.clone().json()));
    assert.equal(((await agreed.json()) as { delivery: { status: string; releaseTag: string | null } }).delivery.releaseTag, "v9.9.9");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/runs/:id/reconcile-delivery observes the remote read-only and reports the matches/diverged/unobserved trichotomy per artifact", async () => {
  // DH-645 S3. Seeds a run whose delivery record spans three repositories —
  // one pushed-and-merged (matching remote), one with a closed-without-merge
  // draft PR (diverged), and one whose gh reads are refused (unobserved) —
  // directly against the ledger, AFTER startDashboard() (S1's lesson:
  // reconcileInterruptedRuns() runs once at startup and would otherwise
  // reconcile a seeded-before-start run's status out from under this test).
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-reconcile-http-"));
  const project = await createRepository(root);
  await initializeProject(project);

  const runner = async (request: { command: string; args: string[] }) => {
    const joined = request.args.join(" ");
    if (request.command === "git" && request.args[0] === "ls-remote" && request.args.includes("--tags")) {
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "ls-remote" && joined.includes("recon-matches")) {
      return { stdout: `${"b".repeat(40)}\trefs/heads/devharmonics/recon-matches\n`, stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "ls-remote" && joined.includes("recon-diverged")) {
      return { stdout: `${"e".repeat(40)}\trefs/heads/devharmonics/recon-diverged\n`, stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "ls-remote" && joined.includes("recon-unobserved")) {
      return { stdout: `${"e".repeat(40)}\trefs/heads/devharmonics/recon-unobserved\n`, stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };

  // Route pull requests by their URL (each repository gets a distinct PR
  // number) rather than cwd, since every repository fixture shares one local
  // checkout in this test.
  const routedRunner = async (request: { command: string; args: string[]; cwd: string }) => {
    if (request.command === "gh" && request.args[1] === "view") {
      const pullRequestUrl = request.args[2] ?? "";
      if (pullRequestUrl.endsWith("/pull/1")) {
        return { stdout: JSON.stringify({ state: "MERGED", headRefOid: "b".repeat(40), statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
      }
      if (pullRequestUrl.endsWith("/pull/2")) {
        return { stdout: JSON.stringify({ state: "CLOSED", headRefOid: "e".repeat(40), statusCheckRollup: [] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
      }
      if (pullRequestUrl.endsWith("/pull/3")) {
        return { stdout: "", stderr: "gh: not logged in to any GitHub hosts. Run gh auth login", exitCode: 1, durationMs: 1, timedOut: false };
      }
    }
    return runner(request);
  };

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false, deliveryRunner: routedRunner as never });
  const dbPath = path.join(devHarmonicsDirectory(project), "devharmonics.db");
  const seedLedger = new Ledger(dbPath);
  const runId = seedLedger.createRun("Reconcile three repositories", project);
  seedLedger.setRunStatus(runId, "running");
  seedLedger.setRunStatus(runId, "ready", "READY");
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:matches", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), branch: "devharmonics/recon-matches" });
  seedLedger.updateDeliveryRepository(runId, "repo:matches", { status: "merged", pullRequestUrl: "https://github.com/example/fixture/pull/1" });
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:diverged", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "e".repeat(40), branch: "devharmonics/recon-diverged" });
  seedLedger.updateDeliveryRepository(runId, "repo:diverged", { status: "draft_pr_created", pullRequestUrl: "https://github.com/example/fixture/pull/2" });
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:unobserved", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "e".repeat(40), branch: "devharmonics/recon-unobserved" });
  seedLedger.updateDeliveryRepository(runId, "repo:unobserved", { status: "draft_pr_created", pullRequestUrl: "https://github.com/example/fixture/pull/3" });
  seedLedger.close();

  try {
    const missing = await fetch(`${dashboard.url}/api/runs/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/reconcile-delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(missing.status, 404, "an unknown run is a 404, not a server fault");

    const response = await fetch(`${dashboard.url}/api/runs/${runId}/reconcile-delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const { repositories } = (await response.json()) as { repositories: Array<{ repositoryId: string; findings: Array<{ artifact: string; state: string; message: string }>; hasDivergence: boolean; hasUnobserved: boolean }> };
    assert.equal(repositories.length, 3, "one reconciliation result per delivered repository");

    const byRepo = (id: string) => repositories.find((repo) => repo.repositoryId === id)!;

    const matches = byRepo("repo:matches");
    assert.equal(matches.hasDivergence, false);
    assert.equal(matches.hasUnobserved, false);
    assert.ok(matches.findings.every((finding) => finding.state === "matches"), "every observed artifact for the untouched repository matches");
    assert.ok(matches.findings.some((finding) => finding.artifact === "branch"));
    assert.ok(matches.findings.some((finding) => finding.artifact === "pull_request"));
    assert.ok(matches.findings.some((finding) => finding.artifact === "checks"));

    const diverged = byRepo("repo:diverged");
    assert.equal(diverged.hasDivergence, true);
    const prFinding = diverged.findings.find((finding) => finding.artifact === "pull_request")!;
    assert.equal(prFinding.state, "diverged");
    assert.match(prFinding.message, /closed without merging/i, "the finding names the ledger's claim vs. observed reality in plain English");

    const unobserved = byRepo("repo:unobserved");
    assert.equal(unobserved.hasUnobserved, true);
    assert.equal(unobserved.hasDivergence, false, "an unobserved artifact must never be counted as, or presented as, a divergence");
    const prUnobserved = unobserved.findings.find((finding) => finding.artifact === "pull_request")!;
    assert.equal(prUnobserved.state, "unobserved");
    assert.match(prUnobserved.message, /could not check/i, "unobserved is reported as 'could not check', never dropped and never a silent confirmation");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/runs/:id/reconcile-delivery is bounded by a timeout so a hanging tool cannot hang the route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-reconcile-timeout-"));
  const project = await createRepository(root);
  await initializeProject(project);

  const hangingRunner = () => new Promise<never>(() => {}); // never resolves — simulates a hung git/gh process
  const dashboard = await startDashboard({
    projectPath: project,
    port: 0,
    open: false,
    deliveryRunner: hangingRunner as never,
    reconciliationTimeoutMs: 300,
  });
  const dbPath = path.join(devHarmonicsDirectory(project), "devharmonics.db");
  const seedLedger = new Ledger(dbPath);
  const runId = seedLedger.createRun("Reconcile against a hanging tool", project);
  seedLedger.setRunStatus(runId, "running");
  seedLedger.setRunStatus(runId, "ready", "READY");
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:hang", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), branch: "devharmonics/recon-hang" });
  seedLedger.updateDeliveryRepository(runId, "repo:hang", { status: "branch_pushed" });
  seedLedger.close();

  try {
    const startedAt = Date.now();
    const response = await fetch(`${dashboard.url}/api/runs/${runId}/reconcile-delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 200);
    assert.ok(elapsedMs < 5_000, `the route must not hang on a stuck tool, took ${elapsedMs}ms`);
    const { repositories } = (await response.json()) as { repositories: Array<{ findings: Array<{ artifact: string; state: string }> }> };
    const branch = repositories[0]!.findings.find((finding) => finding.artifact === "branch")!;
    assert.equal(branch.state, "unobserved");

    // The server itself must still be responsive after a hung reconciliation
    // call settled — the shared HTTP server was never blocked.
    const stillAlive = await fetch(`${dashboard.url}/api/runs`);
    assert.equal(stillAlive.status, 200);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/inbox projects pending decisions read-only and drops them the instant the ledger shows them resolved", async () => {
  // DH-645 S1. Seeds three kinds of genuinely-waiting decision directly
  // against the ledger, then drives the REAL HTTP endpoint. No
  // orchestrator/CLI fixtures are needed — the inbox is a pure read of
  // ledger state the server already owns.
  //
  // Seeding happens AFTER startDashboard (not before, unlike "the delivery
  // HTTP route..." above): startDashboard() calls
  // Ledger.reconcileInterruptedRuns() once at startup, which auto-pauses any
  // run still 'planning'/'running'/'awaiting_approval' as an orphan of a
  // crashed process (see src/ledger.ts). A run seeded before start would
  // have its 'awaiting_approval' status silently reconciled to 'paused'
  // before this test ever gets to look at it — seeding through a second
  // Ledger connection to the same file AFTER the dashboard is up avoids
  // that and exercises the ordinary "still live" case instead.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-inbox-http-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const dbPath = path.join(devHarmonicsDirectory(project), "devharmonics.db");
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });

  const seedLedger = new Ledger(dbPath);

  // (a) a run awaiting plan approval.
  const planRunId = seedLedger.createRun("Add CSV export to the customer report", project);
  seedLedger.savePlan(planRunId, {
    summary: "Add CSV export",
    recommendedConcurrency: 1,
    revision: 1,
    tasks: [{ id: "t1", title: "Implement export", description: "Implement CSV export", dependencies: [], preferredProvider: "codex" as const, checks: ["diff-check"] }],
  });
  seedLedger.requestPlanApproval(planRunId);

  // (b) a READY run with one repository still needing its next delivery
  // step approved, and one already merged (excluded — tagging is optional).
  const deliverRunId = seedLedger.createRun("Ship the reporting service", project);
  seedLedger.setRunStatus(deliverRunId, "running");
  seedLedger.setRunStatus(deliverRunId, "ready", "READY");
  seedLedger.prepareDeliveryRepository({ runId: deliverRunId, repositoryId: "repo:pending", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), branch: "devharmonics/inbox1" });
  seedLedger.prepareDeliveryRepository({ runId: deliverRunId, repositoryId: "repo:done", localPath: project, baseBranch: "main", baseCommit: "c".repeat(40), headCommit: "d".repeat(40), branch: "devharmonics/inbox2" });
  seedLedger.updateDeliveryRepository(deliverRunId, "repo:done", { status: "merged" });

  // (c) a paused run awaiting owner direction.
  const pausedRunId = seedLedger.createRun("Migrate the billing job", project);
  seedLedger.setRunStatus(pausedRunId, "running");
  seedLedger.pauseRun(pausedRunId, "Needs your decision before continuing");

  seedLedger.close();

  try {
    const before = await (await fetch(`${dashboard.url}/api/runs`)).json();

    const response = await fetch(`${dashboard.url}/api/inbox`);
    assert.equal(response.status, 200);
    const { items } = (await response.json()) as { items: Array<Record<string, any>> };

    const byKind = (kind: string) => items.filter((item) => item.kind === kind);
    assert.equal(byKind("plan_approval").length, 1, "the awaiting-approval run produces exactly one plan approval item");
    assert.equal(byKind("delivery_step_approval").length, 1, "only the pending repository produces a delivery item; the merged one is excluded");
    assert.equal(byKind("paused_run").length, 1, "the paused run produces exactly one paused-run item");

    const plan = byKind("plan_approval")[0]!;
    assert.equal(plan.runId, planRunId);
    assert.equal(typeof plan.title, "string");
    assert.ok(plan.title.length > 0);
    assert.match(plan.evidence, /revision 1/i);
    assert.deepEqual(plan.actionTarget, { view: "runs", control: "approve-run", label: "Open this run to approve the plan" });
    assert.ok(Number.isFinite(Date.parse(plan.waitingSinceIso)), "waitingSinceIso is a real timestamp");

    const delivery = byKind("delivery_step_approval")[0]!;
    assert.equal(delivery.runId, deliverRunId);
    assert.equal(delivery.repositoryId, "repo:pending");
    assert.match(delivery.evidence, /Reviewed commit b{12} on branch devharmonics\/inbox1/);
    assert.equal(delivery.actionTarget.control, "delivery-panel");

    const paused = byKind("paused_run")[0]!;
    assert.equal(paused.runId, pausedRunId);
    assert.equal(paused.evidence, "Needs your decision before continuing");
    assert.equal(paused.actionTarget.control, "resume-run");

    // Read-only: a GET must never mutate the ledger it reads. Hit it again,
    // then compare the FULL /api/runs payload byte-for-byte against the
    // snapshot taken before either GET /api/inbox call.
    await fetch(`${dashboard.url}/api/inbox`);
    const after = await (await fetch(`${dashboard.url}/api/runs`)).json();
    assert.deepEqual(after, before, "GET /api/inbox must not change any run or delivery state");

    // Resolution honesty: approving the plan and completing the delivery
    // step (via a second connection to the SAME ledger file, exactly as a
    // concurrent owner action would) must make both items disappear on the
    // very next projection.
    const mutateLedger = new Ledger(dbPath);
    mutateLedger.approvePlan(planRunId);
    mutateLedger.updateDeliveryRepository(deliverRunId, "repo:pending", { status: "tagged" });
    mutateLedger.close();

    const afterResolution = (await (await fetch(`${dashboard.url}/api/inbox`)).json()) as { items: Array<Record<string, any>> };
    assert.equal(afterResolution.items.filter((item: Record<string, any>) => item.kind === "plan_approval").length, 0, "an approved plan leaves the inbox");
    assert.equal(afterResolution.items.filter((item: Record<string, any>) => item.kind === "delivery_step_approval").length, 0, "a tagged repository leaves the inbox");
    assert.equal(afterResolution.items.filter((item: Record<string, any>) => item.kind === "paused_run").length, 1, "the still-paused run remains");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/inbox also serves the program status view, read-only, grouped by product and by repository path", async () => {
  // DH-645 S2. One endpoint serving the one Inbox view (per the design
  // brief's "the inbox is a route, never a second gate" spirit extended to
  // the program view: one view, one fetch). Seeded AFTER startDashboard for
  // the same reason as the S1 inbox test above: reconcileInterruptedRuns()
  // would otherwise auto-pause a freshly seeded 'running' run.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-program-status-http-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const dbPath = path.join(devHarmonicsDirectory(project), "devharmonics.db");
  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false });

  const seedLedger = new Ledger(dbPath);

  seedLedger.upsertProduct({
    id: "prod-civic",
    name: "CivicSuite",
    organizationUrl: "https://github.com/example/civicsuite",
    description: "",
    repositories: [{
      id: "repo:civic",
      name: "civiccore",
      fullName: "example/civiccore",
      url: "https://github.com/example/civiccore",
      cloneUrl: "https://github.com/example/civiccore.git",
      defaultBranch: "main",
      visibility: "public",
      archived: false,
      sizeKb: 100,
      language: "TypeScript",
      description: null,
      intelligence: {},
    }],
  });

  // (a) a run linked to a registered product via its integration set — must
  // group under the product's NAME.
  const linkedRunId = seedLedger.createRun("Ship the reporting module", project);
  seedLedger.setRunStatus(linkedRunId, "running");
  seedLedger.createIntegrationSet({
    runId: linkedRunId,
    productId: "prod-civic",
    integrationConditions: [],
    repositories: [{ repositoryId: "repo:civic", localPath: project, baseCommit: "a".repeat(40), integrationBranch: "devharmonics/civic", integrationWorktreePath: project }],
  });

  // (b) a run with a task currently retrying — must land in 'retrying',
  // never 'stalled' or 'moving', regardless of how long it has been quiet.
  const retryRunId = seedLedger.createRun("Fix the flaky check", project);
  seedLedger.setRunStatus(retryRunId, "running");
  seedLedger.addTask(retryRunId, { id: "t1", title: "Fix it", description: "d", dependencies: [], preferredProvider: null, checks: [] });
  seedLedger.setTaskStatus(retryRunId, "t1", "working");
  seedLedger.setTaskStatus(retryRunId, "t1", "retry");

  // (c) a run with no product link — must group under its own project path.
  const unlinkedRunId = seedLedger.createRun("Tidy up the standalone tool", project);
  seedLedger.setRunStatus(unlinkedRunId, "running");

  seedLedger.close();

  try {
    const response = await fetch(`${dashboard.url}/api/inbox`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { items: unknown[]; program: { groups: Array<{ key: string; label: string; counts: Record<string, number>; runs: Array<Record<string, any>> }>; totals: Record<string, number> } };

    assert.ok(Array.isArray(body.items), "the existing /api/inbox items field is unchanged");
    assert.ok(body.program, "the response now also carries a program field");

    const allRuns = body.program.groups.flatMap((group) => group.runs);
    const linked = allRuns.find((run) => run.runId === linkedRunId)!;
    const retrying = allRuns.find((run) => run.runId === retryRunId)!;
    const unlinked = allRuns.find((run) => run.runId === unlinkedRunId)!;

    assert.ok(linked, "the product-linked run appears in the program view");
    assert.ok(retrying, "the retrying run appears in the program view");
    assert.ok(unlinked, "the unlinked run appears in the program view");

    assert.equal(retrying.bucket, "retrying");

    const civicGroup = body.program.groups.find((group) => group.runs.some((run) => run.runId === linkedRunId));
    assert.equal(civicGroup?.label, "CivicSuite", "the linked run groups under the registered product's NAME");

    const pathGroup = body.program.groups.find((group) => group.runs.some((run) => run.runId === unlinkedRunId));
    assert.equal(pathGroup?.label, project, "the unlinked run groups under its own repository path");
    assert.notEqual(civicGroup?.key, pathGroup?.key);

    // Read-only: a GET must never mutate the ledger it reads.
    const before = await (await fetch(`${dashboard.url}/api/runs`)).json();
    await fetch(`${dashboard.url}/api/inbox`);
    const after = await (await fetch(`${dashboard.url}/api/runs`)).json();
    assert.deepEqual(after, before, "GET /api/inbox must not change any run, task, or integration-set state");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the tag prefill follows the MERGE commit's declared version once merged, not the reviewed head", async () => {
  // ROUND2-002: the tag GATE judges the merge commit, but the GET prefill used
  // to read the reviewed head. When the merge commit declares a DIFFERENT
  // version than the head (the base advanced, or merge resolution changed the
  // manifest), the cockpit prefilled a version the gate would reject. Here the
  // reviewed head declares 1.0.0 and the merge commit declares 2.0.0: the
  // prefill must read 1.0.0 before merge and 2.0.0 after, matching the gate.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-divergent-prefill-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.runPolicy.allowExternalWrites = true;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const headOid = "b".repeat(40);
  const mergeOid = "c".repeat(40);
  const seedLedger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  const runId = seedLedger.createRun("Deliver with a divergent merge commit", project);
  seedLedger.setRunStatus(runId, "running");
  seedLedger.setRunStatus(runId, "ready", "READY");
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:div", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: headOid, branch: "devharmonics/div1" });
  seedLedger.close();

  let prState = "OPEN";
  const runner = async (request: { command: string; args: string[] }) => {
    const joined = request.args.join(" ");
    if (request.command === "git" && joined === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/div.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    // The reviewed head commit declares 1.0.0; the merge commit declares 2.0.0.
    // The enrichment must resolve from whichever commit it asks `git show` about.
    if (request.command === "git" && request.args[0] === "show" && joined.endsWith(":package.json")) {
      const version = joined.includes(mergeOid) ? "2.0.0" : "1.0.0";
      return { stdout: JSON.stringify({ name: "fixture", version }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "create") {
      return { stdout: "https://github.com/civicsuite/div/pull/12\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("state,isDraft,mergeable")) {
      return { stdout: JSON.stringify({ state: prState, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: headOid, statusCheckRollup: [] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("mergeCommit")) {
      return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: mergeOid } }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "merge") prState = "MERGED";
    if (request.command === "git" && request.args[0] === "rev-parse" && joined.includes("refs/tags/")) {
      return { stdout: "", stderr: "", exitCode: 1, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false, deliveryRunner: runner as never });
  try {
    const deliver = (body: Record<string, unknown>) => fetch(`${dashboard.url}/api/runs/${runId}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: "repo:div", expectedHeadCommit: headOid, ...body }),
    });
    const prefill = async () => {
      const payload = await fetch(`${dashboard.url}/api/runs/${runId}/delivery`).then((response) => response.json()) as {
        delivery: { repositories: Array<{ repositoryId: string; declaredVersion: string | null; mergeCommitOid: string | null }> };
      };
      return payload.delivery.repositories.find((repository) => repository.repositoryId === "repo:div")!;
    };

    // Before a merge commit exists, the reviewed head is the only truth: 1.0.0.
    assert.equal((await deliver({ action: "push_branch" })).status, 200);
    assert.equal((await deliver({ action: "create_draft_pr" })).status, 200);
    const beforeMerge = await prefill();
    assert.equal(beforeMerge.mergeCommitOid, null, "no merge commit is recorded before the merge");
    assert.equal(beforeMerge.declaredVersion, "1.0.0", "before merge the prefill reads the reviewed head");

    // After merge, the prefill must follow the MERGE commit (2.0.0) — the exact
    // artifact the tag gate will judge — never the head's stale 1.0.0.
    const merged = await deliver({ action: "merge_pr" });
    assert.equal(merged.status, 200, JSON.stringify(await merged.clone().json()));
    const afterMerge = await prefill();
    assert.equal(afterMerge.mergeCommitOid, mergeOid, "the merge commit OID is persisted when the merge completes");
    assert.equal(afterMerge.declaredVersion, "2.0.0", "after merge the prefill follows the merge commit, not the head");

    // The gate now agrees with the prefill: the head's stale 1.0.0 is refused,
    // and the merge-commit's 2.0.0 tags cleanly with no mismatch confirmation.
    assert.equal((await deliver({ action: "tag_release", tag: "v1.0.0" })).status, 409, "the stale head version is refused by the gate");
    assert.equal((await deliver({ action: "tag_release", tag: "v2.0.0" })).status, 200, "the merge-commit version tags cleanly");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a transient merge-time gh mergeCommit failure is repaired lazily at read time, never the stale head", async () => {
  // ROUND3-001, failure path 1: the merge succeeds and is durable, but the
  // post-merge `gh pr view ... mergeCommit` lookup fails, so no merge OID is
  // persisted. The old GET fell back to the reviewed head (1.0.0) — exactly the
  // stale prefill ROUND2-002 fixed — and merge_pr cannot retry (it returns early
  // once merged). The GET path must now be the authority: while the gh failure
  // persists it reports the version as temporarily unavailable (never 1.0.0),
  // and once the live PR is readable again it resolves and persists the merge
  // commit's 2.0.0.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-merge-oid-repair-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.runPolicy.allowExternalWrites = true;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const headOid = "b".repeat(40);
  const mergeOid = "c".repeat(40);
  const seedLedger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  const runId = seedLedger.createRun("Deliver with a transient merge-commit lookup failure", project);
  seedLedger.setRunStatus(runId, "running");
  seedLedger.setRunStatus(runId, "ready", "READY");
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:div", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: headOid, branch: "devharmonics/div1" });
  seedLedger.close();

  let prState = "OPEN";
  // The merge-commit lookup fails at merge time and is repaired only after the
  // test clears this flag, standing in for a transient GitHub/API failure that
  // outlives the (early-returning) merge_pr call.
  let failMergeCommitView = true;
  const runner = async (request: { command: string; args: string[] }) => {
    const joined = request.args.join(" ");
    if (request.command === "git" && joined === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/div.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "show" && joined.endsWith(":package.json")) {
      const version = joined.includes(mergeOid) ? "2.0.0" : "1.0.0";
      return { stdout: JSON.stringify({ name: "fixture", version }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "create") {
      return { stdout: "https://github.com/civicsuite/div/pull/12\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("state,isDraft,mergeable")) {
      return { stdout: JSON.stringify({ state: prState, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: headOid, statusCheckRollup: [] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("mergeCommit")) {
      // The real failure: gh exits nonzero with no usable stdout.
      if (failMergeCommitView) return { stdout: "", stderr: "gh: could not read pull request\n", exitCode: 1, durationMs: 1, timedOut: false };
      return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: mergeOid } }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "merge") prState = "MERGED";
    if (request.command === "git" && request.args[0] === "rev-parse" && joined.includes("refs/tags/")) {
      return { stdout: "", stderr: "", exitCode: 1, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false, deliveryRunner: runner as never });
  try {
    const deliver = (body: Record<string, unknown>) => fetch(`${dashboard.url}/api/runs/${runId}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: "repo:div", expectedHeadCommit: headOid, ...body }),
    });
    const prefill = async () => {
      const payload = await fetch(`${dashboard.url}/api/runs/${runId}/delivery`).then((response) => response.json()) as {
        delivery: { repositories: Array<{ repositoryId: string; declaredVersion: string | null; mergeCommitOid: string | null; mergeVersionUnavailable?: boolean }> };
      };
      return payload.delivery.repositories.find((repository) => repository.repositoryId === "repo:div")!;
    };

    assert.equal((await deliver({ action: "push_branch" })).status, 200);
    assert.equal((await deliver({ action: "create_draft_pr" })).status, 200);

    // The merge is durable even though the merge-commit lookup failed; no OID
    // is persisted.
    const merged = await deliver({ action: "merge_pr" });
    assert.equal(merged.status, 200, JSON.stringify(await merged.clone().json()));
    assert.equal(((await merged.json()) as { delivery: { mergeCommitOid: string | null } }).delivery.mergeCommitOid, null, "a failed merge-commit lookup leaves the OID unpersisted");

    // While the live PR is still unreadable, GET is honest: temporarily
    // unavailable, NOT the stale head 1.0.0.
    const stillFailing = await prefill();
    assert.equal(stillFailing.declaredVersion, null, "with the merge OID unresolvable, the prefill is null — never the stale head");
    assert.equal(stillFailing.mergeVersionUnavailable, true, "the caller gets an explicit retry signal");

    // Once the live PR is readable again, GET resolves the merge commit (2.0.0),
    // persists the OID, and never returns the head's 1.0.0.
    failMergeCommitView = false;
    const repaired = await prefill();
    assert.equal(repaired.mergeCommitOid, mergeOid, "the merge OID is re-resolved and persisted at read time");
    assert.equal(repaired.declaredVersion, "2.0.0", "the prefill follows the merge commit, never the reviewed head 1.0.0");
    assert.notEqual(repaired.mergeVersionUnavailable, true, "resolved reads carry no unavailable signal");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a persisted merge OID whose object is not local is fetched at read time, never null or the head", async () => {
  // ROUND3-001, failure path 2: the merge-commit OID IS persisted, but the
  // merge-time fetch failed, so the object is not in the local store. The old
  // GET ran `git show` on the missing object and yielded no version at all (not
  // even the head fallback the comment promised). The GET path must fetch the
  // merge commit before reading it: while the fetch keeps failing it reports the
  // version as temporarily unavailable, and once the fetch succeeds it returns
  // the merge commit's 2.0.0 — never null, never the head.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-merge-fetch-repair-"));
  const project = await createRepository(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  config.runPolicy.allowExternalWrites = true;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const headOid = "b".repeat(40);
  const mergeOid = "c".repeat(40);
  const seedLedger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  const runId = seedLedger.createRun("Deliver with an unfetched merge commit", project);
  seedLedger.setRunStatus(runId, "running");
  seedLedger.setRunStatus(runId, "ready", "READY");
  seedLedger.prepareDeliveryRepository({ runId, repositoryId: "repo:div", localPath: project, baseBranch: "main", baseCommit: "a".repeat(40), headCommit: headOid, branch: "devharmonics/div1" });
  seedLedger.close();

  let prState = "OPEN";
  // The merge object becomes local only once a fetch succeeds; the merge-time
  // fetch (and the first GET-time fetch) fail, standing in for a network/API
  // failure that leaves the merge commit unavailable locally.
  let fetchWorks = false;
  let mergeObjectLocal = false;
  const runner = async (request: { command: string; args: string[] }) => {
    const joined = request.args.join(" ");
    if (request.command === "git" && joined === "remote get-url origin") {
      return { stdout: "https://github.com/civicsuite/div.git\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "fetch") {
      if (fetchWorks) {
        mergeObjectLocal = true;
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
      }
      return { stdout: "", stderr: "fatal: could not fetch\n", exitCode: 1, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "cat-file") {
      // The merge object is present only after a successful fetch; the head is
      // always local.
      const present = joined.includes(mergeOid) ? mergeObjectLocal : true;
      return { stdout: present ? `${joined}\n` : "", stderr: present ? "" : "fatal: Not a valid object name\n", exitCode: present ? 0 : 1, durationMs: 1, timedOut: false };
    }
    if (request.command === "git" && request.args[0] === "show" && joined.endsWith(":package.json")) {
      if (joined.includes(mergeOid)) {
        if (!mergeObjectLocal) return { stdout: "", stderr: "fatal: invalid object name\n", exitCode: 128, durationMs: 1, timedOut: false };
        return { stdout: JSON.stringify({ name: "fixture", version: "2.0.0" }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
      }
      return { stdout: JSON.stringify({ name: "fixture", version: "1.0.0" }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "create") {
      return { stdout: "https://github.com/civicsuite/div/pull/12\n", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("state,isDraft,mergeable")) {
      return { stdout: JSON.stringify({ state: prState, isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: headOid, statusCheckRollup: [] }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "view" && joined.includes("mergeCommit")) {
      return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: mergeOid } }), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    }
    if (request.command === "gh" && request.args[1] === "merge") prState = "MERGED";
    if (request.command === "git" && request.args[0] === "rev-parse" && joined.includes("refs/tags/")) {
      return { stdout: "", stderr: "", exitCode: 1, durationMs: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
  };

  const dashboard = await startDashboard({ projectPath: project, port: 0, open: false, deliveryRunner: runner as never });
  try {
    const deliver = (body: Record<string, unknown>) => fetch(`${dashboard.url}/api/runs/${runId}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: "repo:div", expectedHeadCommit: headOid, ...body }),
    });
    const prefill = async () => {
      const payload = await fetch(`${dashboard.url}/api/runs/${runId}/delivery`).then((response) => response.json()) as {
        delivery: { repositories: Array<{ repositoryId: string; declaredVersion: string | null; mergeCommitOid: string | null; mergeVersionUnavailable?: boolean }> };
      };
      return payload.delivery.repositories.find((repository) => repository.repositoryId === "repo:div")!;
    };

    assert.equal((await deliver({ action: "push_branch" })).status, 200);
    assert.equal((await deliver({ action: "create_draft_pr" })).status, 200);

    // The OID is persisted at merge time, but the merge-time fetch failed, so
    // the object is not local.
    const merged = await deliver({ action: "merge_pr" });
    assert.equal(merged.status, 200, JSON.stringify(await merged.clone().json()));
    assert.equal(((await merged.json()) as { delivery: { mergeCommitOid: string | null } }).delivery.mergeCommitOid, mergeOid, "the merge OID is persisted even though its object was not fetched");
    assert.equal(mergeObjectLocal, false, "the merge-time fetch failed, so the object is not local");

    // While the fetch keeps failing, GET is honest: temporarily unavailable,
    // NOT null-forever and NOT the head.
    const stillMissing = await prefill();
    assert.equal(stillMissing.declaredVersion, null, "an unfetchable merge object yields no version — never the head");
    assert.equal(stillMissing.mergeVersionUnavailable, true, "the caller gets an explicit retry signal");
    assert.equal(stillMissing.mergeCommitOid, mergeOid, "the persisted OID is preserved through the failed read");

    // Once the fetch succeeds, GET fetches the merge commit and returns 2.0.0.
    fetchWorks = true;
    const repaired = await prefill();
    assert.equal(repaired.declaredVersion, "2.0.0", "the read path fetches the merge commit and returns its version, never null");
    assert.notEqual(repaired.mergeVersionUnavailable, true, "resolved reads carry no unavailable signal");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("run provenance pins before execution and survives pause and resume", async () => {
  // Audit DH810-AUD-001/002 at the orchestrator: an unknown pin refuses
  // BEFORE any run row exists, a valid pin is recorded at run creation, and a
  // recovery run keeps the objective linkage and exact workflow revision.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-provenance-resume-"));
  const project = await createRepository(root);
  const command = await createFakeCli(root);
  await initializeProject(project);
  const config = await loadConfig(project);
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(project), "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const ledger = new Ledger(path.join(devHarmonicsDirectory(project), "devharmonics.db"));
  const orchestrator = new Orchestrator(ledger);
  try {
    assert.throws(
      () => orchestrator.begin({ goal: "forged", projectPath: project, workflowRevisionHash: "f".repeat(64) }),
      /unknown workflow revision/i,
      "an unknown pin refuses before a run exists",
    );
    assert.equal(ledger.listRuns().length, 0, "the refused start created no run");

    const workflows = await import("../src/workflows.js") as Record<string, any>;
    const parsed = workflows.parseWorkflowDocument(await readFile(path.join(process.cwd(), "workflows", "release-truth-audit.json"), "utf-8"));
    assert.equal(parsed.ok, true);
    const recorded = (ledger as Ledger & Record<string, any>).recordWorkflowRevision({ workflow: parsed.workflow });

    // The pinned run also carries a real objective/plan linkage, so resume
    // must preserve BOTH (round-3 note on AUD-002: the hash alone is not the
    // whole provenance chain).
    const instantiated = workflows.instantiateWorkflow({ workflow: parsed.workflow, inputs: { repositoryId: "repo:docs", tag: "v0.0.1" }, projectPath: project, repositoryIds: [] });
    assert.equal(instantiated.ok, true, JSON.stringify(instantiated.issues ?? []));
    const objective = ledger.createObjective(instantiated.objective);
    ledger.appendPlanRevision(objective.id, {
      summary: "Audit the release",
      recommendedConcurrency: 1,
      tasks: [{ id: "audit", title: "Audit", description: "Audit the release claims", dependencies: [], preferredProvider: "codex" as const, checks: ["diff-check"] }],
    }, "Single audit task");
    const approved = ledger.approvePlanRevision(objective.id, 1);

    const runId = orchestrator.begin({
      goal: "workflow run",
      projectPath: project,
      autonomy: "observe",
      workflowRevisionHash: recorded.revisionHash,
      objectiveLink: { objectiveId: objective.id, approvedPlanRevision: approved.revision },
    });
    assert.equal(ledger.getRun(runId)?.workflowRevisionHash, recorded.revisionHash, "the pin is recorded at run creation, before execution");
    orchestrator.pause(runId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (ledger.getRun(runId)?.status !== "paused") ledger.pauseRun(runId);
    const resumedId = orchestrator.resume(runId);
    assert.ok(resumedId, "the paused run resumes");
    const resumed = ledger.getRun(resumedId!);
    assert.equal(resumed?.workflowRevisionHash, recorded.revisionHash, "the recovery run keeps the exact workflow revision");
    assert.equal(resumed?.objectiveId, objective.id, "the recovery run keeps the objective linkage");
    assert.equal(resumed?.approvedPlanRevision, approved.revision, "the recovery run keeps the approved plan revision");
  } finally {
    await orchestrator.shutdown();
    ledger.close();
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
    // Slice A: the composer's own h1 lost its bespoke copy in favor of a
    // shared VIEW_DESCRIPTIONS title + purpose sentence rendered in the
    // topbar for every view — this pins the new canonical Runs purpose line.
    assert.match(pageText, /Define an objective, approve the team's plan, and watch the work happen\./);
    assert.match(pageText, /aria-label="Agent count"/);
    assert.match(pageText, /id="run-autonomy"/);
    assert.match(pageText, /id="delivery-panel"/);
    const appText = await fetch(`${dashboard.url}/app.js`).then((response) => response.text());
    assert.match(appText, /create_draft_pr/);
    assert.match(appText, /Approve &amp; push branch/);
    // Slice A: "PR" was unexplained shorthand — the button now spells out
    // "pull request" to match the rest of the delivery panel's wording.
    assert.match(appText, /Approve &amp; create draft pull request/);
    // Owner-corrected rule (2026-07-22): the cockpit COMPLETES the delivery.
    // Merge and tag exist as owner-approved actions; what must never exist is
    // a merge that happens without a confirmation carrying the approval.
    assert.match(appText, /data-delivery-action="merge_pr"/, "the cockpit exposes an owner-approved merge action");
    assert.match(appText, /data-delivery-action="tag_release"/, "the cockpit exposes an owner-approved tag action");
    assert.match(appText, /window\.confirm/, "every delivery action runs behind an explicit owner confirmation");
    const bootstrap = await fetch(`${dashboard.url}/api/bootstrap`);
    const value = (await bootstrap.json()) as {
      product: { name: string; version: string };
      defaultProject: string;
      providers: Array<{ name: string; setupSteps: string[] }>;
    };
    assert.deepEqual(value.product, { name: "DevHarmonics", version: "0.6.1" });
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
    // Gate finding QA-2 (2026-07-22): a config document the schema refuses is
    // a CLIENT fault — 400, not the 500 this test previously accepted.
    assert.equal(invalidConfigResponse.status, 400);
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
    assert.match(indexHtml, /\/app\.css\?v=0\.6\.1/);
    assert.match(indexHtml, /\/app\.js\?v=0\.6\.1/);
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");
    assert.equal(indexResponse.headers.get("expires"), "0");

    const appScript = await fetch(`${dashboard.url}/app.js?v=0.6.1`).then((response) => response.text());
    assert.match(appScript, /new EventSource/);
    assert.doesNotMatch(appScript, /setInterval\(refreshRuns/);
    assert.match(appScript, /autonomy:\s*\$\("#run-autonomy"\)\.value/);
    assert.match(appScript, /window\.scrollTo\(\{\s*top:\s*0/);
    assert.match(appScript, /\/api\/runs\/\$\{runId\}\/report/);
    assert.match(appScript, /\/api\/runs\/\$\{runId\}\/evidence\/export/);
    assert.match(appScript, /data-qualify-benchmark/);
    assert.match(appScript, /model\.qualified\s*&&\s*!model\.qualificationStale\s*&&\s*!model\.excluded/);
    assert.match(appScript, /This model needs an extra accuracy test before it can be used/);
    assert.match(appScript, /function isModelSchedulable\(model\)/);
    assert.match(appScript, /function hasCurrentOperationalQualification\(model\)/);
    assert.match(appScript, /function hasCurrentQualificationForUiRole\(model, role\)/);
    assert.match(appScript, /hasCurrentQualificationForUiRole\(model, role\)/);
    assert.match(appScript, /not currently role-qualified/);
    assert.match(appScript, /isModelSchedulable\(qualifiedModel\)\s*\?\s*"It's active and ready to be used\."/);
    assert.match(appScript, /Passed a role check/);
    assert.match(appScript, /Passed some roles, failed others — see qualification history below/);
    assert.match(appScript, /Hasn't passed a role check yet — can't be used/);

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

    const appStyles = await fetch(`${dashboard.url}/app.css?v=0.6.1`).then((response) => response.text());
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

test("a run starts when its reviewer is not yet qualified but can be", async () => {
  // The third attempt at the first real cross-repository run was refused with
  // "no subscription or qualified local reviewer is available" while both
  // subscriptions were ready. Earlier runs had left every connection carrying a
  // current WORKER qualification, which suppresses the provider default, and
  // nothing was reviewer-qualified yet — reviewers are qualified on first use.
  // A gate that demands current routability refuses work that would qualify a
  // reviewer moments later.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-reviewer-firstuse-"));
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
    // Exactly the state a prior run leaves: a current, active, non-stale
    // qualification for ANOTHER role on every connection, so no connection
    // offers its provider default, and nothing is reviewer-qualified.
    for (const provider of ["codex", "claude", "gemini"] as const) {
      const connectionId = `subscription-cli:${provider}`;
      ledger.upsertConnection({ id: connectionId, provider, transport: "subscription_cli", authentication: "subscription", displayName: provider, enabled: true, installed: true, authenticated: true, visible: true, healthy: true, available: true, entitlement: "unknown", capacity: "unknown", adapterVersion: "test", runtimeVersion: "test", metadata: {} });
      const modelId = `${connectionId}:model:seeded`;
      ledger.upsertDiscoveredModel({ id: modelId, connectionId, canonicalName: "seeded", displayName: "seeded", source: "provider_catalog", lifecycle: "known", visible: true, verified: false, qualified: false, active: false, metadata: profileMetadata({ tier: "premium", family: "seeded", capabilities: ["text", "code"], source: "catalog" }) });
      ledger.recordModelQualification({ modelId, fixtureVersion: "test", role: "worker", passed: true, score: 1, evidence: {} });
      ledger.setModelPreference(modelId, { active: true });
    }

    runId = await new Orchestrator(ledger).run({ goal: "Audit fixture without changing it", projectPath: project, autonomy: "observe", agents: 1 });
    const run = ledger.getRun(runId);
    assert.doesNotMatch(
      `${run?.finalReview ?? ""}`,
      /qualified local reviewer is available/i,
      "a reviewer that can be qualified on first use must not be treated as absent",
    );
    assert.ok((run?.tasks ?? []).length > 0, `the run executed rather than being refused: ${run?.finalReview}`);
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

test("a write task that changes nothing does not pass", async () => {
  // The first real cross-repository run marked both tasks PASSED having changed
  // no files at all. The workers narrated their intentions and edited nothing;
  // diff-check passed because there was no diff to fault, and tests passed
  // because nothing was broken. Only the independent reviewer noticed, and only
  // because it looked for a diff that did not exist.
  //
  // A workspace_write task that produced no repository change has not done its
  // work, whatever it claims. Saying so is deterministic and costs one git call.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-noop-worker-"));
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
    runId = await new Orchestrator(ledger).run({ goal: "No-op fixture: apply the corrections", projectPath: project, agents: 1 });
    const run = ledger.getRun(runId);
    const task = run?.tasks.find((item) => !item.id.startsWith("__"));
    assert.ok(task, "a task was planned");
    assert.notEqual(task.status, "passed", `a task that changed nothing must not pass: ${JSON.stringify(run?.tasks.map((t) => ({ id: t.id, status: t.status })))}`);
    assert.ok(
      (run?.events ?? []).some((event) => /no repository change/i.test(event.message)),
      `the run says the task produced nothing: ${JSON.stringify((run?.events ?? []).map((event) => event.message).slice(0, 12))}`,
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

test("a cross-repository architect is told the validators its repositories actually register", async () => {
  // The architect is instructed that every check name must come from the
  // allowlisted validators. It was handed the PROJECT's names while the affected
  // repositories registered different ones, so the first real cross-repository
  // run planned `test` against repositories that have `tests`, and every task
  // failed with "unknown validator". Asserting the helper could not catch this —
  // the defect was in what the production call passed.
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-architect-vocab-"));
  const core = await createRepository(path.join(root, "core"));
  const docs = await createRepository(path.join(root, "docs"));
  await git(core, ["remote", "add", "origin", "https://github.com/vocab-product/core.git"]);
  await git(docs, ["remote", "add", "origin", "https://github.com/vocab-product/docs.git"]);
  const command = await createFakeCli(root);
  await initializeProject(core);
  const config = await loadConfig(core);
  config.product.architect = "claude";
  config.product.reviewer = "gemini";
  config.product.workers = ["codex"];
  for (const provider of ["codex", "claude", "gemini"] as const) config.connections[provider].command = command;
  await writeFile(path.join(devHarmonicsDirectory(core), "config.json"), `${JSON.stringify(config, null, 2)}
`, "utf8");

  const captured = path.join(root, "architect-prompt.txt");
  process.env.DH_CAPTURE_ARCHITECT_PROMPT = captured;
  const dashboard = await startDashboard({ projectPath: core, port: 0, open: false });
  try {
    const productResponse = await fetch(`${dashboard.url}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "vocab-product",
        name: "Vocab product",
        organizationUrl: "https://github.com/vocab-product",
        repositories: [
          { id: "repo:core", name: "core", fullName: "vocab-product/core", url: "https://github.com/vocab-product/core", cloneUrl: "https://github.com/vocab-product/core.git", defaultBranch: "main", visibility: "public", archived: false, sizeKb: 10, language: "Python", description: "Core", intelligence: {} },
          { id: "repo:docs", name: "docs", fullName: "vocab-product/docs", url: "https://github.com/vocab-product/docs", cloneUrl: "https://github.com/vocab-product/docs.git", defaultBranch: "main", visibility: "public", archived: false, sizeKb: 10, language: "Markdown", description: "Docs", intelligence: {} },
        ],
      }),
    });
    assert.equal(productResponse.status, 201, await productResponse.clone().text());
    for (const [localPath, role, validators] of [
      [core, "module", { "repo-only-lint": "git diff --check" }],
      [docs, "documentation", { "repo-only-docs-check": "git diff --check" }],
    ] as const) {
      const response = await fetch(`${dashboard.url}/api/products/vocab-product/repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localPath, role, expectedBranch: "main", owners: ["fixture"], dependencyRepositoryIds: [], governanceSources: ["README.md"], validators }),
      });
      assert.equal(response.status, 201, await response.clone().text());
    }

    const objectiveResponse = await fetch(`${dashboard.url}/api/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "Cross repository fixture: implement and document the product change",
        acceptanceCriteria: ["Both repositories contain the approved result"],
        constraints: [],
        projectPath: core,
        productId: "vocab-product",
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

    const prompt = await readFile(captured, "utf8");
    const allowlist = /Allowlisted validators: (.+)/.exec(prompt)?.[1] ?? "";
    assert.match(allowlist, /repo-only-lint/, "the architect is offered the validators the affected repositories register");
    assert.match(allowlist, /repo-only-docs-check/, "including every affected repository, not just the first");
    assert.match(allowlist, /diff-check/, "and the project's own validators remain available");

    // BOTH SIDES of the contract. Offering a vocabulary the plan validator then
    // rejects is the same drift twice: the architect was told to choose from the
    // repositories' validators and then refused for doing so. A plan naming a
    // repository-registered validator must be accepted.
    const revision = await planResponse.json() as { revision: { plan: { tasks: Array<{ id: string; checks: string[] }> } } };
    const planned = revision.revision.plan.tasks.flatMap((task) => task.checks);
    assert.ok(
      planned.some((check) => check === "repo-only-lint" || check === "repo-only-docs-check"),
      `the accepted plan uses a repository-registered validator: ${JSON.stringify(revision.revision.plan.tasks.map((t) => ({ id: t.id, checks: t.checks })))}`,
    );
  } finally {
    delete process.env.DH_CAPTURE_ARCHITECT_PROMPT;
    await dashboard.close();
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
    // Gitignored, so it lives in the primary checkout without dirtying the tree
    // and never appears in a task worktree.
    await writeFile(path.join(docs, ".gitignore"), "root-token-probe.mjs\n", "utf8");
    await git(docs, ["add", ".gitignore"]);
    await git(docs, ["commit", "-m", "chore: ignore the root-token probe"]);
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
        body: JSON.stringify({ localPath, role, expectedBranch: "main", owners: ["fixture"], dependencyRepositoryIds: [], governanceSources: ["README.md"], validators: role === "module" ? { "diff-check": "git diff --check", "defect-free": `node -e "const p=require('path');process.exit(!process.cwd().includes(p.sep+'tasks'+p.sep)&&require('fs').existsSync('needs-fix.txt')?1:0)"` } : { "diff-check": "node ${repoRoot}/root-token-probe.mjs" } }),
      });
      assert.equal(response.status, 201, await response.clone().text());
    }

    // The docs repository's registered validator is `node ${repoRoot}/root-token-probe.mjs`,
    // and this script exists ONLY in that repository's primary checkout — it is
    // never committed, so no task worktree contains it. The validator therefore
    // passes only if production expanded the token against the REGISTERED
    // repository's own root. Testing the helper directly could not catch a
    // production call site that stopped calling it; this drives the real loop.
    await writeFile(path.join(docs, "root-token-probe.mjs"), "process.stdout.write('ROOT_TOKEN_PROBE_OK');\n", "utf8");

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
    const detail = await fetch(`${dashboard.url}/api/runs/${runId}`).then((response) => response.json() as Promise<{
      tasks: Array<{ id: string; checks?: Array<{ name: string; passed: boolean; stdout?: string; stderr?: string }> }>;
    }>);
    const tokenCheck = detail.tasks
      .filter((task) => task.id.includes("docs"))
      .flatMap((task) => task.checks ?? [])
      .find((check) => check.name === "diff-check");
    assert.ok(tokenCheck, `the docs task ran its registered validator: ${JSON.stringify(detail.tasks.map((task) => ({ id: task.id, checks: (task.checks ?? []).map((c) => c.name) })))}`);
    assert.equal(tokenCheck.passed, true, `the token must expand against the registered repository's own root: ${JSON.stringify(tokenCheck)}`);
    assert.match(tokenCheck.stdout ?? "", /ROOT_TOKEN_PROBE_OK/);

    assert.equal(run.status, "ready", run.finalReview ?? "run did not become ready");
    assert.match(run.finalReview ?? "", /repo:core .* -> .*repo:docs/s);

    const integrationResponse = await fetch(`${dashboard.url}/api/runs/${runId}/integration-set`);
    assert.equal(integrationResponse.status, 200, await integrationResponse.clone().text());
    integrationSet = await integrationResponse.json() as IntegrationSetFixture;
    assert.ok(integrationSet);
    assert.equal(integrationSet.repositories.length, 2);
    const byId = new Map(integrationSet.repositories.map((repository) => [repository.repositoryId, repository]));
    // Proof the token reached the shipping path: the docs check ran the script
    // that lives only in the primary checkout.

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
    assert.match(pageText, /Ask AI models about this project/);
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
    assert.match(appScript, /Pause requested/, "a pending hold is reported as requested, not as held");
    assert.match(appScript, /takes effect once the current task finishes/, "the panel says when a request takes effect");
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
