import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { spawnPlan } from "./path-resolve.mjs";

/**
 * Run a headless AI-CLI worker to completion (or timeout) and capture its
 * full output, never throwing for process-level failure.
 *
 * `superviseProcess` never rejects: a caller driving many concurrent workers
 * cannot afford one bad command string or a missing binary to blow up an
 * `await Promise.all(...)` for every other worker. Every failure mode —
 * spawn ENOENT, a timeout, a nonzero exit, stdin EPIPE — is folded into the
 * returned shape instead.
 *
 * `command` must already be an absolute, PATH-resolved path (see
 * resolvePathCommand in path-resolve.mjs): resolving PATH here too would
 * silently re-introduce the exact shim-picking bug that module exists to
 * fix, and would resolve against the wrong env if the caller narrowed one.
 */
export async function superviseProcess({
  command,
  args = [],
  cwd,
  prompt = null,
  timeoutMs,
  env = process.env,
  onStdout = null,
  onStderr = null,
  // Hard ceiling on waiting for stdio to drain after the child exits.
  // See the exit/close comment below: a detached descendant can hold the
  // pipes open forever, so 'close' alone is not a settlement guarantee.
  drainDeadlineMs = 10_000,
}) {
  const startedAt = new Date();
  const platform = process.platform;
  // spawnPlan can refuse an argument up front (e.g. an embedded newline that
  // cmd.exe would silently truncate — GAUNTLET C-1). Fold that into the same
  // fail-closed shape as a spawn ENOENT: this function must never throw, so a
  // caller Promise.all-ing many workers cannot lose all of them to one bad arg.
  let spawnCommand;
  let spawnArgs;
  let verbatim;
  try {
    ({ spawnCommand, spawnArgs, verbatim } = spawnPlan(command, args, { platform, env }));
  } catch (err) {
    const finishedAt = new Date();
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: String(err?.message ?? err),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let killTimer = null;
    let escalateTimer = null;
    let drainTimer = null;

    // finish() is the single resolution path: whichever event fires first
    // ("close", or a synchronous spawn error before the child ever starts)
    // clears both timers so neither can fire after resolution and keep the
    // event loop alive past this call.
    function finish(exitCode) {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      if (drainTimer) clearTimeout(drainTimer);
      const finishedAt = new Date();
      resolve({
        exitCode: exitCode ?? null,
        stdout,
        stderr,
        timedOut,
        error: spawnError,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    }

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Detaching on POSIX makes the child its own process-group leader,
        // which is what lets the timeout path signal -pid (the whole group,
        // e.g. a shell plus whatever it launched) instead of just the direct
        // child. Windows has no equivalent concept, and detaching there
        // would just spawn a separate console; taskkill /T walks the actual
        // process tree by PID instead.
        detached: platform !== "win32",
        windowsVerbatimArguments: verbatim,
      });
    } catch (err) {
      // Spawn-level throw (rare, but some invalid-arg combinations throw
      // synchronously instead of emitting "error"). Treated identically to
      // an async spawn error below.
      spawnError = String(err?.message ?? err);
      finish(null);
      return;
    }

    // A synchronous ENOENT/EACCES still surfaces as an async "error" event,
    // not a throw — this is the common spawn-failure path (bad/missing
    // command). exitCode is forced to null here rather than read off
    // child.exitCode: on Windows, a failed spawn leaves child.exitCode set
    // to the raw negative libuv errno (e.g. -4058 for ENOENT) instead of
    // null, which would otherwise leak a platform-specific errno into the
    // "no process ever ran" case — found by this module's own test suite.
    child.on("error", (err) => {
      spawnError = String(err?.message ?? err);
      finish(null);
    });

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    // Writing to a child that has already exited (or never started) raises
    // EPIPE on the stdin stream; without this handler that is an unhandled
    // "error" event and crashes the whole supervisor process.
    child.stdin?.on("error", () => {});
    if (typeof prompt === "string") {
      child.stdin?.write(prompt);
    }
    child.stdin?.end();

    if (Number.isFinite(timeoutMs)) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killTree(child, platform);
        escalateTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone, or no such process group (e.g. Windows) — fine.
          }
        }, 5000);
      }, timeoutMs);
    }

    // "exit" fires when the process itself terminates. "close" additionally
    // waits for its stdio to drain — and a DETACHED DESCENDANT that inherited
    // the piped stdout/stderr keeps those pipes open after the tracked child
    // is long gone, so "close" may never arrive at all. A CLI that backgrounds
    // a helper or daemon is an entirely ordinary shape.
    //
    // GauntletGate BLOCKER (2026-08-05), reproduced: a child that exited
    // normally at ~300ms after spawning such a descendant left this promise
    // unsettled past an 8s outer bound, with the timeout path never even
    // engaging. The consequences are exactly what this codebase promises can
    // never happen: no receipt is written (an attempt indistinguishable from
    // one that never occurred), and inside integrate.mjs the per-repository
    // lock is held open against every other integration.
    //
    // The prior comment claimed SIGKILL guaranteed "close" would fire. It does
    // not: SIGKILL reaches the direct child, never a detached descendant
    // holding the shared pipe. acp-worker.mjs's copy of this logic
    // independently discovered the need for a hard ceiling and added one; that
    // fix was never carried back here, to the more heavily used sibling. It is
    // now: "exit" plus a bounded drain deadline guarantees settlement.
    let exited = false;
    let exitEventCode = null;
    child.on("exit", (code) => {
      exited = true;
      exitEventCode = code;
      drainTimer = setTimeout(() => {
        // stdio never drained — settle on the exit code we already have
        // rather than waiting on a pipe a descendant may hold forever.
        finish(code);
      }, drainDeadlineMs);
      drainTimer.unref?.();
    });

    child.on("close", (code) => {
      // Normal path: stdio drained. Prefer close's code; fall back to the code
      // the "exit" event already reported if close's is null. (The previous
      // form referenced this handler's own null `code` in the fallback, so it
      // could never actually fall back — a no-op dressed as one. `exited` is
      // still tracked for clarity of intent even though exit precedes close.)
      finish(code ?? (exited ? exitEventCode : null));
    });
  });
}

/**
 * Kill the entire process tree rooted at `child`, not just the direct
 * child. An AI-CLI worker commonly launches its own subprocesses (shell
 * tool calls, language servers); killing only the immediate PID on timeout
 * leaves those running and orphaned.
 */
function killTree(child, platform) {
  if (platform === "win32") {
    // taskkill /T walks the tree by PID; /F is required because a plain
    // WM_CLOSE-equivalent is not sent to console subprocesses. Run via
    // spawnSync (not exec) so no shell interprets the PID value.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    // Negative pid signals the whole process GROUP; only valid because the
    // child was spawned with detached: true (making it the group leader).
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already exited between the timeout firing and this call — fine.
  }
}
