import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchedulerService } from "../../src/server/scheduler.js";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { RunStore } from "../../src/server/run-store.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";
import { seedRuns } from "../helpers/seed.js";
import { nextOccurrenceForRecurrence } from "../../src/server/recurrence.js";
import { loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";

describe("scheduler service integration", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;
  let store: RunStore;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-int-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new RunStore(":memory:");
  });

  afterEach(async () => {
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  const createScheduler = () => new SchedulerService(new LocalExecutionAdapter(), store);
  const runsOf = () => store.listRuns(workspaceKeyFromPath(workspacePath)).runs;

  it("creates and reloads a persisted recurring task with computed summary and next run", async () => {
    const scheduler = createScheduler();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    expect(task.recurrenceSummary).toContain("Daily at 09:00");
    expect(task.nextRunAt).toBeTruthy();

    const state = await scheduler.loadWorkspaceState(workspacePath, () => ({
      status: "needs_config",
      message: "not configured"
    }));
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.name).toBe("Morning summary");
  });

  it("lists a task whose saved cron never matches, with no next run, instead of failing the load", async () => {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const now = new Date().toISOString();
    ledger.tasks.push({
      id: "task-bad-cron",
      workspaceKey: ledger.workspaceKey,
      workspacePath: ledger.workspacePath,
      name: "Bad cron",
      prompt: "Go",
      recurrence: { scheduleType: "cron", timezone: "Europe/Paris", expression: "0 9 31 2 *" },
      recurrenceSummary: "Cron",
      enabled: true,
      nextRunAt: null,
      lastRunStatus: null,
      createdAt: now,
      updatedAt: now
    });
    await saveWorkspaceLedger(ledger);
    const state = await createScheduler().loadWorkspaceState(workspacePath, () => ({ status: "ready", message: "ok" }));
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.nextRunAt).toBeNull();
  });

  it("updates a task and recalculates its recurrence summary", async () => {
    const scheduler = createScheduler();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Weekly review",
      prompt: "Review weekly changes.",
      recurrence: {
        scheduleType: "weekly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfWeek: "monday"
      }
    });

    const updated = await scheduler.updateTask(task.id, {
      workspacePath,
      recurrence: {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "10:15",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      }
    });

    expect(updated.recurrenceSummary).toContain("Monthly on day 31");
    expect(updated.nextRunAt).toBeTruthy();
  });

  it("executes due runs through the local command profile and records the result", async () => {
    const scheduler = createScheduler();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    await scheduler.saveExecutionProfile({
      workspacePath,
      command: process.execPath,
      args: [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log('stdin:'+d);});"
      ],
      timeoutMs: 10_000
    });

    const ledger = await loadWorkspaceLedger(workspacePath);
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    ledger.tasks[0]!.nextRunAt = dueAt;
    await saveWorkspaceLedger(ledger);

    await scheduler.tickWithoutDispatcher();

    const updated = await loadWorkspaceLedger(workspacePath);
    expect(runsOf()).toHaveLength(1);
    expect(runsOf()[0]?.status).toBe("succeeded");
    expect(runsOf()[0]?.outcomeSummary).toContain("stdin:Summarize the workspace.");
    const derived = await scheduler.loadWorkspaceState(workspacePath, () => ({ status: "ready", message: "ok" }));
    expect(derived.tasks[0]?.lastRunStatus).toBe("succeeded");

    await scheduler.tickWithoutDispatcher();
    expect(runsOf()).toHaveLength(1);
  });

  it("marks due runs as missed when no execution profile is configured", async () => {
    const scheduler = createScheduler();
    await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveWorkspaceLedger(ledger);

    await scheduler.tickWithoutDispatcher();

    const updated = await loadWorkspaceLedger(workspacePath);
    expect(runsOf()[0]?.status).toBe("missed");
    expect(runsOf()[0]?.outcomeSummary).toContain("Configure a local execution command");
  });

  it("records all missed recurring occurrences in one tick and resumes from the next future slot", async () => {
    const scheduler = createScheduler();
    const recurrence = {
      scheduleType: "daily" as const,
      timezone: "Europe/Paris",
      localTime: "09:00"
    };

    await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence
    });

    const ledger = await loadWorkspaceLedger(workspacePath);
    const firstMissed = DateTime.now()
      .setZone("Europe/Paris")
      .minus({ days: 3 })
      .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const expectedOccurrences: string[] = [];
    let cursor = firstMissed;
    const now = DateTime.now().toUTC();

    while (cursor.toUTC() <= now) {
      expectedOccurrences.push(cursor.toUTC().toISO()!);
      cursor = cursor.plus({ days: 1 });
    }

    ledger.tasks[0]!.nextRunAt = expectedOccurrences[0]!;
    await saveWorkspaceLedger(ledger);

    await scheduler.tickWithoutDispatcher();

    const updated = await loadWorkspaceLedger(workspacePath);
    expect(runsOf()).toHaveLength(expectedOccurrences.length);
    expect(runsOf().every((run) => run.status === "missed")).toBe(true);
    expect(runsOf().map((run) => run.scheduledFor).sort()).toEqual([...expectedOccurrences].sort());
    expect(runsOf().every((run) => run.outcomeSummary.includes("Configure a local execution command"))).toBe(true);
    expect(updated.tasks[0]?.nextRunAt).toBe(
      nextOccurrenceForRecurrence(recurrence, expectedOccurrences.at(-1))
    );
  });

  it("does not execute paused tasks until they are resumed", async () => {
    const scheduler = createScheduler();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    await scheduler.pauseTask(task.id, workspacePath);

    const pausedLedger = await loadWorkspaceLedger(workspacePath);
    pausedLedger.tasks[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveWorkspaceLedger(pausedLedger);

    await scheduler.tickWithoutDispatcher();

    const stillPaused = await loadWorkspaceLedger(workspacePath);
    expect(runsOf()).toHaveLength(0);
    expect(stillPaused.tasks[0]?.enabled).toBe(false);

    const resumed = await scheduler.resumeTask(task.id, workspacePath);
    expect(resumed.enabled).toBe(true);

    const resumedLedger = await loadWorkspaceLedger(workspacePath);
    resumedLedger.tasks[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveWorkspaceLedger(resumedLedger);

    await scheduler.tickWithoutDispatcher();

    expect(runsOf()[0]?.status).toBe("missed");
  });

  it("deletes tasks so they are removed from the active list and never execute again", async () => {
    const scheduler = createScheduler();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Weekly review",
      prompt: "Review weekly changes.",
      recurrence: {
        scheduleType: "weekly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfWeek: "monday"
      }
    });

    await scheduler.deleteTask(task.id, workspacePath);

    const deletedLedger = await loadWorkspaceLedger(workspacePath);
    expect(deletedLedger.tasks).toHaveLength(0);

    await scheduler.tickWithoutDispatcher();

    const afterTick = await loadWorkspaceLedger(workspacePath);
    expect(afterTick.tasks).toHaveLength(0);
    expect(runsOf()).toHaveLength(0);
  });

  it("duplicates tasks and supports a manual run-now without waiting for the next occurrence", async () => {
    const scheduler = createScheduler();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    const duplicate = await scheduler.duplicateTask(task.id, workspacePath);
    expect(duplicate.id).not.toBe(task.id);
    expect(duplicate.name).toContain("(Copy)");

    const manualRun = await scheduler.createManualRun(task.id, workspacePath);
    expect(["failed", "succeeded"]).toContain(manualRun.status);

    const ledger = await loadWorkspaceLedger(workspacePath);
    expect(ledger.tasks).toHaveLength(2);
    expect(runsOf()).toHaveLength(1);
    expect(runsOf()[0]?.taskId).toBe(task.id);
  });

  it("retries the latest failed run against the same workspace task", async () => {
    const scheduler = createScheduler();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Retry target",
      prompt: "Retry the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    const failedRun = await scheduler.createManualRun(task.id, workspacePath);
    expect(failedRun.status).toBe("failed");

    const retriedRun = await scheduler.retryRun(failedRun.id, workspacePath);
    expect(retriedRun.taskId).toBe(task.id);
    expect(retriedRun.retryOfRunId).toBe(failedRun.id);

    const ledger = await loadWorkspaceLedger(workspacePath);
    expect(runsOf()).toHaveLength(2);
    expect(runsOf()[0]?.id).toBe(retriedRun.id);
    expect(runsOf()[1]?.id).toBe(failedRun.id);
  });

  it("lists runs by the ledger's workspacePath for a misnamed ledger file without rewriting it", async () => {
    const otherPath = path.join(tempHome, "other-project");
    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    const ledgerFile = path.join(dataDir, `${workspaceKeyFromPath(workspacePath)}.json`);
    const contents = `${JSON.stringify({
      version: 2,
      workspaceKey: workspaceKeyFromPath(otherPath),
      workspacePath: otherPath,
      tasks: [],
      executionProfile: null,
      updatedAt: "2026-04-26T08:00:00.000Z"
    })}\n`;
    await writeFile(ledgerFile, contents, "utf8");
    seedRuns(store, otherPath, [
      {
        id: "run-b",
        occurrenceKey: "task-b:2026-04-27T07:00:00.000Z",
        taskId: "task-b",
        workspaceKey: workspaceKeyFromPath(otherPath),
        scheduledFor: "2026-04-27T07:00:00.000Z",
        startedAt: "2026-04-27T07:00:01.000Z",
        finishedAt: "2026-04-27T07:00:09.000Z",
        status: "succeeded",
        outcomeSummary: "ok",
        failureReason: null,
        retryOfRunId: null,
        executionRequest: null
      }
    ]);

    const page = await createScheduler().listRuns(workspacePath);

    expect(page.runs.map((run) => run.id)).toEqual(["run-b"]);
    expect(await readFile(ledgerFile, "utf8")).toBe(contents);
  });
});
