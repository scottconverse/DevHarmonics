import type { DevHarmonicsConfig, PlannedTask } from "./types.js";

export type ReviewRisk = "low" | "medium" | "high";
export type ReviewFindingSeverity = "low" | "medium" | "high" | "critical";
export type ReviewFindingDisposition = "open" | "accepted" | "rejected" | "fixed";
export type ReviewLens = "artifact" | "claims";

export interface ReviewRequirement {
  risk: ReviewRisk;
  requiredReviewers: number;
  minimumDistinctProviders: number;
  requireImplementorIndependence: boolean;
  requiredLenses: ReviewLens[];
}

export interface ReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  location: string | null;
  rationale: string;
  suggestedCorrection: string;
  disposition: ReviewFindingDisposition;
}

export interface ClaimedChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  taskId: string | null;
}

export interface StructuredReview {
  verdict: "READY" | "NOT_READY";
  provider: string;
  modelId: string | null;
  connectionId: string;
  lens: ReviewLens | null;
  summary: string;
  findings: ReviewFinding[];
  /** The claims lens's extracted manifest; null when no manifest was returned at all. */
  claimedChanges: ClaimedChange[] | null;
  rawText: string;
}

export interface ReviewQuorumDecision {
  passed: boolean;
  requiredReviewers: number;
  completedReviews: number;
  distinctProviders: number;
  independentReviews: number;
  lensesCovered: ReviewLens[];
  singleLens: boolean;
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
    requiredLenses: [...new Set(policy.requiredLensesByRisk[risk])],
  };
}

/** Deterministic lens assignment: quorum slot i cycles through the required lenses. */
export function lensForSlot(requiredLenses: readonly ReviewLens[], slot: number): ReviewLens | null {
  if (requiredLenses.length === 0) return null;
  return requiredLenses[(slot - 1) % requiredLenses.length]!;
}

/**
 * An observe run produces reports and no repository change, so there is no
 * artifact for an artifact lens to review — its reports ARE the claims.
 */
export function applicableReviewLenses(requirement: Pick<ReviewRequirement, "requiredLenses">, autonomy: string): ReviewLens[] {
  if (autonomy === "observe") return requirement.requiredLenses.length ? ["claims"] : [];
  return [...requirement.requiredLenses];
}

function firstVerdict(text: string): "READY" | "NOT_READY" {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trim().toUpperCase();
  return firstLine === "READY" ? "READY" : "NOT_READY";
}

function parseReviewJson(text: string): { findings: unknown[]; claimedChanges: unknown[] | null } {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return { findings: [], claimedChanges: null };
  try {
    const value = JSON.parse(candidate) as { findings?: unknown; claimedChanges?: unknown };
    return {
      findings: Array.isArray(value.findings) ? value.findings : [],
      claimedChanges: Array.isArray(value.claimedChanges) ? value.claimedChanges : null,
    };
  } catch {
    return { findings: [], claimedChanges: null };
  }
}

/** One path grammar for claims and diffs, so the two sides cannot drift apart. */
function normalizeChangePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function normalizeClaimedChange(value: unknown): ClaimedChange | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const rawPath = typeof item.path === "string" ? normalizeChangePath(item.path) : "";
  if (!rawPath) return null;
  const kind = ["created", "modified", "deleted"].includes(String(item.kind))
    ? String(item.kind) as ClaimedChange["kind"]
    : "modified";
  const taskId = typeof item.taskId === "string" && item.taskId.trim() ? item.taskId.trim() : null;
  return { path: rawPath, kind, taskId };
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
  identity: { provider: string; modelId?: string | null; connectionId: string; lens?: ReviewLens | null },
): StructuredReview {
  const verdict = firstVerdict(text);
  const parsed = parseReviewJson(text);
  const normalized = parsed.findings
    .map(normalizeFinding)
    .filter((finding): finding is ReviewFinding => Boolean(finding));
  const claimedChanges = parsed.claimedChanges === null
    ? null
    : parsed.claimedChanges.map(normalizeClaimedChange).filter((change): change is ClaimedChange => Boolean(change));
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
    lens: identity.lens ?? null,
    summary: body || (verdict === "READY" ? "No material findings." : findings[0]!.rationale),
    findings,
    claimedChanges,
    rawText: text,
  };
}

/**
 * The deterministic half of the claims lens: compare what the accepted reports
 * SAID against what the integration actually CONTAINS. A claimed change absent
 * from the diff is the defect-22 class (narration without artifacts) even when
 * other tasks made the diff nonempty; an integrated change nobody claimed is an
 * unexplained change. Claims from tasks that never passed are fallback echoes,
 * not divergences.
 */
export function claimsArtifactDivergence(input: {
  reviews: readonly StructuredReview[];
  diffPaths: readonly string[];
  passedTaskIds: ReadonlySet<string> | null;
}): ReviewFinding[] {
  const manifests = input.reviews.filter((review) => review.lens === "claims" && review.claimedChanges !== null);
  if (!manifests.length) return [];
  const claims = manifests.flatMap((review) => review.claimedChanges!);
  const diffSet = new Set(input.diffPaths.map(normalizeChangePath));
  const claimedSet = new Set(claims.map((claim) => claim.path));
  const findings: ReviewFinding[] = [];
  for (const claim of claims) {
    if (diffSet.has(claim.path)) continue;
    if (claim.taskId !== null && input.passedTaskIds !== null && !input.passedTaskIds.has(claim.taskId)) continue;
    findings.push({
      id: `divergence-claimed-${findings.length + 1}`,
      severity: "high",
      location: claim.path,
      rationale: `Task ${claim.taskId ?? "(unattributed)"} claims a ${claim.kind} change to ${claim.path} that the integrated diff does not contain.`,
      suggestedCorrection: "Establish whether the work was actually done; a report narrating changes that do not exist must fail, not pass.",
      disposition: "open",
    });
  }
  for (const path of diffSet) {
    if (claimedSet.has(path)) continue;
    findings.push({
      id: `divergence-unexplained-${findings.length + 1}`,
      severity: "medium",
      location: path,
      rationale: `${path} changed in the integration but no task report claims it.`,
      suggestedCorrection: "Attribute the change to a task or remove it before re-review.",
      disposition: "open",
    });
  }
  return findings;
}

export function adjudicateReviewQuorum(input: {
  requirement: ReviewRequirement;
  implementationProviders: readonly string[];
  reviews: readonly StructuredReview[];
  /** Deterministic claims/artifact divergence findings; they block the quorum like any open finding. */
  divergence?: readonly ReviewFinding[];
  /**
   * False for observe runs: there is no artifact, so a claims-lens review is
   * not required to return a claimed-changes manifest. Defaults to true.
   */
  expectClaimsManifest?: boolean;
}): ReviewQuorumDecision {
  const providers = new Set(input.reviews.map((review) => review.provider));
  const implementors = new Set(input.implementationProviders);
  const independentReviews = input.reviews.filter((review) => !implementors.has(review.provider)).length;
  const divergenceFindings = (input.divergence ?? []).filter((finding) => finding.disposition === "open");
  const openFindings = [
    ...input.reviews.flatMap((review) => review.findings).filter((finding) => finding.disposition === "open"),
    ...divergenceFindings,
  ];
  // An undeclared lens covers nothing: coverage is judged only on what a review
  // was actually shown, never inferred from what it happened to discuss.
  const declaredLenses = input.reviews
    .map((review) => review.lens)
    .filter((lens): lens is ReviewLens => lens !== null);
  const lensesCovered = [...new Set(declaredLenses)];
  const missingLenses = input.requirement.requiredLenses.filter((lens) => !lensesCovered.includes(lens));
  const reasons: string[] = [];
  if (missingLenses.length) {
    reasons.push(`Requires review lens coverage {${input.requirement.requiredLenses.join(", ")}}; not covered: ${missingLenses.join(", ")}.`);
  }
  if (divergenceFindings.length) {
    reasons.push(`Claims/artifact divergence: ${divergenceFindings.length} deterministic finding${divergenceFindings.length === 1 ? "" : "s"}.`);
  }
  if ((input.expectClaimsManifest ?? true) && input.reviews.some((review) => review.lens === "claims" && review.claimedChanges === null)) {
    reasons.push("A claims-lens review returned no claimed-changes manifest; the divergence check could not run.");
  }
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
    lensesCovered,
    singleLens: lensesCovered.length <= 1,
    openFindings,
    reasons,
  };
}
