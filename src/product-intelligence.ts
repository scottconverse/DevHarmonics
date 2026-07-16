import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ProductRecord, RepositoryRecord } from "./ledger.js";
import { runProcess } from "./process.js";

export type ProductClaimKind = "version" | "release" | "status" | "maturity" | "tier";

export interface ProductIntelligenceSource {
  repositoryId: string;
  path: string;
  status: "read" | "missing" | "unsafe" | "unreadable";
  revision: string | null;
  blobSha: string | null;
  contentSha256: string | null;
  workingTree: boolean;
  error: string | null;
}

export interface SourceBackedClaim {
  kind: ProductClaimKind;
  subject: string;
  value: string;
  repositoryId: string;
  sourcePath: string;
  line: number;
  excerpt: string;
  revision: string;
  contentSha256: string;
  workingTree: boolean;
}

export interface ProductIntelligenceFinding {
  kind: "missing_source" | "unsafe_source" | "unreadable_source" | "dirty_source" | "conflicting_claim";
  severity: "info" | "warning" | "error";
  message: string;
  repositoryId: string | null;
  sourcePath: string | null;
  claimKind: ProductClaimKind | null;
  values: string[];
  citations: string[];
}

export interface RepositoryIntelligenceSummary {
  repositoryId: string;
  role: string;
  headSha: string | null;
  maturity: string;
  sourceCount: number;
  claimCount: number;
}

export interface ProductIntelligenceSnapshot {
  id: string;
  productId: string;
  status: "ready" | "attention";
  repositories: RepositoryIntelligenceSummary[];
  sources: ProductIntelligenceSource[];
  claims: SourceBackedClaim[];
  findings: ProductIntelligenceFinding[];
  createdAt: string;
}

export async function scanProductIntelligence(product: ProductRecord): Promise<ProductIntelligenceSnapshot> {
  const repositories: RepositoryIntelligenceSummary[] = [];
  const sources: ProductIntelligenceSource[] = [];
  const claims: SourceBackedClaim[] = [];
  const findings: ProductIntelligenceFinding[] = [];

  for (const repository of product.repositories) {
    const result = await scanRepository(repository);
    repositories.push(result.summary);
    sources.push(...result.sources);
    claims.push(...result.claims);
    findings.push(...result.findings);
  }
  findings.push(...conflictingClaimFindings(claims));

  return {
    id: randomUUID(),
    productId: product.id,
    status: findings.some((finding) => finding.severity !== "info") ? "attention" : "ready",
    repositories,
    sources,
    claims,
    findings,
    createdAt: new Date().toISOString(),
  };
}

const MAX_SOURCE_BYTES = 1_000_000;

async function scanRepository(repository: RepositoryRecord): Promise<{
  summary: RepositoryIntelligenceSummary;
  sources: ProductIntelligenceSource[];
  claims: SourceBackedClaim[];
  findings: ProductIntelligenceFinding[];
}> {
  const sources: ProductIntelligenceSource[] = [];
  const claims: SourceBackedClaim[] = [];
  const findings: ProductIntelligenceFinding[] = [];
  const headSha = repository.localPath ? await gitValue(repository.localPath, ["rev-parse", "HEAD"]) : repository.inspection?.headSha ?? null;

  for (const sourcePath of repository.governanceSources) {
    const result = await readCanonicalSource(repository, sourcePath, headSha);
    sources.push(result.source);
    claims.push(...result.claims);
    if (result.finding) findings.push(result.finding);
    if (result.source.workingTree) {
      findings.push({
        kind: "dirty_source",
        severity: "warning",
        message: `${repository.id}:${sourcePath} contains uncommitted canonical evidence.`,
        repositoryId: repository.id,
        sourcePath,
        claimKind: null,
        values: [],
        citations: [],
      });
    }
  }

  const maturityClaims = claims.filter((claim) => claim.kind === "maturity" || claim.kind === "tier");
  const maturityValues = [...new Set(maturityClaims.map((claim) => claim.value))];
  return {
    summary: {
      repositoryId: repository.id,
      role: repository.role,
      headSha,
      maturity: maturityValues.length === 0 ? "unknown" : maturityValues.length === 1 ? maturityValues[0]! : "conflicting",
      sourceCount: sources.filter((source) => source.status === "read").length,
      claimCount: claims.length,
    },
    sources,
    claims,
    findings,
  };
}

async function readCanonicalSource(repository: RepositoryRecord, sourcePath: string, revision: string | null): Promise<{
  source: ProductIntelligenceSource;
  claims: SourceBackedClaim[];
  finding: ProductIntelligenceFinding | null;
}> {
  const unavailable = (
    status: "missing" | "unsafe" | "unreadable",
    kind: "missing_source" | "unsafe_source" | "unreadable_source",
    message: string,
  ) => ({
    source: {
      repositoryId: repository.id,
      path: sourcePath,
      status,
      revision,
      blobSha: null,
      contentSha256: null,
      workingTree: false,
      error: message,
    } satisfies ProductIntelligenceSource,
    claims: [],
    finding: {
      kind,
      severity: kind === "unsafe_source" ? "error" : "warning",
      message,
      repositoryId: repository.id,
      sourcePath,
      claimKind: null,
      values: [],
      citations: [],
    } satisfies ProductIntelligenceFinding,
  });

  if (!repository.localPath) {
    return unavailable("unreadable", "unreadable_source", `${repository.id}:${sourcePath} cannot be scanned until a local checkout is attached.`);
  }
  let root: string;
  try {
    root = await realpath(repository.localPath);
  } catch {
    return unavailable(
      "unreadable",
      "unreadable_source",
      `${repository.id}:${sourcePath} cannot be scanned because its registered local checkout is unavailable.`,
    );
  }
  if (path.isAbsolute(sourcePath) || !isInside(root, path.resolve(root, sourcePath))) {
    return unavailable("unsafe", "unsafe_source", `${repository.id}:${sourcePath} escapes the registered repository root.`);
  }
  const target = path.resolve(root, sourcePath);
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(target);
  } catch {
    return unavailable("missing", "missing_source", `${repository.id}:${sourcePath} is configured but missing.`);
  }
  if (!isInside(root, resolvedTarget)) {
    return unavailable("unsafe", "unsafe_source", `${repository.id}:${sourcePath} resolves outside the registered repository root.`);
  }
  let stats;
  try {
    stats = await lstat(resolvedTarget);
  } catch {
    return unavailable("missing", "missing_source", `${repository.id}:${sourcePath} disappeared while it was being scanned.`);
  }
  if (!stats.isFile() || stats.size > MAX_SOURCE_BYTES) {
    return unavailable("unreadable", "unreadable_source", `${repository.id}:${sourcePath} is not a regular text file under ${MAX_SOURCE_BYTES} bytes.`);
  }
  let content: Buffer;
  try {
    content = await readFile(resolvedTarget);
  } catch {
    return unavailable("unreadable", "unreadable_source", `${repository.id}:${sourcePath} could not be read.`);
  }
  if (content.includes(0)) {
    return unavailable("unreadable", "unreadable_source", `${repository.id}:${sourcePath} appears to be binary.`);
  }
  const text = content.toString("utf8");
  const relativePath = path.relative(root, resolvedTarget).replaceAll(path.sep, "/");
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const [blobSha, status] = await Promise.all([
    gitValue(root, ["rev-parse", `HEAD:${relativePath}`]),
    gitValue(root, ["status", "--porcelain=v1", "--", relativePath]),
  ]);
  const workingTree = Boolean(status);
  const source: ProductIntelligenceSource = {
    repositoryId: repository.id,
    path: sourcePath,
    status: "read",
    revision,
    blobSha,
    contentSha256,
    workingTree,
    error: null,
  };
  return {
    source,
    claims: revision ? extractClaims(repository, sourcePath, text, revision, contentSha256, workingTree) : [],
    finding: null,
  };
}

function extractClaims(
  repository: RepositoryRecord,
  sourcePath: string,
  text: string,
  revision: string,
  contentSha256: string,
  workingTree: boolean,
): SourceBackedClaim[] {
  const lines = text.split(/\r?\n/);
  const claims: SourceBackedClaim[] = [];
  const defaultSubject = repository.name.toLowerCase();
  if (sourcePath.toLowerCase().endsWith(".json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const subject = typeof parsed.name === "string" ? parsed.name.toLowerCase() : defaultSubject;
      for (const kind of ["version", "release", "status", "maturity", "tier"] as const) {
        if (typeof parsed[kind] !== "string" && typeof parsed[kind] !== "number") continue;
        const line = Math.max(1, lines.findIndex((value) => new RegExp(`^[\\s\"]*${kind}[\"]?\\s*:`).test(value)) + 1);
        const value = normalizedClaimValue(String(parsed[kind]));
        if (isPlausibleClaim(kind, value)) claims.push(claim(repository.id, sourcePath, kind, subject, value, line, lines[line - 1] ?? "", revision, contentSha256, workingTree));
      }
    } catch {
      // A configured text source may use a .json suffix without valid JSON. Text extraction below remains safe.
    }
  }
  const projectSection = text.match(/(?:^|\n)\[project\]\s*\r?\n([\s\S]*?)(?=\r?\n\[|$)/i)?.[1];
  if (projectSection) {
    const name = projectSection.match(/^name\s*=\s*["']([^"']+)["']/mi)?.[1]?.toLowerCase() ?? defaultSubject;
    const versionMatch = projectSection.match(/^version\s*=\s*["']([^"']+)["']/mi);
    if (versionMatch?.[1]) {
      const line = Math.max(1, lines.findIndex((value) => value.includes(versionMatch[0])) + 1);
      claims.push(claim(repository.id, sourcePath, "version", name, versionMatch[1], line, lines[line - 1] ?? "", revision, contentSha256, workingTree));
    }
  }
  const dependencyPattern = /["']([a-z][a-z0-9_-]+)\s*@[^"']*\/releases\/download\/v([^/"']+)/ig;
  for (const match of text.matchAll(dependencyPattern)) {
    if (!match[1] || !match[2] || match.index === undefined) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    claims.push(claim(repository.id, sourcePath, "version", match[1].toLowerCase(), match[2], line, lines[line - 1] ?? "", revision, contentSha256, workingTree));
  }
  const proseDependencyPattern = /\b(?:exact|published|requires?|depends? on|pins?)\s+([a-z][a-z0-9_-]+)\s+v(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/ig;
  for (const match of text.matchAll(proseDependencyPattern)) {
    if (!match[1] || !match[2] || match.index === undefined) continue;
    if (["to", "the", "a", "an"].includes(match[1].toLowerCase())) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    claims.push(claim(repository.id, sourcePath, "version", match[1].toLowerCase(), match[2], line, lines[line - 1] ?? "", revision, contentSha256, workingTree));
  }
  const pattern = /^\s*(?:[#>*-]+\s*)?(?:\*\*)?(?:([a-z][a-z0-9_-]*)\s+)?(version|release|status|maturity|tier)(?:\*\*)?\s*[:=-]\s*(.+?)\s*$/i;
  lines.forEach((lineText, index) => {
    const match = lineText.match(pattern);
    if (!match?.[2] || !match[3]) return;
    const subject = match[1]?.toLowerCase() ?? defaultSubject;
    const kind = match[2].toLowerCase() as ProductClaimKind;
    const value = normalizedClaimValue(match[3]);
    if (!value || !isPlausibleClaim(kind, value)) return;
    if (!claims.some((item) => item.kind === kind && item.line === index + 1 && item.value === value)) {
      claims.push(claim(repository.id, sourcePath, kind, subject, value, index + 1, lineText, revision, contentSha256, workingTree));
    }
  });
  return claims;
}

function claim(
  repositoryId: string,
  sourcePath: string,
  kind: ProductClaimKind,
  subject: string,
  rawValue: string,
  line: number,
  excerpt: string,
  revision: string,
  contentSha256: string,
  workingTree: boolean,
): SourceBackedClaim {
  return {
    kind,
    subject,
    value: normalizedClaimValue(rawValue),
    repositoryId,
    sourcePath,
    line,
    excerpt: excerpt.trim().slice(0, 300),
    revision,
    contentSha256,
    workingTree,
  };
}

function normalizedClaimValue(value: string): string {
  return value.trim().replace(/^[`'"*]+|[`'"*,;.]+$/g, "").trim().slice(0, 200);
}

function isPlausibleClaim(kind: ProductClaimKind, value: string): boolean {
  if (kind === "version") return /^v?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?$/i.test(value);
  if (value.length > 80 || /[(){}\[\]]/.test(value)) return false;
  return /\b(alpha|beta|candidate|stable|ga|general availability|prototype|planned|queued|foundation|current|active|maintenance|deprecated|archived|complete|in progress|ready|not ready|experimental|released|unreleased|draft)\b/i.test(value)
    || /^v?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?$/i.test(value);
}

function conflictingClaimFindings(claims: SourceBackedClaim[]): ProductIntelligenceFinding[] {
  const groups = new Map<string, SourceBackedClaim[]>();
  for (const item of claims) {
    const key = `${item.subject}:${item.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const findings: ProductIntelligenceFinding[] = [];
  for (const items of groups.values()) {
    const values = [...new Set(items.map((item) => item.value))];
    if (values.length < 2) continue;
    const kind = items[0]!.kind;
    findings.push({
      kind: "conflicting_claim",
      severity: "error",
      message: `Canonical sources disagree on ${items[0]!.subject} ${kind}: ${values.join(" versus ")}.`,
      repositoryId: new Set(items.map((item) => item.repositoryId)).size === 1 ? items[0]!.repositoryId : null,
      sourcePath: null,
      claimKind: kind,
      values,
      citations: items.map((item) => `${item.repositoryId}:${item.sourcePath}:${item.line}`),
    });
  }
  return findings;
}

async function gitValue(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
