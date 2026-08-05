import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { workerCommand } from "../scripts/worker-command.mjs";

/**
 * Coverage for scripts/worker-command.mjs (the `devharmonics worker` CLI):
 * an 11-flag argv parser, provider/prompt/cwd/timeout validation, JSON-vs-
 * human output, and the `receipt.status === "completed" ? 0 : 1` exit-code
 * contract. Before this file, nothing imported workerCommand or exercised
 * it (a GauntletGate test-audit finding this file closes).
 *
 * Fixture pattern: a FAKE "codex"/"claude" CLI on PATH, ported from
 * test/run-worker.test.mjs's fakeCodexDir — a .CMD shim on win32 / chmod+x
 * shell script on POSIX, delegating to a real Node script that honors each
 * provider's real contract (codex: JSONL on stdout, prompt via stdin,
 * writes --output-last-message; claude: one JSON object on stdout, prompt
 * via argv, per scripts/providers.mjs's buildInvocation). No real AI CLI
 * ever runs.
 *
 * In-process vs. real subprocess, and why both are used here:
 * `workerCommand` (unlike `qualifyCommand` in scripts/qualify-command.mjs)
 * takes no injectable `write` sink, and (unlike `runWorker`) takes no
 * injectable `env` — it always prints via the real process.stdout.write and
 * always resolves the provider CLI against the live process.env. This
 * change is scoped to touch only test files plus scripts/path-resolve.mjs,
 * so scripts/worker-command.mjs cannot be given either hook. Concretely:
 *   - Assertions that must read literal STDOUT CONTENT (the human-readable
 *     text, or --json output) use a real subprocess spawn of
 *     `node scripts/cli.mjs worker ...` — spawnSync captures a CHILD
 *     process's stdout independently, with zero risk to this test file's
 *     own output. (Monkey-patching process.stdout.write in-process was
 *     deliberately avoided elsewhere in this suite — see the comment above
 *     runQualifyCommand in test/qualify.test.mjs — because it collides with
 *     node:test's own asynchronous reporter writing to that same real
 *     stdout; a real subprocess spawn has no such collision.)
 *   - Assertions that only need workerCommand's RETURN VALUE (0/1) or the
 *     receipt it leaves on disk are exercised in-process against the real
 *     exported function. Where a fake provider CLI must be resolvable for
 *     that, the fixture directory is temporarily prepended to the REAL
 *     process.env.PATH and restored in a `finally` (see withFixturePath) —
 *     a mechanism unrelated to the stdout-collision risk above (a plain env
 *     var, not a captured stream). This is safe because node:test runs a
 *     file's top-level tests sequentially by default (verified empirically
 *     while writing this file), so no concurrent test in this process ever
 *     observes the mutated PATH.
 *   - Several real subprocess spawns also prove the TRUE process exit code
 *     (0, 1, and 2 are all covered), since workerCommand's in-process return
 *     value and cli.mjs's `process.exit(code)` wiring are distinct
 *     properties — a bug in one would not necessarily show up in the other.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- fake "codex" on PATH (stdin prompt, JSONL stdout) ----------------------
// Ported from test/run-worker.test.mjs's fakeCodexDir.

function fakeCodexDir(exitCode = 0) {
  const dir = tmp("dh-workercmd-fakecodex-");
  const impl = path.join(dir, "fake-codex-impl.mjs");
  writeFileSync(impl, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--output-last-message");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "turn.started", model: "fake-model-9b" }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 4 } }));
  if (outPath) writeFileSync(outPath, "FAKE DONE: " + stdin.trim());
  process.exit(${exitCode});
});
`);
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "codex.CMD"), `@echo off\r\nnode "${impl}" %*\r\n`);
  } else {
    const shim = path.join(dir, "codex");
    writeFileSync(shim, `#!/bin/sh\nexec node "${impl}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return dir;
}

// --- fake "claude" on PATH (argv prompt, one JSON object on stdout) ---------
// Same shim pattern, honoring claude's contract instead (see
// scripts/providers.mjs's parseClaudeOutput: a "result" string field and a
// "total_cost_usd" number).

function fakeClaudeDir(exitCode = 0) {
  const dir = tmp("dh-workercmd-fakeclaude-");
  const impl = path.join(dir, "fake-claude-impl.mjs");
  writeFileSync(impl, `
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ result: "FAKE CLAUDE DONE", total_cost_usd: 0.002 }));
  process.exit(${exitCode});
});
`);
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "claude.CMD"), `@echo off\r\nnode "${impl}" %*\r\n`);
  } else {
    const shim = path.join(dir, "claude");
    writeFileSync(shim, `#!/bin/sh\nexec node "${impl}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return dir;
}

// --- env wiring for real subprocess spawns ----------------------------------
// Ported from test/pipeline.test.mjs's buildEnv: fixture dirs go first so
// they always win PATH resolution; the real PATH stays behind them so
// `node`/System32 utilities the fixtures themselves shell out to still work.

function buildEnv(...fixtureDirs) {
  const existingPath = process.env.PATH ?? process.env.Path ?? "";
  const merged = [...fixtureDirs.filter(Boolean), existingPath].join(path.delimiter);
  return {
    ...process.env,
    PATH: merged,
    Path: merged,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  };
}

// --- env wiring for in-process workerCommand calls --------------------------
// See the file header: workerCommand exposes no injectable env, so the
// fixture dir is temporarily prepended to the REAL process.env.PATH and
// restored afterwards.

async function withFixturePath(dir, fn) {
  const savedPATH = process.env.PATH;
  const savedPathExt = process.env.PATHEXT;
  process.env.PATH = `${dir}${path.delimiter}${savedPATH ?? ""}`;
  process.env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  try {
    return await fn();
  } finally {
    if (savedPATH === undefined) delete process.env.PATH; else process.env.PATH = savedPATH;
    if (savedPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathExt;
  }
}

/** Read the receipt out of the single run directory a call must have created.
 * A bare runs root (no enclosing .devharmonics) also carries the fan-out
 * meter's own `.fanout` directory (D1) — that is the meter, not a run. */
function readSoleReceipt(runsRoot) {
  const entries = readdirSync(runsRoot).filter((name) => name !== ".fanout");
  assert.equal(entries.length, 1, `expected exactly one run directory under ${runsRoot}, got: ${entries.join(", ")}`);
  const runDir = path.join(runsRoot, entries[0]);
  const receipt = JSON.parse(readFileSync(path.join(runDir, "receipt.json"), "utf8"));
  return { runDir, receipt };
}

// ---------------------------------------------------------------------------
// 1. Happy path (real subprocess: needs literal stdout content)
// ---------------------------------------------------------------------------

test("cli worker: happy path -- completed run exits 0, human-readable output names status/provider/receipt path", () => {
  const fixture = fakeCodexDir(0);
  const cwd = tmp("dh-workercmd-cwd-");
  const runsRoot = tmp("dh-workercmd-runs-");
  try {
    const run = spawnSync(process.execPath, [
      CLI, "worker",
      "--provider", "codex",
      "--model", "fake-model-9b",
      "--prompt", "do the thing",
      "--cwd", cwd,
      "--runs-root", runsRoot,
      "--task-id", "happy1",
      "--timeout-minutes", "0.5",
    ], { encoding: "utf8", timeout: 30_000, env: buildEnv(fixture) });

    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /status:\s+completed/);
    assert.match(run.stdout, /provider:\s+codex \(requested fake-model-9b, resolved fake-model-9b\)/);
    assert.match(run.stdout, /usage:\s+inputTokens=11 outputTokens=4 totalTokens=15/);

    const { runDir } = readSoleReceipt(runsRoot);
    const receiptPath = path.join(runDir, "receipt.json");
    assert.ok(existsSync(receiptPath));
    assert.ok(run.stdout.includes(receiptPath), "human output must print the exact receipt path");
  } finally {
    for (const d of [fixture, cwd, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. --json output (real subprocess: needs literal stdout content)
// ---------------------------------------------------------------------------

test("cli worker --json: emits parseable JSON containing the receipt and runDir", () => {
  const fixture = fakeCodexDir(0);
  const cwd = tmp("dh-workercmd-cwd-");
  const runsRoot = tmp("dh-workercmd-runs-");
  try {
    const run = spawnSync(process.execPath, [
      CLI, "worker",
      "--provider", "codex",
      "--model", "fake-model-9b",
      "--prompt", "do the thing",
      "--cwd", cwd,
      "--runs-root", runsRoot,
      "--task-id", "json1",
      "--timeout-minutes", "0.5",
      "--json",
    ], { encoding: "utf8", timeout: 30_000, env: buildEnv(fixture) });

    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.ok(parsed.receipt, "parsed JSON must include a receipt");
    assert.equal(parsed.receipt.status, "completed");
    assert.equal(parsed.receipt.provider, "codex");
    assert.ok(parsed.runDir, "parsed JSON must include runDir");
    assert.ok(existsSync(parsed.runDir));
    assert.ok(existsSync(path.join(parsed.runDir, "receipt.json")));
  } finally {
    for (const d of [fixture, cwd, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Failed worker (real subprocess: proves the TRUE process exit code)
// ---------------------------------------------------------------------------

test("cli worker: fake CLI exits nonzero -> process exits 1, and a receipt still exists on disk", () => {
  const fixture = fakeCodexDir(5);
  const cwd = tmp("dh-workercmd-cwd-");
  const runsRoot = tmp("dh-workercmd-runs-");
  try {
    const run = spawnSync(process.execPath, [
      CLI, "worker",
      "--provider", "codex",
      "--model", "fake-model-9b",
      "--prompt", "boom",
      "--cwd", cwd,
      "--runs-root", runsRoot,
      "--task-id", "failed1",
      "--timeout-minutes", "0.5",
      "--json",
    ], { encoding: "utf8", timeout: 30_000, env: buildEnv(fixture) });

    assert.equal(run.status, 1, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.receipt.status, "failed");
    assert.equal(parsed.receipt.exit.code, 5);
    assert.ok(existsSync(path.join(parsed.runDir, "receipt.json")), "a receipt must still exist on disk for a failed worker");
  } finally {
    for (const d of [fixture, cwd, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Flag validation (in-process; none of these ever reach PATH resolution)
// ---------------------------------------------------------------------------

test("flag validation: bad --provider rejects with the allowed-provider message", async () => {
  await assert.rejects(
    () => workerCommand(["--provider", "not-a-real-provider", "--prompt", "p", "--cwd", "unused"]),
    /--provider must be one of/,
  );
});

test("cli worker: bad --provider exits 2 (the real process-level exit-2 path)", () => {
  const run = spawnSync(process.execPath, [
    CLI, "worker",
    "--provider", "not-a-real-provider",
    "--prompt", "p",
    "--cwd", "unused",
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 2, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /--provider must be one of/);
});

test("flag validation: missing --prompt rejects", async () => {
  await assert.rejects(
    () => workerCommand(["--provider", "codex", "--cwd", "unused"]),
    /--prompt and --cwd are required/,
  );
});

test("flag validation: missing --cwd rejects", async () => {
  await assert.rejects(
    () => workerCommand(["--provider", "codex", "--prompt", "p"]),
    /--prompt and --cwd are required/,
  );
});

test("flag validation: --timeout-minutes must be a positive number -- zero and non-numeric both rejected", async () => {
  await assert.rejects(
    () => workerCommand(["--provider", "codex", "--prompt", "p", "--cwd", "unused", "--timeout-minutes", "0"]),
    /--timeout-minutes must be a positive finite number/,
  );
  await assert.rejects(
    () => workerCommand(["--provider", "codex", "--prompt", "p", "--cwd", "unused", "--timeout-minutes", "not-a-number"]),
    /--timeout-minutes must be a positive finite number/,
  );
});

test("flag validation: unknown flag rejects", async () => {
  await assert.rejects(
    () => workerCommand(["--not-a-real-flag"]),
    /Unknown worker option: --not-a-real-flag/,
  );
});

// ---------------------------------------------------------------------------
// 5. --allowed-tools reaches the invocation (in-process, PATH temporarily patched)
// ---------------------------------------------------------------------------

test("workerCommand in-process: --allowed-tools is parsed into an array and reaches the invocation (recorded in the receipt's args)", async () => {
  const fixture = fakeClaudeDir(0);
  const cwd = tmp("dh-workercmd-cwd-");
  const runsRoot = tmp("dh-workercmd-runs-");
  try {
    const code = await withFixturePath(fixture, () => workerCommand([
      "--provider", "claude",
      "--model", "fake-claude-model",
      "--prompt", "do the thing",
      "--cwd", cwd,
      "--runs-root", runsRoot,
      "--task-id", "allowedtools1",
      "--timeout-minutes", "0.5",
      "--allowed-tools", "Read,Edit",
      "--json",
    ]));
    assert.equal(code, 0, "the fake claude CLI exits 0, so this must complete");

    const { receipt } = readSoleReceipt(runsRoot);
    assert.equal(receipt.status, "completed");
    assert.ok(Array.isArray(receipt.args), "receipt.args must record the invocation argv");
    const idx = receipt.args.indexOf("--allowedTools");
    assert.ok(idx >= 0, `--allowedTools must appear in the recorded invocation args: ${JSON.stringify(receipt.args)}`);
    assert.equal(receipt.args[idx + 1], "Read,Edit", 'the parsed ["Read","Edit"] array must be rejoined exactly as passed');
  } finally {
    for (const d of [fixture, cwd, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. --runs-root is honored (in-process, PATH temporarily patched)
// ---------------------------------------------------------------------------

test("workerCommand in-process: --runs-root is honored -- the receipt lands where told, not at the default location", async () => {
  const fixture = fakeCodexDir(0);
  const cwd = tmp("dh-workercmd-cwd-");
  const customRunsRoot = tmp("dh-workercmd-customruns-");
  try {
    const code = await withFixturePath(fixture, () => workerCommand([
      "--provider", "codex",
      "--model", "fake-model-9b",
      "--prompt", "do the thing",
      "--cwd", cwd,
      "--runs-root", customRunsRoot,
      "--task-id", "runsroot1",
      "--timeout-minutes", "0.5",
    ]));
    assert.equal(code, 0);

    const { receipt } = readSoleReceipt(customRunsRoot);
    assert.equal(receipt.status, "completed");
    assert.equal(existsSync(path.join(cwd, ".devharmonics")), false, "the default runs-root under cwd must not be touched when --runs-root is given");
  } finally {
    for (const d of [fixture, cwd, customRunsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. The exit-code contract in-process: a failed run resolves 1
//    (tests 1 and 2 above already exercise the completed -> 0 side in-process
//    indirectly via CLI wiring; this proves workerCommand's own return value
//    on the failure branch directly, independent of cli.mjs's process.exit).
// ---------------------------------------------------------------------------

test("workerCommand in-process: a failed run (nonzero fake exit) resolves 1, and a receipt documenting the failure still exists on disk", async () => {
  const fixture = fakeCodexDir(9);
  const cwd = tmp("dh-workercmd-cwd-");
  const runsRoot = tmp("dh-workercmd-runs-");
  try {
    const code = await withFixturePath(fixture, () => workerCommand([
      "--provider", "codex",
      "--model", "fake-model-9b",
      "--prompt", "boom",
      "--cwd", cwd,
      "--runs-root", runsRoot,
      "--task-id", "failedinprocess1",
      "--timeout-minutes", "0.5",
    ]));
    assert.equal(code, 1, 'receipt.status !== "completed" must resolve 1');

    const { receipt } = readSoleReceipt(runsRoot);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.exit.code, 9);
  } finally {
    for (const d of [fixture, cwd, runsRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// --- Audit fix-pass: ENG-001 per-surface budgets + QA-007 sandbox enum ------

test("ENG-001: a --config budget of maxWorkers:1 is ENFORCED by the worker CLI — the second invocation refuses", async () => {
  const fixture = fakeCodexDir(0);
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), "dh-workercmd-budget-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dh-workercmd-budget-cwd-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "dh-workercmd-budget-cfg-"));
  const configFile = path.join(configDir, "tight.json");
  writeFileSync(configFile, JSON.stringify({ budgets: { maxWorkers: 1 } }));
  const restorePath = process.env.PATH;
  const restorePath2 = process.env.Path;
  process.env.PATH = `${fixture}${path.delimiter}${restorePath ?? ""}`;
  process.env.Path = process.env.PATH;
  try {
    const first = await workerCommand([
      "--provider", "codex", "--model", "fake-model-9b", "--prompt", "p",
      "--cwd", cwd, "--runs-root", runsRoot, "--config", configFile, "--json",
    ]);
    assert.equal(first, 0, "first worker under the cap must complete");
    const second = await workerCommand([
      "--provider", "codex", "--model", "fake-model-9b", "--prompt", "p",
      "--cwd", cwd, "--runs-root", runsRoot, "--config", configFile, "--json",
    ]);
    assert.equal(second, 1, "second worker must be refused by the operator's cap");
    const ledger = readFileSync(path.join(runsRoot, ".fanout", "usage.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
    assert.equal(ledger.length, 2, "one reservation + one terminal; the refusal writes nothing");
    const receipts = readdirSync(runsRoot).filter((n) => n !== ".fanout");
    assert.equal(receipts.length, 2, "both attempts leave receipts");
  } finally {
    process.env.PATH = restorePath;
    process.env.Path = restorePath2;
    for (const d of [fixture, runsRoot, cwd, configDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("QA-007: worker --sandbox validates its advertised enum instead of forwarding garbage", async () => {
  await assert.rejects(
    () => workerCommand(["--provider", "codex", "--model", "m", "--prompt", "p", "--cwd", ".", "--sandbox", "utterly-bogus"]),
    /--sandbox must be "read-only" or "workspace-write", got: "utterly-bogus"/,
  );
});

test("UX-011: worker --timeout-minutes quotes the offending value like run's sibling flag", async () => {
  await assert.rejects(
    () => workerCommand(["--provider", "codex", "--model", "m", "--prompt", "p", "--cwd", ".", "--timeout-minutes", "nope"]),
    /--timeout-minutes must be a positive finite number, got: "nope"/,
  );
});
