# Run Event Log — Design

**Date:** 2026-10-29 (revised 2026-10-31 after review)
**Branch:** `003-run-event-log`
**Spec-kit spec:** [`specs/003-run-event-log/spec.md`](../../../specs/003-run-event-log/spec.md)
**Follow-up:** `004-cron-expressions` builds on this branch.

## Goal

Keep the complete run history of every scheduled prompt, as an append-only event log, without slowing down the scheduler or the dashboard.

## Problem

Each workspace's tasks and runs live in one JSON file (`~/.cloudcli-workspace-scheduled-prompts/<workspaceKey>.json`). `saveWorkspaceLedger` rewrites the whole file on every run start and finish, and the global dashboard reads every file on each refresh. History is capped at `RUN_HISTORY_LIMIT = 500` runs per workspace, shared by all tasks in it.

That cap was harmless while the shortest schedule was daily. Sub-daily schedules (planned in `004-cron-expressions`) would either wipe history within hours or, if the cap were removed, grow the JSON file to gigabytes that are rewritten twice a minute.

Three existing defects in the same code paths are fixed along the way, because the new design would otherwise inherit them:

1. A run left `running` when the plugin server stops stays `running` forever.
2. `executeTask` saves a ledger object loaded *before* a child process that can run for minutes (`scheduler.ts:381`, `:390`). Any pause, edit, create or delete made over HTTP during the run is overwritten; a deleted task comes back.
3. An exception inside `tickWithoutDispatcher` is an unhandled rejection (`server.ts:14` calls it with `void` and no `.catch`), which terminates the plugin server.

## Decisions

| Topic | Decision |
|---|---|
| Storage shape | Append-only **event log** (`run_events`). Run state is folded from events in TypeScript. |
| File layout | **One** `runs.db` in the data dir, shared by all workspaces |
| Existing JSON runs | **One-time import** on startup, with a `.v1.json.bak` backup |
| SQLite library | Built-in **`node:sqlite`** |
| Code structure | New **`RunStore`** module; `runs` removed from `WorkspaceLedger` |
| `lastRunStatus` | **Derived** from `RunStore` when tasks are served; no longer persisted |
| Retention | None. History is never pruned. |
| Task definitions | Stay in the per-workspace JSON files (out of scope) |

Rejected alternatives:

- **One row per run, updated on finish.** Simpler, but loses the trail of how a run reached its state.
- **One `.db` per workspace.** The dashboard would still open N files per refresh.
- **Read old runs from JSON forever.** Two code paths on every query.
- **`better-sqlite3`.** Native build on each plugin install; fails on machines without build tools.
- **`sql.js`.** Whole database in memory, file rewritten on save — the same problem as today.
- **Back `ledger.runs` with SQLite via diffing.** Fewer call-site changes, but hides the log behind array mutation and the diff is error-prone.
- **A SQL view (`runs_current`) as the query path.** Measured at 500k events: 396 ms for one page of `listRuns`, 1,331 ms for latest-runs-per-task. SQLite cannot push the workspace filter into the grouped view. Rejected in favour of first-event queries plus a TypeScript fold (0.5 ms for both).

## 1. Schema and run model

File: `<dataRoot>/runs.db`, where `dataRoot` is the existing `~/.cloudcli-workspace-scheduled-prompts`.

### Opening the database

In this order, outside any transaction:

```sql
PRAGMA journal_mode = WAL;   -- must not run inside a transaction
PRAGMA foreign_keys = OFF;
PRAGMA user_version;         -- read: 0 = new file, 1 = current, >1 = refuse
```

If `user_version` is 0, the schema below is created between manual `BEGIN` / `COMMIT` (with `ROLLBACK` on error), ending with `PRAGMA user_version = 1`. `node:sqlite` on Node 22.23 has no `db.transaction` helper; all transactions in this design use `db.exec("BEGIN")` / `db.exec("COMMIT")` / `db.exec("ROLLBACK")`.

### Schema

```sql
CREATE TABLE run_events (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  workspace_key     TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  occurrence_key    TEXT NOT NULL,
  scheduled_for     TEXT NOT NULL,   -- ISO 8601 UTC; identical on every event of a run
  type              TEXT NOT NULL CHECK (type IN ('started','succeeded','failed','missed')),
  at                TEXT NOT NULL,   -- ISO 8601 UTC, when the event happened
  source            TEXT NOT NULL CHECK (source IN ('scheduler','manual','retry','recovery','migrated')),
  summary           TEXT NOT NULL,
  failure_reason    TEXT,
  retry_of_run_id   TEXT,
  execution_request TEXT             -- JSON; set only on 'started'
);

-- One run's events, in order (fold, getRun, listEvents, recovery)
CREATE INDEX ix_events_run        ON run_events (run_id, seq);
-- Workspace run pages
CREATE INDEX ix_events_ws_page    ON run_events (workspace_key, scheduled_for DESC, seq DESC);
-- Per-task run pages and dashboard summaries
CREATE INDEX ix_events_task_page  ON run_events (task_id, scheduled_for DESC, seq DESC);
-- Duplicate-occurrence check
CREATE INDEX ix_events_occurrence ON run_events (occurrence_key);
-- Crash recovery: only 'started' events, so the scan does not grow with summaries
CREATE INDEX ix_events_started    ON run_events (run_id, seq) WHERE type = 'started';

CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
```

### Run identity and order

- A run's **first event** is the row with the smallest `seq` for its `run_id`. It fixes the run's `taskId`, `workspaceKey`, `occurrenceKey`, `scheduledFor` and `retryOfRunId`.
- Runs are ordered by `scheduled_for DESC, first_seq DESC`. `first_seq` breaks ties deterministically (newest-created first); run IDs are random UUIDs and are never used for ordering.

### Folding events into a `ScheduledRun` — `foldRun(events)`

A pure function in `src/server/run-fold.ts`, given one run's events in `seq` order:

| `ScheduledRun` field | Value |
|---|---|
| `id`, `taskId`, `workspaceKey`, `occurrenceKey`, `scheduledFor`, `retryOfRunId` | First event |
| `status` | Last event's `type`; `started` maps to `running` |
| `startedAt` | `at` of the `started` event, else `null` |
| `finishedAt` | Last event's `at` if its type is not `started`, else `null` |
| `outcomeSummary`, `failureReason` | Last event's `summary`, `failure_reason` |
| `executionRequest` | The `started` event's `execution_request`, parsed; else `null` |

### Event sequences

| Case | Events |
|---|---|
| Normal run | `started` → `succeeded` or `failed` |
| Missed run | `missed` |
| Blocked run (no execution profile) | `missed` (scheduler) or `failed` (manual, retry) |
| Run Now | `started` with `source='manual'` → final |
| Retry | New `run_id`, `retry_of_run_id` set, `source='retry'`; original untouched |
| Interrupted run | `started` → `failed` with `source='recovery'` |

`RunStatus` values `scheduled` and `canceled` are declared in `model.ts` but never set. They get no event type and remain in the TypeScript union for compatibility.

### Crash recovery

At startup, before the first tick, `recoverInterruptedRuns(now)` finds every run whose last event is `started` and appends a `failed` event:

- `at`: the startup time;
- `source`: `recovery`;
- `summary` and `failure_reason`: `"Plugin server restarted while this run was in progress."`

Query: `SELECT s.run_id FROM run_events s INDEXED BY ix_events_started WHERE s.type = 'started' AND NOT EXISTS (SELECT 1 FROM run_events n WHERE n.run_id = s.run_id AND n.seq > s.seq)`. Measured ~105 ms at 500k events with ~2 KB summaries, once per startup. Because `lastRunStatus` is derived (§2), the task shows `failed` with no ledger write.

### Size

A run's `summary` holds up to 4,000 characters each of stdout and stderr (`OUTPUT_LIMIT`, `execution-adapter.ts:4`), and `execution_request` includes the full prompt when the profile uses the `{{prompt}}` template (`execution-adapter.ts:68–74`; with stdin transport it does not). Expect several KB per run. An every-minute task adds roughly **2–3 GB per year**. The file is appended to, never rewritten. Pruning is out of scope (see Out of scope).

## 2. `RunStore`, call sites and ledger writes

### Interface — `src/server/run-store.ts`

The event types live in `src/shared/model.ts` (so the client can import them) and are imported by `run-store.ts`:

```ts
// src/shared/model.ts
export type RunEventType = "started" | "succeeded" | "failed" | "missed";
export type RunEventSource = "scheduler" | "manual" | "retry" | "recovery" | "migrated";

export interface NewRunEvent {
  runId: string;
  workspaceKey: string;
  taskId: string;
  occurrenceKey: string;
  scheduledFor: string;
  type: RunEventType;
  at: string;
  source: RunEventSource;
  summary: string;
  failureReason?: string | null;
  retryOfRunId?: string | null;
  executionRequest?: Record<string, unknown> | null;
}

export interface RunEvent extends NewRunEvent { seq: number }
```

```ts
// src/server/run-store.ts
import type { NewRunEvent, RunEvent, ScheduledRun } from "../shared/model.js";

export interface RunPage { runs: ScheduledRun[]; nextCursor: string | null }

export interface TaskRunSummary {
  latest: ScheduledRun | null;          // newest run of the task, any status
  latestFinished: ScheduledRun | null;  // newest run with finishedAt set
}

export class RunStore {
  constructor(dbPath: string);  // ":memory:" in tests
  appendEvent(event: NewRunEvent): void;
  appendEvents(events: NewRunEvent[]): void;             // one transaction; used by migration and recovery
  getRun(runId: string): ScheduledRun | null;
  hasRun(runId: string): boolean;
  hasOccurrence(occurrenceKey: string): boolean;
  listRuns(workspaceKey: string, opts?: { limit?: number; before?: string | null; taskId?: string }): RunPage;
  listEvents(runId: string): RunEvent[];
  taskRunSummaries(taskIds: string[]): Map<string, TaskRunSummary>;
  recoverInterruptedRuns(now: string): number;           // returns runs closed
  close(): void;
}
```

### Query strategy

- **`listRuns`**: select first events only, then fold.
  1. `SELECT run_id, scheduled_for, seq FROM run_events f WHERE workspace_key = ? [AND task_id = ?] AND seq = (SELECT MIN(seq) FROM run_events WHERE run_id = f.run_id) [AND (scheduled_for, seq) < (?, ?)] ORDER BY scheduled_for DESC, seq DESC LIMIT ? + 1`
  2. Load all events for those run IDs (`WHERE run_id IN (...) ORDER BY run_id, seq`) and `foldRun` each.
  3. If `limit + 1` rows came back, drop the last and set `nextCursor` from the last kept run.
- **Cursor**: opaque string `"<scheduledFor>|<firstSeq>"`. An unparsable cursor is a 400 error.
- **`taskRunSummaries`**: per task, run the `listRuns` first-event query with `task_id = ?` in pages of 5. `latest` is the first run returned; `latestFinished` is the first returned run with `finishedAt` set, fetching further pages until found or exhausted (normally one page). Using the same query and order as `listRuns` guarantees the dashboard's "latest" is the run shown at the top of Recent Runs, including ties on `scheduled_for`. Measured 0.3 ms for 20 tasks at 500k events.
- **`hasOccurrence`**: `SELECT 1 FROM run_events WHERE occurrence_key = ? LIMIT 1`.
- **`recoverInterruptedRuns`**: the `ix_events_started` query in §1, then `appendEvents` in one transaction.

`limit` defaults to `RUN_PAGE_SIZE = 100` and is clamped to 1–500. `RUN_HISTORY_LIMIT` is removed.

### Wiring and startup

`src/server.ts`, in this order:

1. `assertSupportedNode(process.versions.node)` (§4). Exit 1 on failure.
2. Install the warning filter (§4).
3. Dynamically import `./server/run-store.js` and open `RunStore` at `<dataRoot>/runs.db`. On failure, write the path and SQLite message to stderr and exit 1.
4. `await migrateLedgerRuns(runStore)` (§3).
5. `runStore.recoverInterruptedRuns(now)`.
6. Construct `SchedulerService(executionAdapter, runStore)` and `startHttpServer(scheduler, runStore)`.
7. Start the 30 s tick: `setInterval(() => { scheduler.tickWithoutDispatcher().catch(logTickError) }, 30_000)`.

Every module other than `server.ts` imports `RunStore` with `import type`, so `node:sqlite` is not loaded before steps 1–2.

`buildGlobalDashboardSnapshot(filter, runStore)` and `resolveGlobalTask(workspaceKey, taskId, runStore)` take the store as a parameter. `http.ts` passes the one it received.

### Workspace key rule

Everywhere — runtime and migration — an event's `workspace_key` is `workspaceKeyFromPath(ledger.workspacePath)`, the same function that names the ledger file (`storage.ts:27`). The in-file `workspaceKey` field and the filename stem are never used for run storage.

### `lastRunStatus` is derived, not stored

- `WorkspaceTask.lastRunStatus` stays in the API type. It is filled when tasks are served: `scheduler.ts` `loadWorkspaceState`, `createTask`/`updateTask`/`pause`/`resume`/`duplicate` responses, and `readGlobalTaskState` call `taskRunSummaries` and set `lastRunStatus = latest?.status ?? task.legacyLastRunStatus ?? null`.
- New optional stored field `WorkspaceTask.legacyLastRunStatus?: RunStatus | null`. Only the migration sets it (§3), and only for tasks that had a non-null `lastRunStatus` but no imported runs (their runs were pushed out by the old 500-run cap). It is never written afterwards, and is ignored once the task has any run in `runs.db`. New tasks never have it.
- `saveWorkspaceLedger` writes `lastRunStatus: null` (v2 files never carry a real value). The task guard (`storage.ts:91`) accepts `lastRunStatus` and `legacyLastRunStatus` missing, `null` or a string.
- `dashboard.ts` `deriveTaskStatus` uses `TaskRunSummary.latest`. `storedTaskStatus` stays as the no-runs fallback but reads `legacyLastRunStatus` (absent → `never_run`). `lastRunFinishedAt` uses `latestFinished`. `findLatestActionableRunId` uses `latest`.

### Ledger writes are serialized and never span an execution

New helper in `scheduler.ts`:

```ts
private async mutateLedger<T>(workspacePath: string, fn: (ledger: WorkspaceLedger) => T | Promise<T>): Promise<T>
```

It takes a per-workspace in-process lock (a promise chain keyed by `workspaceKeyFromPath(workspacePath)`), **reloads** the ledger from disk, runs `fn`, and saves if `JSON.stringify` of the ledger differs from before `fn` ran. Then it releases the lock, also when `fn` throws.

Rules:

- **Not re-entrant.** Only public entry points take the lock: `createTask`, `updateTask`, `deleteTask`, `pauseTask`, `resumeTask`, `duplicateTask`, `saveExecutionProfile`, `loadWorkspaceState`, `listRuns`, and the scheduler's per-occurrence step. Code they share (for example `pauseTask` → `updateTask`, `loadWorkspaceState` → `refreshWorkspaceLedger`) is split into a private `…Locked(ledger, …)` variant that takes the already-loaded ledger and never calls `mutateLedger`.
- `fn` must not await the execution adapter or anything that takes the lock. No code holds a ledger object across an `await` of the execution adapter.
- `RunStore` calls are synchronous and may run inside `fn`.

### Call-site changes

| Location | Today | After |
|---|---|---|
| `scheduler.ts:287–313` tick loop | ledger loaded once per workspace, saved at end | per workspace: `try { … } catch (e) { logTickError(e) }`; each due occurrence is one claim (below); no save at the end |
| `scheduler.ts:292` occurrence check | `ledger.runs.some(...)` | inside the claim: `runStore.hasOccurrence(key)` |
| `scheduler.ts:325` missed | build run, `trimRuns`, set `lastRunStatus`, save | inside the claim: `appendEvent({ type: "missed", source: "scheduler" })` |
| `scheduler.ts:351` blocked | build run, `trimRuns`, set `lastRunStatus`, save | scheduled: inside the claim as `missed`; manual/retry: `appendEvent({ type: "failed" })` |
| `scheduler.ts:367–371` start | push `running` run, set status, save | see **Claiming a scheduled occurrence** below |
| `scheduler.ts:375–392` finish | mutate run, set status, save stale ledger | `appendEvent({ type: result.status })` only. **No ledger write.** |
| `scheduler.ts:210` Run Now | `executeTask(..., { manual: true })` | same, `source: "manual"` |
| `scheduler.ts:226` retry lookup | `ledger.runs.find` | `runStore.getRun(id)`; 404 "Run not found" unless `run.workspaceKey === workspaceKeyFromPath(workspacePath)`; `source: "retry"` |
| `scheduler.ts:107` workspace state | all runs | `listRuns(key)` first page + `runsNextCursor` |
| `scheduler.ts:113` `listRuns` | slice of all runs | `runStore.listRuns(key, opts)` |
| `dashboard.ts:239` | group `ledger.runs` | `runStore.taskRunSummaries(ledger.tasks.map(t => t.id))` |
| `dashboard.ts:289` | filter `ledger.runs` | `runStore.taskRunSummaries([taskId])` |
| `trimRuns`, `sortRunsDesc`, `latestRunsByTaskId`, `storedTaskStatus` | | deleted |

### Claiming a scheduled occurrence

Ticks overlap: `setInterval` does not wait, and a tick awaits each execution inline. A tick's view of a task (from `listWorkspaceLedgers` at tick start) can therefore be minutes old. Every decision about a due occurrence is made inside the lock against the freshly reloaded ledger, as a compare-and-set.

For each task the tick sees as due, with `scheduledFor = <the tick's view of task.nextRunAt>`:

1. **Claim, inside `mutateLedger`.** Reload. Let `task` be the fresh task and `key = occurrenceKeyForTask(task.id, scheduledFor)`. Proceed only if **all** hold:
   - `task` exists and `task.enabled`;
   - `task.nextRunAt === scheduledFor` (the user has not rescheduled, and no other tick has advanced it).

   If either fails, change nothing and skip this occurrence. If both hold but the occurrence is already known (`inFlightOccurrences.has(key) || runStore.hasOccurrence(key)`), set `task.nextRunAt = computeTaskNextRun(task, scheduledFor)` and skip execution; this is today's `alreadyTracked` branch (`scheduler.ts:294`). Otherwise, still inside the lock:
   - set `task.nextRunAt = computeTaskNextRun(task, scheduledFor)` from the fresh task;
   - if the execution profile is not ready, or `scheduledFor` is outside the 90 s grace window: `appendEvent({ type: "missed", source: "scheduler" })` and finish (no execution);
   - otherwise add `key` to `inFlightOccurrences` and `appendEvent({ type: "started", source: "scheduler", executionRequest })`.
2. **Execute, outside the lock.** Run the adapter. On completion or exception, `appendEvent` the final event. In `finally`, remove `key` from `inFlightOccurrences`.

Because the claim checks `nextRunAt === scheduledFor` and advances it atomically under the lock, two overlapping ticks cannot both claim one occurrence, and a stale tick cannot run a time the user has edited away. The existing missed-occurrence catch-up loop (`scheduler.ts:287`) keeps its shape: each iteration is one claim, re-reading `nextRunAt` from the fresh ledger.

Failure handling:

- The claim throws before saving (reload or `appendEvent` failure): the lock's save does not happen, `nextRunAt` is unchanged, `key` is removed from `inFlightOccurrences`, and the next tick retries.
- The save at the end of the claim throws after `started` was appended: the run is recorded and not executed. The tick removes `key` from `inFlightOccurrences` and appends `failed` (`summary` and `failure_reason`: "Could not save the schedule; run not started."). On the next tick `nextRunAt` still equals `scheduledFor` and `hasOccurrence(key)` is true, so the `alreadyTracked` branch advances `nextRunAt` without running it twice.
- The final `appendEvent` after execution throws: the run stays `started` until the next startup's recovery closes it.

**Manual runs and retries** (`createManualRun`, `retryRun`) do not claim: they do not move `nextRunAt` and use a fresh `scheduledFor = now`. They add their key to `inFlightOccurrences`, append `started` with `source: "manual"` or `"retry"`, execute, and append the final event.

The execution adapter runs only after the `started` event is written.

### Tick errors

`tickWithoutDispatcher` wraps each workspace in `try/catch`; a failure in one workspace is logged with its workspace key and does not stop the others. `logTickError` writes to stderr. The `setInterval` callback attaches `.catch(logTickError)` so nothing escapes as an unhandled rejection.

### HTTP API (backwards-compatible)

| Endpoint | Change |
|---|---|
| `GET /v1/runs?workspacePath=&limit=&before=&taskId=` | Adds `before` cursor and optional `taskId`; response adds `nextCursor`. Callers passing `workspacePath` and `limit` get the same `runs` array (newest first). **One behaviour change:** without `limit`, the default drops from 500 to 100 runs; callers that need more page with `before`. Non-integer `limit` → 400 `"limit must be an integer"`; out of range is clamped to 1–500. Bad cursor → 400 `"invalid cursor"`. |
| `GET /v1/runs/:id/events?workspacePath=` | **New.** Returns `RunEventsResponse` (below). 404 `"Run not found"` if the run does not exist or its `workspaceKey` differs from `workspaceKeyFromPath(workspacePath)`. |
| Workspace state response | `runs` holds the first page (100) instead of all; adds `runsNextCursor`. |

Contract types in `src/shared/contracts.ts`:

```ts
export interface ListRunsResponse { runs: ScheduledRun[]; nextCursor: string | null }   // new; today the handler returns an untyped { runs }
export interface WorkspaceStateResponse { /* existing fields */ runsNextCursor: string | null }
export interface RunEventsResponse {
  events: RunEvent[];                                        // seq order
  retryOf: { id: string; scheduledFor: string } | null;     // the original run, when this run is a retry and the original exists
}
```

`retryOf` is filled with `runStore.getRun(run.retryOfRunId)`; it is `null` when `retryOfRunId` is null or the original is not found.

### HTTP status codes

`http.ts` today turns every thrown error into 400 (`http.ts:224–227`). A new `HttpError extends Error { status: number }` in `src/server/http-error.ts` is thrown for 404 cases ("Run not found", "Task not found" in the new paths). The catch block uses `error instanceof HttpError ? error.status : 400`. Existing `throw new Error(...)` sites are unchanged and stay 400.

## 3. Migration and client

### Migration — `src/server/migrate-runs.ts`

`migrateLedgerRuns(store)` runs once per startup. It reads `dataRoot` directly (not through `listWorkspaceLedgers`). For each `*.json` file whose parsed object has a `runs` array:

1. **Backup.** If `<stem>.v1.json.bak` does not exist: copy to `<stem>.v1.json.bak.tmp`, then rename to `<stem>.v1.json.bak`.
2. **Key and target path.** `workspaceKey = workspaceKeyFromPath(normalizeWorkspacePath(file.workspacePath))`; `targetPath = <dataRoot>/<workspaceKey>.json`, the path `loadWorkspaceLedger` uses at runtime (`storage.ts:27`). If `workspacePath` is missing or not a string, skip the file and log to stderr. If `targetPath` differs from the file's path and a file already exists at `targetPath`:
   - if the file at `targetPath` has no `runs` array and every valid run in this file is already in the store (`hasRun`), this file is the leftover of an interrupted step 5: delete it and move on;
   - otherwise log "ledger name conflict: <file> vs <targetPath>" and skip the file (both stay untouched).
3. **Events.** For every run that passes the existing `isRunEntry` check and whose `id` is not already in the store (`hasRun`), build events with `source='migrated'` and the run's original `id`, `occurrenceKey`, `taskId`, `scheduledFor`, `retryOfRunId`:
   - status `succeeded`/`failed`/`missed`: a `started` event at `startedAt` with `executionRequest` if `startedAt` is set; then the final event at `finishedAt`. If `finishedAt` is null (never written by v0.2.0 for these statuses), use `startedAt`, then `scheduledFor`.
   - status `running`: `started` at `startedAt ?? scheduledFor`; then `failed` with `source='recovery'`, `at` = migration time, the recovery summary from §1.
   - status `scheduled` or `canceled`: skipped.
   - Entries failing `isRunEntry`, or whose `status` is not one of the six `RunStatus` values: counted and skipped; the count is logged to stderr with the file name. They remain in the `.bak`. (`isRunEntry` accepts any status string, `storage.ts:110`, and an unknown one would fail the `type` CHECK and abort the file's transaction.)
4. **Commit.** `store.appendEvents(events)` in one transaction.
5. **Rewrite.** Build the v2 object: `runs` removed, `version: 2`, and for each task:
   - if the task has at least one run in the store (after this import): `lastRunStatus: null`;
   - otherwise: `legacyLastRunStatus` = the file's `lastRunStatus` if it is a `RunStatus` other than `running`, else nothing; then `lastRunStatus: null`.

   Write it to a temp file in `dataRoot`, then rename to `targetPath`. If `targetPath` differs from the file that was read, delete the original after the rename. A crash between rename and delete leaves the original with `runs` still present; step 2's leftover rule removes it on the next startup.

Failure in any step for one file: log to stderr, leave the file unchanged, continue with the next file. The next startup retries.

Idempotence: a crash between steps 4 and 5 leaves `runs` in the file; the next startup's step 3 skips every imported run and step 5 completes. A file without `runs` is skipped.

### Ledger code — `src/server/storage.ts`, `src/shared/model.ts`

- `WorkspaceLedger.runs` removed. `STORAGE_VERSION` becomes `2`.
- `coerceLedgerShape` ignores `runs` entirely: a missing `runs` is valid and adds no repair note, and a leftover `runs` array (migration pending) is not read. The "metadata partially repaired" check becomes `!Array.isArray(record.tasks)`. This keeps migrated workspaces `available` rather than `partial` (`storage.ts:215`).
- `createEmptyLedger` drops `runs`.
- The task guard (`storage.ts:91`) accepts `lastRunStatus` missing, `null` or a string.

### Client — `run-history.ts`, `app.ts`, `api.ts`, `state.ts`

- State gains `runsNextCursor: string | null` and `runsTaskFilter: string | null`.
- **Task filter.** Recent Runs gets a select: "All tasks" plus each task name. Changing it reloads the first page with `taskId`.
- **Load older runs.** Shown when `runsNextCursor` is set. Calls `GET /v1/runs?workspacePath=<path>&before=<cursor>&limit=100[&taskId=]`, appends results, updates the cursor. Disabled while loading; on error, shows the message inline and stays enabled.
- **History toggle.** Per run. On first open it calls `GET /v1/runs/:id/events?workspacePath=<path>` and lists events as `<type> · <local time> · <source>`. `migrated` and `recovery` are labelled. When the response's `retryOf` is set, a line "Retry of run scheduled for <retryOf.scheduledFor, local time>" is shown above the events.
- **One merge helper for every refresh path.** New `mergeRuns(incoming: ScheduledRun[])` in `app.ts`:
  - drops runs whose `taskId` does not match `runsTaskFilter` (when set);
  - replaces entries with the same `id`, adds the rest;
  - re-sorts by `scheduledFor` desc (ties: keep server order);
  - keeps older pages already loaded and leaves `runsNextCursor` unchanged.

  It is used by:
  - `reconcileWorkspaceState` (`app.ts:692`);
  - the global-dashboard action path, which today calls `loadFromContext` directly and replaces `runs` (`app.ts:592`, `:667`);
  - Run Now and Retry, which today prepend the new run unconditionally (`app.ts:982`, `:1003`).

  Refreshes fetch the first page with the active filter: `GET /v1/runs?workspacePath=&taskId=<filter>` when a filter is set, otherwise the `runs` from the workspace state response. Changing workspace or the task filter replaces the list and cursor instead of merging.

## 4. Testing and rollout

### Node version guard and warnings

- `assertSupportedNode(version)` in `src/server/node-version.ts`: accepts `22.x` with minor ≥ 13, `23.x` with minor ≥ 4, and any major ≥ 24. Otherwise throws `Scheduled Prompt needs Node 22.13+ (found X)`. (`node:sqlite` still needs `--experimental-sqlite` on 23.0–23.3.)
- `package.json` `engines.node`: `">=22.13 <23 || >=23.4"`.
- Warning filter: `process.removeAllListeners("warning")`, then `process.on("warning", w => …)` which drops `ExperimentalWarning`s whose message mentions SQLite and writes every other warning to stderr as `${w.name}: ${w.message}`. It never calls `process.emitWarning`, which would recurse.

### New tests

`tests/unit/run-fold.test.ts`: `foldRun` for each event sequence in §1.

`tests/unit/run-store.test.ts` (in-memory database):
- append then `getRun`, for each event sequence;
- `UPDATE` and `DELETE` on `run_events` throw;
- `listRuns` paging: no duplicates or gaps across pages, including several runs sharing a `scheduledFor`; order is stable across calls; `taskId` filter; bad cursor throws;
- `taskRunSummaries`: `latest` and `latestFinished` while a run is in progress;
- `recoverInterruptedRuns` closes only runs whose last event is `started`, with the specified `at`, `source`, `summary`, and its query uses `ix_events_started` (`EXPLAIN QUERY PLAN`);
- `taskRunSummaries().latest` matches `listRuns({ taskId }).runs[0]`, including ties on `scheduledFor`;
- opening a file with `user_version` 2 throws;
- WAL is enabled on a file-backed database.

`tests/unit/migrate-runs.test.ts` (temporary data dir):
- v1 file → events + v2 file at the same path + `.bak`; migrated runs fold to the original `status`, `startedAt`, `finishedAt`, `outcomeSummary`, `failureReason`;
- `running` entry → `started` + recovery `failed`;
- crash between commit and rewrite, then re-run → no duplicates;
- invalid entries skipped and counted;
- filename stem different from `workspaceKeyFromPath(workspacePath)` → the original file is rewritten, no second file is created, events use the derived key;
- a file without `runs` is untouched; a second run is a no-op;
- an unknown run `status` is skipped and counted, and the rest of the file imports;
- a task whose runs were all pushed out by the old cap gets `legacyLastRunStatus`; a task with imported runs does not;
- name conflict with an unrelated file at the target path → both files untouched, conflict logged;
- leftover original after an interrupted rename → deleted on the next run.

`tests/unit/node-version.test.ts`: accepts `22.13.0`, `23.4.0`, `24.0.0`; rejects `22.12.9`, `23.3.0`, `20.18.0`.

`tests/integration/scheduler-concurrency.test.ts`:
- a task paused, edited or deleted while its run is executing stays paused, edited or deleted after the run finishes;
- a throwing `appendEvent` in one workspace does not stop the tick for another workspace and produces no unhandled rejection;
- retry with a run ID from another workspace → HTTP 404 "Run not found";
- two overlapping ticks reaching the same due occurrence → exactly one `started` event and one execution;
- a schedule edited while a stale tick still holds the old `nextRunAt` → the old occurrence is not executed;
- the claim's save fails after `started` → `failed` "Could not save the schedule" is recorded, and the next tick advances `nextRunAt` without executing.

`tests/integration/performance.test.ts` (extended): seed 500,000 events across 20 tasks in 5 workspaces. Budgets:
- first page of `listRuns` (workspace and per-task): < 50 ms;
- `taskRunSummaries` for all 20 tasks: < 50 ms;
- one `appendEvent`: < 5 ms.

### Existing tests

These files read or seed `runs` and change as follows:

| File | Change |
|---|---|
| `tests/integration/scheduler-loop.test.ts` | Rewritten: assertions on `ledger.runs` (lines 112–303) become `runStore.listRuns` / `getRun`. "Records all missed recurring occurrences in one tick" keeps its meaning. |
| `tests/integration/global-dashboard.test.ts` | Seed runs through `appendEvent`; pass the store to `buildGlobalDashboardSnapshot`. |
| `tests/integration/performance.test.ts` | `new SchedulerService(...)` (line 77) gains the store; `state.runs` length (line 86) changes from 500 to 100; `buildGlobalDashboardSnapshot` (line 127) gains the store; any `runs:` seeding goes through `appendEvent`. |
| `tests/integration/app-reconcile.test.ts` | Reconcile now merges pages; add cases where an older page survives an action, a global-dashboard action, and Run Now under a task filter. |
| `tests/unit/dashboard.test.ts` | Replace `runs:` seed objects with `TaskRunSummary` inputs; status derivation from `latest`; `legacyLastRunStatus` fallback; `never_run` when neither. |
| `tests/unit/storage.test.ts` | Replace `runs:` seed objects; a ledger without `runs` is `available`; no `runs` written; missing `lastRunStatus` / `legacyLastRunStatus` accepted. |
| `tests/integration/run-history.test.ts` | Add Load older runs, task filter and History toggle cases. |

### Rollout

1. Fork `krugerm/cloudcli-cron` (done), branch `003-run-event-log` (done).
2. This design plus the spec-kit spec; implementation plan next.
3. Build and test on the branch.
4. Point the installed plugin at the fork: `git -C ~/.claude-code-ui/plugins/cloudcli-cron remote set-url origin https://github.com/krugerm/cloudcli-cron.git`, check out the branch, then **Update** in CloudCLI plugin settings (runs `git pull`, `npm install`, `npm run build`). Task data in `~/.cloudcli-workspace-scheduled-prompts/` is outside the plugin folder and is not touched by the switch.
5. Open a PR to `grostim/cloudcli-cron:master`.
6. Start `004-cron-expressions` from this branch.

### Done when

- `npm test` passes on Node 22.23.
- `npm run build` succeeds.
- In the real CloudCLI install: a test task runs and shows its event history; restarting the plugin mid-run produces a `recovery` event and the task shows `failed`; Load older runs pages correctly; pausing a task during a run keeps it paused.

## Out of scope

- Moving task definitions into SQLite.
- Pruning or exporting history. At 2–3 GB/year per every-minute task, a retention option is the likely next feature.
- Cron expressions (`004-cron-expressions`).
- Removing events of deleted workspaces or tasks.
- The tick awaiting a long execution before moving to the next task in the same workspace (existing behaviour; revisit in `004` for sub-daily schedules).
