import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceTask } from "../../src/shared/model.js";
import type { LegacyRun } from "../../src/server/legacy-runs.js";
import { buildGlobalDashboardSnapshot } from "../../src/server/dashboard.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { createTestRunStore, seedLedger } from "../helpers/seed.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

describe("performance fixtures", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-perf-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("loads 100 tasks and the first page of 500 runs within the documented budget", async () => {
    const store = createTestRunStore();
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    const createdAt = "2026-04-26T08:00:00.000Z";
    const tasks: WorkspaceTask[] = Array.from({ length: 100 }, (_, index) => ({
      id: `task-${index}`,
      workspaceKey,
      workspacePath,
      name: `Task ${index}`,
      prompt: `Prompt ${index}`,
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      },
      recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: "2099-01-01T08:00:00.000Z",
      lastRunStatus: index % 3 === 0 ? "succeeded" : null,
      createdAt,
      updatedAt: createdAt
    }));

    const runs: LegacyRun[] = Array.from({ length: 500 }, (_, index) => ({
      id: `run-${index}`,
      occurrenceKey: `task-${index % tasks.length}:2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:00.000Z`,
      taskId: `task-${index % tasks.length}`,
      workspaceKey,
      scheduledFor: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:00.000Z`,
      startedAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:05.000Z`,
      finishedAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:10.000Z`,
      status: index % 7 === 0 ? "failed" : "succeeded",
      outcomeSummary: `Run ${index}`,
      failureReason: index % 7 === 0 ? `Failure ${index}` : null,
      retryOfRunId: null,
      executionRequest: null
    }));

    await seedLedger(store, {
      version: 1,
      workspaceKey,
      workspacePath,
      tasks,
      runs,
      executionProfile: null,
      updatedAt: createdAt
    });

    const scheduler = new SchedulerService(new LocalExecutionAdapter(), store);
    const startedAt = performance.now();
    const state = await scheduler.loadWorkspaceState(workspacePath, () => ({
      status: "needs_config",
      message: "Configure a local execution command to enable automatic prompt runs."
    }));
    const durationMs = performance.now() - startedAt;

    expect(state.tasks).toHaveLength(100);
    expect(state.runs).toHaveLength(100);
    expect(state.runsNextCursor).not.toBeNull();
    expect(durationMs).toBeLessThan(2_000);
    store.close();
  });

  it("builds a 100-job global dashboard snapshot within the documented budget", async () => {
    const store = createTestRunStore();
    const workspacePaths = Array.from({ length: 4 }, (_, index) => path.join(tempHome, `project-${index}`));
    const startedAt = performance.now();

    for (const [workspaceIndex, currentPath] of workspacePaths.entries()) {
      await mkdir(currentPath, { recursive: true });
      const workspaceKey = workspaceKeyFromPath(currentPath);
      const tasks: WorkspaceTask[] = Array.from({ length: 25 }, (_, taskIndex) => ({
        id: `task-${workspaceIndex}-${taskIndex}`,
        workspaceKey,
        workspacePath: currentPath,
        name: `Task ${workspaceIndex}-${taskIndex}`,
        prompt: `Prompt ${workspaceIndex}-${taskIndex}`,
        recurrence: {
          scheduleType: "daily",
          timezone: "Europe/Paris",
          localTime: "09:00"
        },
        recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
        enabled: taskIndex % 3 !== 0,
        nextRunAt: "2099-01-01T08:00:00.000Z",
        lastRunStatus: taskIndex % 5 === 0 ? "failed" : "succeeded",
        createdAt: "2026-04-26T08:00:00.000Z",
        updatedAt: "2026-04-26T08:00:00.000Z"
      }));

      await seedLedger(store, {
        version: 1,
        workspaceKey,
        workspacePath: currentPath,
        tasks,
        runs: [],
        executionProfile: null,
        updatedAt: "2026-04-26T08:00:00.000Z"
      });
    }

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store);
    const durationMs = performance.now() - startedAt;

    expect(snapshot.jobs).toHaveLength(100);
    expect(snapshot.summary.totalJobs).toBe(100);
    expect(durationMs).toBeLessThan(2_000);
    store.close();
  });
});

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
