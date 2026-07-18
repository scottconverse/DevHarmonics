import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Mechanical verification of the `path:line` citations in a diagnostic report.
 *
 * A read-only diagnostic produces no repository change, so the usual proof —
 * validators run against modified state — has nothing to bite on. That left the
 * report's own citations as the evidence, and they were only ever checked for
 * SHAPE: a regex confirmed something looked like `file.ext:12`. A worker that
 * invents well-formed citations therefore passed.
 *
 * Citations are checkable facts, so this checks them: the cited file must exist
 * inside the assigned worktree, and the cited line must exist within it. This is
 * deterministic, needs no model, and costs milliseconds — where the alternative
 * was discovering the fabrication only if an executing reviewer happened to
 * re-inspect the repository itself.
 *
 * It deliberately verifies existence rather than meaning. Whether a real line
 * supports the conclusion drawn from it is a review question; whether the line
 * exists at all is not.
 */
export interface CitationCheck {
  /** The citation exactly as it appeared in the report. */
  citation: string;
  /** Repository-relative path as cited. */
  path: string;
  line: number;
  /** Empty when the citation resolves to a real line. */
  reason: string;
}

export interface CitationVerification {
  checked: CitationCheck[];
  unverifiable: CitationCheck[];
}

// Matches `src/app.py:12`, `README.md:4`, `docs\guide.md:7-9` — a filename with
// an extension followed by a line number, optionally a range.
const CITATION_PATTERN = /([A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[A-Za-z0-9]+):(\d+)(?:-\d+)?/g;

/** True when `candidate` stays inside `root` once resolved. */
function insideWorktree(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function verifyReportCitations(worktreePath: string, text: string): Promise<CitationVerification> {
  const root = path.resolve(worktreePath);
  const seen = new Set<string>();
  const checked: CitationCheck[] = [];

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const rawPath = match[1]!;
    const line = Number(match[2]);
    // A worker may cite an absolute path inside its own worktree; compare on the
    // repository-relative tail so both forms resolve the same way.
    const normalized = rawPath.replaceAll("\\", "/");
    const relative = normalized.includes(root.replaceAll("\\", "/"))
      ? normalized.slice(root.replaceAll("\\", "/").length).replace(/^\/+/, "")
      : normalized;
    const citation = `${rawPath}:${match[2]}`;
    if (seen.has(citation)) continue;
    seen.add(citation);

    const resolved = path.resolve(root, relative);
    const check: CitationCheck = { citation, path: relative, line, reason: "" };
    if (!insideWorktree(root, resolved)) {
      check.reason = "cites a path outside the assigned worktree";
      checked.push(check);
      continue;
    }
    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        check.reason = "cites a path that is not a file";
        checked.push(check);
        continue;
      }
      const lines = (await readFile(resolved, "utf8")).split(/\r?\n/).length;
      if (line < 1 || line > lines) {
        check.reason = `cites line ${line}, but the file has ${lines} line${lines === 1 ? "" : "s"}`;
      }
    } catch {
      check.reason = "cites a file that does not exist in the assigned worktree";
    }
    checked.push(check);
  }

  return { checked, unverifiable: checked.filter((item) => item.reason !== "") };
}

/** One-line summary suitable for a rejection message or a receipt. */
export function describeUnverifiableCitations(verification: CitationVerification): string {
  return verification.unverifiable
    .map((item) => `${item.citation} ${item.reason}`)
    .join("; ");
}
