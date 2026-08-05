import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePathCommand } from "../scripts/path-resolve.mjs";
import { superviseProcess } from "../scripts/supervise.mjs";
import { runWorker } from "../scripts/run-worker.mjs";

/**
 * Regression guard for GAUNTLET-2026-08-05 findings B-1 (cmd.exe command
 * injection) and C-1 (embedded-newline command truncation).
 *
 * On Windows `claude` resolves to claude.CMD, an npm %*-forwarding shim, so any
 * argv-delivered argument is parsed by cmd.exe TWICE (the `cmd /c` line, then
 * the shim's %* re-expansion). An adversarial prompt with an odd number of `"`
 * before a metacharacter broke out and launched a second process; a multi-line
 * prompt was silently truncated at the first newline. Both reproduced live.
 *
 * The fix keeps untrusted content OFF the command line: the claude worker's
 * prompt now rides stdin (providers.mjs), and any argv argument that still
 * contains a newline is refused rather than silently truncated (path-resolve
 * escapeCmdArg). These tests pin both. Windows-only: the ComSpec wrap (and the
 * whole vulnerability class) only exists on win32.
 */

// A fake claude.CMD faithful to a real npm shim: `node stub %*`, reads stdin,
// emits valid `--output-format json`. Plus argv-echo.cmd as the attacker's
// canary — if an injected `argv-echo` ever runs, it appends a marker line.
function makeClaudeFakebin() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dh-secinj-"));
  const fakebin = path.join(root, "fakebin");
  mkdirSync(fakebin, { recursive: true });
  const canary = path.join(root, "canary.log");
  writeFileSync(canary, "");

  const attacker = path.join(fakebin, "argv-echo-stub.mjs");
  writeFileSync(attacker, `import {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(canary)},"INJECTED "+JSON.stringify(process.argv.slice(2))+"\\n");`);
  writeFileSync(path.join(fakebin, "argv-echo.cmd"), `@echo off\r\nnode "${attacker}" %*\r\n`);

  // Reads and discards stdin (like the real CLI consuming its piped prompt),
  // then prints a minimal valid claude JSON body. Does NOT touch the canary.
  const claudeStub = path.join(fakebin, "claude-stub.mjs");
  writeFileSync(
    claudeStub,
    `let s="";process.stdin.on("data",c=>{s+=c});process.stdin.on("end",()=>{` +
      `process.stdout.write(JSON.stringify({result:"done",total_cost_usd:0,cost_breakdown:{"claude-x":0}}))});`,
  );
  writeFileSync(path.join(fakebin, "claude.cmd"), `@echo off\r\nnode "${claudeStub}" %*\r\n`);
  return { root, fakebin, canary };
}

test(
  "B-1: an injecting prompt through the real runWorker(claude) path launches no second process (prompt rides stdin, not argv)",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, fakebin, canary } = makeClaudeFakebin();
    const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-secinj-cwd-"));
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-secinj-runs-"));
    try {
      const env = { ...process.env, PATH: `${fakebin};${process.env.PATH ?? process.env.Path ?? ""}` };
      // Odd number of `"` before `&`, then an injected argv-echo — the exact
      // shape that launched a second process on the unfixed argv-delivered path.
      const prompt = 'Rename the "x & argv-echo PWNED & echo done';
      const { receipt } = await runWorker({
        taskId: "sec-inj", provider: "claude", model: "claude-x", prompt, cwd, runsRoot,
        sandbox: "workspace-write", permissionMode: "acceptEdits", allowedTools: ["Read", "Edit", "Write"],
        timeoutMs: 20_000, env,
      });
      const log = readFileSync(canary, "utf8");
      assert.equal(log.includes("PWNED"), false, `an attacker-chosen process ran from prompt content: ${log}`);
      assert.equal(receipt.status, "completed", "the benign claude invocation itself should still succeed");
    } finally {
      for (const d of [root, cwd, runsRoot]) rmSync(d, { recursive: true, force: true });
    }
  },
);

test(
  "C-1: an argv argument containing a newline is refused, never silently truncated",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dh-secnl-"));
    const fakebin = path.join(root, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const canary = path.join(root, "canary.log");
    writeFileSync(canary, "");
    const stub = path.join(fakebin, "s.mjs");
    writeFileSync(stub, `import {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(canary)},"HIT\\n");process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
    writeFileSync(path.join(fakebin, "argv-echo.cmd"), `@echo off\r\nnode "${stub}" %*\r\n`);
    try {
      const env = { ...process.env, PATH: `${fakebin};${process.env.PATH ?? process.env.Path ?? ""}` };
      const resolved = resolvePathCommand("argv-echo", { env });
      const r = await superviseProcess({
        command: resolved,
        args: ["--first", "line1\r\nline2-would-be-dropped", "--must-not-vanish"],
        cwd: fakebin,
        timeoutMs: 20_000,
        env,
      });
      const ran = readFileSync(canary, "utf8").trim().length > 0;
      if (ran) {
        const argv = JSON.parse(r.stdout);
        assert.ok(argv.includes("--must-not-vanish"), `a trailing flag was silently dropped by truncation: ${r.stdout}`);
      } else {
        assert.ok(r.error, "must report an explicit error rather than silently truncating");
        assert.match(r.error, /newline|control char|line break/i, `error must name the real cause, got: ${r.error}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
