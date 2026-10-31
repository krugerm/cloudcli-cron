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
