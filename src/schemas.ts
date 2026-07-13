import { z } from "zod";

const providerSchema = z.enum(["codex", "claude", "gemini"]);

export const runPlanSchema = z
  .object({
    summary: z.string().min(1),
    recommendedConcurrency: z.number().int().positive(),
    tasks: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
          title: z.string().min(1),
          description: z.string().min(1),
          dependencies: z.array(z.string()),
          preferredProvider: providerSchema.nullable(),
          checks: z.array(z.string()).min(1),
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

export const providerConfigSchema = z.object({
  enabled: z.boolean(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});

export const ringerConfigSchema = z.object({
  version: z.literal(1),
  architect: providerSchema,
  reviewer: providerSchema,
  workers: z.array(providerSchema).min(1),
  concurrency: z.object({
    mode: z.enum(["auto", "manual"]),
    agents: z.number().int().positive(),
    ceiling: z.number().int().positive().nullable(),
  }),
  retry: z.object({
    maxAttempts: z.number().int().positive(),
    backoffMs: z.number().int().nonnegative(),
  }),
  providers: z.object({
    codex: providerConfigSchema,
    claude: providerConfigSchema,
    gemini: providerConfigSchema,
  }),
  validators: z.record(
    z.string(),
    z.object({
      command: z.string().min(1),
      args: z.array(z.string()),
      timeoutMs: z.number().int().positive(),
      cwd: z.string().optional(),
    }),
  ),
});

export const architectOutputJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    recommendedConcurrency: { type: "integer", minimum: 1 },
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
        },
        required: [
          "id",
          "title",
          "description",
          "dependencies",
          "preferredProvider",
          "checks",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "recommendedConcurrency", "tasks"],
  additionalProperties: false,
} as const;
