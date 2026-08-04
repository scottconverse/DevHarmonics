import path from "node:path";
import process from "node:process";
import { runWorker } from "./run-worker.mjs";
import { SUBPROCESS_PROVIDERS } from "./providers.mjs";

/**
 * CLI surface for one bounded worker run. Exit semantics mirror doctor's
 * honesty rule: 0 only for a completed run, 1 for a run that executed and
 * failed or timed out (its receipt says why), 2 when the runner itself could
 * not operate. A crashed runner must never look like a failed-but-recorded
 * worker, and neither must look like success.
 */
export async function workerCommand(argv) {
  const options = {
    provider: null, model: null, prompt: null, cwd: null,
    taskId: "adhoc", runsRoot: null, sandbox: "read-only",
    permissionMode: "dontAsk", allowedTools: ["Read"],
    timeoutMinutes: 10, asJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => { i += 1; return argv[i]; };
    switch (argv[i]) {
      case "--provider": options.provider = next(); break;
      case "--model": options.model = next(); break;
      case "--prompt": options.prompt = next(); break;
      case "--cwd": options.cwd = next(); break;
      case "--task-id": options.taskId = next(); break;
      case "--runs-root": options.runsRoot = next(); break;
      case "--sandbox": options.sandbox = next(); break;
      case "--permission-mode": options.permissionMode = next(); break;
      case "--allowed-tools": options.allowedTools = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--timeout-minutes": options.timeoutMinutes = Number(next()); break;
      case "--json": options.asJson = true; break;
      default: throw new Error(`Unknown worker option: ${argv[i]}`);
    }
  }
  if (!SUBPROCESS_PROVIDERS.includes(options.provider)) {
    throw new Error(`--provider must be one of ${SUBPROCESS_PROVIDERS.join(", ")}`);
  }
  if (!options.prompt || !options.cwd) throw new Error("--prompt and --cwd are required");
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes must be a positive number");
  }
  const cwd = path.resolve(options.cwd);
  const runsRoot = path.resolve(options.runsRoot ?? path.join(cwd, ".devharmonics", "runs"));

  const { receipt, runDir } = await runWorker({
    taskId: options.taskId,
    provider: options.provider,
    model: options.model,
    prompt: options.prompt,
    cwd,
    runsRoot,
    sandbox: options.sandbox,
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    timeoutMs: Math.round(options.timeoutMinutes * 60_000),
  });

  if (options.asJson) {
    process.stdout.write(`${JSON.stringify({ receipt, runDir }, null, 2)}\n`);
  } else {
    const usage = receipt.usage
      ? Object.entries(receipt.usage).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(" ") || "none reported"
      : "none reported";
    process.stdout.write([
      `status:   ${receipt.status}`,
      `provider: ${receipt.provider} (requested ${receipt.requestedModel}, resolved ${receipt.resolvedModel ?? "unverified"})`,
      `usage:    ${usage}`,
      `receipt:  ${path.join(runDir, "receipt.json")}`,
      receipt.exit?.error ? `error:    ${receipt.exit.error}` : null,
    ].filter(Boolean).join("\n") + "\n");
  }
  return receipt.status === "completed" ? 0 : 1;
}
