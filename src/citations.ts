import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Mechanical verification of the source citations in a diagnostic report.
 *
 * A read-only diagnostic produces no repository change, so the usual proof —
 * validators run against modified state — has nothing to bite on. That left the
 * report's own citations as the evidence, and they were only ever checked for
 * SHAPE: a regex confirmed something looked like `file.ext:12`. A worker that
 * invents well-formed citations therefore passed.
 *
 * Citations are checkable facts, so this checks them: the cited file must exist
 * inside the assigned worktree, and every cited line must exist within it.
 *
 * ONE grammar, used by both the evidence gate and this verifier. The first
 * version of this module had its own narrower pattern than the gate in
 * `agents.ts`, so `[missing.md](missing.md), line 2` satisfied the gate and
 * produced zero citations to verify — the check was bypassed by writing the
 * evidence a different, equally accepted way. Any form the gate accepts as
 * evidence must be a form this module can resolve, which is only guaranteed if
 * there is exactly one extractor. That is `extractCitations`.
 *
 * It deliberately verifies existence rather than meaning. Whether a real line
 * supports the conclusion drawn from it is a review question; whether the line
 * exists at all is not.
 */
export interface ParsedCitation {
  /** The citation as it should be shown back to the owner. */
  citation: string;
  /** The path exactly as written in the report, before any resolution. */
  rawPath: string;
  startLine: number;
  /** Equal to `startLine` unless the report cited a range. */
  endLine: number;
}

export interface CitationCheck extends ParsedCitation {
  /** Empty when the citation resolves to real lines. */
  reason: string;
}

export interface CitationVerification {
  checked: CitationCheck[];
  unverifiable: CitationCheck[];
}

// A path token: an optional `file:///` scheme, an optional root (Windows drive,
// UNC share, or POSIX `/`), directory segments that may include `..`, and a
// filename with an alphabetic extension. The extension must start with a letter
// so that version strings like `1.2.0` are not read as filenames.
const PATH_TOKEN = String.raw`(?:file:///)?(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|/)?(?:[\w.@~+-]+[\\/])*[\w.@~+-]*\.[A-Za-z][A-Za-z0-9]{0,7}`;
// Do not start a match in the middle of a longer path or identifier.
const BOUNDARY = String.raw`(?<![\w.\\/:-])`;
const RANGE = String.raw`(\d+)(?:\s*[-–]\s*(\d+))?`;

const DIRECT_CITATION = new RegExp(`${BOUNDARY}(${PATH_TOKEN}):${RANGE}`, "g");
const LINKED_CITATION = new RegExp(`\\[[^\\]]*\\]\\(\\s*(${PATH_TOKEN})(?::${RANGE})?[^)]*\\)`, "g");
const BARE_PATH = new RegExp(`${BOUNDARY}(${PATH_TOKEN})`, "g");
// The gate in `agents.ts` accepts a file mention with a line reference in nearby
// prose, so this resolves that form too, pairing a path with the first line
// reference that follows it. The pairing is a heuristic — that is inherent to
// the prose form, and matching the gate exactly is the point.
const NEARBY_LINE = new RegExp(`\\blines?\\s+${RANGE}`, "i");
const NEARBY_WINDOW = 300;

interface Candidate {
  rawPath: string;
  start: number;
  end: number;
  startLine: number | null;
  endLine: number | null;
}

/**
 * Every evidence-shaped source reference in `text`, in the same grammar the
 * diagnostic evidence gate accepts. Explicit `path:line` forms win over linked
 * forms, which win over a bare path paired with a nearby line reference.
 */
export function extractCitations(text: string): ParsedCitation[] {
  const candidates: Candidate[] = [];
  const claimed: Array<[number, number]> = [];
  const overlapsClaimed = (start: number, end: number): boolean =>
    claimed.some(([from, to]) => start < to && end > from);

  const collect = (pattern: RegExp, pathGroup: number, lineGroup: number): void => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (overlapsClaimed(start, end)) continue;
      claimed.push([start, end]);
      const startLine = match[lineGroup] ? Number(match[lineGroup]) : null;
      const endLine = match[lineGroup + 1] ? Number(match[lineGroup + 1]) : startLine;
      candidates.push({ rawPath: match[pathGroup]!, start, end, startLine, endLine });
    }
  };

  collect(DIRECT_CITATION, 1, 2);
  collect(LINKED_CITATION, 1, 2);
  collect(BARE_PATH, 1, 2);

  const seen = new Set<string>();
  const citations: ParsedCitation[] = [];
  for (const candidate of candidates) {
    let { startLine, endLine } = candidate;
    if (startLine === null) {
      const nearby = NEARBY_LINE.exec(text.slice(candidate.end, candidate.end + NEARBY_WINDOW));
      if (!nearby) continue;
      startLine = Number(nearby[1]);
      endLine = nearby[2] ? Number(nearby[2]) : startLine;
    }
    // A backwards range (`file.ts:9-2`) is not a line span anyone can check.
    const first = startLine;
    const last = endLine ?? startLine;
    const citation = first === last ? `${candidate.rawPath}:${first}` : `${candidate.rawPath}:${first}-${last}`;
    if (seen.has(citation)) continue;
    seen.add(citation);
    citations.push({ citation, rawPath: candidate.rawPath, startLine: first, endLine: last });
  }
  return citations;
}

/** True when `candidate` stays inside `root` once both are resolved. */
function insideWorktree(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Lines the file actually has. An empty file has zero lines, and a trailing
 * newline does not create a final empty one — both used to be counted as a real
 * line, so `empty.md:1` verified against a file with nothing in it.
 */
function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** The cited path as an absolute filesystem path, or null if it is not a path. */
function toAbsolute(root: string, rawPath: string): string | null {
  let cited = rawPath.startsWith("file:///") ? rawPath.slice("file:///".length) : rawPath;
  // A POSIX `file:///etc/x` loses its leading slash to the scheme strip.
  if (!/^[A-Za-z]:[\\/]/.test(cited) && rawPath.startsWith("file:///")) cited = `/${cited}`;
  const rooted = /^[A-Za-z]:[\\/]/.test(cited) || cited.startsWith("\\\\") || cited.startsWith("/");
  // Only resolve an absolute path as absolute on a platform that understands
  // that root, otherwise `C:\x\y.ts` silently becomes a relative path.
  if (rooted) return path.isAbsolute(cited) ? path.resolve(cited) : null;
  return path.resolve(root, cited);
}

export async function verifyReportCitations(worktreePath: string, text: string): Promise<CitationVerification> {
  const root = await canonical(path.resolve(worktreePath));
  const checked: CitationCheck[] = [];

  for (const citation of extractCitations(text)) {
    const check: CitationCheck = { ...citation, reason: await checkCitation(root, citation) };
    checked.push(check);
  }

  return { checked, unverifiable: checked.filter((item) => item.reason !== "") };
}

async function checkCitation(root: string, citation: ParsedCitation): Promise<string> {
  if (citation.endLine < citation.startLine) return "cites a line range that ends before it starts";
  const resolved = toAbsolute(root, citation.rawPath);
  if (resolved === null) return "cites a path outside the assigned worktree";
  // Containment is decided once, on the canonical target: a symlink can be
  // lexically inside the worktree and point anywhere, and a `../` traversal is
  // only visible before the path is normalized away.
  if (!insideWorktree(root, await canonical(resolved))) return "cites a path outside the assigned worktree";
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return "cites a path that is not a file";
    const lines = countLines(await readFile(resolved, "utf8"));
    if (citation.startLine < 1 || citation.endLine > lines) {
      return lines === 0
        ? "cites a line in a file that is empty"
        : `cites line${citation.startLine === citation.endLine ? "" : "s"} ${citation.startLine === citation.endLine ? citation.startLine : `${citation.startLine}-${citation.endLine}`}, but the file has ${lines} line${lines === 1 ? "" : "s"}`;
    }
  } catch {
    return "cites a file that does not exist in the assigned worktree";
  }
  return "";
}

/** Canonical path, falling back to the resolved path when it does not exist. */
async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

/** One-line summary suitable for a rejection message or a receipt. */
export function describeUnverifiableCitations(verification: CitationVerification): string {
  return verification.unverifiable
    .map((item) => `${item.citation} ${item.reason}`)
    .join("; ");
}
