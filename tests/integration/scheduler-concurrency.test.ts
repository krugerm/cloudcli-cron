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
