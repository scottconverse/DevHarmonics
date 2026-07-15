import type { DevHarmonicsConfig } from "./types.js";
import { loadConfig } from "./config.js";
import { inspectProviders, type ProviderStatus } from "./doctor.js";
import type { Ledger } from "./ledger.js";
import { modelQualificationFingerprint } from "./model-fingerprint.js";
import { inferModelProfile, profileMetadata } from "./model-intelligence.js";
import { syncOllamaRuntimes, type OllamaDiscovery } from "./ollama.js";
import { QUALIFICATION_FINGERPRINT_FIXTURE } from "./qualification.js";
import { syncSubscriptionConnections } from "./registry.js";
import { OpenRouterService } from "./openrouter.js";

const CLAUDE_MODELS_URL = "https://platform.claude.com/docs/en/about-claude/models/overview";
const DEFAULT_REFRESH_HOURS = 24;

export interface CatalogRefreshResult {
  config: DevHarmonicsConfig;
  providers: ProviderStatus[];
  ollama: OllamaDiscovery[];
  refreshedAt: string;
}

export class ModelCatalogCoordinator {
  private refreshInFlight: Promise<CatalogRefreshResult> | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ledger: Ledger, private readonly projectPath: string) {}

  async refresh(force = false, source = "manual"): Promise<CatalogRefreshResult> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!force && !this.isStale()) return this.snapshot();
    this.refreshInFlight = this.performRefresh(source).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async ensureFresh(): Promise<CatalogRefreshResult> {
    const config = await loadConfig(this.projectPath);
    const maxAgeMs = DEFAULT_REFRESH_HOURS * 60 * 60_000;
    const coordinator = this.ledger.listCatalogRefreshes().find((item) => item.provider === "coordinator");
    const stale = !coordinator || Date.now() - Date.parse(coordinator.refreshedAt) >= maxAgeMs;
    const providers = await inspectProviders(config, this.projectPath);
    const knownVersions = new Map(this.ledger.listConnections().map((connection) => [connection.provider, connection.runtimeVersion]));
    const versionChanged = providers.some((provider) => provider.installed && knownVersions.get(provider.name) !== (provider.version || null));
    return stale || versionChanged ? this.refresh(true, stale ? "pre_run_stale" : "pre_run_runtime_changed") : this.snapshot(config, providers);
  }

  startPeriodic(): void {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      void this.refresh(true, "periodic").catch((error) => {
        this.ledger.recordCatalogRefresh({ provider: "coordinator", status: "failed", source: "periodic", modelCount: 0, detail: error instanceof Error ? error.message : String(error) });
      });
    }, DEFAULT_REFRESH_HOURS * 60 * 60_000);
    this.periodicTimer.unref();
  }

  stop(): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = null;
  }

  private isStale(): boolean {
    const refresh = this.ledger.listCatalogRefreshes().find((item) => item.provider === "coordinator");
    return !refresh || Date.now() - Date.parse(refresh.refreshedAt) >= DEFAULT_REFRESH_HOURS * 60 * 60_000;
  }

  private async snapshot(config?: DevHarmonicsConfig, providers?: ProviderStatus[]): Promise<CatalogRefreshResult> {
    const resolvedConfig = config ?? await loadConfig(this.projectPath);
    return {
      config: resolvedConfig,
      providers: providers ?? await inspectProviders(resolvedConfig, this.projectPath),
      ollama: [],
      refreshedAt: newestRefresh(this.ledger) ?? new Date(0).toISOString(),
    };
  }

  private async performRefresh(source: string): Promise<CatalogRefreshResult> {
    const config = await loadConfig(this.projectPath);
    const openRouter = new OpenRouterService(this.ledger);
    await openRouter.syncConnection(config.openRouter.enabled);
    const providers = await inspectProviders(config, this.projectPath);
    syncSubscriptionConnections(this.ledger, providers);
    for (const provider of providers) {
      this.ledger.recordCatalogRefresh({
        provider: provider.name,
        status: provider.installed ? "success" : "failed",
        source: provider.name === "claude" ? "Claude CLI control plane" : `${provider.name} runtime catalog`,
        modelCount: provider.visibleModels.length,
        detail: provider.summary,
      });
    }

    await this.refreshClaudeOfficialCatalog();
    try {
      await openRouter.syncCatalog();
    } catch (error) {
      this.ledger.recordCatalogRefresh({ provider: "openrouter", status: "failed", source: "https://openrouter.ai/api/v1/models", modelCount: 0, detail: error instanceof Error ? error.message : String(error) });
    }
    const ollama = await syncOllamaRuntimes(this.ledger, config.localRuntimes.ollama);
    this.ledger.recordCatalogRefresh({
      provider: "ollama",
      status: ollama.some((runtime) => runtime.available) ? "success" : "failed",
      source: "Ollama runtime discovery",
      modelCount: ollama.reduce((total, runtime) => total + runtime.models.length, 0),
      detail: ollama.some((runtime) => runtime.available) ? "Local runtime catalogs refreshed" : "No configured Ollama runtime was reachable",
    });
    this.refreshFingerprints();
    this.ledger.recordCatalogRefresh({
      provider: "coordinator",
      status: "success",
      source,
      modelCount: this.ledger.listModels().filter((model) => !model.retired).length,
      detail: "All configured provider and local-runtime catalogs were checked",
    });
    return { config, providers, ollama, refreshedAt: newestRefresh(this.ledger) ?? new Date().toISOString() };
  }

  private async refreshClaudeOfficialCatalog(): Promise<void> {
    try {
      const response = await fetch(CLAUDE_MODELS_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Anthropic returned HTTP ${response.status}`);
      const models = parseCurrentClaudeModels(await response.text());
      if (models.length < 4) throw new Error("Anthropic catalog did not expose all four current model families");
      const invalidExisting = this.ledger.listModels("subscription-cli:claude")
        .filter((model) => model.source === "provider_catalog" && !validClaudeModelId(model.canonicalName))
        .map((model) => model.id);
      this.ledger.retireInvalidModels(invalidExisting, "Rejected malformed Claude catalog identifier");
      const modelIds: string[] = [];
      const catalogModels: Array<{ id: string; canonicalName: string; displayName: string; metadata: Readonly<Record<string, unknown>> }> = [];
      for (const canonicalName of models) {
        const id = `subscription-cli:claude:model:${normalizeModelId(canonicalName)}`;
        modelIds.push(id);
        catalogModels.push({ id, canonicalName, displayName: displayClaudeName(canonicalName), metadata: { officialSource: CLAUDE_MODELS_URL, requiresRuntimeQualification: true } });
        const inferred = inferModelProfile({ canonicalName, displayName: displayClaudeName(canonicalName), metadata: {} }, { provider: "claude", transport: "subscription_cli" });
        this.ledger.upsertDiscoveredModel({
          id,
          connectionId: "subscription-cli:claude",
          canonicalName,
          displayName: displayClaudeName(canonicalName),
          source: "provider_catalog",
          lifecycle: "known",
          visible: false,
          verified: false,
          qualified: false,
          active: false,
          metadata: {
            officialCatalog: true,
            officialSource: CLAUDE_MODELS_URL,
            requiresRuntimeQualification: true,
            ...profileMetadata({ ...inferred, source: "catalog", confidence: "official", evidenceUrls: [CLAUDE_MODELS_URL] }),
          },
        });
      }
      this.ledger.upsertProviderCatalogModels("claude", catalogModels, 3);
      this.ledger.reconcileDiscoveredModels("subscription-cli:claude", "provider_catalog", modelIds, 3);
      this.ledger.recordCatalogRefresh({ provider: "claude-official", status: "success", source: CLAUDE_MODELS_URL, modelCount: models.length, detail: "Official Anthropic current-model catalog refreshed" });
    } catch (error) {
      this.ledger.recordCatalogRefresh({ provider: "claude-official", status: "failed", source: CLAUDE_MODELS_URL, modelCount: 0, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  private refreshFingerprints(): void {
    const connections = new Map(this.ledger.listConnections().map((connection) => [connection.id, connection]));
    for (const model of this.ledger.listModels().filter((item) => !item.retired)) {
      const connection = connections.get(model.connectionId);
      if (!connection) continue;
      this.ledger.applyModelFingerprint(model.id, modelQualificationFingerprint(model, connection, QUALIFICATION_FINGERPRINT_FIXTURE));
    }
  }
}

export function parseCurrentClaudeModels(html: string): string[] {
  const matches = [...html.matchAll(/claude-(fable|opus|sonnet|haiku)-(\d+(?:-\d+)*(?:-\d{8})?)/gi)]
    .map((match) => match[0].toLowerCase())
    .filter(validClaudeModelId);
  const latest = new Map<string, string>();
  for (const model of new Set(matches)) {
    const family = model.split("-")[1]!;
    const existing = latest.get(family);
    if (!existing || compareModelVersions(model, existing) > 0) latest.set(family, model);
  }
  return ["fable", "opus", "sonnet", "haiku"].map((family) => latest.get(family)).filter((value): value is string => Boolean(value));
}

function validClaudeModelId(model: string): boolean {
  const segments = model.match(/\d+/g) ?? [];
  return segments.length > 0 && segments.every((segment, index) => segment.length === 1 || index === segments.length - 1 && segment.length === 8);
}

function compareModelVersions(left: string, right: string): number {
  const numbers = (value: string) => value.match(/\d+/g)?.map(Number) ?? [];
  const leftParts = numbers(left);
  const rightParts = numbers(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return left.localeCompare(right);
}

function displayClaudeName(model: string): string {
  return model.split("-").map((part, index) => index === 0 ? "Claude" : /^\d+$/.test(part) ? part : `${part[0]?.toUpperCase()}${part.slice(1)}`).join(" ");
}

function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function newestRefresh(ledger: Ledger): string | null {
  return ledger.listCatalogRefreshes().map((item) => item.refreshedAt).sort().at(-1) ?? null;
}
