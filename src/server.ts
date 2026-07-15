import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject, loadConfig, saveConfig, devHarmonicsDirectory } from "./config.js";
import { inspectProviders } from "./doctor.js";
import { Ledger } from "./ledger.js";
import { Orchestrator } from "./orchestrator.js";
import { ModelCatalogCoordinator } from "./catalog.js";
import { modelQualificationFingerprint } from "./model-fingerprint.js";
import { QUALIFICATION_FINGERPRINT_FIXTURE, qualificationFixtureVersion, qualifyRuntimeModel, qualifyWithAdapter, type QualificationRole } from "./qualification.js";
import { estimateQualificationCost, isExactOpenRouterModelId, OpenRouterService } from "./openrouter.js";
import { PRODUCT_NAME, VERSION } from "./product.js";
import { redactText } from "./redaction.js";
import { observeLocalResources } from "./resources.js";
import { manualModelSchema, productRegistrationSchema } from "./schemas.js";
import type { ProviderName, RunRequest } from "./types.js";
import { inferModelProfile } from "./model-intelligence.js";
import type { ModelRecord } from "./registry.js";

const uiDirectory = fileURLToPath(new URL("./ui/", import.meta.url));

export async function startDashboard(options: {
  projectPath: string;
  port?: number;
  open?: boolean;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const defaultProject = path.resolve(options.projectPath);
  await initializeProject(defaultProject);
  const ledger = new Ledger(path.join(devHarmonicsDirectory(defaultProject), "devharmonics.db"));
  ledger.reconcileInterruptedRuns();
  const orchestrator = new Orchestrator(ledger);
  const catalog = new ModelCatalogCoordinator(ledger, defaultProject);
  const openRouter = new OpenRouterService(ledger);
  const eventStreams = new Set<ServerResponse>();

  await catalog.refresh(true, "application_launch");
  catalog.startPeriodic();

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, { defaultProject, ledger, orchestrator, catalog, openRouter, eventStreams });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: redactText(message) });
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
      catalog.stop();
      for (const stream of eventStreams) stream.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await orchestrator.shutdown();
      ledger.close();
    },
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    defaultProject: string;
    ledger: Ledger;
    orchestrator: Orchestrator;
    catalog: ModelCatalogCoordinator;
    openRouter: OpenRouterService;
    eventStreams: Set<ServerResponse>;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const { config, providers, ollama, refreshedAt } = await context.catalog.refresh(false);
    sendJson(response, 200, {
      product: { name: PRODUCT_NAME, version: VERSION },
      defaultProject: context.defaultProject,
      config,
      providers,
      ollama,
      catalog: { refreshedAt, refreshes: context.ledger.listCatalogRefreshes() },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/catalog/refresh") {
    requireJsonRequest(request);
    const result = await context.catalog.refresh(true, "manual_refresh_fleet");
    sendJson(response, 200, { ...result, refreshes: context.ledger.listCatalogRefreshes() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/catalog/refreshes") {
    sendJson(response, 200, { refreshes: context.ledger.listCatalogRefreshes() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/openrouter/status") {
    sendJson(response, 200, await context.openRouter.status());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/connect") {
    requireJsonRequest(request);
    const host = request.headers.host ?? "";
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error("OpenRouter OAuth requires the local dashboard host");
    const callbackUrl = `http://${host}/api/openrouter/callback`;
    sendJson(response, 200, { authorizationUrl: context.openRouter.beginOAuth(callbackUrl) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/openrouter/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) throw new Error("OpenRouter OAuth callback is missing its authorization code");
    await context.openRouter.completeOAuth(code, state);
    const config = await loadConfig(context.defaultProject);
    await context.openRouter.syncConnection(config.openRouter.enabled);
    response.writeHead(302, { Location: "/?openrouter=connected#models", "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/disconnect") {
    requireJsonRequest(request);
    await context.openRouter.disconnect();
    const config = await loadConfig(context.defaultProject);
    await context.openRouter.syncConnection(config.openRouter.enabled);
    sendJson(response, 200, { connected: false });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/openrouter/catalog") {
    const query = url.searchParams.get("q") ?? "";
    const models = context.ledger.listProviderCatalogModels("openrouter", query, 100).map((model) => ({ ...model, exact: isExactOpenRouterModelId(model.canonicalName), estimatedQualificationCostUsd: estimateQualificationCost(model) }));
    sendJson(response, 200, { models });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/models/activate") {
    requireJsonRequest(request);
    const body = await readJson(request) as { modelId?: string };
    if (!body.modelId) throw new Error("OpenRouter modelId is required");
    sendJson(response, 201, { model: context.openRouter.activateCatalogModel(body.modelId) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJson(response, 200, { runs: context.ledger.listRuns() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/products") {
    sendJson(response, 200, { products: context.ledger.listProducts() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/products") {
    requireJsonRequest(request);
    const parsed = productRegistrationSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendJson(response, 400, {
        error: "Invalid product registration",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
      return;
    }
    sendJson(response, 201, { product: context.ledger.upsertProduct(parsed.data) });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/config") {
    requireJsonRequest(request);
    const config = await saveConfig(context.defaultProject, await readJson(request));
    await context.openRouter.syncConnection(config.openRouter.enabled);
    sendJson(response, 200, { config });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/connections") {
    const health = new Map(context.ledger.listConnectionHealth().map((item) => [item.connectionId, item]));
    sendJson(response, 200, { connections: context.ledger.listConnections().map((connection) => ({ ...connection, health: health.get(connection.id) ?? null })) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    const connectionId = url.searchParams.get("connectionId") ?? undefined;
    const health = new Map(context.ledger.listModelHealth().map((item) => [item.modelId, item]));
    sendJson(response, 200, {
      models: context.ledger.listModels(connectionId).map((model) => ({ ...model, health: health.get(model.id) ?? null })),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/model-performance") {
    const modelId = url.searchParams.get("modelId") ?? undefined;
    sendJson(response, 200, {
      profiles: context.ledger.listModelPerformanceProfiles(modelId),
      policies: context.ledger.listModelPerformancePolicies().filter((policy) => !modelId || policy.modelId === modelId),
    });
    return;
  }

  const performancePolicyMatch = url.pathname.match(/^\/api\/model-performance\/(.+)\/policy$/);
  if (request.method === "PUT" && performancePolicyMatch?.[1]) {
    requireJsonRequest(request);
    const modelId = decodeURIComponent(performancePolicyMatch[1]);
    if (!context.ledger.getModel(modelId)) {
      sendJson(response, 404, { error: "Model not found" });
      return;
    }
    const body = await readJson(request) as { reset?: boolean; excluded?: boolean };
    if (body.reset !== undefined && typeof body.reset !== "boolean" || body.excluded !== undefined && typeof body.excluded !== "boolean") {
      sendJson(response, 400, { error: "Performance policy requires boolean reset or excluded fields" });
      return;
    }
    const policy = context.ledger.setModelPerformancePolicy(modelId, {
      ...(body.reset ? { ignoredBefore: new Date().toISOString() } : {}),
      ...(body.excluded === undefined ? {} : { excluded: body.excluded }),
    });
    sendJson(response, 200, { policy });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/resources") {
    sendJson(response, 200, { resources: await observeLocalResources() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/qualifications") {
    const modelId = url.searchParams.get("modelId") ?? undefined;
    sendJson(response, 200, { qualifications: context.ledger.listModelQualifications(modelId) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    const headerCursor = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0] ?? null
      : request.headers["last-event-id"] ?? null;
    const after = parseIntegerQuery(url.searchParams.get("after") ?? headerCursor, 0, "after");
    await streamEvents(request, response, context.ledger, context.eventStreams, after);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/models") {
    requireJsonRequest(request);
    const parsed = manualModelSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendJson(response, 400, {
        error: "Invalid manual model entry",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
      return;
    }
    const model = context.ledger.addManualModel(parsed.data);
    sendJson(response, 201, { model });
    return;
  }

  const qualifyModelMatch = url.pathname.match(/^\/api\/models\/(.+)\/qualify$/);
  if (request.method === "POST" && qualifyModelMatch?.[1]) {
    requireJsonRequest(request);
    const modelId = decodeURIComponent(qualifyModelMatch[1]);
    const model = context.ledger.getModel(modelId);
    if (!model) {
      sendJson(response, 404, { error: "Model not found" });
      return;
    }
    const connection = context.ledger.listConnections().find((item) => item.id === model.connectionId);
    if (!connection) {
      sendJson(response, 409, { error: "Model connection is not available" });
      return;
    }
    const body = await readJson(request) as { role?: QualificationRole; confirmPaidCost?: boolean };
    const allowedRoles: QualificationRole[] = ["general", "architect", "worker", "reviewer", "analysis", "benchmark"];
    const role = body.role ?? (connection.transport === "local" ? "analysis" : "general");
    if (!allowedRoles.includes(role)) {
      sendJson(response, 400, { error: "Unknown qualification role" });
      return;
    }
    if (connection.provider === "openrouter" && !body.confirmPaidCost) {
      sendJson(response, 409, { error: "Paid qualification requires explicit cost confirmation", requiresCostConfirmation: true, estimatedCostUsd: estimateQualificationCost(model) });
      return;
    }
    if (connection.provider === "openrouter") await context.openRouter.assertQualificationCredit(estimateQualificationCost(model));
    const { outcome, qualification } = await qualifyAndRecord(context, modelId, role);
    sendJson(response, outcome.passed ? 200 : 422, { ...(outcome.passed ? {} : { error: "Model qualification failed; see qualification history" }), qualification, model: context.ledger.getModel(modelId) });
    return;
  }

  const preferenceModelMatch = url.pathname.match(/^\/api\/models\/(.+)\/preference$/);
  if (request.method === "PUT" && preferenceModelMatch?.[1]) {
    requireJsonRequest(request);
    const body = await readJson(request) as { pinned?: boolean; excluded?: boolean; active?: boolean; upgradePolicy?: "pinned" | "track_family"; confirmPaidCost?: boolean };
    const modelId = decodeURIComponent(preferenceModelMatch[1]);
    const existing = context.ledger.getModel(modelId);
    if (!existing) {
      sendJson(response, 404, { error: "Model not found" });
      return;
    }
    if (body.active && (!existing.qualified || existing.qualificationStale)) {
      const connection = context.ledger.listConnections().find((item) => item.id === existing.connectionId);
      if (connection?.provider === "openrouter" && !body.confirmPaidCost) {
        sendJson(response, 409, { error: "Paid qualification requires explicit cost confirmation", requiresCostConfirmation: true, estimatedCostUsd: estimateQualificationCost(existing) });
        return;
      }
      if (connection?.provider === "openrouter") await context.openRouter.assertQualificationCredit(estimateQualificationCost(existing));
      const role: QualificationRole = connection?.transport === "local" ? "analysis" : "general";
      const { outcome } = await qualifyAndRecord(context, modelId, role);
      if (!outcome.passed) {
        sendJson(response, 422, { error: "Model failed automatic activation qualification", model: context.ledger.getModel(modelId) });
        return;
      }
    }
    const model = context.ledger.setModelPreference(modelId, body);
    sendJson(response, 200, { model });
    return;
  }

  const eventsMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/events$/i);
  if (request.method === "GET" && eventsMatch?.[1]) {
    if (!context.ledger.getRun(eventsMatch[1])) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }
    const after = parseIntegerQuery(url.searchParams.get("after"), 0, "after");
    const limit = parseIntegerQuery(url.searchParams.get("limit"), 200, "limit");
    const events = context.ledger.listEvents(eventsMatch[1], { after, limit });
    sendJson(response, 200, {
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
    });
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
    const config = await loadConfig(projectPath);
    await context.catalog.ensureFresh();
    await qualifyEligibleCandidates(context);
    const agents = body.agents === "auto" ? "auto" : Number(body.agents);
    const enabledProviders = body.enabledProviders as ProviderName[] | undefined;
    const autonomy = body.autonomy ?? config.runPolicy.autonomy;
    if (!(["observe", "supervised", "bounded"] as const).includes(autonomy)) throw new Error("Run autonomy must be observe, supervised, or bounded");
    const runId = context.orchestrator.begin({
      goal: body.goal.trim(),
      projectPath,
      autonomy,
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

  const evidenceMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/evidence$/i);
  if (request.method === "GET" && evidenceMatch?.[1]) {
    const evidence = context.ledger.getRunEvidence(evidenceMatch[1]);
    sendJson(response, evidence ? 200 : 404, evidence ?? { error: "Run not found" });
    return;
  }

  const pauseRunMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/pause$/i);
  if (request.method === "POST" && pauseRunMatch?.[1]) {
    requireJsonRequest(request);
    const paused = context.orchestrator.pause(pauseRunMatch[1]);
    sendJson(response, paused ? 200 : 409, paused ? { status: "paused" } : { error: "Run is not active" });
    return;
  }

  const approveRunMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/approve$/i);
  if (request.method === "POST" && approveRunMatch?.[1]) {
    requireJsonRequest(request);
    const approved = context.orchestrator.approve(approveRunMatch[1]);
    sendJson(response, approved ? 200 : 409, approved ? { status: "running" } : { error: "Run is not waiting for an active plan approval" });
    return;
  }

  const resumeRunMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/resume$/i);
  if (request.method === "POST" && resumeRunMatch?.[1]) {
    requireJsonRequest(request);
    const runId = context.orchestrator.resume(resumeRunMatch[1]);
    sendJson(response, runId ? 202 : 409, runId ? { runId } : { error: "Only paused runs can resume" });
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
      "Pragma": "no-cache",
      "Expires": "0",
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

async function qualifyAndRecord(
  context: { defaultProject: string; ledger: Ledger; openRouter?: OpenRouterService },
  modelId: string,
  role: QualificationRole,
) {
  const model = context.ledger.getModel(modelId);
  if (!model) throw new Error(`Model '${modelId}' was not found`);
  const connection = context.ledger.listConnections().find((item) => item.id === model.connectionId);
  if (!connection) throw new Error("Model connection is not available");
  const config = await loadConfig(context.defaultProject);
  const fingerprint = modelQualificationFingerprint(model, connection, QUALIFICATION_FINGERPRINT_FIXTURE);
  context.ledger.applyModelFingerprint(modelId, fingerprint);
  const refreshedModel = context.ledger.getModel(modelId)!;
  let outcome;
  try {
    outcome = connection.provider === "openrouter"
      ? await qualifyWithAdapter({ adapter: await context.openRouter!.adapter(), model: refreshedModel, cwd: context.defaultProject, role, provider: "openrouter" })
      : await qualifyRuntimeModel({ model: refreshedModel, connection, config, cwd: context.defaultProject, role });
  } catch (error) {
    outcome = {
      fixtureVersion: qualificationFixtureVersion(connection.transport, role),
      role,
      passed: false,
      score: 0,
      evidence: { connectionId: connection.id, requestedModelId: modelId, error: error instanceof Error ? error.message : String(error) },
    };
  }
  const qualification = context.ledger.recordModelQualification({ modelId, ...outcome, fingerprint });
  return { outcome, qualification };
}

async function qualifyEligibleCandidates(context: { defaultProject: string; ledger: Ledger; openRouter?: OpenRouterService }): Promise<void> {
  // Ordinary active and pinned models are requalified only when the scheduler
  // actually selects them. Family-tracked upgrade candidates are the exception:
  // they must pass both qualification and the deterministic benchmark before
  // the router may promote them over the pinned family baseline.
  const candidates = new Map<string, { model: ModelRecord; role: QualificationRole; benchmark: boolean }>();
  const config = await loadConfig(context.defaultProject);
  for (const role of ["architect", "worker", "reviewer"] as const) {
    const assignment = config.routing[role];
    if (assignment.upgradePolicy !== "track_family" || !assignment.modelId) continue;
    const base = context.ledger.getModel(assignment.modelId);
    if (!base) continue;
    const connection = context.ledger.listConnections().find((item) => item.id === base.connectionId);
    if (!connection || connection.provider === "openrouter") continue;
    const family = inferModelProfile(base, connection).family;
    const newest = context.ledger.listModels(base.connectionId)
      .filter((model) => !model.retired && !model.excluded && inferModelProfile(model, connection).family === family)
      .sort((left, right) => compareModelIdentifiers(right.canonicalName, left.canonicalName))[0];
    if (newest) candidates.set(newest.id, { model: newest, role, benchmark: true });
  }
  for (const { model, role, benchmark } of candidates.values()) {
    const connection = context.ledger.listConnections().find((item) => item.id === model.connectionId);
    if (!connection?.available || connection.provider === "openrouter") continue;
    const effectiveRole = connection.transport === "local" ? "analysis" : role;
    if (!model.qualified || model.qualificationStale || !context.ledger.listModelQualifications(model.id).some((item) => item.passed && item.role === effectiveRole)) {
      await qualifyAndRecord(context, model.id, effectiveRole);
    }
    if (benchmark && context.ledger.getModel(model.id)?.qualified && !context.ledger.listModelQualifications(model.id).some((item) => item.passed && item.role === "benchmark" && item.fingerprint === context.ledger.getModel(model.id)?.qualificationFingerprint)) {
      await qualifyAndRecord(context, model.id, "benchmark");
    }
  }
}

function compareModelIdentifiers(left: string, right: string): number {
  const leftNumbers = left.match(/\d+/g)?.map(Number) ?? [];
  const rightNumbers = right.match(/\d+/g)?.map(Number) ?? [];
  for (let index = 0; index < Math.max(leftNumbers.length, rightNumbers.length); index += 1) {
    const difference = (leftNumbers[index] ?? 0) - (rightNumbers[index] ?? 0);
    if (difference) return difference;
  }
  return left.localeCompare(right);
}

function parseIntegerQuery(value: string | null, fallback: number, name: string): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Query parameter '${name}' must be a non-negative integer`);
  return Number(value);
}

async function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  ledger: Ledger,
  streams: Set<ServerResponse>,
  initialCursor: number,
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.write("retry: 1000\n\n");
  streams.add(response);
  let cursor = initialCursor;

  const replay = () => {
    const events = ledger.listAllEvents({ after: cursor, limit: 500 });
    for (const event of events) {
      response.write(`id: ${event.cursor}\n`);
      response.write("event: run-event\n");
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      cursor = event.cursor;
    }
  };
  replay();
  const replayTimer = setInterval(replay, 500);
  const heartbeatTimer = setInterval(() => response.write(": keep-alive\n\n"), 15_000);

  await new Promise<void>((resolve) => {
    request.once("close", resolve);
    response.once("close", resolve);
  });
  clearInterval(replayTimer);
  clearInterval(heartbeatTimer);
  streams.delete(response);
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
