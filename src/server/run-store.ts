import { DatabaseSync, type StatementSync } from "node:sqlite";
import { RUN_PAGE_MAX, RUN_PAGE_SIZE } from "../shared/model.js";
import type { NewRunEvent, RunEvent, RunEventSource, RunEventType, ScheduledRun } from "../shared/model.js";
import { RECOVERY_SUMMARY, foldRun } from "./run-fold.js";

export const RUN_STORE_SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE run_events (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  workspace_key     TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  occurrence_key    TEXT NOT NULL,
  scheduled_for     TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('started','succeeded','failed','missed')),
  at                TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('scheduler','manual','retry','recovery','migrated')),
  summary           TEXT NOT NULL,
  failure_reason    TEXT,
  retry_of_run_id   TEXT,
  execution_request TEXT
);
CREATE INDEX ix_events_run        ON run_events (run_id, seq);
CREATE INDEX ix_events_ws_page    ON run_events (workspace_key, seq DESC);
CREATE INDEX ix_events_task_page  ON run_events (workspace_key, task_id, seq DESC);
CREATE INDEX ix_events_occurrence ON run_events (workspace_key, occurrence_key);
CREATE INDEX ix_events_started    ON run_events (run_id, seq) WHERE type = 'started';
CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
`;

export const RECOVER_INTERRUPTED_SQL =
  "SELECT s.run_id AS run_id FROM run_events s INDEXED BY ix_events_started " +
  "WHERE s.type = 'started' AND NOT EXISTS (SELECT 1 FROM run_events n WHERE n.run_id = s.run_id AND n.seq > s.seq)";

interface EventRow {
  seq: number;
  run_id: string;
  workspace_key: string;
  task_id: string;
  occurrence_key: string;
  scheduled_for: string;
  type: string;
  at: string;
  source: string;
  summary: string;
  failure_reason: string | null;
  retry_of_run_id: string | null;
  execution_request: string | null;
}

function toEvent(row: EventRow): RunEvent {
  return {
    seq: Number(row.seq),
    runId: row.run_id,
    workspaceKey: row.workspace_key,
    taskId: row.task_id,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for,
    type: row.type as RunEventType,
    at: row.at,
    source: row.source as RunEventSource,
    summary: row.summary,
    failureReason: row.failure_reason,
    retryOfRunId: row.retry_of_run_id,
    executionRequest: row.execution_request ? (JSON.parse(row.execution_request) as Record<string, unknown>) : null
  };
}

export interface ListRunsOptions {
  limit?: number;
  before?: string | null;
  taskId?: string | null;
}

export interface RunPage {
  runs: ScheduledRun[];
  nextCursor: string | null;
}

export interface TaskRunSummary {
  latest: ScheduledRun | null;
  latestFinished: ScheduledRun | null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return RUN_PAGE_SIZE;
  }
  return Math.min(RUN_PAGE_MAX, Math.max(1, Math.trunc(limit)));
}

function parseCursor(cursor: string): number {
  if (!/^[1-9]\d*$/u.test(cursor)) {
    throw new Error("invalid cursor");
  }
  return Number(cursor);
}

export class RunStore {
  protected readonly db: DatabaseSync;
  private closed = false;
  private readonly insertStatement: StatementSync;
  private readonly runEventsStatement: StatementSync;
  private readonly hasRunStatement: StatementSync;
  private readonly hasOccurrenceStatement: StatementSync;
  private readonly pageStatements = new Map<string, StatementSync>();

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = OFF");
      const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
      if (version > RUN_STORE_SCHEMA_VERSION) {
        throw new Error(
          `${dbPath} has schema version ${version}; this plugin supports up to ${RUN_STORE_SCHEMA_VERSION}.`
        );
      }
      if (version === 0) {
        this.transaction(() => {
          this.db.exec(SCHEMA_SQL);
          this.db.exec(`PRAGMA user_version = ${RUN_STORE_SCHEMA_VERSION}`);
        });
      }
    } catch (error) {
      this.db.close();
      throw error;
    }

    this.insertStatement = this.db.prepare(
      "INSERT INTO run_events (run_id, workspace_key, task_id, occurrence_key, scheduled_for, type, at, source, summary, failure_reason, retry_of_run_id, execution_request) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this.runEventsStatement = this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq");
    this.hasRunStatement = this.db.prepare("SELECT 1 AS found FROM run_events WHERE run_id = ? LIMIT 1");
    this.hasOccurrenceStatement = this.db.prepare(
      "SELECT 1 AS found FROM run_events WHERE workspace_key = ? AND occurrence_key = ? LIMIT 1"
    );
  }

  protected transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(event: NewRunEvent): void {
    this.insertStatement.run(
      event.runId,
      event.workspaceKey,
      event.taskId,
      event.occurrenceKey,
      event.scheduledFor,
      event.type,
      event.at,
      event.source,
      event.summary,
      event.failureReason ?? null,
      event.retryOfRunId ?? null,
      event.executionRequest ? JSON.stringify(event.executionRequest) : null
    );
  }

  appendEvents(events: NewRunEvent[]): void {
    if (!events.length) {
      return;
    }
    this.transaction(() => {
      for (const event of events) {
        this.appendEvent(event);
      }
    });
  }

  listEvents(runId: string): RunEvent[] {
    return (this.runEventsStatement.all(runId) as unknown as EventRow[]).map(toEvent);
  }

  getRun(runId: string): ScheduledRun | null {
    const events = this.listEvents(runId);
    return events.length ? foldRun(events) : null;
  }

  hasRun(runId: string): boolean {
    return this.hasRunStatement.get(runId) !== undefined;
  }

  hasOccurrence(workspaceKey: string, occurrenceKey: string): boolean {
    return this.hasOccurrenceStatement.get(workspaceKey, occurrenceKey) !== undefined;
  }

  private pageStatement(withTask: boolean, withCursor: boolean): StatementSync {
    const key = `${withTask}:${withCursor}`;
    let statement = this.pageStatements.get(key);
    if (!statement) {
      statement = this.db.prepare(
        "SELECT run_id, seq FROM run_events f WHERE workspace_key = ?" +
          (withTask ? " AND task_id = ?" : "") +
          " AND seq = (SELECT MIN(seq) FROM run_events WHERE run_id = f.run_id)" +
          (withCursor ? " AND seq < ?" : "") +
          " ORDER BY seq DESC LIMIT ?"
      );
      this.pageStatements.set(key, statement);
    }
    return statement;
  }

  listRuns(workspaceKey: string, options: ListRunsOptions = {}): RunPage {
    const limit = clampLimit(options.limit);
    const before = options.before === undefined || options.before === null ? null : parseCursor(options.before);
    const params: Array<string | number> = [workspaceKey];
    if (options.taskId) {
      params.push(options.taskId);
    }
    if (before !== null) {
      params.push(before);
    }
    params.push(limit + 1);
    const heads = this.pageStatement(Boolean(options.taskId), before !== null).all(...params) as unknown as Array<{
      run_id: string;
      seq: number;
    }>;
    const hasMore = heads.length > limit;
    const kept = hasMore ? heads.slice(0, limit) : heads;
    if (!kept.length) {
      return { runs: [], nextCursor: null };
    }

    const placeholders = kept.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM run_events WHERE run_id IN (${placeholders}) ORDER BY run_id, seq`)
      .all(...kept.map((head) => head.run_id)) as unknown as EventRow[];
    const grouped = new Map<string, RunEvent[]>();
    for (const row of rows) {
      const list = grouped.get(row.run_id) ?? [];
      list.push(toEvent(row));
      grouped.set(row.run_id, list);
    }
    const runs = kept.map((head) => foldRun(grouped.get(head.run_id)!));
    return { runs, nextCursor: hasMore ? String(runs[runs.length - 1]!.sequence) : null };
  }

  taskRunSummaries(workspaceKey: string, taskIds: string[]): Map<string, TaskRunSummary> {
    const summaries = new Map<string, TaskRunSummary>();
    for (const taskId of taskIds) {
      let latest: ScheduledRun | null = null;
      let latestFinished: ScheduledRun | null = null;
      let before: string | null = null;
      do {
        const page = this.listRuns(workspaceKey, { taskId, limit: 5, before });
        latest ??= page.runs[0] ?? null;
        latestFinished = page.runs.find((run) => run.finishedAt !== null) ?? null;
        before = page.nextCursor;
      } while (!latestFinished && before);
      summaries.set(taskId, { latest, latestFinished });
    }
    return summaries;
  }

  recoverInterruptedRuns(now: string): number {
    const rows = this.db.prepare(RECOVER_INTERRUPTED_SQL).all() as unknown as Array<{ run_id: string }>;
    const events: NewRunEvent[] = [];
    for (const { run_id: runId } of rows) {
      const run = this.getRun(runId);
      if (!run) {
        continue;
      }
      events.push({
        runId: run.id,
        workspaceKey: run.workspaceKey,
        taskId: run.taskId,
        occurrenceKey: run.occurrenceKey,
        scheduledFor: run.scheduledFor,
        retryOfRunId: run.retryOfRunId,
        type: "failed",
        at: now,
        source: "recovery",
        summary: RECOVERY_SUMMARY,
        failureReason: RECOVERY_SUMMARY
      });
    }
    this.appendEvents(events);
    return events.length;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
