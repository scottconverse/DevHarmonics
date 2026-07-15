import type { AgentRole, PlannedTask } from "./types.js";

export interface AgentResultEnvelope {
  version: 1;
  role: AgentRole;
  summary: string;
  artifacts: string[];
  assumptions: string[];
  risks: string[];
  nextAction: string | null;
  completionClaim: boolean;
  malformedSource: boolean;
}

export function normalizeAgentResult(role: AgentRole, text: string): AgentResultEnvelope {
  try {
    const value = JSON.parse(text) as Partial<AgentResultEnvelope>;
    if (typeof value.summary === "string" && value.summary.trim()) {
      return {
        version: 1,
        role,
        summary: value.summary.trim(),
        artifacts: stringArray(value.artifacts),
        assumptions: stringArray(value.assumptions),
        risks: stringArray(value.risks),
        nextAction: typeof value.nextAction === "string" ? value.nextAction : null,
        completionClaim: value.completionClaim === true,
        malformedSource: false,
      };
    }
  } catch {
    // Free-form provider output is retained as a conservative normalized
    // envelope and is visibly marked malformed for empirical scoring.
  }
  return {
    version: 1,
    role,
    summary: text.trim().slice(0, 4_000) || "Provider returned no summary",
    artifacts: [],
    assumptions: [],
    risks: [],
    nextAction: null,
    completionClaim: false,
    malformedSource: true,
  };
}

export function validateDiagnosticResult(task: PlannedTask, text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/\b(?:please\s+approve|awaiting\s+(?:plan\s+)?approval|approval\s+(?:is\s+)?required|approve\s+(?:the\s+)?execution|before\s+(?:i|we)\s+(?:can\s+)?(?:begin|execute))\b/i.test(normalized)) {
    return "the worker asked for approval instead of executing the already-approved diagnostic";
  }
  if (normalized.length < 80) return "the diagnostic report is too short to substantiate its conclusions";
  const requiresLineEvidence = [...(task.acceptanceCriteria ?? []), ...(task.expectedArtifacts ?? [])]
    .some((value) => /line number|path:line|line citation/i.test(value));
  const pathLineCitation = /[A-Za-z0-9_.-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?\b/;
  const linkedFileWithNearbyLine = /(?:\[[^\]]*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+\]\([^)]+\)|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)[\s\S]{0,300}\bline(?:s)?\s+\d+(?:\s*[-\u2013]\s*\d+)?\b/i;
  if (requiresLineEvidence && !pathLineCitation.test(text) && !linkedFileWithNearbyLine.test(text)) {
    return "the diagnostic report does not contain the required repository path:line evidence";
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
