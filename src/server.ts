import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeProject, loadConfig, saveConfig, devHarmonicsDirectory } from "./config.js";
import { inspectProviders } from "./doctor.js";
import { Ledger } from "./ledger.js";
import { Orchestrator } from "./orchestrator.js";
import { ModelCatalogCoordinator } from "./catalog.js";
import { modelQualificationFingerprint } from "./model-fingerprint.js";
import { QUALIFICATION_FINGERPRINT_FIXTURE, hasCurrentOperationalQualification, hasCurrentRoleQualification, qualificationFixtureVersion, qualifyRuntimeModel, qualifyWithAdapter, trackedFamilyQualificationRole, type QualificationRole } from "./qualification.js";
import { estimateQualificationCost, isExactOpenRouterModelId, OpenRouterService } from "./openrouter.js";
import { PRODUCT_NAME, VERSION } from "./product.js";
import { redactText } from "./redaction.js";
import { createRunEvidenceExport, createRunReport } from "./reporter.js";
import { observeLocalResources } from "./resources.js";
import { inspectLocalRepository } from "./repository-intelligence.js";
import { DeliveryService, type DeliveryAction } from "./delivery.js";
import { scanProductIntelligence } from "./product-intelligence.js";
import { manualModelSchema, objectiveInputSchema, productRegistrationSchema, workbenchSessionInputSchema } from "./schemas.js";
import type { ObjectiveInput, ProviderName, RunRequest, WorkbenchMessageRecord } from "./types.js";
import { inferModelProfile } from "./model-intelligence.js";
import type { ModelRecord } from "./registry.js";

const uiDirectory = fileURLToPath(new URL("./ui/", import.meta.url));

class ClientRequestError extends Error {}

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
  const delivery = new DeliveryService(ledger);
  const eventStreams = new Set<ServerResponse>();

  await catalog.refresh(true, "application_launch");
  catalog.startPeriodic();

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, { defaultProject, ledger, orchestrator, catalog, openRouter, delivery, eventStreams });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, error instanceof ClientRequestError ? 400 : 500, { error: redactText(message) });
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
    delivery: DeliveryService;
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
    const quotaGroupHealth = new Map(context.ledger.listQuotaGroupHealth().map((item) => [`${item.connectionId}\u0000${item.quotaGroupId}`, item]));
    sendJson(response, 200, {
      models: context.ledger.listModels(connectionId).map((model) => {
        const quotaGroup = typeof model.metadata.quotaGroup === "string" ? model.metadata.quotaGroup : null;
        return {
          ...model,
          health: health.get(model.id) ?? null,
          quotaGroupHealth: quotaGroup ? quotaGroupHealth.get(`${model.connectionId}\u0000${quotaGroup}`) ?? null : null,
        };
      }),
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
    const allowedRoles: QualificationRole[] = ["general", "architect", "worker", "reviewer", "analysis", "benchmark", "local_tools"];
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
    if (body.active && (!existing.qualified || existing.qualificationStale || !hasCurrentOperationalQualification(context.ledger, existing))) {
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
  const integrationSetMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/integration-set$/i);
  if (request.method === "GET" && integrationSetMatch?.[1]) {
    if (!context.ledger.getRun(integrationSetMatch[1])) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }
    const integrationSet = context.ledger.getIntegrationSet(integrationSetMatch[1]);
    sendJson(response, integrationSet ? 200 : 404, integrationSet ?? { error: "Run has no multi-repository integration set" });
    return;
  }

  const productIntelligenceMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/intelligence$/);
  if (productIntelligenceMatch?.[1] && request.method === "GET") {
    const productId = decodeURIComponent(productIntelligenceMatch[1]);
    if (!context.ledger.getProduct(productId)) {
      sendJson(response, 404, { error: "Product not found" });
      return;
    }
    const snapshot = context.ledger.latestProductIntelligenceSnapshot(productId);
    sendJson(response, snapshot ? 200 : 404, snapshot ?? { error: "Product has no intelligence snapshot" });
    return;
  }

  if (productIntelligenceMatch?.[1] && request.method === "POST") {
    requireJsonRequest(request);
    const productId = decodeURIComponent(productIntelligenceMatch[1]);
    const product = context.ledger.getProduct(productId);
    if (!product) {
      sendJson(response, 404, { error: "Product not found" });
      return;
    }
    const snapshot = context.ledger.recordProductIntelligenceSnapshot(await scanProductIntelligence(product));
    sendJson(response, 201, snapshot);
    return;
  }

  if (request.method === "GET" && runMatch?.[1]) {
    const run = context.ledger.getRun(runMatch[1]);
    sendJson(response, run ? 200 : 404, run ?? { error: "Run not found" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/objectives") {
    sendJson(response, 200, { objectives: context.ledger.listObjectives() });
    return;
  }

  const productRepositoriesMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/repositories$/);
  if (request.method === "POST" && productRepositoriesMatch?.[1]) {
    requireJsonRequest(request);
    const productId = decodeURIComponent(productRepositoriesMatch[1]);
    const product = context.ledger.getProduct(productId);
    if (!product) {
      sendJson(response, 404, { error: "Product not found" });
      return;
    }
    const body = await readJson(request) as {
      localPath?: string;
      role?: string;
      expectedBranch?: string | null;
      owners?: unknown;
      dependencyRepositoryIds?: unknown;
      governanceSources?: unknown;
      governanceRules?: unknown;
      validators?: unknown;
    };
    if (!body.localPath?.trim()) {
      sendJson(response, 400, { error: "Local repository path is required" });
      return;
    }
    const expectedBranch = body.expectedBranch?.trim() || undefined;
    const inspection = await inspectLocalRepository(body.localPath, {
      ...(expectedBranch ? { expectedCurrentBranch: expectedBranch, expectedDefaultBranch: expectedBranch } : {}),
    });
    if (!inspection.isGitRepository || !inspection.gitRoot || !inspection.repositoryName) {
      sendJson(response, 400, { error: "Local path is not a usable Git repository", inspection });
      return;
    }
    const remoteIdentity = repositoryRemoteIdentity(inspection.originRemoteUrl);
    const fullName = remoteIdentity?.fullName ?? `${product.id}/${inspection.repositoryName}`;
    const existing = product.repositories.find((repository) => repository.fullName.toLowerCase() === fullName.toLowerCase()
      || repository.localPath && path.resolve(repository.localPath) === inspection.gitRoot);
    const repositoryId = existing?.id ?? `local:${product.id}:${slugId(inspection.repositoryName)}`;
    const knownIds = new Set(product.repositories.map((repository) => repository.id).concat(repositoryId));
    const dependencyRepositoryIds = stringArray(body.dependencyRepositoryIds);
    const unknownDependencies = dependencyRepositoryIds.filter((id) => !knownIds.has(id));
    const repository = context.ledger.upsertRepository({
      id: repositoryId,
      productId: product.id,
      name: remoteIdentity?.fullName.split("/").at(-1) ?? existing?.name ?? inspection.repositoryName,
      fullName,
      url: remoteIdentity?.webUrl ?? existing?.url ?? pathToFileURL(inspection.gitRoot).toString(),
      cloneUrl: inspection.originRemoteUrl ?? existing?.cloneUrl ?? pathToFileURL(inspection.gitRoot).toString(),
      defaultBranch: inspection.defaultBranch ?? expectedBranch ?? inspection.currentBranch ?? existing?.defaultBranch ?? "main",
      visibility: existing?.visibility ?? "unknown",
      archived: existing?.archived ?? false,
      sizeKb: existing?.sizeKb ?? 0,
      language: existing?.language ?? null,
      description: existing?.description ?? null,
      intelligence: { ...(existing?.intelligence ?? {}), localInspectionStatus: inspection.status },
      localPath: inspection.gitRoot,
      role: repositoryRole(body.role),
      expectedBranch: expectedBranch ?? null,
      owners: stringArray(body.owners),
      dependencyRepositoryIds,
      validators: validatorMap(body.validators),
      governanceSources: stringArray(body.governanceSources),
      governanceRules: stringArray(body.governanceRules),
    });
    context.ledger.recordRepositoryInspection(repository.id, {
      currentBranch: inspection.currentBranch,
      headSha: inspection.headSha,
      remoteUrl: inspection.originRemoteUrl,
      dirty: inspection.dirty,
      compatibilityIssues: [...inspection.issues.map((issue) => issue.message), ...unknownDependencies.map((id) => `Dependency repository '${id}' is not registered in ${product.name}.`)],
    });
    sendJson(response, 201, { repository: context.ledger.getRepository(repository.id), inspection });
    return;
  }

  const repositoryRefreshMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/repositories\/([^/]+)\/refresh$/);
  if (request.method === "POST" && repositoryRefreshMatch?.[1] && repositoryRefreshMatch[2]) {
    requireJsonRequest(request);
    const productId = decodeURIComponent(repositoryRefreshMatch[1]);
    const repositoryId = decodeURIComponent(repositoryRefreshMatch[2]);
    const repository = context.ledger.getRepository(repositoryId);
    if (!repository || repository.productId !== productId || !repository.localPath) {
      sendJson(response, 404, { error: "Registered local repository not found" });
      return;
    }
    const inspection = await inspectLocalRepository(repository.localPath, {
      ...(repository.cloneUrl.startsWith("file:") ? {} : { expectedRemoteUrl: repository.cloneUrl }),
      ...(repository.expectedBranch ? { expectedCurrentBranch: repository.expectedBranch, expectedDefaultBranch: repository.expectedBranch } : {}),
    });
    const product = context.ledger.getProduct(productId)!;
    const knownIds = new Set(product.repositories.map((item) => item.id));
    const unknownDependencies = repository.dependencyRepositoryIds.filter((id) => !knownIds.has(id));
    context.ledger.recordRepositoryInspection(repository.id, {
      currentBranch: inspection.currentBranch,
      headSha: inspection.headSha,
      remoteUrl: inspection.originRemoteUrl,
      dirty: inspection.dirty,
      compatibilityIssues: [...inspection.issues.map((issue) => issue.message), ...unknownDependencies.map((id) => `Dependency repository '${id}' is not registered in ${product.name}.`)],
    });
    sendJson(response, 200, { repository: context.ledger.getRepository(repository.id), inspection });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workbench") {
    sendJson(response, 200, { sessions: context.ledger.listWorkbenchSessions() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workbench") {
    requireJsonRequest(request);
    const raw = await readJson(request) as Record<string, unknown>;
    const parsed = workbenchSessionInputSchema.safeParse({
      projectPath: path.resolve(String(raw.projectPath || context.defaultProject)),
      title: raw.title,
    });
    if (!parsed.success) {
      sendJson(response, 400, { error: "Workbench scratchpad is invalid", issues: parsed.error.issues });
      return;
    }
    const details = await stat(parsed.data.projectPath);
    if (!details.isDirectory()) throw new Error("Workbench project path must be a directory");
    await initializeProject(parsed.data.projectPath);
    sendJson(response, 201, { session: context.ledger.createWorkbenchSession(parsed.data) });
    return;
  }

  const workbenchMatch = url.pathname.match(/^\/api\/workbench\/([a-f0-9-]+)$/i);
  if (request.method === "GET" && workbenchMatch?.[1]) {
    const session = context.ledger.getWorkbenchSession(workbenchMatch[1]);
    sendJson(response, session ? 200 : 404, session ? { session, messages: context.ledger.listWorkbenchMessages(session.id) } : { error: "Workbench scratchpad not found" });
    return;
  }

  const workbenchConsultMatch = url.pathname.match(/^\/api\/workbench\/([a-f0-9-]+)\/consult$/i);
  if (request.method === "POST" && workbenchConsultMatch?.[1]) {
    requireJsonRequest(request);
    const session = context.ledger.getWorkbenchSession(workbenchConsultMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: "Workbench scratchpad not found" });
      return;
    }
    const body = await readJson(request) as { question?: string; modelIds?: unknown };
    const question = body.question?.trim() ?? "";
    const modelIds = Array.isArray(body.modelIds)
      ? [...new Set(body.modelIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
      : [];
    if (!question) {
      sendJson(response, 400, { error: "Workbench question is required" });
      return;
    }
    if (!modelIds.length) {
      sendJson(response, 400, { error: "Select at least one qualified model" });
      return;
    }
    const prior = context.ledger.listWorkbenchMessages(session.id);
    const discussionContext = prior.map((message) => {
      const identity = message.role === "user" ? "User" : message.provider || message.role;
      const bodyText = message.status === "failed" ? `[failed: ${message.error}]` : message.content;
      return `${identity}: ${bodyText}`;
    }).join("\n\n");
    const userMessage = context.ledger.appendWorkbenchMessage({ sessionId: session.id, role: "user", content: question });
    let responses: WorkbenchMessageRecord[] = [];
    const consultations = await context.orchestrator.consultWorkbench({
      sessionId: session.id,
      projectPath: session.projectPath,
      question,
      discussionContext,
      modelIds,
      persist: (results) => {
        responses = results.map((consultation) => context.ledger.appendWorkbenchMessage({
          sessionId: session.id,
          role: "assistant",
          content: consultation.text ?? "",
          provider: consultation.provider,
          connectionId: consultation.connectionId,
          requestedModelId: consultation.requestedModelId,
          resolvedModelId: consultation.resolvedModelId,
          status: consultation.status,
          error: consultation.error,
          inputTokens: consultation.inputTokens,
          outputTokens: consultation.outputTokens,
          costUsd: consultation.costUsd,
          durationMs: consultation.durationMs,
          paidSpendReservationId: consultation.paidSpendReservationId,
        }));
      },
    });
    sendJson(response, 201, { userMessage, responses });
    return;
  }

  const workbenchConvertMatch = url.pathname.match(/^\/api\/workbench\/([a-f0-9-]+)\/convert$/i);
  if (request.method === "POST" && workbenchConvertMatch?.[1]) {
    requireJsonRequest(request);
    const session = context.ledger.getWorkbenchSession(workbenchConvertMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: "Workbench scratchpad not found" });
      return;
    }
    if (session.objectiveId) {
      const objective = context.ledger.getObjective(session.objectiveId);
      sendJson(response, 409, { error: "This Workbench discussion is already linked to an objective", objective });
      return;
    }
    const raw = await readJson(request) as Record<string, unknown>;
    const policyNotes = Array.isArray(raw.policyNotes) ? raw.policyNotes : [];
    const parsed = objectiveInputSchema.safeParse({
      ...raw,
      projectPath: session.projectPath,
      policyNotes: [...policyNotes, `Workbench source: ${session.id}`],
    });
    if (!parsed.success) {
      sendJson(response, 400, { error: "Objective draft is invalid", issues: parsed.error.issues });
      return;
    }
    const objective = context.ledger.createObjective(parsed.data);
    const updatedSession = context.ledger.linkWorkbenchObjective(session.id, objective.id);
    sendJson(response, 201, { objective, session: updatedSession });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/objectives") {
    requireJsonRequest(request);
    const raw = await readJson(request) as Record<string, unknown>;
    const parsed = objectiveInputSchema.safeParse({ ...raw, projectPath: path.resolve(String(raw.projectPath || context.defaultProject)) });
    if (!parsed.success) {
      sendJson(response, 400, { error: "Objective is invalid", issues: parsed.error.issues });
      return;
    }
    const selectionError = objectiveRepositorySelectionError(context.ledger, parsed.data);
    if (selectionError) {
      sendJson(response, 400, { error: selectionError });
      return;
    }
    const details = await stat(parsed.data.projectPath);
    if (!details.isDirectory()) throw new Error("Project path must be a directory");
    await initializeProject(parsed.data.projectPath);
    sendJson(response, 201, { objective: context.ledger.createObjective(parsed.data) });
    return;
  }

  const objectiveMatch = url.pathname.match(/^\/api\/objectives\/([a-f0-9-]+)$/i);
  if (request.method === "GET" && objectiveMatch?.[1]) {
    const objective = context.ledger.getObjective(objectiveMatch[1]);
    sendJson(response, objective ? 200 : 404, objective ? { objective } : { error: "Objective not found" });
    return;
  }
  if (request.method === "PUT" && objectiveMatch?.[1]) {
    requireJsonRequest(request);
    const raw = await readJson(request) as Record<string, unknown>;
    const expectedRevision = Number(raw.expectedRevision);
    const parsed = objectiveInputSchema.safeParse({ ...raw, projectPath: path.resolve(String(raw.projectPath || context.defaultProject)) });
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      sendJson(response, 400, { error: "expectedRevision must be a positive integer" });
      return;
    }
    if (!parsed.success) {
      sendJson(response, 400, { error: "Objective is invalid", issues: parsed.error.issues });
      return;
    }
    const selectionError = objectiveRepositorySelectionError(context.ledger, parsed.data);
    if (selectionError) {
      sendJson(response, 400, { error: selectionError });
      return;
    }
    sendJson(response, 200, { objective: context.ledger.updateObjective(objectiveMatch[1], parsed.data, expectedRevision) });
    return;
  }

  const objectivePlansMatch = url.pathname.match(/^\/api\/objectives\/([a-f0-9-]+)\/plans$/i);
  if (request.method === "GET" && objectivePlansMatch?.[1]) {
    const objective = context.ledger.getObjective(objectivePlansMatch[1]);
    sendJson(response, objective ? 200 : 404, objective ? { plans: context.ledger.listPlanRevisions(objective.id) } : { error: "Objective not found" });
    return;
  }
  if (request.method === "POST" && objectivePlansMatch?.[1]) {
    requireJsonRequest(request);
    const objective = context.ledger.getObjective(objectivePlansMatch[1]);
    if (!objective) {
      sendJson(response, 404, { error: "Objective not found" });
      return;
    }
    const body = await readJson(request) as { enabledProviders?: ProviderName[]; revisionFeedback?: string; rationale?: string };
    const previous = context.ledger.listPlanRevisions(objective.id).at(-1) ?? null;
    const proposal = await context.orchestrator.proposeObjectivePlan({
      objective,
      ...(body.enabledProviders ? { enabledProviders: body.enabledProviders } : {}),
      previous,
      ...(body.revisionFeedback?.trim() ? { revisionFeedback: body.revisionFeedback.trim() } : {}),
    });
    const rationale = body.rationale?.trim() || body.revisionFeedback?.trim() || (previous ? "Refined objective plan" : "Initial objective plan");
    const revision = context.ledger.appendPlanRevision(objective.id, proposal.plan, rationale);
    sendJson(response, 201, { objective, revision, preview: proposal.preview });
    return;
  }

  const objectiveStartMatch = url.pathname.match(/^\/api\/objectives\/([a-f0-9-]+)\/plans\/(\d+)\/start$/i);
  if (request.method === "POST" && objectiveStartMatch?.[1] && objectiveStartMatch[2]) {
    requireJsonRequest(request);
    const objective = context.ledger.getObjective(objectiveStartMatch[1]);
    const revisionNumber = Number(objectiveStartMatch[2]);
    const storedRevision = objective ? context.ledger.getPlanRevision(objective.id, revisionNumber) : null;
    if (!objective || !storedRevision) {
      sendJson(response, 404, { error: "Objective or plan revision not found" });
      return;
    }
    const execution = context.orchestrator.objectiveExecutionReadiness(objective, storedRevision.plan);
    if (!execution.supported) {
      sendJson(response, 409, { error: execution.reason, execution });
      return;
    }
    const body = await readJson(request) as { agents?: number | "auto"; enabledProviders?: ProviderName[] };
    const revision = context.ledger.approvePlanRevision(objective.id, revisionNumber);
    const agents = body.agents === "auto" ? "auto" : Number(body.agents);
    const runId = context.orchestrator.beginApprovedObjective({
      objective,
      revision,
      agents: agents === "auto" || Number.isInteger(agents) && agents > 0 ? agents : "auto",
      ...(body.enabledProviders ? { enabledProviders: body.enabledProviders } : {}),
    });
    sendJson(response, 202, { runId, objectiveId: objective.id, approvedPlanRevision: revision.revision });
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

  const deliveryMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/delivery$/i);
  if (request.method === "GET" && deliveryMatch?.[1]) {
    const run = context.ledger.getRun(deliveryMatch[1]);
    sendJson(response, run ? 200 : 404, run ? { delivery: run.delivery } : { error: "Run not found" });
    return;
  }
  if (request.method === "POST" && deliveryMatch?.[1]) {
    requireJsonRequest(request);
    const body = await readJson(request) as { repositoryId?: unknown; action?: unknown; expectedHeadCommit?: unknown };
    const repositoryId = typeof body.repositoryId === "string" ? body.repositoryId.trim() : "";
    const action = body.action as DeliveryAction;
    const expectedHeadCommit = typeof body.expectedHeadCommit === "string" ? body.expectedHeadCommit.trim() : "";
    if (!repositoryId || !["push_branch", "create_draft_pr"].includes(action) || !expectedHeadCommit) {
      throw new ClientRequestError("Delivery requires repositoryId, expectedHeadCommit, and a supported action");
    }
    const run = context.ledger.getRun(deliveryMatch[1]);
    if (!run) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }
    const config = await loadConfig(run.projectPath);
    const result = await context.delivery.execute({
      runId: run.id,
      repositoryId,
      action,
      expectedHeadCommit,
      config,
      approval: { id: randomUUID(), kind: "external_write", approvedBy: "local-owner", approvedAt: new Date().toISOString() },
    });
    sendJson(response, 200, { delivery: result });
    return;
  }

  const reportMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/report$/i);
  if (request.method === "GET" && reportMatch?.[1]) {
    const evidence = context.ledger.getRunEvidence(reportMatch[1]);
    sendJson(response, evidence ? 200 : 404, evidence ? createRunReport(evidence) : { error: "Run not found" });
    return;
  }

  const evidenceExportMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/evidence\/export$/i);
  if (request.method === "GET" && evidenceExportMatch?.[1]) {
    const evidence = context.ledger.getRunEvidence(evidenceExportMatch[1]);
    if (!evidence) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="devharmonics-${evidenceExportMatch[1]}-evidence.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(`${JSON.stringify(createRunEvidenceExport(evidence), null, 2)}\n`);
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

function objectiveRepositorySelectionError(ledger: Ledger, input: ObjectiveInput): string | null {
  if (!input.productId) return input.repositoryIds.length ? "Repository selection requires a product" : null;
  const product = ledger.getProduct(input.productId);
  if (!product) return `Product '${input.productId}' is not registered`;
  if (!input.repositoryIds.length) return "Select at least one repository for a product objective";
  if (new Set(input.repositoryIds).size !== input.repositoryIds.length) return "Objective repository selection contains duplicates";
  const known = new Set(product.repositories.map((repository) => repository.id));
  const unknown = input.repositoryIds.filter((repositoryId) => !known.has(repositoryId));
  return unknown.length ? `Repositories are not registered in ${product.name}: ${unknown.join(", ")}` : null;
}

function repositoryRole(value: unknown): "umbrella" | "shared_platform" | "module" | "desktop" | "installer" | "documentation" | "release_truth" | "other" {
  const roles = ["umbrella", "shared_platform", "module", "desktop", "installer", "documentation", "release_truth", "other"] as const;
  return roles.includes(value as typeof roles[number]) ? value as typeof roles[number] : "other";
}

function validatorMap(value: unknown): Record<string, { command: string; args: string[]; timeoutMs: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, commandLine]) => {
    if (typeof commandLine !== "string" || !name.trim() || !commandLine.trim()) return [];
    const parts = commandLine.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^(?:"|')|(?:"|')$/g, "")) ?? [];
    const command = parts.shift();
    return command ? [[name.trim(), { command, args: parts, timeoutMs: 120_000 }]] : [];
  }));
}

function repositoryRemoteIdentity(remote: string | null): { fullName: string; webUrl: string } | null {
  if (!remote) return null;
  const trimmed = remote.trim().replace(/\.git$/i, "");
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  let host: string;
  let pathname: string;
  if (scp && !trimmed.includes("://")) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  }
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const fullName = parts.slice(-2).join("/");
  return { fullName, webUrl: `https://${host}/${parts.join("/")}` };
}

function slugId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
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
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new ClientRequestError("Request body must contain valid JSON");
  }
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
    const effectiveRole = trackedFamilyQualificationRole(connection.transport, role);
    if (!model.qualified || model.qualificationStale || !hasCurrentRoleQualification(context.ledger, model, effectiveRole, effectiveRole === "local_tools" ? "workspace_write" : "read_only")) {
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
