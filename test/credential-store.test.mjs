import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createCredentialStore, CREDENTIAL_NAME_PATTERN } from "../scripts/credential-store.mjs";
import { credentialCommand } from "../scripts/credential-command.mjs";

const IS_WINDOWS = process.platform === "win32";

function tempStoreDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-credstore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake DPAPI for hermetic logic tests on every OS: reversible, obviously not
// encryption. The REAL DPAPI is exercised by the Windows-gated live test below.
const fakeDpapi = async (script, stdin) =>
  script.includes("::Protect(") ? `fake:${Buffer.from(stdin, "utf8").toString("base64")}` : Buffer.from(stdin.slice(5), "base64").toString("utf8");

test("credential names are whitelisted — a path-shaped name never touches the filesystem", async (t) => {
  const store = createCredentialStore({ directory: tempStoreDir(t), platform: "win32", dpapi: fakeDpapi });
  for (const bad of ["../escape", "a/b", "a\\b", "", "sp ace", "dot.json"]) {
    assert.equal(CREDENTIAL_NAME_PATTERN.test(bad), false);
    assert.throws(() => store.has(bad), /Invalid credential name/);
    await assert.rejects(() => store.set(bad, "secret"), /Invalid credential name/);
  }
});

test("set refuses off-Windows with a plain-language remedy, and refuses an empty secret anywhere", async (t) => {
  const posixStore = createCredentialStore({ directory: tempStoreDir(t), platform: "linux", dpapi: fakeDpapi });
  await assert.rejects(() => posixStore.set("anthropic", "sk-x"), /only on Windows.*apiKeyEnvVar/s);
  const winStore = createCredentialStore({ directory: tempStoreDir(t), platform: "win32", dpapi: fakeDpapi });
  await assert.rejects(() => winStore.set("anthropic", "   "), /empty credential/);
});

test("round-trip: set writes a ciphertext-only file, get returns the secret, list/has/delete behave", async (t) => {
  const dir = tempStoreDir(t);
  const store = createCredentialStore({ directory: dir, platform: "win32", dpapi: fakeDpapi });
  await store.set("anthropic", "sk-super-secret");
  const raw = readFileSync(path.join(dir, "anthropic.json"), "utf8");
  assert.ok(!raw.includes("sk-super-secret"), "the plaintext secret must never be on disk");
  assert.match(raw, /windows-dpapi-current-user/);
  assert.equal(await store.get("anthropic"), "sk-super-secret");
  assert.equal(store.has("anthropic"), true);
  assert.deepEqual(store.list(), ["anthropic"]);
  assert.equal(await store.get("never-stored"), null, "missing = null, not an error");
  assert.equal(store.delete("anthropic"), true);
  assert.equal(store.delete("anthropic"), false);
  assert.deepEqual(store.list(), []);
});

test("a stored credential refuses to decrypt off-Windows, and a mangled file names its remedy", async (t) => {
  const dir = tempStoreDir(t);
  const win = createCredentialStore({ directory: dir, platform: "win32", dpapi: fakeDpapi });
  await win.set("anthropic", "sk-x");
  const posix = createCredentialStore({ directory: dir, platform: "linux", dpapi: fakeDpapi });
  await assert.rejects(() => posix.get("anthropic"), /cannot be decrypted on this operating system/);
  writeFileSync(path.join(dir, "mangled.json"), "{ not json");
  await assert.rejects(() => win.get("mangled"), /unreadable.*credential set mangled/s);
  writeFileSync(path.join(dir, "oddshape.json"), JSON.stringify({ version: 2, ciphertext: "x" }));
  await assert.rejects(() => win.get("oddshape"), /unrecognized format/);
});

test("LIVE Windows DPAPI: a real protect/unprotect round-trip through PowerShell", { skip: !IS_WINDOWS && "DPAPI exists only on Windows" }, async (t) => {
  const store = createCredentialStore({ directory: tempStoreDir(t) });
  await store.set("livetest", "sk-live-roundtrip-proof");
  assert.equal(await store.get("livetest"), "sk-live-roundtrip-proof");
  const raw = readFileSync(path.join(store.directory, "livetest.json"), "utf8");
  assert.ok(!raw.includes("sk-live-roundtrip-proof"), "DPAPI ciphertext only on disk");
});

// --- the credential command ---------------------------------------------------

function fakeStdin(text) {
  const stream = Readable.from([text]);
  stream.isTTY = false;
  return stream;
}

test("credential set reads the secret from STDIN (never argv), stores it, and points at the config wiring", async (t) => {
  const store = createCredentialStore({ directory: tempStoreDir(t), platform: "win32", dpapi: fakeDpapi });
  let out = "";
  const code = await credentialCommand(["set", "anthropic"], {
    store,
    write: (t2) => { out += t2; },
    stdin: fakeStdin("sk-from-stdin\n"),
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
  assert.equal(await store.get("anthropic"), "sk-from-stdin");
  assert.ok(!out.includes("sk-from-stdin"), "the secret is never echoed");
  assert.match(out, /endpoints\.<endpoint>\.credential/);
});

test("credential list prints names only; delete reports honestly either way; unknown subcommands refuse", async (t) => {
  const store = createCredentialStore({ directory: tempStoreDir(t), platform: "win32", dpapi: fakeDpapi });
  await store.set("one", "s1");
  let out = "";
  const write = (t2) => { out += t2; };
  assert.equal(await credentialCommand(["list"], { store, write }), 0);
  assert.match(out, /one/);
  assert.ok(!out.includes("s1"));
  out = "";
  assert.equal(await credentialCommand(["delete", "one"], { store, write }), 0);
  assert.match(out, /Deleted/);
  out = "";
  assert.equal(await credentialCommand(["delete", "one"], { store, write }), 0);
  assert.match(out, /nothing to delete/);
  await assert.rejects(() => credentialCommand(["show", "one"], { store, write }), /Unknown credential subcommand/);
  await assert.rejects(() => credentialCommand(["set"], { store, write }), /requires a name/);
});
