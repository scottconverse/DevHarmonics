import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject, loadConfig, devHarmonicsDirectory } from "./config.js";
import { inspectProviders } from "./doctor.js";
import { Ledger } from "./ledger.js";
import { Orchestrator } from "./orchestrator.js";
import { PRODUCT_NAME, VERSION } from "./product.js";
import type { ProviderName, RunRequest } from "./types.js";

const uiDirectory = fileURLToPath(new URL("./ui/", import.meta.url));

export async function startDashboard(options: {
  projectPath: string;
  port?: number;
  open?: boolean;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const defaultProject = path.resolve(options.projectPath);
  await initializeProject(defaultProject);
  const ledger = new Ledger(path.join(devHarmonicsDirectory(defaultProject), "devharmonics.db"));
  const orchestrator = new Orchestrator(ledger);

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, { defaultProject, ledger, orchestrator });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4317, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 4317;
  const url = `http://127.0.0.1:${port}`;
  if (options.open !== false) openBrowser(url);

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      ledger.close();
    },
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: { defaultProject: string; ledger: Ledger; orchestrator: Orchestrator },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const config = await loadConfig(context.defaultProject);
    sendJson(response, 200, {
      product: { name: PRODUCT_NAME, version: VERSION },
      defaultProject: context.defaultProject,
      config,
      providers: await inspectProviders(config, context.defaultProject),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJson(response, 200, { runs: context.ledger.listRuns() });
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)$/i);
  if (request.method === "GET" && runMatch?.[1]) {
    const run = context.ledger.getRun(runMatch[1]);
    sendJson(response, run ? 200 : 404, run ?? { error: "Run not found" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    requireJsonRequest(request);
    const body = (await readJson(request)) as Partial<RunRequest>;
    if (!body.goal?.trim()) throw new Error("Goal is required");
    const projectPath = path.resolve(body.projectPath || context.defaultProject);
    const details = await stat(projectPath);
    if (!details.isDirectory()) throw new Error("Project path must be a directory");
    await initializeProject(projectPath);
    const agents = body.agents === "auto" ? "auto" : Number(body.agents);
    const enabledProviders = body.enabledProviders as ProviderName[] | undefined;
    const runId = context.orchestrator.begin({
      goal: body.goal.trim(),
      projectPath,
      agents: agents === "auto" || Number.isInteger(agents) && agents > 0 ? agents : "auto",
      ...(enabledProviders ? { enabledProviders } : {}),
    });
    sendJson(response, 202, { runId });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/init") {
    requireJsonRequest(request);
    const body = (await readJson(request)) as { projectPath?: string };
    const projectPath = path.resolve(body.projectPath || context.defaultProject);
    await initializeProject(projectPath);
    sendJson(response, 200, { projectPath });
    return;
  }

  const cancelRunMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/cancel$/i);
  if (request.method === "POST" && cancelRunMatch?.[1]) {
    requireJsonRequest(request);
    const cancelled = context.orchestrator.cancel(cancelRunMatch[1]);
    sendJson(
      response,
      cancelled ? 200 : 404,
      cancelled ? { status: "cancelled" } : { error: "Run not found or not active" },
    );
    return;
  }

  const assets: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  };
  const asset = assets[url.pathname];
  if (request.method === "GET" && asset) {
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    response.end(await readFile(path.join(uiDirectory, asset.file)));
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function requireJsonRequest(request: IncomingMessage): void {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("Only application/json requests are accepted");
  }
  const origin = request.headers.origin;
  if (origin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    throw new Error("Cross-origin requests are not accepted");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
