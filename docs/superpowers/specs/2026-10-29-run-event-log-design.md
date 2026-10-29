# Run Event Log — Design

**Date:** 2026-10-29
**Branch:** `003-run-event-log`
**Spec-kit spec:** [`specs/003-run-event-log/spec.md`](../../../specs/003-run-event-log/spec.md)
**Follow-up:** `004-cron-expressions` builds on this branch.

## Goal

Keep the complete run history of every scheduled prompt, as an append-only event log, without slowing down the scheduler or the dashboard.

## Problem

Each workspace's tasks and runs live in one JSON file (`~/.cloudcli-workspace-scheduled-prompts/<workspaceKey>.json`). `saveWorkspaceLedger` rewrites the whole file on every run start and finish, and the global dashboard reads every file on each refresh. History is capped at `RUN_HISTORY_LIMIT = 500` runs per workspace, shared by all tasks in it.

That cap was harmless while the shortest schedule was daily. Sub-daily schedules (planned in `004-cron-expressions`) would either wipe history within hours or, if the cap were removed, grow the JSON file to hundreds of MB that are rewritten twice a minute.

A second, existing gap: a run left `running` when the plugin server stops (crash, restart, machine sleep) stays `running` forever.

## Decisions

| Topic | Decision |
|---|---|
| Storage shape | Append-only **event log** (`run_events`), current run state derived by a view |
| File layout | **One** `runs.db` in the data dir, shared by all workspaces |
| Existing JSON runs | **One-time import** on startup, with a `.v1.json.bak` backup |
| SQLite library | Built-in **`node:sqlite`**; `engines.node` becomes `>=22.13` |
| Code structure | New **`RunStore`** module; `runs` removed from `WorkspaceLedger` |
| Retention | None. History is never pruned. |
| Task definitions | Stay in the per-workspace JSON files (out of scope) |

Rejected alternatives:

- **One row per run, updated on finish.** Simpler, but loses the trail of how a run reached its state.
- **One `.db` per workspace.** The dashboard would still open N files per refresh.
- **Read old runs from JSON forever.** Two code paths on every query.
- **`better-sqlite3`.** Native build on each plugin install; fails on machines without build tools.
- **`sql.js`.** Whole database in memory, file rewritten on save — the same problem as today.
- **Back `ledger.runs` with SQLite via diffing.** Fewer call-site changes, but hides the log behind array mutation and the diff is error-prone.

## 1. Schema

File: `<dataRoot>/runs.db`, where `dataRoot` is the existing `~/.cloudcli-workspace-scheduled-prompts`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA user_version = 1;

CREATE TABLE run_events (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  workspace_key     TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  occurrence_key    TEXT NOT NULL,
  scheduled_for     TEXT NOT NULL,   -- ISO 8601 UTC
  type              TEXT NOT NULL CHECK (type IN ('started','succeeded','failed','missed')),
  at                TEXT NOT NULL,   -- ISO 8601 UTC, when the event happened
  source            TEXT NOT NULL CHECK (source IN ('scheduler','manual','retry','recovery','migrated')),
  summary           TEXT NOT NULL,
  failure_reason    TEXT,
  retry_of_run_id   TEXT,
  execution_request TEXT             -- JSON; set only on 'started'
);

CREATE INDEX ix_events_run        ON run_events (run_id, seq);
CREATE INDEX ix_events_ws_sched   ON run_events (workspace_key, scheduled_for DESC);
CREATE INDEX ix_events_task       ON run_events (task_id, seq);
CREATE INDEX ix_events_occurrence ON run_events (occurrence_key);

CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
```

### `runs_current` view

Maps events to the existing `ScheduledRun` type, one row per `run_id`:

| `ScheduledRun` field | Source |
|---|---|
| `id`, `taskId`, `workspaceKey`, `occurrenceKey`, `scheduledFor`, `retryOfRunId` | First event of the run |
| `status` | Latest event's `type`; `started` maps to `running` |
| `startedAt` | `at` of the `started` event, else `null` |
| `finishedAt` | Latest event's `at` if its type is not `started`, else `null` |
| `outcomeSummary`, `failureReason` | Latest event |
| `executionRequest` | The `started` event's `execution_request`, parsed |

### Event sequences

| Case | Events |
|---|---|
| Normal run | `started` → `succeeded` or `failed` |
| Missed run | `missed` |
| Blocked run (no execution profile) | `missed` (scheduler) or `failed` (manual) |
| Retry | New `run_id`, `retry_of_run_id` set, `source='retry'`; original untouched |
| Interrupted run | `started` → `failed` with `source='recovery'` |

`RunStatus` values `scheduled` and `canceled` are declared in `model.ts` but never set. They get no event type. They remain in the TypeScript union for compatibility.

### Crash recovery

At startup, before the first tick, every run whose latest event is `started` gets a `failed` event: `source='recovery'`, summary `"Plugin server restarted while this run was in progress."`. The corresponding `task.lastRunStatus` in the JSON ledger is set to `failed` if it is still `running`.

### Size

About 500 bytes per event, about 1 KB per run. An every-minute task adds about 500 MB per year. The file is appended to, never rewritten.

## 2. `RunStore` and call sites

### Interface — `src/server/run-store.ts`

```ts
export interface NewRunEvent {
  runId: string;
  workspaceKey: string;
  taskId: string;
  occurrenceKey: string;
  scheduledFor: string;
  type: "started" | "succeeded" | "failed" | "missed";
  at: string;
  source: "scheduler" | "manual" | "retry" | "recovery" | "migrated";
  summary: string;
  failureReason?: string | null;
  retryOfRunId?: string | null;
  executionRequest?: Record<string, unknown> | null;
}

export interface RunEvent extends NewRunEvent { seq: number }

export interface RunPage { runs: ScheduledRun[]; nextCursor: string | null }

export class RunStore {
  constructor(dbPath: string);  // ":memory:" in tests
  appendEvent(event: NewRunEvent): void;               // the only write path
  appendEvents(events: NewRunEvent[]): void;           // one transaction; used by migration
  getRun(runId: string): ScheduledRun | null;
  hasRun(runId: string): boolean;                      // used by migration
  hasOccurrence(occurrenceKey: string): boolean;
  listRuns(workspaceKey: string, opts?: { limit?: number; before?: string; taskId?: string }): RunPage;
  listEvents(runId: string): RunEvent[];
  latestRunsByTask(workspaceKeys: string[], perTask: number): Map<string, ScheduledRun[]>;
  recoverInterruptedRuns(now: string): ScheduledRun[]; // returns the runs it closed
  close(): void;
}
```

- `listRuns` orders by `scheduled_for DESC, run_id DESC`. The cursor encodes both, `"<scheduledFor>|<runId>"`, so runs sharing a `scheduledFor` are neither skipped nor duplicated across pages. `nextCursor` is `null` on the last page.
- Default `limit` is `RUN_PAGE_SIZE = 100`. `RUN_HISTORY_LIMIT` is removed.
- On open, the store sets the pragmas, creates the schema if `user_version = 0`, and refuses to open a file with a newer `user_version` than it knows.
- `node:sqlite` prints an `ExperimentalWarning`. `src/server.ts` filters that one warning (`process.on("warning")` plus `process.removeAllListeners("warning")` for the default printer, re-emitting all other warnings).

### Wiring

`src/server.ts` creates one `RunStore` at `<dataRoot>/runs.db` and passes it to `SchedulerService` (`constructor(executionAdapter, runStore)`). Startup order:

1. Check Node version (see §4).
2. Open `RunStore`.
3. `migrateLedgerRuns(runStore)` (§3).
4. `runStore.recoverInterruptedRuns(now)` and update affected tasks' `lastRunStatus`.
5. Start HTTP server and the 30 s tick.

### Call-site changes

| Location | Today | After |
|---|---|---|
| `scheduler.ts:292` occurrence check | `ledger.runs.some(...)` | `runStore.hasOccurrence(key)` |
| `scheduler.ts:325` missed | build run, `trimRuns`, save | `appendEvent({ type: "missed" })` |
| `scheduler.ts:351` blocked | build run, `trimRuns`, save | `appendEvent({ type: manual ? "failed" : "missed" })` |
| `scheduler.ts:369` start | push `running` run, save | `appendEvent({ type: "started", executionRequest })` |
| `scheduler.ts:375–392` finish | mutate run, save | `appendEvent({ type: result.status })` |
| `scheduler.ts:226` retry lookup | `ledger.runs.find` | `runStore.getRun(id)` |
| `scheduler.ts:107` workspace state | all runs | `listRuns(key)` first page |
| `scheduler.ts:113` `listRuns` | slice of all runs | `runStore.listRuns(key, opts)` |
| `dashboard.ts:239` | group `ledger.runs` | `runStore.latestRunsByTask(keys, n)` |
| `dashboard.ts:289` | filter `ledger.runs` | `runStore.listRuns(key, { taskId })` |
| `trimRuns`, `sortRunsDesc` | | deleted |

`source` is set from context: tick → `scheduler`; Run Now → `manual`; Retry → `retry`.

`task.lastRunStatus` stays in the task JSON. The ledger is still saved when task fields change, including `lastRunStatus` and `nextRunAt`, but no longer to record a run.

The `executeTask` method returns the `ScheduledRun` read back from `runStore.getRun(runId)` after appending, so callers keep receiving the same shape.

### HTTP API (backwards-compatible)

| Endpoint | Change |
|---|---|
| `GET /v1/runs?workspacePath=&limit=&before=` | Adds `before` cursor; response adds `nextCursor`. Callers passing only `limit` see the same `runs` array. |
| `GET /v1/runs/:id/events?workspacePath=` | **New.** Returns `{ events: RunEvent[] }` in `seq` order. 404 if the run does not exist or belongs to another workspace. |
| Workspace state response | `runs` holds the first page (100) instead of all; adds `runsNextCursor`. |

Contract types in `src/shared/contracts.ts` gain `nextCursor`, `runsNextCursor` and `RunEventsResponse`.

### Errors

- If `runs.db` cannot be opened or created (permissions, disk full, corrupt file, newer `user_version`), the plugin server writes the path and SQLite message to stderr and exits non-zero. It never runs without history.
- `appendEvent` is synchronous. If it throws, the surrounding scheduler operation fails the same way a failed `saveWorkspaceLedger` does today: the error propagates, nothing is executed, and the tick moves on to the next workspace.
- The execution adapter runs only after the `started` event is written.

## 3. Migration and client paging

### Migration — `src/server/migrate-runs.ts`

`migrateLedgerRuns(store)` runs once per startup. For each `*.json` in `dataRoot` whose parsed object has a `runs` array:

1. If `<key>.v1.json.bak` does not exist, copy the file to it.
2. Build events for every run that passes the existing `isRunEntry` check and whose `id` is not already in the store (`hasRun`). All events carry `source='migrated'` and the run's original `id`, `occurrenceKey`, `taskId`, `scheduledFor`, `retryOfRunId`:
   - `started` at `startedAt` with `executionRequest`, if `startedAt` is set;
   - final event at `finishedAt ?? scheduledFor`, type from `status`;
   - status `running`: `started`, then `failed` with `source='recovery'`;
   - status `scheduled` or `canceled` (never written today): skipped.
3. `store.appendEvents(events)` in one transaction.
4. Rewrite the JSON without `runs`, `version: 2`, through the existing temp-file + rename write.

Idempotence: if the process dies between steps 3 and 4, the next startup finds `runs` again, step 2 skips every run already imported, and step 4 completes. Running the migration on an already-migrated file does nothing.

Invalid run entries stay only in the `.bak`. The workspace shows the existing repair warning, "Invalid run entries were ignored."

### Ledger code — `src/server/storage.ts`, `src/shared/model.ts`

- `WorkspaceLedger.runs` removed.
- `createEmptyLedger` and the normalize step (`storage.ts:145–178`) stop reading and writing `runs`. The normalize step still reports invalid run entries if a v1 file is loaded before migration.
- `STORAGE_VERSION` becomes `2`.

### Client — `run-history.ts`, `app.ts`, `api.ts`, `state.ts`

- State gains `runsNextCursor: string | null`.
- When it is set, a **Load older runs** button appears below Recent Runs. It calls `GET /v1/runs?before=<cursor>&limit=100`, appends the results and updates the cursor. The button disables while loading and shows the error inline on failure.
- Each run gets a **History** toggle. On first open it calls `GET /v1/runs/:id/events` and lists events as `<type> <local time> (<source>)`. `migrated` and `recovery` sources are labelled.
- Existing behaviour stays: Retry button, new runs put at the top of the list (`app.ts:982`, `:1003`).

## 4. Testing and rollout

### Node version guard

`src/server.ts` checks `process.versions.node` before importing `node:sqlite` (dynamic import). Below 22.13 it writes `Scheduled Prompt needs Node 22.13+ (found X)` to stderr and exits 1. `package.json` `engines.node` becomes `>=22.13`. The check is a pure function `assertSupportedNode(version)` so it can be tested.

### New tests

`tests/unit/run-store.test.ts` (in-memory database):
- append then read back as `ScheduledRun`, for each event sequence in §1;
- `UPDATE` and `DELETE` on `run_events` throw;
- `runs_current` derives `status`, `startedAt`, `finishedAt`;
- paging with `before`: no duplicates or gaps, including runs sharing a `scheduledFor`;
- `latestRunsByTask` across two workspaces;
- `recoverInterruptedRuns` closes only runs whose latest event is `started`;
- opening a file with a newer `user_version` throws.

`tests/unit/migrate-runs.test.ts` (temporary data dir):
- v1 file → events + v2 file + `.bak`;
- `running` entry → `started` + recovery `failed`;
- crash between commit and rewrite, then re-run → no duplicates;
- invalid entries skipped;
- second run is a no-op.

`tests/unit/node-version.test.ts`: `assertSupportedNode` accepts `22.13.0`, `24.0.0`; rejects `22.12.9`, `20.18.0`.

`tests/integration/performance.test.ts` (extended): seed 500,000 events across 20 tasks in 5 workspaces. Budgets:
- first page of `listRuns`: < 50 ms;
- `latestRunsByTask` for all 5 workspaces: < 50 ms;
- one `appendEvent`: < 5 ms.

### Existing tests

Five files seed ledgers with `runs: [...]`: `tests/contract/plugin-rpc.test.ts`, `tests/integration/scheduler-loop.test.ts`, `tests/integration/global-dashboard.test.ts`, `tests/integration/run-history.test.ts`, `tests/unit/storage.test.ts`. They switch to seeding through `RunStore.appendEvent` on an in-memory store. Assertions keep their meaning. `scheduler-loop.test.ts` "records all missed recurring occurrences in one tick" passes unchanged in intent.

### Rollout

1. Fork `krugerm/cloudcli-cron` (done), branch `003-run-event-log` (done).
2. This design plus the spec-kit spec; implementation plan next.
3. Build and test on the branch.
4. Point the installed plugin at the fork: `git -C ~/.claude-code-ui/plugins/cloudcli-cron remote set-url origin https://github.com/krugerm/cloudcli-cron.git`, check out the branch, then **Update** in CloudCLI plugin settings (runs `git pull`, `npm install`, `npm run build`). Task data in `~/.cloudcli-workspace-scheduled-prompts/` is outside the plugin folder and is not touched.
5. Open a PR to `grostim/cloudcli-cron:master`.
6. Start `004-cron-expressions` from this branch.

### Done when

- `npm test` passes on Node 22.23.
- `npm run build` succeeds.
- In the real CloudCLI install: a test task runs and shows its event history; restarting the plugin mid-run produces a `recovery` event; Load older runs pages correctly.

## Out of scope

- Moving task definitions into SQLite.
- Pruning or exporting history.
- Cron expressions (`004-cron-expressions`).
- Pruning events of deleted workspaces or tasks.
