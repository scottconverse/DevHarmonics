import type { CheckResult, ObjectiveRecord, PlannedTask, ProviderName, RunAutonomy, RunPlan } from "./types.js";
import type { ReviewLens } from "./review.js";

const NARRATION_WITHHELD =
  "Implementor task reports are deliberately withheld from this review lens. Judge only the artifact itself — the repository state, the combined diff, and the executed check receipts. Do not assume anything a report might have claimed.";

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

Inspect the repository but do not modify it while planning. ${taskInstructions} Every check name must come from the allowlisted validators above, and for a repository-scoped task it must be one the repository context lists for THAT repository — a validator registered elsewhere does not exist there. Never invent a shell command. Dependencies must form a directed acyclic graph.

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

/**
 * What the reviewer may be told about citation verification, given what actually
 * ran. `verifyReportCitations` executes only for read-only tasks, so a plan with
 * no read-only task earns no existence claim at all, and a mixed plan earns one
 * scoped to the reports it covered.
 */
export function citationDutyText(plan: RunPlan): string {
  const judgeSupport = "For each material conclusion, open the cited lines and judge whether their actual content supports the conclusion drawn from them; a real line cited for a claim it does not support is a finding, not evidence.";
  const readOnly = plan.tasks.filter((task) => (task.permission ?? "workspace_write") === "read_only");
  if (readOnly.length === 0) {
    return `Citations in these reports have NOT been mechanically verified — that check runs only for read-only tasks, and this plan has none. Treat every cited location as unverified. ${judgeSupport}`;
  }
  if (readOnly.length === plan.tasks.length) {
    return `Every path:line citation in these reports has already been verified to exist. That is all it proves. ${judgeSupport}`;
  }
  const names = readOnly.map((task) => task.id).join(", ");
  return `Citations have already been verified to exist for the read-only tasks (${names}); that is all that check proves, and reports from the remaining tasks carry no such verification. ${judgeSupport}`;
}

export function reviewerPrompt(input: {
  goal: string;
  constitution: string;
  plan: RunPlan;
  checkSummary: string;
  taskReports: string;
  workspacePath: string;
  autonomy: RunAutonomy;
  lens?: ReviewLens | null;
}): string {
  const reviewSubject = input.autonomy === "observe"
    ? "Review the diagnostic task reports and repository state. Confirm that the reports answer the goal with concrete evidence, that no repository changes were made, and that conclusions distinguish fact from inference."
    : "Review the combined diff, task reports, and repository state.";
  // The mechanical gate proves cited lines EXIST; only a reviewer can judge
  // whether they SUPPORT what is claimed from them. Said explicitly, because a
  // reviewer who assumes resolution implies support waves through a report that
  // cites real lines whose content has nothing to do with its conclusions.
  //
  // Verification runs only for read-only tasks, so the claim is made only about
  // reports that actually went through it. Telling a reviewer that an
  // implementation task's citations were mechanically verified is a claim the
  // product has not earned.
  // The citation duty is about judging report citations; the artifact lens has
  // no reports to judge, so the duty would dangle there.
  const citationDuty = input.lens === "artifact" ? "" : ` ${citationDutyText(input.plan)}`;
  // The artifact lens sees no implementor narration: reviewers that all read
  // the same worker claims share the same blind spot, so this bundle keeps
  // only what actually exists — the worktree, the diff, and the receipts.
  const reportsSection = input.lens === "artifact"
    ? NARRATION_WITHHELD
    : `Diagnostic task reports and handoffs:\n${input.taskReports || "No task reports were recorded."}`;
  const artifactReviewSubject = input.lens === "artifact" && input.autonomy !== "observe"
    ? "Review the combined diff and repository state."
    : reviewSubject;
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

${reportsSection}

${artifactReviewSubject}${citationDuty} Return a concise verdict beginning with exactly READY or NOT READY. After the verdict, explain the evidence and material risks. Then include exactly one fenced JSON object with this shape:
\`\`\`json
{"findings":[{"id":"stable-short-id","severity":"low|medium|high|critical","location":"path:line or null","rationale":"evidence-backed reason","suggestedCorrection":"bounded correction","disposition":"open"}]}
\`\`\`
READY must use an empty findings array. NOT READY must include every blocking finding. Do not inherit implementor claims as fact, do not modify files, and do not emit another verdict after the first line.`;
}

function taskContractLines(plan: RunPlan): string {
  return plan.tasks.map((task) => [
    `${task.id}: ${task.title}`,
    `scope=${(task.repositoryScope ?? ["."]).join(", ")}`,
    `permission=${task.permission ?? "workspace_write"}`,
    `acceptance=${(task.acceptanceCriteria ?? []).join(" | ") || "assigned checks pass"}`,
  ].join("; ")).join("\n");
}

export function localReviewerContextHeader(input: {
  goal: string;
  constitution: string;
  plan: RunPlan;
  checkSummary: string;
  taskReports: string;
  autonomy: RunAutonomy;
  lens?: ReviewLens | null;
}): string {
  const contracts = taskContractLines(input.plan);
  const reportsSection = input.lens === "artifact"
    ? NARRATION_WITHHELD
    : `${input.autonomy === "observe" ? "Diagnostic task reports" : "Task reports and handoffs"}:\n${bounded(input.taskReports || "No task reports were recorded.", 12_000)}`;
  const citationDuty = input.lens === "artifact"
    ? "Judge only what the provided chunks actually contain."
    : `${citationDutyText(input.plan)} Where the provided chunks do not include the cited content, say plainly that support could not be assessed rather than assuming it.`;
  return `You are the final context-only reviewer for an isolated integration branch. You do not have repository tools; the orchestrator will provide the combined diff in bounded chunks.

${citationDuty}

Goal:
${bounded(input.goal, 3_000)}

Constitution:
${bounded(input.constitution, 2_000)}

Task contracts:
${bounded(contracts, 4_000)}

Executed check receipts:
${bounded(input.checkSummary, 3_000)}

${reportsSection}`;
}

/**
 * The claims lens reviews what the implementors SAID, never what they did: it
 * has no repository access and never learns the worktree location, so its
 * judgment cannot be anchored by the artifact — and its extracted manifest is
 * what the divergence gate compares against the real diff.
 */
export function claimsReviewerContextHeader(input: {
  goal: string;
  constitution: string;
  plan: RunPlan;
  checkSummary: string;
  autonomy: RunAutonomy;
}): string {
  return `You are the claims-lens reviewer. You have no repository access and will never see the diff; the orchestrator supplies the implementors' task reports in bounded chunks. Your duties: (1) extract every concrete claim the reports make — files changed, behaviors added or fixed, checks run — and judge whether the claims cohere with each other and with the executed check receipts below; (2) return the file-level claims as a claimedChanges manifest. A report that narrates intent ("I will apply...", "I would edit...") without stating a completed change is a finding, not a claim.

Goal:
${bounded(input.goal, 3_000)}

Constitution:
${bounded(input.constitution, 2_000)}

Task contracts:
${bounded(taskContractLines(input.plan), 4_000)}

Executed check receipts:
${bounded(input.checkSummary, 3_000)}

In your final response, the fenced JSON object must additionally contain a "claimedChanges" array, one entry per file the reports claim was created, modified, or deleted: {"claimedChanges":[{"path":"relative/path","kind":"created|modified|deleted","taskId":"the claiming task"}]}. An empty array is a statement that the reports claim no repository changes at all.`;
}

/**
 * The per-chunk JSON instruction for claims-lens reviews. The chunk runner's
 * default contract names findings alone; if the claims lens relied on it, the
 * last and most literal formatting instruction the model sees would contradict
 * the header's manifest demand and the divergence gate would starve.
 */
export const CLAIMS_CHUNK_JSON_CONTRACT = `Finish with exactly one fenced JSON object shaped as {"findings":[{"id":"stable-short-id","severity":"low|medium|high|critical","location":"path:line or null","rationale":"evidence-backed reason","suggestedCorrection":"bounded correction","disposition":"open"}],"claimedChanges":[{"path":"relative/path","kind":"created|modified|deleted","taskId":"the claiming task"}]}. READY must use an empty findings array. claimedChanges must list every file-level change the supplied reports claim was created, modified, or deleted; an empty array is a statement that the reports claim no repository changes. Every claimedChanges entry requires all three fields exactly: kind must be one of created, modified, or deleted, and taskId must name the claiming task — an entry missing any of them invalidates the whole manifest.`;

/** The claims lens reviews the narration itself, chunked like any other evidence. */
export function claimsReviewChunks(taskReports: string, maxChars = 8_000): Array<{ label: string; content: string }> {
  const content = taskReports.trim() || "No task reports were recorded.";
  const chunks: Array<{ label: string; content: string }> = [];
  for (let start = 0; start < content.length; start += maxChars) {
    chunks.push({ label: `task reports ${chunks.length + 1}`, content: content.slice(start, start + maxChars) });
  }
  return chunks.length ? chunks : [{ label: "task reports 1", content }];
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
