import { domainId, type ModelId, type ProviderConnectionId } from "./domain.js";
import type { ProviderName } from "./types.js";

export interface LegacyProviderProjection {
  provider: ProviderName;
  connectionId: ProviderConnectionId;
  modelId: ModelId;
  transport: "subscription_cli";
  authentication: "subscription";
  modelResolution: "provider_default_unresolved";
}

/**
 * Projects the fixed v0.1 provider field into stable provider-neutral identities.
 * The exact model remains explicitly unresolved because the legacy CLI receipt did
 * not persist it; later runtime adapters can replace this projection with a concrete
 * connection and model without changing run/task identity.
 */
export function projectLegacyProvider(provider: ProviderName): LegacyProviderProjection {
  return {
    provider,
    connectionId: domainId("ProviderConnection", `subscription-cli:${provider}`),
    modelId: domainId("Model", `provider-default:${provider}`),
    transport: "subscription_cli",
    authentication: "subscription",
    modelResolution: "provider_default_unresolved",
  };
}
