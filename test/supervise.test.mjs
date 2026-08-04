import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { superviseProcess } from "../scripts/supervise.mjs";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "dh-supervise-"));
}

// Confirms a PID no longer exists, polling briefly because tree-kill on
// Windows (taskkill /T /F) and process-group SIGTERM on POSIX are not
// guaranteed to be reflected in the OS process table the instant the kill
// call returns, even though "close" has already fired for our direct child.
function assertPidGoneEventually(pid, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const gone = process.platform === "win32" ? isGoneWindows(pid) : isGonePosix(pid);
    if (gone) return;
    if (Date.now() > deadline) {
      assert.fail(`pid ${pid} still present after ${timeoutMs}ms`);
    }
  }
}

function isGoneWindows(pid) {
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8", windowsHide: true });
  const output = result.stdout ?? "";
  // A matching row would contain the PID as its own token; the "no tasks
  // match" message does not, regardless of Windows display language.
  return !new RegExp(`\\b${pid}\\b`).test(output);
}

function isGonePosix(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

test("success: captures stdout/stderr, exit code 0, and well-formed timing fields", async () => {
  const result = await superviseProcess({
    command: process.execPath,
    args: ["-e", "console.log('out'); console.error('err')"],
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  assert.ok(result.durationMs >= 0, `durationMs was ${result.durationMs}`);
  assert.match(result.startedAt, ISO_RE);
  assert.match(result.finishedAt, ISO_RE);
});

test("prompt is delivered over stdin and the child sees EOF", async () => {
  const result = await superviseProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.on('data',d=>process.stdout.write('GOT:'+d)); process.stdin.on('end',()=>process.exit(0))",
    ],
    prompt: "hello",
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /GOT:hello/);
});

test("null prompt still ends stdin immediately (child waiting on end resolves)", async () => {
  const result = await superviseProcess({
    command: process.execPath,
    // stdin.resume() is required: a Readable stays in paused mode (and
    // never fires "end", even for a zero-byte stream) until something
    // switches it to flowing mode — a "data" listener or an explicit
    // resume(). Listening only for "end" hung forever (found live while
    // writing this test). No explicit process.exit() either: on Windows,
    // stdout to a pipe is async, and exiting immediately after a write can
    // truncate it before it flushes; exiting naturally once the event loop
    // drains avoids that race too.
    args: [
      "-e",
      "process.stdin.resume(); process.stdin.on('end',()=>{ process.stdout.write('ended'); process.exitCode = 0; })",
    ],
    prompt: null,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ended/);
});

test("nonzero exit code is passed through untouched", async () => {
  const result = await superviseProcess({
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.error, null);
});

test("timeout kills the whole process tree and resolves promptly", async () => {
  const startedWaiting = Date.now();
  const result = await superviseProcess({
    command: process.execPath,
    // Print our own pid first (before the timeout can fire) so the test can
    // verify afterward that the OS process table no longer has it.
    args: ["-e", "console.log(process.pid); setInterval(()=>{},1000)"],
    timeoutMs: 1500,
  });
  const waitedMs = Date.now() - startedWaiting;
  assert.equal(result.timedOut, true);
  assert.ok(result.exitCode === null || typeof result.exitCode === "number");
  assert.ok(waitedMs < 15000, `superviseProcess took ${waitedMs}ms to resolve after a 1500ms timeout`);

  const pidMatch = result.stdout.match(/(\d+)/);
  assert.ok(pidMatch, `expected the child pid in stdout, got: ${JSON.stringify(result.stdout)}`);
  const pid = Number(pidMatch[1]);
  assertPidGoneEventually(pid);
});

test("a nonexistent command resolves with an error instead of throwing", async () => {
  const result = await superviseProcess({
    command: "Z:/does/not/exist-tool",
    args: [],
  });
  assert.equal(result.exitCode, null);
  assert.ok(result.error, "expected a non-null error message");
  assert.equal(result.timedOut, false);
});

test(
  "a real .cmd file runs via the ComSpec wrap on Windows",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = tempDir();
    try {
      // Casing kept exact and lowercase throughout — this suite also runs on
      // case-sensitive Ubuntu CI (see the note in test/path-resolve.test.mjs);
      // this particular test is win32-gated, but the fixture name must not
      // rely on case-insensitive matching either way.
      const script = path.join(dir, "fake-tool.cmd");
      writeFileSync(script, "@echo off\r\necho ARG=%1\r\nexit /b 0\r\n");
      const result = await superviseProcess({ command: script, args: ["hello"] });
      assert.equal(result.exitCode, 0, result.error ?? result.stderr);
      assert.match(result.stdout, /ARG="?hello"?/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("onStdout callback chunks concatenate to exactly the returned stdout", async () => {
  const script = [
    "let i = 0;",
    "function tick() {",
    "  process.stdout.write('chunk' + i + '\\n');",
    "  i++;",
    "  if (i < 4) { setTimeout(tick, 20); } else { process.exit(0); }",
    "}",
    "tick();",
  ].join("\n");
  let seen = "";
  const result = await superviseProcess({
    command: process.execPath,
    args: ["-e", script],
    onStdout: (chunk) => {
      seen += chunk;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(seen, result.stdout);
  assert.match(result.stdout, /chunk0[\s\S]*chunk3/);
});

test("a .cmd child receives a spaces-and-quotes argument INTACT through the wrap", { skip: process.platform !== "win32" }, async () => {
  // Found live 2026-08-04: the verbatim ComSpec wrap joined args unquoted, so
  // claude.cmd received `-p Reply with exactly ...` as many argv tokens (its
  // prompt shredded), and a prompt containing JSON quotes broke cmd.exe's own
  // parsing outright. codex survived only because its prompt rides stdin.
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-quote-"));
  try {
    const script = path.join(dir, "echo-args.cmd");
    writeFileSync(script, "@echo off\r\necho FIRST=%1\r\n");
    const tricky = 'Reply with {"minimumHours": 3} and no other text.';
    const result = await superviseProcess({ command: script, args: [tricky], cwd: dir, prompt: null, timeoutMs: 20_000 });
    assert.equal(result.exitCode, 0, result.stderr || result.error);
    // %1 keeps the surrounding quotes cmd needs; strip them for comparison.
    const first = result.stdout.trim().replace(/^FIRST=/, "").replace(/^"|"$/g, "");
    assert.equal(first.replaceAll('\\"', '"'), tricky, `argv[1] must arrive as ONE intact argument, got: ${result.stdout.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
