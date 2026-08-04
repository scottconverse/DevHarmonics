import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePathCommand, runResolved } from "../scripts/path-resolve.mjs";

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "dh-path-"));
}

test("a recognized Windows extension wins over the bare npm POSIX shim", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n");
    writeFileSync(path.join(dir, "codex.cmd"), "@echo off\r\n");
    const resolved = resolvePathCommand("codex", {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    // Windows paths are case-insensitive; PATHEXT casing must not matter.
    assert.equal(resolved.toLowerCase(), path.join(dir, "codex.cmd").toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an earlier PATH directory wins over a later one", () => {
  const first = tempDir();
  const second = tempDir();
  try {
    writeFileSync(path.join(first, "tool.cmd"), "@echo off\r\n");
    writeFileSync(path.join(second, "tool.cmd"), "@echo off\r\n");
    const resolved = resolvePathCommand("tool", {
      platform: "win32",
      env: { PATH: `${first};${second}`, PATHEXT: ".CMD" },
    });
    assert.equal(resolved.toLowerCase(), path.join(first, "tool.cmd").toLowerCase());
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("nothing on PATH returns null rather than a guess, on both platform branches", () => {
  const dir = tempDir();
  try {
    assert.equal(resolvePathCommand("codex", { platform: "win32", env: { PATH: dir } }), null);
    assert.equal(resolvePathCommand("codex", { platform: "linux", env: { PATH: "/definitely/not/real" } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolution uses the caller's env, never the ambient one", () => {
  // Regression: an env parameter accepted but not threaded through silently
  // resolves against process.env — the exact bug class hit on 2026-08-04.
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "onlyhere.cmd"), "@echo off\r\n");
    const resolved = resolvePathCommand("onlyhere", {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD" },
    });
    assert.ok(resolved !== null, "must resolve from the supplied env's PATH");
    assert.equal(
      resolvePathCommand("onlyhere", { platform: "win32", env: { PATH: tempDir(), PATHEXT: ".CMD" } }),
      null,
      "must NOT fall back to any ambient PATH",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runResolved executes a real resolved executable cross-platform (node itself)", () => {
  const resolved = resolvePathCommand("node");
  assert.ok(resolved, "node must be resolvable in the test environment");
  const run = runResolved(resolved, ["--version"]);
  assert.equal(run.ok, true, run.error ?? run.stderr);
  assert.match(run.stdout.trim(), /^v\d+\./);
});

test("runResolved spawns a real .cmd file on Windows without EINVAL", { skip: process.platform !== "win32" }, () => {
  // Regression: Node refuses to spawn .cmd/.bat directly (EINVAL); the
  // explicit ComSpec wrap is the sanctioned fix. Hit live on 2026-08-04.
  const dir = tempDir();
  try {
    const script = path.join(dir, "fake-tool.cmd");
    writeFileSync(script, "@echo off\r\necho ARG=%1\r\nexit /b 0\r\n");
    const run = runResolved(script, ["hello"]);
    assert.equal(run.ok, true, run.error ?? run.stderr);
    assert.match(run.stdout, /ARG=hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runResolved executes a bare shell script on POSIX", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  try {
    const script = path.join(dir, "fake-tool");
    writeFileSync(script, "#!/bin/sh\necho ARG=$1\nexit 0\n");
    chmodSync(script, 0o755);
    const run = runResolved(script, ["hello"]);
    assert.equal(run.ok, true, run.error ?? run.stderr);
    assert.match(run.stdout, /ARG=hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
