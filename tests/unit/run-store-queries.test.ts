import * as os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newEvent } from "../helpers/events.js";
import { RECOVER_INTERRUPTED_SQL, RunStore } from "../../src/server/run-store.js";
import { RECOVERY_SUMMARY } from "../../src/server/run-fold.js";

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
      store.appendEvent(newEvent({ runId: `r${index}`, type: "missed", scheduledFor: "2026-04-27T07:00:00.000Z" }));
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
      store.appendEvent(newEvent({ runId: `r${index}`, type: "missed", scheduledFor: `2026-04-2${index}T07:00:00.000Z` }));
    }
    const first = store.listRuns("ws-a", { limit: 3 });
    store.appendEvent(newEvent({ runId: "late", type: "missed", scheduledFor: "2026-01-01T07:00:00.000Z" }));
    const second = store.listRuns("ws-a", { limit: 3, before: first.nextCursor });
    expect(second.runs.map((run) => run.id)).toEqual(["r2", "r1", "r0"]);
    expect(store.listRuns("ws-a", { limit: 1 }).runs[0]?.id).toBe("late");
  });

  it("orders a run by its first event, and folds later events in", () => {
    store.appendEvent(newEvent({ runId: "a", type: "started" }));
    store.appendEvent(newEvent({ runId: "b", type: "missed" }));
    store.appendEvent(newEvent({ runId: "a", type: "succeeded" }));
    expect(store.listRuns("ws-a").runs.map((run) => [run.id, run.status])).toEqual([
      ["b", "missed"],
      ["a", "succeeded"]
    ]);
  });

  it("filters by task and by workspace", () => {
    store.appendEvent(newEvent({ runId: "t1", type: "missed" }));
    store.appendEvent(newEvent({ runId: "t2", type: "missed", taskId: "task-2" }));
    store.appendEvent(newEvent({ runId: "other", type: "missed", workspaceKey: "ws-b" }));
    expect(store.listRuns("ws-a", { taskId: "task-2" }).runs.map((run) => run.id)).toEqual(["t2"]);
    expect(store.listRuns("ws-a").runs.map((run) => run.id)).toEqual(["t2", "t1"]);
    expect(store.listRuns("ws-b").runs.map((run) => run.id)).toEqual(["other"]);
  });

  it("clamps limit to 1..500 and defaults to 100", () => {
    for (let index = 0; index < 120; index += 1) {
      store.appendEvent(newEvent({ runId: `r${index}`, type: "missed" }));
    }
    expect(store.listRuns("ws-a").runs).toHaveLength(100);
    expect(store.listRuns("ws-a", { limit: 0 }).runs).toHaveLength(1);
    expect(store.listRuns("ws-a", { limit: 10_000 }).runs).toHaveLength(120);
  });

  it.each(["abc", "0", "-3", "1.5", ""])("rejects cursor %j", (cursor) => {
    expect(() => store.listRuns("ws-a", { before: cursor })).toThrow("invalid cursor");
  });

  it("summarizes latest and latestFinished per task while a run is in progress", () => {
    store.appendEvent(newEvent({ runId: "old", type: "started" }));
    store.appendEvent(newEvent({ runId: "old", type: "failed" }));
    store.appendEvent(newEvent({ runId: "live", type: "started" }));
    store.appendEvent(newEvent({ runId: "copy", type: "missed", workspaceKey: "ws-copy" }));
    const summary = store.taskRunSummaries("ws-a", ["task-1", "task-none"]);
    expect(summary.get("task-1")?.latest?.id).toBe("live");
    expect(summary.get("task-1")?.latestFinished?.id).toBe("old");
    expect(summary.get("task-none")).toEqual({ latest: null, latestFinished: null });
    expect(store.taskRunSummaries("ws-a", ["task-1"]).get("task-1")?.latest?.id).toBe(
      store.listRuns("ws-a", { taskId: "task-1" }).runs[0]?.id
    );
  });

  it("finds latestFinished beyond the first page of five", () => {
    store.appendEvent(newEvent({ runId: "done", type: "missed" }));
    for (let index = 0; index < 7; index += 1) {
      store.appendEvent(newEvent({ runId: `run${index}`, type: "started" }));
    }
    expect(store.taskRunSummaries("ws-a", ["task-1"]).get("task-1")?.latestFinished?.id).toBe("done");
  });

  it("closes only runs whose last event is started", () => {
    store.appendEvent(newEvent({ runId: "live", type: "started", retryOfRunId: "x", occurrenceKey: "task-1:live-key" }));
    store.appendEvent(newEvent({ runId: "done", type: "started" }));
    store.appendEvent(newEvent({ runId: "done", type: "succeeded" }));
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
