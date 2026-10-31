# Run Event Log — Design

**Date:** 2026-10-29 (revised 2026-10-31 after six review rounds)
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
-- Workspace run pages (creation order)
CREATE INDEX ix_events_ws_page    ON run_events (workspace_key, seq DESC);
-- Per-task run pages and dashboard summaries (creation order)
CREATE INDEX ix_events_task_page  ON run_events (task_id, seq DESC);
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
- A run's **`sequence`** is the `seq` of its first event. Runs are ordered by `sequence DESC` (newest-recorded first) everywhere: API pages, the client list, and `taskRunSummaries`. This is the single definition of run order.
- Why creation order, not `scheduled_for`: a run can be recorded long after its scheduled time (catch-up after downtime, a task delayed behind another task's execution). Under scheduled-time order such a run lands inside a range the client has already paged past, and neither a first-page refresh nor "Load older" ever returns it. Under creation order every new run sorts above every existing run, so page boundaries never move. Run IDs are random UUIDs and are never used for ordering.

### Folding events into a `ScheduledRun` — `foldRun(events)`

A pure function in `src/server/run-fold.ts`, given one run's events in `seq` order:

| `ScheduledRun` field | Value |
|---|---|
| `id`, `taskId`, `workspaceKey`, `occurrenceKey`, `scheduledFor`, `retryOfRunId` | First event |
| `sequence` (**new field** on `ScheduledRun`, `number`) | First event's `seq` |
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

- `runId`, `workspaceKey`, `taskId`, `occurrenceKey`, `scheduledFor`, `retryOfRunId`: copied from the run's first event;
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
  1. `SELECT run_id, seq FROM run_events f WHERE workspace_key = ? [AND task_id = ?] AND seq = (SELECT MIN(seq) FROM run_events WHERE run_id = f.run_id) [AND seq < ?] ORDER BY seq DESC LIMIT ? + 1`
  2. Load all events for those run IDs (`WHERE run_id IN (...) ORDER BY run_id, seq`) and `foldRun` each.
  3. If `limit + 1` rows came back, drop the last and set `nextCursor` from the last kept run.
- **Cursor**: the `sequence` of the last run on the page, as a decimal string. Anything that is not a positive integer is a 400 error. Measured at 500k events: 0.23 ms for a workspace page (first or deep), 0.09 ms for a task page.
- **`taskRunSummaries`**: per task, the first-event query filtered by `task_id = ?` only (no `workspace_key` condition; task IDs are UUIDs), in pages of 5. `latest` is the first run returned; `latestFinished` is the first returned run with `finishedAt` set, fetching further pages until found or exhausted (normally one page). It uses the run order defined in §1, so the dashboard's "latest" is the run at the top of that task's Recent Runs.
- **`hasOccurrence`**: `SELECT 1 FROM run_events WHERE occurrence_key = ? LIMIT 1`.
- **`recoverInterruptedRuns`**: the `ix_events_started` query in §1, then `appendEvents` in one transaction.

`limit` defaults to `RUN_PAGE_SIZE = 100` and is clamped to 1–500. `RUN_HISTORY_LIMIT` is removed.

### Wiring and startup

`src/server.ts`, in this order:

1. `assertSupportedNode(process.versions.node)` (§4). Exit 1 on failure.
2. Install the warning filter (§4).
3. Dynamically import `./server/run-store.js` and open `RunStore` at `<dataRoot>/runs.db`. On failure, write the path and SQLite message to stderr and exit 1.
4. `const frozenKeys = await migrateLedgerRuns(runStore)` (§3), then `setFrozenWorkspaceKeys(frozenKeys)` (new, `storage.ts`), which `listWorkspaceLedgerRecords` reads.
5. `runStore.recoverInterruptedRuns(now)`.
6. Construct `SchedulerService(executionAdapter, runStore, frozenKeys)` (`frozenKeys` defaults to an empty set, so tests pass only the store) and `startHttpServer(scheduler, runStore)`.
7. Start the 30 s tick: `setInterval(() => { scheduler.tickWithoutDispatcher().catch(logTickError) }, 30_000)`.

Every module other than `server.ts` imports `RunStore` with `import type`, so `node:sqlite` is not loaded before steps 1–2.

`buildGlobalDashboardSnapshot(filter, runStore)` and `resolveGlobalTask(workspaceKey, taskId, runStore)` take the store as a parameter. `http.ts` passes the one it received. The global dashboard's reads (`listWorkspaceLedgerRecords`, `readGlobalTaskState`) only read ledger files and never save them, as today.

### Workspace key rule

Everywhere — runtime and migration — an event's `workspace_key` is `workspaceKeyFromPath(ledger.workspacePath)`, the same function that names the ledger file (`storage.ts:27`). It normalizes the path itself (`workspace.ts:12–14`), so no caller normalizes first. The in-file `workspaceKey` field and the filename stem are never used for run storage.

### `lastRunStatus` is derived, not stored

- `WorkspaceTask.lastRunStatus` stays in the API type. **Every** response that returns a `WorkspaceTask` (workspace state, task create/update/pause/resume/duplicate, `readGlobalTaskState`, `resolveGlobalTask`, global-dashboard actions) fills it on a copy of the task — never on the ledger object inside `fn`, so serving a task never changes the file — as `latest?.status ?? task.legacyLastRunStatus ?? null`, with `latest` from `taskRunSummaries`. `updateTask` ignores any `lastRunStatus` or `legacyLastRunStatus` in the request.
- New optional stored field `WorkspaceTask.legacyLastRunStatus?: RunStatus | null`. Only the migration sets it (§3), and only for tasks that had a non-null `lastRunStatus` but no imported runs (their runs were pushed out by the old 500-run cap). It is never written afterwards, and is ignored once the task has any run in `runs.db`. New tasks never have it: `createTask` does not set it, and `duplicateTask` (which spreads `...source`, `scheduler.ts:193–201`) deletes it from the copy.
- `saveWorkspaceLedger` writes `lastRunStatus: null` (v2 files never carry a real value). The task guard (`storage.ts:91`) accepts `lastRunStatus` and `legacyLastRunStatus` missing, `null` or a string.
- `dashboard.ts` `deriveTaskStatus` uses `TaskRunSummary.latest`. `storedTaskStatus` stays as the no-runs fallback but reads `legacyLastRunStatus` (absent → `never_run`). `lastRunFinishedAt` uses `latestFinished`. `findLatestActionableRunId` uses `latest`.

### Ledger writes are serialized and never span an execution

New helper in `scheduler.ts`:

```ts
private async mutateLedger<T>(workspacePath: string, fn: (ledger: WorkspaceLedger) => T | Promise<T>): Promise<T>
```

It takes a per-workspace in-process lock (a promise chain keyed by `workspaceKeyFromPath(workspacePath)`), **reloads** the ledger from disk, runs `fn`, and saves if `JSON.stringify` of the ledger differs from before `fn` ran. It releases the lock in `finally`, whether `fn` or the save throws.

Rules:

- **Not re-entrant.** Only public entry points take the lock: `createTask`, `updateTask`, `deleteTask`, `pauseTask`, `resumeTask`, `duplicateTask`, `saveExecutionProfile`, `loadWorkspaceState`, and the scheduler's claim. Code they share (for example `pauseTask` → `updateTask`, `loadWorkspaceState` → `refreshWorkspaceLedger`) is split into a private `…Locked(ledger, …)` variant that takes the already-loaded ledger and never calls `mutateLedger`.
- **`listRuns` is read-only.** It reads `runs.db` and the ledger file without the lock and never refreshes or saves the ledger.
- **One locked call per workspace-state request.** `http.ts:82` today calls `refreshWorkspaceLedger` directly (only to read the execution profile) and then `loadWorkspaceState`, which refreshes again. The direct call is removed; the signature becomes `loadWorkspaceState(workspacePath, capabilityFor: (profile: ExecutionProfile | null) => ExecutionCapability)`, and the refresh, capability and response are built inside one `mutateLedger` (`capabilityFor` is synchronous). `refreshWorkspaceLedger` is no longer public.
- `fn` must not await the execution adapter or anything that takes the lock. No code holds a ledger object across an `await` of the execution adapter.
- `RunStore` calls are synchronous and may run inside `fn`.

**The refresh never takes a due occurrence away from the tick.** Today `refreshWorkspaceLedger` recomputes every task's `nextRunAt` from *now* (`scheduler.ts:262–268`), so a page load between 09:00:00 and the tick moves a 09:00 daily task to tomorrow and the occurrence is lost without a trace. New rule for the refresh: if `task.enabled` and `task.nextRunAt` is non-null and `<= now`, leave `nextRunAt` unchanged (the tick claims it, runs it or records it as `missed`). Otherwise recompute it from now, as today. `recurrenceSummary` is still refreshed in both cases.

**`nextRunAt` on task edits.** Today `updateTask` recomputes `nextRunAt` from now on every edit (`taskWithComputedFields`, `scheduler.ts:165–166`), so editing a prompt inside the due window silently drops the occurrence. New rule, the only place `updateTask` sets `nextRunAt` (the first matching row wins):

| Edit | `nextRunAt` |
|---|---|
| `enabled` changes to `false` (pause) | `null` |
| `enabled` changes to `true` (resume) | recomputed from now (occurrences during the pause are neither run nor recorded) |
| `recurrence` present and different from the stored one, compared as canonical JSON (keys sorted recursively) after both the request's and the stored recurrence pass `validateRecurrenceDefinition`, so key order and formatting never count as a change | recomputed from now (for a paused task this stays `null`: `computeTaskNextRun` returns `null` when `enabled` is false, `recurrence.ts:175`) |
| anything else (name, prompt, unchanged recurrence) | unchanged |

`duplicateTask` creates a new task, so its `nextRunAt` is computed from now, as today.

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
| `scheduler.ts:226` retry lookup | `ledger.runs.find` | `runStore.getRun(id)` plus the workspace check in §2 "HTTP status codes"; `source: "retry"` |
| `scheduler.ts:107` workspace state | all runs | `listRuns(key)` first page + `runsNextCursor` |
| `scheduler.ts:113` `listRuns` | slice of all runs | `runStore.listRuns(key, opts)` |
| `dashboard.ts:239` | group `ledger.runs` | `runStore.taskRunSummaries(ledger.tasks.map(t => t.id))` |
| `dashboard.ts:289` | filter `ledger.runs` | `runStore.taskRunSummaries([taskId])` |
| `trimRuns`, `sortRunsDesc`, `latestRunsByTaskId` | | deleted |

### Claiming a scheduled occurrence

Ticks overlap: `setInterval` does not wait, and a tick awaits each execution inline. A tick's view of a task (from `listWorkspaceLedgers` at tick start) can therefore be minutes old. Every decision about a due occurrence is made inside the lock against the freshly reloaded ledger, as a compare-and-set.

For each task the tick sees as due, with `scheduledFor = <the tick's view of task.nextRunAt>`:

1. **Claim, inside `mutateLedger`.** Reload. Let `task` be the fresh task and `key = occurrenceKeyForTask(task.id, scheduledFor)`. Proceed only if **all** hold:
   - `task` exists and `task.enabled`;
   - `task.nextRunAt === scheduledFor` (the user has not rescheduled, and no other tick has advanced it).

   If either fails, change nothing and skip this occurrence. If both hold but the occurrence is already known (`inFlightOccurrences.has(key) || runStore.hasOccurrence(key)`), set `task.nextRunAt = computeTaskNextRun(task, scheduledFor)` and skip execution; this is today's `alreadyTracked` branch (`scheduler.ts:294`). Otherwise, still inside the lock:
   - set `task.nextRunAt = computeTaskNextRun(task, scheduledFor)` from the fresh task;
   - if the execution profile is not ready, or `tickStartedAt - scheduledFor > 90 s` (today's grace window and reference time, `scheduler.ts:300`): `appendEvent({ type: "missed", source: "scheduler" })` and finish (no execution);
   - otherwise add `key` to `inFlightOccurrences` and `appendEvent({ type: "started", source: "scheduler", executionRequest })`.
2. **Execute, outside the lock.** Run the adapter. On completion or exception, `appendEvent` the final event. In `finally`, remove `key` from `inFlightOccurrences`.

Because the claim checks `nextRunAt === scheduledFor` and advances it atomically under the lock, two overlapping ticks cannot both claim one occurrence, and a stale tick cannot run a time the user has edited away. The existing missed-occurrence catch-up loop (`scheduler.ts:287`) keeps its shape. Each claim returns the fresh task's `nextRunAt` after the claim (or `null` if the task was skipped because it is gone, paused or was rescheduled); the loop continues with that value as the next `scheduledFor` while it is `<= tickStartedAt`, and stops on `null` or after an execution, as today.

Failure handling:

- The claim throws before saving (reload or `appendEvent` failure): the lock's save does not happen, `nextRunAt` is unchanged, `key` is removed from `inFlightOccurrences`, and the next tick retries.
- The save at the end of the claim throws after `missed` was appended: nothing else to do; on the next tick `nextRunAt` still equals `scheduledFor`, `hasOccurrence(key)` is true, and the `alreadyTracked` branch advances it.
- The save at the end of the claim throws after `started` was appended (the claim sets a local `startedAppended` flag immediately after that `appendEvent` returns, and the tick checks it): the run is recorded and not executed. The tick removes `key` from `inFlightOccurrences` and appends `failed` (`summary` and `failure_reason`: "Could not save the schedule; run not started."). On the next tick `nextRunAt` still equals `scheduledFor` and `hasOccurrence(key)` is true, so the `alreadyTracked` branch advances `nextRunAt` without running it twice.
- The final `appendEvent` after execution throws: the run stays `started` until the next startup's recovery closes it.

**Manual runs and retries** (`createManualRun`, `retryRun`) do not claim: they do not move `nextRunAt` and use a fresh `scheduledFor = now`. Their occurrence key is `` `${taskId}:manual:${runId}` `` (today's `occurrenceKeyForTask` format is `${taskId}:${scheduledFor}`), so it can never equal a scheduled occurrence's key. They add that key to `inFlightOccurrences`, append `started` with `source: "manual"` or `"retry"`, execute, and append the final event.

**Event summaries at runtime:** `started` → `"Command started."` (today's `createRunningRun` text); `missed` → today's text: the capability message when the profile is not ready, else `"Automatic execution was unavailable at the scheduled time."`; final events → the adapter result's `outcomeSummary` and `failureReason`, or the exception message, as today.

The execution adapter runs only after the `started` event is written.

### Tick errors

`tickWithoutDispatcher` wraps each workspace in `try/catch`; a failure in one workspace is logged with its workspace key and does not stop the others. `logTickError` writes to stderr. The `setInterval` callback attaches `.catch(logTickError)` so nothing escapes as an unhandled rejection.

### HTTP API (backwards-compatible)

| Endpoint | Change |
|---|---|
| `GET /v1/runs?workspacePath=&limit=&before=&taskId=` | Adds `before` cursor and optional `taskId`; response adds `nextCursor`. Callers passing `workspacePath` and `limit` get the same `runs` array (newest first). **One behaviour change:** without `limit`, the default drops from 500 to 100 runs; callers that need more page with `before`. Non-integer `limit` → 400 `"limit must be an integer"`; out of range is clamped to 1–500. Bad cursor → 400 `"invalid cursor"`. |
| `GET /v1/runs/:id/events?workspacePath=` | **New.** Returns `RunEventsResponse` (below). Not-found handling: §2 "HTTP status codes". |
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

`retryOf` is filled with `runStore.getRun(run.retryOfRunId)`; it is `null` when `retryOfRunId` is null, the original is not found, or the original's `workspaceKey` differs from the requested workspace's.

### HTTP status codes

`http.ts` today turns every thrown error into 400 (`http.ts:224–227`). A new `HttpError extends Error { status: number }` in `src/server/http-error.ts` carries a status; the catch block uses `error instanceof HttpError ? error.status : 400`.

The complete list of `HttpError(404, "Run not found")` cases:

- `retryRun` (`scheduler.ts:228`, today a plain `Error` → 400): the run does not exist, or `run.workspaceKey !== workspaceKeyFromPath(workspacePath)`;
- `GET /v1/runs/:id/events`: the same two conditions.

`HttpError(409, "Run history import pending")` is thrown only for a frozen workspace, by the methods listed in §3 Migration. Every other existing `throw new Error(...)` site is unchanged and stays 400; that includes "Task not found" when a manual run or retry targets a deleted task.

## 3. Migration and client

### Migration — `src/server/migrate-runs.ts`

`migrateLedgerRuns(store)` runs once per startup. It reads `dataRoot` directly (not through `listWorkspaceLedgers`). For each `*.json` file whose parsed object has a `runs` array:

1. **Backup.** If `<stem>.v1.json.bak` does not exist: copy to `<stem>.v1.json.bak.tmp`, then rename to `<stem>.v1.json.bak`.
2. **Key and target path.** `workspaceKey = workspaceKeyFromPath(file.workspacePath)` (the rule in §2 "Workspace key rule"); `targetPath = <dataRoot>/<workspaceKey>.json`, the path `loadWorkspaceLedger` uses at runtime (`storage.ts:27`). If `workspacePath` is missing or not a string, skip the file and log to stderr. If `targetPath` differs from the file's path and a file already exists at `targetPath`:
   - if the file at `targetPath` has `migratedFrom` equal to this file's name, this file is the leftover of an interrupted step 5: delete it and move on;
   - otherwise log "ledger name conflict: <file> vs <targetPath>" and skip the file (both stay untouched).
3. **Events.** Timestamps (`scheduledFor`, `startedAt`, `finishedAt`) are normalized with `new Date(x).toISOString()`; a run with an unparsable timestamp counts as invalid (below). Runs are processed in ascending `scheduledFor`, then ascending `startedAt` (missing first), then position in the file, so their `sequence` follows schedule order and a retry sorts after its original. Among entries that pass validation, the first in this processing order with a given `id` is imported; later entries with that `id` count as invalid. An `id` already in the store from **another** file is also counted as invalid and logged ("run id already imported from <other workspace key>"); an `id` already in the store from this file's own earlier, interrupted import is skipped silently (that is the idempotence path). For every run that passes the existing `isRunEntry` check and whose `id` is not already in the store (`hasRun`), build events with `source='migrated'` and the run's original `id`, `occurrenceKey`, `taskId`, `scheduledFor`, `retryOfRunId`:
   - status `succeeded`/`failed`/`missed`: a `started` event at `startedAt` with `executionRequest` and `summary: "Command started."` (today's `createRunningRun` text) if `startedAt` is set; then the final event at `finishedAt` with the run's `outcomeSummary` and `failureReason`. If `finishedAt` is null (never written by v0.2.0 for these statuses), use `startedAt`, then `scheduledFor`.
   - status `running`: `started` at `startedAt ?? scheduledFor`; then `failed` with `source='recovery'`, `at` = migration time, the recovery summary from §1.
   - status `scheduled` or `canceled` (never written by v0.2.0): counted as invalid.
   - A run without `startedAt` gets no `started` event, so its `executionRequest` (if any) is kept only in the `.bak`.
   - Entries failing `isRunEntry`, or whose `status` is not one of the six `RunStatus` values: counted and skipped; the count is logged to stderr with the file name. They remain in the `.bak`. (`isRunEntry` accepts any status string, `storage.ts:110`, and an unknown one would fail the `type` CHECK and abort the file's transaction.)
4. **Commit.** `store.appendEvents(events)` in one transaction.
5. **Rewrite.** Build the v2 object:
   - `runs` removed, `version: 2`;
   - `workspacePath` (top-level and per task) set to `normalizeWorkspacePath(file.workspacePath)`;
   - top-level `workspaceKey` and every task's `workspaceKey` set to the derived `workspaceKey` from step 2 (otherwise `coerceLedgerShape` reports "workspace key was repaired from the filename" and marks the workspace `partial`, `storage.ts:161`, `:215`);
   - if `targetPath` differs from the file that was read: `migratedFrom: "<original file name>"`;
   - each task: `lastRunStatus: null`, and `legacyLastRunStatus` set only when the task has no run in the store after step 4 and the file's `lastRunStatus` is a `RunStatus` other than `running` (field defined in §2 "`lastRunStatus` is derived, not stored").

   Write it to `<targetPath>.tmp` (not matched by the `*.json` scan), then rename to `targetPath`. If `targetPath` differs from the file that was read, delete the original after the rename. A crash between rename and delete leaves the original; step 2's leftover rule removes it on the next startup because the target names it in `migratedFrom`.

`migratedFrom` is an optional string on `WorkspaceLedger`, written only here (persistence: "Ledger code" below).

Failure in any step for one file: log to stderr, leave the file unchanged, continue with the next file. The next startup retries.

**A workspace whose import failed is frozen until a later start imports it.** Otherwise a later save (refresh, claim, edit) would write the ledger without `runs` and the v0.2.0 history would be lost, and any run recorded meanwhile would get a lower `sequence` than the old runs imported later.

`migrateLedgerRuns` returns `frozenKeys: Set<string>`: the derived `workspaceKey` (step 2) of every file whose steps 1–5 failed. Name conflicts (step 2) are not frozen; they are the accepted limit stated there. The set is handed out once at startup (§2 "Wiring and startup", steps 4 and 6) and is fixed for the life of the process. For a key in `frozenKeys`:
- `listWorkspaceLedgerRecords` reports the workspace `unavailable` with the warning "Run history import failed; it will be retried at the next start. See the plugin log." — for the failed file and for any ledger file at the derived path;
- the tick skips it;
- `mutateLedger`, `createManualRun` and `retryRun` throw `HttpError(409, "Run history import pending")` before reading or writing anything — so neither a misnamed file's target path nor the original can be created or saved, and no run is recorded;
- `listRuns` and the events endpoint return its already-imported runs (none, until the import commits).

Keying by the derived `workspaceKey` (not by the file) is what freezes a misnamed file's workspace too: runtime loads go to `<derivedKey>.json` (§3 step 2), which the freeze blocks.

Idempotence: a crash between steps 4 and 5 leaves `runs` in the file; the next startup's step 3 skips every imported run and step 5 completes. A file without `runs` is skipped.

### Ledger code — `src/server/storage.ts`, `src/shared/model.ts`

- `WorkspaceLedger.runs` removed. `STORAGE_VERSION` becomes `2`.
- `coerceLedgerShape` ignores `runs`: a missing `runs` is valid and adds no repair note, and a leftover array is never read outside the migration. Whether a workspace is frozen comes only from `frozenKeys` (above). The "metadata partially repaired" check becomes `!Array.isArray(record.tasks)`. This keeps migrated workspaces `available` rather than `partial` (`storage.ts:215`).
- `createEmptyLedger` drops `runs`.
- `coerceLedgerShape` copies `migratedFrom` through when it is a string, so later saves keep it (§3 step 5).
- Task guard: see §2 "`lastRunStatus` is derived, not stored".

### Client — `run-history.ts`, `app.ts`, `api.ts`, `state.ts`

- State gains `runsNextCursor: string | null` and `runsTaskFilter: string | null`.
- **Task filter.** Recent Runs gets a select: "All tasks" plus each task name. Changing it reloads the first page with `taskId`.
- **Load older runs.** Shown when `runsNextCursor` is set. Calls `GET /v1/runs?workspacePath=<path>&before=<cursor>&limit=100[&taskId=]`, appends results, updates the cursor. Disabled while loading; on error, shows the message inline and stays enabled.
- **History toggle.** Per run. **Every** open calls `GET /v1/runs/:id/events?workspacePath=<path>` (no cache, so a run opened while `running` shows its final event the next time it is opened) and lists events as `<type> · <local time> · <source>`. `migrated` and `recovery` are labelled. When the response's `retryOf` is set, a line "Retry of run scheduled for <retryOf.scheduledFor, local time>" is shown above the events.
- **Refresh after actions.** Run Now, Retry, `reconcileWorkspaceState` (`app.ts:692`) and the global-dashboard action path (`app.ts:592`, `:667`) refresh the list by **reloading it**: `GET /v1/runs?workspacePath=<path>[&taskId=<filter>]&limit=<n>`, where `n` = the number of runs currently shown, at least 100 and at most 500 (the API maximum). The response replaces the list and the cursor. Run Now and Retry no longer insert their returned run into the list (today's prepend at `app.ts:982`, `:1003` is removed); the reload brings it in. The global-dashboard path reloads only when the action's workspace is the loaded one, as today (`app.ts:590`). There is no client-side merge: because runs are in creation order (§1), a reload of the top `n` runs is always a consistent prefix of the history, and "Load older" continues from its cursor.
- **List generation.** State gains `runsGeneration: number`. Workspace switch, first load, filter change and every reload increment it **when the request is sent**, and record the new value with the request. "Load older" does not increment it; it records the current value. A response is applied only if its recorded generation still equals `runsGeneration`; a Load older response additionally requires that its `before` still equals the current `runsNextCursor` (a reload sent before it may have moved the cursor). Otherwise it is dropped. So a Load older response is dropped once any reload, filter change or workspace switch has been sent after it, and only the most recently sent reload can replace the list (no older state can overwrite a newer one).
- **`loadFromContext`** (workspace switch, `app.ts:542`, first load, and the refresh paths above) loads tasks and status from the workspace-state response as today, but **ignores its `runs` and `runsNextCursor`**. The run list always comes from a separate, generation-tagged `GET /v1/runs?workspacePath=<path>&limit=<n>[&taskId=<filter>]` (first load and workspace switch: `n` = 100). A workspace switch also resets `runsTaskFilter` to `null`. Task and status data are applied as today regardless of the generation check, which covers only the run list.
- The client uses `ListRunsResponse` from `contracts.ts` (`RunPage` is server-internal).

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
- `listRuns` paging: no duplicates or gaps across pages; a run recorded after page 1 was read (even with an older `scheduledFor`) never appears on page 2 or later; `taskId` filter; bad cursor throws;
- `taskRunSummaries`: `latest` and `latestFinished` while a run is in progress;
- `recoverInterruptedRuns` closes only runs whose last event is `started`, with the specified `at`, `source`, `summary`, and its query uses `ix_events_started` (`EXPLAIN QUERY PLAN`);
- `taskRunSummaries().latest` matches `listRuns({ taskId }).runs[0]`;
- opening a file with `user_version` 2 throws;
- WAL is enabled on a file-backed database.

`tests/unit/migrate-runs.test.ts` (temporary data dir):
- v1 file whose name matches its path → events + v2 file at the same path + `.bak`; migrated runs fold to the original `status`, `startedAt`, `finishedAt`, `outcomeSummary`, `failureReason`;
- `running` entry → `started` + recovery `failed`;
- crash between commit and rewrite, then re-run → no duplicates;
- invalid entries skipped and counted;
- filename stem different from `workspaceKeyFromPath(workspacePath)` → the ledger is moved to `<derivedKey>.json` with `migratedFrom` and the derived `workspaceKey`, the original is removed, events use the derived key, and the workspace loads as `available`;
- a file without `runs` is untouched; a second run is a no-op;
- an import that fails (e.g. `appendEvents` throws) leaves the file with `runs` and its derived key in `frozenKeys`: `unavailable`, skipped by the tick, edits, Run Now and Retry → 409; for a misnamed file, opening its workspace creates no `<derivedKey>.json`; the next start imports it;
- a run `id` present in two workspaces' files: imported for the first, counted invalid and logged for the second;
- duplicate run `id`s in one file: first imported, rest counted invalid;
- an unknown run `status` is skipped and counted, and the rest of the file imports;
- a task whose runs were all pushed out by the old cap gets `legacyLastRunStatus`; a task with imported runs does not;
- name conflict with an unrelated file at the target path → both files untouched, conflict logged;
- leftover original after an interrupted rename → deleted on the next run; an unrelated file with the same target is not deleted even if it has `runs: []`;
- migrated `started` events have summary "Command started.".

`tests/unit/node-version.test.ts`: accepts `22.13.0`, `23.4.0`, `24.0.0`; rejects `22.12.9`, `23.3.0`, `20.18.0`.

`tests/integration/scheduler-concurrency.test.ts`:
- a task paused, edited or deleted while its run is executing stays paused, edited or deleted after the run finishes;
- a throwing `appendEvent` in one workspace does not stop the tick for another workspace and produces no unhandled rejection;
- retry with a run ID from another workspace → HTTP 404 "Run not found";
- two overlapping ticks reaching the same due occurrence → exactly one `started` event and one execution;
- a schedule edited while a stale tick still holds the old `nextRunAt` → the old occurrence is not executed;
- the claim's save fails after `started` → `failed` "Could not save the schedule" is recorded, and the next tick advances `nextRunAt` without executing;
- a workspace-state load between an occurrence's due time and the tick → the occurrence still runs (or is recorded `missed`), and `nextRunAt` is not advanced by the load;
- `GET /v1/runs` never writes the ledger file;
- `duplicateTask` of a task with `legacyLastRunStatus` → the copy has none;
- editing a task's prompt inside the due window keeps `nextRunAt` (also when the request repeats the stored recurrence with different key order), and the occurrence runs; resuming recomputes from now; a manual run's occurrence key never matches a scheduled one.

`tests/integration/performance.test.ts` (extended): seed 500,000 events across 20 tasks in 5 workspaces. Budgets:
- first page of `listRuns` (workspace and per-task): < 50 ms;
- `taskRunSummaries` for all 20 tasks: < 50 ms;
- one `appendEvent`: < 5 ms.

### Existing tests

These files read or seed `runs` and change as follows:

| File | Change |
|---|---|
| `tests/integration/scheduler-loop.test.ts` | Rewritten: assertions on `ledger.runs` (lines 112–303) become `runStore.listRuns` / `getRun`. "Records all missed recurring occurrences in one tick" keeps its meaning. |
| `tests/integration/global-dashboard.test.ts` | Seed runs through `appendEvent`; pass the store to `buildGlobalDashboardSnapshot`; `startHttpServer(new SchedulerService())` at lines 887 and 999 gains the store. |
| `tests/integration/performance.test.ts` | `new SchedulerService(...)` (line 77) gains the store; `state.runs` length (line 86) changes from 500 to 100; `buildGlobalDashboardSnapshot` (line 127) gains the store; any `runs:` seeding goes through `appendEvent`. |
| `tests/integration/app-reconcile.test.ts` | Reconcile reloads the top `n` runs (100–500) instead of replacing with the state response's runs; add cases: 3 loaded pages are still shown after an action, after a global-dashboard action, and after Run Now under a task filter. |
| `tests/unit/dashboard.test.ts` | Replace `runs:` seed objects with `TaskRunSummary` inputs; status derivation from `latest`; `legacyLastRunStatus` fallback; `never_run` when neither. |
| `tests/unit/storage.test.ts` | Replace `runs:` seed objects; a ledger without `runs` is `available`; no `runs` written; missing `lastRunStatus` / `legacyLastRunStatus` accepted. |
| `tests/integration/run-history.test.ts` | Add Load older runs, task filter and History toggle cases; a refresh after 3 loaded pages reloads 300 runs; a Load older response arriving after a reload, filter change or workspace switch is dropped, including one sent while a reload was in flight that moved the cursor; of two overlapping reloads only the later-sent one is applied. |

### Rollout

1. Fork `krugerm/cloudcli-cron` (done), branch `003-run-event-log` (done).
2. This design plus the spec-kit spec; implementation plan next.
3. Build and test on the branch.
4. Point the installed plugin at the fork: `git -C ~/.claude-code-ui/plugins/cloudcli-cron remote set-url origin https://github.com/krugerm/cloudcli-cron.git`, check out the branch, then **Update** in CloudCLI plugin settings (runs `git pull`, `npm install`, `npm run build`). Task data in `~/.cloudcli-workspace-scheduled-prompts/` is outside the plugin folder and is not touched by the switch.
5. Open a PR to `grostim/cloudcli-cron:master`.
6. Start `004-cron-expressions` from this branch.

**Rollback.** v0.2.0 cannot read v2 ledger files (`sortRunsDesc(ledger.runs)` fails on the missing array). To go back: stop CloudCLI, check out v0.2.0 in the plugin folder, and for each `<stem>.v1.json.bak` in `~/.cloudcli-workspace-scheduled-prompts/`, rename it back to `<stem>.json` (so no stale `.bak` remains for a later re-upgrade) and delete any `<derivedKey>.json` whose `migratedFrom` names it. Task edits made after the upgrade are lost. Runs recorded after the upgrade are lost to v0.2.0 but remain in `runs.db`.

### Done when

- `npm test` passes on Node 22.23.
- `npm run build` succeeds.
- In the real CloudCLI install: a test task runs and shows its event history; restarting the plugin mid-run produces a `recovery` event and the task shows `failed`; Load older runs pages correctly; pausing a task during a run keeps it paused.

## Out of scope

- Moving task definitions into SQLite.
- Pruning or exporting history. At 2–3 GB/year per every-minute task, a retention option is the likely next feature.
- Cron expressions (`004-cron-expressions`).
- Removing events of deleted workspaces or tasks.
- Two plugin server processes on one data directory (CloudCLI starts one per plugin). A second process's startup recovery would close the first's in-progress runs.
- The tick awaiting a long execution before moving to the next task in the same workspace (existing behaviour; revisit in `004` for sub-daily schedules).
