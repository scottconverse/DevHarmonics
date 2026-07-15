import type { ConnectionRecord, ModelRecord } from "./registry.js";

export const ANTIGRAVITY_GEMINI_QUOTA_GROUP = "antigravity:gemini-models";
export const ANTIGRAVITY_CLAUDE_GPT_QUOTA_GROUP = "antigravity:claude-gpt-models";

export interface AntigravityModelIdentity {
  platform: "antigravity";
  modelVendor: "google" | "anthropic" | "openai" | "unknown";
  quotaGroup: string;
  quotaGroupDisplayName: string;
}

export function isAntigravityConnection(connection: Pick<ConnectionRecord, "provider" | "displayName" | "metadata">): boolean {
  return connection.metadata.platform === "antigravity"
    || connection.displayName === "Google Antigravity"
    || connection.provider === "gemini";
}

export function antigravityModelIdentity(name: string): AntigravityModelIdentity {
  const normalized = name.toLowerCase();
  if (normalized.includes("gemini")) {
    return { platform: "antigravity", modelVendor: "google", quotaGroup: ANTIGRAVITY_GEMINI_QUOTA_GROUP, quotaGroupDisplayName: "Gemini Models" };
  }
  if (normalized.includes("claude")) {
    return { platform: "antigravity", modelVendor: "anthropic", quotaGroup: ANTIGRAVITY_CLAUDE_GPT_QUOTA_GROUP, quotaGroupDisplayName: "Claude and GPT Models" };
  }
  if (normalized.includes("gpt") || normalized.includes("oss")) {
    return { platform: "antigravity", modelVendor: "openai", quotaGroup: ANTIGRAVITY_CLAUDE_GPT_QUOTA_GROUP, quotaGroupDisplayName: "Claude and GPT Models" };
  }
  return { platform: "antigravity", modelVendor: "unknown", quotaGroup: "antigravity:unknown", quotaGroupDisplayName: "Unclassified Antigravity Models" };
}

export function modelQuotaGroup(model: Pick<ModelRecord, "metadata"> | null | undefined): { id: string; displayName: string } | null {
  if (!model || typeof model.metadata.quotaGroup !== "string") return null;
  return {
    id: model.metadata.quotaGroup,
    displayName: typeof model.metadata.quotaGroupDisplayName === "string" ? model.metadata.quotaGroupDisplayName : model.metadata.quotaGroup,
  };
}

export function quotaResetAt(detail: string, now = new Date()): string | null {
  const match = detail.match(/resets?\s+in\s+(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!match) return null;
  const durationMs = Number(match[1] ?? 0) * 86_400_000
    + Number(match[2] ?? 0) * 3_600_000
    + Number(match[3] ?? 0) * 60_000
    + Number(match[4] ?? 0) * 1_000;
  return durationMs > 0 ? new Date(now.getTime() + durationMs).toISOString() : null;
}
