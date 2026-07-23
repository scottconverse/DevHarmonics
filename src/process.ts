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
    const child = spawn(resolved.command, resolved.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
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
        if (typeof child.pid === "number") {
          try {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          } catch {
            // best-effort; the backstop drain timer below still guarantees settlement
          }
        }
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
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
