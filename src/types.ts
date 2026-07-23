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
    /**
     * Owner attestation that no admin-managed Claude Code policy (file,
     * registry, MDM, or server-delivered) governs this machine. Required for
     * a Claude CLI reviewer to take a claims-lens slot: managed policy can
     * configure hooks that survive every headless shutdown flag, and the
     * server/MDM tiers are not client-enumerable. Defaults to false.
     */
    attestNoManagedClaudePolicy: boolean;
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
  /**
   * DH-647 S2. Set by the architect when this task introduces a new
   * dependency, selects a runtime/transport, or picks between architectures —
   * a short subject phrase, the same vocabulary as a DecisionRecord/PlanDecision
   * subject. Matched against RunPlan.decisions[] by subject token overlap at
   * preview time to decide whether the choice is shown as compared or
   * flagged as proposed without recorded alternatives. Null when the task is
   * not a consequential choice.
   */
  consequentialChoice?: string | null;
}

export interface RepositoryImpact {
  repositoryId: string;
  disposition: "affected" | "excluded";
  rationale: string;
}

/**
 * DH-647 S2. A consequential choice the architect is making AS PART OF THIS
 * PLAN — same shape and validation rules as S1's DecisionRecordInput.options
 * (exactly one selected option, a reason on every rejected option), but not
 * yet a durable DecisionRecord: it becomes one only on plan approval, via
 * createDecisionRecord (source 'architect'). A plan preview that is never
 * approved persists nothing.
 */
export interface PlanDecision {
  subject: string;
  question: string;
  optionsConsidered: DecisionOption[];
  decidingConstraint: string;
  acceptedCost: string;
}

export interface RunPlan {
  summary: string;
  recommendedConcurrency: number;
  revision?: number;
  previousRevision?: number | null;
  repositoryImpact?: RepositoryImpact[];
  integrationConditions?: string[];
  tasks: PlannedTask[];
  /** DH-647 S2. Optional: consequential choices weighed while building this plan. */
  decisions?: PlanDecision[];
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
  /** DH-810 structural provenance: pinned into the run BEFORE execution starts; never client-supplied. */
  workflowRevisionHash?: string | undefined;
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
  /**
   * Structural provenance: set ONLY by workflow instantiation. The run started
   * from this objective derives its pinned revision from HERE — never from a
   * client-supplied value, which would make the audit trail fabricable.
   * Hand-editing the objective clears it: an edited objective is no longer the
   * workflow's objective.
   */
  workflowRevisionHash?: string | undefined;
}

export interface ObjectiveRecord extends Omit<ObjectiveInput, "workflowRevisionHash"> {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Always present on a stored record: the exact workflow revision this
   * objective came from, or null when it was hand-authored or hand-edited.
   * String-or-null (never omitted) — the same public shape as
   * RunSummary.workflowRevisionHash (audit DH810-AUD-008).
   */
  workflowRevisionHash: string | null;
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

export type DeliveryRepositoryStatus = "prepared" | "branch_pushed" | "draft_pr_created" | "merged" | "tagged" | "failed";

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
  /** The release tag actually pushed for this repository, once tagged. */
  releaseTag: string | null;
  /**
   * The immutable merge commit OID recorded when merge_pr completes — the exact
   * commit the tag gate judges. The cockpit's post-merge tag prefill resolves
   * the declared version from this OID, not the reviewed head, so it can never
   * propose a version the gate will reject. Null before a merge commit exists.
   */
  mergeCommitOid: string | null;
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
  /** The exact workflow revision this run executed (DH-810); null for runs not started from a workflow. */
  workflowRevisionHash: string | null;
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

/**
 * DH-647. A decision an owner or architect made deliberately, kept so a
 * rejected approach is never re-proposed from scratch as if it were fresh
 * analysis. Append-only: nothing here is ever edited after creation — a
 * changed mind is a NEW record that supersedes this one, never a mutation of
 * it, so the original reasoning stays readable verbatim.
 */
export type DecisionOptionDisposition = "selected" | "rejected";

export interface DecisionOption {
  /** Short label for the option considered, e.g. "Podman" or "Docker Desktop". */
  option: string;
  disposition: DecisionOptionDisposition;
  /** Required when disposition is 'rejected'; optional for the selected option. */
  reason: string | null;
}

export type DecisionScope = "run" | "product" | "machine";
export type DecisionSource = "owner" | "architect";

export interface DecisionRecordInput {
  /** Short noun phrase — the retrieval key readers search by. */
  subject: string;
  question: string;
  options: DecisionOption[];
  decidingConstraint: string;
  evidence: string;
  /** What the choice gave up, not only what it chose. */
  acceptedCost: string;
  scope: DecisionScope;
  productId?: string | null;
  /** The run that originated the decision, if any. */
  runId?: string | null;
  source: DecisionSource;
  /** The id of the decision record this one replaces, if any. */
  supersedes?: string | null;
  /** Required iff supersedes is set. */
  whatChanged?: string | null;
}

export interface DecisionRecord {
  id: string;
  subject: string;
  question: string;
  options: DecisionOption[];
  decidingConstraint: string;
  evidence: string;
  acceptedCost: string;
  scope: DecisionScope;
  productId: string | null;
  runId: string | null;
  source: DecisionSource;
  supersedes: string | null;
  /** The id of the record that superseded this one, if any — derived, not stored. */
  supersededBy: string | null;
  whatChanged: string | null;
  createdAt: string;
}
