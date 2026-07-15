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
  const plan = {summary:"fixture plan",recommendedConcurrency:1,tasks:[task]};
  console.log(JSON.stringify({result:JSON.stringify(plan)}));
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
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"README.md:1 contains the heading Fixture. This directly satisfies the assigned diagnostic criterion, and the read-only inspection identified no contradictory heading elsewhere. No files were changed."}}));
} else if (input.includes("Resolve review findings")) {
  if (existsSync("needs-fix.txt")) unlinkSync("needs-fix.txt");
  writeFileSync("result.txt", "corrected by independent fixer\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Removed needs-fix.txt and created corrected result.txt"}}));
} else if (input.includes("Fixer fixture")) {
  writeFileSync("needs-fix.txt", "defect marker\\n", "utf8");
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Created needs-fix.txt for review"}}));
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
        adapter_version: "0.4.0",
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
    const bootstrap = await fetch(`${dashboard.url}/api/bootstrap`);
    const value = (await bootstrap.json()) as {
      product: { name: string; version: string };
      defaultProject: string;
      providers: Array<{ name: string; setupSteps: string[] }>;
    };
    assert.deepEqual(value.product, { name: "DevHarmonics", version: "0.4.0" });
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
    assert.equal(exportValue.evidenceVersion, 3);
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
    assert.match(indexHtml, /\/app\.css\?v=0\.4\.0/);
    assert.match(indexHtml, /\/app\.js\?v=0\.4\.0/);
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");
    assert.equal(indexResponse.headers.get("expires"), "0");

    const appScript = await fetch(`${dashboard.url}/app.js?v=0.4.0`).then((response) => response.text());
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

    const appStyles = await fetch(`${dashboard.url}/app.css?v=0.4.0`).then((response) => response.text());
    assert.match(appStyles, /@media \(max-width:\s*1200px\)[\s\S]*?\.board\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(appStyles, /@media \(max-width:\s*950px\)[\s\S]*?\.run-list\s*\{[\s\S]*?display:\s*flex/);
    assert.match(appStyles, /\.app-shell\s*\{[^}]*overflow-x:\s*clip/);
    assert.match(appStyles, /\.run-list\s*\{[^}]*max-width:\s*100%/);
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
