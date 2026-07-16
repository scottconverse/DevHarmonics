import path from "node:path";
import type { DevHarmonicsConfig, AgentRole } from "./types.js";

export type ToolSideEffect = "none" | "workspace_write" | "external_write" | "destructive" | "spending";
export type ToolPolicyOutcome = "allow" | "deny" | "require_approval";
export type ToolActorRole = AgentRole | "coordinator" | "reporter";
export type ToolStage =
  | "planning"
  | "implementation"
  | "repair"
  | "verification"
  | "integration"
  | "review"
  | "reporting"
  | "release"
  | "workbench";
export type ToolSecretPolicy = "forbid" | "redact" | "credential_reference";

export interface ToolDefinition {
  id: string;
  trust: "built_in" | "configured" | "external";
  sideEffect: ToolSideEffect;
  receiptsRequired: boolean;
  description: string;
  allowedRoles: readonly ToolActorRole[];
  allowedStages: readonly ToolStage[];
  secretPolicy: ToolSecretPolicy;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
  lockScope: "none" | "worktree" | "repository" | "external_github";
}

export interface ToolApprovalReceipt {
  id: string;
  kind: "plan" | "external_write" | "spending" | "destructive";
  approvedBy: string;
  approvedAt: string;
}

export interface ToolExecutionRequest {
  toolId: string;
  actorRole: ToolActorRole;
  stage: ToolStage;
  taskPermission: "read_only" | "workspace_write";
  assignedWorktree: string | null;
  repositoryRoot?: string | null;
  cwd: string;
  targetPaths?: readonly string[];
  planApproved: boolean;
  approval?: ToolApprovalReceipt | null;
}

export interface ToolPolicyDecision {
  tool: ToolDefinition;
  outcome: ToolPolicyOutcome;
  reason: string;
  receiptRequired: boolean;
  lockKeys: string[];
  approvalId: string | null;
}

const readRoles: readonly ToolActorRole[] = ["architect", "worker", "reviewer", "coordinator", "reporter"];
const readStages: readonly ToolStage[] = ["planning", "implementation", "repair", "verification", "integration", "review", "reporting", "workbench"];
const emptyOutputSchema = { type: "object" } as const;

const builtInTools: Readonly<Record<string, ToolDefinition>> = {
  "file.read": {
    id: "file.read", trust: "built_in", sideEffect: "none", receiptsRequired: true,
    description: "Read a path-scoped file", allowedRoles: readRoles, allowedStages: readStages,
    secretPolicy: "redact", inputSchema: { type: "object", required: ["path"] }, outputSchema: { type: "object", required: ["content"] }, lockScope: "none",
  },
  "file.search": {
    id: "file.search", trust: "built_in", sideEffect: "none", receiptsRequired: true,
    description: "Search inside the assigned worktree", allowedRoles: readRoles, allowedStages: readStages,
    secretPolicy: "redact", inputSchema: { type: "object", required: ["query", "targetPaths"] }, outputSchema: { type: "object", required: ["matches"] }, lockScope: "none",
  },
  "file.patch": {
    id: "file.patch", trust: "built_in", sideEffect: "workspace_write", receiptsRequired: true,
    description: "Apply a path-scoped patch", allowedRoles: ["worker", "coordinator"], allowedStages: ["implementation", "repair"],
    secretPolicy: "forbid", inputSchema: { type: "object", required: ["patch", "targetPaths"] }, outputSchema: emptyOutputSchema, lockScope: "worktree",
  },
  "git.status": {
    id: "git.status", trust: "built_in", sideEffect: "none", receiptsRequired: true,
    description: "Inspect assigned-worktree status", allowedRoles: readRoles, allowedStages: readStages,
    secretPolicy: "forbid", inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["stdout", "exitCode"] }, lockScope: "none",
  },
  "git.diff": {
    id: "git.diff", trust: "built_in", sideEffect: "none", receiptsRequired: true,
    description: "Inspect assigned-worktree changes", allowedRoles: readRoles, allowedStages: readStages,
    secretPolicy: "redact", inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["stdout", "exitCode"] }, lockScope: "none",
  },
  "git.commit": {
    id: "git.commit", trust: "built_in", sideEffect: "workspace_write", receiptsRequired: true,
    description: "Commit an isolated task worktree", allowedRoles: ["worker", "coordinator"], allowedStages: ["implementation", "repair"],
    secretPolicy: "forbid", inputSchema: { type: "object", required: ["message"] }, outputSchema: { type: "object", required: ["commit"] }, lockScope: "worktree",
  },
  "git.merge": {
    id: "git.merge", trust: "built_in", sideEffect: "workspace_write", receiptsRequired: true,
    description: "Merge a verified task branch into the integration worktree", allowedRoles: ["coordinator"], allowedStages: ["integration"],
    secretPolicy: "forbid", inputSchema: { type: "object", required: ["branch"] }, outputSchema: { type: "object", required: ["commit"] }, lockScope: "repository",
  },
  "github.pull_request": {
    id: "github.pull_request", trust: "external", sideEffect: "external_write", receiptsRequired: true,
    description: "Create or update a GitHub pull request", allowedRoles: ["coordinator"], allowedStages: ["release"],
    secretPolicy: "credential_reference", inputSchema: { type: "object", required: ["repository", "head", "base"] }, outputSchema: { type: "object", required: ["url"] }, lockScope: "external_github",
  },
  "shell.unrestricted": {
    id: "shell.unrestricted", trust: "external", sideEffect: "destructive", receiptsRequired: true,
    description: "Run an unrestricted shell", allowedRoles: [], allowedStages: [],
    secretPolicy: "forbid", inputSchema: { type: "object" }, outputSchema: emptyOutputSchema, lockScope: "none",
  },
};

function validatorDefinition(toolId: string): ToolDefinition {
  return {
    id: toolId, trust: "configured", sideEffect: "none", receiptsRequired: true,
    description: "Run an allowlisted repository validator", allowedRoles: ["worker", "reviewer", "coordinator"],
    allowedStages: ["implementation", "repair", "verification", "integration", "review"], secretPolicy: "redact",
    inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["stdout", "stderr", "exitCode", "durationMs"] },
    lockScope: "repository",
  };
}

function unknownDefinition(toolId: string): ToolDefinition {
  return {
    id: toolId, trust: "external", sideEffect: "destructive", receiptsRequired: true, description: "Unregistered tool",
    allowedRoles: [], allowedStages: [], secretPolicy: "forbid", inputSchema: { type: "object" }, outputSchema: emptyOutputSchema, lockScope: "none",
  };
}

export function listToolDefinitions(): ToolDefinition[] {
  return Object.values(builtInTools).map((tool) => ({
    ...tool,
    allowedRoles: [...tool.allowedRoles],
    allowedStages: [...tool.allowedStages],
    inputSchema: { ...tool.inputSchema },
    outputSchema: { ...tool.outputSchema },
  }));
}

export function toolDefinition(toolId: string): ToolDefinition {
  if (toolId.startsWith("validator:")) return validatorDefinition(toolId);
  return builtInTools[toolId] ?? unknownDefinition(toolId);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function scopeFailure(request: ToolExecutionRequest, tool: ToolDefinition): string | null {
  if (!request.assignedWorktree) {
    return tool.sideEffect === "workspace_write" || request.targetPaths?.length
      ? "Workspace tools require an assigned worktree"
      : null;
  }
  const root = path.resolve(request.assignedWorktree);
  if (!inside(root, path.resolve(request.cwd))) return "Tool working directory is outside the assigned worktree";
  for (const target of request.targetPaths ?? []) {
    const resolved = path.resolve(root, target);
    if (!inside(root, resolved)) return `Target '${target}' is outside the assigned worktree`;
  }
  return null;
}

function lockKeys(request: ToolExecutionRequest, tool: ToolDefinition): string[] {
  const worktree = request.assignedWorktree ? path.resolve(request.assignedWorktree) : null;
  if (tool.lockScope === "worktree" && worktree) return [`worktree:${worktree}`];
  if (tool.lockScope === "repository") {
    const repository = request.repositoryRoot ? path.resolve(request.repositoryRoot) : worktree;
    return repository ? [`repository:${repository}${tool.id.startsWith("validator:") ? `:${tool.id}` : ""}`] : [];
  }
  if (tool.lockScope === "external_github") return ["external:github"];
  return [];
}

function decision(tool: ToolDefinition, outcome: ToolPolicyOutcome, reason: string, request?: ToolExecutionRequest): ToolPolicyDecision {
  return {
    tool,
    outcome,
    reason,
    receiptRequired: tool.receiptsRequired,
    lockKeys: request ? lockKeys(request, tool) : [],
    approvalId: request?.approval?.id ?? null,
  };
}

export function evaluateToolRequest(request: ToolExecutionRequest, config: DevHarmonicsConfig): ToolPolicyDecision {
  const tool = toolDefinition(request.toolId);
  if (tool.trust === "external" && tool.sideEffect === "destructive") {
    return decision(tool, "deny", "Unrestricted or unregistered destructive tools are not available to agents", request);
  }
  if (!tool.allowedRoles.includes(request.actorRole)) {
    return decision(tool, "deny", `${tool.id} is not available to the ${request.actorRole} role`, request);
  }
  if (!tool.allowedStages.includes(request.stage)) {
    return decision(tool, "deny", `${tool.id} is not available during ${request.stage}`, request);
  }
  const scopeError = scopeFailure(request, tool);
  if (scopeError) return decision(tool, "deny", scopeError, request);
  if (tool.sideEffect === "workspace_write") {
    if (request.taskPermission !== "workspace_write" || config.runPolicy.autonomy === "observe") {
      return decision(tool, "deny", "Read-only or Observe work cannot modify a worktree", request);
    }
    if (config.runPolicy.requirePlanApproval && !request.planApproved) {
      return decision(tool, "require_approval", "Workspace writes require an approved plan", request);
    }
  }
  if (tool.sideEffect === "spending") {
    if (!config.runPolicy.allowPaidApi) return decision(tool, "deny", "Paid API access is disabled by run policy", request);
    if (request.approval?.kind !== "spending") return decision(tool, "require_approval", "Paid API use requires an explicit approval receipt", request);
  }
  if (tool.sideEffect === "external_write") {
    if (!config.runPolicy.allowExternalWrites) return decision(tool, "deny", "External writes are disabled by run policy", request);
    if (request.approval?.kind !== "external_write") return decision(tool, "require_approval", "External writes require human approval", request);
  }
  return decision(tool, "allow", tool.receiptsRequired ? "Allowed with a retained execution receipt" : "Allowed", request);
}

export function evaluateToolPolicy(toolId: string, config: DevHarmonicsConfig): ToolPolicyDecision {
  const tool = toolDefinition(toolId);
  if (tool.id === "shell.unrestricted" || (tool.trust === "external" && tool.sideEffect === "destructive")) {
    return decision(tool, "deny", "Unrestricted or unregistered destructive tools are not available to agents");
  }
  if (tool.sideEffect === "spending") {
    return config.runPolicy.allowPaidApi
      ? decision(tool, "require_approval", "Paid API use requires an explicit approval receipt")
      : decision(tool, "deny", "Paid API access is disabled by run policy");
  }
  if (tool.sideEffect === "external_write") {
    return config.runPolicy.allowExternalWrites
      ? decision(tool, "require_approval", "External writes require human approval")
      : decision(tool, "deny", "External writes are disabled by run policy");
  }
  if (tool.sideEffect === "workspace_write" && config.runPolicy.autonomy === "observe") {
    return decision(tool, "deny", "Observe-only runs cannot modify a worktree");
  }
  return decision(tool, "allow", tool.receiptsRequired ? "Allowed with a retained execution receipt" : "Allowed");
}

export function requireAllowedTool(toolId: string, config: DevHarmonicsConfig): ToolPolicyDecision {
  const result = evaluateToolPolicy(toolId, config);
  if (result.outcome !== "allow") throw new Error(`${toolId} ${result.outcome.replace("_", " ")}: ${result.reason}`);
  return result;
}
