// @vitest-environment jsdom

import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGlobalDashboardSnapshot } from "../../src/server/dashboard.js";
import { startHttpServer } from "../../src/server/http.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { loadWorkspaceLedger } from "../../src/server/storage.js";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { createTestRunStore, seedLedger } from "../helpers/seed.js";
import { WorkspaceScheduledPromptsApp } from "../../src/client/app.js";
import { renderGlobalDashboard } from "../../src/client/views/global-dashboard.js";
import type { GlobalDashboardSnapshot } from "../../src/shared/model.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";
import type { PluginAPI } from "../../src/types.js";

const snapshot: GlobalDashboardSnapshot = {
  generatedAt: "2026-04-27T08:00:00.000Z",
  summary: {
    totalJobs: 2,
    activeJobs: 1,
    pausedJobs: 1,
    problemJobs: 1,
    workspacesTotal: 2,
    workspacesDegraded: 1
  },
  jobs: [
    {
      taskId: "task-1",
      workspaceKey: "workspace-1",
      workspacePath: "/tmp/alpha",
      workspaceLabel: "alpha",
      name: "Daily summary",
      scheduleType: "daily",
      recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: "2099-01-01T08:00:00.000Z",
      lastRunStatus: "failed",
      lastRunFinishedAt: "2026-04-27T07:00:00.000Z",
      latestActionableRunId: "run-1",
      workspaceAvailability: "available",
      workspaceDrilldownAvailable: true,
      availableActions: ["run_now", "pause", "retry"]
    }
  ],
  workspaces: [
    {
      workspaceKey: "workspace-1",
      workspacePath: "/tmp/alpha",
      workspaceLabel: "alpha",
      status: "available",
      jobCount: 1,
      warning: null
    },
    {
      workspaceKey: "workspace-2",
      workspacePath: "/tmp/beta",
      workspaceLabel: "beta",
      status: "unavailable",
      jobCount: 0,
      warning: "Workspace path is unavailable."
    }
  ],
  partialData: true,
  warnings: ["Workspace path is unavailable."]
};

describe("global dashboard view", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aggregates jobs across multiple persisted workspaces", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-global-"));
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    const store = createTestRunStore();

    try {
      const workspaceA = path.join(tempHome, "alpha");
      const workspaceB = path.join(tempHome, "beta");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const workspaceAKey = workspaceKeyFromPath(workspaceA);
      const workspaceBKey = workspaceKeyFromPath(workspaceB);

      await seedLedger(store, {
        version: 1,
        workspaceKey: workspaceAKey,
        workspacePath: workspaceA,
        tasks: [
          {
            id: "task-a",
            workspaceKey: workspaceAKey,
            workspacePath: workspaceA,
            name: "A",
            prompt: "A",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
            recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
            enabled: true,
            nextRunAt: "2099-01-01T08:00:00.000Z",
            lastRunStatus: null,
            createdAt: "2026-04-27T08:00:00.000Z",
            updatedAt: "2026-04-27T08:00:00.000Z"
          }
        ],
        runs: [],
        executionProfile: null,
        updatedAt: "2026-04-27T08:00:00.000Z"
      });

      await seedLedger(store, {
        version: 1,
        workspaceKey: workspaceBKey,
        workspacePath: workspaceB,
        tasks: [
          {
            id: "task-b",
            workspaceKey: workspaceBKey,
            workspacePath: workspaceB,
            name: "B",
            prompt: "B",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
            recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
            enabled: false,
            nextRunAt: "2099-01-01T08:00:00.000Z",
            lastRunStatus: null,
            createdAt: "2026-04-27T08:00:00.000Z",
            updatedAt: "2026-04-27T08:00:00.000Z"
          }
        ],
        runs: [],
        executionProfile: null,
        updatedAt: "2026-04-27T08:00:00.000Z"
      });

      const aggregated = await buildGlobalDashboardSnapshot({ sortBy: "workspace" }, store);
      expect(aggregated.jobs).toHaveLength(2);
      expect(aggregated.jobs.map((job) => job.workspaceLabel)).toEqual(["alpha", "beta"]);
    } finally {
      store.close();
      process.env.HOME = previousHome;
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps summary counters on the full workspace subset while filters narrow the list", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-global-"));
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    const store = createTestRunStore();

    try {
      const workspaceA = path.join(tempHome, "alpha");
      const workspaceB = path.join(tempHome, "beta");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const workspaceAKey = workspaceKeyFromPath(workspaceA);
      const workspaceBKey = workspaceKeyFromPath(workspaceB);

      await seedLedger(store, {
        version: 1,
        workspaceKey: workspaceAKey,
        workspacePath: workspaceA,
        tasks: [
          {
            id: "task-failed",
            workspaceKey: workspaceAKey,
            workspacePath: workspaceA,
            name: "Failed",
            prompt: "Failed",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
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
            workspaceKey: workspaceAKey,
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
        workspaceKey: workspaceBKey,
        workspacePath: workspaceB,
        tasks: [
          {
            id: "task-ok",
            workspaceKey: workspaceBKey,
            workspacePath: workspaceB,
            name: "Healthy",
            prompt: "Healthy",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
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
            id: "run-ok",
            occurrenceKey: "task-ok:2026-04-27T08:00:00.000Z",
            taskId: "task-ok",
            workspaceKey: workspaceBKey,
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

      const filtered = await buildGlobalDashboardSnapshot({ sortBy: "urgency", status: "problem" }, store);
      expect(filtered.jobs).toHaveLength(1);
      expect(filtered.jobs[0]?.taskId).toBe("task-failed");
      expect(filtered.summary.totalJobs).toBe(2);
      expect(filtered.summary.problemJobs).toBe(1);
      expect(filtered.summary.workspacesTotal).toBe(2);
    } finally {
      store.close();
      process.env.HOME = previousHome;
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("renders aggregated jobs and degraded workspace warnings", () => {
    const onRefresh = vi.fn();
    const section = renderGlobalDashboard(
      snapshot,
      false,
      null,
      { sortBy: "urgency" },
      {
        onRefresh,
        onSetStatusFilter: vi.fn(),
        onSetWorkspaceFilter: vi.fn(),
        onSetSortBy: vi.fn(),
        onOpenWorkspace: vi.fn(),
        onRunNow: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onRetry: vi.fn()
      }
    );

    expect(section.textContent).toContain("Global Dashboard");
    expect(section.textContent).toContain("Daily summary");
    expect(section.textContent).toContain("alpha");
    expect(section.textContent).toContain("Partial data");
    expect(section.textContent).toContain("beta");

    section.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders filters, urgency highlighting, and degraded workspace messaging", () => {
    const handlers = {
      onRefresh: vi.fn(),
      onSetStatusFilter: vi.fn(),
      onSetWorkspaceFilter: vi.fn(),
      onSetSortBy: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onRunNow: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onRetry: vi.fn()
    };
    const section = renderGlobalDashboard(
      snapshot,
      false,
      null,
      { sortBy: "urgency", status: "problem" },
      handlers
    );

    const failedRow = section.querySelector<HTMLElement>('.wsp-global-job[data-problem="true"]');
    expect(failedRow?.textContent).toContain("Needs attention");

    const statusSelect = section.querySelector<HTMLSelectElement>('select[name="statusFilter"]');
    statusSelect!.value = "failed";
    statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(handlers.onSetStatusFilter).toHaveBeenCalledWith("failed");

    const sortSelect = section.querySelector<HTMLSelectElement>('select[name="sortBy"]');
    sortSelect!.value = "name";
    sortSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(handlers.onSetSortBy).toHaveBeenCalledWith("name");

    expect(section.textContent).toContain("Workspace path is unavailable.");
  });

  it("surfaces unreadable ledgers as partial dashboard data", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-global-unreadable-"));
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    const store = createTestRunStore();

    try {
      const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
      await mkdir(dataDir, { recursive: true });
      await rm(path.join(tempHome, "missing-workspace"), { recursive: true, force: true });
      await seedLedger(store, {
        version: 1,
        workspaceKey: "workspace-keep",
        workspacePath: path.join(tempHome, "workspace-keep"),
        tasks: [
          {
            id: "task-keep",
            workspaceKey: "workspace-keep",
            workspacePath: path.join(tempHome, "workspace-keep"),
            name: "Keep visible",
            prompt: "Keep visible",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
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
      await rm(path.join(tempHome, "workspace-keep"), { recursive: true, force: true });
      await writeFile(path.join(dataDir, "broken.json"), "{invalid", "utf8");

      const generated = await buildGlobalDashboardSnapshot({ sortBy: "urgency" }, store);
      const section = renderGlobalDashboard(generated, false, null, { sortBy: "urgency" }, {
        onRefresh: vi.fn(),
        onSetStatusFilter: vi.fn(),
        onSetWorkspaceFilter: vi.fn(),
        onSetSortBy: vi.fn(),
        onOpenWorkspace: vi.fn(),
        onRunNow: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onRetry: vi.fn()
      });

      expect(generated.partialData).toBe(true);
      expect(section.textContent).toContain("Ledger could not be read");
      expect(section.textContent).toContain("Partial data");
    } finally {
      store.close();
      process.env.HOME = previousHome;
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("renders loading and error states", () => {
    const loading = renderGlobalDashboard(
      null,
      true,
      null,
      { sortBy: "urgency" },
      {
        onRefresh: vi.fn(),
        onSetStatusFilter: vi.fn(),
        onSetWorkspaceFilter: vi.fn(),
        onSetSortBy: vi.fn(),
        onOpenWorkspace: vi.fn(),
        onRunNow: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onRetry: vi.fn()
      }
    );
    expect(loading.textContent).toContain("Loading global dashboard");

    const failure = renderGlobalDashboard(
      null,
      false,
      "Refresh failed.",
      { sortBy: "urgency" },
      {
        onRefresh: vi.fn(),
        onSetStatusFilter: vi.fn(),
        onSetWorkspaceFilter: vi.fn(),
        onSetSortBy: vi.fn(),
        onOpenWorkspace: vi.fn(),
        onRunNow: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onRetry: vi.fn()
      }
    );
    expect(failure.textContent).toContain("Refresh failed.");
  });

  it("renders direct global actions and workspace drilldown controls", () => {
    const handlers = {
      onRefresh: vi.fn(),
      onSetStatusFilter: vi.fn(),
      onSetWorkspaceFilter: vi.fn(),
      onSetSortBy: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onRunNow: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onRetry: vi.fn()
    };
    const section = renderGlobalDashboard(snapshot, false, null, { sortBy: "urgency" }, handlers);

    Array.from(section.querySelectorAll("button"))
      .find((button) => button.textContent === "Open Workspace")
      ?.click();
    Array.from(section.querySelectorAll("button"))
      .find((button) => button.textContent === "Run Now")
      ?.click();
    Array.from(section.querySelectorAll("button"))
      .find((button) => button.textContent === "Pause")
      ?.click();
    Array.from(section.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")
      ?.click();

    expect(handlers.onOpenWorkspace).toHaveBeenCalledWith("/tmp/alpha", "task-1");
    expect(handlers.onRunNow).toHaveBeenCalledWith("workspace-1", "task-1");
    expect(handlers.onPause).toHaveBeenCalledWith("workspace-1", "task-1");
    expect(handlers.onRetry).toHaveBeenCalledWith("workspace-1", "task-1", "run-1");
  });

  it("marks degraded one-time jobs as needing attention and keeps partial workspace actions enabled", () => {
    const partialSnapshot: GlobalDashboardSnapshot = {
      ...snapshot,
      summary: {
        totalJobs: 1,
        activeJobs: 1,
        pausedJobs: 0,
        problemJobs: 1,
        workspacesTotal: 1,
        workspacesDegraded: 1
      },
      jobs: [
        {
          taskId: "task-partial",
          workspaceKey: "workspace-partial",
          workspacePath: "/tmp/partial",
          workspaceLabel: "partial",
          workspaceDrilldownAvailable: true,
          name: "One-time partial job",
          scheduleType: "one_time",
          recurrenceSummary: "Once on 2026-04-27 08:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: null,
          lastRunStatus: "succeeded",
          lastRunFinishedAt: "2026-04-27T06:00:05.000Z",
          latestActionableRunId: null,
          workspaceAvailability: "partial",
          availableActions: ["run_now", "pause"]
        }
      ],
      workspaces: [
        {
          workspaceKey: "workspace-partial",
          workspacePath: "/tmp/partial",
          workspaceLabel: "partial",
          status: "partial",
          jobCount: 1,
          warning: "Ledger was repaired."
        }
      ],
      partialData: true,
      warnings: ["partial: Ledger was repaired."]
    };
    const handlers = {
      onRefresh: vi.fn(),
      onSetStatusFilter: vi.fn(),
      onSetWorkspaceFilter: vi.fn(),
      onSetSortBy: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onRunNow: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onRetry: vi.fn()
    };

    const section = renderGlobalDashboard(partialSnapshot, false, null, { sortBy: "urgency" }, handlers);
    const row = section.querySelector<HTMLElement>('.wsp-global-job[data-task-id="task-partial"]');
    const runNowButton = row?.querySelector<HTMLButtonElement>('button[data-action="run_now"]');
    const pauseButton = row?.querySelector<HTMLButtonElement>('button[data-action="pause"]');

    expect(row?.getAttribute("data-problem")).toBe("true");
    expect(row?.textContent).toContain("Needs attention");
    expect(runNowButton?.disabled).toBe(false);
    expect(pauseButton?.disabled).toBe(false);
  });

  it("escapes persisted job metadata when rendering global rows", () => {
    const escapedSnapshot: GlobalDashboardSnapshot = {
      ...snapshot,
      jobs: [
        {
          ...snapshot.jobs[0]!,
          name: '<img src=x onerror="window.__xss=1">Daily',
          workspaceLabel: "<b>alpha</b>"
        }
      ]
    };
    const handlers = {
      onRefresh: vi.fn(),
      onSetStatusFilter: vi.fn(),
      onSetWorkspaceFilter: vi.fn(),
      onSetSortBy: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onRunNow: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onRetry: vi.fn()
    };

    const section = renderGlobalDashboard(escapedSnapshot, false, null, { sortBy: "urgency" }, handlers);
    const row = section.querySelector<HTMLElement>('.wsp-global-job[data-task-id="task-1"]');

    expect(row?.querySelector("img")).toBeNull();
    expect(row?.querySelector("b")).toBeNull();
    expect(row?.textContent).toContain('<img src=x onerror="window.__xss=1">Daily');
    expect(row?.textContent).toContain("<b>alpha</b>");
  });

  it("escapes persisted workspace filter options when rendering global controls", () => {
    const escapedSnapshot: GlobalDashboardSnapshot = {
      ...snapshot,
      workspaces: [
        {
          workspaceKey: 'workspace"><img src=x onerror="window.__xss=1">',
          workspacePath: "/tmp/injected",
          workspaceLabel: '<b>Injected</b> & "quoted"',
          status: "available",
          jobCount: 1,
          warning: null
        }
      ]
    };
    const handlers = {
      onRefresh: vi.fn(),
      onSetStatusFilter: vi.fn(),
      onSetWorkspaceFilter: vi.fn(),
      onSetSortBy: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onRunNow: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onRetry: vi.fn()
    };

    const section = renderGlobalDashboard(escapedSnapshot, false, null, { sortBy: "urgency" }, handlers);
    const workspaceSelect = section.querySelector<HTMLSelectElement>('select[name="workspaceFilter"]');

    expect(section.querySelector("img")).toBeNull();
    expect(section.querySelector("b")).toBeNull();
    expect(workspaceSelect?.options).toHaveLength(2);
    expect(workspaceSelect?.options[1]?.value).toBe('workspace"><img src=x onerror="window.__xss=1">');
    expect(workspaceSelect?.options[1]?.textContent).toBe('<b>Injected</b> & "quoted"');
  });

  it("mounts a dedicated global tab and loads the aggregated snapshot", async () => {
    let globalRequestCount = 0;
    const updatedSnapshot: GlobalDashboardSnapshot = {
      ...snapshot,
      jobs: snapshot.jobs.map((job) =>
        job.taskId === "task-1"
          ? {
              ...job,
              enabled: false,
              lastRunStatus: "paused",
              availableActions: ["run_now", "resume", "retry"]
            }
          : job
      )
    };
    const api: PluginAPI = {
      context: {
        theme: "light",
        project: null,
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path) => {
        if (method === "POST" && path === "/v1/global-jobs/workspace-1/task-1/actions/pause") {
          return {
            task: {
              id: "task-1",
              workspaceKey: "workspace-1",
              workspacePath: "/tmp/alpha",
              name: "Daily summary",
              prompt: "A",
              recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
              recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
              enabled: false,
              nextRunAt: "2099-01-01T08:00:00.000Z",
              lastRunStatus: "paused",
              createdAt: "2026-04-27T08:00:00.000Z",
              updatedAt: "2026-04-27T08:00:00.000Z"
            }
          };
        }
        if (method === "GET" && path.startsWith("/v1/workspace-state")) {
          return {
            capability: { status: "needs_config", message: "Configure execution." },
            executionProfile: null,
            tasks: [],
            runs: []
          };
        }
        if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
          globalRequestCount += 1;
          return globalRequestCount > 1 ? updatedSnapshot : snapshot;
        }
        throw new Error(`Unexpected RPC: ${method} ${path}`);
      }
    };

    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, api);
    await app.mount();

    expect(container.textContent).toContain("Global Dashboard");
    expect(container.textContent).toContain("Daily summary");
    expect(container.textContent).toContain("Global overview");

    container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      if (button.textContent === "Pause") {
        button.click();
      }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(container.textContent).toContain("Resume");

    app.unmount();
  }, 10_000);

  it("shows a pending state for a global action and refreshes immediately after it resolves", async () => {
    let globalRequestCount = 0;
    let resolvePause: ((value: unknown) => void) | null = null;
    const updatedSnapshot: GlobalDashboardSnapshot = {
      ...snapshot,
      jobs: snapshot.jobs.map((job) =>
        job.taskId === "task-1"
          ? {
              ...job,
              enabled: false,
              lastRunStatus: "paused",
              availableActions: ["run_now", "resume", "retry"]
            }
          : job
      )
    };

    const api: PluginAPI = {
      context: {
        theme: "light",
        project: null,
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path) => {
        if (method === "POST" && path === "/v1/global-jobs/workspace-1/task-1/actions/pause") {
          return await new Promise((resolve) => {
            resolvePause = resolve;
          });
        }
        if (method === "GET" && path.startsWith("/v1/workspace-state")) {
          return {
            capability: { status: "needs_config", message: "Configure execution." },
            executionProfile: null,
            tasks: [],
            runs: []
          };
        }
        if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
          globalRequestCount += 1;
          return globalRequestCount > 1 ? updatedSnapshot : snapshot;
        }
        throw new Error(`Unexpected RPC: ${method} ${path}`);
      }
    };

    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, api);
    await app.mount();

    const pauseButton = container.querySelector<HTMLButtonElement>('button[data-action="pause"]');
    pauseButton?.click();
    await Promise.resolve();

    expect(container.textContent).toContain("Working...");

    resolvePause?.({
      task: {
        id: "task-1",
        workspaceKey: "workspace-1",
        workspacePath: "/tmp/alpha",
        name: "Daily summary",
        prompt: "A",
        recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
        recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
        enabled: false,
        nextRunAt: "2099-01-01T08:00:00.000Z",
        lastRunStatus: "paused",
        createdAt: "2026-04-27T08:00:00.000Z",
        updatedAt: "2026-04-27T08:00:00.000Z"
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(globalRequestCount).toBeGreaterThan(1);
    expect(container.textContent).toContain("Resume");
    expect(container.textContent).toContain('Schedule "Daily summary" paused.');

    app.unmount();
  });

  it("opens a workspace drilldown from a global job", async () => {
    const api: PluginAPI = {
      context: {
        theme: "light",
        project: null,
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path) => {
        if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
          return snapshot;
        }
        if (method === "GET" && path.startsWith("/v1/workspace-state")) {
          return {
            capability: { status: "needs_config", message: "Configure execution." },
            executionProfile: null,
            tasks: [
              {
                id: "task-1",
                workspaceKey: "workspace-1",
                workspacePath: "/tmp/alpha",
                name: "Workspace view task",
                prompt: "A",
                recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
                recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
                enabled: true,
                nextRunAt: "2099-01-01T08:00:00.000Z",
                lastRunStatus: "succeeded",
                createdAt: "2026-04-27T08:00:00.000Z",
                updatedAt: "2026-04-27T08:00:00.000Z"
              }
            ],
            runs: []
          };
        }
        throw new Error(`Unexpected RPC: ${method} ${path}`);
      }
    };

    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, api);
    await app.mount();

    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Open Workspace")
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.textContent).toContain("Workspace view task");
    expect(container.textContent).toContain("Workspace");

    app.unmount();
  });

  it("routes global HTTP actions across workspaces and rejects stale retry targets", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-global-http-"));
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    const store = createTestRunStore();

    let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;

    try {
      const workspaceA = path.join(tempHome, "alpha");
      const workspaceB = path.join(tempHome, "beta");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const workspaceAKey = workspaceKeyFromPath(workspaceA);
      const workspaceBKey = workspaceKeyFromPath(workspaceB);

      await seedLedger(store, {
        version: 1,
        workspaceKey: workspaceAKey,
        workspacePath: workspaceA,
        tasks: [
          {
            id: "task-a",
            workspaceKey: workspaceAKey,
            workspacePath: workspaceA,
            name: "Alpha task",
            prompt: "Alpha",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
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
            id: "run-failed-a",
            occurrenceKey: "task-a:2026-04-27T08:00:00.000Z",
            taskId: "task-a",
            workspaceKey: workspaceAKey,
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
        workspaceKey: workspaceBKey,
        workspacePath: workspaceB,
        tasks: [
          {
            id: "task-b",
            workspaceKey: workspaceBKey,
            workspacePath: workspaceB,
            name: "Beta task",
            prompt: "Beta",
            recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "10:00" },
            recurrenceSummary: "Daily at 10:00 (Europe/Paris)",
            enabled: false,
            nextRunAt: "2099-01-01T08:00:00.000Z",
            lastRunStatus: "paused",
            createdAt: "2026-04-27T08:00:00.000Z",
            updatedAt: "2026-04-27T08:00:00.000Z"
          }
        ],
        runs: [],
        executionProfile: null,
        updatedAt: "2026-04-27T08:00:00.000Z"
      });

      server = await startHttpServer(new SchedulerService(new LocalExecutionAdapter(), store), store);
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral HTTP port.");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const pauseResponse = await fetch(`${baseUrl}/v1/global-jobs/${workspaceAKey}/task-a/actions/pause`, {
        method: "POST"
      });
      expect(pauseResponse.status).toBe(200);
      expect((await pauseResponse.json()).task.enabled).toBe(false);

      const resumeResponse = await fetch(`${baseUrl}/v1/global-jobs/${workspaceBKey}/task-b/actions/resume`, {
        method: "POST"
      });
      expect(resumeResponse.status).toBe(200);
      expect((await resumeResponse.json()).task.enabled).toBe(true);

      const runNowResponse = await fetch(`${baseUrl}/v1/global-jobs/${workspaceAKey}/task-a/actions/run-now`, {
        method: "POST"
      });
      expect(runNowResponse.status).toBe(202);
      const runNowPayload = await runNowResponse.json();
      expect(runNowPayload.run.taskId).toBe("task-a");
      expect(runNowPayload.run.status).toBe("failed");
      expect(runNowPayload.task.id).toBe("task-a");
      expect(runNowPayload.task.lastRunStatus).toBe("failed");

      const staleRetryResponse = await fetch(`${baseUrl}/v1/global-jobs/${workspaceAKey}/task-a/actions/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-stale" })
      });
      expect(staleRetryResponse.status).toBe(400);
      expect((await staleRetryResponse.json()).error).toContain("latest actionable run");

      const retryResponse = await fetch(`${baseUrl}/v1/global-jobs/${workspaceAKey}/task-a/actions/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: runNowPayload.run.id })
      });
      expect(retryResponse.status).toBe(202);
      const retryPayload = await retryResponse.json();
      expect(retryPayload.run.retryOfRunId).toBe(runNowPayload.run.id);
      expect(retryPayload.task.id).toBe("task-a");
      expect(retryPayload.task.lastRunStatus).toBe("failed");

      const refreshedA = await loadWorkspaceLedger(workspaceA);
      const refreshedB = await loadWorkspaceLedger(workspaceB);
      expect(refreshedA.tasks[0]?.enabled).toBe(false);
      expect(refreshedB.tasks[0]?.enabled).toBe(true);
    } finally {
      store.close();
      process.env.HOME = previousHome;
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("returns post-action task state for repaired ledgers without failing the action response", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-global-http-repaired-"));
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    const store = createTestRunStore();

    let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;

    try {
      const workspacePath = path.join(tempHome, "repaired");
      await mkdir(workspacePath, { recursive: true });
      const workspaceKey = workspaceKeyFromPath(workspacePath);

      await mkdir(path.join(tempHome, ".cloudcli-workspace-scheduled-prompts"), { recursive: true });
      await writeFile(
        path.join(tempHome, ".cloudcli-workspace-scheduled-prompts", `${workspaceKey}.json`),
        `${JSON.stringify(
          {
            version: 1,
            workspaceKey,
            workspacePath,
            tasks: [
              {
                id: "task-repaired",
                workspaceKey,
                workspacePath,
                name: "Repaired task",
                prompt: "Run anyway",
                recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
                recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
                enabled: true,
                nextRunAt: "2099-01-01T08:00:00.000Z",
                lastRunStatus: null,
                createdAt: "2026-04-27T08:00:00.000Z",
                updatedAt: "2026-04-27T08:00:00.000Z"
              },
              null
            ],
            runs: [],
            executionProfile: null,
            updatedAt: "2026-04-27T08:00:00.000Z"
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      server = await startHttpServer(new SchedulerService(new LocalExecutionAdapter(), store), store);
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral HTTP port.");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const runNowResponse = await fetch(`${baseUrl}/v1/global-jobs/${workspaceKey}/task-repaired/actions/run-now`, {
        method: "POST"
      });

      expect(runNowResponse.status).toBe(202);
      const payload = await runNowResponse.json();
      expect(payload.task.id).toBe("task-repaired");
      expect(payload.task.lastRunStatus).toBe("failed");
      expect(payload.run.taskId).toBe("task-repaired");
      expect(payload.run.status).toBe("failed");
    } finally {
      store.close();
      process.env.HOME = previousHome;
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("routes all global actions to the correct workspace-scoped RPC endpoints", async () => {
    const actionSnapshot: GlobalDashboardSnapshot = {
      ...snapshot,
      jobs: [
        {
          ...snapshot.jobs[0]!,
          taskId: "task-failed",
          lastRunStatus: "failed",
          latestActionableRunId: "run-failed",
          availableActions: ["run_now", "pause", "retry"]
        },
        {
          taskId: "task-paused",
          workspaceKey: "workspace-2",
          workspacePath: "/tmp/beta",
          workspaceLabel: "beta",
          workspaceDrilldownAvailable: true,
          name: "Paused job",
          scheduleType: "daily",
          recurrenceSummary: "Daily at 10:00 (Europe/Paris)",
          enabled: false,
          nextRunAt: "2099-01-01T08:00:00.000Z",
          lastRunStatus: "paused",
          lastRunFinishedAt: null,
          latestActionableRunId: null,
          workspaceAvailability: "available",
          availableActions: ["run_now", "resume"]
        }
      ]
    };
    const rpcCalls: string[] = [];
    const api: PluginAPI = {
      context: {
        theme: "light",
        project: null,
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path, body) => {
        rpcCalls.push(`${method} ${path}`);

        if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
          return actionSnapshot;
        }
        if (method === "GET" && path.startsWith("/v1/workspace-state")) {
          return {
            capability: { status: "needs_config", message: "Configure execution." },
            executionProfile: null,
            tasks: [],
            runs: []
          };
        }
        if (method === "POST" && path === "/v1/global-jobs/workspace-1/task-failed/actions/run-now") {
          return {
            task: {
              id: "task-failed",
              workspaceKey: "workspace-1",
              workspacePath: "/tmp/alpha",
              name: "Daily summary",
              prompt: "A",
              recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
              recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
              enabled: true,
              nextRunAt: "2099-01-01T08:00:00.000Z",
              lastRunStatus: "running",
              createdAt: "2026-04-27T08:00:00.000Z",
              updatedAt: "2026-04-27T08:00:00.000Z"
            },
            run: {
              id: "run-now",
              occurrenceKey: "task-failed:2026-04-27T08:00:00.000Z",
              taskId: "task-failed",
              workspaceKey: "workspace-1",
              scheduledFor: "2026-04-27T08:00:00.000Z",
              startedAt: "2026-04-27T08:00:01.000Z",
              finishedAt: null,
              status: "running",
              outcomeSummary: "running",
              failureReason: null,
              retryOfRunId: null,
              executionRequest: null
            }
          };
        }
        if (method === "POST" && path === "/v1/global-jobs/workspace-1/task-failed/actions/pause") {
          return {
            task: {
              id: "task-failed",
              workspaceKey: "workspace-1",
              workspacePath: "/tmp/alpha",
              name: "Daily summary",
              prompt: "A",
              recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
              recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
              enabled: false,
              nextRunAt: "2099-01-01T08:00:00.000Z",
              lastRunStatus: "paused",
              createdAt: "2026-04-27T08:00:00.000Z",
              updatedAt: "2026-04-27T08:00:00.000Z"
            }
          };
        }
        if (method === "POST" && path === "/v1/global-jobs/workspace-1/task-failed/actions/retry") {
          expect(body).toEqual({ runId: "run-failed" });
          return {
            task: {
              id: "task-failed",
              workspaceKey: "workspace-1",
              workspacePath: "/tmp/alpha",
              name: "Daily summary",
              prompt: "A",
              recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
              recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
              enabled: true,
              nextRunAt: "2099-01-01T08:00:00.000Z",
              lastRunStatus: "running",
              createdAt: "2026-04-27T08:00:00.000Z",
              updatedAt: "2026-04-27T08:00:00.000Z"
            },
            run: {
              id: "run-retry",
              occurrenceKey: "task-failed:2026-04-27T08:30:00.000Z",
              taskId: "task-failed",
              workspaceKey: "workspace-1",
              scheduledFor: "2026-04-27T08:30:00.000Z",
              startedAt: "2026-04-27T08:30:01.000Z",
              finishedAt: null,
              status: "running",
              outcomeSummary: "running",
              failureReason: null,
              retryOfRunId: "run-failed",
              executionRequest: null
            }
          };
        }
        if (method === "POST" && path === "/v1/global-jobs/workspace-2/task-paused/actions/resume") {
          return {
            task: {
              id: "task-paused",
              workspaceKey: "workspace-2",
              workspacePath: "/tmp/beta",
              name: "Paused job",
              prompt: "B",
              recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "10:00" },
              recurrenceSummary: "Daily at 10:00 (Europe/Paris)",
              enabled: true,
              nextRunAt: "2099-01-01T08:00:00.000Z",
              lastRunStatus: "succeeded",
              createdAt: "2026-04-27T08:00:00.000Z",
              updatedAt: "2026-04-27T08:00:00.000Z"
            }
          };
        }

        throw new Error(`Unexpected RPC: ${method} ${path}`);
      }
    };

    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, api);
    await app.mount();

    let failedRow = container.querySelector<HTMLElement>('.wsp-global-job[data-task-id="task-failed"]');
    failedRow?.querySelector<HTMLButtonElement>('button[data-action="run_now"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    failedRow = container.querySelector<HTMLElement>('.wsp-global-job[data-task-id="task-failed"]');
    failedRow?.querySelector<HTMLButtonElement>('button[data-action="pause"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    failedRow = container.querySelector<HTMLElement>('.wsp-global-job[data-task-id="task-failed"]');
    failedRow?.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    const pausedRow = container.querySelector<HTMLElement>('.wsp-global-job[data-task-id="task-paused"]');
    pausedRow?.querySelector<HTMLButtonElement>('button[data-action="resume"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(rpcCalls.some((call) => call.startsWith("GET /v1/global-dashboard"))).toBe(true);
    expect(rpcCalls.some((call) => call === "POST /v1/global-jobs/workspace-1/task-failed/actions/run-now")).toBe(true);
    expect(rpcCalls.some((call) => call === "POST /v1/global-jobs/workspace-1/task-failed/actions/pause")).toBe(true);
    expect(rpcCalls.some((call) => call === "POST /v1/global-jobs/workspace-1/task-failed/actions/retry")).toBe(true);
    expect(rpcCalls.some((call) => call === "POST /v1/global-jobs/workspace-2/task-paused/actions/resume")).toBe(true);

    app.unmount();
  }, 10_000);

  it("refreshes the global snapshot on the documented cadence", async () => {
    vi.useFakeTimers();
    let globalRequestCount = 0;
    const api: PluginAPI = {
      context: {
        theme: "light",
        project: null,
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path) => {
        if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
          globalRequestCount += 1;
          return snapshot;
        }
        if (method === "GET" && path.startsWith("/v1/workspace-state")) {
          return {
            capability: { status: "needs_config", message: "Configure execution." },
            executionProfile: null,
            tasks: [],
            runs: []
          };
        }
        throw new Error(`Unexpected RPC: ${method} ${path}`);
      }
    };

    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, api);
    await app.mount();

    expect(globalRequestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(globalRequestCount).toBe(2);

    app.unmount();
  });

  it("does not refresh the global snapshot in the background while the workspace tab is active", async () => {
    vi.useFakeTimers();
    let globalRequestCount = 0;
    const api: PluginAPI = {
      context: {
        theme: "light",
        project: { name: "alpha", path: "/tmp/alpha" },
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path) => {
        if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
          globalRequestCount += 1;
          return snapshot;
        }
        if (method === "GET" && path.startsWith("/v1/workspace-state")) {
          return {
            capability: { status: "needs_config", message: "Configure execution." },
            executionProfile: null,
            tasks: [],
            runs: []
          };
        }
        throw new Error(`Unexpected RPC: ${method} ${path}`);
      }
    };

    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, api);
    await app.mount();

    expect(globalRequestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(globalRequestCount).toBe(1);

    container.querySelectorAll<HTMLButtonElement>(".wsp-tab")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(globalRequestCount).toBe(3);

    app.unmount();
  });

  it("wires global filter changes into the backend query", async () => {
    const rpcCalls: string[] = [];
    const api: PluginAPI = {
      context: {
        theme: "light",
        project: null,
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path) => {
        rpcCalls.push(`${method} ${path}`);
        if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
          return snapshot;
        }
        if (method === "GET" && path.startsWith("/v1/workspace-state")) {
          return {
            capability: { status: "needs_config", message: "Configure execution." },
            executionProfile: null,
            tasks: [],
            runs: []
          };
        }
        throw new Error(`Unexpected RPC: ${method} ${path}`);
      }
    };

    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, api);
    await app.mount();

    const statusSelect = container.querySelector<HTMLSelectElement>('select[name="statusFilter"]');
    statusSelect!.value = "problem";
    statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const sortSelect = container.querySelector<HTMLSelectElement>('select[name="sortBy"]');
    sortSelect!.value = "name";
    sortSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(rpcCalls.some((call) => call.includes("/v1/global-dashboard?sortBy=urgency"))).toBe(true);
    expect(rpcCalls.some((call) => call.includes("/v1/global-dashboard?status=problem&sortBy=urgency"))).toBe(true);
    expect(rpcCalls.some((call) => call.includes("/v1/global-dashboard?status=problem&sortBy=name"))).toBe(true);

    app.unmount();
  });
});
