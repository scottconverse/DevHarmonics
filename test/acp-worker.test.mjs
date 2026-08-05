import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAcpWorker, choosePermissionOption } from "../scripts/acp-worker.mjs";
import { validateReceipt } from "../scripts/receipts.mjs";

// GAUNTLET (Agent B): under allow-edits the grant is no longer kind-only — an
// edit whose declared file location escapes the workspace cwd is refused.
test("allow-edits grants an in-workspace edit but refuses one whose location escapes cwd", () => {
  const cwd = process.platform === "win32" ? "C:\\ws" : "/ws";
  const opts = [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }];
  const mk = (locations) => ({ options: opts, toolCall: { kind: "edit", locations } });

  // in-workspace relative + absolute-inside -> allowed
  const inside = choosePermissionOption(mk([{ path: "src/app.js" }]), "allow-edits", cwd);
  assert.equal(inside?.kind, "allow_once");
  // escaping location (traversal) -> refused, even though kind is "edit"
  const escape = choosePermissionOption(mk([{ path: "../../etc/passwd" }]), "allow-edits", cwd);
  assert.equal(escape?.kind, "reject_once", "an edit targeting outside cwd must be refused");
  // absolute path elsewhere -> refused
  const abs = choosePermissionOption(mk([{ path: process.platform === "win32" ? "C:\\Windows\\x" : "/etc/x" }]), "allow-edits", cwd);
  assert.equal(abs?.kind, "reject_once");
  // one good + one escaping -> refused (all must be inside)
  const mixed = choosePermissionOption(mk([{ path: "ok.js" }, { path: "../out.js" }]), "allow-edits", cwd);
  assert.equal(mixed?.kind, "reject_once");
  // a non-edit kind is still refused; deny still refuses an in-workspace edit
  assert.equal(choosePermissionOption({ options: opts, toolCall: { kind: "delete", locations: [{ path: "src/app.js" }] } }, "allow-edits", cwd)?.kind, "reject_once");
  assert.equal(choosePermissionOption(mk([{ path: "src/app.js" }]), "deny", cwd)?.kind, "reject_once");
});

/**
 * Hermetic, real-protocol tests: the worker under test spawns
 * test/fixtures/fake-acp-agent.mjs, a genuine ACP agent built on the SAME
 * SDK, so every round-trip here (initialize, session/new, session/update
 * notifications, a permission request, session/prompt completion) is the
 * real wire protocol with zero AI involved.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = path.join(__dirname, "fixtures", "fake-acp-agent.mjs");

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readEvents(runDir) {
  return readFileSync(path.join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function envWith(behavior, extra = {}) {
  return { ...process.env, FAKE_ACP_BEHAVIOR: behavior, ...extra };
}

test("happy path (allow-edits): final text, ordered events, granted permission, valid receipt", async () => {
  const runsRoot = tmp("dh-acp-runs-");
  const cwd = tmp("dh-acp-cwd-");
  try {
    const { receipt, runDir, permissionRequests } = await runAcpWorker({
      taskId: "acp-happy",
      provider: "claude",
      adapterCommand: process.execPath,
      adapterArgs: [fixture],
      prompt: "please edit config.json",
      cwd,
      runsRoot,
      permissionMode: "allow-edits",
      timeoutMs: 30_000,
      env: envWith("ok"),
    });

    assert.equal(receipt.status, "completed");
    assert.equal(receipt.lane, "acp");
    assert.equal(receipt.resolvedModel, "fake-acp-model-1");
    assert.equal(receipt.resolutionVerified, true);
    assert.deepEqual(receipt.usage, { inputTokens: 30, outputTokens: 12, totalTokens: 42 });

    const validation = validateReceipt(receipt);
    assert.deepEqual(validation.errors, []);
    assert.equal(validation.ok, true);

    const finalText = readFileSync(path.join(runDir, "final-text.txt"), "utf8");
    assert.equal(finalText, "Looking at the repository before editing.Edited config.json successfully.");

    const events = readEvents(runDir);
    const sessionUpdateKinds = events
      .filter((e) => e.type === "session_update")
      .map((e) => e.notification.update.sessionUpdate);
    assert.deepEqual(sessionUpdateKinds, ["agent_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);

    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].kind, "edit");
    assert.deepEqual(permissionRequests[0].answer, { outcome: "selected", optionId: "allow" });

    const permissionEvents = events.filter((e) => e.type === "permission_request");
    assert.equal(permissionEvents.length, 1);
    assert.deepEqual(permissionEvents[0].answer, { outcome: "selected", optionId: "allow" });

    assert.ok(existsSync(path.join(runDir, "receipt.json")));
  } finally {
    for (const d of [runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("deny policy: the edit permission is refused, agent honors it, receipt still completed", async () => {
  const runsRoot = tmp("dh-acp-runs-");
  const cwd = tmp("dh-acp-cwd-");
  try {
    const { receipt, runDir, permissionRequests } = await runAcpWorker({
      taskId: "acp-deny",
      provider: "claude",
      adapterCommand: process.execPath,
      adapterArgs: [fixture],
      prompt: "please edit config.json",
      cwd,
      runsRoot,
      permissionMode: "deny",
      timeoutMs: 30_000,
      env: envWith("ok"),
    });

    assert.equal(receipt.status, "completed");
    assert.equal(permissionRequests.length, 1);
    assert.deepEqual(permissionRequests[0].answer, { outcome: "selected", optionId: "reject" });

    const finalText = readFileSync(path.join(runDir, "final-text.txt"), "utf8");
    assert.equal(finalText, "Looking at the repository before editing.I could not edit the file: permission was refused.");

    assert.equal(validateReceipt(receipt).ok, true);
  } finally {
    for (const d of [runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("adapter exits with a protocol error before responding: failed receipt, error captured, no hang", async () => {
  const runsRoot = tmp("dh-acp-runs-");
  const cwd = tmp("dh-acp-cwd-");
  try {
    const { receipt } = await runAcpWorker({
      taskId: "acp-protoerr",
      provider: "claude",
      adapterCommand: process.execPath,
      adapterArgs: [fixture],
      prompt: "p",
      cwd,
      runsRoot,
      permissionMode: "deny",
      timeoutMs: 15_000,
      env: envWith("protocol-error"),
    });

    assert.equal(receipt.status, "failed");
    assert.ok(receipt.exit.error, "a captured error message");
    assert.equal(validateReceipt(receipt).ok, true);
  } finally {
    for (const d of [runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("timeout: a prompt turn that never completes yields a timeout receipt and the adapter tree is dead", async () => {
  const runsRoot = tmp("dh-acp-runs-");
  const cwd = tmp("dh-acp-cwd-");
  const pidFile = path.join(tmp("dh-acp-pidfile-"), "pid.txt");
  try {
    const { receipt } = await runAcpWorker({
      taskId: "acp-timeout",
      provider: "claude",
      adapterCommand: process.execPath,
      adapterArgs: [fixture],
      prompt: "p",
      cwd,
      runsRoot,
      permissionMode: "deny",
      timeoutMs: 1500,
      env: envWith("hang", { FAKE_ACP_PIDFILE: pidFile }),
    });

    assert.equal(receipt.status, "timeout");
    assert.equal(receipt.exit.timedOut, true);
    assert.equal(validateReceipt(receipt).ok, true);

    assert.ok(existsSync(pidFile), "the fake agent must have started and recorded its pid");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the adapter process tree must be dead after a timeout");
  } finally {
    for (const d of [runsRoot, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

test("spawn failure (adapter command not found): failed receipt, never a throw", async () => {
  const runsRoot = tmp("dh-acp-runs-");
  const cwd = tmp("dh-acp-cwd-");
  const emptyDir = tmp("dh-acp-empty-");
  try {
    const { receipt, runDir } = await runAcpWorker({
      taskId: "acp-nospawn",
      provider: "claude",
      adapterCommand: "definitely-not-a-real-acp-adapter-xyz",
      adapterArgs: [],
      prompt: "p",
      cwd,
      runsRoot,
      env: { ...process.env, PATH: emptyDir, Path: emptyDir },
    });

    assert.equal(receipt.status, "failed");
    assert.match(receipt.exit.error, /not found on PATH/);
    assert.equal(validateReceipt(receipt).ok, true);
    assert.ok(existsSync(path.join(runDir, "receipt.json")));
  } finally {
    for (const d of [runsRoot, cwd, emptyDir]) rmSync(d, { recursive: true, force: true });
  }
});
