export const PROVIDERS = ["codex", "claude", "gemini"] as const;

export type ProviderName = (typeof PROVIDERS)[number];
export type AgentRole = "architect" | "worker" | "reviewer";
export type TaskStatus =
  | "queued"
  | "working"
  | "verifying"
  | "retry"
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled";

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

export interface DevHarmonicsConfig {
  version: 1;
  architect: ProviderName;
  reviewer: ProviderName;
  workers: ProviderName[];
  concurrency: {
    mode: "auto" | "manual";
    agents: number;
    ceiling: number | null;
  };
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };
  providers: Record<ProviderName, ProviderConfig>;
  validators: Record<string, ValidatorConfig>;
}

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  preferredProvider: ProviderName | null;
  checks: string[];
}

export interface RunPlan {
  summary: string;
  recommendedConcurrency: number;
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
  agents?: number | "auto";
  enabledProviders?: ProviderName[];
}

export interface RunSummary {
  id: string;
  goal: string;
  projectPath: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  finalReview: string | null;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    provider: ProviderName | null;
    attemptCount: number;
    checks: CheckResult[];
  }>;
  events: Array<{
    id: number;
    kind: string;
    message: string;
    createdAt: string;
  }>;
}
