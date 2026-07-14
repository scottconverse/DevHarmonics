import type { CheckResult, PlannedTask, ProviderName, RunPlan } from "./types.js";

export function architectPrompt(input: {
  goal: string;
  constitution: string;
  validators: string[];
  providers: ProviderName[];
}): string {
  return `You are the architect for a local software-development agent team.

Goal:
${input.goal}

Constitution:
${input.constitution}

Available worker providers: ${input.providers.join(", ")}
Allowlisted validators: ${input.validators.length ? input.validators.join(", ") : "none"}

Inspect the repository but do not modify it. Decompose the goal into small implementation tasks that can run independently where possible. Tasks must produce repository changes; do not create separate planning or review tasks. Every check name must come from the allowlisted validators above. Never invent a shell command. Dependencies must form a directed acyclic graph.

Return only a JSON object with this exact shape:
{
  "summary": "short plan summary",
  "recommendedConcurrency": 4,
  "tasks": [
    {
      "id": "short-lowercase-id",
      "title": "task title",
      "description": "complete, bounded implementation instructions",
      "dependencies": [],
      "preferredProvider": "codex" | "claude" | "gemini" | null,
      "checks": ["validator-name"]
    }
  ]
}`;
}

export function workerPrompt(input: {
  goal: string;
  constitution: string;
  task: PlannedTask;
  attempt: number;
  feedback: string;
}): string {
  return `You are a worker implementing one bounded task in an isolated Git worktree.

Overall goal:
${input.goal}

Constitution:
${input.constitution}

Assigned task (${input.task.id}): ${input.task.title}
${input.task.description}

Acceptance validators run by the orchestrator after you finish: ${input.task.checks.join(", ") || "none configured"}
Attempt: ${input.attempt}
${input.feedback ? `\nPrevious verification feedback:\n${input.feedback}\n` : ""}
Implement only this task. Inspect existing conventions, make the necessary edits, and run focused checks when useful. Do not commit, create branches, alter .devharmonics, or claim success without evidence. Finish with a concise summary of files changed and checks you ran.`;
}

export function reviewerPrompt(input: {
  goal: string;
  constitution: string;
  plan: RunPlan;
  checkSummary: string;
}): string {
  return `You are the final reviewer. Inspect the integration worktree in read-only mode.

Goal:
${input.goal}

Constitution:
${input.constitution}

Plan:
${JSON.stringify(input.plan, null, 2)}

Executed check receipts:
${input.checkSummary}

Review the combined diff and repository state. Return a concise verdict beginning with exactly READY or NOT READY, followed by evidence, material risks, and any required follow-up. Do not modify files.`;
}

export function formatFailures(results: CheckResult[]): string {
  return results
    .filter((result) => !result.passed)
    .map((result) => {
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      return `${result.name} exited ${result.exitCode}:\n${output || "No output"}`;
    })
    .join("\n\n");
}
