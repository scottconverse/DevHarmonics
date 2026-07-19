import { extractCitations } from "./citations.js";
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
  // A read-only diagnostic's citations ARE its evidence: it changes nothing, so
  // validators have no repository state to judge and the report stands alone. A
  // report grounded in nothing is not a diagnostic, however fluent — so every
  // diagnostic requires at least one citation, whether or not its acceptance
  // criteria remembered to ask. Criteria phrasing still forces the requirement
  // onto other read-only kinds that ask for line evidence explicitly.
  const requiresLineEvidence = task.kind === "diagnostic"
    || [...(task.acceptanceCriteria ?? []), ...(task.expectedArtifacts ?? [])]
      .some((value) => /line number|path:line|line citation/i.test(value));
  // Deliberately the same extractor the citation verifier resolves against: an
  // evidence form this gate accepts but that verifier cannot parse is a hole,
  // and two separate patterns had already opened one.
  if (requiresLineEvidence && extractCitations(text).length === 0) {
    return "the diagnostic report does not contain the required repository path:line evidence";
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
