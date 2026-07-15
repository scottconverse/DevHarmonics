import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface ProtectedCredential {
  version: 1;
  protection: "windows-dpapi-current-user";
  ciphertext: string;
}

export class CredentialStore {
  constructor(private readonly directory = path.join(os.homedir(), ".devharmonics", "credentials")) {}

  async has(name: string): Promise<boolean> {
    try {
      await readFile(this.file(name), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async set(name: string, secret: string): Promise<void> {
    if (process.platform !== "win32") throw new Error("Secure OAuth credential storage is currently available only on Windows");
    const ciphertext = await runPowerShell(
      "$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)",
      secret,
    );
    await mkdir(this.directory, { recursive: true });
    const value: ProtectedCredential = { version: 1, protection: "windows-dpapi-current-user", ciphertext };
    await writeFile(this.file(name), `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async get(name: string): Promise<string | null> {
    let value: ProtectedCredential;
    try {
      value = JSON.parse(await readFile(this.file(name), "utf8")) as ProtectedCredential;
    } catch {
      return null;
    }
    if (value.version !== 1 || value.protection !== "windows-dpapi-current-user" || process.platform !== "win32") {
      throw new Error("The stored OAuth credential cannot be decrypted on this operating system or user account");
    }
    return runPowerShell(
      "$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($p)",
      value.ciphertext,
    );
  }

  async delete(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }

  private file(name: string): string {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error("Invalid credential name");
    return path.join(this.directory, `${name}.json`);
  }
}

function runPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Windows credential protection failed (${code}): ${stderr.trim()}`)));
    child.stdin.end(stdin);
  });
}
