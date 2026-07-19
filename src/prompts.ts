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
  repositoryContext?: string;
  selectedRepositoryIds?: string[];
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

Exact planning workspace root: ${input.workspacePath}
Operate read-only inside that directory. Do not inspect another checkout unless it is explicitly listed in the repository registry context below. Registry metadata is authoritative for repositories that are not locally available.

Goal:
${input.goal}

${input.previousPlan ? `This is a revision of plan ${input.previousPlan.revision ?? 1}. Preserve sound work, address the requested changes, and return a complete replacement plan.\n\nPrevious plan:\n${JSON.stringify(input.previousPlan, null, 2)}\n\nRevision request:\n${input.revisionFeedback || "Refine the plan while preserving the objective."}\n` : ""}

Constitution:
${input.constitution}

${input.repositoryContext ? `Repository registry context:
${input.repositoryContext}

For every repository listed as requiring an impact decision, include exactly one repositoryImpact entry with an affected or excluded disposition and concrete rationale. Every affected repository must have at least one task whose repositoryIds includes it. Do not silently expand the selected scope. When shared-platform work can affect modules, or documentation, installer, version, or release-truth work may be required, represent that impact explicitly rather than burying it in another task. Multi-repository plans must list their cross-repository integration conditions.
` : ""}

Available worker providers: ${input.providers.join(", ")}
Allowlisted validators: ${input.validators.length ? input.validators.join(", ") : "none"}

Inspect the repository but do not modify it while planning. ${taskInstructions} Every check name must come from the allowlisted validators above. Never invent a shell command. Dependencies must form a directed acyclic graph.

Return only a JSON object with this exact shape:
{
  "summary": "short plan summary",
  "recommendedConcurrency": 4,
      "revision": ${input.previousPlan ? (input.previousPlan.revision ?? 1) + 1 : 1},
      "previousRevision": ${input.previousPlan ? input.previousPlan.revision ?? 1 : null},
  "repositoryImpact": [
    { "repositoryId": "registered-repository-id", "disposition": "affected" | "excluded", "rationale": "why this repository is or is not part of the change" }
  ],
  "integrationConditions": ["condition required before the affected repositories are ready together"],
  "tasks": [
    {
      "id": "short-lowercase-id",
      "title": "task title",
      "description": "${example.description}",
      "dependencies": [],
      "preferredProvider": "codex" | "claude" | "gemini" | null,
      "checks": ["validator-name"],
      "kind": "${example.kind}",
      "repositoryIds": ${JSON.stringify(input.selectedRepositoryIds ?? [])},
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
  // The mechanical gate proves cited lines EXIST; only a reviewer can judge
  // whether they SUPPORT what is claimed from them. Said explicitly, because a
  // reviewer who assumes resolution implies support waves through a report that
  // cites real lines whose content has nothing to do with its conclusions.
  const citationDuty = "Every path:line citation in these reports has already been verified to exist. That is all it proves. For each material conclusion, open the cited lines and judge whether their actual content supports the conclusion drawn from them; a real line cited for a claim it does not support is a finding, not evidence.";
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

${reviewSubject} ${citationDuty} Return a concise verdict beginning with exactly READY or NOT READY. After the verdict, explain the evidence and material risks. Then include exactly one fenced JSON object with this shape:
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

Citations in the task reports have been mechanically verified to exist — existence is already verified, and it is all that is. Where the provided chunks include the cited content, judge whether it supports the conclusion drawn from it, and treat a real line cited for a claim it does not support as a finding. Where the chunks do not include the cited content, say plainly that support could not be assessed rather than assuming it.

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

export function workbenchConsultationPrompt(input: {
  projectPath: string;
  question: string;
  discussionContext: string;
}): string {
  return `You are consulting inside the DevHarmonics Workbench, a discussion-only project scratchpad.

Project root: ${input.projectPath}

Hard boundary: this is not an execution run. Work read-only. Do not modify files, create commits or branches, install dependencies, invoke write-capable tools, or write to external systems. You may inspect the project when the runtime supports read-only tools. Clearly distinguish observed repository facts from inference.

Prior discussion:
${bounded(input.discussionContext || "No prior discussion.", 12_000)}

Current question:
${bounded(input.question, 6_000)}

Give a direct, useful answer for a product manager. Include concrete repository evidence when available, material tradeoffs, and unresolved questions. Do not produce an execution claim or imply that any proposed action has been approved.`;
}

function bounded(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n[truncated by DevHarmonics]`;
}
