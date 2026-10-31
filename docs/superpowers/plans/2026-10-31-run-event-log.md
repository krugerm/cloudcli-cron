# Run Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move scheduled-prompt run history out of the per-workspace JSON ledgers into one append-only SQLite event log, keep complete history, and fix the scheduler races the old storage hid.

**Architecture:** A new `RunStore` (`node:sqlite`) owns `~/.cloudcli-workspace-scheduled-prompts/runs.db`, an append-only `run_events` table. A run's state is folded from its events in TypeScript. Task definitions stay in the JSON ledgers, but every ledger write goes through a per-workspace lock that reloads the file. Scheduled occurrences are claimed with a compare-and-set inside that lock. v0.2.0 runs are imported once at startup, and a workspace whose import fails is frozen. The client pages runs by creation order and reloads the list after actions.

**Tech Stack:** TypeScript 5.9 (ES2022, NodeNext), Node ≥ 22.13 built-in `node:sqlite`, luxon, vitest 3 (+ jsdom), esbuild.

**Spec:** `docs/superpowers/specs/2026-10-29-run-event-log-design.md` (the design; section references such as "§2 Claiming" point here) and `specs/003-run-event-log/spec.md` (FR/SC numbers). Both are at commit `bd93223`. Read both before starting any task.

## Global Constraints

- **Baseline:** on `bd93223`, `npm test` gives 14 test files and 85 tests passing, and `npx tsc -p tsconfig.json --noEmit` exits 0. Every task ends with both commands green.
- **Node:** `engines.node` is `">=22.13 <23 || >=23.4"`. The guard message is exactly `Scheduled Prompt needs Node 22.13+ (found X)`.
- **Dependencies:** SQLite comes only from the built-in `node:sqlite`. No new runtime or dev dependencies.
- **Loading `node:sqlite`:** only `src/server/run-store.ts` imports it. Every other `src/` module uses `import type` for `RunStore`. `src/server/startup.ts` loads `run-store.js` with a dynamic `import()`.
- **Database:** `runs.db` lives in the existing data dir `~/.cloudcli-workspace-scheduled-prompts/`.
  - Schema `PRAGMA user_version = 1`.
  - WAL is set outside any transaction.
  - Transactions use manual `BEGIN`/`COMMIT`/`ROLLBACK`.
- **Ledger format:** ledger files are written with `version: 2` and no `runs` key.
- **Append-only:** no code issues `UPDATE` or `DELETE` on `run_events`, and triggers enforce this.
- **Run order:** `sequence` (the first event's `seq`) `DESC` everywhere.
  - Default page size is `RUN_PAGE_SIZE = 100`; the clamp range is 1 to `RUN_PAGE_MAX = 500`.
  - The cursor is the decimal `sequence` of the last run on a page.
- **Workspace key rule:** an event's `workspace_key` is always `workspaceKeyFromPath(ledger.workspacePath)`. Never use a ledger's in-file `workspaceKey`, its filename stem, or `task.workspaceKey` for run storage.
- **Exact strings**, copied verbatim from the design:
  - `"Command started."`
  - `"Plugin server restarted while this run was in progress."`
  - `"Automatic execution was unavailable at the scheduled time."`
  - `"Could not save the schedule; run not started."`
  - `"Run not found"` (HTTP 404)
  - `"Run history import pending"` (HTTP 409)
  - `"Run history import failed; it will be retried at the next start. See the plugin log."`
  - `"limit must be an integer"`
  - `"invalid cursor"`
  - `"Manual execution could not start. <capability message>"`
- **Occurrence keys:** scheduled keys use `occurrenceKeyForTask(taskId, scheduledFor)`, which gives `${taskId}:${scheduledFor}`. Manual runs and retries use `${taskId}:manual:${runId}`.
- **Test setup:** tests that touch storage set `process.env.HOME` to a fresh `mkdtemp` directory, following the existing pattern, and use `new RunStore(":memory:")` unless the test needs a file.
- **Commits:** one commit per task, conventional style, ending with a `Co-Authored-By` trailer if the executor's harness requires one.

## Review Focus

These are the five failure modes most likely to hurt a user that the design's own test lists don't cover. Each has a test in the task named after it.

1. **v0.2.0 timestamps with an offset, or a `workspacePath` with a trailing slash.**
   - Example: `"2026-04-27T10:00:00+02:00"` written by hand or by an older build.
   - Expected: the run imports with the instant normalized to UTC, it is ordered correctly, and it lands in the workspace that `workspaceKeyFromPath` derives.
   - Test: Task 6 (`legacy-runs.test.ts`) and Task 10 (`migrate-runs.test.ts`).
2. **A task deleted while its command is still running.**
   - Expected: the run's final event is still recorded, it stays in Recent Runs, and the tick and dashboard don't fail on the orphaned run.
   - Test: Task 8 (`scheduler-concurrency.test.ts`).
3. **A ledger file edited by hand that carries unknown extra fields.**
   - Example: a user-added `notes` key on the ledger or on a task.
   - Expected: locked edits and refreshes keep those fields; nothing is silently dropped.
   - Test: Task 8 (`scheduler-concurrency.test.ts`).
4. **Clicking "Load older runs" twice quickly.**
   - Expected: no duplicate page and no skipped runs; the second click does nothing while the first is in flight.
   - Test: Task 12 (`app-runs.test.ts`).
5. **The plugin server is killed in the middle of a run** (machine sleep, host restart).
   - Expected: at the next start the run is closed as `failed` with a `recovery` event, and the task shows `failed` without any ledger write.
   - Test: Task 11 (`startup.test.ts`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/server/node-version.ts` | create | `assertSupportedNode(version)` |
| `src/server/warnings.ts` | create | `installWarningFilter()`: drops the SQLite `ExperimentalWarning` only |
| `src/shared/model.ts` | modify | run-event types, `ScheduledRun.sequence`, `WorkspaceTask.legacyLastRunStatus`, `WorkspaceLedger.migratedFrom`, page-size constants; `WorkspaceLedger.runs` removed |
| `src/server/run-fold.ts` | create | `foldRun(events)` and shared summary strings; pure, no I/O |
| `src/server/run-store.ts` | create | the only `node:sqlite` user: schema, append, reads, paging, summaries, recovery |
| `src/server/http-error.ts` | create | `HttpError(status, message)` |
| `src/server/legacy-runs.ts` | create | v0.2.0 run shape, validation, `eventsForLegacyRun`, import ordering |
| `src/server/migrate-runs.ts` | create | one-time import of v0.2.0 ledgers; returns `frozenKeys` |
| `src/server/storage.ts` | modify | ledger v2, data-dir exports, `lastRunStatus` handling, frozen keys |
| `src/server/scheduler.ts` | modify (Task 8 replaces it) | ledger lock, claim, manual runs, derived status, run reads |
| `src/server/dashboard.ts` | modify | reads `RunStore` summaries |
| `src/server/http.ts` | modify | store wiring, `/v1/runs` paging, `/v1/runs/:id/events`, `HttpError` status |
| `src/shared/contracts.ts` | modify | `ListRunsResponse`, `RunEventsResponse`, `parseListRunsQuery`, `runsNextCursor` |
| `src/server/startup.ts` | create | `startPluginServer()`: open store, migrate, recover, wire, tick |
| `src/server.ts` | modify | guard, then warning filter, then `startPluginServer()` |
| `src/client/api.ts`, `src/client/state.ts`, `src/client/app.ts`, `src/client/views/run-history.ts` | modify | paging, filter, generation, History toggle |
| `tests/helpers/seed.ts` | create | `createTestRunStore()`, `seedLedger()`, `seedRuns()` for fixtures written in the old ledger-with-runs shape |

## Task overview

| # | Task | Ends with |
|---|---|---|
| 1 | Node version guard and warning filter | pure modules, tested |
| 2 | Run-event types and `foldRun` | pure fold, tested |
| 3 | `RunStore` core | schema, append, reads |
| 4 | `RunStore` paging, summaries, recovery, 500k performance | budgets met |
| 5 | `HttpError` status mapping | 404/409 reach clients |
| 6 | Cut run storage over to `RunStore` | scheduler, dashboard and HTTP use the store; ledger v2 |
| 7 | Derive `lastRunStatus`; `legacyLastRunStatus` | no stored status writes |
| 8 | Ledger lock, occurrence claim, refresh and edit rules | final `scheduler.ts` |
| 9 | Runs API: paging, filter, events, `retryOf` | HTTP contract |
| 10 | v0.2.0 migration and frozen workspaces | import plus 409 gates |
| 11 | Startup order and wiring | `startup.ts` plus thin `server.ts` |
| 12 | Client paging, filter, generation, History | UI |
| 13 | Docs, version 0.3.0, manual verification | release-ready branch |

---

### Task 1: Node version guard and warning filter

**Files:**
- Create: `src/server/node-version.ts`
- Create: `src/server/warnings.ts`
- Modify: `package.json:7-9` (`engines`)
- Test: `tests/unit/node-version.test.ts`
- Test: `tests/unit/warnings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `assertSupportedNode(version: string): void`. It throws `Error("Scheduled Prompt needs Node 22.13+ (found <version>)")`.
  - `installWarningFilter(target?: WarningTarget, write?: (line: string) => void): void`, where `WarningTarget = Pick<NodeJS.Process, "removeAllListeners" | "on">`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/node-version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertSupportedNode } from "../../src/server/node-version.js";

describe("assertSupportedNode", () => {
  it.each(["22.13.0", "v22.23.1", "23.4.0", "24.0.0", "26.1.3"])("accepts %s", (version) => {
    expect(() => assertSupportedNode(version)).not.toThrow();
  });

  it.each(["22.12.9", "23.3.0", "20.18.0", "18.20.4"])("rejects %s with the exact message", (version) => {
    expect(() => assertSupportedNode(version)).toThrow(`Scheduled Prompt needs Node 22.13+ (found ${version})`);
  });
});
```

`tests/unit/warnings.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installWarningFilter } from "../../src/server/warnings.js";

function makeWarning(name: string, message: string): Error {
  const warning = new Error(message);
  warning.name = name;
  return warning;
}

describe("installWarningFilter", () => {
  it("drops only the SQLite ExperimentalWarning and writes every other warning", () => {
    const target = new EventEmitter();
    const previous: string[] = [];
    target.on("warning", () => previous.push("default printer"));
    const lines: string[] = [];

    installWarningFilter(target as unknown as Pick<NodeJS.Process, "removeAllListeners" | "on">, (line) => lines.push(line));

    target.emit("warning", makeWarning("ExperimentalWarning", "SQLite is an experimental feature and might change at any time"));
    target.emit("warning", makeWarning("ExperimentalWarning", "Fetch is experimental"));
    target.emit("warning", makeWarning("DeprecationWarning", "Buffer() is deprecated"));

    expect(previous).toEqual([]);
    expect(lines).toEqual([
      "ExperimentalWarning: Fetch is experimental\n",
      "DeprecationWarning: Buffer() is deprecated\n"
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/node-version.test.ts tests/unit/warnings.test.ts`
Expected: FAIL. Both files report `Failed to load url ../../src/server/node-version.js` (or `warnings.js`).

- [ ] **Step 3: Implement**

`src/server/node-version.ts`:

```ts
export function assertSupportedNode(version: string): void {
  const [major = 0, minor = 0] = version
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const supported = (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24;
  if (!supported) {
    throw new Error(`Scheduled Prompt needs Node 22.13+ (found ${version})`);
  }
}
```

`src/server/warnings.ts`:

```ts
export type WarningTarget = Pick<NodeJS.Process, "removeAllListeners" | "on">;

export function installWarningFilter(
  target: WarningTarget = process,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  }
): void {
  target.removeAllListeners("warning");
  target.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && /sqlite/iu.test(warning.message)) {
      return;
    }
    write(`${warning.name}: ${warning.message}\n`);
  });
}
```

The filter never calls `process.emitWarning`, because that would recurse.

Replace the `engines` block in `package.json`:

```json
  "engines": {
    "node": ">=22.13 <23 || >=23.4"
  },
```

- [ ] **Step 4: Run tests and the type check**

Run: `npx vitest run tests/unit/node-version.test.ts tests/unit/warnings.test.ts`
Expected: PASS, 10 tests.

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all test files pass and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/server/node-version.ts src/server/warnings.ts package.json tests/unit/node-version.test.ts tests/unit/warnings.test.ts
git commit -m "feat(003): node version guard and sqlite warning filter"
```

---

### Task 2: Run-event types and `foldRun`

**Files:**
- Modify: `src/shared/model.ts:83-96` (`ScheduledRun`), and append new types and constants at the end of the file
- Modify: `src/server/scheduler.ts:50-82` (`createRun`, `createRunningRun`)
- Modify: `src/server/storage.ts:175-178` (run mapping in `coerceLedgerShape`)
- Create: `src/server/run-fold.ts`
- Test: `tests/unit/run-fold.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (in `src/shared/model.ts`):
  - `RunEventType`, `RunEventSource`, `NewRunEvent`, `RunEvent`
  - `ScheduledRun.sequence: number`
  - `RUN_PAGE_SIZE = 100` and `RUN_PAGE_MAX = 500`
- Produces (in `src/server/run-fold.ts`):
  - `foldRun(events: RunEvent[]): ScheduledRun`
  - `STARTED_SUMMARY`, `RECOVERY_SUMMARY`, `MISSED_UNAVAILABLE_SUMMARY`, `SAVE_FAILED_SUMMARY`

- [ ] **Step 1: Write the failing test**

`tests/unit/run-fold.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../src/shared/model.js";
import { foldRun, RECOVERY_SUMMARY, STARTED_SUMMARY } from "../../src/server/run-fold.js";

const base = {
  runId: "run-1",
  workspaceKey: "ws",
  taskId: "task-1",
  occurrenceKey: "task-1:2026-04-27T07:00:00.000Z",
  scheduledFor: "2026-04-27T07:00:00.000Z",
  retryOfRunId: null
};

function event(seq: number, partial: Partial<RunEvent> & Pick<RunEvent, "type" | "at">): RunEvent {
  return { ...base, seq, source: "scheduler", summary: "s", failureReason: null, executionRequest: null, ...partial };
}

describe("foldRun", () => {
  it("folds a normal run (started -> succeeded)", () => {
    const run = foldRun([
      event(4, { type: "started", at: "2026-04-27T07:00:01.000Z", summary: STARTED_SUMMARY, executionRequest: { command: "codex" } }),
      event(9, { type: "succeeded", at: "2026-04-27T07:00:30.000Z", summary: "done" })
    ]);
    expect(run).toEqual({
      id: "run-1",
      occurrenceKey: base.occurrenceKey,
      taskId: "task-1",
      workspaceKey: "ws",
      scheduledFor: base.scheduledFor,
      sequence: 4,
      startedAt: "2026-04-27T07:00:01.000Z",
      finishedAt: "2026-04-27T07:00:30.000Z",
      status: "succeeded",
      outcomeSummary: "done",
      failureReason: null,
      retryOfRunId: null,
      executionRequest: { command: "codex" }
    });
  });

  it("folds a running run", () => {
    const run = foldRun([event(1, { type: "started", at: "2026-04-27T07:00:01.000Z", summary: STARTED_SUMMARY })]);
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();
    expect(run.outcomeSummary).toBe(STARTED_SUMMARY);
  });

  it("folds a missed run (single event)", () => {
    const run = foldRun([event(2, { type: "missed", at: "2026-04-27T07:02:00.000Z", summary: "late", failureReason: "late" })]);
    expect(run).toMatchObject({ status: "missed", startedAt: null, finishedAt: "2026-04-27T07:02:00.000Z", failureReason: "late", sequence: 2 });
  });

  it("folds an interrupted run closed by recovery", () => {
    const run = foldRun([
      event(3, { type: "started", at: "2026-04-27T07:00:01.000Z" }),
      event(7, { type: "failed", at: "2026-04-28T09:00:00.000Z", source: "recovery", summary: RECOVERY_SUMMARY, failureReason: RECOVERY_SUMMARY })
    ]);
    expect(run).toMatchObject({ status: "failed", outcomeSummary: RECOVERY_SUMMARY, finishedAt: "2026-04-28T09:00:00.000Z" });
  });

  it("takes identity from the first event and sorts by seq defensively", () => {
    const run = foldRun([
      event(8, { type: "failed", at: "2026-04-27T07:00:05.000Z", retryOfRunId: "ignored" }),
      event(5, { type: "started", at: "2026-04-27T07:00:01.000Z", retryOfRunId: "run-0", source: "retry" })
    ]);
    expect(run.retryOfRunId).toBe("run-0");
    expect(run.sequence).toBe(5);
    expect(run.status).toBe("failed");
  });

  it("rejects an empty event list", () => {
    expect(() => foldRun([])).toThrow("foldRun needs at least one event");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/run-fold.test.ts`
Expected: FAIL with `Failed to load url ../../src/server/run-fold.js`.

- [ ] **Step 3: Implement**

In `src/shared/model.ts`, add `sequence` to `ScheduledRun` directly after `scheduledFor`:

```ts
export interface ScheduledRun {
  id: string;
  occurrenceKey: string;
  taskId: string;
  workspaceKey: string;
  scheduledFor: string;
  sequence: number;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  outcomeSummary: string;
  failureReason: string | null;
  retryOfRunId: string | null;
  executionRequest: Record<string, unknown> | null;
}
```

Append at the end of `src/shared/model.ts`:

```ts
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

export interface RunEvent extends NewRunEvent {
  seq: number;
}

export const RUN_PAGE_SIZE = 100;
export const RUN_PAGE_MAX = 500;
```

Keep `RUN_HISTORY_LIMIT` for now; Task 6 removes it.

Create `src/server/run-fold.ts`:

```ts
import type { RunEvent, ScheduledRun } from "../shared/model.js";

export const STARTED_SUMMARY = "Command started.";
export const RECOVERY_SUMMARY = "Plugin server restarted while this run was in progress.";
export const MISSED_UNAVAILABLE_SUMMARY = "Automatic execution was unavailable at the scheduled time.";
export const SAVE_FAILED_SUMMARY = "Could not save the schedule; run not started.";

export function foldRun(events: RunEvent[]): ScheduledRun {
  if (!events.length) {
    throw new Error("foldRun needs at least one event");
  }
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const started = ordered.find((entry) => entry.type === "started");

  return {
    id: first.runId,
    occurrenceKey: first.occurrenceKey,
    taskId: first.taskId,
    workspaceKey: first.workspaceKey,
    scheduledFor: first.scheduledFor,
    sequence: first.seq,
    startedAt: started?.at ?? null,
    finishedAt: last.type === "started" ? null : last.at,
    status: last.type === "started" ? "running" : last.type,
    outcomeSummary: last.summary,
    failureReason: last.failureReason ?? null,
    retryOfRunId: first.retryOfRunId ?? null,
    executionRequest: started?.executionRequest ?? null
  };
}
```

Add `sequence: 0,` after `scheduledFor,` in both `createRun` (`src/server/scheduler.ts:56`) and `createRunningRun` (`:73`).

In `src/server/storage.ts`, change the runs mapping in `coerceLedgerShape` (lines 175–178) to:

```ts
      runs: runs.map((run) => ({
        ...run,
        sequence: 0,
        workspaceKey
      })),
```

These `sequence: 0` placeholders exist only until Task 6 deletes in-ledger runs.

- [ ] **Step 4: Run tests and the type check**

Run: `npx vitest run tests/unit/run-fold.test.ts`
Expected: PASS, 6 tests.

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/model.ts src/server/run-fold.ts src/server/scheduler.ts src/server/storage.ts tests/unit/run-fold.test.ts
git commit -m "feat(003): run event types and foldRun"
```

---

### Task 3: `RunStore` core

**Files:**
- Create: `src/server/run-store.ts`
- Test: `tests/unit/run-store.test.ts`

**Interfaces:**
- Consumes: from Task 2, `NewRunEvent`, `RunEvent`, `ScheduledRun`, `foldRun`, and `RUN_PAGE_SIZE`/`RUN_PAGE_MAX` (the last two are used from Task 4).
- Produces: `class RunStore` with
  - `constructor(dbPath: string)`
  - `appendEvent(event: NewRunEvent): void`
  - `appendEvents(events: NewRunEvent[]): void`
  - `getRun(runId: string): ScheduledRun | null`
  - `hasRun(runId: string): boolean`
  - `hasOccurrence(workspaceKey: string, occurrenceKey: string): boolean`
  - `listEvents(runId: string): RunEvent[]`
  - `close(): void`
- Also produces `RUN_STORE_SCHEMA_VERSION = 1` and the exported SQL constant `RECOVER_INTERRUPTED_SQL`.

- [ ] **Step 1: Write the failing test**

`tests/unit/run-store.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewRunEvent } from "../../src/shared/model.js";
import { RunStore } from "../../src/server/run-store.js";

export function newEvent(partial: Partial<NewRunEvent> & Pick<NewRunEvent, "runId" | "type">): NewRunEvent {
  return {
    workspaceKey: "ws-a",
    taskId: "task-1",
    occurrenceKey: `task-1:${partial.runId}`,
    scheduledFor: "2026-04-27T07:00:00.000Z",
    at: "2026-04-27T07:00:01.000Z",
    source: "scheduler",
    summary: partial.type === "started" ? "Command started." : "done",
    ...partial
  };
}

describe("RunStore core", () => {
  let store: RunStore;

  beforeEach(() => {
    store = new RunStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("appends events and folds them back into a ScheduledRun", () => {
    store.appendEvent(newEvent({ runId: "r1", type: "started", executionRequest: { command: "codex", args: ["exec"] } }));
    store.appendEvent(newEvent({ runId: "r1", type: "failed", at: "2026-04-27T07:01:00.000Z", summary: "boom", failureReason: "boom" }));

    const run = store.getRun("r1");
    expect(run).toMatchObject({
      id: "r1",
      status: "failed",
      startedAt: "2026-04-27T07:00:01.000Z",
      finishedAt: "2026-04-27T07:01:00.000Z",
      outcomeSummary: "boom",
      failureReason: "boom",
      executionRequest: { command: "codex", args: ["exec"] }
    });
    expect(run?.sequence).toBe(1);
    expect(store.listEvents("r1").map((entry) => entry.type)).toEqual(["started", "failed"]);
  });

  it("folds each documented event sequence", () => {
    store.appendEvent(newEvent({ runId: "missed", type: "missed", failureReason: "late" }));
    store.appendEvent(newEvent({ runId: "running", type: "started" }));
    store.appendEvent(newEvent({ runId: "retry", type: "started", source: "retry", retryOfRunId: "missed" }));
    store.appendEvent(newEvent({ runId: "retry", type: "succeeded" }));

    expect(store.getRun("missed")?.status).toBe("missed");
    expect(store.getRun("running")?.status).toBe("running");
    expect(store.getRun("retry")).toMatchObject({ status: "succeeded", retryOfRunId: "missed" });
    expect(store.getRun("nope")).toBeNull();
  });

  it("answers hasRun and workspace-scoped hasOccurrence", () => {
    store.appendEvent(newEvent({ runId: "r1", type: "missed", occurrenceKey: "task-1:T" }));
    expect(store.hasRun("r1")).toBe(true);
    expect(store.hasRun("r2")).toBe(false);
    expect(store.hasOccurrence("ws-a", "task-1:T")).toBe(true);
    expect(store.hasOccurrence("ws-b", "task-1:T")).toBe(false);
  });

  it("appendEvents is atomic", () => {
    expect(() =>
      store.appendEvents([
        newEvent({ runId: "ok", type: "missed" }),
        { ...newEvent({ runId: "bad", type: "missed" }), type: "exploded" as never }
      ])
    ).toThrow();
    expect(store.hasRun("ok")).toBe(false);
  });
});

describe("RunStore file database", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "run-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("enables WAL and rejects UPDATE and DELETE", () => {
    const dbPath = path.join(dir, "runs.db");
    const store = new RunStore(dbPath);
    store.appendEvent(newEvent({ runId: "r1", type: "missed" }));
    store.close();

    const raw = new DatabaseSync(dbPath);
    expect((raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    expect(() => raw.exec("UPDATE run_events SET summary = 'x'")).toThrow("run_events is append-only");
    expect(() => raw.exec("DELETE FROM run_events")).toThrow("run_events is append-only");
    raw.close();
  });

  it("refuses a database from a newer plugin version", () => {
    const dbPath = path.join(dir, "future.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 2");
    raw.close();
    expect(() => new RunStore(dbPath)).toThrow(/schema version 2/);
  });

  it("reopens an existing database without recreating the schema", () => {
    const dbPath = path.join(dir, "runs.db");
    const first = new RunStore(dbPath);
    first.appendEvent(newEvent({ runId: "r1", type: "missed" }));
    first.close();
    const second = new RunStore(dbPath);
    expect(second.hasRun("r1")).toBe(true);
    second.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/run-store.test.ts`
Expected: FAIL with `Failed to load url ../../src/server/run-store.js`.

- [ ] **Step 3: Implement `src/server/run-store.ts`**

```ts
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
```

`close()` uses its own `closed` flag rather than `DatabaseSync#isOpen`, which may be missing at runtime on Node 22.13–22.14.

- [ ] **Step 4: Run tests and the type check**

Run: `npx vitest run tests/unit/run-store.test.ts`
Expected: PASS, 7 tests.

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass. An `ExperimentalWarning: SQLite …` line in the vitest output is expected and harmless.

- [ ] **Step 5: Commit**

```bash
git add src/server/run-store.ts tests/unit/run-store.test.ts
git commit -m "feat(003): append-only RunStore core"
```

---

### Task 4: `RunStore` paging, summaries, recovery and performance

**Files:**
- Modify: `src/server/run-store.ts` (add `listRuns`, `taskRunSummaries`, `recoverInterruptedRuns`, and the exported types `RunPage`, `ListRunsOptions`, `TaskRunSummary`)
- Test: `tests/unit/run-store-queries.test.ts`
- Test: `tests/integration/performance.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: Task 3 `RunStore`, and Task 2 `RECOVERY_SUMMARY`, `RUN_PAGE_SIZE` and `RUN_PAGE_MAX`.
- Produces:
  - `interface ListRunsOptions { limit?: number; before?: string | null; taskId?: string | null }`
  - `interface RunPage { runs: ScheduledRun[]; nextCursor: string | null }`
  - `interface TaskRunSummary { latest: ScheduledRun | null; latestFinished: ScheduledRun | null }`
  - `RunStore.listRuns(workspaceKey: string, options?: ListRunsOptions): RunPage`. It throws `Error("invalid cursor")` when the cursor is invalid.
  - `RunStore.taskRunSummaries(workspaceKey: string, taskIds: string[]): Map<string, TaskRunSummary>`
  - `RunStore.recoverInterruptedRuns(now: string): number`

- [ ] **Step 1: Write the failing tests**

`tests/unit/run-store-queries.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewRunEvent } from "../../src/shared/model.js";
import { RECOVER_INTERRUPTED_SQL, RunStore } from "../../src/server/run-store.js";
import { RECOVERY_SUMMARY } from "../../src/server/run-fold.js";

function ev(runId: string, type: NewRunEvent["type"], extra: Partial<NewRunEvent> = {}): NewRunEvent {
  return {
    runId,
    workspaceKey: "ws-a",
    taskId: "task-1",
    occurrenceKey: `task-1:${runId}`,
    scheduledFor: "2026-04-27T07:00:00.000Z",
    type,
    at: "2026-04-27T07:00:01.000Z",
    source: "scheduler",
    summary: type,
    ...extra
  };
}

describe("RunStore queries", () => {
  let store: RunStore;

  beforeEach(() => {
    store = new RunStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("pages newest-recorded first with no duplicates or gaps", () => {
    for (let index = 0; index < 23; index += 1) {
      store.appendEvent(ev(`r${index}`, "missed", { scheduledFor: "2026-04-27T07:00:00.000Z" }));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = store.listRuns("ws-a", { limit: 5, before: cursor });
      seen.push(...page.runs.map((run) => run.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, index) => `r${22 - index}`));
  });

  it("never shows a run recorded after page 1 on a later page, even with an older scheduledFor", () => {
    for (let index = 0; index < 6; index += 1) {
      store.appendEvent(ev(`r${index}`, "missed", { scheduledFor: `2026-04-2${index}T07:00:00.000Z` }));
    }
    const first = store.listRuns("ws-a", { limit: 3 });
    store.appendEvent(ev("late", "missed", { scheduledFor: "2026-01-01T07:00:00.000Z" }));
    const second = store.listRuns("ws-a", { limit: 3, before: first.nextCursor });
    expect(second.runs.map((run) => run.id)).toEqual(["r2", "r1", "r0"]);
    expect(store.listRuns("ws-a", { limit: 1 }).runs[0]?.id).toBe("late");
  });

  it("orders a run by its first event, and folds later events in", () => {
    store.appendEvent(ev("a", "started"));
    store.appendEvent(ev("b", "missed"));
    store.appendEvent(ev("a", "succeeded"));
    expect(store.listRuns("ws-a").runs.map((run) => [run.id, run.status])).toEqual([
      ["b", "missed"],
      ["a", "succeeded"]
    ]);
  });

  it("filters by task and by workspace", () => {
    store.appendEvent(ev("t1", "missed"));
    store.appendEvent(ev("t2", "missed", { taskId: "task-2" }));
    store.appendEvent(ev("other", "missed", { workspaceKey: "ws-b" }));
    expect(store.listRuns("ws-a", { taskId: "task-2" }).runs.map((run) => run.id)).toEqual(["t2"]);
    expect(store.listRuns("ws-a").runs.map((run) => run.id)).toEqual(["t2", "t1"]);
    expect(store.listRuns("ws-b").runs.map((run) => run.id)).toEqual(["other"]);
  });

  it("clamps limit to 1..500 and defaults to 100", () => {
    for (let index = 0; index < 120; index += 1) {
      store.appendEvent(ev(`r${index}`, "missed"));
    }
    expect(store.listRuns("ws-a").runs).toHaveLength(100);
    expect(store.listRuns("ws-a", { limit: 0 }).runs).toHaveLength(1);
    expect(store.listRuns("ws-a", { limit: 10_000 }).runs).toHaveLength(120);
  });

  it.each(["abc", "0", "-3", "1.5", ""])("rejects cursor %j", (cursor) => {
    expect(() => store.listRuns("ws-a", { before: cursor })).toThrow("invalid cursor");
  });

  it("summarizes latest and latestFinished per task while a run is in progress", () => {
    store.appendEvent(ev("old", "started"));
    store.appendEvent(ev("old", "failed"));
    store.appendEvent(ev("live", "started"));
    store.appendEvent(ev("copy", "missed", { workspaceKey: "ws-copy" }));
    const summary = store.taskRunSummaries("ws-a", ["task-1", "task-none"]);
    expect(summary.get("task-1")?.latest?.id).toBe("live");
    expect(summary.get("task-1")?.latestFinished?.id).toBe("old");
    expect(summary.get("task-none")).toEqual({ latest: null, latestFinished: null });
    expect(store.taskRunSummaries("ws-a", ["task-1"]).get("task-1")?.latest?.id).toBe(
      store.listRuns("ws-a", { taskId: "task-1" }).runs[0]?.id
    );
  });

  it("finds latestFinished beyond the first page of five", () => {
    store.appendEvent(ev("done", "missed"));
    for (let index = 0; index < 7; index += 1) {
      store.appendEvent(ev(`run${index}`, "started"));
    }
    expect(store.taskRunSummaries("ws-a", ["task-1"]).get("task-1")?.latestFinished?.id).toBe("done");
  });

  it("closes only runs whose last event is started", () => {
    store.appendEvent(ev("live", "started", { retryOfRunId: "x", occurrenceKey: "task-1:live-key" }));
    store.appendEvent(ev("done", "started"));
    store.appendEvent(ev("done", "succeeded"));
    expect(store.recoverInterruptedRuns("2026-05-01T00:00:00.000Z")).toBe(1);
    const events = store.listEvents("live");
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      source: "recovery",
      at: "2026-05-01T00:00:00.000Z",
      summary: RECOVERY_SUMMARY,
      failureReason: RECOVERY_SUMMARY,
      occurrenceKey: "task-1:live-key",
      retryOfRunId: "x"
    });
    expect(store.listEvents("done")).toHaveLength(2);
    expect(store.recoverInterruptedRuns("2026-05-02T00:00:00.000Z")).toBe(0);
  });
});

describe("recovery query plan", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "run-store-plan-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the partial started-events index", () => {
    const dbPath = path.join(dir, "runs.db");
    new RunStore(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${RECOVER_INTERRUPTED_SQL}`).all() as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(" | ");
    raw.close();
    expect(plan).toContain("ix_events_started");
  });
});
```

Append to `tests/integration/performance.test.ts`. This also needs an import of `RunStore` from `../../src/server/run-store.js` at the top of the file.

```ts
describe("run store at 500k events", () => {
  it("meets the paging, summary and append budgets", () => {
    const store = new RunStore(":memory:");
    const workspaces = Array.from({ length: 5 }, (_, index) => `ws-${index}`);
    const tasks = workspaces.flatMap((workspaceKey) =>
      Array.from({ length: 4 }, (_, index) => ({ workspaceKey, taskId: `${workspaceKey}-task-${index}` }))
    );
    const summary = "x".repeat(1_000);
    const events = [];
    for (let index = 0; index < 250_000; index += 1) {
      const { workspaceKey, taskId } = tasks[index % tasks.length]!;
      const base = {
        runId: `run-${index}`,
        workspaceKey,
        taskId,
        occurrenceKey: `${taskId}:${index}`,
        scheduledFor: "2026-04-27T07:00:00.000Z",
        source: "scheduler" as const,
        summary
      };
      events.push({ ...base, type: "started" as const, at: "2026-04-27T07:00:01.000Z" });
      events.push({ ...base, type: "succeeded" as const, at: "2026-04-27T07:00:02.000Z" });
    }
    store.appendEvents(events);

    const time = (fn: () => unknown): number => {
      fn();
      const startedAt = performance.now();
      for (let index = 0; index < 20; index += 1) {
        fn();
      }
      return (performance.now() - startedAt) / 20;
    };

    expect(time(() => store.listRuns("ws-0"))).toBeLessThan(50);
    expect(time(() => store.listRuns("ws-0", { taskId: "ws-0-task-1" }))).toBeLessThan(50);
    expect(
      time(() => {
        for (const workspaceKey of workspaces) {
          store.taskRunSummaries(
            workspaceKey,
            tasks.filter((task) => task.workspaceKey === workspaceKey).map((task) => task.taskId)
          );
        }
      })
    ).toBeLessThan(50);
    expect(
      time(() =>
        store.appendEvent({
          runId: `extra-${Math.random()}`,
          workspaceKey: "ws-0",
          taskId: "ws-0-task-0",
          occurrenceKey: `k-${Math.random()}`,
          scheduledFor: "2026-04-27T07:00:00.000Z",
          type: "missed",
          at: "2026-04-27T07:00:00.000Z",
          source: "scheduler",
          summary: "late"
        })
      )
    ).toBeLessThan(5);
    store.close();
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/run-store-queries.test.ts tests/integration/performance.test.ts`
Expected: FAIL with `store.listRuns is not a function` (and the same for `taskRunSummaries` and `recoverInterruptedRuns`).

- [ ] **Step 3: Implement**

Add these imports at the top of `src/server/run-store.ts`:

```ts
import { RUN_PAGE_MAX, RUN_PAGE_SIZE } from "../shared/model.js";
import { RECOVERY_SUMMARY } from "./run-fold.js";
```

Keep the existing `foldRun` import. Then add these exports after `toEvent`:

```ts
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
```

Add these members to `RunStore` (put the field next to the other statement fields):

```ts
  private readonly pageStatements = new Map<string, StatementSync>();

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
```

- [ ] **Step 4: Run tests and the type check**

Run: `npx vitest run tests/unit/run-store-queries.test.ts tests/integration/performance.test.ts`
Expected: PASS. The 500k test takes about 5–20 s to seed; every measured average is under its budget.

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/run-store.ts tests/unit/run-store-queries.test.ts tests/integration/performance.test.ts
git commit -m "feat(003): run paging, task summaries and crash recovery in RunStore"
```

---

### Task 5: `HttpError` status mapping

**Files:**
- Create: `src/server/http-error.ts`
- Modify: `src/server/http.ts:224-228` (catch block) and the imports
- Test: `tests/integration/http-errors.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `class HttpError extends Error { readonly status: number; constructor(status: number, message: string) }`. `http.ts` responds with `error.status` for an `HttpError` and with 400 for every other error.

- [ ] **Step 1: Write the failing test**

`tests/integration/http-errors.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { startHttpServer } from "../../src/server/http.js";
import { HttpError } from "../../src/server/http-error.js";
import type { SchedulerService } from "../../src/server/scheduler.js";

describe("http error mapping", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function post(scheduler: Partial<SchedulerService>, url: string): Promise<Response> {
    server = await startHttpServer(scheduler as SchedulerService);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral port");
    }
    return fetch(`http://127.0.0.1:${address.port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspacePath: "/tmp/project" })
    });
  }

  it("uses the HttpError status", async () => {
    const response = await post(
      {
        retryRun: async () => {
          throw new HttpError(404, "Run not found");
        }
      },
      "/v1/runs/run-1/actions/retry"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Run not found" });
  });

  it("keeps 400 for plain errors", async () => {
    const response = await post(
      {
        retryRun: async () => {
          throw new Error("Task not found");
        }
      },
      "/v1/runs/run-1/actions/retry"
    );
    expect(response.status).toBe(400);
  });
});
```

Task 6 changes `startHttpServer` to `(scheduler, runStore)`. When it does, it updates this test to pass `{} as RunStore` as the second argument.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/http-errors.test.ts`
Expected: FAIL with `Failed to load url ../../src/server/http-error.js`.

- [ ] **Step 3: Implement**

`src/server/http-error.ts`:

```ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}
```

In `src/server/http.ts`, add `import { HttpError } from "./http-error.js";` and replace the catch block at lines 225–228:

```ts
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      json(response, error instanceof HttpError ? error.status : 400, { error: message });
    }
```

- [ ] **Step 4: Run tests and the type check**

Run: `npx vitest run tests/integration/http-errors.test.ts && npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/http-error.ts src/server/http.ts tests/integration/http-errors.test.ts
git commit -m "feat(003): HttpError carries an HTTP status"
```

---

### Task 6: Cut run storage over to `RunStore`

After this task no run is read from or written to a ledger file. The scheduler, dashboard and HTTP layer read and write runs only through `RunStore`, and ledgers are saved as v2. This task deliberately keeps the old `lastRunStatus` writes and the old save-after-execution; Tasks 7 and 8 replace them.

**Files:**
- Create: `src/server/legacy-runs.ts`
- Create: `tests/helpers/seed.ts`
- Modify: `src/shared/model.ts` (remove `WorkspaceLedger.runs` and `RUN_HISTORY_LIMIT`)
- Modify: `src/shared/contracts.ts` (`WorkspaceStateResponse.runsNextCursor`, `ListRunsResponse`)
- Modify: `src/server/storage.ts` (v2, data-dir exports, drop runs and `isRunEntry`)
- Modify: `src/server/scheduler.ts` (store-backed run writes and reads)
- Modify: `src/server/dashboard.ts` (store-backed summaries)
- Modify: `src/server/http.ts` (store wiring, `/v1/runs` shape)
- Modify: `src/server.ts` (open the store)
- Test: `tests/unit/legacy-runs.test.ts` (new)
- Test: update `tests/integration/scheduler-loop.test.ts`, `tests/unit/dashboard.test.ts`, `tests/integration/global-dashboard.test.ts`, `tests/integration/performance.test.ts`, `tests/unit/storage.test.ts`, `tests/integration/http-errors.test.ts`

**Interfaces:**
- Consumes:
  - from Tasks 3 and 4: `RunStore`, `RunPage`, `ListRunsOptions`, `TaskRunSummary`;
  - from Task 2: `STARTED_SUMMARY`;
  - from Task 5: `HttpError`.
- Produces:
  - `legacy-runs.ts`:
    - `LegacyRun`
    - `isLegacyRunEntry(value): value is LegacyRun`
    - `IMPORTABLE_LEGACY_STATUSES`
    - `eventsForLegacyRun(run: LegacyRun, workspaceKey: string, now: string): NewRunEvent[] | null`
    - `legacyRecordingTime(run: LegacyRun): string`
    - `sortLegacyRunsForImport<T extends { run: LegacyRun }>(entries: T[]): T[]`
  - `storage.ts`:
    - `ledgerDataRoot(): string`
    - `ensureLedgerDataDir(): Promise<void>`
    - `STORAGE_VERSION = 2` (exported)
  - `SchedulerService`:
    - `constructor(executionAdapter: LocalExecutionAdapter, runStore: RunStore)`
    - `listRuns(workspacePath: string, options?: ListRunsOptions): Promise<RunPage>`
  - dashboard:
    - `buildGlobalDashboardSnapshot(filter, runStore: RunStore)`
    - `resolveGlobalTask(workspaceKey, taskId, runStore: RunStore)`
  - HTTP:
    - `createHttpHandler(scheduler, runStore)`
    - `startHttpServer(scheduler, runStore)`
  - `contracts.ts`:
    - `ListRunsResponse { runs: ScheduledRun[]; nextCursor: string | null }`
    - `WorkspaceStateResponse.runsNextCursor: string | null`
  - `tests/helpers/seed.ts`:
    - `createTestRunStore(): RunStore`
    - `seedLedger(store, fixture): Promise<void>`
    - `seedRuns(store, workspacePath, runs): void`

- [ ] **Step 1: Write the failing test for `legacy-runs.ts`**

`tests/unit/legacy-runs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  eventsForLegacyRun,
  isLegacyRunEntry,
  legacyRecordingTime,
  sortLegacyRunsForImport,
  type LegacyRun
} from "../../src/server/legacy-runs.js";
import { RECOVERY_SUMMARY, STARTED_SUMMARY } from "../../src/server/run-fold.js";

function legacy(partial: Partial<LegacyRun>): LegacyRun {
  return {
    id: "run-1",
    occurrenceKey: "task-1:2026-04-27T07:00:00.000Z",
    taskId: "task-1",
    workspaceKey: "in-file-key",
    scheduledFor: "2026-04-27T07:00:00.000Z",
    startedAt: "2026-04-27T07:00:01.000Z",
    finishedAt: "2026-04-27T07:00:09.000Z",
    status: "succeeded",
    outcomeSummary: "ok",
    failureReason: null,
    retryOfRunId: null,
    executionRequest: { command: "codex" },
    ...partial
  };
}

describe("legacy runs", () => {
  it("validates the v0.2.0 run shape", () => {
    expect(isLegacyRunEntry(legacy({}))).toBe(true);
    expect(isLegacyRunEntry({ ...legacy({}), outcomeSummary: 3 })).toBe(false);
    expect(isLegacyRunEntry(null)).toBe(false);
  });

  it("builds started + final events under the derived key", () => {
    const events = eventsForLegacyRun(legacy({}), "derived", "2026-05-01T00:00:00.000Z");
    expect(events).toEqual([
      expect.objectContaining({ type: "started", at: "2026-04-27T07:00:01.000Z", source: "migrated", summary: STARTED_SUMMARY, workspaceKey: "derived", executionRequest: { command: "codex" } }),
      expect.objectContaining({ type: "succeeded", at: "2026-04-27T07:00:09.000Z", source: "migrated", summary: "ok", failureReason: null })
    ]);
  });

  it("omits started when startedAt is null and falls back finishedAt -> startedAt -> scheduledFor", () => {
    const events = eventsForLegacyRun(legacy({ status: "missed", startedAt: null, finishedAt: null }), "k", "now");
    expect(events).toEqual([expect.objectContaining({ type: "missed", at: "2026-04-27T07:00:00.000Z" })]);
  });

  it("closes a running run with a recovery event at migration time", () => {
    const events = eventsForLegacyRun(legacy({ status: "running", finishedAt: null }), "k", "2026-05-01T00:00:00.000Z");
    expect(events?.map((event) => [event.type, event.source, event.at])).toEqual([
      ["started", "migrated", "2026-04-27T07:00:01.000Z"],
      ["failed", "recovery", "2026-05-01T00:00:00.000Z"]
    ]);
    expect(events?.[1]?.summary).toBe(RECOVERY_SUMMARY);
  });

  it("rejects scheduled, canceled, unknown statuses and unparsable timestamps", () => {
    for (const status of ["scheduled", "canceled", "weird"]) {
      expect(eventsForLegacyRun(legacy({ status }), "k", "now")).toBeNull();
    }
    expect(eventsForLegacyRun(legacy({ startedAt: "yesterday" }), "k", "now")).toBeNull();
  });

  // Review Focus 1: offset timestamps normalize to UTC and sort by instant
  it("normalizes offset timestamps to UTC ISO and orders by recording time", () => {
    const offset = legacy({ id: "offset", scheduledFor: "2026-04-27T10:00:00+02:00", startedAt: "2026-04-27T10:00:05+02:00", finishedAt: "2026-04-27T10:00:09+02:00" });
    const events = eventsForLegacyRun(offset, "k", "now");
    expect(events?.[0]?.scheduledFor).toBe("2026-04-27T08:00:00.000Z");
    expect(events?.[0]?.at).toBe("2026-04-27T08:00:05.000Z");
    expect(legacyRecordingTime(offset)).toBe("2026-04-27T08:00:05.000Z");

    const later = legacy({ id: "later", startedAt: "2026-04-27T08:30:00.000Z" });
    const sorted = sortLegacyRunsForImport([{ run: later }, { run: offset }]).map((entry) => entry.run.id);
    expect(sorted).toEqual(["offset", "later"]);
  });

  it("keeps file order for equal recording times", () => {
    const a = legacy({ id: "a" });
    const b = legacy({ id: "b" });
    expect(sortLegacyRunsForImport([{ run: a }, { run: b }]).map((entry) => entry.run.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/legacy-runs.test.ts`
Expected: FAIL with `Failed to load url ../../src/server/legacy-runs.js`.

- [ ] **Step 3: Implement `src/server/legacy-runs.ts`**

```ts
import type { NewRunEvent } from "../shared/model.js";
import { RECOVERY_SUMMARY, STARTED_SUMMARY } from "./run-fold.js";

export interface LegacyRun {
  id: string;
  occurrenceKey: string;
  taskId: string;
  workspaceKey: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  outcomeSummary: string;
  failureReason: string | null;
  retryOfRunId: string | null;
  executionRequest: Record<string, unknown> | null;
}

export const IMPORTABLE_LEGACY_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "missed", "running"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLegacyRunEntry(value: unknown): value is LegacyRun {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.occurrenceKey === "string" &&
    typeof value.taskId === "string" &&
    typeof value.workspaceKey === "string" &&
    typeof value.scheduledFor === "string" &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    (typeof value.finishedAt === "string" || value.finishedAt === null) &&
    typeof value.status === "string" &&
    typeof value.outcomeSummary === "string" &&
    (typeof value.failureReason === "string" || value.failureReason === null) &&
    (typeof value.retryOfRunId === "string" || value.retryOfRunId === null) &&
    (isObject(value.executionRequest) || value.executionRequest === null)
  );
}

function normalizeIso(value: string): string | null {
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

/** Recording time used for import order: startedAt ?? finishedAt ?? scheduledFor, normalized. */
export function legacyRecordingTime(run: LegacyRun): string {
  return normalizeIso(run.startedAt ?? run.finishedAt ?? run.scheduledFor) ?? run.scheduledFor;
}

/** Stable sort by recording time; equal times keep their order in the file. */
export function sortLegacyRunsForImport<T extends { run: LegacyRun }>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, time: legacyRecordingTime(entry.run) }))
    .sort((left, right) => left.time.localeCompare(right.time) || left.index - right.index)
    .map((item) => item.entry);
}

/** Events for one v0.2.0 run, or null when the run cannot be imported (counted as invalid). */
export function eventsForLegacyRun(run: LegacyRun, workspaceKey: string, now: string): NewRunEvent[] | null {
  if (!IMPORTABLE_LEGACY_STATUSES.has(run.status)) {
    return null;
  }
  const scheduledFor = normalizeIso(run.scheduledFor);
  const startedAt = run.startedAt === null ? null : normalizeIso(run.startedAt);
  const finishedAt = run.finishedAt === null ? null : normalizeIso(run.finishedAt);
  if (!scheduledFor || (run.startedAt !== null && !startedAt) || (run.finishedAt !== null && !finishedAt)) {
    return null;
  }

  const base = {
    runId: run.id,
    workspaceKey,
    taskId: run.taskId,
    occurrenceKey: run.occurrenceKey,
    scheduledFor,
    retryOfRunId: run.retryOfRunId
  };

  if (run.status === "running") {
    return [
      { ...base, type: "started", at: startedAt ?? scheduledFor, source: "migrated", summary: STARTED_SUMMARY, executionRequest: run.executionRequest },
      { ...base, type: "failed", at: now, source: "recovery", summary: RECOVERY_SUMMARY, failureReason: RECOVERY_SUMMARY }
    ];
  }

  const events: NewRunEvent[] = [];
  if (startedAt) {
    events.push({ ...base, type: "started", at: startedAt, source: "migrated", summary: STARTED_SUMMARY, executionRequest: run.executionRequest });
  }
  events.push({
    ...base,
    type: run.status as "succeeded" | "failed" | "missed",
    at: finishedAt ?? startedAt ?? scheduledFor,
    source: "migrated",
    summary: run.outcomeSummary,
    failureReason: run.failureReason
  });
  return events;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/unit/legacy-runs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Create the test helper `tests/helpers/seed.ts`**

```ts
import { RunStore } from "../../src/server/run-store.js";
import { saveWorkspaceLedger } from "../../src/server/storage.js";
import { eventsForLegacyRun, sortLegacyRunsForImport, type LegacyRun } from "../../src/server/legacy-runs.js";
import { STARTED_SUMMARY } from "../../src/server/run-fold.js";
import type { WorkspaceLedger } from "../../src/shared/model.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

/** A ledger fixture written in the v0.2.0 shape (runs inline). */
export type LegacyLedgerFixture = Omit<WorkspaceLedger, "version"> & { version?: number; runs?: LegacyRun[] };

export function createTestRunStore(): RunStore {
  return new RunStore(":memory:");
}

/**
 * Records fixture runs as events under the workspace's derived key.
 * A `running` fixture stays running (one `started` event): fixtures describe live state, not an import.
 */
export function seedRuns(store: RunStore, workspacePath: string, runs: LegacyRun[]): void {
  const workspaceKey = workspaceKeyFromPath(workspacePath);
  const now = new Date().toISOString();
  for (const { run } of sortLegacyRunsForImport(runs.map((entry) => ({ run: entry })))) {
    if (run.status === "running") {
      store.appendEvent({
        runId: run.id,
        workspaceKey,
        taskId: run.taskId,
        occurrenceKey: run.occurrenceKey,
        scheduledFor: run.scheduledFor,
        retryOfRunId: run.retryOfRunId,
        type: "started",
        at: run.startedAt ?? run.scheduledFor,
        source: "scheduler",
        summary: STARTED_SUMMARY,
        executionRequest: run.executionRequest
      });
      continue;
    }
    const events = eventsForLegacyRun(run, workspaceKey, now);
    if (!events) {
      throw new Error(`fixture run ${run.id} cannot be seeded`);
    }
    store.appendEvents(events);
  }
}

export async function seedLedger(store: RunStore, fixture: LegacyLedgerFixture): Promise<void> {
  const { runs = [], ...rest } = fixture;
  await saveWorkspaceLedger({ ...rest, version: 2 } as WorkspaceLedger);
  seedRuns(store, rest.workspacePath, runs);
}
```

- [ ] **Step 6: Change model, contracts and storage**

In `src/shared/model.ts`:
- Delete `runs: ScheduledRun[];` from `WorkspaceLedger` (line 118).
- Delete `export const RUN_HISTORY_LIMIT = 500;`.

In `src/shared/contracts.ts`:
- Add `runsNextCursor: string | null;` to `WorkspaceStateResponse` after `runs`.
- Add this after `RunResponse`:

```ts
export interface ListRunsResponse {
  runs: ScheduledRun[];
  nextCursor: string | null;
}
```

In `src/server/storage.ts`:
1. Remove `ScheduledRun` from the type import.
2. Change `const STORAGE_VERSION = 1;` to `export const STORAGE_VERSION = 2;`.
3. Rename the private `dataRoot()` to the exported `ledgerDataRoot()`, and update all callers in the file (`workspaceLedgerPath`, `ensureDataDir`, `listWorkspaceLedgerRecords`).
4. Rename `ensureDataDir` to the exported `ensureLedgerDataDir`, and update its callers.
5. In `createEmptyLedger`, delete `runs: [],`.
6. Delete `isRunEntry` (it now lives in `legacy-runs.ts`).
7. In `coerceLedgerShape`, delete the `const { entries: runs, repaired: repairedRuns } = …` line, the `if (repairedRuns) {…}` block and the `runs: runs.map(…)` property. Change the metadata check to:

```ts
  if (!Array.isArray(record.tasks)) {
    repairNotes.push("Ledger metadata was partially repaired while loading.");
  }
```

8. In `saveWorkspaceLedger`, write a v2 object without `runs`. Replace the body with:

```ts
export async function saveWorkspaceLedger(ledger: WorkspaceLedger): Promise<void> {
  await ensureLedgerDataDir();
  ledger.updatedAt = new Date().toISOString();
  ledger.version = STORAGE_VERSION;

  const { runs: _legacyRuns, ...persisted } = ledger as WorkspaceLedger & { runs?: unknown };
  void _legacyRuns;
  const filePath = workspaceLedgerPath(ledger.workspacePath);
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}
```

`loadWorkspaceLedger` returns the raw parsed file, so a not-yet-migrated v1 file can still carry `runs`. The destructuring above makes sure runtime saves never write runs back. Task 10 freezes such workspaces anyway.

- [ ] **Step 7: Change `src/server/scheduler.ts` to read and write runs through the store**

Replace the import block (lines 1–26) with:

```ts
import { randomUUID } from "node:crypto";
import type {
  CreateTaskRequest,
  ExecutionProfileRequest,
  UpdateTaskRequest,
  WorkspaceStateResponse
} from "../shared/contracts.js";
import type {
  ExecutionCapability,
  ExecutionProfile,
  RunEventSource,
  ScheduledRun,
  WorkspaceLedger,
  WorkspaceTask
} from "../shared/model.js";
import { normalizeWorkspacePath, workspaceKeyFromPath } from "../shared/workspace.js";
import {
  computeTaskNextRun,
  formatRecurrenceSummary,
  occurrenceKeyForTask,
  validateRecurrenceDefinition
} from "./recurrence.js";
import { LocalExecutionAdapter } from "./execution-adapter.js";
import { HttpError } from "./http-error.js";
import { STARTED_SUMMARY } from "./run-fold.js";
import type { ListRunsOptions, RunPage, RunStore } from "./run-store.js";
import { createExecutionProfile, normalizeExecutionProfile, resolveExecutionCapability } from "./settings.js";
import { listWorkspaceLedgers, loadWorkspaceLedger, saveWorkspaceLedger } from "./storage.js";
```

Delete `sortRunsDesc`, `trimRuns`, `createRun` and `createRunningRun` (lines 34–40 and 50–82).

Replace the class head, `loadWorkspaceState` and `listRuns` (lines 93–114) with:

```ts
export class SchedulerService {
  private readonly inFlightOccurrences = new Set<string>();

  constructor(
    private readonly executionAdapter: LocalExecutionAdapter,
    private readonly runStore: RunStore
  ) {}

  async loadWorkspaceState(workspacePath: string, capability: ExecutionCapability): Promise<WorkspaceStateResponse> {
    const ledger = await this.refreshWorkspaceLedger(workspacePath);
    const page = this.runStore.listRuns(workspaceKeyFromPath(ledger.workspacePath));
    return {
      capability,
      executionProfile: ledger.executionProfile,
      tasks: ledger.tasks,
      runs: page.runs,
      runsNextCursor: page.nextCursor
    };
  }

  async listRuns(workspacePath: string, options: ListRunsOptions = {}): Promise<RunPage> {
    return this.runStore.listRuns(workspaceKeyFromPath(workspacePath), options);
  }

  private requireRun(runId: string): ScheduledRun {
    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new Error("Run was not recorded");
    }
    return run;
  }
```

In `retryRun`, replace lines 226–229 with:

```ts
    const existing = this.runStore.getRun(runId);
    if (!existing || existing.workspaceKey !== workspaceKeyFromPath(ledger.workspacePath)) {
      throw new HttpError(404, "Run not found");
    }
```

In `tickWithoutDispatcher`, replace lines 290–292 with:

```ts
          const alreadyTracked =
            this.inFlightOccurrences.has(occurrenceKey) ||
            this.runStore.hasOccurrence(workspaceKeyFromPath(ledger.workspacePath), occurrenceKey);
```

Replace `recordMissedRun` (lines 322–328) with:

```ts
  private recordMissedRun(ledger: WorkspaceLedger, task: WorkspaceTask, scheduledFor: string, reason: string): void {
    this.runStore.appendEvent({
      runId: randomUUID(),
      workspaceKey: workspaceKeyFromPath(ledger.workspacePath),
      taskId: task.id,
      occurrenceKey: occurrenceKeyForTask(task.id, scheduledFor),
      scheduledFor,
      retryOfRunId: null,
      type: "missed",
      at: nowIso(),
      source: "scheduler",
      summary: reason,
      failureReason: reason
    });
    task.lastRunStatus = "missed";
    task.nextRunAt = computeTaskNextRun(task, scheduledFor);
  }
```

Replace `executeTask` (lines 330–395) with:

```ts
  private async executeTask(
    ledger: WorkspaceLedger,
    task: WorkspaceTask,
    scheduledFor: string,
    options?: { manual?: boolean; retryOfRunId?: string | null }
  ): Promise<ScheduledRun> {
    const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
    if (this.inFlightOccurrences.has(occurrenceKey)) {
      throw new Error("This occurrence is already running.");
    }

    const runId = randomUUID();
    const source: RunEventSource = options?.retryOfRunId ? "retry" : options?.manual ? "manual" : "scheduler";
    const base = {
      runId,
      workspaceKey: workspaceKeyFromPath(ledger.workspacePath),
      taskId: task.id,
      occurrenceKey,
      scheduledFor,
      source,
      retryOfRunId: options?.retryOfRunId ?? null
    };
    const profile = ledger.executionProfile;
    const capability = resolveExecutionCapability(profile ?? null);

    if (capability.status !== "ready" || !profile) {
      const blockedStatus: "failed" | "missed" = options?.manual ? "failed" : "missed";
      const blockedSummary = options?.manual
        ? `Manual execution could not start. ${capability.message}`
        : capability.message;
      this.runStore.appendEvent({ ...base, type: blockedStatus, at: nowIso(), summary: blockedSummary, failureReason: blockedSummary });
      task.lastRunStatus = blockedStatus;
      if (!options?.manual) {
        task.nextRunAt = computeTaskNextRun(task, scheduledFor);
      }
      await saveWorkspaceLedger(ledger);
      return this.requireRun(runId);
    }

    this.inFlightOccurrences.add(occurrenceKey);
    const executionRequest = this.executionAdapter.createRequest(task, profile, scheduledFor);
    this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
    if (!options?.manual) {
      task.nextRunAt = computeTaskNextRun(task, scheduledFor);
    }
    task.lastRunStatus = "running";
    await saveWorkspaceLedger(ledger);

    try {
      const result = await this.executionAdapter.execute(task, profile, scheduledFor, executionRequest);
      this.runStore.appendEvent({ ...base, type: result.status, at: nowIso(), summary: result.outcomeSummary, failureReason: result.failureReason });
      task.lastRunStatus = result.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local command execution failed.";
      this.runStore.appendEvent({ ...base, type: "failed", at: nowIso(), summary: message, failureReason: message });
      task.lastRunStatus = "failed";
    } finally {
      this.inFlightOccurrences.delete(occurrenceKey);
    }
    await saveWorkspaceLedger(ledger);
    return this.requireRun(runId);
  }
```

- [ ] **Step 8: Change `src/server/dashboard.ts` to use store summaries**

1. Remove `ScheduledRun` from the type import. Add:

```ts
import { workspaceKeyFromPath } from "../shared/workspace.js";
import type { RunStore, TaskRunSummary } from "./run-store.js";

const EMPTY_SUMMARY: TaskRunSummary = { latest: null, latestFinished: null };
```

2. Delete `latestRunsByTaskId` (lines 16–27).
3. Replace `deriveTaskStatus`, `findLatestActionableRunId` and `buildJobRecord` (lines 41–118) with:

```ts
function deriveTaskStatus(
  task: WorkspaceTask,
  summary: TaskRunSummary,
  workspaceAvailability: WorkspaceAvailability
): GlobalJobRunStatus {
  const latest = summary.latest;
  if (latest?.status === "running") {
    return "running";
  }

  if (!task.enabled) {
    return "paused";
  }

  if (!latest) {
    return storedTaskStatus(task);
  }

  if (workspaceAvailability !== "available" && latest.status === "succeeded") {
    return "succeeded";
  }

  switch (latest.status) {
    case "succeeded":
    case "failed":
    case "missed":
      return latest.status;
    default:
      return storedTaskStatus(task);
  }
}

function findLatestActionableRunId(summary: TaskRunSummary): string | null {
  const latest = summary.latest;
  if (!latest) {
    return null;
  }
  return latest.status === "failed" || latest.status === "missed" ? latest.id : null;
}

function buildJobRecord(
  ledgerRecord: WorkspaceLedgerRecord,
  ledger: WorkspaceLedger,
  task: WorkspaceTask,
  summary: TaskRunSummary
): GlobalJobRecord {
  const lastRunStatus = deriveTaskStatus(task, summary, ledgerRecord.status);
  const latestActionableRunId = findLatestActionableRunId(summary);

  return {
    taskId: task.id,
    workspaceKey: ledger.workspaceKey,
    workspacePath: ledger.workspacePath,
    workspaceLabel: ledgerRecord.workspaceLabel,
    workspaceDrilldownAvailable: ledgerRecord.status !== "unavailable",
    name: task.name,
    scheduleType: task.recurrence.scheduleType,
    recurrenceSummary: task.recurrenceSummary,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunStatus,
    lastRunFinishedAt: summary.latestFinished?.finishedAt ?? null,
    latestActionableRunId,
    workspaceAvailability: ledgerRecord.status,
    availableActions: buildAvailableActions(task, latestActionableRunId)
  };
}
```

4. Change `buildGlobalDashboardSnapshot`'s signature to `(filter: GlobalDashboardFilter, runStore: RunStore)`. Replace its inner loop (lines 239–242) with:

```ts
    const summaries = runStore.taskRunSummaries(
      workspaceKeyFromPath(ledger.workspacePath),
      ledger.tasks.map((task) => task.id)
    );
    for (const task of ledger.tasks) {
      allJobs.push(buildJobRecord(workspace, ledger, task, summaries.get(task.id) ?? EMPTY_SUMMARY));
    }
```

`ledger.workspaceKey` here is the filename stem (`storage.ts:143`). Runs are keyed by `workspaceKeyFromPath(ledger.workspacePath)` (the design's Workspace key rule). The two differ for copied or misnamed files, so always use the derived key for `RunStore` calls.

5. Change `resolveGlobalTask` to `(workspaceKey: string, taskId: string, runStore: RunStore)` and replace lines 288–292 with:

```ts
  const summary =
    runStore
      .taskRunSummaries(workspaceKeyFromPath(workspace.ledger.workspacePath), [taskId])
      .get(taskId) ?? EMPTY_SUMMARY;
  const latestActionableRunId = findLatestActionableRunId(summary);
```

- [ ] **Step 9: Change `src/server/http.ts` and `src/server.ts`**

In `http.ts`:
- Add `ListRunsResponse` to the contracts type import, and add `import type { RunStore } from "./run-store.js";`.
- Change the signatures to `createHttpHandler(scheduler: SchedulerService, runStore: RunStore)` and `startHttpServer(scheduler: SchedulerService, runStore: RunStore)`; `startHttpServer` passes both to `createHttpHandler`.
- Pass `runStore` as the second argument to `buildGlobalDashboardSnapshot(…)` (line 90) and as the third argument to `resolveGlobalTask(workspaceKey, taskId, runStore)` (line 190).
- Replace the `/v1/runs` body at line 104 with:

```ts
        const page = await scheduler.listRuns(workspacePath, { limit });
        json(response, 200, { runs: page.runs, nextCursor: page.nextCursor } satisfies ListRunsResponse);
```

Replace `src/server.ts` with this. Task 11 replaces it again with the final startup order.

```ts
import path from "node:path";
import { LocalExecutionAdapter } from "./server/execution-adapter.js";
import { startHttpServer } from "./server/http.js";
import { SchedulerService } from "./server/scheduler.js";
import { ensureLedgerDataDir, ledgerDataRoot } from "./server/storage.js";

async function main(): Promise<void> {
  await ensureLedgerDataDir();
  const { RunStore } = await import("./server/run-store.js");
  const runStore = new RunStore(path.join(ledgerDataRoot(), "runs.db"));
  const scheduler = new SchedulerService(new LocalExecutionAdapter(), runStore);
  const server = await startHttpServer(scheduler, runStore);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server port");
  }

  setInterval(() => {
    void scheduler.tickWithoutDispatcher();
  }, 30_000).unref();

  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 10: Update the existing tests**

**`tests/integration/http-errors.test.ts`.** Add `import type { RunStore } from "../../src/server/run-store.js";` and change the call to `startHttpServer(scheduler as SchedulerService, {} as RunStore)`.

**`tests/integration/scheduler-loop.test.ts`.**
1. Add these imports:

```ts
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { RunStore } from "../../src/server/run-store.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";
```

2. Add `let store: RunStore;` next to the other `let` declarations.
3. In `beforeEach`, add `store = new RunStore(":memory:");` at the end. In `afterEach`, add `store.close();` first.
4. Inside the `describe`, add these helpers after the hooks:

```ts
  const createScheduler = () => new SchedulerService(new LocalExecutionAdapter(), store);
  const runsOf = () => store.listRuns(workspaceKeyFromPath(workspacePath)).runs;
```

5. Apply the replacements:

```bash
perl -0pi -e 's/new SchedulerService\(\)/createScheduler()/g; s/\b(updated|replayCheck|stillPaused|afterResume|afterTick|ledger)\.runs\b/runsOf()/g' tests/integration/scheduler-loop.test.ts
```

Then check by hand that no `.runs` reference to a ledger remains (`grep -n "\.runs" tests/integration/scheduler-loop.test.ts` should show only `runsOf()` calls).

**`tests/unit/dashboard.test.ts`.**
1. Replace the storage import with:

```ts
import type { RunStore } from "../../src/server/run-store.js";
import { createTestRunStore, seedLedger } from "../helpers/seed.js";
```

2. Add `let store: RunStore;`. In `beforeEach`, add `store = createTestRunStore();`. In `afterEach`, add `store.close();`.
3. Apply:

```bash
perl -0pi -e 's/await saveWorkspaceLedger\(\{/await seedLedger(store, {/g; s/buildGlobalDashboardSnapshot\((\{[^}]*\})\)/buildGlobalDashboardSnapshot($1, store)/g' tests/unit/dashboard.test.ts
```

**`tests/integration/global-dashboard.test.ts`.**
1. Add these imports:

```ts
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { createTestRunStore, seedLedger } from "../helpers/seed.js";
```

2. Keep `loadWorkspaceLedger` in the storage import and drop `saveWorkspaceLedger`.
3. Five tests touch storage or the server: "aggregates jobs across multiple persisted workspaces", "keeps summary counters…", "surfaces unreadable ledgers…", "routes global HTTP actions…" and "returns post-action task state…". In each one:
   - insert `const store = createTestRunStore();` directly after `process.env.HOME = tempHome;`;
   - insert `store.close();` as the first statement of its `finally` block.
4. Apply:

```bash
perl -0pi -e 's/await saveWorkspaceLedger\(\{/await seedLedger(store, {/g; s/buildGlobalDashboardSnapshot\((\{[^}]*\})\)/buildGlobalDashboardSnapshot($1, store)/g; s/startHttpServer\(new SchedulerService\(\)\)/startHttpServer(new SchedulerService(new LocalExecutionAdapter(), store), store)/g' tests/integration/global-dashboard.test.ts
```

**`tests/integration/performance.test.ts`.**
1. Add these imports:

```ts
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { createTestRunStore, seedLedger } from "../helpers/seed.js";
```

2. Drop `saveWorkspaceLedger` from the imports.
3. In the two original tests:
   - add `const store = createTestRunStore();` as the first line;
   - replace `await saveWorkspaceLedger({` with `await seedLedger(store, {`;
   - replace `new SchedulerService()` with `new SchedulerService(new LocalExecutionAdapter(), store)`;
   - replace `buildGlobalDashboardSnapshot({ sortBy: "urgency" })` with `buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store)`;
   - add `store.close();` as the last line.
4. Change `expect(state.runs).toHaveLength(500);` to:

```ts
    expect(state.runs).toHaveLength(100);
    expect(state.runsNextCursor).not.toBeNull();
```

5. Rename that test to `"loads 100 tasks and the first page of 500 runs within the documented budget"`.

**`tests/unit/storage.test.ts`.** In "filters malformed task and run entries while keeping the workspace readable", replace

```ts
    expect(partial?.ledger?.runs).toHaveLength(1);
    expect(partial?.warning).toContain("Invalid task entries were ignored.");
    expect(partial?.warning).toContain("Invalid run entries were ignored.");
```

with

```ts
    expect(partial?.warning).toContain("Invalid task entries were ignored.");
    expect(partial?.warning).not.toContain("Invalid run entries");
```

Then append these tests to the `describe`:

```ts
  it("treats a ledger without runs as available and never writes runs", async () => {
    await mkdir("/tmp/project-v2", { recursive: true });
    const ledger = await loadWorkspaceLedger("/tmp/project-v2");
    (ledger as typeof ledger & { runs?: unknown[] }).runs = [{ stale: true }];
    await saveWorkspaceLedger(ledger);

    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    const file = JSON.parse(await readFile(path.join(dataDir, `${ledger.workspaceKey}.json`), "utf8"));
    expect(file.version).toBe(2);
    expect("runs" in file).toBe(false);

    const records = await listWorkspaceLedgerRecords();
    const record = records.find((entry) => entry.workspacePath === "/tmp/project-v2");
    expect(record?.status).toBe("available");
    expect(record?.warning).toBeNull();
  });
```

Add `readFile` to the `node:fs/promises` import.

- [ ] **Step 11: Run the suite and the type check**

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all test files pass, and `grep -rn "\.runs\b" src/server` shows no ledger-run references.

- [ ] **Step 12: Commit**

```bash
git add -A src tests
git commit -m "feat(003): store run history in RunStore instead of ledger files"
```

---

### Task 7: Derive `lastRunStatus`; add `legacyLastRunStatus`

**Files:**
- Modify: `src/shared/model.ts:68-81` (`WorkspaceTask`)
- Modify: `src/server/storage.ts` (task guard, coercion pass-through, save writes `lastRunStatus: null`)
- Modify: `src/server/scheduler.ts` (remove `lastRunStatus` writes, add `withDerivedStatus`, duplicate clears legacy)
- Modify: `src/server/dashboard.ts` (`storedTaskStatus` reads legacy; `readGlobalTaskState` derives)
- Modify: `src/server/http.ts` (`loadTaskAfterAction` passes the store)
- Test: `tests/unit/derived-status.test.ts` (new), plus updates to `tests/unit/dashboard.test.ts`, `tests/integration/scheduler-loop.test.ts` and `tests/unit/storage.test.ts`

**Interfaces:**
- Consumes: Task 6 store wiring.
- Produces:
  - `WorkspaceTask.legacyLastRunStatus?: RunStatus | null`
  - `readGlobalTaskState(workspaceKey, taskId, runStore: RunStore): Promise<WorkspaceTask>`. It returns a copy with the derived `lastRunStatus`.
  - `SchedulerService` (private) `withDerivedStatus(workspaceKey: string, tasks: WorkspaceTask[]): WorkspaceTask[]`
  - Every scheduler method that returns a `WorkspaceTask` now returns a copy with the derived status.

- [ ] **Step 1: Write the failing tests**

`tests/unit/derived-status.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import type { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { listWorkspaceLedgerRecords, loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";
import { createTestRunStore } from "../helpers/seed.js";

const capability = () => ({ status: "needs_config" as const, message: "not configured" });

describe("derived lastRunStatus", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;
  let store: RunStore;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-derived-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = createTestRunStore();
    scheduler = new SchedulerService(new LocalExecutionAdapter(), store);
  });

  afterEach(async () => {
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function createTask() {
    return scheduler.createTask({
      workspacePath,
      name: "Daily",
      prompt: "Go",
      recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" }
    });
  }

  it("derives status from the latest run and never stores it", async () => {
    const task = await createTask();
    expect(task.lastRunStatus).toBeNull();
    await scheduler.createManualRun(task.id, workspacePath);

    const state = await scheduler.loadWorkspaceState(workspacePath, capability());
    expect(state.tasks[0]?.lastRunStatus).toBe("failed");

    const file = JSON.parse(await readFile(path.join(tempHome, ".cloudcli-workspace-scheduled-prompts", `${workspaceKeyFromPath(workspacePath)}.json`), "utf8"));
    expect(file.tasks[0].lastRunStatus).toBeNull();
  });

  it("falls back to legacyLastRunStatus only when the task has no runs", async () => {
    const task = await createTask();
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.legacyLastRunStatus = "succeeded";
    await saveWorkspaceLedger(ledger);
    expect((await scheduler.loadWorkspaceState(workspacePath, capability())).tasks[0]?.lastRunStatus).toBe("succeeded");

    await scheduler.createManualRun(task.id, workspacePath);
    expect((await scheduler.loadWorkspaceState(workspacePath, capability())).tasks[0]?.lastRunStatus).toBe("failed");
  });

  it("does not copy legacyLastRunStatus into a duplicate", async () => {
    const task = await createTask();
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.legacyLastRunStatus = "failed";
    await saveWorkspaceLedger(ledger);
    const copy = await scheduler.duplicateTask(task.id, workspacePath);
    const stored = (await loadWorkspaceLedger(workspacePath)).tasks.find((entry) => entry.id === copy.id);
    expect(stored && "legacyLastRunStatus" in stored).toBe(false);
    expect(copy.lastRunStatus).toBeNull();
  });

  it("keeps a valid legacyLastRunStatus through coercion and drops an invalid one", async () => {
    await createTask();
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.legacyLastRunStatus = "failed";
    ledger.tasks.push({ ...ledger.tasks[0]!, id: "bogus", legacyLastRunStatus: "nonsense" as never });
    await saveWorkspaceLedger(ledger);
    const record = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspacePath === workspacePath);
    expect(record?.ledger?.tasks.find((entry) => entry.id !== "bogus")?.legacyLastRunStatus).toBe("failed");
    expect(record?.ledger?.tasks.find((entry) => entry.id === "bogus")?.legacyLastRunStatus).toBeUndefined();
  });
});
```

`loadWorkspaceState` still takes a capability object at this point; Task 8 changes it to a function and updates these calls.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/derived-status.test.ts`
Expected: FAIL. `lastRunStatus` in the file is `"failed"` rather than `null`, and the legacy assertions fail.

- [ ] **Step 3: Implement**

In `src/shared/model.ts`, add this to `WorkspaceTask` after `lastRunStatus`:

```ts
  legacyLastRunStatus?: RunStatus | null;
```

In `src/server/storage.ts`:

1. Add this near the top:

```ts
const RUN_STATUSES: ReadonlySet<string> = new Set(["scheduled", "running", "succeeded", "failed", "missed", "canceled"]);
```

2. In `isTaskEntry`, replace the `lastRunStatus` condition (line 91) with:

```ts
    (value.lastRunStatus === undefined || typeof value.lastRunStatus === "string" || value.lastRunStatus === null) &&
    (value.legacyLastRunStatus === undefined || typeof value.legacyLastRunStatus === "string" || value.legacyLastRunStatus === null) &&
```

3. In `coerceLedgerShape`, replace the tasks mapping with:

```ts
      tasks: tasks.map((task) => {
        const coerced: WorkspaceTask = {
          ...task,
          lastRunStatus: task.lastRunStatus ?? null,
          workspaceKey,
          workspacePath
        };
        if (typeof task.legacyLastRunStatus === "string" && RUN_STATUSES.has(task.legacyLastRunStatus)) {
          coerced.legacyLastRunStatus = task.legacyLastRunStatus;
        } else {
          delete coerced.legacyLastRunStatus;
        }
        return coerced;
      }),
```

4. In `saveWorkspaceLedger`, persist `lastRunStatus: null` without mutating the caller's object. Replace the `persisted` line with:

```ts
  const { runs: _legacyRuns, ...rest } = ledger as WorkspaceLedger & { runs?: unknown };
  void _legacyRuns;
  const persisted = { ...rest, tasks: rest.tasks.map((task) => ({ ...task, lastRunStatus: null })) };
```

In `src/server/scheduler.ts`:

1. Delete every `task.lastRunStatus = …` assignment: in `recordMissedRun`, and in `executeTask` (the blocked branch, the `"running"` line, the success line and the catch line).
2. Add this private method:

```ts
  private withDerivedStatus(workspaceKey: string, tasks: WorkspaceTask[]): WorkspaceTask[] {
    const summaries = this.runStore.taskRunSummaries(workspaceKey, tasks.map((task) => task.id));
    return tasks.map((task) => ({
      ...task,
      lastRunStatus: summaries.get(task.id)?.latest?.status ?? task.legacyLastRunStatus ?? null
    }));
  }
```

3. Make these methods return derived copies:
   - In `loadWorkspaceState`, `tasks: this.withDerivedStatus(workspaceKeyFromPath(ledger.workspacePath), ledger.tasks)`.
   - In `createTask`, `updateTask` and `duplicateTask`, replace `return task;` (or `return copy;`) with `return this.withDerivedStatus(workspaceKeyFromPath(ledger.workspacePath), [task])[0]!;` (use `copy` in `duplicateTask`).
4. In `duplicateTask`, after building `copy` and before `ledger.tasks.push(copy);`, add `delete copy.legacyLastRunStatus;`.

In `src/server/dashboard.ts`:

1. Replace `storedTaskStatus` with:

```ts
function storedTaskStatus(task: WorkspaceTask): GlobalJobRunStatus {
  switch (task.legacyLastRunStatus) {
    case "running":
    case "succeeded":
    case "failed":
    case "missed":
      return task.legacyLastRunStatus;
    default:
      return "never_run";
  }
}
```

2. Change `readGlobalTaskState` to `(workspaceKey: string, taskId: string, runStore: RunStore)` and replace its `return task;` with:

```ts
  const summary =
    runStore.taskRunSummaries(workspaceKeyFromPath(workspace.ledger.workspacePath), [taskId]).get(taskId) ?? EMPTY_SUMMARY;
  return { ...task, lastRunStatus: summary.latest?.status ?? task.legacyLastRunStatus ?? null };
```

In `src/server/http.ts`, change `loadTaskAfterAction` to take `runStore` and call `readGlobalTaskState(workspaceKey, taskId, runStore)`. Update its two callers to `loadTaskAfterAction(workspaceKey, taskId, runStore)`.

- [ ] **Step 4: Update the existing tests**

**`tests/unit/dashboard.test.ts`**, test "falls back to the persisted task status when matching run history has been trimmed". Rename it to `"falls back to legacyLastRunStatus when the task has no runs"` and, in its task fixture, replace `lastRunStatus: "failed",` with:

```ts
          lastRunStatus: null,
          legacyLastRunStatus: "failed",
```

**`tests/integration/scheduler-loop.test.ts`**, test "executes due runs…". Replace `expect(updated.tasks[0]?.lastRunStatus).toBe("succeeded");` with:

```ts
    const derived = await scheduler.loadWorkspaceState(workspacePath, { status: "ready", message: "ok" });
    expect(derived.tasks[0]?.lastRunStatus).toBe("succeeded");
```

- [ ] **Step 5: Run the suite and the type check**

Run: `npx vitest run tests/unit/derived-status.test.ts && npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass. `grep -n "lastRunStatus = " src/server/scheduler.ts` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "feat(003): derive lastRunStatus from run history; legacyLastRunStatus fallback"
```

---

### Task 8: Ledger lock, occurrence claim, and the refresh and edit rules

This task replaces `src/server/scheduler.ts` with its final shape, except for the frozen-workspace gates that Task 10 adds. Read design §2 "Ledger writes are serialized…", "Claiming a scheduled occurrence", "The refresh never takes a due occurrence away from the tick", "`nextRunAt` on task edits", "Manual runs and retries", "Event summaries at runtime" and "Tick errors" before starting.

**Files:**
- Replace: `src/server/scheduler.ts`
- Modify: `src/server/http.ts:77-87` (one locked workspace-state call)
- Test: `tests/integration/scheduler-concurrency.test.ts` (new)
- Test: update `tests/integration/scheduler-loop.test.ts`, `tests/integration/performance.test.ts` and `tests/unit/derived-status.test.ts` (the `loadWorkspaceState` signature)

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces:
  - `SchedulerService.loadWorkspaceState(workspacePath: string, capabilityFor: (profile: ExecutionProfile | null) => ExecutionCapability): Promise<WorkspaceStateResponse>`
  - `listRuns` (read-only), `createTask`, `updateTask`, `deleteTask`, `pauseTask`, `resumeTask`, `duplicateTask`, `createManualRun`, `retryRun`, `saveExecutionProfile`, `tickWithoutDispatcher`
  - `export function logTickError(error: unknown, workspaceKey?: string): void`
  - private `claimOccurrence(workspacePath, taskId, scheduledFor, tickStartedAt): Promise<ClaimOutcome>` (the tests call it through a cast)
  - `refreshWorkspaceLedger` is removed from the public API.

- [ ] **Step 1: Write the failing tests**

`tests/integration/scheduler-concurrency.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { HttpError } from "../../src/server/http-error.js";
import { SAVE_FAILED_SUMMARY } from "../../src/server/run-fold.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

const daily = { scheduleType: "daily" as const, timezone: "Europe/Paris", localTime: "09:00" };
const notReady = () => ({ status: "needs_config" as const, message: "not configured" });

describe("scheduler concurrency", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;
  let store: RunStore;
  let scheduler: SchedulerService;
  let key: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-conc-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new RunStore(":memory:");
    scheduler = new SchedulerService(new LocalExecutionAdapter(), store);
    key = workspaceKeyFromPath(workspacePath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function slowTask(ms = 400) {
    const task = await scheduler.createTask({ workspacePath, name: "Slow", prompt: "Go", recurrence: daily });
    await scheduler.saveExecutionProfile({
      workspacePath,
      command: process.execPath,
      args: ["-e", `setTimeout(() => console.log('done'), ${ms})`],
      timeoutMs: 10_000
    });
    await makeDue(task.id);
    return task;
  }

  async function makeDue(taskId: string, agoMs = 10_000) {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const task = ledger.tasks.find((entry) => entry.id === taskId)!;
    task.nextRunAt = new Date(Date.now() - agoMs).toISOString();
    await saveWorkspaceLedger(ledger);
    return task.nextRunAt;
  }

  async function waitForRunning(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (store.listRuns(key).runs[0]?.status === "running") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("run never started");
  }

  it("keeps a pause made while the run executes", async () => {
    const task = await slowTask();
    const tick = scheduler.tickWithoutDispatcher();
    await waitForRunning();
    await scheduler.pauseTask(task.id, workspacePath);
    await tick;
    expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.enabled).toBe(false);
    expect(store.listRuns(key).runs[0]?.status).toBe("succeeded");
  });

  it("keeps a prompt edit made while the run executes", async () => {
    const task = await slowTask();
    const tick = scheduler.tickWithoutDispatcher();
    await waitForRunning();
    await scheduler.updateTask(task.id, { workspacePath, prompt: "Edited" });
    await tick;
    expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.prompt).toBe("Edited");
  });

  // Review Focus 2: task deleted while its command runs
  it("records the final event of a task deleted mid-run and keeps it visible", async () => {
    const task = await slowTask();
    const tick = scheduler.tickWithoutDispatcher();
    await waitForRunning();
    await scheduler.deleteTask(task.id, workspacePath);
    await tick;
    expect((await loadWorkspaceLedger(workspacePath)).tasks).toHaveLength(0);
    expect(store.listRuns(key).runs[0]).toMatchObject({ taskId: task.id, status: "succeeded" });
    await expect(scheduler.tickWithoutDispatcher()).resolves.toBeUndefined();
  });

  it("executes a due occurrence once when two ticks overlap", async () => {
    await slowTask();
    await Promise.all([scheduler.tickWithoutDispatcher(), scheduler.tickWithoutDispatcher()]);
    const runs = store.listRuns(key).runs;
    expect(runs).toHaveLength(1);
    expect(store.listEvents(runs[0]!.id).filter((entry) => entry.type === "started")).toHaveLength(1);
  });

  it("does not run an occurrence the user rescheduled while a stale tick held it", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "T", prompt: "P", recurrence: daily });
    const stale = await makeDue(task.id);
    await scheduler.updateTask(task.id, { workspacePath, recurrence: { ...daily, localTime: "10:30" } });
    const claim = (scheduler as unknown as {
      claimOccurrence(p: string, t: string, s: string, n: string): Promise<{ kind: string }>;
    }).claimOccurrence(workspacePath, task.id, stale, new Date().toISOString());
    expect((await claim).kind).toBe("skipped");
    expect(store.listRuns(key).runs).toHaveLength(0);
  });

  it("logs a failing workspace and still ticks the others, with no unhandled rejection", async () => {
    const otherPath = path.join(tempHome, "other");
    await mkdir(otherPath, { recursive: true });
    const a = await scheduler.createTask({ workspacePath, name: "A", prompt: "A", recurrence: daily });
    await makeDue(a.id);
    const b = await scheduler.createTask({ workspacePath: otherPath, name: "B", prompt: "B", recurrence: daily });
    const ledgerB = await loadWorkspaceLedger(otherPath);
    ledgerB.tasks.find((entry) => entry.id === b.id)!.nextRunAt = new Date(Date.now() - 10_000).toISOString();
    await saveWorkspaceLedger(ledgerB);

    const original = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation((event) => {
      if (event.workspaceKey === key) {
        throw new Error("disk full");
      }
      original(event);
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(scheduler.tickWithoutDispatcher()).resolves.toBeUndefined();
    expect(store.listRuns(workspaceKeyFromPath(otherPath)).runs).toHaveLength(1);
    expect(stderr.mock.calls.some(([line]) => String(line).includes("disk full"))).toBe(true);
    expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.nextRunAt).not.toBeNull();
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "records a failed run when the claim's save fails, then advances without executing",
    async () => {
      const task = await slowTask(10);
      const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await chmod(dataDir, 0o500);
      try {
        await scheduler.tickWithoutDispatcher();
      } finally {
        await chmod(dataDir, 0o700);
      }
      const [run] = store.listRuns(key).runs;
      expect(run).toMatchObject({ status: "failed", outcomeSummary: SAVE_FAILED_SUMMARY });

      await scheduler.tickWithoutDispatcher();
      expect(store.listRuns(key).runs).toHaveLength(1);
      expect((await loadWorkspaceLedger(workspacePath)).tasks.find((entry) => entry.id === task.id)?.nextRunAt! > new Date().toISOString()).toBe(true);
    }
  );

  it("does not let a workspace-state load take a due occurrence from the tick", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "T", prompt: "P", recurrence: daily });
    const due = await makeDue(task.id, 60_000);
    await scheduler.loadWorkspaceState(workspacePath, notReady);
    expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.nextRunAt).toBe(due);
    await scheduler.tickWithoutDispatcher();
    expect(store.listRuns(key).runs).toHaveLength(1);
  });

  it("never writes the ledger when listing runs", async () => {
    const untouched = path.join(tempHome, "untouched");
    await scheduler.listRuns(untouched);
    expect(existsSync(path.join(tempHome, ".cloudcli-workspace-scheduled-prompts", `${workspaceKeyFromPath(untouched)}.json`))).toBe(false);
  });

  it("keeps nextRunAt on a prompt edit in the due window, also when the recurrence repeats in another key order", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "T", prompt: "P", recurrence: daily });
    const due = await makeDue(task.id, 30_000);
    await scheduler.updateTask(task.id, {
      workspacePath,
      prompt: "New",
      recurrence: { localTime: "09:00", timezone: "Europe/Paris", scheduleType: "daily" }
    });
    expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.nextRunAt).toBe(due);
    await scheduler.tickWithoutDispatcher();
    expect(store.listRuns(key).runs).toHaveLength(1);
  });

  it("recomputes nextRunAt from now on resume, and keeps it null on a paused recurrence edit", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "T", prompt: "P", recurrence: daily });
    await makeDue(task.id);
    const paused = await scheduler.pauseTask(task.id, workspacePath);
    expect(paused.nextRunAt).toBeNull();
    const edited = await scheduler.updateTask(task.id, { workspacePath, recurrence: { ...daily, localTime: "11:00" } });
    expect(edited.nextRunAt).toBeNull();
    const resumed = await scheduler.resumeTask(task.id, workspacePath);
    expect(resumed.nextRunAt! > new Date().toISOString()).toBe(true);
  });

  it("gives manual runs a key that never matches a scheduled occurrence", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "T", prompt: "P", recurrence: daily });
    const run = await scheduler.createManualRun(task.id, workspacePath);
    expect(run.occurrenceKey).toBe(`${task.id}:manual:${run.id}`);
    expect(run.outcomeSummary).toBe(
      "Manual execution could not start. Configure a local execution command to enable automatic prompt runs."
    );
  });

  it("rejects a retry of another workspace's run with 404", async () => {
    const otherPath = path.join(tempHome, "other");
    await mkdir(otherPath, { recursive: true });
    const other = await scheduler.createTask({ workspacePath: otherPath, name: "O", prompt: "O", recurrence: daily });
    const run = await scheduler.createManualRun(other.id, otherPath);
    await expect(scheduler.retryRun(run.id, workspacePath)).rejects.toMatchObject({ status: 404, message: "Run not found" });
    await expect(scheduler.retryRun(run.id, workspacePath)).rejects.toBeInstanceOf(HttpError);
  });

  // Review Focus 3: unknown fields in a hand-edited ledger survive locked writes
  it("preserves unknown ledger and task fields across locked edits and refreshes", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "T", prompt: "P", recurrence: daily });
    const file = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts", `${key}.json`);
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.notes = "keep me";
    raw.tasks[0].notes = "me too";
    await writeFile(file, JSON.stringify(raw), "utf8");

    await scheduler.updateTask(task.id, { workspacePath, prompt: "Changed" });
    await scheduler.loadWorkspaceState(workspacePath, notReady);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.notes).toBe("keep me");
    expect(after.tasks[0].notes).toBe("me too");
  });
});
```

The manual-run summary comes from `resolveExecutionCapability`'s `needs_config` message (`src/server/settings.ts:72-75`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/scheduler-concurrency.test.ts`
Expected: FAIL. Among the failures:
- the pause or prompt edit made during the run is overwritten;
- overlapping ticks give 2 runs;
- `claimOccurrence` is not a function;
- the manual key format doesn't match;
- the state load advances `nextRunAt`.

- [ ] **Step 3: Replace `src/server/scheduler.ts`**

```ts
import { randomUUID } from "node:crypto";
import type {
  CreateTaskRequest,
  ExecutionProfileRequest,
  UpdateTaskRequest,
  WorkspaceStateResponse
} from "../shared/contracts.js";
import type {
  ExecutionCapability,
  ExecutionProfile,
  RunEventSource,
  ScheduledRun,
  WorkspaceLedger,
  WorkspaceTask
} from "../shared/model.js";
import { normalizeWorkspacePath, workspaceKeyFromPath } from "../shared/workspace.js";
import {
  computeTaskNextRun,
  formatRecurrenceSummary,
  occurrenceKeyForTask,
  validateRecurrenceDefinition
} from "./recurrence.js";
import type { ExecutionRequestMetadata, LocalExecutionAdapter } from "./execution-adapter.js";
import { HttpError } from "./http-error.js";
import { MISSED_UNAVAILABLE_SUMMARY, SAVE_FAILED_SUMMARY, STARTED_SUMMARY } from "./run-fold.js";
import type { ListRunsOptions, RunPage, RunStore } from "./run-store.js";
import { createExecutionProfile, normalizeExecutionProfile, resolveExecutionCapability } from "./settings.js";
import { listWorkspaceLedgers, loadWorkspaceLedger, saveWorkspaceLedger } from "./storage.js";

const EXECUTION_GRACE_WINDOW_MS = 90_000;

function nowIso(): string {
  return new Date().toISOString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isOutsideExecutionGraceWindow(scheduledFor: string, referenceIso: string): boolean {
  const scheduledAt = Date.parse(scheduledFor);
  const referenceAt = Date.parse(referenceIso);
  if (Number.isNaN(scheduledAt) || Number.isNaN(referenceAt)) {
    return true;
  }
  return referenceAt - scheduledAt > EXECUTION_GRACE_WINDOW_MS;
}

function manualOccurrenceKey(taskId: string, runId: string): string {
  return `${taskId}:manual:${runId}`;
}

export function logTickError(error: unknown, workspaceKey?: string): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[scheduled-prompts] tick error${workspaceKey ? ` (workspace ${workspaceKey})` : ""}: ${detail}\n`);
}

interface RunBase {
  runId: string;
  workspaceKey: string;
  taskId: string;
  occurrenceKey: string;
  scheduledFor: string;
  source: RunEventSource;
  retryOfRunId: string | null;
}

interface ClaimedRun {
  base: RunBase;
  task: WorkspaceTask;
  profile: ExecutionProfile;
  executionRequest: ExecutionRequestMetadata;
}

type ClaimOutcome =
  | { kind: "skipped"; nextRunAt: null }
  | { kind: "advanced"; nextRunAt: string | null }
  | { kind: "started"; nextRunAt: string | null; run: ClaimedRun };

export class SchedulerService {
  private readonly inFlightOccurrences = new Set<string>();
  private readonly ledgerLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly executionAdapter: LocalExecutionAdapter,
    private readonly runStore: RunStore
  ) {}

  /** Per-workspace lock; reloads the ledger, runs fn, saves only if fn changed it. Not re-entrant. */
  private async mutateLedger<T>(workspacePath: string, fn: (ledger: WorkspaceLedger) => T | Promise<T>): Promise<T> {
    const lockKey = workspaceKeyFromPath(workspacePath);
    const previous = this.ledgerLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.ledgerLocks.set(lockKey, chained);
    await previous;
    try {
      const ledger = await loadWorkspaceLedger(workspacePath);
      const before = JSON.stringify(ledger);
      const result = await fn(ledger);
      if (JSON.stringify(ledger) !== before) {
        await saveWorkspaceLedger(ledger);
      }
      return result;
    } finally {
      release();
      if (this.ledgerLocks.get(lockKey) === chained) {
        this.ledgerLocks.delete(lockKey);
      }
    }
  }

  private withDerivedStatus(workspaceKey: string, tasks: WorkspaceTask[]): WorkspaceTask[] {
    const summaries = this.runStore.taskRunSummaries(workspaceKey, tasks.map((task) => task.id));
    return tasks.map((task) => ({
      ...task,
      lastRunStatus: summaries.get(task.id)?.latest?.status ?? task.legacyLastRunStatus ?? null
    }));
  }

  private requireRun(runId: string): ScheduledRun {
    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new Error("Run was not recorded");
    }
    return run;
  }

  /** The refresh never moves a nextRunAt that is already due: the tick owns past-due slots. */
  private refreshLocked(ledger: WorkspaceLedger): void {
    const normalizedProfile = normalizeExecutionProfile(ledger.executionProfile);
    if (JSON.stringify(normalizedProfile) !== JSON.stringify(ledger.executionProfile)) {
      ledger.executionProfile = normalizedProfile;
    }
    const now = nowIso();
    for (const task of ledger.tasks) {
      task.recurrenceSummary = formatRecurrenceSummary(task.recurrence);
      const due = task.enabled && task.nextRunAt !== null && task.nextRunAt <= now;
      if (!due) {
        task.nextRunAt = computeTaskNextRun(task, now);
      }
    }
  }

  async loadWorkspaceState(
    workspacePath: string,
    capabilityFor: (profile: ExecutionProfile | null) => ExecutionCapability
  ): Promise<WorkspaceStateResponse> {
    return this.mutateLedger(workspacePath, (ledger) => {
      this.refreshLocked(ledger);
      const workspaceKey = workspaceKeyFromPath(ledger.workspacePath);
      const page = this.runStore.listRuns(workspaceKey);
      return {
        capability: capabilityFor(ledger.executionProfile),
        executionProfile: ledger.executionProfile,
        tasks: this.withDerivedStatus(workspaceKey, ledger.tasks),
        runs: page.runs,
        runsNextCursor: page.nextCursor
      };
    });
  }

  /** Read-only: no lock, no refresh, no save. */
  async listRuns(workspacePath: string, options: ListRunsOptions = {}): Promise<RunPage> {
    return this.runStore.listRuns(workspaceKeyFromPath(workspacePath), options);
  }

  async createTask(request: CreateTaskRequest): Promise<WorkspaceTask> {
    validateRecurrenceDefinition(request.recurrence);
    const task = await this.mutateLedger(request.workspacePath, (ledger) => {
      const createdAt = nowIso();
      const created: WorkspaceTask = {
        id: randomUUID(),
        workspaceKey: ledger.workspaceKey,
        workspacePath: normalizeWorkspacePath(request.workspacePath),
        name: request.name.trim(),
        prompt: request.prompt.trim(),
        recurrence: request.recurrence,
        recurrenceSummary: formatRecurrenceSummary(request.recurrence),
        enabled: true,
        nextRunAt: null,
        lastRunStatus: null,
        createdAt,
        updatedAt: createdAt
      };
      created.nextRunAt = computeTaskNextRun(created, createdAt);
      ledger.tasks.push(created);
      return { ...created };
    });
    return this.withDerivedStatus(workspaceKeyFromPath(request.workspacePath), [task])[0]!;
  }

  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<WorkspaceTask> {
    const task = await this.mutateLedger(request.workspacePath, (ledger) => this.updateTaskLocked(ledger, taskId, request));
    return this.withDerivedStatus(workspaceKeyFromPath(request.workspacePath), [task])[0]!;
  }

  /** nextRunAt rules (design §2 "nextRunAt on task edits"); the first matching row wins. */
  private updateTaskLocked(ledger: WorkspaceLedger, taskId: string, request: UpdateTaskRequest): WorkspaceTask {
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    const wasEnabled = task.enabled;
    let recurrenceChanged = false;
    if (request.recurrence) {
      validateRecurrenceDefinition(request.recurrence);
      recurrenceChanged = canonicalJson(request.recurrence) !== canonicalJson(task.recurrence);
      task.recurrence = request.recurrence;
    }
    if (request.name !== undefined) {
      task.name = request.name.trim();
    }
    if (request.prompt !== undefined) {
      task.prompt = request.prompt.trim();
    }
    if (request.enabled !== undefined) {
      task.enabled = request.enabled;
    }
    task.updatedAt = nowIso();
    task.recurrenceSummary = formatRecurrenceSummary(task.recurrence);

    if (wasEnabled && !task.enabled) {
      task.nextRunAt = null;
    } else if (!wasEnabled && task.enabled) {
      task.nextRunAt = computeTaskNextRun(task, task.updatedAt);
    } else if (recurrenceChanged) {
      task.nextRunAt = computeTaskNextRun(task, task.updatedAt);
    }
    return { ...task };
  }

  async deleteTask(taskId: string, workspacePath: string): Promise<void> {
    await this.mutateLedger(workspacePath, (ledger) => {
      ledger.tasks = ledger.tasks.filter((task) => task.id !== taskId);
    });
  }

  async pauseTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: false });
  }

  async resumeTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: true });
  }

  async duplicateTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    const copy = await this.mutateLedger(workspacePath, (ledger) => {
      const source = ledger.tasks.find((task) => task.id === taskId);
      if (!source) {
        throw new Error("Task not found");
      }
      const createdAt = nowIso();
      const duplicate: WorkspaceTask = {
        ...source,
        id: randomUUID(),
        name: `${source.name} (Copy)`,
        createdAt,
        updatedAt: createdAt,
        lastRunStatus: null
      };
      delete duplicate.legacyLastRunStatus;
      duplicate.recurrenceSummary = formatRecurrenceSummary(duplicate.recurrence);
      duplicate.nextRunAt = computeTaskNextRun(duplicate, createdAt);
      ledger.tasks.push(duplicate);
      return { ...duplicate };
    });
    return this.withDerivedStatus(workspaceKeyFromPath(workspacePath), [copy])[0]!;
  }

  async saveExecutionProfile(request: ExecutionProfileRequest): Promise<ExecutionProfile> {
    return this.mutateLedger(request.workspacePath, (ledger) => {
      ledger.executionProfile = createExecutionProfile({
        workspaceKey: ledger.workspaceKey,
        command: request.command,
        args: request.args,
        timeoutMs: request.timeoutMs
      });
      return ledger.executionProfile;
    });
  }

  async createManualRun(taskId: string, workspacePath: string): Promise<ScheduledRun> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    return this.runManually(ledger, { ...task }, null);
  }

  async retryRun(runId: string, workspacePath: string): Promise<ScheduledRun> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const existing = this.runStore.getRun(runId);
    if (!existing || existing.workspaceKey !== workspaceKeyFromPath(ledger.workspacePath)) {
      throw new HttpError(404, "Run not found");
    }
    const task = ledger.tasks.find((entry) => entry.id === existing.taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    return this.runManually(ledger, { ...task }, existing.id);
  }

  /** Manual runs and retries never claim and never move nextRunAt. */
  private async runManually(ledger: WorkspaceLedger, task: WorkspaceTask, retryOfRunId: string | null): Promise<ScheduledRun> {
    const runId = randomUUID();
    const base: RunBase = {
      runId,
      workspaceKey: workspaceKeyFromPath(ledger.workspacePath),
      taskId: task.id,
      occurrenceKey: manualOccurrenceKey(task.id, runId),
      scheduledFor: nowIso(),
      source: retryOfRunId ? "retry" : "manual",
      retryOfRunId
    };
    const profile = ledger.executionProfile;
    const capability = resolveExecutionCapability(profile ?? null);
    if (capability.status !== "ready" || !profile) {
      const summary = `Manual execution could not start. ${capability.message}`;
      this.runStore.appendEvent({ ...base, type: "failed", at: nowIso(), summary, failureReason: summary });
      return this.requireRun(runId);
    }

    const executionRequest = this.executionAdapter.createRequest(task, profile, base.scheduledFor);
    this.inFlightOccurrences.add(base.occurrenceKey);
    try {
      this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
      await this.executeAndRecord({ base, task, profile, executionRequest });
    } finally {
      this.inFlightOccurrences.delete(base.occurrenceKey);
    }
    return this.requireRun(runId);
  }

  /** Runs the adapter outside any lock and appends the final event. */
  private async executeAndRecord(run: ClaimedRun): Promise<void> {
    let final: { type: "succeeded" | "failed"; summary: string; failureReason: string | null };
    try {
      const result = await this.executionAdapter.execute(run.task, run.profile, run.base.scheduledFor, run.executionRequest);
      final = { type: result.status, summary: result.outcomeSummary, failureReason: result.failureReason };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local command execution failed.";
      final = { type: "failed", summary: message, failureReason: message };
    }
    this.runStore.appendEvent({ ...run.base, ...final, at: nowIso() });
  }

  async tickWithoutDispatcher(): Promise<void> {
    const ledgers = await listWorkspaceLedgers();
    for (const snapshot of ledgers) {
      const workspaceKey = workspaceKeyFromPath(snapshot.workspacePath);
      try {
        await this.tickWorkspace(snapshot);
      } catch (error) {
        logTickError(error, workspaceKey);
      }
    }
  }

  private async tickWorkspace(snapshot: WorkspaceLedger): Promise<void> {
    const tickStartedAt = nowIso();
    for (const viewTask of snapshot.tasks) {
      let scheduledFor = viewTask.enabled ? viewTask.nextRunAt : null;
      while (scheduledFor && scheduledFor <= tickStartedAt) {
        const outcome = await this.claimOccurrence(snapshot.workspacePath, viewTask.id, scheduledFor, tickStartedAt);
        if (outcome.kind === "started") {
          try {
            await this.executeAndRecord(outcome.run);
          } finally {
            this.inFlightOccurrences.delete(outcome.run.base.occurrenceKey);
          }
          break;
        }
        if (outcome.kind === "skipped") {
          break;
        }
        scheduledFor = outcome.nextRunAt;
      }
    }
  }

  /** Compare-and-set inside the lock (design §2 "Claiming a scheduled occurrence"). */
  private async claimOccurrence(
    workspacePath: string,
    taskId: string,
    scheduledFor: string,
    tickStartedAt: string
  ): Promise<ClaimOutcome> {
    const claim: { addedKey?: string; started?: ClaimedRun } = {};
    try {
      return await this.mutateLedger(workspacePath, (ledger): ClaimOutcome => {
        const task = ledger.tasks.find((entry) => entry.id === taskId);
        if (!task || !task.enabled || task.nextRunAt !== scheduledFor) {
          return { kind: "skipped", nextRunAt: null };
        }
        const workspaceKey = workspaceKeyFromPath(ledger.workspacePath);
        const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
        task.nextRunAt = computeTaskNextRun(task, scheduledFor);
        if (this.inFlightOccurrences.has(occurrenceKey) || this.runStore.hasOccurrence(workspaceKey, occurrenceKey)) {
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        const base: RunBase = {
          runId: randomUUID(),
          workspaceKey,
          taskId: task.id,
          occurrenceKey,
          scheduledFor,
          source: "scheduler",
          retryOfRunId: null
        };
        const profile = ledger.executionProfile;
        const capability = resolveExecutionCapability(profile ?? null);
        if (capability.status !== "ready" || !profile || isOutsideExecutionGraceWindow(scheduledFor, tickStartedAt)) {
          const summary = capability.status !== "ready" ? capability.message : MISSED_UNAVAILABLE_SUMMARY;
          this.runStore.appendEvent({ ...base, type: "missed", at: nowIso(), summary, failureReason: summary });
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        const executionRequest = this.executionAdapter.createRequest(task, profile, scheduledFor);
        this.inFlightOccurrences.add(occurrenceKey);
        claim.addedKey = occurrenceKey;
        this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
        claim.started = { base, task: { ...task }, profile, executionRequest };
        return { kind: "started", nextRunAt: task.nextRunAt, run: claim.started };
      });
    } catch (error) {
      if (claim.addedKey) {
        this.inFlightOccurrences.delete(claim.addedKey);
      }
      if (claim.started) {
        this.runStore.appendEvent({
          ...claim.started.base,
          type: "failed",
          at: nowIso(),
          summary: SAVE_FAILED_SUMMARY,
          failureReason: SAVE_FAILED_SUMMARY
        });
      }
      throw error;
    }
  }
}
```

Check `execution-adapter.ts:6`: `ExecutionRequestMetadata` is already exported there.

- [ ] **Step 4: One locked workspace-state call in `src/server/http.ts`**

Replace lines 82–84 with:

```ts
        const payload: WorkspaceStateResponse = await scheduler.loadWorkspaceState(workspacePath, (profile) =>
          createCapability(request.headers, profile)
        );
```

- [ ] **Step 5: Update callers of the new `loadWorkspaceState` signature in tests**

```bash
perl -0pi -e 's/loadWorkspaceState\(workspacePath, \{/loadWorkspaceState(workspacePath, () => ({/g; s/(loadWorkspaceState\(workspacePath, \(\) => \(\{[^}]*\})\)/$1))/g' tests/integration/scheduler-loop.test.ts tests/integration/performance.test.ts
perl -0pi -e 's/loadWorkspaceState\(workspacePath, capability\(\)\)/loadWorkspaceState(workspacePath, capability)/g' tests/unit/derived-status.test.ts
```

Then check that every call has the form `scheduler.loadWorkspaceState(workspacePath, () => ({ status: …, message: … }))`: `grep -n "loadWorkspaceState" tests -r`.

In `scheduler-loop.test.ts`, two assertions depend on the new behaviour:
- **"does not execute paused tasks until they are resumed"**: it stays green. Resume recomputes `nextRunAt`, and the test then makes the task due again by hand.
- **"duplicates tasks and supports a manual run-now…"**: it stays green. Manual runs still record one run.

- [ ] **Step 6: Run the suite and the type check**

Run: `npx vitest run tests/integration/scheduler-concurrency.test.ts && npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass. `grep -n "refreshWorkspaceLedger" src -r` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "feat(003): serialize ledger writes and claim occurrences with compare-and-set"
```

---

### Task 9: Runs API: paging, task filter, events and `retryOf`

**Files:**
- Modify: `src/shared/contracts.ts` (add `RunEventsResponse`, `ListRunsQuery` and `parseListRunsQuery`)
- Modify: `src/server/scheduler.ts` (add `listRunEvents`)
- Modify: `src/server/http.ts` (the `/v1/runs` parser and `GET /v1/runs/:id/events`)
- Test: `tests/integration/runs-api.test.ts` (new)
- Test: `tests/contract/plugin-rpc.test.ts` (parser cases)

**Interfaces:**
- Consumes: Task 8 `SchedulerService.listRuns` and Task 4 `RunStore.listEvents`/`getRun`.
- Produces:
  - `parseListRunsQuery(searchParams: URLSearchParams): ListRunsQuery`, where `ListRunsQuery = { workspacePath: string; limit?: number; before?: string; taskId?: string }`
  - `RunEventsResponse = { events: RunEvent[]; retryOf: { id: string; scheduledFor: string } | null }`
  - `SchedulerService.listRunEvents(runId: string, workspacePath: string): Promise<RunEventsResponse>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/plugin-rpc.test.ts`, inside the `describe`, and add `parseListRunsQuery` to its contracts import:

```ts
  it("parses run list queries", () => {
    expect(parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p&limit=20&before=41&taskId=t1"))).toEqual({
      workspacePath: "/tmp/p",
      limit: 20,
      before: "41",
      taskId: "t1"
    });
    expect(parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p"))).toEqual({
      workspacePath: "/tmp/p",
      limit: undefined,
      before: undefined,
      taskId: undefined
    });
    expect(() => parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p&limit=abc"))).toThrow("limit must be an integer");
    expect(() => parseListRunsQuery(new URLSearchParams("limit=5"))).toThrow("workspacePath is required");
  });
```

`tests/integration/runs-api.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import type http from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { startHttpServer } from "../../src/server/http.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";

const daily = { scheduleType: "daily" as const, timezone: "Europe/Paris", localTime: "09:00" };

describe("runs API", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let workspacePath: string;
  let store: RunStore;
  let scheduler: SchedulerService;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-runs-api-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    store = new RunStore(":memory:");
    scheduler = new SchedulerService(new LocalExecutionAdapter(), store);
    server = await startHttpServer(scheduler, store);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  const get = async (url: string) => {
    const response = await fetch(`${baseUrl}${url}`);
    return { status: response.status, body: await response.json() };
  };

  it("pages with before, filters by taskId and validates limit and cursor", async () => {
    const a = await scheduler.createTask({ workspacePath, name: "A", prompt: "A", recurrence: daily });
    const b = await scheduler.createTask({ workspacePath, name: "B", prompt: "B", recurrence: daily });
    for (let index = 0; index < 3; index += 1) {
      await scheduler.createManualRun(a.id, workspacePath);
      await scheduler.createManualRun(b.id, workspacePath);
    }
    const wp = encodeURIComponent(workspacePath);

    const first = await get(`/v1/runs?workspacePath=${wp}&limit=4`);
    expect(first.status).toBe(200);
    expect(first.body.runs).toHaveLength(4);
    const second = await get(`/v1/runs?workspacePath=${wp}&limit=4&before=${first.body.nextCursor}`);
    expect(second.body.runs).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.runs, ...second.body.runs].map((run: { id: string }) => run.id);
    expect(new Set(ids).size).toBe(6);

    const filtered = await get(`/v1/runs?workspacePath=${wp}&taskId=${a.id}`);
    expect(filtered.body.runs.every((run: { taskId: string }) => run.taskId === a.id)).toBe(true);
    expect(filtered.body.runs).toHaveLength(3);

    expect(await get(`/v1/runs?workspacePath=${wp}&limit=abc`)).toEqual({ status: 400, body: { error: "limit must be an integer" } });
    expect(await get(`/v1/runs?workspacePath=${wp}&before=xyz`)).toEqual({ status: 400, body: { error: "invalid cursor" } });
  });

  it("returns a run's events with retryOf, and 404 for another workspace", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "A", prompt: "A", recurrence: daily });
    const original = await scheduler.createManualRun(task.id, workspacePath);
    const retry = await scheduler.retryRun(original.id, workspacePath);
    const wp = encodeURIComponent(workspacePath);

    const events = await get(`/v1/runs/${retry.id}/events?workspacePath=${wp}`);
    expect(events.status).toBe(200);
    expect(events.body.events.map((entry: { type: string; source: string }) => [entry.type, entry.source])).toEqual([["failed", "retry"]]);
    expect(events.body.retryOf).toEqual({ id: original.id, scheduledFor: original.scheduledFor });

    const plain = await get(`/v1/runs/${original.id}/events?workspacePath=${wp}`);
    expect(plain.body.retryOf).toBeNull();

    const otherPath = encodeURIComponent(path.join(tempHome, "other"));
    expect(await get(`/v1/runs/${original.id}/events?workspacePath=${otherPath}`)).toEqual({ status: 404, body: { error: "Run not found" } });
    expect(await get(`/v1/runs/missing/events?workspacePath=${wp}`)).toEqual({ status: 404, body: { error: "Run not found" } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/runs-api.test.ts tests/contract/plugin-rpc.test.ts`
Expected: FAIL. `parseListRunsQuery` is not exported, the events route returns 404 "Route not found", and `limit=abc` returns a 200 with an empty page instead of a 400.

- [ ] **Step 3: Implement**

In `src/shared/contracts.ts`, add `RunEvent` to the model type import and add:

```ts
export interface RunEventsResponse {
  events: RunEvent[];
  retryOf: { id: string; scheduledFor: string } | null;
}

export interface ListRunsQuery {
  workspacePath: string;
  limit?: number;
  before?: string;
  taskId?: string;
}

export function parseListRunsQuery(searchParams: URLSearchParams): ListRunsQuery {
  const workspacePath = searchParams.get("workspacePath")?.trim();
  if (!workspacePath) {
    throw new Error("workspacePath is required");
  }
  const limitValue = searchParams.get("limit");
  let limit: number | undefined;
  if (limitValue !== null) {
    if (!/^-?\d+$/u.test(limitValue.trim())) {
      throw new Error("limit must be an integer");
    }
    limit = Number(limitValue);
  }
  const before = searchParams.get("before");
  const taskId = searchParams.get("taskId");
  return {
    workspacePath,
    limit,
    before: before === null ? undefined : before,
    taskId: taskId ? taskId : undefined
  };
}
```

`before=""` passes through as `""`, so `RunStore` throws `"invalid cursor"` (Task 4 tests the empty string).

In `src/server/scheduler.ts`, add `RunEventsResponse` to the contracts type import and add:

```ts
  async listRunEvents(runId: string, workspacePath: string): Promise<RunEventsResponse> {
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    const run = this.runStore.getRun(runId);
    if (!run || run.workspaceKey !== workspaceKey) {
      throw new HttpError(404, "Run not found");
    }
    const original = run.retryOfRunId ? this.runStore.getRun(run.retryOfRunId) : null;
    return {
      events: this.runStore.listEvents(runId),
      retryOf:
        original && original.workspaceKey === workspaceKey
          ? { id: original.id, scheduledFor: original.scheduledFor }
          : null
    };
  }
```

In `src/server/http.ts`:
- Add `parseListRunsQuery` and `RunEventsResponse` to the contracts imports.
- Replace the whole `/v1/runs` branch (lines 97–106) with:

```ts
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        const query = parseListRunsQuery(url.searchParams);
        const page = await scheduler.listRuns(query.workspacePath, {
          limit: query.limit,
          before: query.before ?? null,
          taskId: query.taskId ?? null
        });
        json(response, 200, { runs: page.runs, nextCursor: page.nextCursor } satisfies ListRunsResponse);
        return;
      }

      if (request.method === "GET" && segments[0] === "v1" && segments[1] === "runs" && segments[2] && segments[3] === "events" && segments.length === 4) {
        const workspacePath = url.searchParams.get("workspacePath");
        if (!workspacePath) {
          throw new Error("workspacePath is required");
        }
        const payload: RunEventsResponse = await scheduler.listRunEvents(decodeURIComponent(segments[2]), workspacePath);
        json(response, 200, payload);
        return;
      }
```

- [ ] **Step 4: Run the suite and the type check**

Run: `npx vitest run tests/integration/runs-api.test.ts tests/contract/plugin-rpc.test.ts && npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "feat(003): run paging, task filter and per-run events API"
```

---

### Task 10: v0.2.0 migration and frozen workspaces

Read design §3 "Migration" and "Ledger code" in full first. Every numbered step and bullet there is a requirement.

**Files:**
- Create: `src/server/migrate-runs.ts`
- Modify: `src/shared/model.ts` (`WorkspaceLedger.migratedFrom?: string`)
- Modify: `src/server/storage.ts` (frozen keys, frozen record status, `migratedFrom` pass-through)
- Modify: `src/server/scheduler.ts` (`frozenKeys` constructor parameter and gates)
- Test: `tests/unit/migrate-runs.test.ts` (new)
- Test: `tests/integration/frozen-workspace.test.ts` (new)

**Interfaces:**
- Consumes: Task 6 `legacy-runs.ts`, `ledgerDataRoot` and `ensureLedgerDataDir`; Task 4 `RunStore` (`hasRun`, `getRun`, `appendEvents`, `taskRunSummaries`); Task 5 `HttpError`.
- Produces:
  - `migrateLedgerRuns(store: RunStore, options?: { log?: (line: string) => void; now?: string }): Promise<Set<string>>`, which returns the frozen derived keys
  - `setFrozenWorkspaceKeys(keys: ReadonlySet<string>): void`
  - `FROZEN_WORKSPACE_WARNING`
  - `new SchedulerService(executionAdapter, runStore, frozenKeys: ReadonlySet<string> = new Set())`
  - `HttpError(409, "Run history import pending")`, thrown by `mutateLedger`, `createManualRun` and `retryRun` for a frozen key; the tick skips frozen workspaces.

- [ ] **Step 1: Write the failing tests**

`tests/unit/migrate-runs.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLedgerRuns } from "../../src/server/migrate-runs.js";
import { RunStore } from "../../src/server/run-store.js";
import { RECOVERY_SUMMARY } from "../../src/server/run-fold.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

const NOW = "2026-10-31T12:00:00.000Z";

function v1Run(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    occurrenceKey: `task-1:${id}`,
    taskId: "task-1",
    workspaceKey: "whatever",
    scheduledFor: "2026-04-27T07:00:00.000Z",
    startedAt: "2026-04-27T07:00:01.000Z",
    finishedAt: "2026-04-27T07:00:09.000Z",
    status: "succeeded",
    outcomeSummary: `ok ${id}`,
    failureReason: null,
    retryOfRunId: null,
    executionRequest: null,
    ...extra
  };
}

function v1Task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspaceKey: "whatever",
    workspacePath: "/ignored",
    name: id,
    prompt: "P",
    recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
    recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
    enabled: true,
    nextRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...extra
  };
}

describe("migrateLedgerRuns", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let dataDir: string;
  let store: RunStore;
  let logs: string[];
  const log = (line: string) => logs.push(line);

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-migrate-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    store = new RunStore(":memory:");
    logs = [];
  });

  afterEach(async () => {
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeV1(name: string, workspacePath: string, runs: unknown[], tasks: unknown[] = [v1Task("task-1")], extra: Record<string, unknown> = {}) {
    await writeFile(path.join(dataDir, name), JSON.stringify({ version: 1, workspaceKey: "x", workspacePath, tasks, runs, executionProfile: null, updatedAt: NOW, ...extra }), "utf8");
  }

  const readJson = async (name: string) => JSON.parse(await readFile(path.join(dataDir, name), "utf8"));

  it("imports a matching-name v1 file into events, a v2 file at the same path, and a .bak", async () => {
    const workspacePath = "/tmp/alpha";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1"), v1Run("r2", { status: "failed", failureReason: "boom", startedAt: "2026-04-27T08:00:01.000Z", finishedAt: "2026-04-27T08:00:05.000Z" })]);

    const frozen = await migrateLedgerRuns(store, { log, now: NOW });

    expect(frozen.size).toBe(0);
    expect(existsSync(path.join(dataDir, `${key}.v1.json.bak`))).toBe(true);
    const v2 = await readJson(`${key}.json`);
    expect(v2.version).toBe(2);
    expect("runs" in v2).toBe(false);
    expect(v2.workspaceKey).toBe(key);
    expect(v2.tasks[0].workspaceKey).toBe(key);
    expect("migratedFrom" in v2).toBe(false);
    const runs = store.listRuns(key).runs;
    expect(runs.map((run) => run.id)).toEqual(["r2", "r1"]);
    expect(runs[1]).toMatchObject({ status: "succeeded", startedAt: "2026-04-27T07:00:01.000Z", finishedAt: "2026-04-27T07:00:09.000Z", outcomeSummary: "ok r1", failureReason: null });
    expect(runs[0]).toMatchObject({ status: "failed", failureReason: "boom" });
    expect(store.listEvents("r1")[0]?.summary).toBe("Command started.");
  });

  it("closes a running entry with started + recovery failed", async () => {
    const workspacePath = "/tmp/running";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("live", { status: "running", finishedAt: null })]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listEvents("live").map((entry) => [entry.type, entry.source, entry.at])).toEqual([
      ["started", "migrated", "2026-04-27T07:00:01.000Z"],
      ["failed", "recovery", NOW]
    ]);
    expect(store.listEvents("live")[1]?.summary).toBe(RECOVERY_SUMMARY);
  });

  it("does not duplicate after a crash between commit and rewrite", async () => {
    const workspacePath = "/tmp/crash";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1")]);
    const original = await readFile(path.join(dataDir, `${key}.json`), "utf8");
    await migrateLedgerRuns(store, { log, now: NOW });
    await writeFile(path.join(dataDir, `${key}.json`), original, "utf8");
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listEvents("r1")).toHaveLength(2);
    expect("runs" in (await readJson(`${key}.json`))).toBe(false);
  });

  it("counts invalid, unknown-status, scheduled/canceled and duplicate entries and imports the rest", async () => {
    const workspacePath = "/tmp/invalid";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [
      null,
      v1Run("ok"),
      v1Run("weird", { status: "exploded" }),
      v1Run("sched", { status: "scheduled" }),
      v1Run("bad-time", { startedAt: "not a date" }),
      v1Run("ok", { outcomeSummary: "duplicate" })
    ]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listRuns(key).runs.map((run) => run.id)).toEqual(["ok"]);
    expect(store.getRun("ok")?.outcomeSummary).toBe("ok ok");
    expect(logs.some((line) => line.includes("5 run entries could not be imported"))).toBe(true);
  });

  it("sets legacyLastRunStatus only for tasks without imported runs, mapping running to failed", async () => {
    const workspacePath = "/tmp/legacy";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1")], [
      v1Task("task-1", { lastRunStatus: "succeeded" }),
      v1Task("task-2", { lastRunStatus: "missed" }),
      v1Task("task-3", { lastRunStatus: "running" }),
      v1Task("task-4", { lastRunStatus: null })
    ]);
    await migrateLedgerRuns(store, { log, now: NOW });
    const tasks = (await readJson(`${key}.json`)).tasks;
    expect(tasks.map((task: Record<string, unknown>) => [task.id, task.lastRunStatus, task.legacyLastRunStatus])).toEqual([
      ["task-1", null, undefined],
      ["task-2", null, "missed"],
      ["task-3", null, "failed"],
      ["task-4", null, undefined]
    ]);
  });

  it("orders imported runs by recording time so a later retry sorts above an earlier run", async () => {
    const workspacePath = "/tmp/order";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [
      v1Run("retry", { retryOfRunId: "a", startedAt: "2026-04-29T07:00:00.000Z", finishedAt: "2026-04-29T07:00:05.000Z" }),
      v1Run("b", { scheduledFor: "2026-04-28T07:00:00.000Z", startedAt: "2026-04-28T07:00:01.000Z", finishedAt: "2026-04-28T07:00:05.000Z" }),
      v1Run("a")
    ]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listRuns(key).runs.map((run) => run.id)).toEqual(["retry", "b", "a"]);
  });

  // Review Focus 1: trailing slash and offset timestamps
  it("moves a misnamed file to its derived name, normalizing workspacePath and timestamps", async () => {
    const workspacePath = "/tmp/misnamed/";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1("copied.json", workspacePath, [v1Run("r1", { scheduledFor: "2026-04-27T09:00:00+02:00", startedAt: "2026-04-27T09:00:01+02:00", finishedAt: "2026-04-27T09:00:09+02:00" })]);
    await migrateLedgerRuns(store, { log, now: NOW });

    expect(existsSync(path.join(dataDir, "copied.json"))).toBe(false);
    expect(existsSync(path.join(dataDir, "copied.v1.json.bak"))).toBe(true);
    const moved = await readJson(`${key}.json`);
    expect(moved).toMatchObject({ migratedFrom: "copied.json", workspaceKey: key, workspacePath: "/tmp/misnamed" });
    expect(moved.tasks[0].workspacePath).toBe("/tmp/misnamed");
    expect(store.getRun("r1")).toMatchObject({ workspaceKey: key, scheduledFor: "2026-04-27T07:00:00.000Z" });
  });

  it("removes a leftover original after an interrupted rename", async () => {
    const workspacePath = "/tmp/leftover";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1("orig.json", workspacePath, [v1Run("r1")]);
    await writeFile(path.join(dataDir, `${key}.json`), JSON.stringify({ version: 2, workspaceKey: key, workspacePath, tasks: [], migratedFrom: "orig.json", executionProfile: null, updatedAt: NOW }), "utf8");
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(existsSync(path.join(dataDir, "orig.json"))).toBe(false);
  });

  it("leaves both files untouched on a name conflict, even when the target has runs: []", async () => {
    const workspacePath = "/tmp/conflict";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1("stray.json", workspacePath, [v1Run("r1")]);
    await writeV1(`${key}.json`, workspacePath, [], [v1Task("other")]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(existsSync(path.join(dataDir, "stray.json"))).toBe(true);
    expect(logs.some((line) => line.includes("ledger name conflict: stray.json"))).toBe(true);
    expect(store.hasRun("r1")).toBe(false);
  });

  it("counts a run id already imported from another workspace as invalid", async () => {
    const pathA = "/tmp/a";
    const pathB = "/tmp/b";
    await writeV1(`${workspaceKeyFromPath(pathA)}.json`, pathA, [v1Run("shared")]);
    await writeV1(`${workspaceKeyFromPath(pathB)}.json`, pathB, [v1Run("shared")]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listEvents("shared").every((entry) => entry.workspaceKey === store.getRun("shared")!.workspaceKey)).toBe(true);
    expect(logs.some((line) => line.includes("run id shared already imported from"))).toBe(true);
  });

  it("scopes legacyLastRunStatus to the workspace for a copied ledger with the same task ids", async () => {
    const pathA = "/tmp/copy-a";
    const pathB = "/tmp/copy-b";
    await writeV1(`${workspaceKeyFromPath(pathA)}.json`, pathA, [v1Run("only-a")], [v1Task("task-1", { lastRunStatus: "succeeded" })]);
    await writeV1(`${workspaceKeyFromPath(pathB)}.json`, pathB, [], [v1Task("task-1", { lastRunStatus: "failed" })]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect((await readJson(`${workspaceKeyFromPath(pathB)}.json`)).tasks[0].legacyLastRunStatus).toBe("failed");
    expect(store.taskRunSummaries(workspaceKeyFromPath(pathB), ["task-1"]).get("task-1")?.latest).toBeNull();
  });

  it("freezes the derived key when the import fails and leaves the file unchanged", async () => {
    const workspacePath = "/tmp/fails";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1")]);
    vi.spyOn(store, "appendEvents").mockImplementation(() => {
      throw new Error("disk full");
    });
    const frozen = await migrateLedgerRuns(store, { log, now: NOW });
    expect([...frozen]).toEqual([key]);
    expect(Array.isArray((await readJson(`${key}.json`)).runs)).toBe(true);
    vi.restoreAllMocks();
    const retried = await migrateLedgerRuns(store, { log, now: NOW });
    expect(retried.size).toBe(0);
    expect(store.hasRun("r1")).toBe(true);
  });

  it("skips files without runs and is a no-op the second time", async () => {
    const workspacePath = "/tmp/noop";
    const key = workspaceKeyFromPath(workspacePath);
    await writeFile(path.join(dataDir, `${key}.json`), JSON.stringify({ version: 2, workspaceKey: key, workspacePath, tasks: [], executionProfile: null, updatedAt: NOW }), "utf8");
    const before = await readFile(path.join(dataDir, `${key}.json`), "utf8");
    await migrateLedgerRuns(store, { log, now: NOW });
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(await readFile(path.join(dataDir, `${key}.json`), "utf8")).toBe(before);
    expect(existsSync(path.join(dataDir, `${key}.v1.json.bak`))).toBe(false);
  });
});
```

`tests/integration/frozen-workspace.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { FROZEN_WORKSPACE_WARNING, listWorkspaceLedgerRecords, setFrozenWorkspaceKeys } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

describe("frozen workspaces", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let store: RunStore;
  let dataDir: string;
  const workspacePath = "/tmp/frozen-ws";
  const key = workspaceKeyFromPath(workspacePath);

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-frozen-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    store = new RunStore(":memory:");
    await writeFile(
      path.join(dataDir, "misnamed.json"),
      JSON.stringify({
        version: 1,
        workspaceKey: "x",
        workspacePath,
        tasks: [
          {
            id: "t1",
            workspaceKey: "x",
            workspacePath,
            name: "T",
            prompt: "P",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
            recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
            enabled: true,
            nextRunAt: new Date(Date.now() - 60_000).toISOString(),
            lastRunStatus: null,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z"
          }
        ],
        runs: [{ id: "r1" }],
        executionProfile: null,
        updatedAt: "2026-04-01T00:00:00.000Z"
      }),
      "utf8"
    );
    setFrozenWorkspaceKeys(new Set([key]));
  });

  afterEach(async () => {
    setFrozenWorkspaceKeys(new Set());
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("reports the workspace unavailable with the frozen warning", async () => {
    const record = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === "misnamed");
    expect(record?.status).toBe("unavailable");
    expect(record?.warning).toContain(FROZEN_WORKSPACE_WARNING);
  });

  it("returns 409 for edits, state loads, Run Now and Retry, and creates no derived ledger file", async () => {
    const scheduler = new SchedulerService(new LocalExecutionAdapter(), store, new Set([key]));
    const pending = { status: 409, message: "Run history import pending" };
    await expect(scheduler.loadWorkspaceState(workspacePath, () => ({ status: "needs_config", message: "x" }))).rejects.toMatchObject(pending);
    await expect(scheduler.createTask({ workspacePath, name: "N", prompt: "P", recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" } })).rejects.toMatchObject(pending);
    await expect(scheduler.createManualRun("t1", workspacePath)).rejects.toMatchObject(pending);
    await expect(scheduler.retryRun("r1", workspacePath)).rejects.toMatchObject(pending);
    expect(existsSync(path.join(dataDir, `${key}.json`))).toBe(false);
  });

  it("is skipped by the tick", async () => {
    const scheduler = new SchedulerService(new LocalExecutionAdapter(), store, new Set([key]));
    await scheduler.tickWithoutDispatcher();
    expect(store.listRuns(key).runs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/migrate-runs.test.ts tests/integration/frozen-workspace.test.ts`
Expected: FAIL with `Failed to load url ../../src/server/migrate-runs.js` and missing exports from `storage.js`.

- [ ] **Step 3: Implement `src/server/migrate-runs.ts`**

```ts
import { access, copyFile, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NewRunEvent } from "../shared/model.js";
import { normalizeWorkspacePath, workspaceKeyFromPath } from "../shared/workspace.js";
import { eventsForLegacyRun, isLegacyRunEntry, sortLegacyRunsForImport, type LegacyRun } from "./legacy-runs.js";
import type { RunStore, TaskRunSummary } from "./run-store.js";
import { ensureLedgerDataDir, ledgerDataRoot, STORAGE_VERSION } from "./storage.js";

const RUN_STATUSES: ReadonlySet<string> = new Set(["scheduled", "running", "succeeded", "failed", "missed", "canceled"]);

interface MigrationOptions {
  log?: (line: string) => void;
  now?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/**
 * One-time import of v0.2.0 ledger runs (design §3 "Migration").
 * Returns the derived workspace keys whose import failed (the frozen workspaces).
 */
export async function migrateLedgerRuns(store: RunStore, options: MigrationOptions = {}): Promise<Set<string>> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? new Date().toISOString();
  await ensureLedgerDataDir();
  const root = ledgerDataRoot();
  const frozen = new Set<string>();

  const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const filePath = path.join(root, name);
    let raw: unknown;
    try {
      raw = await readJson(filePath);
    } catch {
      continue; // unreadable ledgers are reported by listWorkspaceLedgerRecords
    }
    if (!isObject(raw) || !Array.isArray(raw.runs)) {
      continue;
    }

    let derivedKey: string | null = null;
    try {
      const stem = name.slice(0, -".json".length);
      const backupPath = path.join(root, `${stem}.v1.json.bak`);
      if (!(await exists(backupPath))) {
        await copyFile(filePath, `${backupPath}.tmp`);
        await rename(`${backupPath}.tmp`, backupPath);
      }

      if (typeof raw.workspacePath !== "string" || !raw.workspacePath.trim()) {
        log(`[scheduled-prompts] ${name}: workspacePath is missing; run history not imported`);
        continue;
      }
      derivedKey = workspaceKeyFromPath(raw.workspacePath);
      const targetPath = path.join(root, `${derivedKey}.json`);

      if (targetPath !== filePath && (await exists(targetPath))) {
        const target = await readJson(targetPath).catch(() => null);
        if (isObject(target) && target.migratedFrom === name) {
          await unlink(filePath);
          log(`[scheduled-prompts] ${name}: removed leftover of an interrupted import into ${derivedKey}.json`);
          continue;
        }
        log(`[scheduled-prompts] ledger name conflict: ${name} vs ${derivedKey}.json; run history not imported`);
        continue;
      }

      const events = collectEvents(store, name, stem, raw.runs, derivedKey, now, log);
      store.appendEvents(events);
      await rewriteLedger(store, raw, name, filePath, targetPath, derivedKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[scheduled-prompts] ${name}: run history import failed (${message}); it will be retried at the next start`);
      if (derivedKey) {
        frozen.add(derivedKey);
      }
    }
  }
  return frozen;
}

function collectEvents(
  store: RunStore,
  name: string,
  stem: string,
  entries: unknown[],
  workspaceKey: string,
  now: string,
  log: (line: string) => void
): NewRunEvent[] {
  let invalid = 0;
  const candidates: Array<{ run: LegacyRun; events: NewRunEvent[] }> = [];
  for (const entry of entries) {
    if (!isLegacyRunEntry(entry) || !RUN_STATUSES.has(entry.status)) {
      invalid += 1;
      continue;
    }
    const events = eventsForLegacyRun(entry, workspaceKey, now);
    if (!events) {
      invalid += 1;
      continue;
    }
    candidates.push({ run: entry, events });
  }

  const seen = new Set<string>();
  const events: NewRunEvent[] = [];
  for (const candidate of sortLegacyRunsForImport(candidates)) {
    const id = candidate.run.id;
    if (seen.has(id)) {
      invalid += 1;
      continue;
    }
    seen.add(id);
    if (store.hasRun(id)) {
      const existing = store.getRun(id);
      if (existing && existing.workspaceKey !== workspaceKey) {
        invalid += 1;
        log(`[scheduled-prompts] ${name}: run id ${id} already imported from ${existing.workspaceKey}`);
      }
      continue; // same workspace: an earlier interrupted import already committed it
    }
    events.push(...candidate.events);
  }
  if (invalid) {
    log(`[scheduled-prompts] ${name}: ${invalid} run entries could not be imported (kept in ${stem}.v1.json.bak)`);
  }
  return events;
}

async function rewriteLedger(
  store: RunStore,
  raw: Record<string, unknown>,
  name: string,
  filePath: string,
  targetPath: string,
  workspaceKey: string
): Promise<void> {
  const workspacePath = normalizeWorkspacePath(raw.workspacePath as string);
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const taskIds = tasks.filter(isObject).map((task) => String(task.id));
  const summaries = store.taskRunSummaries(workspaceKey, taskIds);

  const v2: Record<string, unknown> = {
    ...raw,
    version: STORAGE_VERSION,
    workspaceKey,
    workspacePath,
    tasks: tasks.map((task) => (isObject(task) ? migrateTask(task, workspaceKey, workspacePath, summaries) : task))
  };
  delete v2.runs;
  if (targetPath !== filePath) {
    v2.migratedFrom = name;
  }

  await writeFile(`${targetPath}.tmp`, `${JSON.stringify(v2, null, 2)}\n`, "utf8");
  await rename(`${targetPath}.tmp`, targetPath);
  if (targetPath !== filePath) {
    await unlink(filePath);
  }
}

function migrateTask(
  task: Record<string, unknown>,
  workspaceKey: string,
  workspacePath: string,
  summaries: Map<string, TaskRunSummary>
): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...task, workspaceKey, workspacePath, lastRunStatus: null };
  delete migrated.legacyLastRunStatus;
  const hasRuns = Boolean(summaries.get(String(task.id))?.latest);
  const stored = task.lastRunStatus;
  if (!hasRuns && typeof stored === "string" && RUN_STATUSES.has(stored)) {
    migrated.legacyLastRunStatus = stored === "running" ? "failed" : stored;
  }
  return migrated;
}
```

- [ ] **Step 4: Storage and model changes**

In `src/shared/model.ts`, add `migratedFrom?: string;` to `WorkspaceLedger`.

In `src/server/storage.ts`:

```ts
export const FROZEN_WORKSPACE_WARNING =
  "Run history import failed; it will be retried at the next start. See the plugin log.";

let frozenWorkspaceKeys: ReadonlySet<string> = new Set();

export function setFrozenWorkspaceKeys(keys: ReadonlySet<string>): void {
  frozenWorkspaceKeys = new Set(keys);
}
```

In `coerceLedgerShape`, add this to the returned ledger object:

```ts
      ...(typeof record.migratedFrom === "string" ? { migratedFrom: record.migratedFrom } : {}),
```

In `inspectLedgerFile`, after `coerceLedgerShape` returns, compute

```ts
    const frozen = frozenWorkspaceKeys.has(workspaceKeyFromPath(ledger.workspacePath));
```

Then make the warning list and status:

```ts
    const warningParts = [
      warning,
      workspaceReadable ? null : "Workspace path is unavailable.",
      frozen ? FROZEN_WORKSPACE_WARNING : null
    ].filter((value): value is string => Boolean(value));
```

and

```ts
      status: frozen ? "unavailable" : warningParts.length ? (workspaceReadable ? "partial" : "unavailable") : "available",
```

- [ ] **Step 5: Scheduler gates**

In `src/server/scheduler.ts`:
1. Change the constructor to:

```ts
  constructor(
    private readonly executionAdapter: LocalExecutionAdapter,
    private readonly runStore: RunStore,
    private readonly frozenKeys: ReadonlySet<string> = new Set()
  ) {}

  private assertNotFrozen(workspacePath: string): void {
    if (this.frozenKeys.has(workspaceKeyFromPath(workspacePath))) {
      throw new HttpError(409, "Run history import pending");
    }
  }
```

2. Make `this.assertNotFrozen(workspacePath);` the first statement of `mutateLedger`, `createManualRun` and `retryRun`.
3. In `tickWithoutDispatcher`, inside the loop and before `try`, add:

```ts
      if (this.frozenKeys.has(workspaceKey)) {
        continue;
      }
```

`createTask` calls `validateRecurrenceDefinition` before `mutateLedger`; that is fine, because the 409 still comes before any write.

- [ ] **Step 6: Run the suite and the type check**

Run: `npx vitest run tests/unit/migrate-runs.test.ts tests/integration/frozen-workspace.test.ts && npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "feat(003): import v0.2.0 run history and freeze workspaces whose import failed"
```

---

### Task 11: Startup order and wiring

**Files:**
- Create: `src/server/startup.ts`
- Replace: `src/server.ts`
- Test: `tests/integration/startup.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1 and 10, plus `logTickError` from Task 8.
- Produces: `startPluginServer(options?: { tickIntervalMs?: number; now?: () => string }): Promise<{ port: number; scheduler: SchedulerService; runStore: RunStore; stop(): Promise<void> }>`.
  - The order is the design's §2 "Wiring and startup" steps 3–7.
  - Steps 1–2 (version guard and warning filter) stay in `server.ts`. They run before `startup.ts` is imported, so `node:sqlite` is never loaded on an unsupported Node.

- [ ] **Step 1: Write the failing test**

`tests/integration/startup.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/server/run-store.js";
import { startPluginServer } from "../../src/server/startup.js";
import { setFrozenWorkspaceKeys } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

describe("startPluginServer", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-startup-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    setFrozenWorkspaceKeys(new Set());
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  // Review Focus 5: plugin killed mid-run
  it("closes a run interrupted by a previous process, without writing the ledger", async () => {
    const workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    const key = workspaceKeyFromPath(workspacePath);
    const ledgerFile = path.join(dataDir, `${key}.json`);
    await writeFile(
      ledgerFile,
      JSON.stringify({ version: 2, workspaceKey: key, workspacePath, tasks: [], executionProfile: null, updatedAt: "2026-04-01T00:00:00.000Z" }),
      "utf8"
    );
    const before = await readFile(ledgerFile, "utf8");

    const previous = new RunStore(path.join(dataDir, "runs.db"));
    previous.appendEvent({
      runId: "live",
      workspaceKey: key,
      taskId: "t1",
      occurrenceKey: "t1:x",
      scheduledFor: "2026-04-27T07:00:00.000Z",
      type: "started",
      at: "2026-04-27T07:00:01.000Z",
      source: "scheduler",
      summary: "Command started."
    });
    previous.close();

    const handle = await startPluginServer({ tickIntervalMs: 3_600_000, now: () => "2026-10-31T00:00:00.000Z" });
    try {
      expect(handle.runStore.getRun("live")).toMatchObject({ status: "failed", outcomeSummary: "Plugin server restarted while this run was in progress." });
      expect(handle.runStore.listEvents("live").at(-1)?.source).toBe("recovery");
      const response = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(response.status).toBe(200);
      expect(await readFile(ledgerFile, "utf8")).toBe(before);
    } finally {
      await handle.stop();
    }
  });

  it("imports v0.2.0 runs at startup before serving", async () => {
    const workspacePath = path.join(tempHome, "legacy");
    await mkdir(workspacePath, { recursive: true });
    const key = workspaceKeyFromPath(workspacePath);
    await writeFile(
      path.join(dataDir, `${key}.json`),
      JSON.stringify({
        version: 1,
        workspaceKey: key,
        workspacePath,
        tasks: [],
        runs: [
          {
            id: "old",
            occurrenceKey: "t:x",
            taskId: "t",
            workspaceKey: key,
            scheduledFor: "2026-04-27T07:00:00.000Z",
            startedAt: null,
            finishedAt: "2026-04-27T07:02:00.000Z",
            status: "missed",
            outcomeSummary: "late",
            failureReason: "late",
            retryOfRunId: null,
            executionRequest: null
          }
        ],
        executionProfile: null,
        updatedAt: "2026-04-01T00:00:00.000Z"
      }),
      "utf8"
    );
    const handle = await startPluginServer({ tickIntervalMs: 3_600_000 });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/v1/runs?workspacePath=${encodeURIComponent(workspacePath)}`);
      expect((await response.json()).runs.map((run: { id: string }) => run.id)).toEqual(["old"]);
    } finally {
      await handle.stop();
    }
  });

  it("fails with the database path when runs.db cannot be opened", async () => {
    await mkdir(path.join(dataDir, "runs.db"));
    await expect(startPluginServer({ tickIntervalMs: 3_600_000 })).rejects.toThrow(path.join(dataDir, "runs.db"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/startup.test.ts`
Expected: FAIL with `Failed to load url ../../src/server/startup.js`.

- [ ] **Step 3: Implement**

`src/server/startup.ts`:

```ts
import type http from "node:http";
import path from "node:path";
import { LocalExecutionAdapter } from "./execution-adapter.js";
import { startHttpServer } from "./http.js";
import { migrateLedgerRuns } from "./migrate-runs.js";
import type { RunStore } from "./run-store.js";
import { logTickError, SchedulerService } from "./scheduler.js";
import { ensureLedgerDataDir, ledgerDataRoot, setFrozenWorkspaceKeys } from "./storage.js";

export interface PluginServerHandle {
  port: number;
  scheduler: SchedulerService;
  runStore: RunStore;
  stop(): Promise<void>;
}

export async function startPluginServer(
  options: { tickIntervalMs?: number; now?: () => string } = {}
): Promise<PluginServerHandle> {
  const now = options.now ?? (() => new Date().toISOString());
  await ensureLedgerDataDir();
  const dbPath = path.join(ledgerDataRoot(), "runs.db");

  let runStore: RunStore;
  try {
    const { RunStore } = await import("./run-store.js");
    runStore = new RunStore(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open run history database ${dbPath}: ${message}`);
  }

  const frozenKeys = await migrateLedgerRuns(runStore, { now: now() });
  setFrozenWorkspaceKeys(frozenKeys);
  runStore.recoverInterruptedRuns(now());

  const scheduler = new SchedulerService(new LocalExecutionAdapter(), runStore, frozenKeys);
  const server: http.Server = await startHttpServer(scheduler, runStore);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server port");
  }

  const timer = setInterval(() => {
    scheduler.tickWithoutDispatcher().catch((error) => logTickError(error));
  }, options.tickIntervalMs ?? 30_000);
  timer.unref();

  return {
    port: address.port,
    scheduler,
    runStore,
    async stop() {
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runStore.close();
    }
  };
}
```

Replace `src/server.ts`:

```ts
import { assertSupportedNode } from "./server/node-version.js";
import { installWarningFilter } from "./server/warnings.js";

async function main(): Promise<void> {
  assertSupportedNode(process.versions.node);
  installWarningFilter();
  const { startPluginServer } = await import("./server/startup.js");
  const handle = await startPluginServer();
  process.stdout.write(`${JSON.stringify({ ready: true, port: handle.port })}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run the suite, the type check and the build**

Run: `npx vitest run tests/integration/startup.test.ts && npm test && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: all pass, and `dist/server.js`, `dist/server/startup.js` and `dist/server/run-store.js` exist.

Smoke check with a real process:

```bash
HOME=$(mktemp -d) node dist/server.js & sleep 1; kill %1
```

Expected stdout: `{"ready":true,"port":<n>}`, with no `ExperimentalWarning` line on stderr.

- [ ] **Step 5: Commit**

```bash
git add src/server/startup.ts src/server.ts tests/integration/startup.test.ts
git commit -m "feat(003): startup order: guard, filter, open store, migrate, recover, serve"
```

---

### Task 12: Client paging, task filter, list generation and History toggle

**Files:**
- Modify: `src/client/api.ts` (`listRuns`, `listRunEvents`)
- Modify: `src/client/state.ts` (new fields)
- Modify: `src/client/app.ts` (reload, generation, Load older, filter, Run Now/Retry, `loadFromContext`)
- Modify: `src/client/views/run-history.ts` (filter select, Load older, History toggle)
- Test: `tests/integration/app-runs.test.ts` (new)
- Test: `tests/integration/run-history.test.ts` (new cases)
- Test: update the mock RPCs in `tests/integration/app-reconcile.test.ts` and `tests/integration/global-dashboard.test.ts`

**Interfaces:**
- Consumes: Task 9 `ListRunsResponse`, `RunEventsResponse` and the endpoints.
- Produces:
  - `PluginRpcClient.listRuns(workspacePath: string, options?: { limit?: number; before?: string | null; taskId?: string | null }): Promise<ListRunsResponse>`
  - `PluginRpcClient.listRunEvents(runId: string, workspacePath: string): Promise<RunEventsResponse>`
  - `AppState` gains `runsNextCursor: string | null`, `runsTaskFilter: string | null`, `runsGeneration: number`, `runsLoadingOlder: boolean` and `runsError: string | null`.
  - `renderRunHistory(runs, handlers, options?)`:
    - `RunHistoryHandlers` gains `onLoadOlder?()`, `onSelectTask?(taskId: string | null)` and `onLoadEvents?(runId): Promise<RunEventsResponse>`.
    - `RunHistoryOptions = { tasks?: Array<{ id: string; name: string }>; taskFilter?: string | null; hasMore?: boolean; loadingOlder?: boolean; error?: string | null }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/run-history.test.ts`:

```ts
describe("run history paging and events", () => {
  const run = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    occurrenceKey: `task-1:${id}`,
    taskId: "task-1",
    workspaceKey: "ws",
    scheduledFor: "2026-04-27T07:00:00.000Z",
    sequence: 1,
    startedAt: "2026-04-27T07:00:01.000Z",
    finishedAt: "2026-04-27T07:00:02.000Z",
    status: "succeeded" as const,
    outcomeSummary: "ok",
    failureReason: null,
    retryOfRunId: null,
    executionRequest: null,
    ...extra
  });

  it("renders the task filter and Load older, and disables Load older while loading", () => {
    const onSelectTask = vi.fn();
    const onLoadOlder = vi.fn();
    const section = renderRunHistory([run("r1")], { onRetry: vi.fn(), onSelectTask, onLoadOlder }, {
      tasks: [{ id: "task-1", name: "Daily" }, { id: "task-2", name: "Weekly" }],
      taskFilter: null,
      hasMore: true
    });
    const select = section.querySelector<HTMLSelectElement>('select[name="runsTaskFilter"]')!;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["All tasks", "Daily", "Weekly"]);
    select.value = "task-2";
    select.dispatchEvent(new Event("change"));
    expect(onSelectTask).toHaveBeenCalledWith("task-2");

    section.querySelector<HTMLButtonElement>('button[data-action="load-older"]')!.click();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    const loading = renderRunHistory([run("r1")], { onRetry: vi.fn(), onLoadOlder }, { hasMore: true, loadingOlder: true });
    expect(loading.querySelector<HTMLButtonElement>('button[data-action="load-older"]')!.disabled).toBe(true);
    expect(renderRunHistory([run("r1")], { onRetry: vi.fn() }, { hasMore: false }).querySelector('[data-action="load-older"]')).toBeNull();
  });

  it("loads events on every History open and shows the retryOf line", async () => {
    const onLoadEvents = vi.fn().mockResolvedValue({
      events: [
        { seq: 1, runId: "r2", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "2026-04-27T07:00:00.000Z", type: "started", at: "2026-04-27T07:00:01.000Z", source: "retry", summary: "Command started." },
        { seq: 2, runId: "r2", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "2026-04-27T07:00:00.000Z", type: "failed", at: "2026-04-27T07:00:02.000Z", source: "recovery", summary: "x" }
      ],
      retryOf: { id: "r1", scheduledFor: "2026-04-26T07:00:00.000Z" }
    });
    const section = renderRunHistory([run("r2", { retryOfRunId: "r1" })], { onRetry: vi.fn(), onLoadEvents });
    const toggle = section.querySelector<HTMLButtonElement>('button[data-action="history"]')!;
    toggle.click();
    await vi.waitFor(() => expect(section.textContent).toContain("Retry of run scheduled for"));
    expect(section.textContent).toContain("started");
    expect(section.textContent).toContain("recovery");
    toggle.click();
    toggle.click();
    await vi.waitFor(() => expect(onLoadEvents).toHaveBeenCalledTimes(2));
  });

  it("shows only the response of the most recent History open", async () => {
    let resolveFirst!: (value: unknown) => void;
    const onLoadEvents = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ events: [{ seq: 9, runId: "r1", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "x", type: "succeeded", at: "2026-04-27T07:00:02.000Z", source: "scheduler", summary: "fresh" }], retryOf: null });
    const section = renderRunHistory([run("r1")], { onRetry: vi.fn(), onLoadEvents });
    const toggle = section.querySelector<HTMLButtonElement>('button[data-action="history"]')!;
    toggle.click();
    toggle.click();
    toggle.click();
    await vi.waitFor(() => expect(section.textContent).toContain("succeeded"));
    resolveFirst({ events: [{ seq: 1, runId: "r1", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "x", type: "started", at: "2026-04-27T07:00:01.000Z", source: "scheduler", summary: "stale" }], retryOf: null });
    await Promise.resolve();
    expect(section.querySelectorAll(".wsp-run-events li")).toHaveLength(1);
  });
});
```

Create `tests/integration/app-runs.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { WorkspaceScheduledPromptsApp } from "../../src/client/app.js";
import type { PluginAPI } from "../../src/types.js";

type Call = { method: string; path: string };

function makeRun(id: number) {
  return {
    id: `r${id}`,
    occurrenceKey: `t:${id}`,
    taskId: "t1",
    workspaceKey: "ws",
    scheduledFor: "2026-04-27T07:00:00.000Z",
    sequence: id,
    startedAt: null,
    finishedAt: "2026-04-27T07:00:00.000Z",
    status: "missed",
    outcomeSummary: `run ${id}`,
    failureReason: "late",
    retryOfRunId: null,
    executionRequest: null
  };
}

function page(fromSequence: number, count: number) {
  const runs = Array.from({ length: count }, (_, index) => makeRun(fromSequence - index));
  const last = fromSequence - count + 1;
  return { runs, nextCursor: last > 1 ? String(last) : null };
}

function createHarness(handlers: Partial<Record<string, (path: string) => Promise<unknown>>> = {}) {
  const calls: Call[] = [];
  const api: PluginAPI = {
    context: { theme: "light", project: { name: "project", path: "/tmp/project" }, session: null },
    onContextChange: () => () => undefined,
    rpc: async (method, path) => {
      calls.push({ method, path });
      for (const [prefix, handler] of Object.entries(handlers)) {
        if (`${method} ${path}`.startsWith(prefix)) {
          return handler!(path);
        }
      }
      if (method === "GET" && path.startsWith("/v1/workspace-state")) {
        return {
          capability: { status: "needs_config", message: "Configure." },
          executionProfile: null,
          tasks: [],
          runs: [makeRun(999)],
          runsNextCursor: "999"
        };
      }
      if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
        return { generatedAt: "x", summary: { totalJobs: 0, activeJobs: 0, pausedJobs: 0, problemJobs: 0, workspacesTotal: 0, workspacesDegraded: 0 }, jobs: [], workspaces: [], partialData: false, warnings: [] };
      }
      if (method === "GET" && path.startsWith("/v1/runs?")) {
        const params = new URLSearchParams(path.split("?")[1]);
        const before = params.get("before");
        const limit = Number(params.get("limit") ?? "100");
        return page(before ? Number(before) - 1 : 1000, limit);
      }
      throw new Error(`Unexpected RPC: ${method} ${path}`);
    }
  };
  const container = document.createElement("div");
  const app = new WorkspaceScheduledPromptsApp(container, api);
  return { app, container, calls, state: () => (app as any).state.snapshot };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

describe("app run list", () => {
  it("loads runs from GET /v1/runs, ignoring the state response's runs", async () => {
    const { app, state, calls } = createHarness();
    await app.mount();
    expect(state().runs[0].id).toBe("r1000");
    expect(state().runsNextCursor).toBe("901");
    expect(calls.some((call) => call.path.startsWith("/v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100"))).toBe(true);
    app.unmount();
  });

  it("reloads as many runs as are shown (3 pages -> 300) after an action", async () => {
    const { app, state, calls } = createHarness({ "POST /v1/tasks/t1/actions/run-now": async () => ({ run: makeRun(5000) }) });
    await app.mount();
    await (app as any).loadOlderRuns();
    await (app as any).loadOlderRuns();
    expect(state().runs).toHaveLength(300);
    await (app as any).reconcileWorkspaceState("/tmp/project", "done", null);
    expect(calls.filter((call) => call.path.includes("limit=300"))).toHaveLength(1);
    expect(state().runs).toHaveLength(300);
    app.unmount();
  });

  it("drops a Load older response once a reload, filter change or workspace switch was sent after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, state } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100&before=": async (path) => {
        await gate;
        const before = Number(new URLSearchParams(path.split("?")[1]).get("before"));
        return page(before - 1, 100);
      }
    });
    await app.mount();
    const older = (app as any).loadOlderRuns();
    await (app as any).setRunsTaskFilter("t1");
    release();
    await older;
    await flush();
    expect(state().runsTaskFilter).toBe("t1");
    expect(state().runs).toHaveLength(100);
    app.unmount();
  });

  it("applies only the later-sent of two overlapping reloads", async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    const { app, state } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=": async () => {
        calls += 1;
        if (calls === 2) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return { runs: [makeRun(1)], nextCursor: null };
        }
        return page(1000, 100);
      }
    });
    await app.mount();
    const first = (app as any).reloadRuns("/tmp/project", 100);
    await flush();
    await (app as any).reloadRuns("/tmp/project", 100);
    releaseFirst();
    await first;
    expect(state().runs).toHaveLength(100);
    app.unmount();
  });

  // Review Focus 4: double-click on Load older
  it("ignores a second Load older click while the first is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, state, calls } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100&before=": async (path) => {
        await gate;
        const before = Number(new URLSearchParams(path.split("?")[1]).get("before"));
        return page(before - 1, 100);
      }
    });
    await app.mount();
    const a = (app as any).loadOlderRuns();
    const b = (app as any).loadOlderRuns();
    release();
    await Promise.all([a, b]);
    expect(calls.filter((call) => call.path.includes("before="))).toHaveLength(1);
    const ids = state().runs.map((run: { id: string }) => run.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(200);
    app.unmount();
  });

  it("does not prepend the Run Now result; the reload brings it in", async () => {
    const { app, state, container } = createHarness({ "POST /v1/tasks/t1/actions/run-now": async () => ({ run: makeRun(424242) }) });
    await app.mount();
    const before = state().runs.length;
    (app as any).state.patch({ tasks: [{ id: "t1", workspaceKey: "ws", workspacePath: "/tmp/project", name: "T", prompt: "P", recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" }, recurrenceSummary: "Daily", enabled: true, nextRunAt: null, lastRunStatus: null, createdAt: "x", updatedAt: "x" }] });
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Run Now")?.click();
    await flush();
    expect(state().runs.some((run: { id: string }) => run.id === "r424242")).toBe(false);
    expect(state().runs).toHaveLength(before);
    app.unmount();
  });
});
```

In `tests/integration/app-reconcile.test.ts` and in every mock RPC in `tests/integration/global-dashboard.test.ts` that has a `/v1/workspace-state` branch, insert this immediately before the final `throw new Error(\`Unexpected RPC…`):

```ts
      if (method === "GET" && path.startsWith("/v1/runs?")) {
        return { runs: [], nextCursor: null };
      }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/app-runs.test.ts tests/integration/run-history.test.ts`
Expected: FAIL. `loadOlderRuns` is not a function, no `runsTaskFilter` select is rendered, and the state's runs come from the workspace-state response.

- [ ] **Step 3: Implement the API and state**

In `src/client/api.ts`, add `ListRunsResponse` and `RunEventsResponse` to the contracts type import and add:

```ts
  listRuns(
    workspacePath: string,
    options: { limit?: number; before?: string | null; taskId?: string | null } = {}
  ): Promise<ListRunsResponse> {
    const params = new URLSearchParams({ workspacePath });
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.before) {
      params.set("before", options.before);
    }
    if (options.taskId) {
      params.set("taskId", options.taskId);
    }
    return this.api.rpc("GET", `/v1/runs?${params.toString()}`);
  }

  listRunEvents(runId: string, workspacePath: string): Promise<RunEventsResponse> {
    return this.api.rpc(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/events?workspacePath=${encodeURIComponent(workspacePath)}`
    );
  }
```

In `src/client/state.ts`, add these to `AppState`:

```ts
  runsNextCursor: string | null;
  runsTaskFilter: string | null;
  runsGeneration: number;
  runsLoadingOlder: boolean;
  runsError: string | null;
```

and these to the initial state:

```ts
    runsNextCursor: null,
    runsTaskFilter: null,
    runsGeneration: 0,
    runsLoadingOlder: false,
    runsError: null,
```

- [ ] **Step 4: Implement the view (`src/client/views/run-history.ts`)**

Replace the file:

```ts
import type { RunEventsResponse } from "../../shared/contracts.js";
import type { ScheduledRun } from "../../shared/model.js";

export interface RunHistoryHandlers {
  onRetry(runId: string): void;
  onLoadOlder?(): void;
  onSelectTask?(taskId: string | null): void;
  onLoadEvents?(runId: string): Promise<RunEventsResponse>;
}

export interface RunHistoryOptions {
  tasks?: Array<{ id: string; name: string }>;
  taskFilter?: string | null;
  hasMore?: boolean;
  loadingOlder?: boolean;
  error?: string | null;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function renderTaskFilter(options: RunHistoryOptions, handlers: RunHistoryHandlers): HTMLElement | null {
  if (!options.tasks?.length || !handlers.onSelectTask) {
    return null;
  }
  const select = document.createElement("select");
  select.name = "runsTaskFilter";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All tasks";
  select.append(all);
  for (const task of options.tasks) {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = task.name;
    select.append(option);
  }
  select.value = options.taskFilter ?? "";
  select.addEventListener("change", () => handlers.onSelectTask?.(select.value || null));
  return select;
}

function attachHistoryToggle(item: HTMLElement, run: ScheduledRun, handlers: RunHistoryHandlers): void {
  if (!handlers.onLoadEvents) {
    return;
  }
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.action = "history";
  toggle.textContent = "History";
  const panel = document.createElement("div");
  panel.className = "wsp-run-history-panel";
  panel.hidden = true;
  let openToken = 0;

  toggle.addEventListener("click", () => {
    if (!panel.hidden) {
      panel.hidden = true;
      openToken += 1;
      return;
    }
    panel.hidden = false;
    panel.textContent = "Loading…";
    const token = ++openToken;
    void handlers.onLoadEvents!(run.id)
      .then((response) => {
        if (token !== openToken) {
          return;
        }
        panel.textContent = "";
        if (response.retryOf) {
          const retryLine = document.createElement("p");
          retryLine.textContent = `Retry of run scheduled for ${localTime(response.retryOf.scheduledFor)}`;
          panel.append(retryLine);
        }
        const list = document.createElement("ol");
        list.className = "wsp-run-events";
        for (const event of response.events) {
          const entry = document.createElement("li");
          entry.textContent = `${event.type} · ${localTime(event.at)} · ${event.source}`;
          list.append(entry);
        }
        panel.append(list);
      })
      .catch((error) => {
        if (token === openToken) {
          panel.textContent = error instanceof Error ? error.message : "Failed to load run history.";
        }
      });
  });

  item.append(toggle, panel);
}

export function renderRunHistory(
  runs: ScheduledRun[],
  handlers: RunHistoryHandlers,
  options: RunHistoryOptions = {}
): HTMLElement {
  const section = document.createElement("section");
  section.className = "run-history";
  section.innerHTML = "<h2>Recent Runs</h2>";

  const filter = renderTaskFilter(options, handlers);
  if (filter) {
    section.append(filter);
  }

  if (options.error) {
    const error = document.createElement("p");
    error.className = "wsp-feedback";
    error.setAttribute("role", "alert");
    error.textContent = options.error;
    section.append(error);
  }

  if (!runs.length) {
    const empty = document.createElement("p");
    empty.textContent = "No runs recorded yet.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  for (const run of runs) {
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "wsp-run-head";

    const title = document.createElement("strong");
    title.textContent = titleCase(run.status);
    head.append(title);

    const chip = document.createElement("span");
    chip.className = "wsp-status-chip";
    chip.textContent = titleCase(run.status);
    head.append(chip);

    const meta = document.createElement("div");
    meta.className = "wsp-run-meta";

    const outcome = document.createElement("span");
    outcome.textContent = run.outcomeSummary;
    meta.append(outcome);

    const scheduled = document.createElement("span");
    scheduled.textContent = `Scheduled for: ${run.scheduledFor}`;
    meta.append(scheduled);

    if (run.failureReason) {
      const failure = document.createElement("span");
      failure.textContent = `Failure: ${run.failureReason}`;
      meta.append(failure);
    }

    item.append(head, meta);

    if (run.status === "failed" || run.status === "missed") {
      const actions = document.createElement("div");
      actions.className = "wsp-inline-actions";
      const retry = document.createElement("button");
      retry.textContent = "Retry";
      retry.addEventListener("click", () => handlers.onRetry(run.id));
      actions.append(retry);
      item.append(actions);
    }

    attachHistoryToggle(item, run, handlers);
    list.append(item);
  }
  section.append(list);

  if (options.hasMore && handlers.onLoadOlder) {
    const more = document.createElement("button");
    more.type = "button";
    more.dataset.action = "load-older";
    more.textContent = options.loadingOlder ? "Loading…" : "Load older runs";
    more.disabled = Boolean(options.loadingOlder);
    more.addEventListener("click", () => handlers.onLoadOlder?.());
    section.append(more);
  }
  return section;
}
```

The existing tests click `section.querySelector("button")` to reach Retry. That still works, because Retry is appended before the History toggle in each item.

- [ ] **Step 5: Implement the app changes (`src/client/app.ts`)**

1. Add these methods to `WorkspaceScheduledPromptsApp`:

```ts
  private refreshLimit(): number {
    return Math.min(500, Math.max(100, this.state.snapshot.runs.length));
  }

  /** Every list request records the generation it was sent under; stale responses are dropped. */
  private async reloadRuns(workspacePath: string, limit: number): Promise<void> {
    const generation = this.state.snapshot.runsGeneration + 1;
    this.state.patch({ runsGeneration: generation });
    const taskId = this.state.snapshot.runsTaskFilter;
    try {
      const page = await this.rpc.listRuns(workspacePath, { limit, taskId });
      const current = this.state.snapshot;
      if (current.runsGeneration !== generation || current.workspacePath !== workspacePath) {
        return;
      }
      this.state.patch({ runs: page.runs, runsNextCursor: page.nextCursor, runsError: null });
    } catch (error) {
      if (this.state.snapshot.runsGeneration === generation) {
        this.state.patch({ runsError: error instanceof Error ? error.message : "Failed to load runs." });
      }
    }
  }

  private async loadOlderRuns(): Promise<void> {
    const { workspacePath, runsNextCursor: before, runsGeneration: generation, runsTaskFilter: taskId, runsLoadingOlder } =
      this.state.snapshot;
    if (!workspacePath || !before || runsLoadingOlder) {
      return;
    }
    this.state.patch({ runsLoadingOlder: true });
    try {
      const page = await this.rpc.listRuns(workspacePath, { before, limit: 100, taskId });
      const current = this.state.snapshot;
      if (current.runsGeneration !== generation || current.runsNextCursor !== before) {
        return;
      }
      this.state.patch({ runs: [...current.runs, ...page.runs], runsNextCursor: page.nextCursor, runsError: null });
    } catch (error) {
      if (this.state.snapshot.runsGeneration === generation) {
        this.state.patch({ runsError: error instanceof Error ? error.message : "Failed to load older runs." });
      }
    } finally {
      this.state.patch({ runsLoadingOlder: false });
    }
  }

  private async setRunsTaskFilter(taskId: string | null): Promise<void> {
    const workspacePath = this.state.snapshot.workspacePath;
    if (!workspacePath) {
      return;
    }
    this.state.patch({ runsTaskFilter: taskId, runs: [], runsNextCursor: null });
    await this.reloadRuns(workspacePath, 100);
  }
```

2. Change `loadFromContext` to `async loadFromContext(workspacePath: string | null, mode: "switch" | "refresh" = "switch"): Promise<boolean>`:
   - In the `state.replace({...})` branch for a null workspace, add `runsNextCursor: null, runsTaskFilter: null, runsGeneration: this.state.snapshot.runsGeneration + 1, runsLoadingOlder: false, runsError: null,`.
   - In the success `patch` (lines 664–674), remove `runs: payload.runs,`.
   - After that patch and before `return true;`, add:

```ts
      if (mode === "switch") {
        this.state.patch({ runsTaskFilter: null });
      }
      await this.reloadRuns(workspacePath, mode === "switch" ? 100 : this.refreshLimit());
```

3. In `reconcileWorkspaceState` (line 697), call `this.loadFromContext(workspacePath, "refresh")`. In `dispatchGlobalAction` (line 592), call `this.loadFromContext(response.task.workspacePath, "refresh")`.
4. In the `onRunNow` handler (lines 975–990) and the `onRetry` handler (lines 997–1013), delete the `this.state.patch({ runs: [response.run, …], error: null });` statements. Each `.then` now only returns the `reconcileWorkspaceState(…)` call. For Retry, `.then(() => this.reconcileWorkspaceState(workspacePath, "Retry finished.", null))`; for Run Now, `.then(() => this.reconcileWorkspaceState(workspacePath, "Manual run finished.", taskId))`.
5. Replace the `renderRunHistory(snapshot.runs, { onRetry … })` call with:

```ts
    right.append(renderRunHistory(snapshot.runs, {
      onRetry: (runId) => {
        const workspacePath = this.state.snapshot.workspacePath;
        if (!workspacePath) {
          return;
        }
        void this.rpc.retryRun(runId, workspacePath)
          .then(() => this.reconcileWorkspaceState(workspacePath, "Retry finished.", null))
          .catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to retry run.",
              successMessage: null
            });
          });
      },
      onLoadOlder: () => {
        void this.loadOlderRuns();
      },
      onSelectTask: (taskId) => {
        void this.setRunsTaskFilter(taskId);
      },
      onLoadEvents: (runId) => {
        const workspacePath = this.state.snapshot.workspacePath;
        if (!workspacePath) {
          return Promise.reject(new Error("No workspace selected."));
        }
        return this.rpc.listRunEvents(runId, workspacePath);
      }
    }, {
      tasks: snapshot.tasks.map((task) => ({ id: task.id, name: task.name })),
      taskFilter: snapshot.runsTaskFilter,
      hasMore: Boolean(snapshot.runsNextCursor),
      loadingOlder: snapshot.runsLoadingOlder,
      error: snapshot.runsError
    }));
```

- [ ] **Step 6: Run the suite, the type check and the build**

Run: `npx vitest run tests/integration/app-runs.test.ts tests/integration/run-history.test.ts && npm test && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: all pass; `dist/index.js` builds.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "feat(003): run list paging, task filter, stale-response guard and History toggle"
```

---

### Task 13: Docs, version 0.3.0 and manual verification

**Files:**
- Modify: `README.md` (Requirements, Execution Timing, Storage, Troubleshooting)
- Modify: `CHANGELOG.md` (new `## [0.3.0] - <release date>` entry)
- Modify: `package.json` and `manifest.json` (`"version": "0.3.0"`)

**Interfaces:**
- Consumes: everything above.
- Produces: release-ready docs only; no code changes.

- [ ] **Step 1: Update `README.md`**

In **Requirements**, replace `- Node.js 18+` with:

```markdown
- Node.js 22.13+ (or 23.4+), for the built-in `node:sqlite` run history
```

Replace the **Execution Timing** bullets with:

```markdown
- Automatic runs are attempted only for occurrences that are still within the scheduler grace window (90 seconds).
- If the plugin or host was unavailable long enough for an occurrence to become stale, that occurrence is recorded as `missed`.
- Recurring schedules record each missed slot in history, then continue from the next future occurrence without catch-up replay.
- Each occurrence runs at most once, even if a run is still in progress when the next scheduler tick fires.
- Editing a task's name or prompt never skips a due run; changing its schedule or resuming it recomputes the next run from now.
- A run that was in progress when the plugin stopped is marked `failed` ("Plugin server restarted while this run was in progress.") at the next start.
```

Replace the **Storage** section body with:

````markdown
Data is stored locally under:

```text
~/.cloudcli-workspace-scheduled-prompts/
```

- `<workspace>.json`: one per workspace, holding its schedules and execution profile.
- `runs.db`: the complete run history for all workspaces, as an append-only SQLite event log. Nothing is ever deleted from it, so expect several KB per run; an every-minute schedule adds roughly 2–3 GB per year.
- `<workspace>.v1.json.bak`: a copy of each v0.2.0 ledger, kept when its run history was imported into `runs.db`.

**Rollback to v0.2.0:** stop CloudCLI, check out v0.2.0 in the plugin folder, rename each `<stem>.v1.json.bak` back to `<stem>.json`, and delete any `<key>.json` whose `migratedFrom` names it. Task edits and runs made after the upgrade are not visible to v0.2.0; the runs remain in `runs.db`.
````

Add to **Troubleshooting**:

```markdown
### A Workspace Shows "Run history import failed"

The workspace's v0.2.0 run history could not be imported into `runs.db` (see the plugin log). The workspace is read-only and not scheduled until the import succeeds; it is retried on every plugin start. No history is lost: the original ledger and its `.v1.json.bak` are kept.
```

In **Known Limits**, add `- Run history is never pruned` after `- No cron syntax`.

- [ ] **Step 2: Update `CHANGELOG.md` and the versions**

Insert this above `## [0.1.0]`, with `<release date>` set to the day the PR is opened:

```markdown
## [0.3.0] - <release date>

### Added

- Complete run history in an append-only SQLite event log (`runs.db`), with "Load older runs" paging, a per-task filter and a per-run event History.
- One-time import of v0.2.0 run history at startup, with a `.v1.json.bak` backup per workspace.
- Runs interrupted by a plugin restart are closed as failed with a recovery event.

### Fixed

- A task paused, edited or deleted while its run executed was overwritten when the run finished.
- Two overlapping scheduler ticks could start the same occurrence twice.
- Opening a workspace between a run's due time and the next tick silently skipped that run.
- Editing a task's prompt inside the due window skipped the due run.
- An error in one workspace stopped the scheduler tick and could crash the plugin server.

### Changed

- Requires Node.js 22.13+ (or 23.4+).
- `GET /v1/runs` without `limit` now returns 100 runs (was 500); page with `before`.
```

Set `"version": "0.3.0"` in both `package.json` and `manifest.json`.

- [ ] **Step 3: Full verification**

Run: `npm ci && npm test && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: everything passes on Node 22.23.

- [ ] **Step 4: Manual verification (design "Done when")**

1. Point the installed plugin at this branch:

```bash
git -C ~/.claude-code-ui/plugins/cloudcli-cron remote set-url origin https://github.com/krugerm/cloudcli-cron.git
git -C ~/.claude-code-ui/plugins/cloudcli-cron fetch origin 003-run-event-log
git -C ~/.claude-code-ui/plugins/cloudcli-cron checkout 003-run-event-log
```

   Then click **Update** in CloudCLI's plugin settings.
2. In a test workspace, create a task with an execution profile of `node -e "setTimeout(()=>console.log('ok'),20000)"`. Click **Run now**, open the run's **History**, and confirm a `started` event.
3. While it runs, restart the plugin from CloudCLI's plugin settings. After restart, confirm the run shows `failed` with "Plugin server restarted while this run was in progress.", that History shows a `recovery` event, and that the task's last status is `failed`.
4. Create more than 100 runs (for example, Run now repeatedly with a fast command). Confirm that **Load older runs** appears, pages without duplicates, and disappears at the end.
5. Start a 20-second run, pause the task while it runs, and confirm that the task is still paused after the run finishes.

Record the results in the PR description.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json manifest.json
git commit -m "docs(003): document run history storage, upgrade and rollback; v0.3.0"
```

---

## Self-review (completed while writing)

- **Spec coverage:**
  - FR-001/002/003: Tasks 3, 4 and 2.
  - FR-004: no pruning anywhere.
  - FR-005: Tasks 4 and 9.
  - FR-006: Task 9.
  - FR-007: Tasks 4 and 11.
  - FR-008: Task 10.
  - FR-009: Task 6 (tasks stay in JSON).
  - FR-010: Task 12.
  - FR-011: Tasks 1 and 11.
  - FR-012: Task 12 (loading, empty and error states in the view).
  - FR-013: Task 7.
  - FR-014: Task 8.
  - FR-015: Task 8.
  - FR-016: Tasks 6, 8 and 9.
  - FR-017: Task 8 (claim, refresh rule, edit rules).
  - FR-018: Tasks 7 and 10.
  - SC-001/002/003: Task 4 performance test.
  - SC-004: Task 10.
  - SC-005: Tasks 4 and 11.
  - SC-006: Task 8 (finishing a run never saves; only the claim saves `nextRunAt`).
- **Placeholder scan:** the forbidden-phrase grep returns nothing.
- **Type consistency:** these names are used identically across tasks:
  - `RunStore.listRuns(workspaceKey, ListRunsOptions)`
  - `taskRunSummaries(workspaceKey, taskIds)`
  - `hasOccurrence(workspaceKey, key)`
  - `SchedulerService(executionAdapter, runStore, frozenKeys?)`
  - `loadWorkspaceState(path, capabilityFor)`
  - `startHttpServer(scheduler, runStore)`
  - `buildGlobalDashboardSnapshot(filter, runStore)`
  - `resolveGlobalTask(key, taskId, runStore)`
  - `readGlobalTaskState(key, taskId, runStore)`
- **Review Focus:**
  - 1 → Task 6 (`legacy-runs.test.ts`, offset timestamps) and Task 10 (trailing slash plus offsets);
  - 2 → Task 8 (delete mid-run);
  - 3 → Task 8 (unknown fields);
  - 4 → Task 12 (double-click);
  - 5 → Task 11 (interrupted run).
