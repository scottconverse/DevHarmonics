import type { CheckResult, ObjectiveRecord, PlannedTask, ProviderName, RunAutonomy, RunPlan } from "./types.js";

export function objectivePromptText(objective: Pick<ObjectiveRecord,
  "outcome" | "acceptanceCriteria" | "constraints" | "risk" | "priority" | "deadline" | "policyNotes" | "repositoryIds">): string {
  const lines = [
    `Outcome:\n${objective.outcome}`,
    `Acceptance criteria:\n${objective.acceptanceCriteria.length ? objective.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- Not supplied; identify ambiguities explicitly."}`,
    `Constraints:\n${objective.constraints.length ? objective.constraints.map((item) => `- ${item}`).join("\n") : "- None supplied."}`,
    `Objective risk: ${objective.risk}`,
    `Priority: ${objective.priority}`,
    `Deadline: ${objective.deadline || "None supplied"}`,
    `Selected repositories: ${objective.repositoryIds.length ? objective.repositoryIds.join(", ") : "Current local workspace"}`,
    `Policy notes:\n${objective.policyNotes.length ? objective.policyNotes.map((item) => `- ${item}`).join("\n") : "- Use project policy and defaults."}`,
  ];
  return lines.join("\n\n");
}

export function architectPrompt(input: {
  goal: string;
  constitution: string;
  validators: string[];
  providers: ProviderName[];
  workspacePath: string;
  autonomy: RunAutonomy;
  previousPlan?: RunPlan | null;
  revisionFeedback?: string;
}): string {
  const observe = input.autonomy === "observe";
  const taskInstructions = observe
    ? `This is an OBSERVE run. Inspect and analyze without changing repository files or external systems. Decompose the goal into independent evidence-gathering tasks. Every task must use kind "diagnostic", permission "read_only", and risk "low". Each task must produce a specific evidence report with cited file paths, commands, or repository facts. Do not create implementation, repair, release, or repository-writing tasks.`
    : `Decompose the goal into small implementation tasks that can run independently where possible. Tasks must produce repository changes; do not create separate planning or review tasks.`;
  const example = observe
    ? { description: "complete, bounded diagnostic instructions", kind: "diagnostic", permission: "read_only", risk: '"low"', capabilities: "analysis", artifacts: "evidence report" }
    : { description: "complete, bounded implementation instructions", kind: "implementation", permission: "workspace_write", risk: '"low" | "medium" | "high"', capabilities: "code", artifacts: "expected file, commit, or report" };
  return `You are the architect for a local software-development agent team.

Exact isolated workspace root: ${input.workspacePath}
Operate only inside that directory. Do not search for, inspect, or modify another checkout of this repository.

Goal:
${input.goal}

${input.previousPlan ? `This is a revision of plan ${input.previousPlan.revision ?? 1}. Preserve sound work, address the requested changes, and return a complete replacement plan.\n\nPrevious plan:\n${JSON.stringify(input.previousPlan, null, 2)}\n\nRevision request:\n${input.revisionFeedback || "Refine the plan while preserving the objective."}\n` : ""}

Constitution:
${input.constitution}

Available worker providers: ${input.providers.join(", ")}
Allowlisted validators: ${input.validators.length ? input.validators.join(", ") : "none"}

Inspect the repository but do not modify it while planning. ${taskInstructions} Every check name must come from the allowlisted validators above. Never invent a shell command. Dependencies must form a directed acyclic graph.

Return only a JSON object with this exact shape:
{
  "summary": "short plan summary",
  "recommendedConcurrency": 4,
      "revision": ${input.previousPlan ? (input.previousPlan.revision ?? 1) + 1 : 1},
      "previousRevision": ${input.previousPlan ? input.previousPlan.revision ?? 1 : null},
  "tasks": [
    {
      "id": "short-lowercase-id",
      "title": "task title",
      "description": "${example.description}",
      "dependencies": [],
      "preferredProvider": "codex" | "claude" | "gemini" | null,
      "checks": ["validator-name"],
      "kind": "${example.kind}",
      "repositoryScope": ["."],
      "permission": "${example.permission}",
      "risk": ${example.risk},
      "capabilityNeeds": ["${example.capabilities}"],
      "acceptanceCriteria": ["observable condition that must be true"],
      "expectedArtifacts": ["${example.artifacts}"]
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
  workspacePath: string;
  sharedContext?: string;
}): string {
  const readOnly = input.task.permission === "read_only";
  const role = readOnly ? "a diagnostic investigator completing one bounded read-only task" : "a worker implementing one bounded task in an isolated Git worktree";
  const expectedArtifacts = (input.task.expectedArtifacts ?? []).join(", ") || (readOnly ? "evidence report" : "repository changes and verification receipts");
  const instructions = readOnly
    ? "Plan approval has already been granted by the user. Execute the assigned diagnostic now; do not ask for approval or return another plan. Investigate only this task. Do not modify files, create commits or branches, install dependencies, or write to external systems. Run only read-only inspection commands. Return a concise evidence report that directly addresses every acceptance criterion, cites exact file paths and relevant facts, distinguishes observations from inferences, and lists any uncertainty."
    : "Implement only this task. Inspect existing conventions, make the necessary edits, and run focused checks when useful. Do not commit, create branches, alter .devharmonics, or claim success without evidence. Finish with a concise summary of files changed and checks you ran.";
  return `You are ${role}.

Exact isolated workspace root: ${input.workspacePath}
Operate only inside that directory. Do not search for, inspect, or modify another checkout of this repository.

Overall goal:
${input.goal}

Constitution:
${input.constitution}

Assigned task (${input.task.id}): ${input.task.title}
${input.task.description}

Repository scope: ${(input.task.repositoryScope ?? ["."]).join(", ")}
Risk: ${input.task.risk ?? "medium"}
Required capabilities: ${(input.task.capabilityNeeds ?? ["code"]).join(", ")}
Acceptance criteria:
${(input.task.acceptanceCriteria ?? []).map((criterion) => `- ${criterion}`).join("\n") || "- Pass the assigned validators without widening scope."}
Expected artifacts: ${expectedArtifacts}

Acceptance validators run by the orchestrator after you finish: ${input.task.checks.join(", ") || "none configured"}
Attempt: ${input.attempt}
${input.sharedContext ? `\nDurable handoff context from earlier attempts:\n${input.sharedContext}\n` : ""}
${input.feedback ? `\nPrevious verification feedback:\n${input.feedback}\n` : ""}
${instructions}`;
}

export function reviewerPrompt(input: {
  goal: string;
  constitution: string;
  plan: RunPlan;
  checkSummary: string;
  taskReports: string;
  workspacePath: string;
  autonomy: RunAutonomy;
}): string {
  const reviewSubject = input.autonomy === "observe"
    ? "Review the diagnostic task reports and repository state. Confirm that the reports answer the goal with concrete evidence, that no repository changes were made, and that conclusions distinguish fact from inference."
    : "Review the combined diff, task reports, and repository state.";
  return `You are the final reviewer. Inspect the integration worktree in read-only mode.

Exact isolated workspace root: ${input.workspacePath}
Operate only inside that directory. Do not search for, inspect, or modify another checkout of this repository.

Goal:
${input.goal}

Constitution:
${input.constitution}

Plan:
${JSON.stringify(input.plan, null, 2)}

Executed check receipts:
${input.checkSummary}

Diagnostic task reports and handoffs:
${input.taskReports || "No task reports were recorded."}

${reviewSubject} Return a concise verdict beginning with exactly READY or NOT READY. After the verdict, explain the evidence and material risks. Then include exactly one fenced JSON object with this shape:
\`\`\`json
{"findings":[{"id":"stable-short-id","severity":"low|medium|high|critical","location":"path:line or null","rationale":"evidence-backed reason","suggestedCorrection":"bounded correction","disposition":"open"}]}
\`\`\`
READY must use an empty findings array. NOT READY must include every blocking finding. Do not inherit implementor claims as fact, do not modify files, and do not emit another verdict after the first line.`;
}

export function localReviewerContextHeader(input: {
  goal: string;
  constitution: string;
  plan: RunPlan;
  checkSummary: string;
  taskReports: string;
  autonomy: RunAutonomy;
}): string {
  const contracts = input.plan.tasks.map((task) => [
    `${task.id}: ${task.title}`,
    `scope=${(task.repositoryScope ?? ["."]).join(", ")}`,
    `permission=${task.permission ?? "workspace_write"}`,
    `acceptance=${(task.acceptanceCriteria ?? []).join(" | ") || "assigned checks pass"}`,
  ].join("; ")).join("\n");
  return `You are the final context-only reviewer for an isolated integration branch. You do not have repository tools; the orchestrator will provide the combined diff in bounded chunks.

Goal:
${bounded(input.goal, 3_000)}

Constitution:
${bounded(input.constitution, 2_000)}

Task contracts:
${bounded(contracts, 4_000)}

Executed check receipts:
${bounded(input.checkSummary, 3_000)}

${input.autonomy === "observe" ? "Diagnostic task reports" : "Task reports and handoffs"}:
${bounded(input.taskReports || "No task reports were recorded.", 12_000)}`;
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

function bounded(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n[truncated by DevHarmonics]`;
}
