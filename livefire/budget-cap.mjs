// LIVE-FIRE: `--max-budget-usd` against the REAL `claude` CLI (R-1).
//
// The unit tests prove buildInvocation emits the flag and runWorker threads it;
// what they cannot prove is that the installed claude CLI accepts the flag and
// what it actually does with it. Two real runs answer that:
//
//   1. A generous cap (0.50): the run must COMPLETE, and the receipt's recorded
//      args must show the flag was really sent. An unknown flag would fail the
//      invocation, so completion + args is proof of acceptance.
//   2. A cap of $0.000001 — far below the cost of any real call: observe
//      whether, and how, the CLI enforces it. The observation is recorded in
//      livefire/README.md either way; this script reports honestly, it does
//      not assume the enforcement semantics it is here to discover.
//
// Costs real subscription tokens: two small model calls.
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.argv[3] || "claude-haiku-4-5-20251001";
const { runWorker } = await import(pathToFileURL(path.join(REPO, "scripts", "run-worker.mjs")));

const runsRoot = mkdtempSync(path.join(os.tmpdir(), "livefire-budget-"));
const PROMPT = "Read package.json in this directory and reply with only the Node engines requirement it declares.";

function describe(receipt) {
  const flag = receipt.args?.includes("--max-budget-usd")
    ? `--max-budget-usd ${receipt.args[receipt.args.indexOf("--max-budget-usd") + 1]}`
    : "(flag NOT present in args)";
  return `status=${receipt.status} exit=${receipt.exit?.code} ${flag} costUsd=${receipt.usage?.costUsd ?? "null"} error=${receipt.exit?.error ?? "none"}`;
}

let failures = 0;
try {
  // --- Run 1: generous cap — must complete with the flag genuinely sent ---
  const generous = await runWorker({
    taskId: "livefire-budget-ok",
    provider: "claude",
    model: MODEL,
    prompt: PROMPT,
    cwd: REPO,
    runsRoot,
    sandbox: "read-only",
    permissionMode: "dontAsk",
    allowedTools: ["Read"],
    maxBudgetUsd: 0.5,
    timeoutMs: 5 * 60_000,
  });
  console.log(`run 1 (cap $0.50):     ${describe(generous.receipt)}`);
  if (generous.receipt.status !== "completed") {
    console.error("FAIL: the generous-cap run did not complete — the real CLI rejected the invocation");
    failures += 1;
  }
  if (!generous.receipt.args?.includes("--max-budget-usd")) {
    console.error("FAIL: --max-budget-usd was not in the recorded invocation args");
    failures += 1;
  }

  // --- Run 2: sub-cent cap — observe the real enforcement behavior ---
  const tiny = await runWorker({
    taskId: "livefire-budget-tiny",
    provider: "claude",
    model: MODEL,
    prompt: PROMPT,
    cwd: REPO,
    runsRoot,
    sandbox: "read-only",
    permissionMode: "dontAsk",
    allowedTools: ["Read"],
    maxBudgetUsd: 0.000001,
    timeoutMs: 5 * 60_000,
  });
  console.log(`run 2 (cap $0.000001): ${describe(tiny.receipt)}`);
  // ENG-011 (audit): only claim "enforced" when the failure is actually
  // budget-shaped — a timeout, auth failure, or network blip is not evidence
  // of enforcement, and a livefire verdict must not overclaim.
  const tinyEvidence = `${tiny.receipt.exit?.error ?? ""} ${tiny.parsed?.finalText ?? ""}`;
  const budgetShaped = /budget|max[- ]?budget|spend|cost limit/i.test(tinyEvidence) || (tiny.receipt.usage?.costUsd ?? 0) > 0.000001;
  console.log(tiny.receipt.status === "completed"
    ? "observed: the tiny cap did NOT stop the run — record this in the README (enforcement semantics)"
    : budgetShaped
      ? "observed: the tiny cap stopped the run for a budget-shaped reason — the ceiling is enforced by the real CLI"
      : "observed: the run failed for a NON-budget reason — INCONCLUSIVE about enforcement; inspect the receipt before recording a verdict");
  if (!tiny.receipt.args?.includes("--max-budget-usd")) {
    console.error("FAIL: --max-budget-usd was not in the tiny-cap invocation args");
    failures += 1;
  }

  console.log(failures === 0
    ? `\nLIVE-FIRE VERDICT: --max-budget-usd was emitted to and accepted by the real ${MODEL} claude CLI`
    : `\nLIVE-FIRE VERDICT: FAILED (${failures} assertion(s))`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(runsRoot, { recursive: true, force: true });
}
