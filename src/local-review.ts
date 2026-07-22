import type { ModelSelection, RuntimeAdapter } from "./runtime.js";
import { parseReviewerResponse } from "./review.js";

export interface DiffFileContext {
  path: string;
  diff: string;
}

export interface ReviewChunk {
  label: string;
  content: string;
}

export interface ChunkReviewReceipt {
  label: string;
  verdict: "READY" | "NOT READY";
  response: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  provider: string;
  connectionId: string;
  resolvedModelId: string;
}

export function chunkDiffFiles(files: readonly DiffFileContext[], maxChars = 6_000): ReviewChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1_000) {
    throw new Error("Review chunk budget must be at least 1000 characters");
  }
  if (!files.length) return [{ label: "no-diff", content: "No repository diff was produced." }];

  const chunks: ReviewChunk[] = [];
  for (const file of files) {
    const parts = splitText(file.diff.trim() || `No textual diff was produced for ${file.path}.`, maxChars);
    for (const [index, content] of parts.entries()) {
      chunks.push({
        label: parts.length === 1 ? file.path : `${file.path} (${index + 1}/${parts.length})`,
        content,
      });
    }
  }
  return chunks;
}

export async function runContextOnlyReview(input: {
  adapter: RuntimeAdapter;
  model: ModelSelection;
  cwd: string;
  contextHeader: string;
  chunks: readonly ReviewChunk[];
  evidenceLabel?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Lens-specific per-chunk JSON instruction; the default names findings alone. */
  jsonContract?: string;
  onChunk?: (receipt: ChunkReviewReceipt, index: number, total: number) => void;
}): Promise<{ text: string; receipts: ChunkReviewReceipt[] }> {
  const receipts: ChunkReviewReceipt[] = [];
  const evidenceLabel = input.evidenceLabel?.trim() || "diff chunk";
  const jsonContract = input.jsonContract?.trim() || `Finish with exactly one fenced JSON object shaped as {"findings":[{"id":"stable-short-id","severity":"low|medium|high|critical","location":"repository-prefixed location such as repo:core/src/a.ts:7","rationale":"evidence-backed reason","suggestedCorrection":"bounded correction","disposition":"open"}]}. READY must use an empty findings array. Every NOT READY blocking finding must use the exact repository-prefixed location visible in the supplied evidence; if no exact location is supported, use null so DevHarmonics fails closed instead of guessing.`;
  const supportedSettings = new Set(input.adapter.connection.capabilities.modelSettings);
  const boundedReviewSettings = Object.fromEntries(Object.entries({ temperature: 0, num_ctx: 8_192, num_predict: 512 })
    .filter(([name]) => supportedSettings.has(name)));
  for (const [index, chunk] of input.chunks.entries()) {
    const prompt = `${input.contextHeader.trim()}

You are reviewing bounded ${evidenceLabel} ${index + 1} of ${input.chunks.length}: ${chunk.label}

${evidenceLabel.toUpperCase()}:
${chunk.content}

Review only the supplied evidence against the stated goal and acceptance criteria. Flag contradictions, unsafe claims, or scope violations visible in this chunk; do not fail a chunk merely because a fact may appear in another chunk. Begin the first line with exactly READY or NOT READY and emit exactly one verdict. Do not write READY or NOT READY again after the first line. Then give concise evidence and any material risk. ${jsonContract} Do not request repository tools; every fact available to you is in this prompt.`;
    const result = await input.adapter.invoke({
      role: "reviewer",
      prompt,
      cwd: input.cwd,
      permission: "read_only",
      timeoutMs: input.timeoutMs ?? 120_000,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      model: {
        ...input.model,
        settings: {
          ...input.model.settings,
          ...boundedReviewSettings,
        },
      },
    }, input.signal ? { signal: input.signal } : {});
    const normalized = result.text.trim();
    const verdict = classifyVerdict(normalized);
    const receipt: ChunkReviewReceipt = {
      label: chunk.label,
      verdict,
      response: normalized,
      durationMs: result.durationMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      provider: result.provider,
      connectionId: String(result.connectionId),
      resolvedModelId: String(result.model.resolvedModelId),
    };
    receipts.push(receipt);
    input.onChunk?.(receipt, index, input.chunks.length);
  }

  const ready = receipts.every((receipt) => receipt.verdict === "READY");
  const parsedResponses = receipts.map((receipt) => parseReviewerResponse(receipt.response, {
    provider: receipt.provider,
    modelId: receipt.resolvedModelId,
    connectionId: receipt.connectionId,
  }));
  const findings = parsedResponses.flatMap((parsed) => parsed.findings);
  // The synthesized response must carry every field the chunks supplied in the
  // shared review grammar. Rebuilding the JSON with findings alone silently
  // discarded the claims lens's claimedChanges manifest — the exact
  // gate-and-verifier-drift class DH-470 records.
  const manifests = parsedResponses.map((parsed) => parsed.claimedChanges).filter((manifest) => manifest !== null);
  const claimedChanges = manifests.length
    ? [...new Map(manifests.flat().map((claim) => [`${claim.path}|${claim.kind}|${claim.taskId ?? ""}`, claim])).values()]
    : null;
  const evidence = receipts.map((receipt) => {
    const detail = receipt.response
      .replace(/^(?:READY|NOT READY)\b[:\s-]*/i, "")
      .replace(/```json[\s\S]*?```/gi, "")
      .trim()
      .slice(0, 1_200);
    return `- ${receipt.label}: ${receipt.verdict}${detail ? ` — ${detail}` : ""}`;
  }).join("\n");
  return {
    text: `${ready ? "READY" : "NOT READY"}

Context-only local review evaluated ${receipts.length} bounded ${evidenceLabel}${receipts.length === 1 ? "" : "s"}.

Evidence:
${evidence}

Material risks: ${ready ? "see the accepted chunk evidence; READY means the evidence package passed review, not that the target has no reported risks" : "one or more chunks require follow-up"}.

Required follow-up: ${ready ? "review and prioritize any risks documented in the accepted evidence" : "inspect the NOT READY chunk receipts before integration"}.

\`\`\`json
${JSON.stringify(claimedChanges === null ? { findings } : { findings, claimedChanges })}
\`\`\``,
    receipts,
  };
}

export function classifyVerdict(response: string): "READY" | "NOT READY" {
  const verdicts = [...response.matchAll(/^(READY|NOT READY)\b/gm)].map((match) => match[1]);
  const deferred = /\b(?:please\s+approve|awaiting\s+(?:plan\s+)?approval|approve\s+(?:the\s+)?execution|tasks?\s+can\s+proceed|can\s+proceed\s+as\s+planned)\b/i.test(response);
  return verdicts.length === 1 && verdicts[0] === "READY" && !deferred ? "READY" : "NOT READY";
}

function splitText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.length + 1 > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < line.length; offset += maxChars) {
        chunks.push(line.slice(offset, offset + maxChars));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}
