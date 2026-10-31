import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGlobalDashboardSnapshot } from "../../src/server/dashboard.js";
import type { RunStore } from "../../src/server/run-store.js";
import { createTestRunStore, seedLedger } from "../helpers/seed.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

describe("global dashboard aggregation", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let store: RunStore;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-dashboard-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = createTestRunStore();
  });

  afterEach(async () => {
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("builds an aggregated snapshot with degraded workspace warnings", async () => {
    const workspacePath = path.join(tempHome, "workspace-a");
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    await seedLedger(store, {
      version: 1,
      workspaceKey,
      workspacePath,
      tasks: [
        {
          id: "task-1",
          workspaceKey,
          workspacePath,
          name: "Daily summary",
          prompt: "Summarize",
          recurrence: {
            scheduleType: "daily",
            timezone: "Europe/Paris",
            localTime: "09:00"
          },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "failed",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-1",
          occurrenceKey: "task-1:2026-04-27T08:00:00.000Z",
          taskId: "task-1",
          workspaceKey,
          scheduledFor: "2026-04-27T08:00:00.000Z",
          startedAt: "2026-04-27T08:00:01.000Z",
          finishedAt: "2026-04-27T08:00:10.000Z",
          status: "failed",
          outcomeSummary: "Command exited with code 1",
          failureReason: "Command exited with code 1",
          retryOfRunId: null,
          executionRequest: null
        }
      ],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    const corruptKey = "corruptedworkspace";
    await writeFile(
      path.join(tempHome, ".cloudcli-workspace-scheduled-prompts", `${corruptKey}.json`),
      "{broken",
      "utf8"
    );

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store);

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.workspaceKey).toBe(workspaceKey);
    expect(snapshot.jobs[0]?.lastRunStatus).toBe("failed");
    expect(snapshot.jobs[0]?.latestActionableRunId).toBe("run-1");
    expect(snapshot.partialData).toBe(true);
    expect(snapshot.workspaces.some((workspace) => workspace.workspaceKey === corruptKey)).toBe(true);
    expect(snapshot.warnings.some((warning) => warning.includes("Ledger could not be read"))).toBe(true);
  });

  it("applies problem filtering and urgency ordering", async () => {
    const firstWorkspacePath = path.join(tempHome, "workspace-b");
    const secondWorkspacePath = path.join(tempHome, "workspace-c");
    const firstKey = workspaceKeyFromPath(firstWorkspacePath);
    const secondKey = workspaceKeyFromPath(secondWorkspacePath);
    await mkdir(firstWorkspacePath, { recursive: true });
    await mkdir(secondWorkspacePath, { recursive: true });

    await seedLedger(store, {
      version: 1,
      workspaceKey: firstKey,
      workspacePath: firstWorkspacePath,
      tasks: [
        {
          id: "task-failed",
          workspaceKey: firstKey,
          workspacePath: firstWorkspacePath,
          name: "Broken task",
          prompt: "Fail",
          recurrence: {
            scheduleType: "daily",
            timezone: "Europe/Paris",
            localTime: "09:00"
          },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "failed",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-failed",
          occurrenceKey: "task-failed:2026-04-27T08:00:00.000Z",
          taskId: "task-failed",
          workspaceKey: firstKey,
          scheduledFor: "2026-04-27T08:00:00.000Z",
          startedAt: "2026-04-27T08:00:01.000Z",
          finishedAt: "2026-04-27T08:00:10.000Z",
          status: "failed",
          outcomeSummary: "failed",
          failureReason: "failed",
          retryOfRunId: null,
          executionRequest: null
        }
      ],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    await seedLedger(store, {
      version: 1,
      workspaceKey: secondKey,
      workspacePath: secondWorkspacePath,
      tasks: [
        {
          id: "task-healthy",
          workspaceKey: secondKey,
          workspacePath: secondWorkspacePath,
          name: "Healthy task",
          prompt: "Pass",
          recurrence: {
            scheduleType: "daily",
            timezone: "Europe/Paris",
            localTime: "09:00"
          },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "succeeded",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-succeeded",
          occurrenceKey: "task-healthy:2026-04-27T08:00:00.000Z",
          taskId: "task-healthy",
          workspaceKey: secondKey,
          scheduledFor: "2026-04-27T08:00:00.000Z",
          startedAt: "2026-04-27T08:00:01.000Z",
          finishedAt: "2026-04-27T08:00:10.000Z",
          status: "succeeded",
          outcomeSummary: "ok",
          failureReason: null,
          retryOfRunId: null,
          executionRequest: null
        }
      ],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency", status: "problem" }, store);

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.taskId).toBe("task-failed");
    expect(snapshot.summary.problemJobs).toBe(1);
  });

  it("only exposes retry for the latest failed or missed run", async () => {
    const workspacePath = path.join(tempHome, "workspace-retry");
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    await seedLedger(store, {
      version: 1,
      workspaceKey,
      workspacePath,
      tasks: [
        {
          id: "task-latest-success",
          workspaceKey,
          workspacePath,
          name: "Recovered task",
          prompt: "Recovered",
          recurrence: {
            scheduleType: "daily",
            timezone: "Europe/Paris",
            localTime: "09:00"
          },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "succeeded",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-succeeded",
          occurrenceKey: "task-latest-success:2026-04-28T08:00:00.000Z",
          taskId: "task-latest-success",
          workspaceKey,
          scheduledFor: "2026-04-28T08:00:00.000Z",
          startedAt: "2026-04-28T08:00:01.000Z",
          finishedAt: "2026-04-28T08:00:10.000Z",
          status: "succeeded",
          outcomeSummary: "ok",
          failureReason: null,
          retryOfRunId: null,
          executionRequest: null
        },
        {
          id: "run-failed-old",
          occurrenceKey: "task-latest-success:2026-04-27T08:00:00.000Z",
          taskId: "task-latest-success",
          workspaceKey,
          scheduledFor: "2026-04-27T08:00:00.000Z",
          startedAt: "2026-04-27T08:00:01.000Z",
          finishedAt: "2026-04-27T08:00:10.000Z",
          status: "failed",
          outcomeSummary: "failed",
          failureReason: "failed",
          retryOfRunId: null,
          executionRequest: null
        }
      ],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store);

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.latestActionableRunId).toBeNull();
    expect(snapshot.jobs[0]?.availableActions).toEqual(["run_now", "pause"]);
  });

  it("falls back to the persisted task status when matching run history has been trimmed", async () => {
    const workspacePath = path.join(tempHome, "workspace-trimmed-status");
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    await seedLedger(store, {
      version: 1,
      workspaceKey,
      workspacePath,
      tasks: [
        {
          id: "task-trimmed",
          workspaceKey,
          workspacePath,
          name: "Trimmed history task",
          prompt: "Keep last status",
          recurrence: {
            scheduleType: "daily",
            timezone: "Europe/Paris",
            localTime: "09:00"
          },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "failed",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store);

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.lastRunStatus).toBe("failed");
    expect(snapshot.summary.problemJobs).toBe(1);
  });

  it("preserves a running status when a task is disabled during execution", async () => {
    const workspacePath = path.join(tempHome, "workspace-running-disabled");
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    await seedLedger(store, {
      version: 1,
      workspaceKey,
      workspacePath,
      tasks: [
        {
          id: "task-running-disabled",
          workspaceKey,
          workspacePath,
          name: "Paused while running",
          prompt: "Long run",
          recurrence: {
            scheduleType: "daily",
            timezone: "Europe/Paris",
            localTime: "09:00"
          },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: false,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "running",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-running",
          occurrenceKey: "task-running-disabled:2026-04-27T08:00:00.000Z",
          taskId: "task-running-disabled",
          workspaceKey,
          scheduledFor: "2026-04-27T08:00:00.000Z",
          startedAt: "2026-04-27T08:00:01.000Z",
          finishedAt: null,
          status: "running",
          outcomeSummary: "running",
          failureReason: null,
          retryOfRunId: null,
          executionRequest: null
        }
      ],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency", status: "running" }, store);

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.lastRunStatus).toBe("running");
    expect(snapshot.summary.pausedJobs).toBe(0);
  });

  it("does not classify a completed one-time schedule with no next run as a problem", async () => {
    const workspacePath = path.join(tempHome, "workspace-d");
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    await seedLedger(store, {
      version: 1,
      workspaceKey,
      workspacePath,
      tasks: [
        {
          id: "task-one-time",
          workspaceKey,
          workspacePath,
          name: "One-time migration",
          prompt: "Run once",
          recurrence: {
            scheduleType: "one_time",
            timezone: "Europe/Paris",
            runAt: "2026-04-27T08:00:00.000+02:00"
          },
          recurrenceSummary: "Once on 2026-04-27 08:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: null,
          lastRunStatus: "succeeded",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-one-time",
          occurrenceKey: "task-one-time:2026-04-27T06:00:00.000Z",
          taskId: "task-one-time",
          workspaceKey,
          scheduledFor: "2026-04-27T06:00:00.000Z",
          startedAt: "2026-04-27T06:00:01.000Z",
          finishedAt: "2026-04-27T06:00:05.000Z",
          status: "succeeded",
          outcomeSummary: "ok",
          failureReason: null,
          retryOfRunId: null,
          executionRequest: null
        }
      ],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    const baseline = await buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store);
    expect(baseline.summary.problemJobs).toBe(0);

    const filtered = await buildGlobalDashboardSnapshot({ sortBy: "urgency", status: "problem" }, store);
    expect(filtered.jobs).toHaveLength(0);
  });

  it("keeps jobs visible when a persisted workspace has moved away", async () => {
    const workspacePath = path.join(tempHome, "workspace-e");
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    await seedLedger(store, {
      version: 1,
      workspaceKey,
      workspacePath,
      tasks: [
        {
          id: "task-moved",
          workspaceKey,
          workspacePath,
          name: "Moved workspace task",
          prompt: "Keep visible",
          recurrence: {
            scheduleType: "daily",
            timezone: "Europe/Paris",
            localTime: "09:00"
          },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "succeeded",
          createdAt: "2026-04-27T08:00:00.000Z",
          updatedAt: "2026-04-27T08:00:00.000Z"
        }
      ],
      runs: [],
      executionProfile: null,
      updatedAt: "2026-04-27T08:00:00.000Z"
    });

    await rm(workspacePath, { recursive: true, force: true });

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store);

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.workspaceAvailability).toBe("unavailable");
    expect(snapshot.jobs[0]?.workspaceDrilldownAvailable).toBe(false);
    expect(snapshot.partialData).toBe(true);
    expect(snapshot.warnings.some((warning) => warning.includes("Workspace path is unavailable"))).toBe(true);
  });
});
