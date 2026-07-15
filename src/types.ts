import type { LegacyProviderProjection } from "./compatibility.js";
import type { RunEvent, RunStatus, TaskStatus } from "./domain.js";

export const PROVIDERS = ["codex", "claude", "gemini"] as const;

export type ProviderName = (typeof PROVIDERS)[number];
export type AgentRole = "architect" | "worker" | "reviewer";
export type ModelTier = "economy" | "standard" | "premium";
export type TaskComplexity = "simple" | "standard" | "complex";
export type { RunStatus, TaskStatus } from "./domain.js";

export interface ValidatorConfig {
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string | undefined;
}

export interface ProviderConfig {
  enabled: boolean;
  command: string;
  timeoutMs: number;
}

export interface RoleRoutingConfig {
  modelId: string | null;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  preferredTier: ModelTier | "auto";
  upgradePolicy: "pinned" | "track_family";
}

export interface OllamaRuntimeConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
}

export interface DevHarmonicsConfig {
  version: 2;
  application: {
    concurrency: {
      mode: "auto" | "manual";
      agents: number;
      ceiling: number | null;
    };
    retry: {
      maxAttempts: number;
      backoffMs: number;
    };
  };
  connections: Record<ProviderName, ProviderConfig>;
  localRuntimes: {
    ollama: OllamaRuntimeConfig[];
  };
  openRouter: {
    enabled: boolean;
    allowPaidFallback: boolean;
    perRunLimitUsd: number;
    monthlyLimitUsd: number;
  };
  product: {
    architect: ProviderName;
    reviewer: ProviderName;
    workers: ProviderName[];
  };
  repository: {
    validators: Record<string, ValidatorConfig>;
  };
  runPolicy: {
    autonomy: "observe" | "supervised" | "bounded";
    requirePlanApproval: boolean;
    allowPaidApi: boolean;
    allowExternalWrites: boolean;
  };
  routing: {
    mode: "adaptive" | "manual";
    architect: RoleRoutingConfig;
    worker: RoleRoutingConfig;
    reviewer: RoleRoutingConfig;
    allowFallback: boolean;
  };
}

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  preferredProvider: ProviderName | null;
  checks: string[];
  kind?: "diagnostic" | "implementation" | "repair" | "review" | "release";
  repositoryScope?: string[];
  permission?: "read_only" | "workspace_write";
  risk?: "low" | "medium" | "high";
  capabilityNeeds?: string[];
  acceptanceCriteria?: string[];
  expectedArtifacts?: string[];
}

export interface RunPlan {
  summary: string;
  recommendedConcurrency: number;
  revision?: number;
  previousRevision?: number | null;
  tasks: PlannedTask[];
}

export interface ProviderRequest {
  role: AgentRole;
  prompt: string;
  cwd: string;
  writeAccess: boolean;
  timeoutMs?: number;
}

export interface ProviderResult {
  provider: ProviderName;
  text: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunRequest {
  goal: string;
  projectPath: string;
  autonomy?: RunAutonomy;
  agents?: number | "auto";
  enabledProviders?: ProviderName[];
}

export type RunAutonomy = "observe" | "supervised" | "bounded";

export interface RunSummary {
  id: string;
  goal: string;
  goalSummary: string;
  projectPath: string;
  autonomy: RunAutonomy;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  finalReview: string | null;
  resumedFrom: string | null;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    kind: NonNullable<PlannedTask["kind"]>;
    repositoryScope: string[];
    permission: NonNullable<PlannedTask["permission"]>;
    risk: NonNullable<PlannedTask["risk"]>;
    acceptanceCriteria: string[];
    expectedArtifacts: string[];
    status: TaskStatus;
    provider: string | null;
    assignment: LegacyProviderProjection | null;
    attemptCount: number;
    checks: CheckResult[];
  }>;
  events: RunEvent[];
}
