import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Ported from devharmonics-v1's `credential-store.ts` (v1 port (d), owner's
 * go): API keys encrypted at rest with Windows DPAPI (CurrentUser scope), one
 * file per credential under `~/.devharmonics/credentials/<name>.json`.
 * SECRET-001 (audit 2026-08-06): the 0o600 mode below is a best-effort POSIX
 * hint only — Windows maps it to the read-only attribute and it grants no
 * owner-only restriction. ALL of the at-rest protection here is DPAPI's.
 * The PM-shaped alternative to "set an environment variable": store the
 * key once with `devharmonics credential set <name>`, then the config names
 * the CREDENTIAL (`endpoints.<name>.credential`), never the key itself.
 *
 * DPAPI CurrentUser means the ciphertext is useless off this machine and to
 * any other Windows account — no master password to invent, nothing to leak
 * in a config file or a receipt. `set` is Windows-only, exactly as v1 was;
 * a store file that reaches a non-Windows host refuses to decrypt loudly.
 */

export const CREDENTIAL_NAME_PATTERN = /^[a-z0-9_-]+$/i;

export function credentialsDir() {
  return path.join(os.homedir(), ".devharmonics", "credentials");
}

function credentialFile(name, directory) {
  if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid credential name ${JSON.stringify(name)} — letters, digits, "_" and "-" only`);
  }
  return path.join(directory, `${name}.json`);
}

/**
 * SECRET-003 (audit 2026-08-06): every read, write, and delete follows whatever
 * sits at the path. A pre-planted symlink (or junction) could redirect a write
 * or a delete somewhere else entirely. Same-user threat, but a credential store
 * is exactly where "same user" stops being a comfortable answer — so a store
 * entry that is not a REGULAR FILE is refused rather than followed.
 */
function assertRegularFile(file) {
  let stats;
  try {
    stats = lstatSync(file);
  } catch {
    return; // absent is fine — the caller handles missing entries
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to use credential store entry ${file}: it is not a regular file (symlink, junction, or directory) — remove it and re-store the credential`);
  }
}

/** DPAPI protect/unprotect via a bounded PowerShell child; the secret rides stdin, never argv. */
function runDpapi(script, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`Windows credential protection failed (${code}): ${stderr.trim()}`))));
    child.stdin.end(stdin);
  });
}

// Add-Type first: Windows PowerShell 5.1 (the guaranteed-present powershell.exe)
// does not preload System.Security, and without it ProtectedData is TypeNotFound.
const PROTECT = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)";
const UNPROTECT = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($p)";

/**
 * The store. `directory` and `platform` are injectable for tests only; real
 * callers take the defaults. All methods that touch DPAPI are async.
 */
export function createCredentialStore({ directory = credentialsDir(), platform = process.platform, dpapi = runDpapi } = {}) {
  return {
    directory,

    has(name) {
      return existsSync(credentialFile(name, directory));
    },

    /** Names present in the store — never the values. */
    list() {
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .filter((n) => CREDENTIAL_NAME_PATTERN.test(n))
        .sort();
    },

    async set(name, secret) {
      const file = credentialFile(name, directory);
      if (platform !== "win32") {
        throw new Error("Secure credential storage is currently available only on Windows (DPAPI) — on this system, use endpoints.<name>.apiKeyEnvVar and an environment variable instead");
      }
      if (typeof secret !== "string" || !secret.trim()) {
        throw new Error("Refusing to store an empty credential");
      }
      assertRegularFile(file);
      const ciphertext = await dpapi(PROTECT, secret);
      mkdirSync(directory, { recursive: true });
      const value = { version: 1, protection: "windows-dpapi-current-user", ciphertext };
      writeFileSync(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    },

    /** null = not stored. A stored-but-undecryptable credential THROWS — that is a real problem, never a silent fallback. */
    async get(name) {
      const file = credentialFile(name, directory);
      if (!existsSync(file)) return null;
      assertRegularFile(file);
      let value;
      try {
        value = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(`Stored credential "${name}" is unreadable (${file}) — re-store it with: devharmonics credential set ${name}`);
      }
      if (value?.version !== 1 || value?.protection !== "windows-dpapi-current-user" || typeof value?.ciphertext !== "string") {
        throw new Error(`Stored credential "${name}" has an unrecognized format (${file}) — re-store it with: devharmonics credential set ${name}`);
      }
      if (platform !== "win32") {
        throw new Error(`Stored credential "${name}" was protected with Windows DPAPI and cannot be decrypted on this operating system`);
      }
      return dpapi(UNPROTECT, value.ciphertext);
    },

    delete(name) {
      const file = credentialFile(name, directory);
      const existed = existsSync(file);
      assertRegularFile(file);
      rmSync(file, { force: true });
      return existed;
    },
  };
}
