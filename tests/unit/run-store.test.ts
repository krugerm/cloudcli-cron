import * as os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newEvent } from "../helpers/events.js";
import { RunStore } from "../../src/server/run-store.js";

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
