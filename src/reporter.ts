import type { RunEvidencePackage } from "./ledger.js";

export type RunReportVerdict = "READY" | "NOT_READY" | "INCONCLUSIVE";

export interface RunReport {
  readonly version: 1;
  readonly runId: string;
  readonly verdict: RunReportVerdict;
  readonly evidenceHash: string;
  readonly summary: string;
  readonly counts: Readonly<{
    tasks: number;
    attempts: number;
    checks: number;
    toolReceipts: number;
    reviews: number;
  }>;
  readonly missingEvidence: readonly string[];
  readonly inconsistencies: readonly string[];
}

export interface RunEvidenceExport {
  readonly version: 1;
  readonly evidenceVersion: number;
  readonly integritySha256: string;
  readonly report: RunReport;
  readonly evidence: Readonly<{
    run: unknown;
    attempts: readonly unknown[];
    blackboard: readonly unknown[];
    toolReceipts: readonly unknown[];
    reviews: readonly unknown[];
  }>;
}

function reviewVerdict(review: string | null): "READY" | "NOT_READY" | null {
  if (!review) return null;
  const firstLine = review.trimStart().split(/\r?\n/, 1)[0]?.trim().toUpperCase();
  if (firstLine === "READY") return "READY";
  if (firstLine === "NOT READY" || firstLine === "NOT_READY") return "NOT_READY";
  return null;
}

function reviewSummary(review: string | null): string {
  if (!review) return "No final review has been retained.";
  const lines = review.trim().split(/\r?\n/);
  if (/^(?:READY|NOT[ _]READY)$/i.test(lines[0]?.trim() ?? "")) lines.shift();
  return lines.join("\n").trim() || "The final review retained a verdict without explanatory detail.";
}

function freezeReport(report: RunReport): RunReport {
  Object.freeze(report.counts);
  Object.freeze(report.missingEvidence);
  Object.freeze(report.inconsistencies);
  return Object.freeze(report);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createRunReport(evidence: RunEvidencePackage | Record<string, any>): RunReport {
  const run = evidence.run as RunEvidencePackage["run"];
  const attempts = Array.isArray(evidence.attempts) ? evidence.attempts : [];
  const toolReceipts = Array.isArray(evidence.toolReceipts) ? evidence.toolReceipts : [];
  const reviews = Array.isArray(evidence.reviews) ? evidence.reviews : [];
  const currentReviews = reviews.filter((review) => !review || typeof review !== "object" || !(review as { invalidatedAt?: unknown }).invalidatedAt);
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const checks = tasks.flatMap((task) => Array.isArray(task.checks) ? task.checks : []);
  const retainedReview = typeof run?.finalReview === "string" ? run.finalReview : null;
  const retainedVerdict = reviewVerdict(retainedReview);
  const missingEvidence: string[] = [];
  const inconsistencies: string[] = [];

  if (!retainedReview) missingEvidence.push("final review");
  else if (!retainedVerdict) missingEvidence.push("machine-readable final verdict");
  if (!tasks.length) missingEvidence.push("task records");
  if (!attempts.length) missingEvidence.push("attempt receipts");
  if (!checks.length) missingEvidence.push("check receipts");
  if (!currentReviews.length) missingEvidence.push("current review receipts");

  if (run.status === "not_ready" && retainedVerdict === "READY") {
    inconsistencies.push("READY review conflicts with run status not_ready");
  }
  if (run.status === "ready" && retainedVerdict === "NOT_READY") {
    inconsistencies.push("NOT READY review conflicts with run status ready");
  }
  if (run.status === "ready" && retainedVerdict === null) {
    inconsistencies.push("Run status ready has no machine-readable final review verdict");
  }
  if (run.status === "ready" && currentReviews.some((review) => (review as { verdict?: unknown }).verdict !== "READY")) {
    inconsistencies.push("Run status ready conflicts with a current non-READY structured review");
  }
  const integrationHashes = new Set(currentReviews.map((review) => String((review as { integrationSha256?: unknown }).integrationSha256 ?? "")).filter(Boolean));
  if (integrationHashes.size > 1) inconsistencies.push("Current review receipts refer to different integration evidence hashes");

  let verdict: RunReportVerdict = "INCONCLUSIVE";
  if (["not_ready", "failed", "cancelled"].includes(run.status) || retainedVerdict === "NOT_READY") {
    verdict = "NOT_READY";
  } else if (run.status === "ready" && retainedVerdict === "READY" && !missingEvidence.length && !inconsistencies.length) {
    verdict = "READY";
  }

  return freezeReport({
    version: 1,
    runId: run.id,
    verdict,
    evidenceHash: String(evidence.integritySha256 ?? ""),
    summary: reviewSummary(retainedReview),
    counts: { tasks: tasks.length, attempts: attempts.length, checks: checks.length, toolReceipts: toolReceipts.length, reviews: currentReviews.length },
    missingEvidence,
    inconsistencies,
  });
}

export function createRunEvidenceExport(evidence: RunEvidencePackage | Record<string, any>): RunEvidenceExport {
  const retained = cloneJson({
    run: evidence.run,
    attempts: Array.isArray(evidence.attempts) ? evidence.attempts : [],
    blackboard: Array.isArray(evidence.blackboard) ? evidence.blackboard : [],
    toolReceipts: Array.isArray(evidence.toolReceipts) ? evidence.toolReceipts : [],
    reviews: Array.isArray(evidence.reviews) ? evidence.reviews : [],
  });
  return deepFreeze({
    version: 1 as const,
    evidenceVersion: Number(evidence.version ?? 0),
    integritySha256: String(evidence.integritySha256 ?? ""),
    report: createRunReport(evidence),
    evidence: retained,
  });
}
