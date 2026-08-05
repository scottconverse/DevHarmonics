import assert from "node:assert/strict";
import test from "node:test";
import { isCredentialShaped, isSessionMarker, workerEnv } from "../scripts/worker-env.mjs";

test("named provider keys and cloud credentials are stripped", () => {
  const { env, stripped } = workerEnv({
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GH_TOKEN: "ghp_secret",
    PATH: "/usr/bin",
    HOME: "/home/scott",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin", "ordinary vars must survive");
  assert.equal(env.HOME, "/home/scott");
  assert.deepEqual(stripped, ["ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "GH_TOKEN", "OPENAI_API_KEY"]);
});

test("shape-based stripping catches the long tail no fixed list can enumerate", () => {
  const { env } = workerEnv({
    ACME_API_KEY: "x",
    INTERNAL_SERVICE_TOKEN: "x",
    DB_PASSWORD: "x",
    VENDOR_SECRET: "x",
    SOME_CREDENTIALS: "x",
    MYAPIKEY: "x",
    EDITOR: "vim",
  });
  for (const gone of ["ACME_API_KEY", "INTERNAL_SERVICE_TOKEN", "DB_PASSWORD", "VENDOR_SECRET", "SOME_CREDENTIALS", "MYAPIKEY"]) {
    assert.equal(env[gone], undefined, `${gone} must be stripped`);
  }
  assert.equal(env.EDITOR, "vim");
});

test("benign lookalikes are NOT stripped — a path is not a secret", () => {
  const { env } = workerEnv({ SSH_AUTH_SOCK: "/tmp/ssh-agent.sock", GPG_TTY: "/dev/tty1" });
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/ssh-agent.sock");
  assert.equal(env.GPG_TTY, "/dev/tty1");
});

test("nested-session markers are stripped so a child provider CLI can launch", () => {
  const { env, stripped } = workerEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/usr/bin" });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.ok(stripped.includes("CLAUDECODE"));
  assert.equal(env.PATH, "/usr/bin");
});

test("session-marker stripping can be disabled without affecting credential stripping", () => {
  const { env } = workerEnv({ CLAUDECODE: "1", OPENAI_API_KEY: "sk" }, { stripSessionMarkers: false });
  assert.equal(env.CLAUDECODE, "1");
  assert.equal(env.OPENAI_API_KEY, undefined, "credentials are stripped regardless");
});

test("the predicates are exported and behave case-insensitively", () => {
  assert.equal(isCredentialShaped("anthropic_api_key"), true);
  assert.equal(isCredentialShaped("PATH"), false);
  assert.equal(isCredentialShaped("SSH_AUTH_SOCK"), false);
  assert.equal(isSessionMarker("claudecode"), true);
  assert.equal(isSessionMarker("PATH"), false);
});

test("the returned env is a copy — the caller's environment is never mutated", () => {
  const original = { OPENAI_API_KEY: "sk", PATH: "/usr/bin" };
  workerEnv(original);
  assert.equal(original.OPENAI_API_KEY, "sk", "input object must be untouched");
});
