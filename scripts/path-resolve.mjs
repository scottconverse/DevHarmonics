import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

/**
 * Real PATH resolution for a bare command name, in the same order an actual
 * shell would use: each PATH directory in turn, and on Windows every PATHEXT
 * suffix in turn within that directory, first match wins.
 *
 * A recognized executable extension is tried BEFORE the bare extensionless
 * name: a global npm install commonly leaves both a POSIX shim (bare name,
 * for Git Bash/WSL) and a `.cmd` shim in the same directory, and only the
 * `.cmd` one is natively spawnable by Windows. Picking the bare one first
 * resolves to a file CreateProcess cannot launch — a bug found live against
 * the real Codex CLI (2026-08-04). The bare name is kept as a last resort.
 */
export function resolvePathCommand(name, { platform = process.platform, env = process.env } = {}) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const directories = pathValue.split(separator).filter(Boolean);
  const suffixes = platform === "win32"
    ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""]
    : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (!existsSync(candidate)) continue;
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

/**
 * Synchronously run a resolved executable path safely on every platform.
 *
 * Node cannot spawn a `.cmd`/`.bat` file directly on Windows — it throws
 * EINVAL (a deliberate restriction tied to a shell-escaping CVE class), and
 * `shell: true` with an args array draws deprecation DEP0190. The sanctioned
 * pattern is an explicit ComSpec wrap with verbatim arguments; that is what
 * this helper does, and only for the recognized-extension case. Both failure
 * modes were hit live against the real Codex CLI (2026-08-04).
 *
 * Callers must pass internally constructed args only; nothing here escapes
 * untrusted content for cmd.exe.
 */
/**
 * Windows env-var names are case-insensitive, but a plain object spread of
 * process.env preserves whatever casing the parent shell used (Git Bash:
 * COMSPEC). A case-sensitive lookup silently misses it — found by this
 * module's own test suite.
 */
function lookupEnv(env, name) {
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}

export function runResolved(command, args = [], { timeoutMs = 20_000, platform = process.platform, env = process.env } = {}) {
  const wrap = platform === "win32" && /\.(cmd|bat)$/i.test(command);
  // Absolute fallback: the child resolves a bare "cmd.exe" against ITS env's
  // PATH, which a caller may legitimately have narrowed to a fixture dir.
  const comspec = lookupEnv(env, "ComSpec")
    ?? path.join(lookupEnv(env, "SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe");
  const spawnCommand = wrap ? comspec : command;
  const spawnArgs = wrap ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: wrap,
    env,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : null,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}
