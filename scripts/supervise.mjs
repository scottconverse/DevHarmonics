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
}) {
  const startedAt = new Date();
  const platform = process.platform;
  const { spawnCommand, spawnArgs, verbatim } = spawnPlan(command, args, { platform, env });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let killTimer = null;
    let escalateTimer = null;

    // finish() is the single resolution path: whichever event fires first
    // ("close", or a synchronous spawn error before the child ever starts)
    // clears both timers so neither can fire after resolution and keep the
    // event loop alive past this call.
    function finish(exitCode) {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
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
        // A worker that ignores SIGTERM (or, on Windows, a taskkill race
        // against a not-yet-fully-started tree) would otherwise hang this
        // promise forever. SIGKILL after a grace period guarantees "close"
        // still fires. taskkill already uses /F, so this branch is POSIX-only
        // in practice, but is safe to arm unconditionally.
        escalateTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone, or no such process group (e.g. Windows) — fine.
          }
        }, 5000);
      }, timeoutMs);
    }

    child.on("close", (code) => {
      finish(code);
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
