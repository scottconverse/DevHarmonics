import type { ConnectionRecord, ModelRecord } from "./registry.js";
import type { AgentRole, ModelTier, PlannedTask, TaskComplexity } from "./types.js";

export interface ModelProfile {
  tier: ModelTier;
  family: string;
  capabilities: string[];
  source: "catalog" | "runtime" | "inferred";
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  confidence?: "official" | "runtime" | "provisional" | "empirical";
  evidenceUrls?: string[];
}

export interface WorkloadClassification {
  complexity: TaskComplexity;
  requiredTier: ModelTier;
  factors: string[];
}

export interface CompatibilityModel {
  provider: "codex" | "claude";
  canonicalName: string;
  displayName: string;
  tier: ModelTier;
  family: string;
  capabilities: string[];
  officialSource: string;
}

export const SUBSCRIPTION_COMPATIBILITY_MODELS: readonly CompatibilityModel[] = [
  verifiedCatalogModel("codex", "gpt-5.6-sol", "GPT-5.6-Sol", "premium", "openai-sol", "https://openai.com/index/gpt-5-6/"),
  verifiedCatalogModel("codex", "gpt-5.6-terra", "GPT-5.6-Terra", "standard", "openai-terra", "https://openai.com/index/gpt-5-6/"),
  verifiedCatalogModel("codex", "gpt-5.6-luna", "GPT-5.6-Luna", "economy", "openai-luna", "https://openai.com/index/gpt-5-6/"),
  verifiedCatalogModel("claude", "claude-fable-5", "Claude Fable 5", "premium", "claude-fable", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration", ["text", "analysis", "code", "tools", "vision", "cyber-restricted"]),
  verifiedCatalogModel("claude", "claude-opus-4-8", "Claude Opus 4.8", "premium", "claude-opus", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
  verifiedCatalogModel("claude", "claude-sonnet-5", "Claude Sonnet 5", "standard", "claude-sonnet", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
  verifiedCatalogModel("claude", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", "economy", "claude-haiku", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
  verifiedCatalogModel("claude", "claude-opus-4-7", "Claude Opus 4.7", "premium", "claude-opus", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
  verifiedCatalogModel("claude", "claude-sonnet-4-6", "Claude Sonnet 4.6", "standard", "claude-sonnet", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
  verifiedCatalogModel("claude", "claude-opus-4-6", "Claude Opus 4.6", "premium", "claude-opus", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
  verifiedCatalogModel("claude", "claude-opus-4-5-20251101", "Claude Opus 4.5", "premium", "claude-opus", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
  verifiedCatalogModel("claude", "claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "standard", "claude-sonnet", "https://support.claude.com/en/articles/11940350-claude-code-model-configuration"),
] as const;

const OFFICIAL_RUNTIME_PROFILES: Readonly<Record<string, ModelProfile>> = {
  "gpt-5.6-sol": officialProfile("premium", "openai-sol", "https://openai.com/index/gpt-5-6/"),
  "gpt-5.6-terra": officialProfile("standard", "openai-terra", "https://openai.com/index/gpt-5-6/"),
  "gpt-5.6-luna": officialProfile("economy", "openai-luna", "https://openai.com/index/gpt-5-6/"),
  "gpt-5.5": officialProfile("premium", "openai-gpt-5.5", "https://openai.com/index/introducing-gpt-5-5/"),
  "gpt-5.4": officialProfile("standard", "openai-gpt-5.4", "https://developers.openai.com/api/docs/models/compare"),
  "gpt-5.4-mini": officialProfile("economy", "openai-gpt-5.4-mini", "https://openai.com/index/introducing-gpt-5-4-mini-and-nano/"),
  "gpt-5.3-codex-spark": officialProfile("economy", "openai-codex-spark", "https://openai.com/index/introducing-gpt-5-3-codex-spark/"),
  "gemini 3.5 flash (low)": officialProfile("standard", "gemini-flash", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "vision"], "low"),
  "gemini 3.5 flash (medium)": officialProfile("standard", "gemini-flash", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "vision"], "medium"),
  "gemini 3.5 flash (high)": officialProfile("standard", "gemini-flash", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "vision"], "high"),
  "gemini 3.1 pro (low)": officialProfile("premium", "gemini-pro", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "vision"], "low"),
  "gemini 3.1 pro (high)": officialProfile("premium", "gemini-pro", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "vision"], "high"),
  "claude sonnet 4.6 (thinking)": officialProfile("standard", "claude-sonnet", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "vision", "reasoning"]),
  "claude opus 4.6 (thinking)": officialProfile("premium", "claude-opus", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "vision", "reasoning"]),
  "gpt-oss 120b (medium)": officialProfile("standard", "openai-gpt-oss", "https://codelabs.developers.google.com/antigravity-cli-hands-on", ["text", "analysis", "code", "tools", "reasoning"], "medium"),
};

const tierRank: Record<ModelTier, number> = { economy: 1, standard: 2, premium: 3 };

export function classifyWorkload(
  role: AgentRole,
  task?: PlannedTask | null,
  preferredTier: ModelTier | "auto" = "auto",
): WorkloadClassification {
  if (preferredTier !== "auto") {
    return {
      complexity: preferredTier === "premium" ? "complex" : preferredTier === "standard" ? "standard" : "simple",
      requiredTier: preferredTier,
      factors: [`user preferred ${preferredTier} tier`],
    };
  }
  if (role === "architect") {
    return { complexity: "complex", requiredTier: "premium", factors: ["architecture requires cross-task reasoning"] };
  }
  if (role === "reviewer") {
    return { complexity: "complex", requiredTier: "premium", factors: ["independent final review is a release gate"] };
  }
  if (!task) {
    return { complexity: "standard", requiredTier: "standard", factors: ["worker task has no finer contract"] };
  }

  const capabilities = new Set((task.capabilityNeeds ?? []).map((item) => item.toLowerCase()));
  const complexCapabilities = ["architecture", "security", "authentication", "migration", "release", "reasoning"];
  const highSignal = task.risk === "high" || task.kind === "release" || complexCapabilities.some((item) => capabilities.has(item));
  if (highSignal) {
    const factors = [
      ...(task.risk === "high" ? ["high-risk task"] : []),
      ...(task.kind === "release" ? ["release task"] : []),
      ...complexCapabilities.filter((item) => capabilities.has(item)).map((item) => `${item} capability required`),
    ];
    return { complexity: "complex", requiredTier: "premium", factors };
  }

  const simpleKind = task.kind === "diagnostic" || task.kind === "review";
  const simplePermission = task.permission === "read_only";
  const narrowScope = (task.repositoryScope?.length ?? 1) <= 1 && (task.acceptanceCriteria?.length ?? 0) <= 2;
  if (task.risk === "low" && narrowScope && (simpleKind || simplePermission)) {
    return {
      complexity: "simple",
      requiredTier: "economy",
      factors: ["low-risk task", simplePermission ? "read-only task" : `${task.kind} task`, "narrow repository scope"],
    };
  }
  return { complexity: "standard", requiredTier: "standard", factors: ["routine implementation workload"] };
}

export function inferModelProfile(model: Pick<ModelRecord, "canonicalName" | "displayName" | "metadata">, connection?: Pick<ConnectionRecord, "provider" | "transport"> | null): ModelProfile {
  const embedded = model.metadata.devHarmonicsProfile;
  if (embedded && typeof embedded === "object") {
    const value = embedded as Partial<ModelProfile>;
    if (isTier(value.tier)) {
      return {
        tier: value.tier,
        family: typeof value.family === "string" ? value.family : familyFromName(model.displayName),
        capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((item): item is string => typeof item === "string") : ["text"],
        source: value.source === "catalog" || value.source === "runtime" ? value.source : "inferred",
        reasoningEffort: isReasoningEffort(value.reasoningEffort) ? value.reasoningEffort : null,
        ...(isConfidence(value.confidence) ? { confidence: value.confidence } : {}),
        evidenceUrls: Array.isArray(value.evidenceUrls) ? value.evidenceUrls.filter((item): item is string => typeof item === "string") : [],
      };
    }
  }

  const name = `${model.canonicalName} ${model.displayName}`.toLowerCase();
  const exact = OFFICIAL_RUNTIME_PROFILES[model.canonicalName.toLowerCase()] ?? OFFICIAL_RUNTIME_PROFILES[model.displayName.toLowerCase()];
  if (exact) return { ...exact, capabilities: [...exact.capabilities], evidenceUrls: [...(exact.evidenceUrls ?? [])] };

  if (connection?.transport === "local") return inferLocalProfile(model, name);

  let tier: ModelTier = "standard";
  if (/\b(sol|opus|fable)\b|gpt-5\.5\b|gemini\s*3\.1\s*pro/.test(name)) tier = "premium";
  else if (/\b(luna|haiku)\b|gpt-5\.4-mini|codex-spark/.test(name)) tier = "economy";
  else if (/\b(terra|sonnet)\b|gpt-oss\s*120b|gemini\s*3\.5\s*flash/.test(name)) tier = "standard";

  const capabilities = ["text"];
  if (/\b(vl|vision|minicpm-v)\b/.test(name)) capabilities.push("vision");
  if (/embed/.test(name)) capabilities.splice(0, capabilities.length, "embedding");
  else capabilities.push("analysis");
  return { tier, family: familyFromName(name), capabilities, source: "inferred", reasoningEffort: effortFromName(name), confidence: "provisional", evidenceUrls: [] };
}

export function tierFitScore(candidate: ModelTier, required: ModelTier): number | null {
  const difference = tierRank[candidate] - tierRank[required];
  if (difference < 0) return null;
  return 40 - difference * 8;
}

export function effortForTier(tier: ModelTier): "low" | "medium" | "high" {
  if (tier === "premium") return "high";
  if (tier === "standard") return "medium";
  return "low";
}

export function reasoningEffortFitScore(candidate: ModelProfile["reasoningEffort"], required: ModelTier): number {
  if (!candidate) return 0;
  const desired = effortForTier(required);
  if (candidate === desired) return 8;
  const rank = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 } as const;
  return Math.abs(rank[candidate] - rank[desired]) === 1 ? 3 : 0;
}

export function profileMetadata(profile: ModelProfile): Record<string, unknown> {
  return { devHarmonicsProfile: profile };
}

function inferLocalProfile(model: Pick<ModelRecord, "metadata">, name: string): ModelProfile {
  const benchmarkTier = model.metadata.benchmarkTier;
  const tier: ModelTier = isTier(benchmarkTier) ? benchmarkTier : "economy";
  const runtimeCapabilities = Array.isArray(model.metadata.capabilities)
    ? model.metadata.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const capabilities: string[] = [];
  if (runtimeCapabilities.includes("embedding") || /embed/.test(name)) capabilities.push("embedding");
  if (runtimeCapabilities.includes("completion")) capabilities.push("text", "analysis");
  if (runtimeCapabilities.includes("vision") || /\b(vl|vision|minicpm-v)\b/.test(name)) capabilities.push("vision");
  if (runtimeCapabilities.includes("tools")) capabilities.push("tools");
  if (runtimeCapabilities.includes("thinking")) capabilities.push("reasoning");
  if (/qwen2\.5(?!vl)/.test(name)) capabilities.push("code");
  return {
    tier,
    family: familyFromName(name),
    capabilities: [...new Set(capabilities.length ? capabilities : ["text", "analysis"])],
    source: "runtime",
    reasoningEffort: runtimeCapabilities.includes("thinking") ? "medium" : null,
    confidence: isTier(benchmarkTier) ? "empirical" : "provisional",
    evidenceUrls: localEvidenceUrls(name),
  };
}

function familyFromName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("claude") || /\b(opus|sonnet|haiku|fable)\b/.test(normalized)) return "claude";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("gpt-oss")) return "gpt-oss";
  if (/\b(sol|terra|luna)\b/.test(normalized)) return "codex";
  if (normalized.includes("qwen")) return "qwen";
  if (normalized.includes("gemma")) return "gemma";
  return normalized.split(/[:\s/-]/).find(Boolean) ?? "unknown";
}

function isTier(value: unknown): value is ModelTier {
  return value === "economy" || value === "standard" || value === "premium";
}

function effortFromName(name: string): Exclude<ModelProfile["reasoningEffort"], undefined> {
  const match = name.match(/\((low|medium|high)\)/);
  return match ? match[1] as "low" | "medium" | "high" : null;
}

function isReasoningEffort(value: unknown): value is NonNullable<ModelProfile["reasoningEffort"]> {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function isConfidence(value: unknown): value is NonNullable<ModelProfile["confidence"]> {
  return value === "official" || value === "runtime" || value === "provisional" || value === "empirical";
}

function officialProfile(
  tier: ModelTier,
  family: string,
  evidenceUrl: string,
  capabilities = ["text", "analysis", "code", "tools", "vision"],
  reasoningEffort: Exclude<ModelProfile["reasoningEffort"], undefined> = null,
): ModelProfile {
  return { tier, family, capabilities, source: "catalog", reasoningEffort, confidence: "official", evidenceUrls: [evidenceUrl] };
}

function verifiedCatalogModel(
  provider: CompatibilityModel["provider"],
  canonicalName: string,
  displayName: string,
  tier: ModelTier,
  family: string,
  officialSource: string,
  capabilities = ["text", "analysis", "code", "tools", "vision"],
): CompatibilityModel {
  return { provider, canonicalName, displayName, tier, family, capabilities, officialSource };
}

function localEvidenceUrls(name: string): string[] {
  if (name.includes("nomic-embed-text")) return ["https://ollama.com/library/nomic-embed-text"];
  if (name.includes("minicpm-v")) return ["https://ollama.com/library/minicpm-v"];
  if (name.includes("qwen3-vl")) return ["https://ollama.com/library/qwen3-vl"];
  if (name.includes("qwen2.5vl")) return ["https://ollama.com/library/qwen2.5vl"];
  if (name.includes("qwen2.5")) return ["https://ollama.com/library/qwen2.5"];
  return [];
}
