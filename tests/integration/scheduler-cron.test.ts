import * as os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalExecutionAdapter, type ExecutionResult } from "../../src/server/execution-adapter.js";
import { MISSED_UNAVAILABLE_SUMMARY } from "../../src/server/run-fold.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";
import type { RecurrenceDefinition } from "../../src/shared/model.js";

const everyMinute: RecurrenceDefinition = { scheduleType: "cron", timezone: "UTC", expression: "* * * * *" };
const daily: RecurrenceDefinition = { scheduleType: "daily", timezone: "UTC", localTime: "09:00" };
const T = "2026-11-01T12:00:00.000Z";
const TICK = "2026-11-01T12:00:10.000Z";
const NOT_READY = "Configure a local execution command to enable automatic prompt runs";

type Claim = { kind: string; nextRunAt: string | null };
type Internals = {
  claimOccurrence(workspacePath: string, taskId: string, scheduledFor: string, tickStartedAt: string): Promise<Claim>;
  runningTasks: Map<string, number>;
};

describe("cron scheduler safeguards", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;
  let store: RunStore;
  let adapter: LocalExecutionAdapter;
  let scheduler: SchedulerService;
  let key: string;
  let gates: Array<(result: ExecutionResult) => void>;

  const internals = () => scheduler as unknown as Internals;
  const succeeded = (): ExecutionResult => ({
    status: "succeeded",
    outcomeSummary: "ok",
    failureReason: null,
    executionRequest: { command: "x", args: [], cwd: workspacePath, promptTransport: "stdin" }
  });

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-cron-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new RunStore(":memory:");
    adapter = new LocalExecutionAdapter();
    gates = [];
    vi.spyOn(adapter, "execute").mockImplementation(() => new Promise((resolve) => gates.push(resolve)));
    scheduler = new SchedulerService(adapter, store);
    key = workspaceKeyFromPath(workspacePath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function readyProfile() {
    await scheduler.saveExecutionProfile({ workspacePath, command: process.execPath, args: ["-e", ""], timeoutMs: 10_000 });
  }

  async function createTask(recurrence: RecurrenceDefinition, name = "Cron") {
    return scheduler.createTask({ workspacePath, name, prompt: "Go", recurrence });
  }

  async function setNextRunAt(taskId: string, iso: string) {
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks.find((entry) => entry.id === taskId)!.nextRunAt = iso;
    await saveWorkspaceLedger(ledger);
  }

  async function nextRunAtOf(taskId: string) {
    return (await loadWorkspaceLedger(workspacePath)).tasks.find((entry) => entry.id === taskId)!.nextRunAt;
  }

  async function waitFor(condition: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition never met");
  }

  describe("collapse", () => {
    it("records one missed event for an 8-hour gap, keyed on the first stale run", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
      const outcome = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", TICK);
      expect(outcome).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T11:59:00.000Z" });
      const runs = store.listRuns(key).runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "missed",
        scheduledFor: "2026-11-01T04:00:00.000Z",
        outcomeSummary:
          "Missed 479 runs between 2026-11-01 04:00 UTC and 2026-11-01 11:58 UTC (the scheduler did not run them in time)."
      });
      expect(await nextRunAtOf(task.id)).toBe("2026-11-01T11:59:00.000Z");
    });

    it("starts the run due within the grace window on the same tick", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(TICK));
      await readyProfile();
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
      const tick = scheduler.tickWithoutDispatcher();
      await waitFor(() => gates.length === 1);
      gates[0]!(succeeded());
      await tick;
      const statuses = store.listRuns(key).runs.map((run) => [run.status, run.scheduledFor]);
      expect(statuses).toEqual([
        ["succeeded", "2026-11-01T11:59:00.000Z"],
        ["missed", "2026-11-01T04:00:00.000Z"]
      ]);
    });

    it("uses the capability message as the reason when the profile is not ready", async () => {
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
      await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", TICK);
      expect(store.listRuns(key).runs[0]?.outcomeSummary).toBe(
        `Missed 479 runs between 2026-11-01 04:00 UTC and 2026-11-01 11:58 UTC (${NOT_READY}).`
      );
    });

    it("caps the count at 1,440", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-10-31T11:00:00.000Z");
      await internals().claimOccurrence(workspacePath, task.id, "2026-10-31T11:00:00.000Z", TICK);
      expect(store.listRuns(key).runs[0]?.outcomeSummary).toBe(
        "Missed 1,440 or more runs between 2026-10-31 11:00 UTC and 2026-11-01 11:58 UTC (the scheduler did not run them in time)."
      );
    });

    it("groups thousands and uses today's text for a single stale run", async () => {
      await readyProfile();
      const many = await createTask(everyMinute, "Many");
      await setNextRunAt(many.id, "2026-10-31T15:59:00.000Z");
      await internals().claimOccurrence(workspacePath, many.id, "2026-10-31T15:59:00.000Z", TICK);
      const one = await createTask(everyMinute, "One");
      await setNextRunAt(one.id, "2026-11-01T11:58:00.000Z");
      await internals().claimOccurrence(workspacePath, one.id, "2026-11-01T11:58:00.000Z", TICK);
      const summaries = store.listRuns(key).runs.map((run) => run.outcomeSummary);
      expect(summaries).toContain(
        "Missed 1,200 runs between 2026-10-31 15:59 UTC and 2026-11-01 11:58 UTC (the scheduler did not run them in time)."
      );
      expect(summaries).toContain(MISSED_UNAVAILABLE_SUMMARY);
    });

    it("formats the collapse times in the task's time zone with its GMT offset", async () => {
      await readyProfile();
      const task = await createTask({ scheduleType: "cron", timezone: "Europe/Amsterdam", expression: "0 9 * * *" });
      await setNextRunAt(task.id, "2026-10-24T07:00:00.000Z");
      const outcome = await internals().claimOccurrence(workspacePath, task.id, "2026-10-24T07:00:00.000Z", "2026-10-26T12:00:10.000Z");
      expect(outcome).toEqual({ kind: "advanced", nextRunAt: "2026-10-27T08:00:00.000Z" });
      expect(store.listRuns(key).runs[0]?.outcomeSummary).toBe(
        "Missed 3 runs between 2026-10-24 09:00 GMT+2 and 2026-10-26 09:00 GMT+1 (the scheduler did not run them in time)."
      );
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "does not record a second event when a retried tick computes a different window",
      async () => {
        await readyProfile();
        const task = await createTask(everyMinute);
        await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
        const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
        await chmod(dataDir, 0o500);
        try {
          await expect(
            internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", TICK)
          ).rejects.toThrow();
        } finally {
          await chmod(dataDir, 0o700);
        }
        expect(await nextRunAtOf(task.id)).toBe("2026-11-01T04:00:00.000Z");
        const retry = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", "2026-11-01T12:00:40.000Z");
        expect(retry).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T12:00:00.000Z" });
        expect(store.listRuns(key).runs).toHaveLength(1);
      }
    );

    it("keeps one missed event per occurrence for a daily task", async () => {
      await readyProfile();
      const task = await createTask(daily);
      await setNextRunAt(task.id, "2026-10-30T09:00:00.000Z");
      let scheduledFor: string | null = "2026-10-30T09:00:00.000Z";
      while (scheduledFor && scheduledFor <= TICK) {
        scheduledFor = (await internals().claimOccurrence(workspacePath, task.id, scheduledFor, TICK)).nextRunAt;
      }
      expect(store.listRuns(key).runs.map((run) => run.status)).toEqual(["missed", "missed", "missed"]);
    });
  });

  describe("overlap", () => {
    async function startScheduled(taskId: string, scheduledFor: string) {
      await setNextRunAt(taskId, scheduledFor);
      return internals().claimOccurrence(workspacePath, taskId, scheduledFor, new Date(Date.parse(scheduledFor) + 5_000).toISOString());
    }

    it("skips a due run while the same cron task is running, without a record; the next one after the run ends runs once", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T12:00:05.000Z"));
      await readyProfile();
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, T);
      const tick = scheduler.tickWithoutDispatcher();
      await waitFor(() => gates.length === 1);
      expect(await nextRunAtOf(task.id)).toBe("2026-11-01T12:01:00.000Z");
      const skip = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T12:01:00.000Z", "2026-11-01T12:01:05.000Z");
      expect(skip).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T12:02:00.000Z" });
      expect(store.listRuns(key).runs).toHaveLength(1);
      gates[0]!(succeeded());
      await tick;
      expect(internals().runningTasks.get(task.id) ?? 0).toBe(0);
      const next = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T12:02:00.000Z", "2026-11-01T12:02:05.000Z");
      expect(next.kind).toBe("started");
      const again = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T12:02:00.000Z", "2026-11-01T12:02:06.000Z");
      expect(again.kind).toBe("skipped");
      expect(store.listRuns(key).runs.map((run) => [run.status, run.scheduledFor])).toEqual([
        ["running", "2026-11-01T12:02:00.000Z"],
        ["succeeded", T]
      ]);
    });

    it("jumps a stale backlog in one claim while running, without a record", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      expect((await startScheduled(task.id, "2026-11-01T08:00:00.000Z")).kind).toBe("started");
      await setNextRunAt(task.id, "2026-11-01T09:00:00.000Z");
      const skip = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T09:00:00.000Z", TICK);
      expect(skip).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T11:59:00.000Z" });
      expect(store.listRuns(key).runs).toHaveLength(1);
    });

    it("keeps counting a scheduled run after an overlapping manual run ends", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      const tickPromise = (async () => {
        const claim = await startScheduled(task.id, T);
        expect(claim.kind).toBe("started");
      })();
      await tickPromise;
      const manual = scheduler.createManualRun(task.id, workspacePath);
      await waitFor(() => gates.length === 1);
      expect(internals().runningTasks.get(task.id)).toBe(2);
      gates[0]!(succeeded());
      await manual;
      expect(internals().runningTasks.get(task.id)).toBe(1);
      await setNextRunAt(task.id, "2026-11-01T12:01:00.000Z");
      const skip = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T12:01:00.000Z", "2026-11-01T12:01:05.000Z");
      expect(skip.kind).toBe("advanced");
    });

    it("does not change the count when a manual run's started append throws", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      expect((await startScheduled(task.id, T)).kind).toBe("started");
      const original = store.appendEvent.bind(store);
      vi.spyOn(store, "appendEvent").mockImplementation((event) => {
        if (event.source === "manual" && event.type === "started") throw new Error("disk full");
        original(event);
      });
      await expect(scheduler.createManualRun(task.id, workspacePath)).rejects.toThrow("disk full");
      expect(internals().runningTasks.get(task.id)).toBe(1);
    });

    it("still starts a daily task while a manual run of it executes", async () => {
      await readyProfile();
      const task = await createTask(daily);
      const manual = scheduler.createManualRun(task.id, workspacePath);
      await waitFor(() => gates.length === 1);
      expect((await startScheduled(task.id, "2026-11-01T09:00:00.000Z")).kind).toBe("started");
      gates[0]!(succeeded());
      await manual;
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "releases the count when the claim's save fails after started",
      async () => {
        await readyProfile();
        const task = await createTask(everyMinute);
        await setNextRunAt(task.id, T);
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
        await chmod(dataDir, 0o500);
        try {
          await expect(internals().claimOccurrence(workspacePath, task.id, T, "2026-11-01T12:00:05.000Z")).rejects.toThrow();
        } finally {
          await chmod(dataDir, 0o700);
        }
        expect(internals().runningTasks.get(task.id) ?? 0).toBe(0);
        await setNextRunAt(task.id, "2026-11-01T12:01:00.000Z");
        const next = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T12:01:00.000Z", "2026-11-01T12:01:05.000Z");
        expect(next.kind).toBe("started");
      }
    );

    // Review Focus 5
    it("a failing execution still releases the running count, even when its final event write throws", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T12:00:05.000Z"));
      await readyProfile();
      vi.mocked(adapter.execute).mockRejectedValueOnce(new Error("crashed"));
      const original = store.appendEvent.bind(store);
      const appendSpy = vi.spyOn(store, "appendEvent").mockImplementation((event) => {
        if (event.type === "failed") throw new Error("disk full");
        original(event);
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, T);
      await scheduler.tickWithoutDispatcher();
      expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "failed", summary: "crashed" }));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("disk full"));
      expect(store.listRuns(key).runs[0]).toMatchObject({ status: "running" });
      expect(internals().runningTasks.get(task.id) ?? 0).toBe(0);
    });
  });

  describe("normalisation", () => {
    it("stores nicknames and spacing normalised on create and update", async () => {
      const task = await createTask({ scheduleType: "cron", timezone: "UTC", expression: "  @DAILY " });
      expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.recurrence).toEqual({
        scheduleType: "cron",
        timezone: "UTC",
        expression: "@daily"
      });
      await scheduler.updateTask(task.id, {
        workspacePath,
        recurrence: { scheduleType: "cron", timezone: "UTC", expression: " 0  9 * *  * " }
      });
      expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.recurrence).toMatchObject({ expression: "0 9 * * *" });
    });

    it("keeps nextRunAt when an edit repeats the stored expression with different spacing", async () => {
      // Clock pinned after 09:00, so a recompute would move nextRunAt to the next day (Ruling R3).
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(TICK));
      const task = await createTask({ scheduleType: "cron", timezone: "UTC", expression: "0 9 * * *" });
      await setNextRunAt(task.id, "2026-11-01T09:00:00.000Z");
      await scheduler.updateTask(task.id, {
        workspacePath,
        prompt: "Edited",
        recurrence: { scheduleType: "cron", timezone: "UTC", expression: "  0 9  * * * " }
      });
      expect(await nextRunAtOf(task.id)).toBe("2026-11-01T09:00:00.000Z");
    });
  });
});
