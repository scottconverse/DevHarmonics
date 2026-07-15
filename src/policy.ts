import type { DevHarmonicsConfig } from "./types.js";

export type ToolSideEffect = "none" | "workspace_write" | "external_write" | "destructive" | "spending";
export type ToolPolicyOutcome = "allow" | "deny" | "require_approval";

export interface ToolDefinition {
  id: string;
  trust: "built_in" | "configured" | "external";
  sideEffect: ToolSideEffect;
  receiptsRequired: boolean;
  description: string;
}

export interface ToolPolicyDecision {
  tool: ToolDefinition;
  outcome: ToolPolicyOutcome;
  reason: string;
}

const builtInTools: Record<string, ToolDefinition> = {
  "git.commit": { id: "git.commit", trust: "built_in", sideEffect: "workspace_write", receiptsRequired: true, description: "Commit an isolated task worktree" },
  "git.merge": { id: "git.merge", trust: "built_in", sideEffect: "workspace_write", receiptsRequired: true, description: "Merge a verified task branch into the integration worktree" },
  "file.patch": { id: "file.patch", trust: "built_in", sideEffect: "workspace_write", receiptsRequired: true, description: "Apply a path-scoped patch" },
  "github.pull_request": { id: "github.pull_request", trust: "external", sideEffect: "external_write", receiptsRequired: true, description: "Create or update a GitHub pull request" },
  "shell.unrestricted": { id: "shell.unrestricted", trust: "external", sideEffect: "destructive", receiptsRequired: true, description: "Run an unrestricted shell" },
};

export function toolDefinition(toolId: string): ToolDefinition {
  if (toolId.startsWith("validator:")) return { id: toolId, trust: "configured", sideEffect: "none", receiptsRequired: true, description: "Run an allowlisted repository validator" };
  return builtInTools[toolId] ?? { id: toolId, trust: "external", sideEffect: "destructive", receiptsRequired: true, description: "Unregistered tool" };
}

export function evaluateToolPolicy(toolId: string, config: DevHarmonicsConfig): ToolPolicyDecision {
  const tool = toolDefinition(toolId);
  if (tool.id === "shell.unrestricted" || (tool.trust === "external" && tool.sideEffect === "destructive")) {
    return { tool, outcome: "deny", reason: "Unrestricted or unregistered destructive tools are not available to agents" };
  }
  if (tool.sideEffect === "spending") {
    return config.runPolicy.allowPaidApi
      ? { tool, outcome: "require_approval", reason: "Paid API use requires an explicit approval receipt" }
      : { tool, outcome: "deny", reason: "Paid API access is disabled by run policy" };
  }
  if (tool.sideEffect === "external_write") {
    return config.runPolicy.allowExternalWrites
      ? { tool, outcome: "require_approval", reason: "External writes require human approval" }
      : { tool, outcome: "deny", reason: "External writes are disabled by run policy" };
  }
  if (tool.sideEffect === "workspace_write" && config.runPolicy.autonomy === "observe") {
    return { tool, outcome: "deny", reason: "Observe-only runs cannot modify a worktree" };
  }
  return { tool, outcome: "allow", reason: tool.receiptsRequired ? "Allowed with a retained execution receipt" : "Allowed" };
}

export function requireAllowedTool(toolId: string, config: DevHarmonicsConfig): ToolPolicyDecision {
  const decision = evaluateToolPolicy(toolId, config);
  if (decision.outcome !== "allow") throw new Error(`${toolId} ${decision.outcome.replace("_", " ")}: ${decision.reason}`);
  return decision;
}
