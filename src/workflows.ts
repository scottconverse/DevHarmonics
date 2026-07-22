import { createHash } from "node:crypto";
import { z } from "zod";
import type { ObjectiveInput } from "./types.js";

/**
 * DH-810: a workflow is a versioned, parameterized document stored in Git.
 * Its identity is its content hash — the same content-addressed discipline the
 * ledger already uses for review evidence bindings — so a later edit can never
 * masquerade as the revision a historical run executed. (Plan revisions use
 * per-objective counters with approval flags; the shared property is
 * immutability of the recorded thing, not the identifier scheme.) Parsing
 * fails closed with named issues; there is no partial parse.
 */

const workflowInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  description: z.string().min(1),
});

export const workflowDocumentSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case name"),
  description: z.string().min(1),
  inputs: z.array(workflowInputSchema),
  objective: z.object({
    outcomeTemplate: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    risk: z.enum(["low", "medium", "high"]),
  }),
  evidenceRequirements: z.array(z.string().min(1)).min(1),
  approvalPoints: z.array(z.enum(["plan", "external_write", "spending", "destructive"])),
  completionContract: z.object({
    deliverable: z.string().min(1),
    reviewLenses: z.array(z.enum(["artifact", "claims"])).min(1),
  }),
  permissions: z.object({
    autonomy: z.enum(["observe", "supervised", "bounded"]),
    allowExternalWrites: z.boolean(),
  }),
});

export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;

export type WorkflowParseResult =
  | { ok: true; workflow: WorkflowDocument }
  | { ok: false; issues: string[] };

export function parseWorkflowDocument(text: string): WorkflowParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, issues: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = workflowDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
  }
  const workflow = parsed.data;
  const issues: string[] = [];
  // A workflow may not demand a permission its declared approval points do not
  // gate — a document that grants itself ungated external writes is refused at
  // parse time, not discovered at run time.
  if (workflow.permissions.allowExternalWrites && !workflow.approvalPoints.includes("external_write")) {
    issues.push("permissions.allowExternalWrites requires an external_write approval point");
  }
  // Inputs are named parameters — a duplicate name is ambiguous at
  // instantiation and refused here, not resolved arbitrarily later.
  const names = workflow.inputs.map((input) => input.name);
  for (const name of new Set(names.filter((candidate, index) => names.indexOf(candidate) !== index))) {
    issues.push(`inputs: duplicate input name '${name}'`);
  }
  // Every ${placeholder} in the outcome template must name a declared input —
  // an author's typo surfaces at parse time, never as a silently unexpanded
  // token in a running objective.
  const declared = new Set(names);
  for (const match of workflow.objective.outcomeTemplate.matchAll(/\$\{([^}]*)\}/g)) {
    if (!declared.has(match[1]!)) issues.push(`objective.outcomeTemplate: placeholder '\${${match[1]}}' names no declared input`);
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, workflow };
}

/** Canonical JSON: object keys sorted recursively, so formatting and key order never mint a new revision. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function workflowRevisionHash(workflow: WorkflowDocument): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(workflow))).digest("hex");
}

export interface WorkflowInstantiation {
  ok: true;
  objective: ObjectiveInput;
  revisionHash: string;
}

export type WorkflowInstantiationResult = WorkflowInstantiation | { ok: false; issues: string[] };

/**
 * DH-810 S3: a workflow plus typed inputs becomes an ObjectiveInput for the
 * EXISTING composer path — no second execution engine. Input validation fails
 * closed: missing required inputs, wrong types, and undeclared names are all
 * refused with named issues before anything is built. The produced objective
 * carries the workflow revision hash in its policy notes so the run that
 * eventually starts from it can pin the exact revision executed.
 */
export function instantiateWorkflow(input: {
  workflow: WorkflowDocument;
  inputs: Record<string, unknown>;
  projectPath: string;
  repositoryIds: string[];
  productId?: string;
  priority?: "low" | "normal" | "high" | "urgent";
}): WorkflowInstantiationResult {
  const issues: string[] = [];
  const declared = new Map(input.workflow.inputs.map((item) => [item.name, item]));
  for (const item of input.workflow.inputs) {
    const value = input.inputs[item.name];
    if (value === undefined || value === null) {
      if (item.required) issues.push(`inputs.${item.name}: required and missing`);
      continue;
    }
    if (typeof value !== item.type) issues.push(`inputs.${item.name}: expected ${item.type}, received ${typeof value}`);
  }
  for (const name of Object.keys(input.inputs)) {
    if (!declared.has(name)) issues.push(`inputs.${name}: not declared by workflow '${input.workflow.name}'`);
  }
  if (issues.length) return { ok: false, issues };

  const revisionHash = workflowRevisionHash(input.workflow);
  const outcome = input.workflow.objective.outcomeTemplate.replace(/\$\{([^}]*)\}/g, (_, name: string) => String(input.inputs[name] ?? ""));
  return {
    ok: true,
    revisionHash,
    objective: {
      outcome,
      acceptanceCriteria: [...input.workflow.objective.acceptanceCriteria],
      constraints: [],
      projectPath: input.projectPath,
      ...(input.productId ? { productId: input.productId } : {}),
      repositoryIds: [...input.repositoryIds],
      risk: input.workflow.objective.risk,
      autonomy: input.workflow.permissions.autonomy,
      priority: input.priority ?? "normal",
      policyNotes: [
        `Workflow: ${input.workflow.name} @ revision ${revisionHash.slice(0, 12)}`,
        ...input.workflow.evidenceRequirements.map((requirement) => `Required evidence: ${requirement}`),
        `Completion contract: ${input.workflow.completionContract.deliverable} (review lenses: ${input.workflow.completionContract.reviewLenses.join(", ")})`,
      ],
    },
  };
}
