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
    // Fixture casing matches PATHEXT exactly: these platform-faked tests run
    // on real filesystems of BOTH case sensitivities in CI, and only exact
    // casing is valid on both. True case-insensitive matching is asserted by
    // the win32-gated test below. (Ubuntu CI caught the mismatch live.)
    writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n");
    writeFileSync(path.join(dir, "codex.CMD"), "@echo off\r\n");
    const resolved = resolvePathCommand("codex", {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    assert.equal(resolved.toLowerCase(), path.join(dir, "codex.CMD").toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an earlier PATH directory wins over a later one", () => {
  const first = tempDir();
  const second = tempDir();
  try {
    writeFileSync(path.join(first, "tool.CMD"), "@echo off\r\n");
    writeFileSync(path.join(second, "tool.CMD"), "@echo off\r\n");
    const resolved = resolvePathCommand("tool", {
      platform: "win32",
      env: { PATH: `${first};${second}`, PATHEXT: ".CMD" },
    });
    assert.equal(resolved.toLowerCase(), path.join(first, "tool.CMD").toLowerCase());
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
    writeFileSync(path.join(dir, "onlyhere.CMD"), "@echo off\r\n");
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

test("on a real Windows filesystem, PATHEXT casing does not have to match the file", { skip: process.platform !== "win32" }, () => {
  // The genuinely case-insensitive behavior, asserted only where the
  // filesystem actually provides it.
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "mixcase.cmd"), "@echo off\r\n");
    const resolved = resolvePathCommand("mixcase", {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD" },
    });
    assert.ok(resolved !== null, "case-insensitive FS must match .CMD suffix to .cmd file");
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
    assert.match(run.stdout, /ARG="?hello"?/);
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
    assert.match(run.stdout, /ARG="?hello"?/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "documented limitation: Windows cannot execute a bare extensionless file directly — resolution still finds it, execution still fails, but the diagnostic is now accurate instead of a misleading ENOENT",
  { skip: process.platform !== "win32" },
  () => {
    // A PATH directory containing ONLY a bare, extensionless file — no
    // .cmd/.exe sibling anywhere. Unlike the "recognized extension wins"
    // fixture above, there is nothing else on PATH for resolvePathCommand to
    // prefer, so its documented last-resort fallback (see the comment on
    // resolvePathCommand) is the only thing that can match.
    const dir = tempDir();
    try {
      const file = path.join(dir, "bare-extensionless-tool");
      writeFileSync(file, "not a real executable, just bytes\n");

      const resolved = resolvePathCommand("bare-extensionless-tool", {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      });
      assert.equal(resolved, file, "the bare extensionless file must still resolve as the last-resort fallback — resolution behavior is unchanged");

      const run = runResolved(resolved, ["hello"], { platform: "win32", timeoutMs: 5000 });

      // The documented limitation itself: Windows' CreateProcess cannot
      // launch a file with no recognized executable extension, even though
      // it plainly exists on disk (proven live: this exact fixture, run
      // against the unpatched code, produced `ok:false, status:null,
      // error:'spawnSync <path> ENOENT'` with error.code "ENOENT" — despite
      // the file existing). No code change fixes this; it is a real OS
      // constraint, not a bug in this module.
      assert.equal(run.ok, false, "Windows genuinely cannot execute this file — this must still fail");
      assert.equal(run.status, null);
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, "");
      assert.equal(run.timedOut, false);

      // What CAN be fixed, and is: the diagnostic. A bare libuv "ENOENT" is
      // actively misleading here (the file demonstrably exists), so the
      // message must name the real cause and point at the real fix, and
      // must no longer read as an ordinary "file not found".
      assert.ok(run.error, "must still report a failure — never silently succeed");
      assert.doesNotMatch(run.error, /^spawnSync .* ENOENT$/, "must no longer be the bare, misleading libuv ENOENT string");
      assert.match(run.error, /cannot execute an extensionless file directly/i);
      assert.match(run.error, /\.cmd or \.exe shim/i, "must point at the real fix");
      assert.ok(run.error.includes(file), "must name the actual file so the operator can find it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
