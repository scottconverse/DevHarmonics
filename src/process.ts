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

    const resolved = resolveCommand(request.command, request.args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
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
    for (const extension of [".exe", ".com", ".ps1", ".cmd", ".bat"]) {
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
