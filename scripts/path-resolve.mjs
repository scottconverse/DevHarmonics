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
 * Windows env-var names are case-insensitive, but a plain object spread of
 * process.env preserves whatever casing the parent shell used (Git Bash:
 * COMSPEC). A case-sensitive lookup silently misses it — found by this
 * module's own test suite.
 *
 * Exported so other spawn-planning callers (e.g. the process supervisor)
 * share one case-insensitive lookup instead of re-deriving it.
 */
export function lookupEnv(env, name) {
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}

/**
 * Decide HOW to spawn a resolved command, without actually spawning it.
 *
 * Split out of runResolved so an async caller (child_process.spawn, in the
 * supervisor) can reuse the exact same .cmd/.bat ComSpec-wrap decision that
 * runResolved uses for spawnSync — the EINVAL/DEP0190 problem described below
 * is identical for both APIs, and duplicating the branch risks the two
 * drifting apart.
 */
/**
 * cmd.exe-safe quoting for one argument (the cross-spawn recipe, hardened).
 * With windowsVerbatimArguments Node performs NO quoting, so an argument
 * containing spaces arrives as many argv tokens and one containing quotes
 * can break cmd.exe's own parsing. Found live 2026-08-04: claude.cmd's
 * argv-delivered prompt was shredded into word-per-token ("-p Reply with
 * exactly ..."), and a JSON-bearing prompt produced cmd's "The system
 * cannot find the file specified". codex survived only because its prompt
 * rides stdin; agy because it is a native .exe that never takes this wrap.
 *
 * Two GAUNTLET-2026-08-05 findings are fixed here:
 *
 * B-1 (command injection). escapeCmdArg is only ever reached for a .cmd/.bat
 * target (spawnPlan's wrap condition below), so every argument is parsed by
 * cmd.exe TWICE — once for the `cmd /c` line, and AGAIN when the batch shim
 * re-expands its `%star` / `%1` arguments (npm-generated shims all end in a
 * `%star` forward-all). A single caret
 * escape survives only the first parse; the metacharacter goes live in the
 * second. This is the BatBadBut / CVE-2024-27980 class, reproduced live: a
 * prompt with an odd number of `"` before an `&` launched a second,
 * attacker-chosen process. The fix is to caret-escape the metacharacters
 * TWICE so they survive both passes as inert literals — exactly cross-spawn's
 * `doubleEscapeMetaChars` mode, which this codepath ALWAYS needs because it
 * always targets a batch shim.
 *
 * C-1 (silent newline truncation). cmd.exe terminates its command line at the
 * first CR/LF, so an argument carrying an embedded newline is truncated there
 * — every argument after it, including safety flags, silently vanishes. A
 * caret cannot escape a newline (before a newline it is a line-continuation,
 * which is worse), so there is no correct in-band encoding. Refuse rather than
 * silently truncate: throw, fail closed, name the real cause. Multi-line
 * content must ride a non-argv lane (HTTP, or codex's stdin delivery).
 */
function escapeCmdArg(value) {
  const str = String(value);
  if (/[\r\n]/.test(str)) {
    throw new Error(
      "escapeCmdArg: argument contains an embedded newline. cmd.exe truncates its command line at the first CR/LF, so carrying this across the .cmd/.bat shim wrap would silently drop every following argument (GAUNTLET C-1). Deliver multi-line content over a non-argv lane (HTTP, or stdin) instead of refusing here.",
    );
  }
  let escaped = str
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
}

export function spawnPlan(command, args = [], { platform = process.platform, env = process.env } = {}) {
  const wrap = platform === "win32" && /\.(cmd|bat)$/i.test(command);
  if (!wrap) {
    return { spawnCommand: command, spawnArgs: args, verbatim: false };
  }
  // Absolute fallback: the child resolves a bare "cmd.exe" against ITS env's
  // PATH, which a caller may legitimately have narrowed to a fixture dir.
  const comspec = lookupEnv(env, "ComSpec")
    ?? path.join(lookupEnv(env, "SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe");
  return {
    spawnCommand: comspec,
    spawnArgs: ["/d", "/s", "/c", [command, ...args].map(escapeCmdArg).join(" ")],
    verbatim: true,
  };
}

/** True only if `p` exists AND is a regular file — never throws. */
function existsAsFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Synchronously run a resolved executable path safely on every platform.
 *
 * Node cannot spawn a `.cmd`/`.bat` file directly on Windows — it throws
 * EINVAL (a deliberate restriction tied to a shell-escaping CVE class), and
 * `shell: true` with an args array draws deprecation DEP0190. The sanctioned
 * pattern is an explicit ComSpec wrap with verbatim arguments; that is what
 * spawnPlan decides, and only for the recognized-extension case. Both
 * failure modes were hit live against the real Codex CLI (2026-08-04).
 *
 * Callers must pass internally constructed args only; nothing here escapes
 * untrusted content for cmd.exe.
 */
export function runResolved(command, args = [], { timeoutMs = 20_000, platform = process.platform, env = process.env } = {}) {
  // spawnPlan can refuse an argument up front (embedded newline — see
  // escapeCmdArg / GAUNTLET C-1). Report it as an ordinary failed run rather
  // than throwing, matching this function's "never throws for process-level
  // failure" contract.
  let spawnCommand;
  let spawnArgs;
  let verbatim;
  try {
    ({ spawnCommand, spawnArgs, verbatim } = spawnPlan(command, args, { platform, env }));
  } catch (err) {
    return { ok: false, status: null, stdout: "", stderr: "", error: String(err?.message ?? err), timedOut: false };
  }
  const result = spawnSync(spawnCommand, spawnArgs, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    env,
  });
  let errorMessage = result.error ? String(result.error.message ?? result.error) : null;
  // Windows CreateProcess cannot launch a file with no recognized executable
  // extension (no .exe/.cmd/.bat association), even when the file plainly
  // exists — libuv surfaces that failure as a plain ENOENT, indistinguishable
  // from "no such file". Proven live on Windows: resolvePathCommand's bare
  // extensionless last-resort fallback hits exactly this. When the file
  // genuinely exists, the message is actively misleading, so it is replaced
  // with an accurate one naming the real cause. When the file does NOT
  // exist, ENOENT is already the correct, honest answer and is left alone.
  if (platform === "win32" && result.error?.code === "ENOENT" && existsAsFile(command)) {
    errorMessage = `"${command}" exists but Windows cannot execute an extensionless file directly (no .exe/.cmd/.bat association) — libuv reports this as ENOENT even though the file is present. The tool on PATH likely needs a .cmd or .exe shim.`;
  }
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: errorMessage,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}
