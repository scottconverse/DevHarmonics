import { z } from "zod";

const providerSchema = z.enum(["codex", "claude", "gemini"]);

export const runPlanSchema = z
  .object({
    summary: z.string().min(1),
    recommendedConcurrency: z.number().int().positive(),
    revision: z.number().int().positive().default(1),
    previousRevision: z.number().int().positive().nullable().default(null),
    tasks: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
          title: z.string().min(1),
          description: z.string().min(1),
          dependencies: z.array(z.string()),
          preferredProvider: providerSchema.nullable(),
          checks: z.array(z.string()).min(1),
          kind: z.enum(["diagnostic", "implementation", "repair", "review", "release"]).default("implementation"),
          repositoryScope: z.array(z.string().min(1)).default(["."]),
          permission: z.enum(["read_only", "workspace_write"]).default("workspace_write"),
          risk: z.enum(["low", "medium", "high"]).default("medium"),
          capabilityNeeds: z.array(z.string().min(1)).default(["code"]),
          acceptanceCriteria: z.array(z.string().min(1)).default([]),
          expectedArtifacts: z.array(z.string().min(1)).default([]),
        }),
      )
      .min(1),
  })
  .superRefine((plan, context) => {
    const ids = new Set(plan.tasks.map((task) => task.id));
    if (ids.size !== plan.tasks.length) {
      context.addIssue({ code: "custom", message: "Task IDs must be unique" });
    }
    for (const task of plan.tasks) {
      for (const dependency of task.dependencies) {
        if (!ids.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `Task ${task.id} references missing dependency ${dependency}`,
          });
        }
        if (dependency === task.id) {
          context.addIssue({
            code: "custom",
            message: `Task ${task.id} cannot depend on itself`,
          });
        }
      }
    }
  });

export const objectiveInputSchema = z.object({
  outcome: z.string().trim().min(1).max(20_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(200),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(200),
  projectPath: z.string().trim().min(1).max(4_096),
  productId: z.string().trim().min(1).max(200).optional(),
  repositoryIds: z.array(z.string().trim().min(1).max(300)).max(500),
  risk: z.enum(["low", "medium", "high"]),
  autonomy: z.enum(["observe", "supervised", "bounded"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  deadline: z.string().datetime({ offset: true }).optional(),
  policyNotes: z.array(z.string().trim().min(1).max(2_000)).max(200),
});

export const planRevisionInputSchema = z.object({
  plan: runPlanSchema,
  rationale: z.string().trim().min(1).max(10_000),
});

export const workbenchSessionInputSchema = z.object({
  projectPath: z.string().trim().min(1).max(4_096),
  title: z.string().trim().min(1).max(500),
});

export const workbenchMessageInputSchema = z.object({
  sessionId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().trim().max(100_000),
  provider: z.string().trim().min(1).max(200).nullable().optional(),
  connectionId: z.string().trim().min(1).max(300).nullable().optional(),
  requestedModelId: z.string().trim().min(1).max(300).nullable().optional(),
  resolvedModelId: z.string().trim().min(1).max(300).nullable().optional(),
  status: z.enum(["complete", "failed"]).nullable().optional(),
  error: z.string().trim().max(20_000).nullable().optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
}).superRefine((message, context) => {
  if (message.role === "assistant") {
    if (!message.provider) context.addIssue({ code: "custom", path: ["provider"], message: "Assistant consultations require a provider" });
    if (!message.status) context.addIssue({ code: "custom", path: ["status"], message: "Assistant consultations require a terminal status" });
    if (message.status === "complete" && !message.resolvedModelId) context.addIssue({ code: "custom", path: ["resolvedModelId"], message: "Completed consultations require the resolved model ID" });
    if (message.status === "failed" && !message.requestedModelId && !message.resolvedModelId) context.addIssue({ code: "custom", path: ["requestedModelId"], message: "Failed consultations require a requested or resolved model ID" });
    if (message.status === "failed" && !message.error) context.addIssue({ code: "custom", path: ["error"], message: "Failed consultations require an error" });
  } else {
    const attributed = message.provider || message.connectionId || message.requestedModelId || message.resolvedModelId
      || message.status || message.error || message.inputTokens != null || message.outputTokens != null
      || message.costUsd != null || message.durationMs != null;
    if (attributed) context.addIssue({ code: "custom", message: "Only assistant consultations may carry model execution attribution" });
    if (!message.content) context.addIssue({ code: "custom", path: ["content"], message: "User and system messages require content" });
  }
});

export const providerConfigSchema = z.object({
  enabled: z.boolean(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});

export const manualModelSchema = z
  .object({
    id: z.string().min(1).max(200),
    connectionId: z.string().min(1).max(200),
    canonicalName: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    lifecycle: z.enum([
      "known",
      "visible",
      "verified",
      "qualified",
      "active",
      "degraded",
      "retired",
    ]).default("known"),
    visible: z.boolean().default(false),
    verified: z.boolean().default(false),
    qualified: z.boolean().default(false),
    active: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((model, context) => {
    if (model.verified && !model.visible) {
      context.addIssue({ code: "custom", message: "A verified model must also be visible" });
    }
    if (model.qualified && !model.verified) {
      context.addIssue({ code: "custom", message: "A qualified model must also be verified" });
    }
    if (model.active && !model.qualified) {
      context.addIssue({ code: "custom", message: "An active model must also be qualified" });
    }
    if (model.lifecycle === "retired" && model.active) {
      context.addIssue({ code: "custom", message: "A retired model cannot be active" });
    }
  });

export const productRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/i).max(200),
  name: z.string().min(1).max(200),
  organizationUrl: z.string().url().max(500),
  description: z.string().max(2_000).default(""),
  repositories: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9:._\/-]*$/i).max(300),
    name: z.string().min(1).max(200),
    fullName: z.string().regex(/^[^/]+\/[^/]+$/).max(300),
    url: z.string().url().max(500),
    cloneUrl: z.string().url().max(500),
    defaultBranch: z.string().min(1).max(200),
    visibility: z.enum(["public", "private", "internal", "unknown"]),
    archived: z.boolean(),
    sizeKb: z.number().int().nonnegative(),
    language: z.string().max(100).nullable().default(null),
    description: z.string().max(2_000).nullable().default(null),
    intelligence: z.record(z.string(), z.unknown()).default({}),
  })).max(500),
});

export const repositoryRoleSchema = z.enum([
  "umbrella",
  "shared_platform",
  "module",
  "desktop",
  "installer",
  "documentation",
  "release_truth",
  "other",
]);

const repositoryValidatorSchema = z.object({
  command: z.string().min(1).max(1_000),
  args: z.array(z.string().max(2_000)).max(100),
  timeoutMs: z.number().int().positive().max(3_600_000),
  cwd: z.string().min(1).max(2_000).optional(),
});

export const repositoryUpsertSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9:._\/-]*$/i).max(300),
  productId: z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/i).max(200),
  name: z.string().min(1).max(200),
  fullName: z.string().regex(/^[^/]+\/[^/]+$/).max(300),
  url: z.string().url().max(500),
  cloneUrl: z.string().min(1).max(500),
  defaultBranch: z.string().min(1).max(200),
  visibility: z.enum(["public", "private", "internal", "unknown"]),
  archived: z.boolean(),
  sizeKb: z.number().int().nonnegative(),
  language: z.string().max(100).nullable().default(null),
  description: z.string().max(2_000).nullable().default(null),
  intelligence: z.record(z.string(), z.unknown()).default({}),
  localPath: z.string().min(1).max(2_000).nullable().default(null),
  role: repositoryRoleSchema.default("other"),
  expectedBranch: z.string().min(1).max(200).nullable().default(null),
  owners: z.array(z.string().min(1).max(200)).max(100).default([]),
  dependencyRepositoryIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9:._\/-]*$/i).max(300)).max(500).default([]),
  validators: z.record(z.string().min(1).max(100), repositoryValidatorSchema).default({}),
  governanceSources: z.array(z.string().min(1).max(2_000)).max(100).default([]),
  governanceRules: z.array(z.string().min(1).max(2_000)).max(500).default([]),
});

export const repositoryInspectionSchema = z.object({
  currentBranch: z.string().min(1).max(500).nullable(),
  headSha: z.string().regex(/^[a-f0-9]{7,64}$/i).nullable(),
  remoteUrl: z.string().min(1).max(2_000).nullable(),
  dirty: z.boolean(),
  compatibilityIssues: z.array(z.string().min(1).max(2_000)).max(500).default([]),
  checkedAt: z.string().datetime({ offset: true }).optional(),
});

const concurrencySchema = z.object({
  mode: z.enum(["auto", "manual"]),
  agents: z.number().int().positive(),
  ceiling: z.number().int().positive().nullable(),
});

const retrySchema = z.object({
  maxAttempts: z.number().int().positive(),
  backoffMs: z.number().int().nonnegative(),
});

const validatorsSchema = z.record(
  z.string(),
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    timeoutMs: z.number().int().positive(),
    cwd: z.string().optional(),
  }),
);

export const legacyDevHarmonicsConfigSchema = z.object({
  version: z.literal(1),
  architect: providerSchema,
  reviewer: providerSchema,
  workers: z.array(providerSchema).min(1),
  concurrency: concurrencySchema,
  retry: retrySchema,
  providers: z.object({
    codex: providerConfigSchema,
    claude: providerConfigSchema,
    gemini: providerConfigSchema,
  }),
  validators: validatorsSchema,
});

export const devHarmonicsConfigSchema = z.object({
  version: z.literal(2),
  application: z.object({
    concurrency: concurrencySchema,
    retry: retrySchema,
  }),
  connections: z.object({
    codex: providerConfigSchema,
    claude: providerConfigSchema,
    gemini: providerConfigSchema,
  }),
  localRuntimes: z.object({
    ollama: z.array(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i).max(80),
      displayName: z.string().min(1).max(120),
      baseUrl: z.string().url().refine((value) => {
        const hostname = new URL(value).hostname;
        return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
      }, "Remote Ollama endpoints require an explicit future policy"),
      enabled: z.boolean(),
    })).max(16),
  }).default({
    ollama: [{ id: "system", displayName: "System Ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }],
  }),
  openRouter: z.object({
    enabled: z.boolean(),
    allowPaidFallback: z.boolean(),
    perRunLimitUsd: z.number().nonnegative().max(10_000),
    monthlyLimitUsd: z.number().nonnegative().max(100_000),
  }).default({
    enabled: false,
    allowPaidFallback: false,
    perRunLimitUsd: 0,
    monthlyLimitUsd: 0,
  }),
  product: z.object({
    architect: providerSchema,
    reviewer: providerSchema,
    workers: z.array(providerSchema).min(1),
  }),
  repository: z.object({
    validators: validatorsSchema,
  }),
  runPolicy: z.object({
    autonomy: z.enum(["observe", "supervised", "bounded"]),
    requirePlanApproval: z.boolean(),
    allowPaidApi: z.boolean(),
    allowExternalWrites: z.boolean(),
  }),
  reviewPolicy: z.object({
    reviewerCountByRisk: z.object({ low: z.number().int().min(1).max(8), medium: z.number().int().min(1).max(8), high: z.number().int().min(1).max(8) }),
    minimumDistinctProvidersByRisk: z.object({ low: z.number().int().min(1).max(4), medium: z.number().int().min(1).max(4), high: z.number().int().min(1).max(4) }),
    requireImplementorIndependenceByRisk: z.object({ low: z.boolean(), medium: z.boolean(), high: z.boolean() }),
    maxFixRounds: z.number().int().min(0).max(5),
  }).default({
    reviewerCountByRisk: { low: 1, medium: 1, high: 2 },
    minimumDistinctProvidersByRisk: { low: 1, medium: 1, high: 2 },
    requireImplementorIndependenceByRisk: { low: false, medium: true, high: true },
    maxFixRounds: 2,
  }),
  routing: z.object({
    mode: z.enum(["adaptive", "manual"]).default("adaptive"),
    architect: roleRoutingSchema(),
    worker: roleRoutingSchema(),
    reviewer: roleRoutingSchema(),
    allowFallback: z.boolean(),
  }).default({
    mode: "adaptive",
    architect: { modelId: null, effort: "high", preferredTier: "auto", upgradePolicy: "pinned" },
    worker: { modelId: null, effort: "high", preferredTier: "auto", upgradePolicy: "pinned" },
    reviewer: { modelId: null, effort: "high", preferredTier: "auto", upgradePolicy: "pinned" },
    allowFallback: true,
  }),
});

function roleRoutingSchema() {
  return z.object({
    modelId: z.string().min(1).nullable(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    preferredTier: z.enum(["auto", "economy", "standard", "premium"]).default("auto"),
    upgradePolicy: z.enum(["pinned", "track_family"]).default("pinned"),
  });
}

export const architectOutputJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    recommendedConcurrency: { type: "integer", minimum: 1 },
    revision: { type: "integer", minimum: 1 },
    previousRevision: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
          title: { type: "string" },
          description: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } },
          preferredProvider: {
            anyOf: [
              { type: "string", enum: ["codex", "claude", "gemini"] },
              { type: "null" },
            ],
          },
          checks: { type: "array", items: { type: "string" } },
          kind: { type: "string", enum: ["diagnostic", "implementation", "repair", "review", "release"] },
          repositoryScope: { type: "array", items: { type: "string" } },
          permission: { type: "string", enum: ["read_only", "workspace_write"] },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          capabilityNeeds: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          expectedArtifacts: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "title",
          "description",
          "dependencies",
          "preferredProvider",
          "checks",
          "kind",
          "repositoryScope",
          "permission",
          "risk",
          "capabilityNeeds",
          "acceptanceCriteria",
          "expectedArtifacts",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "recommendedConcurrency", "revision", "previousRevision", "tasks"],
  additionalProperties: false,
} as const;
