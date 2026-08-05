import path from "node:path";
import process from "node:process";
import { runAcpWorker } from "./acp-worker.mjs";

/**
 * CLI surface for one bounded ACP-lane worker run (Agent Client Protocol
 * over stdio). Mirrors worker-command.mjs exactly in style and exit
 * semantics: 0 only for a completed run, 1 for a run that executed and
 * failed or timed out (its receipt says why), 2 when the runner itself
 * could not operate. A crashed runner must never look like a
 * failed-but-recorded worker, and neither must look like success.
 *
 * `deps.runAcpWorker` is injectable (default: the real one) so this command
 * can be driven hermetically in tests without a real ACP adapter process.
 */
export async function acpCommand(argv, {
  write = (text) => { process.stdout.write(text); },
  deps = {},
} = {}) {
  const { runAcpWorker: runAcpWorkerFn = runAcpWorker } = deps;

  const options = {
    adapter: "claude-code-acp", prompt: null, cwd: null,
    taskId: "adhoc", runsRoot: null, permissionMode: "deny",
    timeoutMinutes: 10, asJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => { i += 1; return argv[i]; };
    switch (argv[i]) {
      case "--adapter": options.adapter = next(); break;
      case "--prompt": options.prompt = next(); break;
      case "--cwd": options.cwd = next(); break;
      case "--task-id": options.taskId = next(); break;
      case "--runs-root": options.runsRoot = next(); break;
      case "--permission-mode": options.permissionMode = next(); break;
      case "--timeout-minutes": options.timeoutMinutes = Number(next()); break;
      case "--json": options.asJson = true; break;
      default: throw new Error(`Unknown acp option: ${argv[i]}`);
    }
  }
  if (!options.prompt || !options.cwd) throw new Error("--prompt and --cwd are required");
  if (!["deny", "allow-edits"].includes(options.permissionMode)) {
    throw new Error('--permission-mode must be "deny" or "allow-edits"');
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes must be a positive number");
  }
  const cwd = path.resolve(options.cwd);
  const runsRoot = path.resolve(options.runsRoot ?? path.join(cwd, ".devharmonics", "runs"));

  const { receipt, runDir, events, permissionRequests } = await runAcpWorkerFn({
    taskId: options.taskId,
    provider: "acp",
    adapterCommand: options.adapter,
    prompt: options.prompt,
    cwd,
    runsRoot,
    permissionMode: options.permissionMode,
    timeoutMs: Math.round(options.timeoutMinutes * 60_000),
  });

  if (options.asJson) {
    write(`${JSON.stringify({ receipt, runDir, eventsCount: events.length, permissionRequests }, null, 2)}\n`);
  } else {
    const usage = receipt.usage
      ? Object.entries(receipt.usage).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(" ") || "none reported"
      : "none reported";
    write([
      `status:      ${receipt.status}`,
      `adapter:     ${options.adapter} (requested ${receipt.requestedModel}, resolved ${receipt.resolvedModel ?? "unverified"})`,
      `usage:       ${usage}`,
      `events:      ${events.length}`,
      `permissions: ${permissionRequests.length} request(s)`,
      `receipt:     ${path.join(runDir, "receipt.json")}`,
      receipt.exit?.error ? `error:       ${receipt.exit.error}` : null,
    ].filter(Boolean).join("\n") + "\n");
  }
  return receipt.status === "completed" ? 0 : 1;
}
