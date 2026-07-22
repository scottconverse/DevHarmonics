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
  reviewPolicy: {
    reviewerCountByRisk: Record<"low" | "medium" | "high", number>;
    minimumDistinctProvidersByRisk: Record<"low" | "medium" | "high", number>;
    requireImplementorIndependenceByRisk: Record<"low" | "medium" | "high", boolean>;
    requiredLensesByRisk: Record<"low" | "medium" | "high", Array<"artifact" | "claims">>;
    maxFixRounds: number;
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
  repositoryIds?: string[];
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

export interface RepositoryImpact {
  repositoryId: string;
  disposition: "affected" | "excluded";
  rationale: string;
}

export interface RunPlan {
  summary: string;
  recommendedConcurrency: number;
  revision?: number;
  previousRevision?: number | null;
  repositoryImpact?: RepositoryImpact[];
  integrationConditions?: string[];
  tasks: PlannedTask[];
}

export interface ProviderRequest {
  role: AgentRole;
  prompt: string;
  cwd: string;
  writeAccess: boolean;
  /** Deny the runtime's file/shell tools entirely — for reviews whose evidence must all arrive in the prompt. */
  withoutRepositoryTools?: boolean;
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
  agents?: number | "auto" | undefined;
  enabledProviders?: ProviderName[] | undefined;
  approvedPlan?: RunPlan | undefined;
  objectiveLink?: RunObjectiveLink | undefined;
}

export type RunAutonomy = "observe" | "supervised" | "bounded";
export type ObjectiveRisk = "low" | "medium" | "high";
export type ObjectivePriority = "low" | "normal" | "high" | "urgent";

export interface ObjectiveInput {
  outcome: string;
  acceptanceCriteria: string[];
  constraints: string[];
  projectPath: string;
  productId?: string | undefined;
  repositoryIds: string[];
  risk: ObjectiveRisk;
  autonomy: RunAutonomy;
  priority: ObjectivePriority;
  deadline?: string | undefined;
  policyNotes: string[];
}

export interface ObjectiveRecord extends ObjectiveInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanRevisionRecord {
  objectiveId: string;
  revision: number;
  plan: RunPlan;
  rationale: string;
  approved: boolean;
  createdAt: string;
  approvedAt: string | null;
}

export interface RunObjectiveLink {
  objectiveId: string;
  approvedPlanRevision: number;
}

export type IntegrationSetStatus = "preparing" | "running" | "ready" | "not_ready" | "failed";
export type IntegrationRepositoryStatus = "pending" | "prepared" | "running" | "ready" | "failed";

export interface IntegrationSetRepositoryRecord {
  repositoryId: string;
  localPath: string;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktreePath: string;
  headCommit: string | null;
  status: IntegrationRepositoryStatus;
  error: string | null;
  updatedAt: string;
}

export interface IntegrationSetRecord {
  id: string;
  runId: string;
  productId: string;
  status: IntegrationSetStatus;
  integrationConditions: string[];
  repositories: IntegrationSetRepositoryRecord[];
  createdAt: string;
  updatedAt: string;
}

export type DeliveryRepositoryStatus = "prepared" | "branch_pushed" | "draft_pr_created" | "failed";

export interface DeliveryRepositoryRecord {
  runId: string;
  repositoryId: string;
  localPath: string;
  baseBranch: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  remoteUrl: string | null;
  status: DeliveryRepositoryStatus;
  pullRequestUrl: string | null;
  approvalId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryHandoffRecord {
  runId: string;
  status: DeliveryRepositoryStatus;
  repositories: DeliveryRepositoryRecord[];
}

export type WorkbenchMessageRole = "user" | "assistant" | "system";
export type WorkbenchMessageStatus = "complete" | "failed";

export interface WorkbenchSessionInput {
  projectPath: string;
  title: string;
}

export interface WorkbenchSessionRecord extends WorkbenchSessionInput {
  id: string;
  mode: "read_only";
  objectiveId: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchMessageInput {
  sessionId: string;
  role: WorkbenchMessageRole;
  content: string;
  provider?: string | null | undefined;
  connectionId?: string | null | undefined;
  requestedModelId?: string | null | undefined;
  resolvedModelId?: string | null | undefined;
  status?: WorkbenchMessageStatus | null | undefined;
  error?: string | null | undefined;
  inputTokens?: number | null | undefined;
  outputTokens?: number | null | undefined;
  costUsd?: number | null | undefined;
  durationMs?: number | null | undefined;
  paidSpendReservationId?: string | null | undefined;
}

export interface WorkbenchMessageRecord {
  id: number;
  sessionId: string;
  role: WorkbenchMessageRole;
  content: string;
  provider: string | null;
  connectionId: string | null;
  requestedModelId: string | null;
  resolvedModelId: string | null;
  status: WorkbenchMessageStatus | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  paidSpendReservationId: string | null;
  createdAt: string;
}

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
  objectiveId: string | null;
  approvedPlanRevision: number | null;
  plan: RunPlan | null;
  integrationSet: IntegrationSetRecord | null;
  delivery: DeliveryHandoffRecord | null;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    kind: NonNullable<PlannedTask["kind"]>;
    repositoryIds: string[];
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

export type SteeringDirectiveKind =
  | "hold_admission"
  | "resume_admission"
  | "reprioritize"
  | "reassign"
  | "clarify"
  | "interrupt";

export type SteeringDisposition = "pending" | "applied" | "rejected" | "superseded";

export interface SteeringPayload {
  clarification?: string | undefined;
  taskOrder?: string[] | undefined;
  provider?: string | undefined;
  modelId?: string | undefined;
  reason?: string | undefined;
}

export interface SteeringDirectiveRecord {
  id: string;
  runId: string;
  kind: SteeringDirectiveKind;
  targetTaskId: string | null;
  actor: string;
  payload: SteeringPayload;
  disposition: SteeringDisposition;
  dispositionReason: string | null;
  appliedAttemptId: number | null;
  createdAt: string;
  updatedAt: string;
}
