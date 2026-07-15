#!/usr/bin/env node
import path from "node:path";
import { initializeProject, loadConfig, devHarmonicsDirectory } from "./config.js";
import { inspectProviders } from "./doctor.js";
import { Ledger } from "./ledger.js";
import { Orchestrator } from "./orchestrator.js";
import { PRODUCT_NAME, PRODUCT_SLUG, VERSION } from "./product.js";
import { startDashboard } from "./server.js";
import type { ProviderName } from "./types.js";

async function main(): Promise<void> {
  const [command = "serve", ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  const projectPath = path.resolve(options.project ?? process.cwd());

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`${PRODUCT_NAME} ${VERSION}`);
    return;
  }

  if (command === "init") {
    const destination = await initializeProject(projectPath);
    console.log(`Initialized ${destination}`);
    return;
  }

  if (command === "doctor") {
    const config = await loadConfig(projectPath);
    const providers = await inspectProviders(config, projectPath);
    for (const provider of providers) {
      const providerLabel = provider.name === "gemini" ? "Google Antigravity" : provider.name;
      console.log(
        `${provider.available ? "READY" : "SETUP"} ${providerLabel.padEnd(18)} ${provider.version || "not installed"} — ${provider.summary}; login: ${provider.loginCommand}`,
      );
      for (const diagnostic of provider.diagnostics.filter((item) => item.state !== "pass")) {
        console.log(`  ${diagnostic.state.toUpperCase().padEnd(8)} ${diagnostic.layer}: ${diagnostic.detail}${diagnostic.action ? `; ${diagnostic.action}` : ""}`);
      }
    }
    console.log("Subscription-only mode is enforced; API-key environment variables are removed from provider processes.");
    return;
  }

  if (command === "run") {
    const goal = options.goal;
    if (!goal) throw new Error("Use --goal \"what the team should accomplish\"");
    await initializeProject(projectPath);
    const config = await loadConfig(projectPath);
    const ledger = new Ledger(path.join(devHarmonicsDirectory(projectPath), "devharmonics.db"));
    const orchestrator = new Orchestrator(ledger);
    const agents = options.agents === "auto" || !options.agents ? "auto" : Number(options.agents);
    const providers = options.providers?.split(",").map((value) => value.trim()) as
      | ProviderName[]
      | undefined;
    const autonomy = options.autonomy ?? config.runPolicy.autonomy;
    if (!(["observe", "supervised", "bounded"] as const).includes(autonomy as "observe" | "supervised" | "bounded")) {
      throw new Error("Use --autonomy observe|supervised|bounded");
    }
    const request = {
      goal,
      projectPath,
      autonomy: autonomy as "observe" | "supervised" | "bounded",
      agents: agents === "auto" || Number.isInteger(agents) && agents > 0 ? agents : "auto",
      ...(providers ? { enabledProviders: providers } : {}),
    } as const;
    const runId = await orchestrator.run(request);
    const run = ledger.getRun(runId);
    console.log(JSON.stringify(run, null, 2));
    ledger.close();
    process.exitCode = run?.status === "ready" ? 0 : 1;
    return;
  }

  if (command === "serve") {
    const port = options.port ? Number(options.port) : undefined;
    const dashboard = await startDashboard({
      projectPath,
      ...(port ? { port } : {}),
      open: options.open !== "false",
    });
    console.log(`${PRODUCT_NAME} dashboard: ${dashboard.url}`);
    const shutdown = async () => {
      await dashboard.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  printHelp();
  process.exitCode = command === "help" || command === "--help" ? 0 : 1;
}

function parseOptions(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (!item?.startsWith("--")) continue;
    const [rawKey, inlineValue] = item.slice(2).split("=", 2);
    if (!rawKey) continue;
    if (inlineValue !== undefined) {
      values[rawKey] = inlineValue;
    } else if (args[index + 1] && !args[index + 1]!.startsWith("--")) {
      values[rawKey] = args[++index]!;
    } else {
      values[rawKey] = "true";
    }
  }
  return values;
}

function printHelp(): void {
  console.log(`${PRODUCT_NAME} ${VERSION} — local subscription-backed agent orchestrator

Usage:
  ${PRODUCT_SLUG} serve [--project PATH] [--port 4317] [--open false]
  ${PRODUCT_SLUG} init [--project PATH]
  ${PRODUCT_SLUG} doctor [--project PATH]
  ${PRODUCT_SLUG} run --goal "..." [--project PATH] [--agents auto|N]
             [--autonomy observe|supervised|bounded]
             [--providers codex,claude,gemini]
  ${PRODUCT_SLUG} --version
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
