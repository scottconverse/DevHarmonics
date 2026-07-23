import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectLegacyProvider } from "./compatibility.js";
import type { AgentResultEnvelope } from "./agents.js";
import {
  assertRunTransition,
  assertTaskTransition,
  parseRunEventKind,
  parseRunStatus,
  parseTaskStatus,
  type RunEvent,
  type RunEventData,
  type RunEventKind,
  type RunStatus,
} from "./domain.js";
import { redactText, redactValue } from "./redaction.js";
import { workflowRevisionHash, type WorkflowDocument } from "./workflows.js";
import {
  objectiveInputSchema,
  planRevisionInputSchema,
  repositoryInspectionSchema,
  repositoryUpsertSchema,
  workbenchMessageInputSchema,
  workbenchSessionInputSchema,
} from "./schemas.js";
import type { ReviewFinding, StructuredReview } from "./review.js";
import type { ProductIntelligenceSnapshot } from "./product-intelligence.js";
import { aggregateModelPerformance, type ModelPerformanceObservation, type ModelPerformanceProfile } from "./model-performance.js";
import { classifyWorkload } from "./model-intelligence.js";
import {
  MODEL_LIFECYCLES,
  type ConnectionRecord,
  type ConnectionRegistryInput,
  type ManualModelInput,
  type ModelDiscoveryInput,
  type ModelRecord,
  type ModelQualificationRecord,
} from "./registry.js";
import type {
  CheckResult,
  DeliveryHandoffRecord,
  DeliveryRepositoryRecord,
  DeliveryRepositoryStatus,
  IntegrationRepositoryStatus,
  IntegrationSetRecord,
  IntegrationSetStatus,
  ObjectiveInput,
  ObjectiveRecord,
  PlanRevisionRecord,
  PlannedTask,
  ProviderName,
  RunAutonomy,
  RunPlan,
  RunObjectiveLink,
  RunSummary,
  SteeringDirectiveKind,
  SteeringDirectiveRecord,
  SteeringDisposition,
  SteeringPayload,
  TaskStatus,
  ValidatorConfig,
  WorkbenchMessageInput,
  WorkbenchMessageRecord,
  WorkbenchSessionInput,
  WorkbenchSessionRecord,
} from "./types.js";
import { modelQuotaGroup, quotaResetAt } from "./antigravity.js";

interface RunRow {
  id: string;
  goal: string;
  project_path: string;
  status: string;
  created_at: string;
  updated_at: string;
  final_review: string | null;
  resumed_from: string | null;
  autonomy: string;
  objective_id: string | null;
  approved_plan_revision: number | null;
  workflow_revision_hash: string | null;
  plan_json: string | null;
}

interface TaskRow {
  task_id: string;
  title: string;
  description: string;
  task_contract_json: string;
  status: string;
  provider: string | null;
  attempt_count: number;
}

interface EventRow {
  id: number;
  run_id: string;
  kind: string;
  message: string;
  data_json: string;
  created_at: string;
}

function healthState(failureKind: string): ConnectionHealthRecord["state"] {
  if (failureKind === "quota_exhausted" || failureKind === "quota_group_exhausted") return "quota_exhausted";
  if (failureKind === "rate_limited") return "rate_limited";
  if (failureKind === "authentication") return "authentication";
  if (failureKind === "incompatible") return "degraded";
  return "cooling";
}

function healthCooldownMs(failureKind: string, failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 8));
  if (failureKind === "authentication") return 0;
  if (failureKind === "quota_exhausted" || failureKind === "quota_group_exhausted") return Math.min(5 * 60 * 60_000, 15 * 60_000 * 2 ** exponent);
  if (failureKind === "rate_limited") return Math.min(30 * 60_000, 60_000 * 2 ** exponent);
  if (failureKind === "incompatible") return 30 * 60_000;
  return Math.min(10 * 60_000, 30_000 * 2 ** exponent);
}

function mapConnectionHealth(row: Record<string, unknown>): ConnectionHealthRecord {
  return {
    connectionId: String(row.connection_id),
    state: String(row.state) as ConnectionHealthRecord["state"],
    failureKind: row.failure_kind === null ? null : String(row.failure_kind),
    consecutiveFailures: Number(row.consecutive_failures),
    cooldownUntil: row.cooldown_until === null ? null : String(row.cooldown_until),
    detail: String(row.detail),
    lastCheckedAt: String(row.last_checked_at),
  };
}

function mapModelHealth(row: Record<string, unknown>): ModelHealthRecord {
  return {
    modelId: String(row.model_id),
    state: String(row.state) as ModelHealthRecord["state"],
    failureKind: row.failure_kind === null ? null : String(row.failure_kind),
    consecutiveFailures: Number(row.consecutive_failures),
    cooldownUntil: row.cooldown_until === null ? null : String(row.cooldown_until),
    detail: String(row.detail),
    lastCheckedAt: String(row.last_checked_at),
  };
}

function mapQuotaGroupHealth(row: Record<string, unknown>): QuotaGroupHealthRecord {
  return {
    connectionId: String(row.connection_id),
    quotaGroupId: String(row.quota_group_id),
    displayName: String(row.display_name),
    state: String(row.state) as QuotaGroupHealthRecord["state"],
    failureKind: row.failure_kind === null ? null : String(row.failure_kind),
    consecutiveFailures: Number(row.consecutive_failures),
    cooldownUntil: row.cooldown_until === null ? null : String(row.cooldown_until),
    detail: String(row.detail),
    lastCheckedAt: String(row.last_checked_at),
  };
}

function isSubscriptionProvider(value: string): value is ProviderName {
  return value === "codex" || value === "claude" || value === "gemini";
}

interface CheckRow {
  task_id: string;
  name: string;
  passed: number;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export const LEDGER_SCHEMA_VERSION = 34;

export const REPOSITORY_ROLES = [
  "umbrella",
  "shared_platform",
  "module",
  "desktop",
  "installer",
  "documentation",
  "release_truth",
  "other",
] as const;

export type RepositoryRole = (typeof REPOSITORY_ROLES)[number];

export interface RepositoryInspectionInput {
  currentBranch: string | null;
  headSha: string | null;
  remoteUrl: string | null;
  dirty: boolean;
  compatibilityIssues: string[];
  checkedAt?: string;
}

export interface RepositoryInspectionRecord extends Omit<RepositoryInspectionInput, "checkedAt"> {
  checkedAt: string;
}

export interface RepositoryUpsertInput {
  id: string;
  productId: string;
  name: string;
  fullName: string;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  visibility: "public" | "private" | "internal" | "unknown";
  archived: boolean;
  sizeKb: number;
  language: string | null;
  description: string | null;
  intelligence: Record<string, unknown>;
  localPath: string | null;
  role: RepositoryRole;
  expectedBranch: string | null;
  owners: string[];
  dependencyRepositoryIds: string[];
  validators: Record<string, ValidatorConfig>;
  governanceSources: string[];
  governanceRules: string[];
}

export interface RepositoryRecord {
  id: string;
  productId: string;
  name: string;
  fullName: string;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  visibility: RepositoryUpsertInput["visibility"];
  archived: boolean;
  sizeKb: number;
  language: string | null;
  description: string | null;
  intelligence: Record<string, unknown>;
  localPath: string | null;
  role: RepositoryRole;
  expectedBranch: string | null;
  owners: string[];
  dependencyRepositoryIds: string[];
  validators: Record<string, ValidatorConfig>;
  governanceSources: string[];
  governanceRules: string[];
  inspection: RepositoryInspectionRecord | null;
  observedAt: string;
}

export interface ProductRecord {
  id: string;
  name: string;
  organizationUrl: string;
  description: string;
  repositories: RepositoryRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductRegistration extends Omit<ProductRecord, "repositories" | "createdAt" | "updatedAt"> {
  repositories: Array<Pick<RepositoryRecord,
    "id" | "name" | "fullName" | "url" | "cloneUrl" | "defaultBranch" | "visibility" |
    "archived" | "sizeKb" | "language" | "description" | "intelligence"
  >>;
}

function sanitizedRemoteUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return redactText(value);
  }
}

function repositoryRecordFromRow(row: Record<string, unknown>): RepositoryRecord {
  const checkedAt = row.checked_at === null ? null : String(row.checked_at);
  return {
    id: String(row.id),
    productId: String(row.product_id),
    name: String(row.name),
    fullName: String(row.full_name),
    url: String(row.url),
    cloneUrl: String(row.clone_url),
    defaultBranch: String(row.default_branch),
    visibility: String(row.visibility) as RepositoryRecord["visibility"],
    archived: Boolean(row.archived),
    sizeKb: Number(row.size_kb),
    language: row.language === null ? null : String(row.language),
    description: row.description === null ? null : String(row.description),
    intelligence: JSON.parse(String(row.intelligence_json)) as Record<string, unknown>,
    localPath: row.local_path === null ? null : String(row.local_path),
    role: String(row.repository_role) as RepositoryRole,
    expectedBranch: row.expected_branch === null ? null : String(row.expected_branch),
    owners: JSON.parse(String(row.owners_json)) as string[],
    dependencyRepositoryIds: JSON.parse(String(row.dependency_repository_ids_json)) as string[],
    validators: JSON.parse(String(row.validators_json)) as Record<string, ValidatorConfig>,
    governanceSources: JSON.parse(String(row.governance_sources_json)) as string[],
    governanceRules: JSON.parse(String(row.governance_rules_json)) as string[],
    inspection: checkedAt === null ? null : {
      currentBranch: row.current_branch === null ? null : String(row.current_branch),
      headSha: row.head_sha === null ? null : String(row.head_sha),
      remoteUrl: row.remote_url === null ? null : String(row.remote_url),
      dirty: Boolean(row.dirty),
      compatibilityIssues: JSON.parse(String(row.compatibility_issues_json)) as string[],
      checkedAt,
    },
    observedAt: String(row.observed_at),
  };
}

export interface ConnectionHealthRecord {
  connectionId: string;
  state: "ready" | "degraded" | "cooling" | "quota_exhausted" | "rate_limited" | "authentication" | "unavailable";
  failureKind: string | null;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  detail: string;
  lastCheckedAt: string;
}

export interface ModelHealthRecord {
  modelId: string;
  state: ConnectionHealthRecord["state"];
  failureKind: string | null;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  detail: string;
  lastCheckedAt: string;
}

export interface QuotaGroupHealthRecord {
  connectionId: string;
  quotaGroupId: string;
  displayName: string;
  state: ConnectionHealthRecord["state"];
  failureKind: string | null;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  detail: string;
  lastCheckedAt: string;
}

export interface AttemptRuntimeContext {
  connectionId: string;
  requestedModelId: string | null;
  modelSettings: Readonly<Record<string, string | number | boolean>>;
  adapterVersion: string;
  runtimeVersion: string | null;
}

export interface AttemptCompletionReceipt {
  modelId?: string | null;
  modelResolution?: string | null;
  failureKind?: string | null;
  resultEnvelope?: AgentResultEnvelope | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  fallbackReason?: string | null;
}

export interface CatalogRefreshRecord {
  provider: string;
  status: "success" | "failed";
  source: string;
  modelCount: number;
  detail: string;
  refreshedAt: string;
}

export interface ProviderCatalogModelRecord {
  id: string;
  provider: string;
  canonicalName: string;
  displayName: string;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  missingObservations: number;
  retired: boolean;
}

export interface InvocationReceiptInput {
  runId: string;
  taskId?: string | null;
  role: string;
  provider: string;
  connectionId: string;
  requestedModelId?: string | null;
  resolvedModelId: string;
  modelResolution?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  workloadClass?: string | null;
  fallbackReason?: string | null;
  paidSpendReservationId?: string | null;
}

export interface PaidSpendReservationInput {
  scopeType: "run" | "workbench";
  scopeId: string;
  estimatedCostUsd: number;
  perScopeLimitUsd: number;
  monthlyLimitUsd: number;
  expectedReceiptCount?: number;
}

export interface ToolPolicyReceiptInput {
  runId: string;
  taskId?: string | null;
  attemptId?: number | null;
  toolId: string;
  actorRole: string;
  stage: string;
  sideEffect: string;
  outcome: "allow" | "deny" | "require_approval";
  reason: string;
  request: Readonly<Record<string, unknown>>;
  lockKeys: readonly string[];
  approvalId?: string | null;
}

export interface ToolPolicyReceiptRecord {
  id: number;
  runId: string;
  taskId: string | null;
  attemptId: number | null;
  toolId: string;
  actorRole: string;
  stage: string;
  sideEffect: string;
  outcome: ToolPolicyReceiptInput["outcome"];
  reason: string;
  request: Record<string, unknown>;
  lockKeys: string[];
  approvalId: string | null;
  createdAt: string;
}

export interface BlackboardEntry {
  id: number;
  runId: string;
  taskId: string | null;
  kind: "decision" | "assumption" | "finding" | "risk" | "handoff" | "question";
  content: string;
  sourceAttemptId: number | null;
  createdAt: string;
}

export interface ReviewReceiptRecord {
  id: number;
  runId: string;
  round: number;
  integrationSha256: string;
  evidenceBinding: ReviewEvidenceBinding;
  verdict: StructuredReview["verdict"];
  provider: string;
  modelId: string | null;
  connectionId: string;
  lens: StructuredReview["lens"];
  summary: string;
  rawText: string;
  findings: ReviewFinding[];
  invalidatedAt: string | null;
  invalidationReason: string | null;
  createdAt: string;
}

export interface ReviewEvidenceBinding {
  version: 1;
  autonomy: string;
  planSha256: string;
  taskReportsSha256: string;
  diffSha256: string;
  checksSha256: string;
  repositories: Array<{
    repositoryId: string;
    baseCommit: string;
    headCommit: string;
  }>;
}

export interface RunEvidencePackage {
  version: 5;
  generatedAt: string;
  run: RunSummary;
  attempts: Array<Record<string, unknown>>;
  blackboard: BlackboardEntry[];
  toolReceipts: ToolPolicyReceiptRecord[];
  reviews: ReviewReceiptRecord[];
  integrationSet: IntegrationSetRecord | null;
  delivery: DeliveryHandoffRecord | null;
  integritySha256: string;
}

interface LedgerMigration {
  version: number;
  name: string;
  apply(database: DatabaseSync): void;
}

const INITIAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    project_path TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_json TEXT,
    final_review TEXT,
    autonomy TEXT NOT NULL DEFAULT 'supervised',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    status TEXT NOT NULL,
    preferred_provider TEXT,
    provider TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    name TEXT NOT NULL,
    passed INTEGER NOT NULL,
    exit_code INTEGER NOT NULL,
    stdout TEXT NOT NULL,
    stderr TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

const MIGRATIONS: readonly LedgerMigration[] = [
  {
    version: 1,
    name: "baseline-v0.1-schema",
    apply(database) {
      database.exec(INITIAL_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: "typed-event-payloads",
    apply(database) {
      const columns = database
        .prepare("SELECT name FROM pragma_table_info('events')")
        .all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "data_json")) {
        database.exec("ALTER TABLE events ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}';");
      }
    },
  },
  {
    version: 3,
    name: "attempt-runtime-receipts",
    apply(database) {
      const columns = new Set(
        (database
          .prepare("SELECT name FROM pragma_table_info('attempts')")
          .all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      const additions: Readonly<Record<string, string>> = {
        connection_id: "TEXT",
        model_id: "TEXT",
        model_resolution: "TEXT",
        model_settings_json: "TEXT NOT NULL DEFAULT '{}'",
        adapter_version: "TEXT",
        runtime_version: "TEXT",
        failure_kind: "TEXT",
      };
      for (const [column, declaration] of Object.entries(additions)) {
        if (!columns.has(column)) {
          database.exec(`ALTER TABLE attempts ADD COLUMN ${column} ${declaration};`);
        }
      }
    },
  },
  {
    version: 4,
    name: "connection-and-model-registry",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS provider_connections (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          transport TEXT NOT NULL,
          authentication TEXT NOT NULL,
          display_name TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          installed INTEGER NOT NULL,
          authenticated INTEGER NOT NULL,
          visible INTEGER NOT NULL,
          healthy INTEGER NOT NULL,
          available INTEGER NOT NULL,
          entitlement TEXT NOT NULL,
          capacity TEXT NOT NULL,
          adapter_version TEXT NOT NULL,
          runtime_version TEXT,
          metadata_json TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS models (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
          canonical_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          source TEXT NOT NULL,
          lifecycle TEXT NOT NULL,
          visible INTEGER NOT NULL,
          verified INTEGER NOT NULL,
          qualified INTEGER NOT NULL,
          active INTEGER NOT NULL,
          degraded INTEGER NOT NULL,
          retired INTEGER NOT NULL,
          metadata_json TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_verified_at TEXT,
          UNIQUE (connection_id, canonical_name)
        );
      `);
    },
  },
  {
    version: 5,
    name: "durable-run-recovery-links",
    apply(database) {
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('runs')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("resumed_from")) {
        database.exec("ALTER TABLE runs ADD COLUMN resumed_from TEXT REFERENCES runs(id);");
      }
    },
  },
  {
    version: 6,
    name: "model-qualification-and-preferences",
    apply(database) {
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('models')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("pinned")) database.exec("ALTER TABLE models ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;");
      if (!columns.has("excluded")) database.exec("ALTER TABLE models ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_qualifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
          fixture_version TEXT NOT NULL,
          role TEXT NOT NULL,
          passed INTEGER NOT NULL,
          score REAL NOT NULL,
          evidence_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 7,
    name: "connection-health-and-cooldowns",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS connection_health (
          connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
          state TEXT NOT NULL,
          failure_kind TEXT,
          consecutive_failures INTEGER NOT NULL,
          cooldown_until TEXT,
          detail TEXT NOT NULL,
          last_checked_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: "blackboard-and-result-envelopes",
    apply(database) {
      const columns = new Set((database.prepare("SELECT name FROM pragma_table_info('attempts')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has("result_envelope_json")) database.exec("ALTER TABLE attempts ADD COLUMN result_envelope_json TEXT;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS blackboard_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          task_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          source_attempt_id INTEGER REFERENCES attempts(id),
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 9,
    name: "product-and-repository-registry",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          organization_url TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS repositories (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          full_name TEXT NOT NULL UNIQUE,
          url TEXT NOT NULL,
          clone_url TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          visibility TEXT NOT NULL,
          archived INTEGER NOT NULL,
          size_kb INTEGER NOT NULL,
          language TEXT,
          description TEXT,
          intelligence_json TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS repositories_product_id ON repositories(product_id);
      `);
    },
  },
  {
    version: 10,
    name: "durable-task-contracts",
    apply(database) {
      const columns = new Set((database.prepare("SELECT name FROM pragma_table_info('tasks')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has("task_contract_json")) database.exec("ALTER TABLE tasks ADD COLUMN task_contract_json TEXT NOT NULL DEFAULT '{}';");
    },
  },
  {
    version: 11,
    name: "model-health-and-cooldowns",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_health (
          model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
          state TEXT NOT NULL,
          failure_kind TEXT,
          consecutive_failures INTEGER NOT NULL,
          cooldown_until TEXT,
          detail TEXT NOT NULL,
          last_checked_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 12,
    name: "catalog-freshness-qualification-fingerprints-and-costs",
    apply(database) {
      const modelColumns = new Set((database.prepare("SELECT name FROM pragma_table_info('models')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      const modelAdditions: Readonly<Record<string, string>> = {
        qualification_fingerprint: "TEXT",
        qualification_stale: "INTEGER NOT NULL DEFAULT 0",
        missing_observations: "INTEGER NOT NULL DEFAULT 0",
        upgrade_policy: "TEXT NOT NULL DEFAULT 'pinned'",
      };
      for (const [column, declaration] of Object.entries(modelAdditions)) {
        if (!modelColumns.has(column)) database.exec(`ALTER TABLE models ADD COLUMN ${column} ${declaration};`);
      }
      const qualificationColumns = new Set((database.prepare("SELECT name FROM pragma_table_info('model_qualifications')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!qualificationColumns.has("fingerprint")) database.exec("ALTER TABLE model_qualifications ADD COLUMN fingerprint TEXT;");
      const attemptColumns = new Set((database.prepare("SELECT name FROM pragma_table_info('attempts')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      const attemptAdditions: Readonly<Record<string, string>> = {
        input_tokens: "INTEGER",
        output_tokens: "INTEGER",
        cost_usd: "REAL",
        fallback_reason: "TEXT",
      };
      for (const [column, declaration] of Object.entries(attemptAdditions)) {
        if (!attemptColumns.has(column)) database.exec(`ALTER TABLE attempts ADD COLUMN ${column} ${declaration};`);
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS catalog_refreshes (
          provider TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          model_count INTEGER NOT NULL,
          detail TEXT NOT NULL,
          refreshed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_catalog_models (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          canonical_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          missing_observations INTEGER NOT NULL DEFAULT 0,
          retired INTEGER NOT NULL DEFAULT 0,
          UNIQUE(provider, canonical_name)
        );
        CREATE INDEX IF NOT EXISTS provider_catalog_models_provider ON provider_catalog_models(provider, retired, display_name);
        CREATE TABLE IF NOT EXISTS invocation_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          task_id TEXT,
          role TEXT NOT NULL,
          provider TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          requested_model_id TEXT,
          resolved_model_id TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL,
          fallback_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS invocation_receipts_run ON invocation_receipts(run_id, created_at);
      `);
    },
  },
  {
    version: 13,
    name: "durable-run-autonomy",
    apply(database) {
      const columns = new Set((database.prepare("SELECT name FROM pragma_table_info('runs')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has("autonomy")) database.exec("ALTER TABLE runs ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'supervised';");
    },
  },
  {
    version: 14,
    name: "model-performance-observation-policy",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_performance_policies (
          model_id TEXT PRIMARY KEY,
          ignored_before TEXT,
          excluded INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 15,
    name: "reviewer-invocation-performance",
    apply(database) {
      const columns = new Set((database.prepare("SELECT name FROM pragma_table_info('invocation_receipts')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has("duration_ms")) database.exec("ALTER TABLE invocation_receipts ADD COLUMN duration_ms INTEGER;");
      if (!columns.has("workload_class")) database.exec("ALTER TABLE invocation_receipts ADD COLUMN workload_class TEXT;");
    },
  },
  {
    version: 16,
    name: "typed-tool-policy-receipts",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS tool_policy_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          task_id TEXT,
          attempt_id INTEGER REFERENCES attempts(id) ON DELETE SET NULL,
          tool_id TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          stage TEXT NOT NULL,
          side_effect TEXT NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT NOT NULL,
          request_json TEXT NOT NULL,
          lock_keys_json TEXT NOT NULL,
          approval_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tool_policy_receipts_run ON tool_policy_receipts(run_id, id);
      `);
    },
  },
  {
    version: 17,
    name: "structured-review-quorums",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS review_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          round INTEGER NOT NULL,
          integration_sha256 TEXT NOT NULL,
          verdict TEXT NOT NULL,
          provider TEXT NOT NULL,
          model_id TEXT,
          connection_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          raw_text TEXT NOT NULL,
          invalidated_at TEXT,
          invalidation_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_findings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_receipt_id INTEGER NOT NULL REFERENCES review_receipts(id) ON DELETE CASCADE,
          finding_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          location TEXT,
          rationale TEXT NOT NULL,
          suggested_correction TEXT NOT NULL,
          disposition TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(review_receipt_id, finding_id)
        );
        CREATE INDEX IF NOT EXISTS review_receipts_run ON review_receipts(run_id, round, id);
        CREATE INDEX IF NOT EXISTS review_findings_receipt ON review_findings(review_receipt_id, id);
      `);
    },
  },
  {
    version: 18,
    name: "durable-objectives-and-plan-revisions",
    apply(database) {
      const runColumns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('runs')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!runColumns.has("objective_id")) database.exec("ALTER TABLE runs ADD COLUMN objective_id TEXT REFERENCES objectives(id) ON DELETE SET NULL;");
      if (!runColumns.has("approved_plan_revision")) database.exec("ALTER TABLE runs ADD COLUMN approved_plan_revision INTEGER;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS objectives (
          id TEXT PRIMARY KEY,
          outcome TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          constraints_json TEXT NOT NULL,
          project_path TEXT NOT NULL,
          product_id TEXT,
          repository_ids_json TEXT NOT NULL,
          risk TEXT NOT NULL,
          autonomy TEXT NOT NULL,
          priority TEXT NOT NULL,
          deadline TEXT,
          policy_notes_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS plan_revisions (
          objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          plan_json TEXT NOT NULL,
          rationale TEXT NOT NULL,
          approved INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          approved_at TEXT,
          PRIMARY KEY (objective_id, revision)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS plan_revisions_one_approved
          ON plan_revisions(objective_id) WHERE approved = 1;
        CREATE INDEX IF NOT EXISTS objectives_updated_at ON objectives(updated_at DESC);
      `);
    },
  },
  {
    version: 19,
    name: "read-only-workbench-consultations",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workbench_sessions (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          title TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode = 'read_only'),
          objective_id TEXT REFERENCES objectives(id) ON DELETE SET NULL,
          converted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workbench_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES workbench_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          provider TEXT,
          connection_id TEXT,
          requested_model_id TEXT,
          resolved_model_id TEXT,
          status TEXT,
          error TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL,
          duration_ms INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS workbench_sessions_updated_at
          ON workbench_sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS workbench_messages_session
          ON workbench_messages(session_id, id);
      `);
    },
  },
  {
    version: 20,
    name: "local-repository-configuration-and-inspection",
    apply(database) {
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('repositories')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      const additions: Readonly<Record<string, string>> = {
        local_path: "TEXT",
        repository_role: "TEXT NOT NULL DEFAULT 'other'",
        expected_branch: "TEXT",
        owners_json: "TEXT NOT NULL DEFAULT '[]'",
        dependency_repository_ids_json: "TEXT NOT NULL DEFAULT '[]'",
        validators_json: "TEXT NOT NULL DEFAULT '{}'",
        governance_sources_json: "TEXT NOT NULL DEFAULT '[]'",
        governance_rules_json: "TEXT NOT NULL DEFAULT '[]'",
        current_branch: "TEXT",
        head_sha: "TEXT",
        remote_url: "TEXT",
        dirty: "INTEGER",
        compatibility_issues_json: "TEXT NOT NULL DEFAULT '[]'",
        checked_at: "TEXT",
      };
      for (const [name, definition] of Object.entries(additions)) {
        if (!columns.has(name)) database.exec(`ALTER TABLE repositories ADD COLUMN ${name} ${definition};`);
      }
      database.exec("CREATE INDEX IF NOT EXISTS repositories_local_path ON repositories(local_path) WHERE local_path IS NOT NULL;");
    },
  },
  {
    version: 21,
    name: "multi-repository-integration-sets",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS integration_sets (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          status TEXT NOT NULL,
          integration_conditions_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS integration_set_repositories (
          integration_set_id TEXT NOT NULL REFERENCES integration_sets(id) ON DELETE CASCADE,
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
          local_path TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          integration_branch TEXT NOT NULL,
          integration_worktree_path TEXT NOT NULL,
          head_commit TEXT,
          status TEXT NOT NULL,
          error TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (integration_set_id, repository_id)
        );
        CREATE INDEX IF NOT EXISTS integration_set_repositories_status
          ON integration_set_repositories(integration_set_id, status);
      `);
    },
  },
  {
    version: 22,
    name: "source-backed-product-intelligence",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS product_intelligence_snapshots (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS product_intelligence_snapshots_product
          ON product_intelligence_snapshots(product_id, created_at DESC);
      `);
    },
  },
  {
    version: 23,
    name: "provider-quota-groups-and-honest-model-resolution",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS quota_group_health (
          connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
          quota_group_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          state TEXT NOT NULL,
          failure_kind TEXT,
          consecutive_failures INTEGER NOT NULL,
          cooldown_until TEXT,
          detail TEXT NOT NULL,
          last_checked_at TEXT NOT NULL,
          PRIMARY KEY (connection_id, quota_group_id)
        );
      `);
      const receiptColumns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('invocation_receipts')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!receiptColumns.has("model_resolution")) database.exec("ALTER TABLE invocation_receipts ADD COLUMN model_resolution TEXT;");
    },
  },
  {
    version: 24,
    name: "review-evidence-bindings",
    apply(database) {
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('review_receipts')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("evidence_binding_json")) database.exec("ALTER TABLE review_receipts ADD COLUMN evidence_binding_json TEXT NOT NULL DEFAULT '{}';");
    },
  },
  {
    version: 25,
    name: "atomic-paid-spend-reservations",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS paid_spend_reservations (
          id TEXT PRIMARY KEY,
          scope_type TEXT NOT NULL CHECK(scope_type IN ('run', 'workbench')),
          scope_id TEXT NOT NULL,
          estimated_cost_usd REAL NOT NULL CHECK(estimated_cost_usd >= 0),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS paid_spend_reservations_scope
          ON paid_spend_reservations(scope_type, scope_id, expires_at);
        CREATE INDEX IF NOT EXISTS paid_spend_reservations_month
          ON paid_spend_reservations(created_at, expires_at);
      `);
    },
  },
  {
    version: 26,
    name: "paid-spend-reservation-lifecycle",
    apply(database) {
      const reservationColumns = new Set((database.prepare("SELECT name FROM pragma_table_info('paid_spend_reservations')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!reservationColumns.has("state")) database.exec("ALTER TABLE paid_spend_reservations ADD COLUMN state TEXT NOT NULL DEFAULT 'invoked' CHECK(state IN ('reserved', 'invoked'));");
      if (!reservationColumns.has("expected_receipt_count")) database.exec("ALTER TABLE paid_spend_reservations ADD COLUMN expected_receipt_count INTEGER NOT NULL DEFAULT 1 CHECK(expected_receipt_count > 0);");
      if (!reservationColumns.has("invoked_at")) database.exec("ALTER TABLE paid_spend_reservations ADD COLUMN invoked_at TEXT;");
      const invocationColumns = new Set((database.prepare("SELECT name FROM pragma_table_info('invocation_receipts')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!invocationColumns.has("paid_spend_reservation_id")) database.exec("ALTER TABLE invocation_receipts ADD COLUMN paid_spend_reservation_id TEXT;");
      const workbenchColumns = new Set((database.prepare("SELECT name FROM pragma_table_info('workbench_messages')").all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!workbenchColumns.has("paid_spend_reservation_id")) database.exec("ALTER TABLE workbench_messages ADD COLUMN paid_spend_reservation_id TEXT;");
      database.exec(`
        CREATE INDEX IF NOT EXISTS invocation_receipts_paid_reservation ON invocation_receipts(paid_spend_reservation_id);
        CREATE INDEX IF NOT EXISTS workbench_messages_paid_reservation ON workbench_messages(paid_spend_reservation_id);
      `);
    },
  },
  {
    version: 27,
    name: "approved-delivery-handoffs",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS delivery_repositories (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          repository_id TEXT NOT NULL,
          local_path TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          head_commit TEXT NOT NULL,
          branch TEXT NOT NULL,
          remote_url TEXT,
          status TEXT NOT NULL CHECK(status IN ('prepared', 'branch_pushed', 'draft_pr_created', 'failed')),
          pull_request_url TEXT,
          approval_id TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, repository_id)
        );
        CREATE INDEX IF NOT EXISTS delivery_repositories_status
          ON delivery_repositories(run_id, status);
      `);
    },
  },
  {
    version: 28,
    name: "live-run-steering",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS steering_directives (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('hold_admission', 'resume_admission', 'reprioritize', 'reassign', 'clarify', 'interrupt')),
          target_task_id TEXT,
          actor TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK(disposition IN ('pending', 'applied', 'rejected', 'superseded')),
          disposition_reason TEXT,
          applied_attempt_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS steering_directives_run
          ON steering_directives(run_id, disposition);
      `);
    },
  },
  {
    version: 29,
    name: "review-receipt-lens",
    apply(database) {
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('review_receipts')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("lens")) database.exec("ALTER TABLE review_receipts ADD COLUMN lens TEXT CHECK(lens IN ('artifact', 'claims') OR lens IS NULL);");
    },
  },
  {
    version: 30,
    name: "delivery-merge-and-tag",
    apply(database) {
      // SQLite cannot widen a CHECK constraint in place; rebuild the table
      // with the merged/tagged states (owner-corrected rule 2026-07-22: the
      // cockpit completes the delivery — merge and tag are owner-receipted
      // actions, never automatic). Idempotent and column-NAMED: a rebuild that
      // SELECT *'s across schema evolution breaks the moment any later
      // migration touched the table (the upgrade tests caught exactly that).
      const tableSql = (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'delivery_repositories'").get() as { sql?: string } | undefined)?.sql ?? "";
      if (tableSql.includes("'merged'")) return;
      database.exec(`
        ALTER TABLE delivery_repositories RENAME TO delivery_repositories_v27;
        CREATE TABLE delivery_repositories (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          repository_id TEXT NOT NULL,
          local_path TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          head_commit TEXT NOT NULL,
          branch TEXT NOT NULL,
          remote_url TEXT,
          status TEXT NOT NULL CHECK(status IN ('prepared', 'branch_pushed', 'draft_pr_created', 'merged', 'tagged', 'failed')),
          pull_request_url TEXT,
          approval_id TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, repository_id)
        );
        INSERT INTO delivery_repositories (run_id, repository_id, local_path, base_branch, base_commit, head_commit, branch, remote_url, status, pull_request_url, approval_id, error, created_at, updated_at)
          SELECT run_id, repository_id, local_path, base_branch, base_commit, head_commit, branch, remote_url, status, pull_request_url, approval_id, error, created_at, updated_at
          FROM delivery_repositories_v27;
        DROP TABLE delivery_repositories_v27;
        CREATE INDEX IF NOT EXISTS delivery_repositories_status
          ON delivery_repositories(run_id, status);
      `);
    },
  },
  {
    version: 31,
    name: "delivery-release-tag",
    apply(database) {
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('delivery_repositories')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("release_tag")) database.exec("ALTER TABLE delivery_repositories ADD COLUMN release_tag TEXT;");
    },
  },
  {
    version: 32,
    name: "workflow-revisions",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_revisions (
          revision_hash TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          document_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS workflow_revisions_name ON workflow_revisions(name, created_at);
      `);
      const runColumns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('runs')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!runColumns.has("workflow_revision_hash")) database.exec("ALTER TABLE runs ADD COLUMN workflow_revision_hash TEXT;");
    },
  },
  {
    version: 33,
    name: "objective-workflow-provenance",
    apply(database) {
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('objectives')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("workflow_revision_hash")) database.exec("ALTER TABLE objectives ADD COLUMN workflow_revision_hash TEXT;");
    },
  },
  {
    version: 34,
    name: "delivery-merge-commit-oid",
    apply(database) {
      // ROUND2-002: persist the immutable merge commit OID so the cockpit's
      // post-merge tag prefill resolves the declared version from the same
      // commit the tag gate judges, never the reviewed head.
      const columns = new Set(
        (database.prepare("SELECT name FROM pragma_table_info('delivery_repositories')").all() as unknown as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("merge_commit_oid")) database.exec("ALTER TABLE delivery_repositories ADD COLUMN merge_commit_oid TEXT;");
    },
  },
];

function summarizeGoal(goal: string, maxLength = 180): string {
  const normalized = goal.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  runs: ["id", "goal", "project_path", "status", "plan_json", "final_review", "resumed_from", "autonomy", "objective_id", "approved_plan_revision", "workflow_revision_hash", "created_at", "updated_at"],
  workflow_revisions: ["revision_hash", "name", "document_json", "created_at"],
  tasks: [
    "run_id",
    "task_id",
    "title",
    "description",
    "dependencies_json",
    "checks_json",
    "status",
    "preferred_provider",
    "provider",
    "attempt_count",
    "task_contract_json",
    "updated_at",
  ],
  attempts: [
    "id",
    "run_id",
    "task_id",
    "provider",
    "prompt",
    "status",
    "output",
    "error",
    "started_at",
    "finished_at",
    "connection_id",
    "model_id",
    "model_resolution",
    "model_settings_json",
    "adapter_version",
    "runtime_version",
    "failure_kind",
    "result_envelope_json",
    "input_tokens",
    "output_tokens",
    "cost_usd",
    "fallback_reason",
  ],
  checks: [
    "id",
    "run_id",
    "task_id",
    "name",
    "passed",
    "exit_code",
    "stdout",
    "stderr",
    "duration_ms",
    "created_at",
  ],
  events: ["id", "run_id", "kind", "message", "data_json", "created_at"],
  provider_connections: [
    "id",
    "provider",
    "transport",
    "authentication",
    "display_name",
    "enabled",
    "installed",
    "authenticated",
    "visible",
    "healthy",
    "available",
    "entitlement",
    "capacity",
    "adapter_version",
    "runtime_version",
    "metadata_json",
    "first_seen_at",
    "last_seen_at",
  ],
  models: [
    "id",
    "connection_id",
    "canonical_name",
    "display_name",
    "source",
    "lifecycle",
    "visible",
    "verified",
    "qualified",
    "active",
    "degraded",
    "retired",
    "metadata_json",
    "first_seen_at",
    "last_seen_at",
    "last_verified_at",
    "pinned",
    "excluded",
    "qualification_fingerprint",
    "qualification_stale",
    "missing_observations",
    "upgrade_policy",
  ],
  model_qualifications: ["id", "model_id", "fixture_version", "role", "passed", "score", "evidence_json", "created_at", "fingerprint"],
  connection_health: ["connection_id", "state", "failure_kind", "consecutive_failures", "cooldown_until", "detail", "last_checked_at"],
  model_health: ["model_id", "state", "failure_kind", "consecutive_failures", "cooldown_until", "detail", "last_checked_at"],
  quota_group_health: ["connection_id", "quota_group_id", "display_name", "state", "failure_kind", "consecutive_failures", "cooldown_until", "detail", "last_checked_at"],
  blackboard_entries: ["id", "run_id", "task_id", "kind", "content", "source_attempt_id", "created_at"],
  products: ["id", "name", "organization_url", "description", "created_at", "updated_at"],
  repositories: [
    "id", "product_id", "name", "full_name", "url", "clone_url", "default_branch", "visibility", "archived", "size_kb",
    "language", "description", "intelligence_json", "observed_at", "local_path", "repository_role", "expected_branch", "owners_json",
    "dependency_repository_ids_json", "validators_json", "governance_sources_json", "governance_rules_json", "current_branch",
    "head_sha", "remote_url", "dirty", "compatibility_issues_json", "checked_at",
  ],
  catalog_refreshes: ["provider", "status", "source", "model_count", "detail", "refreshed_at"],
  provider_catalog_models: ["id", "provider", "canonical_name", "display_name", "metadata_json", "first_seen_at", "last_seen_at", "missing_observations", "retired"],
  invocation_receipts: ["id", "run_id", "task_id", "role", "provider", "connection_id", "requested_model_id", "resolved_model_id", "model_resolution", "input_tokens", "output_tokens", "cost_usd", "duration_ms", "workload_class", "fallback_reason", "paid_spend_reservation_id", "created_at"],
  tool_policy_receipts: ["id", "run_id", "task_id", "attempt_id", "tool_id", "actor_role", "stage", "side_effect", "outcome", "reason", "request_json", "lock_keys_json", "approval_id", "created_at"],
  review_receipts: ["id", "run_id", "round", "integration_sha256", "evidence_binding_json", "verdict", "provider", "model_id", "connection_id", "lens", "summary", "raw_text", "invalidated_at", "invalidation_reason", "created_at"],
  review_findings: ["id", "review_receipt_id", "finding_id", "severity", "location", "rationale", "suggested_correction", "disposition", "created_at"],
  objectives: ["id", "outcome", "acceptance_criteria_json", "constraints_json", "project_path", "product_id", "repository_ids_json", "risk", "autonomy", "priority", "deadline", "policy_notes_json", "revision", "created_at", "updated_at", "workflow_revision_hash"],
  plan_revisions: ["objective_id", "revision", "plan_json", "rationale", "approved", "created_at", "approved_at"],
  workbench_sessions: ["id", "project_path", "title", "mode", "objective_id", "converted_at", "created_at", "updated_at"],
  workbench_messages: ["id", "session_id", "role", "content", "provider", "connection_id", "requested_model_id", "resolved_model_id", "status", "error", "input_tokens", "output_tokens", "cost_usd", "duration_ms", "paid_spend_reservation_id", "created_at"],
  paid_spend_reservations: ["id", "scope_type", "scope_id", "estimated_cost_usd", "state", "expected_receipt_count", "invoked_at", "created_at", "expires_at"],
  delivery_repositories: ["run_id", "repository_id", "local_path", "base_branch", "base_commit", "head_commit", "branch", "remote_url", "status", "pull_request_url", "approval_id", "error", "created_at", "updated_at", "release_tag", "merge_commit_oid"],
  integration_sets: ["id", "run_id", "product_id", "status", "integration_conditions_json", "created_at", "updated_at"],
  integration_set_repositories: ["integration_set_id", "repository_id", "local_path", "base_commit", "integration_branch", "integration_worktree_path", "head_commit", "status", "error", "updated_at"],
  product_intelligence_snapshots: ["id", "product_id", "status", "snapshot_json", "created_at"],
  model_performance_policies: ["model_id", "ignored_before", "excluded", "updated_at"],
  steering_directives: ["id", "run_id", "kind", "target_task_id", "actor", "payload_json", "disposition", "disposition_reason", "applied_attempt_id", "created_at", "updated_at"],
  schema_migrations: ["version", "name", "applied_at"],
};

/**
 * Runs that can still consume direction. `paused` is deliberately absent:
 * recovery continues in a new run, so a directive recorded against a paused run
 * would have no consumer.
 */
export const STEERABLE_RUN_STATUSES: readonly string[] = ["planning", "running", "awaiting_approval"];

/** Tasks that can still consume direction — anything not already finished. */
export const STEERABLE_TASK_STATUSES: readonly string[] = ["queued", "working", "verifying", "retry"];

function toSteeringDirectiveRecord(row: Record<string, unknown>): SteeringDirectiveRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    kind: String(row.kind) as SteeringDirectiveKind,
    targetTaskId: row.target_task_id == null ? null : String(row.target_task_id),
    actor: String(row.actor),
    payload: JSON.parse(String(row.payload_json)) as SteeringPayload,
    disposition: String(row.disposition) as SteeringDisposition,
    dispositionReason: row.disposition_reason == null ? null : String(row.disposition_reason),
    appliedAttemptId: row.applied_attempt_id == null ? null : Number(row.applied_attempt_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface ModelPerformancePolicyRecord {
  modelId: string;
  ignoredBefore: string | null;
  excluded: boolean;
  updatedAt: string;
}

export class Ledger {
  private readonly database: DatabaseSync;
  private readonly filename: string;
  /** Depth counter making writeAtomically reentrant; see that method. */
  private openWriteTransactions = 0;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    const existed = existsSync(filename);
    this.filename = filename;
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec("PRAGMA foreign_keys = ON;");
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.migrate(existed);
      this.database.exec("PRAGMA journal_mode = WAL;");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  getSchemaVersion(): number {
    return this.readSchemaVersion();
  }

  createWorkbenchSession(input: WorkbenchSessionInput): WorkbenchSessionRecord {
    const session = workbenchSessionInputSchema.parse(input) as WorkbenchSessionInput;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO workbench_sessions (
        id, project_path, title, mode, objective_id, converted_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'read_only', NULL, NULL, ?, ?)
    `).run(id, session.projectPath, redactText(session.title), now, now);
    return this.getWorkbenchSession(id)!;
  }

  getWorkbenchSession(id: string): WorkbenchSessionRecord | null {
    const row = this.database.prepare("SELECT * FROM workbench_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorkbenchSession(row) : null;
  }

  listWorkbenchSessions(): WorkbenchSessionRecord[] {
    const rows = this.database.prepare("SELECT * FROM workbench_sessions ORDER BY updated_at DESC, id").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapWorkbenchSession(row));
  }

  appendWorkbenchMessage(input: WorkbenchMessageInput): WorkbenchMessageRecord {
    const message = workbenchMessageInputSchema.parse(input) as WorkbenchMessageInput;
    if (!this.getWorkbenchSession(message.sessionId)) {
      throw new Error(`Workbench session '${message.sessionId}' was not found`);
    }
    const now = new Date().toISOString();
    if (message.paidSpendReservationId) this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.database.prepare(`
        INSERT INTO workbench_messages (
          session_id, role, content, provider, connection_id, requested_model_id,
          resolved_model_id, status, error, input_tokens, output_tokens, cost_usd,
          duration_ms, paid_spend_reservation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.sessionId,
        message.role,
        redactText(message.content),
        message.provider ?? null,
        message.connectionId ?? null,
        message.requestedModelId ?? null,
        message.resolvedModelId ?? null,
        message.status ?? null,
        message.error == null ? null : redactText(message.error),
        message.inputTokens ?? null,
        message.outputTokens ?? null,
        message.costUsd ?? null,
        message.durationMs ?? null,
        message.paidSpendReservationId ?? null,
        now,
      );
      this.database.prepare("UPDATE workbench_sessions SET updated_at = ? WHERE id = ?").run(now, message.sessionId);
      if (message.paidSpendReservationId) this.reconcilePaidSpendReservation(message.paidSpendReservationId);
      const row = this.database.prepare("SELECT * FROM workbench_messages WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;
      if (message.paidSpendReservationId) this.database.exec("COMMIT;");
      return this.mapWorkbenchMessage(row);
    } catch (error) {
      if (message.paidSpendReservationId) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  listWorkbenchMessages(sessionId: string): WorkbenchMessageRecord[] {
    if (!this.getWorkbenchSession(sessionId)) {
      throw new Error(`Workbench session '${sessionId}' was not found`);
    }
    const rows = this.database.prepare("SELECT * FROM workbench_messages WHERE session_id = ? ORDER BY id").all(sessionId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapWorkbenchMessage(row));
  }

  linkWorkbenchObjective(sessionId: string, objectiveId: string): WorkbenchSessionRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const session = this.getWorkbenchSession(sessionId);
      if (!session) throw new Error(`Workbench session '${sessionId}' was not found`);
      const objective = this.getObjective(objectiveId);
      if (!objective) throw new Error(`Objective '${objectiveId}' was not found`);
      if (session.objectiveId && session.objectiveId !== objectiveId) {
        throw new Error(`Workbench session '${sessionId}' is already linked to objective '${session.objectiveId}'`);
      }
      if (session.projectPath !== objective.projectPath) {
        throw new Error("Workbench session and objective must use the same project path");
      }
      if (!session.objectiveId) {
        const now = new Date().toISOString();
        this.database.prepare(`
          UPDATE workbench_sessions
          SET objective_id = ?, converted_at = ?, updated_at = ?
          WHERE id = ?
        `).run(objectiveId, now, now, sessionId);
      }
      this.database.exec("COMMIT");
      return this.getWorkbenchSession(sessionId)!;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createObjective(input: ObjectiveInput): ObjectiveRecord {
    // The public schema deliberately has no workflowRevisionHash (audit
    // DH810-AUD-001) — the privileged provenance field is re-attached from the
    // typed input here and validated against the stored revisions, so an
    // objective can never claim a pedigree the ledger has not recorded.
    const objective = {
      ...objectiveInputSchema.parse(input),
      ...(input.workflowRevisionHash ? { workflowRevisionHash: input.workflowRevisionHash } : {}),
    } as ObjectiveInput;
    if (objective.workflowRevisionHash) {
      if (!/^[a-f0-9]{64}$/.test(objective.workflowRevisionHash)) {
        throw new Error("Objective workflow provenance must be a 64-character content hash");
      }
      if (!this.getWorkflowRevision(objective.workflowRevisionHash)) {
        throw new Error(`Objective provenance names unknown workflow revision '${objective.workflowRevisionHash}'`);
      }
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO objectives (
        id, outcome, acceptance_criteria_json, constraints_json, project_path, product_id,
        repository_ids_json, risk, autonomy, priority, deadline, policy_notes_json,
        workflow_revision_hash, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      redactText(objective.outcome),
      JSON.stringify(objective.acceptanceCriteria.map(redactText)),
      JSON.stringify(objective.constraints.map(redactText)),
      objective.projectPath,
      objective.productId ?? null,
      JSON.stringify(objective.repositoryIds),
      objective.risk,
      objective.autonomy,
      objective.priority,
      objective.deadline ?? null,
      JSON.stringify(objective.policyNotes.map(redactText)),
      objective.workflowRevisionHash ?? null,
      now,
      now,
    );
    return this.getObjective(id)!;
  }

  updateObjective(id: string, input: ObjectiveInput, expectedRevision: number): ObjectiveRecord {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected objective revision must be a positive integer");
    }
    const objective = objectiveInputSchema.parse(input) as ObjectiveInput;
    const result = this.database.prepare(`
      UPDATE objectives SET
        outcome = ?, acceptance_criteria_json = ?, constraints_json = ?, project_path = ?,
        product_id = ?, repository_ids_json = ?, risk = ?, autonomy = ?, priority = ?,
        deadline = ?, policy_notes_json = ?, workflow_revision_hash = NULL,
        revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      redactText(objective.outcome),
      JSON.stringify(objective.acceptanceCriteria.map(redactText)),
      JSON.stringify(objective.constraints.map(redactText)),
      objective.projectPath,
      objective.productId ?? null,
      JSON.stringify(objective.repositoryIds),
      objective.risk,
      objective.autonomy,
      objective.priority,
      objective.deadline ?? null,
      JSON.stringify(objective.policyNotes.map(redactText)),
      new Date().toISOString(),
      id,
      expectedRevision,
    );
    if (result.changes === 0) {
      if (!this.getObjective(id)) throw new Error(`Objective '${id}' was not found`);
      throw new Error(`Objective '${id}' revision conflict: expected revision ${expectedRevision}`);
    }
    return this.getObjective(id)!;
  }

  getObjective(id: string): ObjectiveRecord | null {
    const row = this.database.prepare("SELECT * FROM objectives WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapObjective(row) : null;
  }

  listObjectives(): ObjectiveRecord[] {
    const rows = this.database.prepare("SELECT * FROM objectives ORDER BY updated_at DESC, id").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapObjective(row));
  }

  appendPlanRevision(objectiveId: string, plan: RunPlan, rationale: string): PlanRevisionRecord {
    const parsed = planRevisionInputSchema.parse({ plan, rationale }) as { plan: RunPlan; rationale: string };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getObjective(objectiveId)) throw new Error(`Objective '${objectiveId}' was not found`);
      const row = this.database.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM plan_revisions WHERE objective_id = ?").get(objectiveId) as { revision: number };
      const revision = row.revision + 1;
      const storedPlan = redactValue({
        ...parsed.plan,
        revision,
        previousRevision: revision > 1 ? revision - 1 : null,
      }) as RunPlan;
      this.database.prepare(`
        INSERT INTO plan_revisions (objective_id, revision, plan_json, rationale, approved, created_at, approved_at)
        VALUES (?, ?, ?, ?, 0, ?, NULL)
      `).run(objectiveId, revision, JSON.stringify(storedPlan), redactText(parsed.rationale), new Date().toISOString());
      this.database.exec("COMMIT");
      return this.getPlanRevision(objectiveId, revision)!;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getPlanRevision(objectiveId: string, revision: number): PlanRevisionRecord | null {
    const row = this.database.prepare("SELECT * FROM plan_revisions WHERE objective_id = ? AND revision = ?").get(objectiveId, revision) as Record<string, unknown> | undefined;
    return row ? this.mapPlanRevision(row) : null;
  }

  listPlanRevisions(objectiveId: string): PlanRevisionRecord[] {
    const rows = this.database.prepare("SELECT * FROM plan_revisions WHERE objective_id = ? ORDER BY revision").all(objectiveId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPlanRevision(row));
  }

  approvePlanRevision(objectiveId: string, revision: number): PlanRevisionRecord {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Plan revision must be a positive integer");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.database.prepare("SELECT 1 AS present FROM plan_revisions WHERE objective_id = ? AND revision = ?").get(objectiveId, revision);
      if (!candidate) throw new Error(`Plan revision ${revision} for objective '${objectiveId}' was not found`);
      this.database.prepare("UPDATE plan_revisions SET approved = 0, approved_at = NULL WHERE objective_id = ? AND approved = 1").run(objectiveId);
      this.database.prepare("UPDATE plan_revisions SET approved = 1, approved_at = ? WHERE objective_id = ? AND revision = ?").run(new Date().toISOString(), objectiveId, revision);
      this.database.exec("COMMIT");
      return this.getPlanRevision(objectiveId, revision)!;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createRun(
    goal: string,
    projectPath: string,
    resumedFrom: string | null = null,
    autonomy: RunAutonomy = "supervised",
    linkage: RunObjectiveLink | null = null,
  ): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let approvedPlanJson: string | null = null;
    if (linkage) {
      const approved = this.database.prepare(`
        SELECT plan_json FROM plan_revisions
        WHERE objective_id = ? AND revision = ? AND approved = 1
      `).get(linkage.objectiveId, linkage.approvedPlanRevision) as { plan_json: string } | undefined;
      if (!approved) {
        throw new Error(`Plan revision ${linkage.approvedPlanRevision} is not the approved plan revision for objective '${linkage.objectiveId}'`);
      }
      approvedPlanJson = approved.plan_json;
    }
    this.database
      .prepare(
        "INSERT INTO runs (id, goal, project_path, status, plan_json, resumed_from, autonomy, objective_id, approved_plan_revision, created_at, updated_at) VALUES (?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, redactText(goal), projectPath, approvedPlanJson, resumedFrom, autonomy, linkage?.objectiveId ?? null, linkage?.approvedPlanRevision ?? null, now, now);
    this.addEvent(id, "run.created", resumedFrom ? "Recovery run created" : "Run created", {
      ...(resumedFrom ? { resumedFrom } : {}),
      ...(linkage ? { objectiveId: linkage.objectiveId, approvedPlanRevision: linkage.approvedPlanRevision } : {}),
      autonomy,
    });
    return id;
  }

  setRunAutonomy(runId: string, autonomy: RunAutonomy): void {
    const result = this.database.prepare("UPDATE runs SET autonomy = ?, updated_at = ? WHERE id = ?").run(autonomy, new Date().toISOString(), runId);
    if (result.changes === 0) throw new Error(`Run '${runId}' was not found`);
  }

  savePlan(runId: string, plan: RunPlan): void {
    const existing = this.database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    if (!existing) throw new Error(`Run '${runId}' was not found`);
    const currentStatus = parseRunStatus(existing.status);
    if (["paused", "cancelled", "failed", "ready", "not_ready"].includes(currentStatus)) return;
    assertRunTransition(currentStatus, "running");
    const safePlan: RunPlan = {
      summary: redactText(plan.summary),
      recommendedConcurrency: plan.recommendedConcurrency,
      ...(plan.revision === undefined ? {} : { revision: plan.revision }),
      ...(plan.previousRevision === undefined ? {} : { previousRevision: plan.previousRevision }),
      repositoryImpact: (plan.repositoryImpact ?? []).map((impact) => ({ ...impact, rationale: redactText(impact.rationale) })),
      integrationConditions: (plan.integrationConditions ?? []).map(redactText),
      tasks: plan.tasks.map((task) => ({
        ...task,
        title: redactText(task.title),
        description: redactText(task.description),
      })),
    };
    if (currentStatus === "running") {
      throw new Error(`Run '${runId}' already has an active plan`);
    }
    const updated = this.database
      .prepare(
        "UPDATE runs SET plan_json = ?, status = 'running', updated_at = ? WHERE id = ? AND status NOT IN ('paused', 'cancelled', 'failed', 'ready', 'not_ready')",
      )
      .run(JSON.stringify(safePlan), new Date().toISOString(), runId);
    if (updated.changes === 0) return;
    const insert = this.database.prepare(
      `INSERT INTO tasks
        (run_id, task_id, title, description, dependencies_json, checks_json, status, preferred_provider, task_contract_json)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    for (const task of safePlan.tasks) {
      insert.run(
        runId,
        task.id,
        task.title,
        task.description,
        JSON.stringify(task.dependencies),
        JSON.stringify(task.checks),
        task.preferredProvider,
        JSON.stringify(redactValue({
          kind: task.kind ?? "implementation",
          repositoryIds: task.repositoryIds ?? [],
          repositoryScope: task.repositoryScope ?? ["."],
          permission: task.permission ?? "workspace_write",
          risk: task.risk ?? "medium",
          capabilityNeeds: task.capabilityNeeds ?? ["code"],
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          expectedArtifacts: task.expectedArtifacts ?? [],
        })),
      );
    }
    this.addEvent(runId, "plan.created", `Architect created ${safePlan.tasks.length} tasks`, {
      taskCount: safePlan.tasks.length,
      revision: safePlan.revision ?? 1,
      previousRevision: safePlan.previousRevision ?? null,
    });
  }

  createIntegrationSet(input: {
    runId: string;
    productId: string;
    integrationConditions: string[];
    repositories: Array<{
      repositoryId: string;
      localPath: string;
      baseCommit: string;
      integrationBranch: string;
      integrationWorktreePath: string;
    }>;
  }): IntegrationSetRecord {
    if (this.getIntegrationSet(input.runId)) throw new Error(`Run '${input.runId}' already has an integration set`);
    if (!input.repositories.length) throw new Error("An integration set requires at least one repository");
    if (new Set(input.repositories.map((repository) => repository.repositoryId)).size !== input.repositories.length) {
      throw new Error("Integration set repository IDs must be unique");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO integration_sets (id, run_id, product_id, status, integration_conditions_json, created_at, updated_at)
        VALUES (?, ?, ?, 'preparing', ?, ?, ?)
      `).run(id, input.runId, input.productId, JSON.stringify(input.integrationConditions.map((condition) => redactText(condition))), now, now);
      const insert = this.database.prepare(`
        INSERT INTO integration_set_repositories (
          integration_set_id, repository_id, local_path, base_commit, integration_branch,
          integration_worktree_path, head_commit, status, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?)
      `);
      for (const repository of input.repositories) {
        insert.run(id, repository.repositoryId, repository.localPath, repository.baseCommit, repository.integrationBranch, repository.integrationWorktreePath, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getIntegrationSet(input.runId)!;
  }

  setIntegrationSetStatus(runId: string, status: IntegrationSetStatus): IntegrationSetRecord {
    const now = new Date().toISOString();
    const updated = this.database.prepare("UPDATE integration_sets SET status = ?, updated_at = ? WHERE run_id = ?").run(status, now, runId);
    if (!updated.changes) throw new Error(`Run '${runId}' has no integration set`);
    return this.getIntegrationSet(runId)!;
  }

  updateIntegrationSetRepository(
    runId: string,
    repositoryId: string,
    input: { status: IntegrationRepositoryStatus; headCommit?: string | null; error?: string | null },
  ): IntegrationSetRecord {
    const set = this.getIntegrationSet(runId);
    if (!set) throw new Error(`Run '${runId}' has no integration set`);
    const current = set.repositories.find((repository) => repository.repositoryId === repositoryId);
    if (!current) throw new Error(`Repository '${repositoryId}' is not part of the integration set`);
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE integration_set_repositories
      SET status = ?, head_commit = ?, error = ?, updated_at = ?
      WHERE integration_set_id = ? AND repository_id = ?
    `).run(input.status, input.headCommit === undefined ? current.headCommit : input.headCommit, input.error === undefined ? current.error : input.error, now, set.id, repositoryId);
    this.database.prepare("UPDATE integration_sets SET updated_at = ? WHERE id = ?").run(now, set.id);
    return this.getIntegrationSet(runId)!;
  }

  getIntegrationSet(runId: string): IntegrationSetRecord | null {
    const row = this.database.prepare("SELECT * FROM integration_sets WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const repositories = this.database.prepare(`
      SELECT * FROM integration_set_repositories WHERE integration_set_id = ? ORDER BY repository_id
    `).all(String(row.id)) as unknown as Array<Record<string, unknown>>;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      productId: String(row.product_id),
      status: String(row.status) as IntegrationSetStatus,
      integrationConditions: JSON.parse(String(row.integration_conditions_json)) as string[],
      repositories: repositories.map((repository) => ({
        repositoryId: String(repository.repository_id),
        localPath: String(repository.local_path),
        baseCommit: String(repository.base_commit),
        integrationBranch: String(repository.integration_branch),
        integrationWorktreePath: String(repository.integration_worktree_path),
        headCommit: repository.head_commit === null ? null : String(repository.head_commit),
        status: String(repository.status) as IntegrationRepositoryStatus,
        error: repository.error === null ? null : String(repository.error),
        updatedAt: String(repository.updated_at),
      })),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  prepareDeliveryRepository(input: {
    runId: string;
    repositoryId: string;
    localPath: string;
    baseBranch: string;
    baseCommit: string;
    headCommit: string;
    branch: string;
  }): DeliveryRepositoryRecord {
    if (!this.getRun(input.runId)) throw new Error(`Run '${input.runId}' was not found`);
    for (const [name, value] of Object.entries(input)) {
      if (!String(value).trim()) throw new Error(`Delivery ${name} cannot be empty`);
    }
    if (input.baseCommit === input.headCommit) throw new Error("Delivery requires a reviewed commit distinct from the base commit");
    const existing = this.getDeliveryHandoff(input.runId)?.repositories.find((repository) => repository.repositoryId === input.repositoryId);
    if (existing) {
      const unchanged = existing.localPath === input.localPath && existing.baseBranch === input.baseBranch && existing.baseCommit === input.baseCommit
        && existing.headCommit === input.headCommit && existing.branch === input.branch;
      if (!unchanged) throw new Error(`Delivery evidence for '${input.repositoryId}' is immutable once prepared`);
      return existing;
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO delivery_repositories (
        run_id, repository_id, local_path, base_branch, base_commit, head_commit, branch,
        remote_url, status, pull_request_url, approval_id, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', NULL, NULL, NULL, ?, ?)
    `).run(input.runId, input.repositoryId, input.localPath, input.baseBranch, input.baseCommit, input.headCommit, input.branch, now, now);
    this.addEvent(input.runId, "delivery.prepared", `${input.repositoryId}: reviewed branch ${input.branch} is ready for owner-approved delivery`, {
      repositoryId: input.repositoryId,
      baseBranch: input.baseBranch,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      branch: input.branch,
    });
    return this.getDeliveryHandoff(input.runId)!.repositories.find((repository) => repository.repositoryId === input.repositoryId)!;
  }

  /**
   * DH-635. A steering directive is durable evidence, not a transient command:
   * it records who asked, what they targeted, and how it was dispositioned, so a
   * run's history explains every redirection after the fact. Terminal runs
   * refuse steering — a finished run's evidence is immutable.
   */
  recordSteeringDirective(input: {
    runId: string;
    kind: SteeringDirectiveKind;
    targetTaskId: string | null;
    actor: string;
    payload: SteeringPayload;
  }): SteeringDirectiveRecord {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    // Validation and insertion share one transaction. Checking run/task state in
    // a separate statement would let a task finish in the gap and leave the new
    // directive with no consumer — a directive stuck pending forever.
    this.writeAtomically(() => {
      const run = this.database.prepare("SELECT status FROM runs WHERE id = ?").get(input.runId) as { status: string } | undefined;
      if (!run) throw new Error(`Run '${input.runId}' was not found`);
      if (!STEERABLE_RUN_STATUSES.includes(run.status)) {
        // A paused run is not steerable: recovery continues in a NEW run, so a
        // directive recorded here would never be reached.
        throw new Error(`Run '${input.runId}' is '${run.status.replaceAll("_", " ")}' and cannot be steered`);
      }
      if (input.targetTaskId) {
        const task = this.database
          .prepare("SELECT status FROM tasks WHERE run_id = ? AND task_id = ?")
          .get(input.runId, input.targetTaskId) as { status: string } | undefined;
        if (!task) throw new Error(`Run '${input.runId}' has no task '${input.targetTaskId}'`);
        if (!STEERABLE_TASK_STATUSES.includes(task.status)) {
          throw new Error(`Task '${input.targetTaskId}' has already finished as '${task.status}' and can no longer be steered`);
        }
        if (input.kind === "interrupt" && task.status !== "working") {
          throw new Error(`Task '${input.targetTaskId}' has no attempt in flight to interrupt (it is '${task.status}')`);
        }
      }
      // A newer directive of the same kind against the same target replaces any
      // still-pending peer, so the scheduler never applies stale direction.
      this.database
        .prepare(
          `UPDATE steering_directives SET disposition = 'superseded', disposition_reason = ?, updated_at = ?
           WHERE run_id = ? AND kind = ? AND disposition = 'pending'
             AND ((target_task_id IS NULL AND ? IS NULL) OR target_task_id = ?)`,
        )
        .run("Superseded by a newer directive", now, input.runId, input.kind, input.targetTaskId, input.targetTaskId);
      const payload = redactValue(input.payload) as SteeringPayload;
      this.database
        .prepare(
          `INSERT INTO steering_directives (id, run_id, kind, target_task_id, actor, payload_json, disposition, disposition_reason, applied_attempt_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(id, input.runId, input.kind, input.targetTaskId, input.actor, JSON.stringify(payload), now, now);
    });
    this.addEvent(input.runId, "steering.requested", `${input.actor} requested ${input.kind}${input.targetTaskId ? ` for ${input.targetTaskId}` : ""}`, {
      directiveId: id,
      kind: input.kind,
      taskId: input.targetTaskId,
    });
    return this.getSteeringDirective(id)!;
  }

  resolveSteeringDirective(
    id: string,
    input: { disposition: Exclude<SteeringDisposition, "pending">; reason?: string; attemptId?: number },
  ): SteeringDirectiveRecord | null {
    const existing = this.getSteeringDirective(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE steering_directives SET disposition = ?, disposition_reason = ?, applied_attempt_id = ?, updated_at = ? WHERE id = ?")
      .run(input.disposition, input.reason ?? null, input.attemptId ?? null, now, id);
    this.addEvent(existing.runId, `steering.${input.disposition}`, `${existing.kind}${existing.targetTaskId ? ` for ${existing.targetTaskId}` : ""}: ${input.disposition}${input.reason ? ` — ${input.reason}` : ""}`, {
      directiveId: id,
      kind: existing.kind,
      taskId: existing.targetTaskId,
      attemptId: input.attemptId ?? null,
    });
    return this.getSteeringDirective(id);
  }

  getSteeringDirective(id: string): SteeringDirectiveRecord | null {
    const row = this.database.prepare("SELECT * FROM steering_directives WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toSteeringDirectiveRecord(row) : null;
  }

  listSteeringDirectives(runId: string, options: { disposition?: SteeringDisposition } = {}): SteeringDirectiveRecord[] {
    const rows = options.disposition
      ? this.database.prepare("SELECT * FROM steering_directives WHERE run_id = ? AND disposition = ? ORDER BY created_at ASC").all(runId, options.disposition)
      : this.database.prepare("SELECT * FROM steering_directives WHERE run_id = ? ORDER BY created_at ASC").all(runId);
    return (rows as Record<string, unknown>[]).map(toSteeringDirectiveRecord);
  }

  /**
   * Run `work` inside one write transaction. Reentrant: a nested call joins the
   * transaction its caller already opened instead of raising SQLite's
   * "cannot start a transaction within a transaction". This keeps atomic
   * operations composable — steering disposition, for instance, has to be able
   * to run both standalone and inside a task-status transition.
   */
  private writeAtomically<T>(work: () => T): T {
    if (this.openWriteTransactions > 0) return work();
    this.database.exec("BEGIN IMMEDIATE");
    this.openWriteTransactions += 1;
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.openWriteTransactions -= 1;
    }
  }

  /**
   * DH-635. Disposition every directive that can no longer be applied, in one
   * statement. Any path that ends work — a run terminalising, a cancellation, a
   * pause, a task blocked by a failed dependency — must call this, or the ledger
   * would keep asserting an operation is still pending when no execution path
   * for it exists. `taskId` scopes the sweep to one task; omit it to sweep the
   * whole run (including run-scoped admission directives).
   */
  dispositionUnreachableSteering(runId: string, input: { reason: string; taskId?: string }): number {
    const now = new Date().toISOString();
    const result = input.taskId
      ? this.database
          .prepare("UPDATE steering_directives SET disposition = 'rejected', disposition_reason = ?, updated_at = ? WHERE run_id = ? AND disposition = 'pending' AND target_task_id = ?")
          .run(input.reason, now, runId, input.taskId)
      : this.database
          .prepare("UPDATE steering_directives SET disposition = 'rejected', disposition_reason = ?, updated_at = ? WHERE run_id = ? AND disposition = 'pending'")
          .run(input.reason, now, runId);
    const swept = Number(result.changes ?? 0);
    if (swept > 0) {
      this.addEvent(runId, "steering.rejected", `${swept} steering directive(s) could no longer be applied: ${input.reason}`, {
        taskId: input.taskId ?? null,
        count: swept,
      });
    }
    return swept;
  }

  /** Pending directives the scheduler should consider at its next safe boundary. */
  pendingSteeringDirectives(runId: string, targetTaskId?: string | null): SteeringDirectiveRecord[] {
    return this.listSteeringDirectives(runId, { disposition: "pending" }).filter((directive) =>
      targetTaskId === undefined ? true : directive.targetTaskId === targetTaskId,
    );
  }

  updateDeliveryRepository(
    runId: string,
    repositoryId: string,
    input: {
      status: DeliveryRepositoryStatus;
      remoteUrl?: string | null;
      pullRequestUrl?: string | null;
      approvalId?: string | null;
      releaseTag?: string | null;
      mergeCommitOid?: string | null;
      error?: string | null;
    },
  ): DeliveryRepositoryRecord {
    const current = this.getDeliveryHandoff(runId)?.repositories.find((repository) => repository.repositoryId === repositoryId);
    if (!current) throw new Error(`Run '${runId}' has no prepared delivery for '${repositoryId}'`);
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE delivery_repositories
      SET status = ?, remote_url = ?, pull_request_url = ?, approval_id = ?, release_tag = ?, merge_commit_oid = ?, error = ?, updated_at = ?
      WHERE run_id = ? AND repository_id = ?
    `).run(
      input.status,
      input.remoteUrl === undefined ? current.remoteUrl : input.remoteUrl,
      input.pullRequestUrl === undefined ? current.pullRequestUrl : input.pullRequestUrl,
      input.approvalId === undefined ? current.approvalId : input.approvalId,
      input.releaseTag === undefined ? current.releaseTag : input.releaseTag,
      input.mergeCommitOid === undefined ? current.mergeCommitOid : input.mergeCommitOid,
      input.error === undefined ? current.error : input.error == null ? null : redactText(input.error),
      now,
      runId,
      repositoryId,
    );
    return this.getDeliveryHandoff(runId)!.repositories.find((repository) => repository.repositoryId === repositoryId)!;
  }

  getDeliveryHandoff(runId: string): DeliveryHandoffRecord | null {
    const rows = this.database.prepare("SELECT * FROM delivery_repositories WHERE run_id = ? ORDER BY repository_id").all(runId) as unknown as Array<Record<string, unknown>>;
    if (!rows.length) return null;
    const repositories: DeliveryRepositoryRecord[] = rows.map((row) => ({
      runId: String(row.run_id),
      repositoryId: String(row.repository_id),
      localPath: String(row.local_path),
      baseBranch: String(row.base_branch),
      baseCommit: String(row.base_commit),
      headCommit: String(row.head_commit),
      branch: String(row.branch),
      remoteUrl: row.remote_url === null ? null : String(row.remote_url),
      status: String(row.status) as DeliveryRepositoryStatus,
      pullRequestUrl: row.pull_request_url === null ? null : String(row.pull_request_url),
      approvalId: row.approval_id === null ? null : String(row.approval_id),
      releaseTag: row.release_tag === null || row.release_tag === undefined ? null : String(row.release_tag),
      mergeCommitOid: row.merge_commit_oid === null || row.merge_commit_oid === undefined ? null : String(row.merge_commit_oid),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
    const status: DeliveryRepositoryStatus = repositories.some((repository) => repository.status === "failed")
      ? "failed"
      : repositories.every((repository) => repository.status === "tagged")
        ? "tagged"
        : repositories.every((repository) => ["merged", "tagged"].includes(repository.status))
          ? "merged"
          : repositories.every((repository) => ["draft_pr_created", "merged", "tagged"].includes(repository.status))
            ? "draft_pr_created"
            : repositories.every((repository) => ["branch_pushed", "draft_pr_created", "merged", "tagged"].includes(repository.status))
              ? "branch_pushed"
              : "prepared";
    return { runId, status, repositories };
  }

  addIntegrationTask(runId: string, checks: string[], taskId = "__integration__", title = "Integration suite"): void {
    this.database
      .prepare(
        `INSERT INTO tasks
          (run_id, task_id, title, description, dependencies_json, checks_json, status, preferred_provider)
         VALUES (?, ?, ?, 'Validate the combined integration branch', '[]', ?, 'queued', NULL)`,
      )
      .run(runId, taskId, redactText(title), JSON.stringify(checks));
    this.addEvent(runId, "integration.queued", `Queued ${checks.length} integration validators`, { taskId });
  }

  setRunStatus(runId: string, status: RunStatus, finalReview?: string): void {
    const row = this.database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    if (!row) throw new Error(`Run '${runId}' was not found`);
    assertRunTransition(parseRunStatus(row.status), status);
    this.database
      .prepare(
        "UPDATE runs SET status = ?, final_review = COALESCE(?, final_review), updated_at = ? WHERE id = ?",
      )
      .run(status, finalReview === undefined ? null : redactText(finalReview), new Date().toISOString(), runId);
    if (["ready", "not_ready", "failed", "cancelled"].includes(status)) {
      this.dispositionUnreachableSteering(runId, { reason: `The run finished as ${status.replaceAll("_", " ")} before this direction could be applied` });
    }
  }

  cancelRun(runId: string): boolean {
    const run = this.database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    if (!run) return false;
    const currentStatus = parseRunStatus(run.status);
    if (["ready", "not_ready", "failed", "cancelled"].includes(currentStatus)) return false;
    assertRunTransition(currentStatus, "cancelled");

    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE runs SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now, runId);
    this.database
      .prepare(
        "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status IN ('queued', 'working', 'verifying', 'retry', 'paused')",
      )
      .run(now, runId);
    this.addEvent(runId, "run.cancelled", "Run cancelled");
    this.dispositionUnreachableSteering(runId, { reason: "The run was cancelled before this direction could be applied" });
    return true;
  }

  setTaskStatus(
    runId: string,
    taskId: string,
    status: TaskStatus,
    provider?: string,
  ): void {
    this.writeAtomically(() => {
      const row = this.database
        .prepare("SELECT status FROM tasks WHERE run_id = ? AND task_id = ?")
        .get(runId, taskId) as { status: string } | undefined;
      if (!row) throw new Error(`Task '${taskId}' was not found in run '${runId}'`);
      assertTaskTransition(parseTaskStatus(row.status), status);
      this.database
        .prepare(
          "UPDATE tasks SET status = ?, provider = COALESCE(?, provider), updated_at = ? WHERE run_id = ? AND task_id = ?",
        )
        .run(status, provider ?? null, new Date().toISOString(), runId, taskId);
      // DH-635: a task that has just finished can no longer consume direction.
      // Sweeping inside this transaction closes both interleavings — direction
      // recorded before the transition is dispositioned here, and direction
      // attempted after it is refused by recordSteeringDirective, which cannot
      // observe a half-applied transition.
      if (!STEERABLE_TASK_STATUSES.includes(status)) {
        this.dispositionUnreachableSteering(runId, {
          taskId,
          reason: `The task finished as '${status}' before this direction could be applied`,
        });
      }
    });
  }

  startAttempt(
    runId: string,
    taskId: string,
    provider: string,
    prompt: string,
    runtime?: AttemptRuntimeContext,
  ): number {
    this.database
      .prepare(
        "UPDATE tasks SET attempt_count = attempt_count + 1, provider = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
      )
      .run(provider, new Date().toISOString(), runId, taskId);
    const result = this.database
      .prepare(
        `INSERT INTO attempts
          (run_id, task_id, provider, prompt, status, started_at, connection_id, model_id,
           model_settings_json, adapter_version, runtime_version)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        taskId,
        provider,
        redactText(prompt),
        new Date().toISOString(),
        runtime?.connectionId ?? null,
        runtime?.requestedModelId ?? null,
        JSON.stringify(redactValue(runtime?.modelSettings ?? {})),
        runtime?.adapterVersion ?? null,
        runtime?.runtimeVersion ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  pauseRun(runId: string, reason = "Run paused by user"): boolean {
    const run = this.database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    if (!run) return false;
    const currentStatus = parseRunStatus(run.status);
    if (!["planning", "running", "awaiting_approval"].includes(currentStatus)) return false;
    assertRunTransition(currentStatus, "paused");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE runs SET status = 'paused', updated_at = ? WHERE id = ?").run(now, runId);
      this.database.prepare("UPDATE tasks SET status = 'paused', updated_at = ? WHERE run_id = ? AND status IN ('queued', 'working', 'verifying', 'retry')").run(now, runId);
      this.database.prepare("UPDATE attempts SET status = 'interrupted', error = ?, finished_at = ? WHERE run_id = ? AND status = 'running'").run(redactText(reason), now, runId);
      this.addEvent(runId, "run.paused", reason);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    // Recovery starts a NEW run rather than restarting this one, so directives
    // left pending here would never be reachable again. Routed through the one
    // primitive: the earlier duplicate SQL here is exactly why the post-pause
    // submission rule drifted away from the sweep.
    this.dispositionUnreachableSteering(runId, {
      reason: "The run was paused before this direction could be applied; recovery continues in a new run",
    });
    return true;
  }

  reconcileInterruptedRuns(): string[] {
    const rows = this.database.prepare("SELECT id FROM runs WHERE status IN ('planning', 'running', 'awaiting_approval') ORDER BY created_at").all() as unknown as Array<{ id: string }>;
    for (const row of rows) {
      this.pauseRun(row.id, "Run paused automatically because the DevHarmonics process restarted");
    }
    return rows.map((row) => row.id);
  }

  requestPlanApproval(runId: string): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run '${runId}' was not found`);
    assertRunTransition(run.status, "awaiting_approval");
    this.database.prepare("UPDATE runs SET status = 'awaiting_approval', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
    this.addEvent(runId, "plan.awaiting_approval", "Plan is waiting for user approval");
  }

  approvePlan(runId: string): boolean {
    const run = this.getRun(runId);
    if (!run || run.status !== "awaiting_approval") return false;
    assertRunTransition(run.status, "running");
    this.database.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
    this.addEvent(runId, "plan.approved", "Plan approved for execution");
    return true;
  }

  finishAttempt(
    attemptId: number,
    status: string,
    output: string,
    error = "",
    receipt: AttemptCompletionReceipt = {},
  ): void {
    this.database
      .prepare(
        `UPDATE attempts SET status = ?, output = ?, error = ?, finished_at = ?,
          model_id = COALESCE(?, model_id),
          model_resolution = COALESCE(?, model_resolution),
          failure_kind = COALESCE(?, failure_kind),
          result_envelope_json = COALESCE(?, result_envelope_json),
          input_tokens = COALESCE(?, input_tokens),
          output_tokens = COALESCE(?, output_tokens),
          cost_usd = COALESCE(?, cost_usd),
          fallback_reason = COALESCE(?, fallback_reason)
         WHERE id = ?`,
      )
      .run(
        status,
        redactText(output),
        redactText(error),
        new Date().toISOString(),
        receipt.modelId ?? null,
        receipt.modelResolution ?? null,
        receipt.failureKind ?? null,
        receipt.resultEnvelope ? JSON.stringify(redactValue(receipt.resultEnvelope)) : null,
        receipt.inputTokens ?? null,
        receipt.outputTokens ?? null,
        receipt.costUsd ?? null,
        receipt.fallbackReason ?? null,
        attemptId,
      );
  }

  addBlackboardEntry(input: Omit<BlackboardEntry, "id" | "createdAt">): BlackboardEntry {
    const createdAt = new Date().toISOString();
    const content = redactText(input.content);
    const result = this.database.prepare("INSERT INTO blackboard_entries (run_id, task_id, kind, content, source_attempt_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.runId, input.taskId, input.kind, content, input.sourceAttemptId, createdAt);
    return { ...input, id: Number(result.lastInsertRowid), content, createdAt };
  }

  listBlackboardEntries(runId: string, taskId?: string): BlackboardEntry[] {
    const rows = (taskId
      ? this.database.prepare("SELECT * FROM blackboard_entries WHERE run_id = ? AND (task_id = ? OR task_id IS NULL) ORDER BY id").all(runId, taskId)
      : this.database.prepare("SELECT * FROM blackboard_entries WHERE run_id = ? ORDER BY id").all(runId)) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), runId: String(row.run_id), taskId: row.task_id === null ? null : String(row.task_id), kind: String(row.kind) as BlackboardEntry["kind"], content: String(row.content), sourceAttemptId: row.source_attempt_id === null ? null : Number(row.source_attempt_id), createdAt: String(row.created_at) }));
  }

  recordCheck(runId: string, taskId: string, result: CheckResult): void {
    this.database
      .prepare(
        `INSERT INTO checks
          (run_id, task_id, name, passed, exit_code, stdout, stderr, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        taskId,
        result.name,
        result.passed ? 1 : 0,
        result.exitCode,
        redactText(result.stdout),
        redactText(result.stderr),
        result.durationMs,
        new Date().toISOString(),
      );
  }

  addEvent(runId: string, kind: RunEventKind, message: string, data: RunEventData = {}): number {
    const safeData = redactValue(data);
    const result = this.database
      .prepare(
        "INSERT INTO events (run_id, kind, message, data_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        kind,
        redactText(message),
        JSON.stringify(safeData),
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string, options: { after?: number; limit?: number } = {}): RunEvent[] {
    const after = options.after ?? 0;
    const limit = options.limit ?? 200;
    this.assertEventPage(after, limit);
    const rows = this.database
      .prepare(
        "SELECT id, run_id, kind, message, data_json, created_at FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?",
      )
      .all(runId, after, limit) as unknown as EventRow[];
    return rows.map((event) => this.mapEvent(event));
  }

  listAllEvents(options: { after?: number; limit?: number } = {}): RunEvent[] {
    const after = options.after ?? 0;
    const limit = options.limit ?? 200;
    this.assertEventPage(after, limit);
    const rows = this.database
      .prepare(
        "SELECT id, run_id, kind, message, data_json, created_at FROM events WHERE id > ? ORDER BY id LIMIT ?",
      )
      .all(after, limit) as unknown as EventRow[];
    return rows.map((event) => this.mapEvent(event));
  }

  listRuns(): RunSummary[] {
    const rows = this.database
      .prepare("SELECT id FROM runs ORDER BY created_at DESC LIMIT 50")
      .all() as unknown as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)).filter((run): run is RunSummary => run !== null);
  }

  /**
   * Gate finding M-50-limit. Projection-specific complete read: EVERY run
   * the ledger has ever recorded, not just the 50 most recent `listRuns()`
   * serves to the `/api/runs` sidebar (left unchanged — that endpoint is
   * deliberately a recent-activity list, polled frequently by the cockpit
   * heartbeat, and was never the thing making a completeness promise).
   * `/api/inbox` (items + program) and `/api/status-export` promise "every
   * decision ... across every run" and "every run the ledger knows about"
   * (src/ui/index.html) — reusing the 50-row sidebar query there meant an
   * old awaiting-approval plan, a paused run, or a pending delivery step
   * fell out of view the instant a 51st run existed, even though the
   * ledger still held it. That is a silent loss of an owner-actionable
   * decision, not a cosmetic gap.
   *
   * Choice + cost, so the tradeoff is explicit rather than assumed: an
   * unlimited scan (no targeted "non-terminal OR has a delivery" filter)
   * was chosen over a targeted query because the Program status view's own
   * promised text is "every run the ledger knows about" — a targeted
   * filter would still under-report an old terminal run's `finished` bucket
   * membership once it ages out, quietly reintroducing the same class of
   * gap this fix exists to close. Cost: one indexed `SELECT id` plus one
   * `getRun()` per run — each `getRun()` is itself 3 further indexed
   * queries (tasks, checks, and an events page capped at 200) — so this is
   * O(N) in the LIFETIME run count for one project's ledger, not O(1) like
   * the sidebar's capped query. That is acceptable here because this query
   * backs three deliberately infrequent, owner-initiated actions (opening
   * the Inbox tab, opening Program status, downloading a status export) —
   * never the polled sidebar or cockpit heartbeat — so the added latency is
   * paid only when an owner actually opens one of those views, not on every
   * refresh tick.
   */
  listAllRuns(): RunSummary[] {
    const rows = this.database
      .prepare("SELECT id FROM runs ORDER BY created_at DESC")
      .all() as unknown as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)).filter((run): run is RunSummary => run !== null);
  }

  getRun(runId: string): RunSummary | null {
    const run = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    if (!run) return null;

    const tasks = this.database
      .prepare(
        "SELECT task_id, title, description, task_contract_json, status, provider, attempt_count FROM tasks WHERE run_id = ? ORDER BY rowid",
      )
      .all(runId) as unknown as TaskRow[];
    const checks = this.database
      .prepare(
        "SELECT task_id, name, passed, exit_code, stdout, stderr, duration_ms FROM checks WHERE run_id = ? ORDER BY id",
      )
      .all(runId) as unknown as CheckRow[];
    const events = this.database
      .prepare(
        "SELECT id, run_id, kind, message, data_json, created_at FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 200",
      )
      .all(runId) as unknown as EventRow[];

    return {
      id: run.id,
      goal: run.goal,
      goalSummary: summarizeGoal(run.goal),
      projectPath: run.project_path,
      autonomy: parseRunAutonomy(run.autonomy),
      status: parseRunStatus(run.status),
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      finalReview: run.final_review,
      resumedFrom: run.resumed_from,
      objectiveId: run.objective_id,
      approvedPlanRevision: run.approved_plan_revision,
      workflowRevisionHash: run.workflow_revision_hash ?? null,
      plan: run.plan_json ? JSON.parse(run.plan_json) as RunPlan : null,
      integrationSet: this.getIntegrationSet(runId),
      delivery: this.getDeliveryHandoff(runId),
      tasks: tasks.map((task) => {
        const contract = JSON.parse(task.task_contract_json || "{}") as Partial<PlannedTask>;
        return {
          id: task.task_id,
          title: task.title,
          description: task.description,
          kind: contract.kind ?? "implementation",
          repositoryIds: contract.repositoryIds ?? [],
          repositoryScope: contract.repositoryScope ?? ["."],
          permission: contract.permission ?? "workspace_write",
          risk: contract.risk ?? "medium",
          acceptanceCriteria: contract.acceptanceCriteria ?? [],
          expectedArtifacts: contract.expectedArtifacts ?? [],
          status: parseTaskStatus(task.status),
          provider: task.provider,
          assignment: task.provider && isSubscriptionProvider(task.provider) ? projectLegacyProvider(task.provider) : null,
          attemptCount: task.attempt_count,
          checks: checks
            .filter((check) => check.task_id === task.task_id)
            .map((check) => ({
              name: check.name,
              passed: Boolean(check.passed),
              exitCode: check.exit_code,
              stdout: check.stdout,
              stderr: check.stderr,
              durationMs: check.duration_ms,
            })),
        };
      }),
      events: events.map((event) => this.mapEvent(event)),
    };
  }

  getRunEvidence(runId: string): RunEvidencePackage | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const attempts = this.database.prepare(
      `SELECT id, task_id, provider, status, output, error, started_at, finished_at,
        connection_id, model_id, model_resolution, model_settings_json, adapter_version,
        runtime_version, failure_kind, result_envelope_json
       FROM attempts WHERE run_id = ? ORDER BY id`,
    ).all(runId) as unknown as Array<Record<string, unknown>>;
    const normalizedAttempts = attempts.map((attempt) => ({
      ...attempt,
      model_settings: JSON.parse(String(attempt.model_settings_json ?? "{}")),
      result_envelope: attempt.result_envelope_json ? JSON.parse(String(attempt.result_envelope_json)) : null,
      model_settings_json: undefined,
      result_envelope_json: undefined,
    }));
    const blackboard = this.listBlackboardEntries(runId);
    const toolReceipts = this.listToolPolicyReceipts(runId);
    const reviews = this.listReviewReceipts(runId);
    const integrationSet = this.getIntegrationSet(runId);
    const delivery = this.getDeliveryHandoff(runId);
    const canonical = JSON.stringify({ run, attempts: normalizedAttempts, blackboard, toolReceipts, reviews, integrationSet, delivery });
    return {
      version: 5,
      generatedAt: new Date().toISOString(),
      run,
      attempts: normalizedAttempts,
      blackboard,
      toolReceipts,
      reviews,
      integrationSet,
      delivery,
      integritySha256: createHash("sha256").update(canonical).digest("hex"),
    };
  }

  addTask(runId: string, task: PlannedTask): void {
    this.database.prepare(
      `INSERT INTO tasks
       (run_id, task_id, title, description, dependencies_json, checks_json, status, preferred_provider, task_contract_json)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      runId,
      task.id,
      redactText(task.title),
      redactText(task.description),
      JSON.stringify(task.dependencies),
      JSON.stringify(task.checks),
      task.preferredProvider,
      JSON.stringify(redactValue({
        kind: task.kind ?? "implementation",
        repositoryIds: task.repositoryIds ?? [],
        repositoryScope: task.repositoryScope ?? ["."],
        permission: task.permission ?? "workspace_write",
        risk: task.risk ?? "medium",
        capabilityNeeds: task.capabilityNeeds ?? ["code"],
        acceptanceCriteria: task.acceptanceCriteria ?? [],
        expectedArtifacts: task.expectedArtifacts ?? [],
      })),
    );
  }

  listModelPerformanceProfiles(modelId?: string): ModelPerformanceProfile[] {
    const rows = (modelId
      ? this.database.prepare(
          `SELECT a.id, a.run_id, a.task_id, a.model_id, a.provider, a.status, a.failure_kind,
           a.result_envelope_json, a.cost_usd, a.started_at, a.finished_at, t.task_contract_json, r.status AS run_status,
           (SELECT COUNT(*) FROM checks c
            WHERE c.run_id = a.run_id AND c.task_id = a.task_id AND c.passed = 0
            AND c.created_at >= COALESCE(a.finished_at, a.started_at)
            AND NOT EXISTS (SELECT 1 FROM attempts n WHERE n.run_id = a.run_id AND n.task_id = a.task_id AND n.id > a.id AND n.started_at <= c.created_at)) AS validator_failure_count,
           (SELECT COUNT(*) FROM events e WHERE e.run_id = a.run_id AND e.kind = 'task.integration_conflict'
            AND CAST(json_extract(e.data_json, '$.attemptId') AS INTEGER) = a.id) AS integration_conflict_count
           FROM attempts a LEFT JOIN tasks t ON t.run_id = a.run_id AND t.task_id = a.task_id LEFT JOIN runs r ON r.id = a.run_id
           WHERE a.model_id = ? ORDER BY a.id`,
        ).all(modelId)
      : this.database.prepare(
          `SELECT a.id, a.run_id, a.task_id, a.model_id, a.provider, a.status, a.failure_kind,
           a.result_envelope_json, a.cost_usd, a.started_at, a.finished_at, t.task_contract_json, r.status AS run_status,
           (SELECT COUNT(*) FROM checks c
            WHERE c.run_id = a.run_id AND c.task_id = a.task_id AND c.passed = 0
            AND c.created_at >= COALESCE(a.finished_at, a.started_at)
            AND NOT EXISTS (SELECT 1 FROM attempts n WHERE n.run_id = a.run_id AND n.task_id = a.task_id AND n.id > a.id AND n.started_at <= c.created_at)) AS validator_failure_count,
           (SELECT COUNT(*) FROM events e WHERE e.run_id = a.run_id AND e.kind = 'task.integration_conflict'
            AND CAST(json_extract(e.data_json, '$.attemptId') AS INTEGER) = a.id) AS integration_conflict_count
           FROM attempts a LEFT JOIN tasks t ON t.run_id = a.run_id AND t.task_id = a.task_id LEFT JOIN runs r ON r.id = a.run_id
           WHERE a.model_id IS NOT NULL ORDER BY a.id`,
        ).all()) as unknown as Array<Record<string, unknown>>;
    const reviewerRows = (modelId
      ? this.database.prepare(
          `SELECT ir.id, ir.run_id, ir.task_id, ir.provider,
           COALESCE(ir.requested_model_id, ir.resolved_model_id) AS model_id,
           ir.cost_usd, ir.duration_ms, ir.workload_class, ir.created_at, r.status AS run_status
           FROM invocation_receipts ir LEFT JOIN runs r ON r.id = ir.run_id
           WHERE ir.role = 'reviewer' AND COALESCE(ir.requested_model_id, ir.resolved_model_id) = ?
           ORDER BY ir.id`,
        ).all(modelId)
      : this.database.prepare(
          `SELECT ir.id, ir.run_id, ir.task_id, ir.provider,
           COALESCE(ir.requested_model_id, ir.resolved_model_id) AS model_id,
           ir.cost_usd, ir.duration_ms, ir.workload_class, ir.created_at, r.status AS run_status
           FROM invocation_receipts ir LEFT JOIN runs r ON r.id = ir.run_id
           WHERE ir.role = 'reviewer' AND COALESCE(ir.requested_model_id, ir.resolved_model_id) IS NOT NULL
           ORDER BY ir.id`,
        ).all()) as unknown as Array<Record<string, unknown>>;
    const policies = new Map(this.listModelPerformancePolicies().map((policy) => [policy.modelId, policy]));
    const attemptObservations: ModelPerformanceObservation[] = rows.map((row) => {
      const envelope = row.result_envelope_json ? JSON.parse(String(row.result_envelope_json)) as Partial<AgentResultEnvelope> : null;
      const task = JSON.parse(String(row.task_contract_json ?? "{}")) as PlannedTask;
      const workload = classifyWorkload("worker", task);
      return {
        id: Number(row.id),
        runId: String(row.run_id),
        taskId: String(row.task_id),
        modelId: String(row.model_id),
        provider: String(row.provider),
        status: String(row.status),
        failureKind: row.failure_kind === null ? null : String(row.failure_kind),
        malformedSource: envelope?.malformedSource === true,
        workloadClass: `${workload.complexity}:${workload.requiredTier}`,
        validatorFailureCount: Number(row.validator_failure_count ?? 0),
        integrationConflictCount: Number(row.integration_conflict_count ?? 0),
        runNotReady: row.run_status === "not_ready",
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
        startedAt: String(row.started_at),
        finishedAt: row.finished_at === null ? null : String(row.finished_at),
      };
    });
    const reviewerObservations: ModelPerformanceObservation[] = reviewerRows.map((row) => {
      const createdAt = String(row.created_at);
      const durationMs = row.duration_ms === null ? null : Number(row.duration_ms);
      const receiptId = Number(row.id);
      return {
        id: 1_000_000_000 + receiptId,
        runId: String(row.run_id),
        taskId: row.task_id === null ? `__review__:${receiptId}` : String(row.task_id),
        modelId: String(row.model_id),
        provider: String(row.provider),
        status: "completed",
        failureKind: null,
        malformedSource: false,
        workloadClass: String(row.workload_class ?? "complex:premium"),
        validatorFailureCount: 0,
        integrationConflictCount: 0,
        runNotReady: row.run_status === "not_ready",
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
        startedAt: durationMs === null ? createdAt : new Date(Date.parse(createdAt) - durationMs).toISOString(),
        finishedAt: durationMs === null ? null : createdAt,
      };
    });
    const observations = [...attemptObservations, ...reviewerObservations].filter((observation) => {
      const ignoredBefore = policies.get(observation.modelId)?.ignoredBefore;
      return !ignoredBefore || observation.startedAt >= ignoredBefore;
    });
    return aggregateModelPerformance(observations).map((profile) => {
      const excluded = policies.get(profile.modelId)?.excluded === true;
      return excluded ? { ...profile, observationsExcluded: true, eligibleForAdaptiveWeighting: false } : profile;
    });
  }

  listModelPerformancePolicies(): ModelPerformancePolicyRecord[] {
    const rows = this.database.prepare("SELECT * FROM model_performance_policies ORDER BY model_id").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      modelId: String(row.model_id),
      ignoredBefore: row.ignored_before === null ? null : String(row.ignored_before),
      excluded: Boolean(row.excluded),
      updatedAt: String(row.updated_at),
    }));
  }

  setModelPerformancePolicy(modelId: string, input: { ignoredBefore?: string | null; excluded?: boolean }): ModelPerformancePolicyRecord {
    const current = this.listModelPerformancePolicies().find((policy) => policy.modelId === modelId);
    const ignoredBefore = input.ignoredBefore === undefined ? current?.ignoredBefore ?? null : input.ignoredBefore;
    if (ignoredBefore !== null && !Number.isFinite(Date.parse(ignoredBefore))) throw new Error("Observation baseline must be an ISO timestamp");
    const excluded = input.excluded ?? current?.excluded ?? false;
    const updatedAt = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO model_performance_policies (model_id, ignored_before, excluded, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET ignored_before = excluded.ignored_before,
       excluded = excluded.excluded, updated_at = excluded.updated_at`,
    ).run(modelId, ignoredBefore, excluded ? 1 : 0, updatedAt);
    return { modelId, ignoredBefore, excluded, updatedAt };
  }

  upsertRepository(input: RepositoryUpsertInput): RepositoryRecord {
    const repository = repositoryUpsertSchema.parse(input) as RepositoryUpsertInput;
    const product = this.database.prepare("SELECT 1 AS present FROM products WHERE id = ?").get(repository.productId);
    if (!product) throw new Error(`Product '${repository.productId}' was not found`);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO repositories (
        id, product_id, name, full_name, url, clone_url, default_branch, visibility,
        archived, size_kb, language, description, intelligence_json, observed_at,
        local_path, repository_role, expected_branch, owners_json, dependency_repository_ids_json,
        validators_json, governance_sources_json, governance_rules_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        product_id = excluded.product_id, name = excluded.name, full_name = excluded.full_name,
        url = excluded.url, clone_url = excluded.clone_url, default_branch = excluded.default_branch,
        visibility = excluded.visibility, archived = excluded.archived, size_kb = excluded.size_kb,
        language = excluded.language, description = excluded.description,
        intelligence_json = excluded.intelligence_json, observed_at = excluded.observed_at,
        local_path = excluded.local_path, repository_role = excluded.repository_role,
        expected_branch = excluded.expected_branch, owners_json = excluded.owners_json,
        dependency_repository_ids_json = excluded.dependency_repository_ids_json,
        validators_json = excluded.validators_json, governance_sources_json = excluded.governance_sources_json,
        governance_rules_json = excluded.governance_rules_json
    `).run(
      repository.id,
      repository.productId,
      redactText(repository.name),
      repository.fullName,
      repository.url,
      sanitizedRemoteUrl(repository.cloneUrl),
      repository.defaultBranch,
      repository.visibility,
      repository.archived ? 1 : 0,
      repository.sizeKb,
      repository.language,
      repository.description === null ? null : redactText(repository.description),
      JSON.stringify(redactValue(repository.intelligence)),
      now,
      repository.localPath,
      repository.role,
      repository.expectedBranch,
      JSON.stringify(repository.owners.map(redactText)),
      JSON.stringify(repository.dependencyRepositoryIds),
      JSON.stringify(redactValue(repository.validators)),
      JSON.stringify(repository.governanceSources),
      JSON.stringify(repository.governanceRules.map(redactText)),
    );
    return this.getRepository(repository.id)!;
  }

  getRepository(repositoryId: string): RepositoryRecord | null {
    const row = this.database.prepare("SELECT * FROM repositories WHERE id = ?").get(repositoryId) as Record<string, unknown> | undefined;
    return row ? repositoryRecordFromRow(row) : null;
  }

  listRepositories(productId?: string): RepositoryRecord[] {
    const rows = (productId
      ? this.database.prepare("SELECT * FROM repositories WHERE product_id = ? ORDER BY name, id").all(productId)
      : this.database.prepare("SELECT * FROM repositories ORDER BY product_id, name, id").all()) as unknown as Array<Record<string, unknown>>;
    return rows.map(repositoryRecordFromRow);
  }

  recordRepositoryInspection(repositoryId: string, input: RepositoryInspectionInput): RepositoryRecord {
    const inspection = repositoryInspectionSchema.parse(input) as RepositoryInspectionInput;
    if (!this.getRepository(repositoryId)) throw new Error(`Repository '${repositoryId}' was not found`);
    const checkedAt = inspection.checkedAt ?? new Date().toISOString();
    this.database.prepare(`
      UPDATE repositories SET current_branch = ?, head_sha = ?, remote_url = ?, dirty = ?,
        compatibility_issues_json = ?, checked_at = ?
      WHERE id = ?
    `).run(
      inspection.currentBranch,
      inspection.headSha,
      sanitizedRemoteUrl(inspection.remoteUrl),
      inspection.dirty ? 1 : 0,
      JSON.stringify(inspection.compatibilityIssues.map(redactText)),
      checkedAt,
      repositoryId,
    );
    return this.getRepository(repositoryId)!;
  }

  upsertProduct(input: ProductRegistration): ProductRecord {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO products (id, name, organization_url, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name,
          organization_url = excluded.organization_url,
          description = excluded.description,
          updated_at = excluded.updated_at
      `).run(input.id, redactText(input.name), input.organizationUrl, redactText(input.description), now, now);
      const repository = this.database.prepare(`
        INSERT INTO repositories
          (id, product_id, name, full_name, url, clone_url, default_branch, visibility,
           archived, size_kb, language, description, intelligence_json, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id, name = excluded.name,
          full_name = excluded.full_name, url = excluded.url, clone_url = excluded.clone_url,
          default_branch = excluded.default_branch, visibility = excluded.visibility,
          archived = excluded.archived, size_kb = excluded.size_kb, language = excluded.language,
          description = excluded.description, intelligence_json = excluded.intelligence_json,
          observed_at = excluded.observed_at
      `);
      for (const item of input.repositories) {
        repository.run(item.id, input.id, redactText(item.name), item.fullName, item.url, item.cloneUrl,
          item.defaultBranch, item.visibility, item.archived ? 1 : 0, item.sizeKb, item.language,
          item.description === null ? null : redactText(item.description), JSON.stringify(redactValue(item.intelligence)), now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const product = this.getProduct(input.id);
    if (!product) throw new Error(`Product '${input.id}' was not saved`);
    return product;
  }

  listProducts(): ProductRecord[] {
    const rows = this.database.prepare("SELECT id FROM products ORDER BY updated_at DESC").all() as unknown as Array<{ id: string }>;
    return rows.map((row) => this.getProduct(row.id)).filter((product): product is ProductRecord => product !== null);
  }

  getProduct(productId: string): ProductRecord | null {
    const product = this.database.prepare("SELECT * FROM products WHERE id = ?").get(productId) as Record<string, unknown> | undefined;
    if (!product) return null;
    const repositories = this.database.prepare("SELECT * FROM repositories WHERE product_id = ? ORDER BY name").all(productId) as unknown as Array<Record<string, unknown>>;
    return {
      id: String(product.id),
      name: String(product.name),
      organizationUrl: String(product.organization_url),
      description: String(product.description),
      repositories: repositories.map(repositoryRecordFromRow),
      createdAt: String(product.created_at),
      updatedAt: String(product.updated_at),
    };
  }

  upsertConnection(input: ConnectionRegistryInput): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO provider_connections
          (id, provider, transport, authentication, display_name, enabled, installed,
           authenticated, visible, healthy, available, entitlement, capacity,
           adapter_version, runtime_version, metadata_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           transport = excluded.transport,
           authentication = excluded.authentication,
           display_name = excluded.display_name,
           enabled = excluded.enabled,
           installed = excluded.installed,
           authenticated = excluded.authenticated,
           visible = excluded.visible,
           healthy = excluded.healthy,
           available = excluded.available,
           entitlement = excluded.entitlement,
           capacity = excluded.capacity,
           adapter_version = excluded.adapter_version,
           runtime_version = excluded.runtime_version,
           metadata_json = excluded.metadata_json,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        input.id,
        input.provider,
        input.transport,
        input.authentication,
        redactText(input.displayName),
        input.enabled ? 1 : 0,
        input.installed ? 1 : 0,
        input.authenticated ? 1 : 0,
        input.visible ? 1 : 0,
        input.healthy ? 1 : 0,
        input.available ? 1 : 0,
        input.entitlement,
        input.capacity,
        input.adapterVersion,
        input.runtimeVersion,
        JSON.stringify(redactValue(input.metadata)),
        now,
        now,
      );
  }

  listConnections(): ConnectionRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM provider_connections ORDER BY provider, id")
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      transport: String(row.transport) as ConnectionRecord["transport"],
      authentication: String(row.authentication) as ConnectionRecord["authentication"],
      displayName: String(row.display_name),
      enabled: Boolean(row.enabled),
      installed: Boolean(row.installed),
      authenticated: Boolean(row.authenticated),
      visible: Boolean(row.visible),
      healthy: Boolean(row.healthy),
      available: Boolean(row.available),
      entitlement: String(row.entitlement),
      capacity: String(row.capacity),
      adapterVersion: String(row.adapter_version),
      runtimeVersion: row.runtime_version === null ? null : String(row.runtime_version),
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
    }));
  }

  recordConnectionOutcome(connectionId: string, input: { success: boolean; failureKind?: string | null; detail?: string }): ConnectionHealthRecord {
    const connection = this.database.prepare("SELECT 1 AS present FROM provider_connections WHERE id = ?").get(connectionId);
    if (!connection) throw new Error(`Provider connection '${connectionId}' was not found`);
    const previous = this.database.prepare("SELECT consecutive_failures FROM connection_health WHERE connection_id = ?").get(connectionId) as { consecutive_failures: number } | undefined;
    const failures = input.success ? 0 : (previous?.consecutive_failures ?? 0) + 1;
    const failureKind = input.success ? null : input.failureKind ?? "unknown";
    const failureCode = failureKind ?? "unknown";
    const state = input.success ? "ready" : healthState(failureCode);
    const now = new Date();
    const cooldownMs = input.success ? 0 : healthCooldownMs(failureCode, failures);
    const cooldownUntil = cooldownMs ? new Date(now.getTime() + cooldownMs).toISOString() : null;
    this.database.prepare(
      `INSERT INTO connection_health (connection_id, state, failure_kind, consecutive_failures, cooldown_until, detail, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET state = excluded.state, failure_kind = excluded.failure_kind,
         consecutive_failures = excluded.consecutive_failures, cooldown_until = excluded.cooldown_until,
         detail = excluded.detail, last_checked_at = excluded.last_checked_at`,
    ).run(connectionId, state, failureKind, failures, cooldownUntil, redactText(input.detail ?? (input.success ? "Invocation succeeded" : "Invocation failed")), now.toISOString());
    return this.getConnectionHealth(connectionId)!;
  }

  getConnectionHealth(connectionId: string): ConnectionHealthRecord | null {
    const row = this.database.prepare("SELECT * FROM connection_health WHERE connection_id = ?").get(connectionId) as Record<string, unknown> | undefined;
    return row ? mapConnectionHealth(row) : null;
  }

  listConnectionHealth(): ConnectionHealthRecord[] {
    return (this.database.prepare("SELECT * FROM connection_health ORDER BY connection_id").all() as unknown as Array<Record<string, unknown>>).map(mapConnectionHealth);
  }

  isConnectionEligible(connectionId: string, at = new Date()): boolean {
    const health = this.getConnectionHealth(connectionId);
    if (!health) return true;
    if (["authentication", "unavailable"].includes(health.state)) return false;
    return !health.cooldownUntil || Date.parse(health.cooldownUntil) <= at.getTime();
  }

  recordModelOutcome(modelId: string, input: { success: boolean; failureKind?: string | null; detail?: string }): ModelHealthRecord {
    if (!this.getModel(modelId)) throw new Error(`Model '${modelId}' was not found`);
    const previous = this.database.prepare("SELECT consecutive_failures FROM model_health WHERE model_id = ?").get(modelId) as { consecutive_failures: number } | undefined;
    const failures = input.success ? 0 : (previous?.consecutive_failures ?? 0) + 1;
    const failureKind = input.success ? null : input.failureKind ?? "unknown";
    const failureCode = failureKind ?? "unknown";
    const state = input.success ? "ready" : healthState(failureCode);
    const now = new Date();
    const cooldownMs = input.success ? 0 : healthCooldownMs(failureCode, failures);
    const cooldownUntil = cooldownMs ? new Date(now.getTime() + cooldownMs).toISOString() : null;
    this.database.prepare(
      `INSERT INTO model_health (model_id, state, failure_kind, consecutive_failures, cooldown_until, detail, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET state = excluded.state, failure_kind = excluded.failure_kind,
         consecutive_failures = excluded.consecutive_failures, cooldown_until = excluded.cooldown_until,
         detail = excluded.detail, last_checked_at = excluded.last_checked_at`,
    ).run(modelId, state, failureKind, failures, cooldownUntil, redactText(input.detail ?? (input.success ? "Invocation succeeded" : "Invocation failed")), now.toISOString());
    this.database.prepare(
      `UPDATE models SET degraded = ?, lifecycle = CASE
         WHEN ? = 1 THEN 'degraded'
         WHEN active = 1 THEN 'active'
         WHEN qualified = 1 THEN 'qualified'
         ELSE lifecycle END
       WHERE id = ?`,
    ).run(input.success ? 0 : 1, input.success ? 0 : 1, modelId);
    return this.getModelHealth(modelId)!;
  }

  getModelHealth(modelId: string): ModelHealthRecord | null {
    const row = this.database.prepare("SELECT * FROM model_health WHERE model_id = ?").get(modelId) as Record<string, unknown> | undefined;
    return row ? mapModelHealth(row) : null;
  }

  listModelHealth(): ModelHealthRecord[] {
    return (this.database.prepare("SELECT * FROM model_health ORDER BY model_id").all() as unknown as Array<Record<string, unknown>>).map(mapModelHealth);
  }

  isModelEligible(modelId: string, at = new Date()): boolean {
    const health = this.getModelHealth(modelId);
    if (!health) return true;
    if (["authentication", "unavailable"].includes(health.state)) return false;
    return !health.cooldownUntil || Date.parse(health.cooldownUntil) <= at.getTime();
  }

  recordQuotaGroupOutcome(
    connectionId: string,
    quotaGroupId: string,
    displayName: string,
    input: { success: boolean; failureKind?: string | null; detail?: string; cooldownUntil?: string | null },
  ): QuotaGroupHealthRecord {
    const connection = this.database.prepare("SELECT 1 AS present FROM provider_connections WHERE id = ?").get(connectionId);
    if (!connection) throw new Error(`Provider connection '${connectionId}' was not found`);
    const previous = this.getQuotaGroupHealth(connectionId, quotaGroupId);
    const now = new Date();
    // A provider-supplied quota reset is authoritative. A late success from an
    // older in-flight request must not erase a newer exhaustion observation.
    if (input.success && previous?.cooldownUntil && Date.parse(previous.cooldownUntil) > now.getTime()) return previous;
    const failures = input.success ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
    const failureKind = input.success ? null : input.failureKind ?? "unknown";
    const state = input.success ? "ready" : healthState(failureKind ?? "unknown");
    const cooldownUntil = input.success
      ? null
      : input.cooldownUntil ?? (() => {
          const cooldownMs = healthCooldownMs(failureKind ?? "unknown", failures);
          return cooldownMs ? new Date(now.getTime() + cooldownMs).toISOString() : null;
        })();
    this.database.prepare(
      `INSERT INTO quota_group_health
       (connection_id, quota_group_id, display_name, state, failure_kind, consecutive_failures, cooldown_until, detail, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, quota_group_id) DO UPDATE SET display_name = excluded.display_name,
         state = excluded.state, failure_kind = excluded.failure_kind, consecutive_failures = excluded.consecutive_failures,
         cooldown_until = excluded.cooldown_until, detail = excluded.detail, last_checked_at = excluded.last_checked_at`,
    ).run(connectionId, quotaGroupId, displayName, state, failureKind, failures, cooldownUntil, redactText(input.detail ?? (input.success ? "Invocation succeeded" : "Quota group unavailable")), now.toISOString());
    return this.getQuotaGroupHealth(connectionId, quotaGroupId)!;
  }

  getQuotaGroupHealth(connectionId: string, quotaGroupId: string): QuotaGroupHealthRecord | null {
    const row = this.database.prepare("SELECT * FROM quota_group_health WHERE connection_id = ? AND quota_group_id = ?").get(connectionId, quotaGroupId) as Record<string, unknown> | undefined;
    return row ? mapQuotaGroupHealth(row) : null;
  }

  listQuotaGroupHealth(connectionId?: string): QuotaGroupHealthRecord[] {
    const rows = (connectionId
      ? this.database.prepare("SELECT * FROM quota_group_health WHERE connection_id = ? ORDER BY quota_group_id").all(connectionId)
      : this.database.prepare("SELECT * FROM quota_group_health ORDER BY connection_id, quota_group_id").all()) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapQuotaGroupHealth);
  }

  isQuotaGroupEligible(connectionId: string, quotaGroupId: string, at = new Date()): boolean {
    const health = this.getQuotaGroupHealth(connectionId, quotaGroupId);
    if (!health) return true;
    return !health.cooldownUntil || Date.parse(health.cooldownUntil) <= at.getTime();
  }

  reconcileLegacyAntigravityQuotaHealth(): number {
    const rows = this.database.prepare(
      `SELECT connection_id, model_id, error, finished_at
       FROM attempts
       WHERE connection_id = 'subscription-cli:gemini'
         AND model_id IS NOT NULL
         AND lower(error) LIKE '%individual quota reached%'
       ORDER BY finished_at DESC`,
    ).all() as unknown as Array<{ connection_id: string; model_id: string; error: string; finished_at: string | null }>;
    const reconciled = new Set<string>();
    const now = new Date();
    for (const row of rows) {
      const model = this.getModel(row.model_id);
      const quotaGroup = modelQuotaGroup(model);
      if (!quotaGroup || reconciled.has(quotaGroup.id)) continue;
      reconciled.add(quotaGroup.id);
      const observedAt = row.finished_at ? new Date(row.finished_at) : now;
      const cooldownUntil = quotaResetAt(row.error, observedAt);
      if (!cooldownUntil || Date.parse(cooldownUntil) <= now.getTime()) continue;
      const current = this.getQuotaGroupHealth(row.connection_id, quotaGroup.id);
      if (current && Date.parse(current.lastCheckedAt) >= observedAt.getTime()) continue;
      this.recordQuotaGroupOutcome(row.connection_id, quotaGroup.id, quotaGroup.displayName, {
        success: false,
        failureKind: "quota_group_exhausted",
        detail: row.error,
        cooldownUntil,
      });
    }
    if (reconciled.size) {
      this.database.prepare(
        "DELETE FROM connection_health WHERE connection_id = 'subscription-cli:gemini' AND lower(detail) LIKE '%individual quota reached%'",
      ).run();
    }
    return reconciled.size;
  }

  addManualModel(input: ManualModelInput): ModelRecord {
    if (!(MODEL_LIFECYCLES as readonly string[]).includes(input.lifecycle)) {
      throw new Error(`Unknown model lifecycle '${input.lifecycle}'`);
    }
    const connection = this.database
      .prepare("SELECT 1 AS present FROM provider_connections WHERE id = ?")
      .get(input.connectionId) as { present: number } | undefined;
    if (!connection) throw new Error(`Provider connection '${input.connectionId}' was not found`);

    const existing = this.database
      .prepare("SELECT connection_id, source FROM models WHERE id = ?")
      .get(input.id) as { connection_id: string; source: string } | undefined;
    if (existing && existing.connection_id !== input.connectionId) {
      throw new Error(`Model '${input.id}' cannot be reassigned to another connection`);
    }
    if (existing && existing.source !== "manual") {
      throw new Error(`Model '${input.id}' is managed by ${existing.source} discovery`);
    }

    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO models
          (id, connection_id, canonical_name, display_name, source, lifecycle, visible,
           verified, qualified, active, degraded, retired, metadata_json, first_seen_at,
           last_seen_at, last_verified_at)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           canonical_name = excluded.canonical_name,
           display_name = excluded.display_name,
           lifecycle = excluded.lifecycle,
           visible = excluded.visible,
           verified = excluded.verified,
           qualified = excluded.qualified,
           active = excluded.active,
           degraded = excluded.degraded,
           retired = excluded.retired,
           metadata_json = excluded.metadata_json,
           last_seen_at = excluded.last_seen_at,
           last_verified_at = CASE
             WHEN excluded.verified = 1 THEN excluded.last_verified_at
             ELSE models.last_verified_at
           END`,
      )
      .run(
        input.id,
        input.connectionId,
        redactText(input.canonicalName),
        redactText(input.displayName),
        input.lifecycle,
        input.visible ? 1 : 0,
        input.verified ? 1 : 0,
        input.qualified ? 1 : 0,
        input.active ? 1 : 0,
        input.lifecycle === "degraded" ? 1 : 0,
        input.lifecycle === "retired" ? 1 : 0,
        JSON.stringify(redactValue(input.metadata)),
        now,
        now,
        input.verified ? now : null,
      );
    return this.listModels(input.connectionId).find((model) => model.id === input.id)!;
  }

  upsertDiscoveredModel(input: ModelDiscoveryInput): void {
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO models
        (id, connection_id, canonical_name, display_name, source, lifecycle, visible,
         verified, qualified, active, degraded, retired, metadata_json, first_seen_at,
         last_seen_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         canonical_name = excluded.canonical_name,
         display_name = excluded.display_name,
         source = excluded.source,
         lifecycle = CASE WHEN models.qualified = 1 THEN models.lifecycle ELSE excluded.lifecycle END,
         visible = excluded.visible,
         metadata_json = excluded.metadata_json,
         last_seen_at = excluded.last_seen_at,
         missing_observations = 0,
         retired = 0`,
    ).run(
      input.id, input.connectionId, redactText(input.canonicalName), redactText(input.displayName),
      input.source, input.lifecycle, input.visible ? 1 : 0, input.verified ? 1 : 0,
      input.qualified ? 1 : 0, input.active ? 1 : 0, input.lifecycle === "degraded" ? 1 : 0,
      input.lifecycle === "retired" ? 1 : 0, JSON.stringify(redactValue(input.metadata)), now, now,
      input.verified ? now : null,
    );
  }

  retireCompatibilityModels(connectionId: string, currentModelIds: readonly string[]): void {
    if (currentModelIds.length === 0) return;
    const placeholders = currentModelIds.map(() => "?").join(", ");
    this.database.prepare(
      `UPDATE models
       SET lifecycle = 'retired', retired = 1, active = 0, excluded = 1, last_seen_at = ?
       WHERE connection_id = ?
         AND source = 'compatibility_catalog'
         AND id NOT IN (${placeholders})`,
    ).run(new Date().toISOString(), connectionId, ...currentModelIds);
  }

  reconcileDiscoveredModels(connectionId: string, source: string, currentModelIds: readonly string[], retirementThreshold = 3): void {
    const now = new Date().toISOString();
    const placeholders = currentModelIds.map(() => "?").join(", ");
    const notIn = currentModelIds.length ? `AND id NOT IN (${placeholders})` : "";
    this.database.prepare(
      `UPDATE models
       SET missing_observations = missing_observations + 1,
           retired = CASE WHEN missing_observations + 1 >= ? THEN 1 ELSE retired END,
           active = CASE WHEN missing_observations + 1 >= ? THEN 0 ELSE active END,
           excluded = CASE WHEN missing_observations + 1 >= ? THEN 1 ELSE excluded END,
           lifecycle = CASE WHEN missing_observations + 1 >= ? THEN 'retired' ELSE lifecycle END,
           last_seen_at = ?
       WHERE connection_id = ? AND source = ? ${notIn}`,
    ).run(retirementThreshold, retirementThreshold, retirementThreshold, retirementThreshold, now, connectionId, source, ...currentModelIds);
  }

  retireInvalidModels(modelIds: readonly string[], reason: string): void {
    if (!modelIds.length) return;
    const placeholders = modelIds.map(() => "?").join(", ");
    this.database.prepare(
      `UPDATE models SET lifecycle = 'retired', retired = 1, active = 0, excluded = 1,
       metadata_json = json_set(metadata_json, '$.retirementReason', ?), last_seen_at = ?
       WHERE id IN (${placeholders})`,
    ).run(redactText(reason), new Date().toISOString(), ...modelIds);
  }

  applyModelFingerprint(modelId: string, fingerprint: string): { changed: boolean; stale: boolean } {
    const model = this.getModel(modelId);
    if (!model) throw new Error(`Model '${modelId}' was not found`);
    const changed = model.qualificationFingerprint !== fingerprint;
    const stale = model.qualified && changed;
    this.database.prepare(
      `UPDATE models SET qualification_fingerprint = ?, qualification_stale = ?,
       lifecycle = CASE WHEN ? = 1 AND qualified = 1 THEN 'qualified' ELSE lifecycle END
       WHERE id = ?`,
    ).run(fingerprint, model.qualified ? (stale ? 1 : model.qualificationStale ? 1 : 0) : 0, stale ? 1 : 0, modelId);
    return { changed, stale };
  }

  recordCatalogRefresh(input: Omit<CatalogRefreshRecord, "refreshedAt"> & { refreshedAt?: string }): CatalogRefreshRecord {
    const refreshedAt = input.refreshedAt ?? new Date().toISOString();
    this.database.prepare(
      `INSERT INTO catalog_refreshes (provider, status, source, model_count, detail, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET status = excluded.status, source = excluded.source,
       model_count = excluded.model_count, detail = excluded.detail, refreshed_at = excluded.refreshed_at`,
    ).run(input.provider, input.status, input.source, input.modelCount, redactText(input.detail), refreshedAt);
    return { ...input, detail: redactText(input.detail), refreshedAt };
  }

  listCatalogRefreshes(): CatalogRefreshRecord[] {
    const rows = this.database.prepare("SELECT * FROM catalog_refreshes ORDER BY provider").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ provider: String(row.provider), status: String(row.status) as CatalogRefreshRecord["status"], source: String(row.source), modelCount: Number(row.model_count), detail: String(row.detail), refreshedAt: String(row.refreshed_at) }));
  }

  upsertProviderCatalogModels(provider: string, models: ReadonlyArray<{ id: string; canonicalName: string; displayName: string; metadata: Readonly<Record<string, unknown>> }>, retirementThreshold = 3): void {
    const now = new Date().toISOString();
    const seen = models.map((model) => model.id);
    const upsert = this.database.prepare(
      `INSERT INTO provider_catalog_models (id, provider, canonical_name, display_name, metadata_json, first_seen_at, last_seen_at, missing_observations, retired)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
       ON CONFLICT(id) DO UPDATE SET canonical_name = excluded.canonical_name, display_name = excluded.display_name,
       metadata_json = excluded.metadata_json, last_seen_at = excluded.last_seen_at, missing_observations = 0, retired = 0`,
    );
    for (const model of models) upsert.run(model.id, provider, model.canonicalName, model.displayName, JSON.stringify(redactValue(model.metadata)), now, now);
    const placeholders = seen.map(() => "?").join(", ");
    const notIn = seen.length ? `AND id NOT IN (${placeholders})` : "";
    this.database.prepare(
      `UPDATE provider_catalog_models SET missing_observations = missing_observations + 1,
       retired = CASE WHEN missing_observations + 1 >= ? THEN 1 ELSE retired END
       WHERE provider = ? ${notIn}`,
    ).run(retirementThreshold, provider, ...seen);
  }

  listProviderCatalogModels(provider?: string, query = "", limit = 100): ProviderCatalogModelRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const pattern = `%${query.toLowerCase()}%`;
    const rows = (provider
      ? this.database.prepare("SELECT * FROM provider_catalog_models WHERE provider = ? AND retired = 0 AND (lower(canonical_name) LIKE ? OR lower(display_name) LIKE ?) ORDER BY display_name LIMIT ?").all(provider, pattern, pattern, boundedLimit)
      : this.database.prepare("SELECT * FROM provider_catalog_models WHERE retired = 0 AND (lower(canonical_name) LIKE ? OR lower(display_name) LIKE ?) ORDER BY provider, display_name LIMIT ?").all(pattern, pattern, boundedLimit)) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), provider: String(row.provider), canonicalName: String(row.canonical_name), displayName: String(row.display_name), metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>, firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at), missingObservations: Number(row.missing_observations), retired: Boolean(row.retired) }));
  }

  getRunSpendUsd(runId: string): number {
    const row = this.database.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM invocation_receipts WHERE run_id = ?").get(runId) as { total: number };
    return Number(row.total);
  }

  getWorkbenchSpendUsd(sessionId: string): number {
    const row = this.database.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM workbench_messages WHERE session_id = ? AND status = 'complete'").get(sessionId) as { total: number };
    return Number(row.total);
  }

  getMonthlySpendUsd(at = new Date()): number {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
    const row = this.database.prepare(`
      SELECT
        (SELECT COALESCE(SUM(cost_usd), 0) FROM invocation_receipts WHERE created_at >= ?) +
        (SELECT COALESCE(SUM(cost_usd), 0) FROM workbench_messages WHERE created_at >= ? AND status = 'complete') AS total
    `).get(start, start) as { total: number };
    return Number(row.total);
  }

  reservePaidSpend(input: PaidSpendReservationInput): string {
    if (!input.scopeId.trim()) throw new Error("Paid-spend reservations require a scope identifier");
    if (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0) throw new Error("Paid-spend estimates must be finite and non-negative");
    if (!Number.isFinite(input.perScopeLimitUsd) || input.perScopeLimitUsd <= 0 || !Number.isFinite(input.monthlyLimitUsd) || input.monthlyLimitUsd <= 0) {
      throw new Error("OpenRouter requires positive per-run and monthly spending limits");
    }
    const expectedReceiptCount = input.expectedReceiptCount ?? 1;
    if (!Number.isSafeInteger(expectedReceiptCount) || expectedReceiptCount < 1) throw new Error("Paid-spend reservations require a positive expected receipt count");

    const id = crypto.randomUUID();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)).toISOString();
    const expiresAt = new Date(nowDate.getTime() + 5 * 60_000).toISOString();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare("DELETE FROM paid_spend_reservations WHERE state = 'reserved' AND expires_at <= ?").run(now);
      this.reconcileAllPaidSpendReservations();
      const actualScopeSpend = input.scopeType === "run"
        ? this.database.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM invocation_receipts WHERE run_id = ?").get(input.scopeId) as { total: number }
        : this.database.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM workbench_messages WHERE session_id = ? AND status = 'complete'").get(input.scopeId) as { total: number };
      const reservedScopeSpend = this.database.prepare(
        "SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM paid_spend_reservations WHERE scope_type = ? AND scope_id = ?",
      ).get(input.scopeType, input.scopeId) as { total: number };
      const actualMonthlySpend = this.database.prepare(`
        SELECT
          (SELECT COALESCE(SUM(cost_usd), 0) FROM invocation_receipts WHERE created_at >= ?) +
          (SELECT COALESCE(SUM(cost_usd), 0) FROM workbench_messages WHERE created_at >= ? AND status = 'complete') AS total
      `).get(monthStart, monthStart) as { total: number };
      const reservedMonthlySpend = this.database.prepare(
        "SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM paid_spend_reservations WHERE created_at >= ?",
      ).get(monthStart) as { total: number };
      const scopeCommitted = Number(actualScopeSpend.total) + Number(reservedScopeSpend.total);
      const monthlyCommitted = Number(actualMonthlySpend.total) + Number(reservedMonthlySpend.total);
      if (scopeCommitted + input.estimatedCostUsd > input.perScopeLimitUsd) {
        throw new Error(`OpenRouter per-run limit would be exceeded ($${scopeCommitted.toFixed(4)} spent or reserved of $${input.perScopeLimitUsd.toFixed(2)})`);
      }
      if (monthlyCommitted + input.estimatedCostUsd > input.monthlyLimitUsd) {
        throw new Error(`OpenRouter monthly limit would be exceeded ($${monthlyCommitted.toFixed(4)} spent or reserved of $${input.monthlyLimitUsd.toFixed(2)})`);
      }
      this.database.prepare(`
        INSERT INTO paid_spend_reservations (id, scope_type, scope_id, estimated_cost_usd, state, expected_receipt_count, invoked_at, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'reserved', ?, NULL, ?, ?)
      `).run(id, input.scopeType, input.scopeId, input.estimatedCostUsd, expectedReceiptCount, now, expiresAt);
      this.database.exec("COMMIT;");
      return id;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  releasePaidSpendReservation(id: string): void {
    this.database.prepare("DELETE FROM paid_spend_reservations WHERE id = ?").run(id);
  }

  markPaidSpendInvoked(id: string): void {
    const result = this.database.prepare("UPDATE paid_spend_reservations SET state = 'invoked', invoked_at = ? WHERE id = ? AND state = 'reserved'").run(new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error("Paid-spend reservation is missing or was already invoked");
  }

  settlePaidSpendReservation(id: string): boolean {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const settled = this.reconcilePaidSpendReservation(id);
      this.database.exec("COMMIT;");
      return settled;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  private reconcileAllPaidSpendReservations(): void {
    const rows = this.database.prepare("SELECT id FROM paid_spend_reservations WHERE state = 'invoked'").all() as unknown as Array<{ id: string }>;
    for (const row of rows) this.reconcilePaidSpendReservation(row.id);
  }

  private reconcilePaidSpendReservation(id: string): boolean {
    const reservation = this.database.prepare("SELECT scope_type, estimated_cost_usd, expected_receipt_count, state FROM paid_spend_reservations WHERE id = ?").get(id) as { scope_type: "run" | "workbench"; estimated_cost_usd: number; expected_receipt_count: number; state: string } | undefined;
    if (!reservation) return true;
    if (reservation.state !== "invoked") return false;
    const receipts = reservation.scope_type === "run"
      ? this.database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(cost_usd), 0) AS total FROM invocation_receipts WHERE paid_spend_reservation_id = ? AND cost_usd IS NOT NULL").get(id) as { count: number; total: number }
      : this.database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(cost_usd), 0) AS total FROM workbench_messages WHERE paid_spend_reservation_id = ? AND status = 'complete' AND cost_usd IS NOT NULL").get(id) as { count: number; total: number };
    if (Number(receipts.count) < Number(reservation.expected_receipt_count)) return false;
    if (Number(receipts.total) > Number(reservation.estimated_cost_usd) + 1e-9) return false;
    this.database.prepare("DELETE FROM paid_spend_reservations WHERE id = ?").run(id);
    return true;
  }

  recordInvocationReceipt(input: InvocationReceiptInput): void {
    if (input.paidSpendReservationId) this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(
        `INSERT INTO invocation_receipts
         (run_id, task_id, role, provider, connection_id, requested_model_id, resolved_model_id, model_resolution,
          input_tokens, output_tokens, cost_usd, duration_ms, workload_class, fallback_reason, paid_spend_reservation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.runId,
        input.taskId ?? null,
        input.role,
        input.provider,
        input.connectionId,
        input.requestedModelId ?? null,
        input.resolvedModelId,
        input.modelResolution ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.costUsd ?? null,
        input.durationMs ?? null,
        input.workloadClass ?? (input.role === "reviewer" ? "complex:premium" : null),
        input.fallbackReason ? redactText(input.fallbackReason) : null,
        input.paidSpendReservationId ?? null,
        new Date().toISOString(),
      );
      if (input.paidSpendReservationId) {
        this.reconcilePaidSpendReservation(input.paidSpendReservationId);
        this.database.exec("COMMIT;");
      }
    } catch (error) {
      if (input.paidSpendReservationId) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  recordProductIntelligenceSnapshot(snapshot: ProductIntelligenceSnapshot): ProductIntelligenceSnapshot {
    if (!this.getProduct(snapshot.productId)) throw new Error(`Product '${snapshot.productId}' was not found`);
    this.database.prepare(`
      INSERT INTO product_intelligence_snapshots (id, product_id, status, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.id, snapshot.productId, snapshot.status, JSON.stringify(redactValue(snapshot)), snapshot.createdAt);
    return this.latestProductIntelligenceSnapshot(snapshot.productId)!;
  }

  latestProductIntelligenceSnapshot(productId: string): ProductIntelligenceSnapshot | null {
    const row = this.database.prepare(`
      SELECT snapshot_json FROM product_intelligence_snapshots
      WHERE product_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(productId) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as ProductIntelligenceSnapshot : null;
  }

  recordToolPolicyReceipt(input: ToolPolicyReceiptInput): number {
    const now = new Date().toISOString();
    const safeReason = redactText(input.reason);
    const safeRequest = redactValue(input.request) as Record<string, unknown>;
    const result = this.database.prepare(
      `INSERT INTO tool_policy_receipts
       (run_id, task_id, attempt_id, tool_id, actor_role, stage, side_effect, outcome,
        reason, request_json, lock_keys_json, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      input.taskId ?? null,
      input.attemptId ?? null,
      input.toolId,
      input.actorRole,
      input.stage,
      input.sideEffect,
      input.outcome,
      safeReason,
      JSON.stringify(safeRequest),
      JSON.stringify([...input.lockKeys]),
      input.approvalId ?? null,
      now,
    );
    const id = Number(result.lastInsertRowid);
    const eventKind = input.outcome === "allow"
      ? "tool.allowed"
      : input.outcome === "deny"
        ? "tool.denied"
        : "tool.approval_required";
    this.addEvent(input.runId, eventKind, `${input.toolId} ${input.outcome.replace("_", " ")}: ${safeReason}`, {
      receiptId: id,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      toolId: input.toolId,
      actorRole: input.actorRole,
      stage: input.stage,
      sideEffect: input.sideEffect,
      outcome: input.outcome,
      lockKeys: [...input.lockKeys],
      approvalId: input.approvalId ?? null,
    });
    return id;
  }

  listToolPolicyReceipts(runId: string): ToolPolicyReceiptRecord[] {
    const rows = this.database.prepare(
      "SELECT * FROM tool_policy_receipts WHERE run_id = ? ORDER BY id",
    ).all(runId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      runId: String(row.run_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      attemptId: row.attempt_id === null ? null : Number(row.attempt_id),
      toolId: String(row.tool_id),
      actorRole: String(row.actor_role),
      stage: String(row.stage),
      sideEffect: String(row.side_effect),
      outcome: String(row.outcome) as ToolPolicyReceiptRecord["outcome"],
      reason: String(row.reason),
      request: JSON.parse(String(row.request_json)) as Record<string, unknown>,
      lockKeys: JSON.parse(String(row.lock_keys_json)) as string[],
      approvalId: row.approval_id === null ? null : String(row.approval_id),
      createdAt: String(row.created_at),
    }));
  }

  recordReviewReceipt(input: {
    runId: string;
    round: number;
    integrationSha256: string;
    evidenceBinding: ReviewEvidenceBinding;
    review: StructuredReview;
  }): number {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(
        `INSERT INTO review_receipts
         (run_id, round, integration_sha256, evidence_binding_json, verdict, provider, model_id, connection_id, lens,
          summary, raw_text, invalidated_at, invalidation_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(
        input.runId,
        input.round,
        input.integrationSha256,
        JSON.stringify(input.evidenceBinding),
        input.review.verdict,
        input.review.provider,
        input.review.modelId,
        input.review.connectionId,
        input.review.lens,
        redactText(input.review.summary),
        redactText(input.review.rawText),
        now,
      );
      const reviewId = Number(result.lastInsertRowid);
      const insertFinding = this.database.prepare(
        `INSERT INTO review_findings
         (review_receipt_id, finding_id, severity, location, rationale, suggested_correction, disposition, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const finding of input.review.findings) {
        insertFinding.run(
          reviewId,
          finding.id,
          finding.severity,
          finding.location,
          redactText(finding.rationale),
          redactText(finding.suggestedCorrection),
          finding.disposition,
          now,
        );
      }
      this.database.exec("COMMIT");
      return reviewId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Per-invocation billing evidence for one run, in insertion order. */
  listInvocationReceipts(runId: string): Array<{ role: string; provider: string; resolvedModelId: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }> {
    const rows = this.database.prepare(
      "SELECT role, provider, resolved_model_id, input_tokens, output_tokens, cost_usd FROM invocation_receipts WHERE run_id = ? ORDER BY id",
    ).all(runId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      role: String(row.role),
      provider: String(row.provider),
      resolvedModelId: row.resolved_model_id === null ? null : String(row.resolved_model_id),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    }));
  }

  /**
   * DH-810: idempotent by content hash. Re-recording identical content returns
   * the original record untouched; changed content is a NEW revision beside the
   * old one. Nothing here can rewrite what a historical run executed.
   */
  recordWorkflowRevision(input: { workflow: WorkflowDocument; promotedFrom?: string }): { revisionHash: string; createdAt: string } {
    // Gate finding (test lane, 2026-07-22): workflow documents carry
    // user-authored free text and go through the same redaction boundary as
    // every other persisted free-text field. Redaction happens BEFORE hashing,
    // so a revision's content identity is the identity of what the ledger
    // actually stores.
    const workflow: WorkflowDocument = {
      ...input.workflow,
      description: redactText(input.workflow.description),
      inputs: input.workflow.inputs.map((item) => ({ ...item, description: redactText(item.description) })),
      objective: {
        ...input.workflow.objective,
        outcomeTemplate: redactText(input.workflow.objective.outcomeTemplate),
        acceptanceCriteria: input.workflow.objective.acceptanceCriteria.map(redactText),
      },
      evidenceRequirements: input.workflow.evidenceRequirements.map(redactText),
      completionContract: { ...input.workflow.completionContract, deliverable: redactText(input.workflow.completionContract.deliverable) },
    };
    // DH-810 promotion guard: a revision promoted from a pilot may never
    // silently WIDEN what the pilot was allowed to do or WEAKEN the oversight
    // the pilot ran under — external writes cannot switch on, autonomy cannot
    // escalate, no approval point may disappear, no review lens may be
    // dropped, and the evidence bar cannot shrink. Refused loudly, never
    // accepted quietly.
    if (input.promotedFrom) {
      const base = this.getWorkflowRevision(input.promotedFrom);
      if (!base) throw new Error(`Unknown promotion base revision '${input.promotedFrom}'`);
      const widenings: string[] = [];
      if (workflow.permissions.allowExternalWrites && !base.workflow.permissions.allowExternalWrites) {
        widenings.push("allowExternalWrites: false -> true");
      }
      const autonomyRank: Record<string, number> = { observe: 0, supervised: 1, bounded: 2 };
      if ((autonomyRank[workflow.permissions.autonomy] ?? 0) > (autonomyRank[base.workflow.permissions.autonomy] ?? 0)) {
        widenings.push(`autonomy: ${base.workflow.permissions.autonomy} -> ${workflow.permissions.autonomy}`);
      }
      for (const point of base.workflow.approvalPoints) {
        if (!workflow.approvalPoints.includes(point)) widenings.push(`approval point removed: ${point}`);
      }
      for (const lens of base.workflow.completionContract.reviewLenses) {
        if (!workflow.completionContract.reviewLenses.includes(lens)) widenings.push(`review lens removed: ${lens}`);
      }
      if (workflow.evidenceRequirements.length < base.workflow.evidenceRequirements.length) {
        widenings.push(`evidence requirements reduced: ${base.workflow.evidenceRequirements.length} -> ${workflow.evidenceRequirements.length}`);
      }
      if (widenings.length) {
        throw new Error(`Promotion from ${input.promotedFrom.slice(0, 12)} would widen permissions (${widenings.join("; ")}); widening requires a fresh un-promoted revision recorded deliberately`);
      }
    }
    const revisionHash = workflowRevisionHash(workflow);
    const existing = this.database.prepare("SELECT created_at FROM workflow_revisions WHERE revision_hash = ?").get(revisionHash) as { created_at: string } | undefined;
    if (existing) return { revisionHash, createdAt: String(existing.created_at) };
    const createdAt = new Date().toISOString();
    this.database.prepare(
      "INSERT INTO workflow_revisions (revision_hash, name, document_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(revisionHash, workflow.name, JSON.stringify(workflow), createdAt);
    return { revisionHash, createdAt };
  }

  listWorkflowRevisions(): Array<{ revisionHash: string; name: string; createdAt: string }> {
    const rows = this.database.prepare("SELECT revision_hash, name, created_at FROM workflow_revisions ORDER BY created_at, revision_hash").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ revisionHash: String(row.revision_hash), name: String(row.name), createdAt: String(row.created_at) }));
  }

  getWorkflowRevision(revisionHash: string): { revisionHash: string; name: string; workflow: WorkflowDocument; createdAt: string } | null {
    const row = this.database.prepare("SELECT * FROM workflow_revisions WHERE revision_hash = ?").get(revisionHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      revisionHash: String(row.revision_hash),
      name: String(row.name),
      workflow: JSON.parse(String(row.document_json)) as WorkflowDocument,
      createdAt: String(row.created_at),
    };
  }

  /**
   * A run may only pin a revision the ledger actually stores, and the pin is
   * an audit fact: once set it can be re-asserted idempotently but never
   * re-pointed at a different revision (panel finding — a later-callable
   * setter that overwrites the pin IS the history rewrite this design forbids).
   */
  linkRunWorkflowRevision(runId: string, revisionHash: string): void {
    if (!this.getWorkflowRevision(revisionHash)) throw new Error(`Unknown workflow revision '${revisionHash}'`);
    const current = this.database.prepare("SELECT workflow_revision_hash FROM runs WHERE id = ?").get(runId) as { workflow_revision_hash: string | null } | undefined;
    if (!current) throw new Error(`Run '${runId}' was not found`);
    if (current.workflow_revision_hash !== null && current.workflow_revision_hash !== revisionHash) {
      throw new Error(`Run '${runId}' is already pinned to workflow revision '${current.workflow_revision_hash}'`);
    }
    this.database.prepare("UPDATE runs SET workflow_revision_hash = ? WHERE id = ?").run(revisionHash, runId);
  }

  listReviewReceipts(runId: string): ReviewReceiptRecord[] {
    const reviews = this.database.prepare(
      "SELECT * FROM review_receipts WHERE run_id = ? ORDER BY round, id",
    ).all(runId) as unknown as Array<Record<string, unknown>>;
    const findFindings = this.database.prepare(
      "SELECT * FROM review_findings WHERE review_receipt_id = ? ORDER BY id",
    );
    return reviews.map((review) => ({
      id: Number(review.id),
      runId: String(review.run_id),
      round: Number(review.round),
      integrationSha256: String(review.integration_sha256),
      evidenceBinding: JSON.parse(String(review.evidence_binding_json)) as ReviewEvidenceBinding,
      verdict: String(review.verdict) as StructuredReview["verdict"],
      provider: String(review.provider),
      modelId: review.model_id === null ? null : String(review.model_id),
      connectionId: String(review.connection_id),
      lens: review.lens === null || review.lens === undefined ? null : String(review.lens) as StructuredReview["lens"],
      summary: String(review.summary),
      rawText: String(review.raw_text),
      invalidatedAt: review.invalidated_at === null ? null : String(review.invalidated_at),
      invalidationReason: review.invalidation_reason === null ? null : String(review.invalidation_reason),
      createdAt: String(review.created_at),
      findings: (findFindings.all(Number(review.id)) as unknown as Array<Record<string, unknown>>).map((finding) => ({
        id: String(finding.finding_id),
        severity: String(finding.severity) as ReviewFinding["severity"],
        location: finding.location === null ? null : String(finding.location),
        rationale: String(finding.rationale),
        suggestedCorrection: String(finding.suggested_correction),
        disposition: String(finding.disposition) as ReviewFinding["disposition"],
      })),
    }));
  }

  invalidateReviewReceipts(runId: string, reason: string): number {
    const result = this.database.prepare(
      "UPDATE review_receipts SET invalidated_at = ?, invalidation_reason = ? WHERE run_id = ? AND invalidated_at IS NULL",
    ).run(new Date().toISOString(), redactText(reason), runId);
    return Number(result.changes);
  }

  listModels(connectionId?: string): ModelRecord[] {
    const rows = (connectionId
      ? this.database
          .prepare("SELECT * FROM models WHERE connection_id = ? ORDER BY display_name, id")
          .all(connectionId)
      : this.database.prepare("SELECT * FROM models ORDER BY display_name, id").all()) as unknown as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id),
      connectionId: String(row.connection_id),
      canonicalName: String(row.canonical_name),
      displayName: String(row.display_name),
      source: String(row.source) as ModelRecord["source"],
      lifecycle: String(row.lifecycle) as ModelRecord["lifecycle"],
      visible: Boolean(row.visible),
      verified: Boolean(row.verified),
      qualified: Boolean(row.qualified),
      active: Boolean(row.active),
      degraded: Boolean(row.degraded),
      retired: Boolean(row.retired),
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
      lastVerifiedAt: row.last_verified_at === null ? null : String(row.last_verified_at),
      pinned: Boolean(row.pinned),
      excluded: Boolean(row.excluded),
      qualificationFingerprint: row.qualification_fingerprint === null ? null : String(row.qualification_fingerprint),
      qualificationStale: Boolean(row.qualified) && Boolean(row.qualification_stale),
      missingObservations: Number(row.missing_observations),
      upgradePolicy: String(row.upgrade_policy) === "track_family" ? "track_family" : "pinned",
    }));
  }

  getModel(modelId: string): ModelRecord | null {
    return this.listModels().find((model) => model.id === modelId) ?? null;
  }

  setModelPreference(modelId: string, input: { pinned?: boolean; excluded?: boolean; active?: boolean; upgradePolicy?: "pinned" | "track_family" }): ModelRecord {
    const model = this.getModel(modelId);
    if (!model) throw new Error(`Model '${modelId}' was not found`);
    const pinned = input.pinned ?? model.pinned;
    const excluded = input.excluded ?? model.excluded;
    const active = excluded ? false : input.active ?? model.active;
    if (active && (!model.qualified || model.qualificationStale)) throw new Error("A model must pass a current qualification before activation");
    const upgradePolicy = input.upgradePolicy ?? model.upgradePolicy;
    this.database.prepare("UPDATE models SET pinned = ?, excluded = ?, active = ?, upgrade_policy = ?, lifecycle = CASE WHEN ? = 1 THEN 'active' WHEN qualified = 1 THEN 'qualified' ELSE lifecycle END, last_seen_at = ? WHERE id = ?")
      .run(pinned ? 1 : 0, excluded ? 1 : 0, active ? 1 : 0, upgradePolicy, active ? 1 : 0, new Date().toISOString(), modelId);
    return this.getModel(modelId)!;
  }

  recordModelQualification(input: { modelId: string; fixtureVersion: string; role: string; passed: boolean; score: number; evidence: Readonly<Record<string, unknown>>; fingerprint?: string | null }): ModelQualificationRecord {
    if (!this.getModel(input.modelId)) throw new Error(`Model '${input.modelId}' was not found`);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("INSERT INTO model_qualifications (model_id, fixture_version, role, passed, score, evidence_json, created_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.modelId, input.fixtureVersion, input.role, input.passed ? 1 : 0, input.score, JSON.stringify(redactValue(input.evidence)), now, input.fingerprint ?? null);
      const qualified = input.passed;
      this.database.prepare("UPDATE models SET visible = 1, verified = 1, qualified = ?, qualification_fingerprint = ?, qualification_stale = ?, active = CASE WHEN ? = 1 THEN active ELSE 0 END, lifecycle = CASE WHEN ? = 1 THEN CASE WHEN active = 1 THEN 'active' ELSE 'qualified' END ELSE 'visible' END, last_verified_at = ?, last_seen_at = ? WHERE id = ?")
        .run(qualified ? 1 : 0, input.fingerprint ?? null, 0, qualified ? 1 : 0, qualified ? 1 : 0, now, now, input.modelId);
      this.database.exec("COMMIT");
      return { id: Number(result.lastInsertRowid), modelId: input.modelId, fixtureVersion: input.fixtureVersion, role: input.role, passed: input.passed, score: input.score, evidence: redactValue(input.evidence) as Record<string, unknown>, fingerprint: input.fingerprint ?? null, createdAt: now };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listModelQualifications(modelId?: string): ModelQualificationRecord[] {
    const rows = (modelId
      ? this.database.prepare("SELECT * FROM model_qualifications WHERE model_id = ? ORDER BY id DESC").all(modelId)
      : this.database.prepare("SELECT * FROM model_qualifications ORDER BY id DESC").all()) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), modelId: String(row.model_id), fixtureVersion: String(row.fixture_version), role: String(row.role), passed: Boolean(row.passed), score: Number(row.score), evidence: JSON.parse(String(row.evidence_json)) as Record<string, unknown>, fingerprint: row.fingerprint === null ? null : String(row.fingerprint), createdAt: String(row.created_at) }));
  }

  getTask(runId: string, taskId: string): PlannedTask | null {
    const row = this.database
      .prepare(
        "SELECT task_id, title, description, dependencies_json, checks_json, preferred_provider, task_contract_json FROM tasks WHERE run_id = ? AND task_id = ?",
      )
      .get(runId, taskId) as
      | {
          task_id: string;
          title: string;
          description: string;
          dependencies_json: string;
          checks_json: string;
          preferred_provider: ProviderName | null;
          task_contract_json: string;
        }
      | undefined;
    if (!row) return null;
    const contract = JSON.parse(row.task_contract_json || "{}") as Partial<PlannedTask>;
    return {
      id: row.task_id,
      title: row.title,
      description: row.description,
      dependencies: JSON.parse(row.dependencies_json) as string[],
      preferredProvider: row.preferred_provider,
      checks: JSON.parse(row.checks_json) as string[],
      kind: contract.kind ?? "implementation",
      repositoryIds: contract.repositoryIds ?? [],
      repositoryScope: contract.repositoryScope ?? ["."],
      permission: contract.permission ?? "workspace_write",
      risk: contract.risk ?? "medium",
      capabilityNeeds: contract.capabilityNeeds ?? ["code"],
      acceptanceCriteria: contract.acceptanceCriteria ?? [],
      expectedArtifacts: contract.expectedArtifacts ?? [],
    };
  }

  private mapObjective(row: Record<string, unknown>): ObjectiveRecord {
    return {
      id: String(row.id),
      outcome: String(row.outcome),
      acceptanceCriteria: JSON.parse(String(row.acceptance_criteria_json)) as string[],
      constraints: JSON.parse(String(row.constraints_json)) as string[],
      projectPath: String(row.project_path),
      ...(row.product_id === null ? {} : { productId: String(row.product_id) }),
      repositoryIds: JSON.parse(String(row.repository_ids_json)) as string[],
      risk: String(row.risk) as ObjectiveRecord["risk"],
      autonomy: parseRunAutonomy(String(row.autonomy)),
      priority: String(row.priority) as ObjectiveRecord["priority"],
      ...(row.deadline === null ? {} : { deadline: String(row.deadline) }),
      policyNotes: JSON.parse(String(row.policy_notes_json)) as string[],
      workflowRevisionHash: row.workflow_revision_hash === null || row.workflow_revision_hash === undefined ? null : String(row.workflow_revision_hash),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapWorkbenchSession(row: Record<string, unknown>): WorkbenchSessionRecord {
    if (String(row.mode) !== "read_only") {
      throw new Error(`Workbench session '${String(row.id)}' has unsupported mode '${String(row.mode)}'`);
    }
    return {
      id: String(row.id),
      projectPath: String(row.project_path),
      title: String(row.title),
      mode: "read_only",
      objectiveId: row.objective_id === null ? null : String(row.objective_id),
      convertedAt: row.converted_at === null ? null : String(row.converted_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapWorkbenchMessage(row: Record<string, unknown>): WorkbenchMessageRecord {
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      role: String(row.role) as WorkbenchMessageRecord["role"],
      content: String(row.content),
      provider: row.provider === null ? null : String(row.provider),
      connectionId: row.connection_id === null ? null : String(row.connection_id),
      requestedModelId: row.requested_model_id === null ? null : String(row.requested_model_id),
      resolvedModelId: row.resolved_model_id === null ? null : String(row.resolved_model_id),
      status: row.status === null ? null : String(row.status) as WorkbenchMessageRecord["status"],
      error: row.error === null ? null : String(row.error),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      paidSpendReservationId: row.paid_spend_reservation_id === null ? null : String(row.paid_spend_reservation_id),
      createdAt: String(row.created_at),
    };
  }

  private mapPlanRevision(row: Record<string, unknown>): PlanRevisionRecord {
    return {
      objectiveId: String(row.objective_id),
      revision: Number(row.revision),
      plan: JSON.parse(String(row.plan_json)) as RunPlan,
      rationale: String(row.rationale),
      approved: Boolean(row.approved),
      createdAt: String(row.created_at),
      approvedAt: row.approved_at === null ? null : String(row.approved_at),
    };
  }

  private migrate(existed: boolean): void {
    const currentVersion = this.readSchemaVersion();
    if (currentVersion > LEDGER_SCHEMA_VERSION) {
      throw new Error(
        `Database uses newer ledger schema version ${currentVersion}; this DevHarmonics build supports version ${LEDGER_SCHEMA_VERSION}`,
      );
    }

    this.assertDatabaseIntegrity("before migration");
    if (currentVersion === LEDGER_SCHEMA_VERSION) {
      this.assertSchemaShape();
      this.assertMigrationHistory(currentVersion);
      return;
    }

    const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion);
    const isCompletePath = pending.every(
      (migration, index) => migration.version === currentVersion + index + 1,
    );
    if (!pending.length || !isCompletePath || pending.at(-1)?.version !== LEDGER_SCHEMA_VERSION) {
      throw new Error(
        `No complete migration path exists from ledger schema version ${currentVersion} to ${LEDGER_SCHEMA_VERSION}`,
      );
    }

    const hasExistingSchema = this.database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get() as { present: number } | undefined;
    const backup = existed && hasExistingSchema ? this.createMigrationBackup(currentVersion) : null;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of pending) {
        migration.apply(this.database);
        this.database
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
      }
      this.assertSchemaShape();
      this.assertMigrationHistory(LEDGER_SCHEMA_VERSION);
      this.assertDatabaseIntegrity("after migration");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Ledger migration from version ${currentVersion} to ${LEDGER_SCHEMA_VERSION} failed${backup ? `; pre-migration backup: ${backup}` : ""}: ${message}`,
        { cause: error },
      );
    }
  }

  private mapEvent(event: EventRow): RunEvent {
    const data = JSON.parse(event.data_json) as unknown;
    if (!data || Array.isArray(data) || typeof data !== "object") {
      throw new Error(`Event ${event.id} has an invalid data payload`);
    }
    return {
      id: event.id,
      cursor: event.id,
      runId: event.run_id,
      kind: parseRunEventKind(event.kind),
      message: event.message,
      data: data as Record<string, unknown>,
      createdAt: event.created_at,
    };
  }

  private assertEventPage(after: number, limit: number): void {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Event cursor must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Event limit must be an integer between 1 and 1000");
    }
  }

  private readSchemaVersion(): number {
    const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  private createMigrationBackup(fromVersion: number): string {
    const stamp = new Date().toISOString().replace(/\D/g, "");
    const backup = `${this.filename}.backup-v${fromVersion}-to-v${LEDGER_SCHEMA_VERSION}-${stamp}-${crypto.randomUUID().slice(0, 8)}.sqlite`;
    this.database.prepare("VACUUM INTO ?").run(backup);
    return backup;
  }

  private assertSchemaShape(): void {
    for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
      const rows = this.database
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table) as unknown as Array<{ name: string }>;
      const columns = new Set(rows.map((row) => row.name));
      const missing = requiredColumns.filter((column) => !columns.has(column));
      if (missing.length) {
        throw new Error(
          `Ledger schema validation failed: table '${table}' is missing columns ${missing.join(", ")}`,
        );
      }
    }
  }

  private assertMigrationHistory(expectedVersion: number): void {
    const rows = this.database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as unknown as Array<{ version: number; name: string }>;
    const expected = MIGRATIONS.filter((migration) => migration.version <= expectedVersion);
    if (
      rows.length !== expected.length ||
      rows.some(
        (row, index) =>
          row.version !== expected[index]?.version || row.name !== expected[index]?.name,
      )
    ) {
      throw new Error(
        `Ledger migration history does not match schema version ${expectedVersion}`,
      );
    }
  }

  private assertDatabaseIntegrity(stage: string): void {
    const integrity = this.database.prepare("PRAGMA integrity_check").all() as unknown as Array<
      Record<string, unknown>
    >;
    const messages = integrity.map((row) => String(Object.values(row)[0]));
    if (messages.length !== 1 || messages[0] !== "ok") {
      throw new Error(`Ledger integrity check failed ${stage}: ${messages.join("; ") || "no result"}`);
    }

    const foreignKeys = this.database.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (foreignKeys.length) {
      throw new Error(
        `Ledger foreign-key integrity check failed ${stage}: ${foreignKeys.length} violation(s)`,
      );
    }
  }
}

function parseRunAutonomy(value: string): RunAutonomy {
  if (value === "observe" || value === "bounded") return value;
  return "supervised";
}
