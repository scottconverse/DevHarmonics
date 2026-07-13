import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CheckResult,
  PlannedTask,
  ProviderName,
  RunPlan,
  RunSummary,
  TaskStatus,
} from "./types.js";

interface RunRow {
  id: string;
  goal: string;
  project_path: string;
  status: string;
  created_at: string;
  updated_at: string;
  final_review: string | null;
}

interface TaskRow {
  task_id: string;
  title: string;
  status: TaskStatus;
  provider: ProviderName | null;
  attempt_count: number;
}

interface EventRow {
  id: number;
  kind: string;
  message: string;
  created_at: string;
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

export class Ledger {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  createRun(goal: string, projectPath: string): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        "INSERT INTO runs (id, goal, project_path, status, created_at, updated_at) VALUES (?, ?, ?, 'planning', ?, ?)",
      )
      .run(id, goal, projectPath, now, now);
    this.addEvent(id, "run.created", "Run created");
    return id;
  }

  savePlan(runId: string, plan: RunPlan): void {
    this.database
      .prepare("UPDATE runs SET plan_json = ?, status = 'running', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(plan), new Date().toISOString(), runId);
    const insert = this.database.prepare(
      `INSERT INTO tasks
        (run_id, task_id, title, description, dependencies_json, checks_json, status, preferred_provider)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    );
    for (const task of plan.tasks) {
      insert.run(
        runId,
        task.id,
        task.title,
        task.description,
        JSON.stringify(task.dependencies),
        JSON.stringify(task.checks),
        task.preferredProvider,
      );
    }
    this.addEvent(runId, "plan.created", `Architect created ${plan.tasks.length} tasks`);
  }

  addIntegrationTask(runId: string, checks: string[]): void {
    this.database
      .prepare(
        `INSERT INTO tasks
          (run_id, task_id, title, description, dependencies_json, checks_json, status, preferred_provider)
         VALUES (?, '__integration__', 'Integration suite', 'Validate the combined integration branch', '[]', ?, 'queued', NULL)`,
      )
      .run(runId, JSON.stringify(checks));
    this.addEvent(runId, "integration.queued", `Queued ${checks.length} integration validators`);
  }

  setRunStatus(runId: string, status: string, finalReview?: string): void {
    this.database
      .prepare(
        "UPDATE runs SET status = ?, final_review = COALESCE(?, final_review), updated_at = ? WHERE id = ?",
      )
      .run(status, finalReview ?? null, new Date().toISOString(), runId);
  }

  cancelRun(runId: string): boolean {
    const run = this.database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    if (!run) return false;
    if (["ready", "not_ready", "failed", "cancelled"].includes(run.status)) return false;

    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE runs SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now, runId);
    this.database
      .prepare(
        "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status IN ('queued', 'working', 'verifying', 'retry')",
      )
      .run(now, runId);
    this.addEvent(runId, "run.cancelled", "Run cancelled");
    return true;
  }

  setTaskStatus(
    runId: string,
    taskId: string,
    status: TaskStatus,
    provider?: ProviderName,
  ): void {
    this.database
      .prepare(
        "UPDATE tasks SET status = ?, provider = COALESCE(?, provider), updated_at = ? WHERE run_id = ? AND task_id = ?",
      )
      .run(status, provider ?? null, new Date().toISOString(), runId, taskId);
  }

  startAttempt(runId: string, taskId: string, provider: ProviderName, prompt: string): number {
    this.database
      .prepare(
        "UPDATE tasks SET attempt_count = attempt_count + 1, provider = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
      )
      .run(provider, new Date().toISOString(), runId, taskId);
    const result = this.database
      .prepare(
        "INSERT INTO attempts (run_id, task_id, provider, prompt, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
      )
      .run(runId, taskId, provider, prompt, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  finishAttempt(attemptId: number, status: string, output: string, error = ""): void {
    this.database
      .prepare(
        "UPDATE attempts SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?",
      )
      .run(status, output, error, new Date().toISOString(), attemptId);
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
        result.stdout,
        result.stderr,
        result.durationMs,
        new Date().toISOString(),
      );
  }

  addEvent(runId: string, kind: string, message: string): void {
    this.database
      .prepare("INSERT INTO events (run_id, kind, message, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, kind, message, new Date().toISOString());
  }

  listRuns(): RunSummary[] {
    const rows = this.database
      .prepare("SELECT id FROM runs ORDER BY created_at DESC LIMIT 50")
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
        "SELECT task_id, title, status, provider, attempt_count FROM tasks WHERE run_id = ? ORDER BY rowid",
      )
      .all(runId) as unknown as TaskRow[];
    const checks = this.database
      .prepare(
        "SELECT task_id, name, passed, exit_code, stdout, stderr, duration_ms FROM checks WHERE run_id = ? ORDER BY id",
      )
      .all(runId) as unknown as CheckRow[];
    const events = this.database
      .prepare(
        "SELECT id, kind, message, created_at FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 200",
      )
      .all(runId) as unknown as EventRow[];

    return {
      id: run.id,
      goal: run.goal,
      projectPath: run.project_path,
      status: run.status,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      finalReview: run.final_review,
      tasks: tasks.map((task) => ({
        id: task.task_id,
        title: task.title,
        status: task.status,
        provider: task.provider,
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
      })),
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        message: event.message,
        createdAt: event.created_at,
      })),
    };
  }

  getTask(runId: string, taskId: string): PlannedTask | null {
    const row = this.database
      .prepare(
        "SELECT task_id, title, description, dependencies_json, checks_json, preferred_provider FROM tasks WHERE run_id = ? AND task_id = ?",
      )
      .get(runId, taskId) as
      | {
          task_id: string;
          title: string;
          description: string;
          dependencies_json: string;
          checks_json: string;
          preferred_provider: ProviderName | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.task_id,
      title: row.title,
      description: row.description,
      dependencies: JSON.parse(row.dependencies_json) as string[],
      preferredProvider: row.preferred_provider,
      checks: JSON.parse(row.checks_json) as string[],
    };
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        project_path TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT,
        final_review TEXT,
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
    `);
  }
}
