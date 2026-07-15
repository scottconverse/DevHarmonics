import { createHash } from "node:crypto";
import type { ConnectionRecord, ModelRecord } from "./registry.js";

export function modelQualificationFingerprint(
  model: ModelRecord,
  connection: ConnectionRecord,
  fixtureVersion: string,
): string {
  const payload = {
    provider: connection.provider,
    transport: connection.transport,
    modelId: model.canonicalName,
    modelProfile: model.metadata.devHarmonicsProfile ?? null,
    capabilities: model.metadata.capabilities ?? null,
    details: model.metadata.details ?? null,
    digest: model.metadata.digest ?? null,
    contextLength: model.metadata.contextLength ?? null,
    pricing: model.metadata.pricing ?? null,
    runtimeVersion: connection.runtimeVersion,
    adapterVersion: connection.adapterVersion,
    fixtureVersion,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
