import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { NewRunEvent, RunEvent, RunEventSource, RunEventType, ScheduledRun } from "../shared/model.js";
import { foldRun } from "./run-fold.js";

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

export class RunStore {
  protected readonly db: DatabaseSync;
  private closed = false;
  private readonly insertStatement: StatementSync;
  private readonly runEventsStatement: StatementSync;
  private readonly hasRunStatement: StatementSync;
  private readonly hasOccurrenceStatement: StatementSync;

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

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
