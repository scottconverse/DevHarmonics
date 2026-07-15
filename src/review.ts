import type { DevHarmonicsConfig, PlannedTask } from "./types.js";

export type ReviewRisk = "low" | "medium" | "high";
export type ReviewFindingSeverity = "low" | "medium" | "high" | "critical";
export type ReviewFindingDisposition = "open" | "accepted" | "rejected" | "fixed";

export interface ReviewRequirement {
  risk: ReviewRisk;
  requiredReviewers: number;
  minimumDistinctProviders: number;
  requireImplementorIndependence: boolean;
}

export interface ReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  location: string | null;
  rationale: string;
  suggestedCorrection: string;
  disposition: ReviewFindingDisposition;
}

export interface StructuredReview {
  verdict: "READY" | "NOT_READY";
  provider: string;
  modelId: string | null;
  connectionId: string;
  summary: string;
  findings: ReviewFinding[];
  rawText: string;
}

export interface ReviewQuorumDecision {
  passed: boolean;
  requiredReviewers: number;
  completedReviews: number;
  distinctProviders: number;
  independentReviews: number;
  openFindings: ReviewFinding[];
  reasons: string[];
}

const riskRank: Record<ReviewRisk, number> = { low: 0, medium: 1, high: 2 };

export function reviewRequirement(
  tasks: readonly Pick<PlannedTask, "risk">[],
  policy: DevHarmonicsConfig["reviewPolicy"],
): ReviewRequirement {
  const risk = tasks.reduce<ReviewRisk>((highest, task) => {
    const candidate = task.risk ?? "medium";
    return riskRank[candidate] > riskRank[highest] ? candidate : highest;
  }, "low");
  return {
    risk,
    requiredReviewers: policy.reviewerCountByRisk[risk],
    minimumDistinctProviders: policy.minimumDistinctProvidersByRisk[risk],
    requireImplementorIndependence: policy.requireImplementorIndependenceByRisk[risk],
  };
}

function firstVerdict(text: string): "READY" | "NOT_READY" {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trim().toUpperCase();
  return firstLine === "READY" ? "READY" : "NOT_READY";
}

function parseFindings(text: string): unknown[] {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return [];
  try {
    const value = JSON.parse(candidate) as { findings?: unknown };
    return Array.isArray(value.findings) ? value.findings : [];
  } catch {
    return [];
  }
}

function normalizeFinding(value: unknown, index: number): ReviewFinding | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
  if (!rationale) return null;
  const severity = ["low", "medium", "high", "critical"].includes(String(item.severity))
    ? String(item.severity) as ReviewFindingSeverity
    : "high";
  const disposition = ["open", "accepted", "rejected", "fixed"].includes(String(item.disposition))
    ? String(item.disposition) as ReviewFindingDisposition
    : "open";
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `finding-${index + 1}`,
    severity,
    location: typeof item.location === "string" && item.location.trim() ? item.location.trim() : null,
    rationale,
    suggestedCorrection: typeof item.suggestedCorrection === "string" && item.suggestedCorrection.trim()
      ? item.suggestedCorrection.trim()
      : "Investigate and correct the reported condition before re-review.",
    disposition,
  };
}

export function parseReviewerResponse(
  text: string,
  identity: { provider: string; modelId?: string | null; connectionId: string },
): StructuredReview {
  const verdict = firstVerdict(text);
  const normalized = parseFindings(text)
    .map(normalizeFinding)
    .filter((finding): finding is ReviewFinding => Boolean(finding));
  const body = text.trim().split(/\r?\n/).slice(1).join("\n").replace(/```json[\s\S]*?```/gi, "").trim();
  const findings = verdict === "NOT_READY" && normalized.length === 0
    ? [{
        id: "finding-1",
        severity: "high" as const,
        location: null,
        rationale: body || "Reviewer returned NOT READY without a structured rationale.",
        suggestedCorrection: "Inspect the retained review and correct the blocking issue before re-review.",
        disposition: "open" as const,
      }]
    : normalized;
  return {
    verdict,
    provider: identity.provider,
    modelId: identity.modelId ?? null,
    connectionId: identity.connectionId,
    summary: body || (verdict === "READY" ? "No material findings." : findings[0]!.rationale),
    findings,
    rawText: text,
  };
}

export function adjudicateReviewQuorum(input: {
  requirement: ReviewRequirement;
  implementationProviders: readonly string[];
  reviews: readonly StructuredReview[];
}): ReviewQuorumDecision {
  const providers = new Set(input.reviews.map((review) => review.provider));
  const implementors = new Set(input.implementationProviders);
  const independentReviews = input.reviews.filter((review) => !implementors.has(review.provider)).length;
  const openFindings = input.reviews.flatMap((review) => review.findings).filter((finding) => finding.disposition === "open");
  const reasons: string[] = [];
  if (input.reviews.length < input.requirement.requiredReviewers) {
    reasons.push(`Requires ${input.requirement.requiredReviewers} completed reviews; received ${input.reviews.length}.`);
  }
  if (providers.size < input.requirement.minimumDistinctProviders) {
    reasons.push(`Requires ${input.requirement.minimumDistinctProviders} distinct reviewer providers; received ${providers.size}.`);
  }
  if (input.requirement.requireImplementorIndependence && independentReviews < input.requirement.requiredReviewers) {
    reasons.push(`Requires ${input.requirement.requiredReviewers} reviews independent from implementation providers; received ${independentReviews}.`);
  }
  if (input.reviews.some((review) => review.verdict !== "READY")) reasons.push("One or more reviewers returned NOT READY.");
  if (openFindings.length) reasons.push(`${openFindings.length} open reviewer finding${openFindings.length === 1 ? " remains" : "s remain"}.`);
  return {
    passed: reasons.length === 0,
    requiredReviewers: input.requirement.requiredReviewers,
    completedReviews: input.reviews.length,
    distinctProviders: providers.size,
    independentReviews,
    openFindings,
    reasons,
  };
}
