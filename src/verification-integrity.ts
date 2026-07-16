export type VerificationIntegrityFindingKind =
  | "test-deleted"
  | "test-skipped"
  | "test-focused"
  | "test-filtered"
  | "assertion-weakened"
  | "unconditional-success"
  | "placeholder"
  | "swallowed-error";

export interface VerificationIntegrityFinding {
  kind: VerificationIntegrityFindingKind;
  severity: "medium" | "high" | "critical";
  path: string;
  evidence: string;
  rationale: string;
}

export interface VerificationIntegrityResult {
  passed: boolean;
  summary: string;
  census: {
    changedTestFiles: number;
    deletedTestFiles: number;
    addedSkips: number;
    removedAssertions: number;
    addedAssertions: number;
  };
  findings: VerificationIntegrityFinding[];
}

const testPath = /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|\.)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const assertion = /\b(?:assert(?:\.[a-z]+)?|expect|should|verify)\s*\(/i;

function changedLines(diff: string, prefix: "+" | "-"): string[] {
  const header = prefix === "+" ? "+++" : "---";
  return diff.split(/\r?\n/).filter((line) => line.startsWith(prefix) && !line.startsWith(header)).map((line) => line.slice(1));
}

function compactEvidence(line: string): string {
  const value = line.trim().replace(/\s+/g, " ");
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

export function analyzeVerificationIntegrity(files: readonly { path: string; diff: string }[]): VerificationIntegrityResult {
  const findings: VerificationIntegrityFinding[] = [];
  let changedTestFiles = 0;
  let deletedTestFiles = 0;
  let addedSkips = 0;
  let removedAssertions = 0;
  let addedAssertions = 0;

  for (const file of files) {
    const isTest = testPath.test(file.path.replaceAll("\\", "/"));
    const added = changedLines(file.diff, "+");
    const removed = changedLines(file.diff, "-");
    if (isTest) changedTestFiles++;
    if (isTest && /deleted file mode|\+\+\+ \/dev\/null/.test(file.diff)) {
      deletedTestFiles++;
      findings.push({ kind: "test-deleted", severity: "critical", path: file.path, evidence: "Test file deleted", rationale: "A deleted test reduces verification evidence until replacement coverage is demonstrated and approved." });
    }
    const fileRemovedAssertions = isTest ? removed.filter((line) => assertion.test(line)).length : 0;
    const fileAddedAssertions = isTest ? added.filter((line) => assertion.test(line) && !/assert\.(?:ok|equal|strictEqual)\s*\(\s*(?:true|1)\s*[,)]/i.test(line)).length : 0;
    removedAssertions += fileRemovedAssertions;
    addedAssertions += fileAddedAssertions;
    if (isTest && fileRemovedAssertions > fileAddedAssertions) {
      findings.push({ kind: "assertion-weakened", severity: "high", path: file.path, evidence: `${fileRemovedAssertions} assertion line(s) removed; ${fileAddedAssertions} substantive assertion line(s) added`, rationale: "The diff removes more executable assertions than it adds, so a green run may represent weaker evidence." });
    }
    for (const line of added) {
      if (isTest && /\b(?:describe|context|suite|test|it)\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe)\s*\(/i.test(line)) {
        addedSkips++;
        findings.push({ kind: "test-skipped", severity: "high", path: file.path, evidence: compactEvidence(line), rationale: "Newly skipped or deferred tests cannot satisfy the verification contract." });
      }
      if (isTest && /\b(?:describe|context|suite|test|it)\.only\s*\(|\bf(?:it|describe)\s*\(/i.test(line)) {
        findings.push({ kind: "test-focused", severity: "critical", path: file.path, evidence: compactEvidence(line), rationale: "A focused test selector can silently exclude the rest of the suite." });
      }
      if (/--test-name-pattern|--grep\b|\bpytest\b[^\n]*\s-k\s|\bjest\b[^\n]*\s-t\s/i.test(line)) {
        findings.push({ kind: "test-filtered", severity: "high", path: file.path, evidence: compactEvidence(line), rationale: "A new test-selection filter can reduce the executed census without changing the reported command outcome." });
      }
      if (/\|\|\s*true\b|;\s*exit\s+0\b|process\.exit\(0\)|assert\.(?:ok|equal|strictEqual)\s*\(\s*(?:true|1)\s*[,)]/i.test(line)) {
        findings.push({ kind: isTest ? "assertion-weakened" : "unconditional-success", severity: "critical", path: file.path, evidence: compactEvidence(line), rationale: "The added expression can force success independently of the behavior under test." });
      }
      if (/\b(?:TODO|FIXME)\b|throw new Error\(["']not implemented|return\s+(?:null|undefined)\s*;?\s*\/\/\s*stub/i.test(line)) {
        findings.push({ kind: "placeholder", severity: "medium", path: file.path, evidence: compactEvidence(line), rationale: "A newly introduced placeholder may substitute for the requested behavior." });
      }
      if (/catch\s*\([^)]*\)\s*\{\s*\}|catch\s*\{\s*\}/i.test(line)) {
        findings.push({ kind: "swallowed-error", severity: "high", path: file.path, evidence: compactEvidence(line), rationale: "A new empty catch can hide a failing behavior from validators." });
      }
    }
  }

  const unique = findings.filter((finding, index) => findings.findIndex((candidate) => candidate.kind === finding.kind && candidate.path === finding.path) === index);
  return {
    passed: unique.length === 0,
    summary: unique.length ? `${unique.length} material verification-integrity finding(s) require resolution or explicit approval.` : "No material verification-integrity weakening was detected in the integration diff.",
    census: { changedTestFiles, deletedTestFiles, addedSkips, removedAssertions, addedAssertions },
    findings: unique,
  };
}
