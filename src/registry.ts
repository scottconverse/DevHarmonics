import { projectLegacyProvider } from "./compatibility.js";
import type { ProviderStatus } from "./doctor.js";
import { VERSION } from "./product.js";
import type { AuthenticationMode, RuntimeTransport } from "./runtime.js";
import { inferModelProfile, profileMetadata, SUBSCRIPTION_COMPATIBILITY_MODELS } from "./model-intelligence.js";
import { antigravityModelIdentity } from "./antigravity.js";

export const MODEL_LIFECYCLES = [
  "known",
  "visible",
  "verified",
  "qualified",
  "active",
  "degraded",
  "retired",
] as const;
export type ModelLifecycle = (typeof MODEL_LIFECYCLES)[number];
export type ModelSource =
  | "manual"
  | "runtime_discovery"
  | "provider_catalog"
  | "compatibility_catalog"
  | "empirical";

export interface ConnectionRegistryInput {
  id: string;
  provider: string;
  transport: RuntimeTransport;
  authentication: AuthenticationMode;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  authenticated: boolean;
  visible: boolean;
  healthy: boolean;
  available: boolean;
  entitlement: string;
  capacity: string;
  adapterVersion: string;
  runtimeVersion: string | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ConnectionRecord extends ConnectionRegistryInput {
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ManualModelInput {
  id: string;
  connectionId: string;
  canonicalName: string;
  displayName: string;
  lifecycle: ModelLifecycle;
  visible: boolean;
  verified: boolean;
  qualified: boolean;
  active: boolean;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ModelDiscoveryInput extends ManualModelInput {
  source: Exclude<ModelSource, "manual">;
}

export interface ModelRecord extends ManualModelInput {
  source: ModelSource;
  degraded: boolean;
  retired: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedAt: string | null;
  pinned: boolean;
  excluded: boolean;
  qualificationFingerprint: string | null;
  qualificationStale: boolean;
  missingObservations: number;
  upgradePolicy: "pinned" | "track_family";
}

export interface ModelQualificationRecord {
  id: number;
  modelId: string;
  fixtureVersion: string;
  role: string;
  passed: boolean;
  score: number;
  evidence: Readonly<Record<string, unknown>>;
  fingerprint: string | null;
  createdAt: string;
}

export interface ConnectionRegistryWriter {
  upsertConnection(input: ConnectionRegistryInput): void;
  upsertDiscoveredModel?(input: ModelDiscoveryInput): void;
  retireCompatibilityModels?(connectionId: string, currentModelIds: readonly string[]): void;
  reconcileDiscoveredModels?(connectionId: string, source: ModelSource, currentModelIds: readonly string[], retirementThreshold?: number): void;
}

const displayNames: Record<string, string> = {
  codex: "OpenAI Codex",
  claude: "Claude Code",
  gemini: "Google Antigravity",
};

export function syncSubscriptionConnections(
  writer: ConnectionRegistryWriter,
  statuses: readonly ProviderStatus[],
): void {
  for (const status of statuses) {
    const projection = projectLegacyProvider(status.name);
    writer.upsertConnection({
      id: projection.connectionId,
      provider: status.name,
      transport: projection.transport,
      authentication: projection.authentication,
      displayName: displayNames[status.name] ?? status.name,
      enabled: status.enabled,
      installed: status.installed,
      authenticated: status.authenticated,
      visible: status.visible,
      healthy: status.healthy,
      available: status.available,
      entitlement: status.entitlement,
      capacity: status.capacity,
      adapterVersion: VERSION,
      runtimeVersion: status.version || null,
      metadata: {
        summary: status.summary,
        diagnostics: status.diagnostics,
        subscriptionOnly: status.subscriptionOnly,
        ...(status.name === "gemini" ? { platform: "antigravity", legacyProviderKey: "gemini" } : {}),
      },
    });
    const runtimeModelIds: string[] = [];
    for (const displayName of status.visibleModels) {
      const profile = inferModelProfile(
        { canonicalName: displayName, displayName, metadata: {} },
        { provider: status.name, transport: "subscription_cli" },
      );
      const modelId = `subscription-cli:${status.name}:model:${normalizeModelId(displayName)}`;
      runtimeModelIds.push(modelId);
      writer.upsertDiscoveredModel?.({
        id: modelId,
        connectionId: projection.connectionId,
        canonicalName: displayName,
        displayName,
        source: "runtime_discovery",
        lifecycle: "visible",
        visible: true,
        verified: false,
        qualified: false,
        active: false,
        metadata: {
          discoveredBy: status.name === "gemini" ? "Google Antigravity CLI" : `${status.name} CLI`,
          runtimeVersion: status.version,
          ...profileMetadata(profile),
          ...(status.name === "gemini" ? antigravityModelIdentity(displayName) : {}),
        },
      });
    }
    writer.reconcileDiscoveredModels?.(projection.connectionId, "runtime_discovery", runtimeModelIds, 3);
  }
  for (const catalogModel of SUBSCRIPTION_COMPATIBILITY_MODELS) {
    const status = statuses.find((item) => item.name === catalogModel.provider);
    if (!status) continue;
    if (status.visibleModels.some((name) => normalizeModelId(name) === normalizeModelId(catalogModel.canonicalName))) continue;
    writer.upsertDiscoveredModel?.({
      id: `subscription-cli:${catalogModel.provider}:model:${normalizeModelId(catalogModel.canonicalName)}`,
      connectionId: projectLegacyProvider(catalogModel.provider).connectionId,
      canonicalName: catalogModel.canonicalName,
      displayName: catalogModel.displayName,
      source: "compatibility_catalog",
      lifecycle: "known",
      visible: false,
      verified: false,
      qualified: false,
      active: false,
      metadata: {
        catalogAlias: true,
        requiresRuntimeQualification: true,
        ...profileMetadata({
          tier: catalogModel.tier,
          family: catalogModel.family,
          capabilities: catalogModel.capabilities,
          source: "catalog",
          reasoningEffort: null,
          confidence: "official",
          evidenceUrls: [catalogModel.officialSource],
        }),
      },
    });
  }
  for (const provider of ["codex", "claude"] as const) {
    const connectionId = projectLegacyProvider(provider).connectionId;
    const currentModelIds = SUBSCRIPTION_COMPATIBILITY_MODELS
      .filter((model) => model.provider === provider)
      .map((model) => `subscription-cli:${provider}:model:${normalizeModelId(model.canonicalName)}`);
    writer.reconcileDiscoveredModels?.(connectionId, "compatibility_catalog", currentModelIds, 3);
  }
}

function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
