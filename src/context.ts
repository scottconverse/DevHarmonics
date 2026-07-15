import { createHash } from "node:crypto";
import type { AgentRole } from "./types.js";

export interface ContextSource {
  reference: string;
  priority: number;
  content: string;
}

export interface ContextPack {
  role: AgentRole;
  content: string;
  includedReferences: string[];
  omittedReferences: string[];
  charCount: number;
  budgetChars: number;
  sha256: string;
}

export function assembleContextPack(role: AgentRole, sources: readonly ContextSource[], budgetChars: number): ContextPack {
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 1_000) throw new Error("Context budget must be at least 1000 characters");
  const ordered = [...sources].sort((left, right) => right.priority - left.priority || left.reference.localeCompare(right.reference));
  const included: string[] = [];
  const omitted: string[] = [];
  let content = "";
  for (const source of ordered) {
    const section = `\n[${source.reference}]\n${source.content.trim()}\n`;
    if (content.length + section.length <= budgetChars) {
      content += section;
      included.push(source.reference);
    } else {
      omitted.push(source.reference);
    }
  }
  content = content.trim();
  return {
    role,
    content,
    includedReferences: included,
    omittedReferences: omitted,
    charCount: content.length,
    budgetChars,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
