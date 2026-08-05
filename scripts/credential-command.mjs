import process from "node:process";
import { createCredentialStore } from "./credential-store.mjs";

/**
 * `devharmonics credential` — manage DPAPI-protected API keys (v1 port (d)).
 *
 *   credential set <name>      store a key (read from stdin — NEVER an argument,
 *                              so the secret can't land in shell history or a
 *                              process listing)
 *   credential list            names in the store (never values)
 *   credential delete <name>   remove one
 *
 * There is deliberately no `credential show`: the store exists so the key is
 * never printed again after the moment it is set.
 */

function readSecretFromStdin({ stdin = process.stdin, stderr = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (stdin.isTTY) stderr.write("Paste the API key and press Enter (input is not echoed back):\n");
    let data = "";
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      data += chunk;
      const newline = data.search(/\r?\n/);
      if (newline >= 0) {
        cleanup();
        resolve(data.slice(0, newline));
      }
    };
    const onEnd = () => { cleanup(); resolve(data); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      if (typeof stdin.pause === "function") stdin.pause();
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
  });
}

export async function credentialCommand(argv, { store = createCredentialStore(), write = (t) => process.stdout.write(t), stdin = process.stdin, stderr = process.stderr } = {}) {
  const [subcommand, name, ...rest] = argv;
  if (rest.length) throw new Error(`Unknown credential option: ${rest[0]}`);
  switch (subcommand) {
    case "set": {
      if (!name) throw new Error("credential set requires a name, e.g.: devharmonics credential set anthropic");
      const secret = (await readSecretFromStdin({ stdin, stderr })).trim();
      await store.set(name, secret);
      write(`Stored credential "${name}" (DPAPI, this Windows account only): ${store.directory}\n`);
      write(`Point an endpoint at it in the project config: endpoints.<endpoint>.credential: "${name}" (see: devharmonics config show)\n`);
      return 0;
    }
    case "list": {
      const names = store.list();
      write(names.length ? `${names.join("\n")}\n` : `(no stored credentials: ${store.directory})\n`);
      return 0;
    }
    case "delete": {
      if (!name) throw new Error("credential delete requires a name");
      const existed = store.delete(name);
      write(existed ? `Deleted credential "${name}".\n` : `No credential named "${name}" was stored — nothing to delete.\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown credential subcommand: ${subcommand ?? "(none)"} — use "set <name>", "list", or "delete <name>"`);
  }
}
