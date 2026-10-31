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
