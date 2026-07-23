import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /**
   * M-timeout-abort: how long to wait after sending SIGTERM (on timeout or
   * on `signal` aborting) before escalating to SIGKILL. A cooperative
   * process exits promptly on SIGTERM; one that ignores it is force-killed
   * once this grace period elapses, so a timed-out or aborted check is never
   * left running in the background. Defaults to 5s.
   */
  killGraceMs?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    // M-timeout-abort: true once we've sent SIGTERM ourselves (from the
    // timeout timer or an aborted `signal`) — guards against sending it
    // twice and gates the SIGKILL escalation below.
    let terminating = false;

    const resolved = resolveCommand(request.command, request.args);
    // The child is NOT spawned with `signal` directly: Node's own
    // signal-kills the process with a single SIGTERM and no escalation. We
    // manage termination ourselves below so a process that ignores SIGTERM
    // is still confirmed dead via SIGKILL before this promise settles.
    // R11b: on POSIX, the child is its own process group leader (detached)
    // so termination below can signal the WHOLE tree via a negative pid
    // (process.kill(-pid, ...)), not just this direct child — a grandchild
    // (e.g. a shell wrapper's real worker) would otherwise survive a
    // SIGTERM/SIGKILL sent only to the direct child. `detached` only
    // affects process-group leadership here; stdio piping is unaffected
    // since stdio is still explicitly piped below. Windows has no POSIX
    // process groups — its tree-kill instead goes through `taskkill /T`.
    const child = spawn(resolved.command, resolved.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const killGraceMs = request.killGraceMs ?? 5_000;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    // SIGTERM now, SIGKILL after killGraceMs if the process is still alive —
    // a timeout or an external abort must always end with the process
    // confirmed dead, never left running because it ignored SIGTERM.
    //
    // On win32, provider CLIs are frequently cmd/shim processes whose real
    // work happens in a GRANDCHILD that inherits the stdio pipes (e.g. a
    // .cmd wrapper that execs node in the foreground). child.kill() only
    // terminates the direct child; the orphaned grandchild keeps the
    // inherited stdout/stderr pipe handles open, so 'close' never fires and
    // this promise never settles. `taskkill /T` kills the whole process
    // tree, so it must run FIRST — while the direct child is still alive
    // for taskkill to enumerate its descendants — rather than after
    // child.kill().
    function terminate(): void {
      if (terminating) return;
      terminating = true;
      if (process.platform === "win32") {
        const pid = child.pid;
        if (typeof pid !== "number") {
          // No pid was ever assigned — nothing to enumerate a tree from.
          // Fall straight back to killing the direct child so 'exit' still
          // fires and this promise doesn't hang forever.
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          return;
        }
        // R11a: `spawn("taskkill", ...)` is itself just another child
        // process — a launch failure normally arrives asynchronously as an
        // 'error' event, not a thrown exception. With no listener, that
        // becomes an unhandled EventEmitter error. And even when taskkill
        // does launch, a nonzero exit means the tree was NOT actually torn
        // down (e.g. the pid it targeted was already gone). Either way, we
        // must fall back to killing the direct child so 'exit' (and the
        // drain backstop below) still fires and runProcess always settles —
        // never silently trust that taskkill worked.
        let killer: ReturnType<typeof spawn> | null = null;
        try {
          killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          return;
        }
        killer.on("error", () => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        });
        killer.on("exit", (code) => {
          if (code !== 0) {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }
        });
      } else {
        // R11b: signal the whole process group (negative pid) so a
        // grandchild spawned by the direct child is torn down too, not just
        // the direct child itself. Fall back to child.kill() if the group
        // kill throws (e.g. the group is already gone, or this pid/platform
        // shape doesn't support it).
        const pid = child.pid;
        const killGroup = (signal: NodeJS.Signals): void => {
          if (typeof pid === "number") {
            try {
              process.kill(-pid, signal);
              return;
            } catch {
              // fall through to the direct-child fallback below
            }
          }
          try {
            child.kill(signal);
          } catch {
            // already gone
          }
        };
        killGroup("SIGTERM");
        killTimer = setTimeout(() => {
          killGroup("SIGKILL");
        }, killGraceMs);
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);

    const onAbort = () => {
      timedOut = true;
      terminate();
    };
    if (request.signal) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }

    function cleanupTimers(): void {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      request.signal?.removeEventListener("abort", onAbort);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanupTimers();
      if (settled) return;
      settled = true;
      reject(error);
    });

    // Backstop: a tree-kill can still race (a grandchild that double-forked,
    // or a stdio handle duplicated somewhere else), so 'close' is not
    // guaranteed to follow 'exit' promptly even after termination. Once the
    // direct child has exited AND we initiated termination, give the tree
    // kill a short drain window, then force the stdio streams closed so
    // 'close' can fire. The promise still only ever resolves from the
    // 'close' handler below — this only guarantees close can arrive.
    child.on("exit", () => {
      if (!terminating || settled) return;
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1_000);
    });

    // Only 'close' (stdio streams flushed AND the process confirmed exited)
    // settles this promise — including after a SIGKILL escalation — so a
    // caller awaiting a timed-out or aborted check learns the external
    // process is actually dead, not merely that we asked it to stop.
    child.on("close", (code) => {
      cleanupTimers();
      if (!settled) {
        settled = true;
        resolve({
          stdout,
          stderr,
          exitCode: code ?? (timedOut ? 124 : 1),
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      }
    });

    child.stdin.on("error", () => {
      // A CLI may close stdin as soon as it has enough input.
    });
    child.stdin.end(request.stdin ?? "");
  });
}

function resolveCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args };

  const explicit = path.isAbsolute(command) || command.includes("\\") || command.includes("/");
  if (explicit) return windowsCommand(command, args);

  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of [".exe", ".com", ".cmd", ".bat", ".ps1"]) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${command}${extension}`);
      if (existsSync(candidate)) return windowsCommand(candidate, args);
    }
  }
  return { command, args };
}

function windowsCommand(command: string, args: string[]): { command: string; args: string[] } {
  const extension = path.extname(command).toLowerCase();
  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args,
      ],
    };
  }
  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

export function subscriptionEnvironment(provider: "codex" | "claude" | "gemini"): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const remove = (names: string[]) => {
    for (const name of names) delete env[name];
  };

  if (provider === "codex") {
    remove(["OPENAI_API_KEY", "CODEX_API_KEY"]);
  } else if (provider === "claude") {
    remove([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]);
  } else {
    remove([
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_GENAI_USE_VERTEXAI",
    ]);
  }

  return env;
}
