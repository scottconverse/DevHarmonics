const domainIdBrand: unique symbol = Symbol("DevHarmonicsDomainId");

export type DomainId<Entity extends string> = string & {
  readonly [domainIdBrand]: Entity;
};

export type ProductId = DomainId<"Product">;
export type WorkspaceId = DomainId<"Workspace">;
export type RepositoryId = DomainId<"Repository">;
export type RunId = DomainId<"Run">;
export type TaskId = DomainId<"Task">;
export type AttemptId = DomainId<"Attempt">;
export type ProviderConnectionId = DomainId<"ProviderConnection">;
export type ModelId = DomainId<"Model">;
export type AgentInstanceId = DomainId<"AgentInstance">;

export type IsoTimestamp = string & { readonly __isoTimestamp: true };
export type Revision = number & { readonly __revision: true };

export function domainId<Entity extends string>(entity: Entity, value: string): DomainId<Entity> {
  if (!value.trim()) throw new Error(`${entity} identifier cannot be empty`);
  return value as DomainId<Entity>;
}

export function isoTimestamp(value: string): IsoTimestamp {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ISO timestamp: ${value}`);
  return value as IsoTimestamp;
}

export function revision(value: number): Revision {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Revision must be a positive integer; received ${value}`);
  }
  return value as Revision;
}

export const RUN_STATUSES = [
  "planning",
  "running",
  "awaiting_approval",
  "paused",
  "ready",
  "not_ready",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_STATUSES = [
  "queued",
  "working",
  "verifying",
  "retry",
  "paused",
  "passed",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  planning: ["running", "paused", "failed", "cancelled"],
  running: ["awaiting_approval", "paused", "ready", "not_ready", "failed", "cancelled"],
  awaiting_approval: ["running", "paused", "failed", "cancelled"],
  paused: ["cancelled"],
  ready: [],
  not_ready: [],
  failed: [],
  cancelled: [],
};

const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["working", "verifying", "paused", "blocked", "failed", "cancelled"],
  working: ["verifying", "retry", "paused", "failed", "cancelled"],
  verifying: ["passed", "retry", "paused", "failed", "cancelled"],
  retry: ["working", "paused", "failed", "cancelled"],
  paused: ["cancelled"],
  passed: [],
  failed: [],
  blocked: [],
  cancelled: [],
};

export function parseRunStatus(value: string): RunStatus {
  if (!(RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unknown run status '${value}'`);
  }
  return value as RunStatus;
}

export function parseTaskStatus(value: string): TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unknown task status '${value}'`);
  }
  return value as TaskStatus;
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (from === to) return;
  if (!runTransitions[from].includes(to)) {
    throw new Error(`Invalid run status transition: ${from} -> ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!taskTransitions[from].includes(to)) {
    throw new Error(`Invalid task status transition: ${from} -> ${to}`);
  }
}

export type PolicyDecisionOutcome = "allow" | "deny" | "require_approval";

export interface PolicyDecisionRecord {
  id: DomainId<"PolicyDecision">;
  policy: string;
  outcome: PolicyDecisionOutcome;
  reason: string;
  decidedAt: IsoTimestamp;
  revision: Revision;
}

export const RUN_EVENT_KINDS = [
  "run.created",
  "plan.created",
  "plan.awaiting_approval",
  "plan.approved",
  "integration.queued",
  "run.cancelled",
  "run.paused",
  "run.resumed",
  "worktree.created",
  "architect.started",
  "architect.failed",
  "model.qualification_passed",
  "model.qualification_failed",
  "scheduler.started",
  "task.blocked",
  "task.started",
  "task.provider_failed",
  "task.integration_conflict",
  "task.passed",
  "check.passed",
  "check.failed",
  "integration.passed",
  "integration.failed",
  "review.started",
  "review.failed",
  "review.chunk_completed",
  "review.completed",
  "review.quorum_passed",
  "review.quorum_failed",
  "review.divergence",
  "review.invalidated",
  "fixer.started",
  "fixer.completed",
  "fixer.failed",
  "run.ready",
  "run.not_ready",
  "task.retry",
  "task.failed",
  "tool.allowed",
  "tool.denied",
  "tool.approval_required",
  "delivery.prepared",
  "delivery.branch_pushed",
  "delivery.draft_pr_created",
  "delivery.failed",
  "steering.requested",
  "steering.applied",
  "steering.rejected",
  "steering.superseded",
  "steering.interrupted",
  "run.failed",
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];
export type RunEventData = Readonly<Record<string, unknown>>;

export interface RunEvent {
  id: number;
  cursor: number;
  runId: string;
  kind: RunEventKind;
  message: string;
  data: RunEventData;
  createdAt: string;
}

export function parseRunEventKind(value: string): RunEventKind {
  if (!(RUN_EVENT_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Unknown run event kind '${value}'`);
  }
  return value as RunEventKind;
}
