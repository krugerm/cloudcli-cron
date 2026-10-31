// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { WorkspaceScheduledPromptsApp } from "../../src/client/app.js";
import type { PluginAPI } from "../../src/types.js";

type Call = { method: string; path: string };

function makeRun(id: number) {
  return {
    id: `r${id}`,
    occurrenceKey: `t:${id}`,
    taskId: "t1",
    workspaceKey: "ws",
    scheduledFor: "2026-04-27T07:00:00.000Z",
    sequence: id,
    startedAt: null,
    finishedAt: "2026-04-27T07:00:00.000Z",
    status: "missed",
    outcomeSummary: `run ${id}`,
    failureReason: "late",
    retryOfRunId: null,
    executionRequest: null
  };
}

function page(fromSequence: number, count: number) {
  const runs = Array.from({ length: count }, (_, index) => makeRun(fromSequence - index));
  const last = fromSequence - count + 1;
  return { runs, nextCursor: last > 1 ? String(last) : null };
}

function createHarness(handlers: Partial<Record<string, (path: string) => Promise<unknown>>> = {}) {
  const calls: Call[] = [];
  const api: PluginAPI = {
    context: { theme: "light", project: { name: "project", path: "/tmp/project" }, session: null },
    onContextChange: () => () => undefined,
    rpc: async (method, path) => {
      calls.push({ method, path });
      for (const [prefix, handler] of Object.entries(handlers)) {
        if (`${method} ${path}`.startsWith(prefix)) {
          return handler!(path);
        }
      }
      if (method === "GET" && path.startsWith("/v1/workspace-state")) {
        return {
          capability: { status: "needs_config", message: "Configure." },
          executionProfile: null,
          tasks: [],
          runs: [makeRun(999)],
          runsNextCursor: "999"
        };
      }
      if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
        return { generatedAt: "x", summary: { totalJobs: 0, activeJobs: 0, pausedJobs: 0, problemJobs: 0, workspacesTotal: 0, workspacesDegraded: 0 }, jobs: [], workspaces: [], partialData: false, warnings: [] };
      }
      if (method === "GET" && path.startsWith("/v1/runs?")) {
        const params = new URLSearchParams(path.split("?")[1]);
        const before = params.get("before");
        const limit = Number(params.get("limit") ?? "100");
        return page(before ? Number(before) - 1 : 1000, limit);
      }
      throw new Error(`Unexpected RPC: ${method} ${path}`);
    }
  };
  const container = document.createElement("div");
  const app = new WorkspaceScheduledPromptsApp(container, api);
  return { app, container, calls, state: () => (app as any).state.snapshot };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

describe("app run list", () => {
  it("loads runs from GET /v1/runs, ignoring the state response's runs", async () => {
    const { app, state, calls } = createHarness();
    await app.mount();
    expect(state().runs[0].id).toBe("r1000");
    expect(state().runsNextCursor).toBe("901");
    expect(calls.some((call) => call.path.startsWith("/v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100"))).toBe(true);
    app.unmount();
  });

  it("reloads as many runs as are shown (3 pages -> 300) after an action", async () => {
    const { app, state, calls } = createHarness({ "POST /v1/tasks/t1/actions/run-now": async () => ({ run: makeRun(5000) }) });
    await app.mount();
    await (app as any).loadOlderRuns();
    await (app as any).loadOlderRuns();
    expect(state().runs).toHaveLength(300);
    await (app as any).reconcileWorkspaceState("/tmp/project", "done", null);
    expect(calls.filter((call) => call.path.includes("limit=300"))).toHaveLength(1);
    expect(state().runs).toHaveLength(300);
    app.unmount();
  });

  it("drops a Load older response once a reload, filter change or workspace switch was sent after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, state } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100&before=": async (path) => {
        await gate;
        const before = Number(new URLSearchParams(path.split("?")[1]).get("before"));
        return page(before - 1, 100);
      }
    });
    await app.mount();
    const older = (app as any).loadOlderRuns();
    await (app as any).setRunsTaskFilter("t1");
    release();
    await older;
    await flush();
    expect(state().runsTaskFilter).toBe("t1");
    expect(state().runs).toHaveLength(100);
    app.unmount();
  });

  it("resets a task filter whose task no longer exists on refresh and reloads unfiltered", async () => {
    const { app, state, calls } = createHarness();
    await app.mount();
    await (app as any).setRunsTaskFilter("gone");
    calls.length = 0;
    await app.loadFromContext("/tmp/project", "refresh");
    expect(state().runsTaskFilter).toBeNull();
    const listCalls = calls.filter((call) => call.path.startsWith("/v1/runs?"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].path).not.toContain("taskId=");
    app.unmount();
  });

  it("applies only the later-sent of two overlapping reloads", async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    const { app, state } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=": async () => {
        calls += 1;
        if (calls === 2) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return { runs: [makeRun(1)], nextCursor: null };
        }
        return page(1000, 100);
      }
    });
    await app.mount();
    const first = (app as any).reloadRuns("/tmp/project", 100);
    await flush();
    await (app as any).reloadRuns("/tmp/project", 100);
    releaseFirst();
    await first;
    expect(state().runs).toHaveLength(100);
    app.unmount();
  });

  // Review Focus 4: double-click on Load older
  it("ignores a second Load older click while the first is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, state, calls } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100&before=": async (path) => {
        await gate;
        const before = Number(new URLSearchParams(path.split("?")[1]).get("before"));
        return page(before - 1, 100);
      }
    });
    await app.mount();
    const a = (app as any).loadOlderRuns();
    const b = (app as any).loadOlderRuns();
    release();
    await Promise.all([a, b]);
    expect(calls.filter((call) => call.path.includes("before="))).toHaveLength(1);
    const ids = state().runs.map((run: { id: string }) => run.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(200);
    app.unmount();
  });

  it("does not prepend the Run Now result; the reload brings it in", async () => {
    let gateReloads = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const reloadReached = new Promise<void>((resolve) => { reached = resolve; });
    const { app, state, container } = createHarness({
      "POST /v1/tasks/t1/actions/run-now": async () => ({ run: makeRun(424242) }),
      "GET /v1/runs?": async (path) => {
        const limit = Number(new URLSearchParams(path.split("?")[1]).get("limit") ?? "100");
        if (gateReloads) {
          reached();
          await gate;
        }
        return page(1000, limit);
      }
    });
    await app.mount();
    const before = state().runs.length;
    (app as any).state.patch({ tasks: [{ id: "t1", workspaceKey: "ws", workspacePath: "/tmp/project", name: "T", prompt: "P", recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" }, recurrenceSummary: "Daily", enabled: true, nextRunAt: null, lastRunStatus: null, createdAt: "x", updatedAt: "x" }] });
    gateReloads = true;
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Run Now")?.click();
    await reloadReached;
    await flush();
    expect(state().runs.some((run: { id: string }) => run.id === "r424242")).toBe(false);
    expect(state().runs).toHaveLength(before);
    release();
    await vi.waitFor(() => expect(state().successMessage).toBe("Manual run finished."));
    expect(state().runs.some((run: { id: string }) => run.id === "r424242")).toBe(false);
    expect(state().runs).toHaveLength(100);
    app.unmount();
  });

  it("drops a Load older response whose cursor a reload landing first has moved", async () => {
    let releaseReload!: () => void;
    let releaseOlder!: () => void;
    const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let reloadCalls = 0;
    const { app, state } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100&before=": async () => {
        await olderGate;
        return page(900, 100);
      },
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=": async () => {
        reloadCalls += 1;
        if (reloadCalls === 2) {
          await reloadGate;
          return { runs: page(1000, 100).runs, nextCursor: "500" };
        }
        return page(1000, 100);
      }
    });
    await app.mount();
    const reload = (app as any).reloadRuns("/tmp/project", 100);
    await flush();
    const older = (app as any).loadOlderRuns();
    await flush();
    releaseReload();
    await reload;
    expect(state().runsNextCursor).toBe("500");
    releaseOlder();
    await older;
    await flush();
    expect(state().runs).toHaveLength(100);
    expect(state().runsNextCursor).toBe("500");
    app.unmount();
  });

  it("drops a Load older response that was in flight across a workspace switch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, state } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100&before=": async () => {
        await gate;
        return page(900, 100);
      }
    });
    await app.mount();
    const older = (app as any).loadOlderRuns();
    await flush();
    await app.loadFromContext("/tmp/other");
    expect(state().runs).toHaveLength(100);
    release();
    await older;
    await flush();
    expect(state().workspacePath).toBe("/tmp/other");
    expect(state().runs).toHaveLength(100);
    expect(state().runsNextCursor).toBe("901");
    app.unmount();
  });

  it("keeps Load older disabled for the new workspace when a stale request from the old one settles", async () => {
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
    const { app, state } = createHarness({
      "GET /v1/runs?workspacePath=%2Ftmp%2Fproject&limit=100&before=": async () => {
        await oldGate;
        return page(900, 100);
      },
      "GET /v1/runs?workspacePath=%2Ftmp%2Fother&limit=100&before=": async () => {
        await newGate;
        return page(900, 100);
      }
    });
    await app.mount();
    const oldOlder = (app as any).loadOlderRuns();
    await flush();
    await app.loadFromContext("/tmp/other");
    const newOlder = (app as any).loadOlderRuns();
    await flush();
    expect(state().runsLoadingOlder).toBe(true);
    releaseOld();
    await oldOlder;
    await flush();
    expect(state().runsLoadingOlder).toBe(true);
    releaseNew();
    await newOlder;
    expect(state().runsLoadingOlder).toBe(false);
    expect(state().runs).toHaveLength(200);
    app.unmount();
  });

  it("keeps 3 loaded pages after a global-dashboard action on the loaded workspace", async () => {
    const { app, state, calls } = createHarness({
      "POST /v1/global-jobs/ws/t1/actions/run-now": async () => ({
        task: { id: "t1", name: "T", workspaceKey: "ws", workspacePath: "/tmp/project" },
        run: makeRun(5000)
      })
    });
    await app.mount();
    await (app as any).loadOlderRuns();
    await (app as any).loadOlderRuns();
    expect(state().runs).toHaveLength(300);
    await (app as any).dispatchGlobalAction("run_now", "ws", "t1");
    expect(calls.filter((call) => call.path.includes("limit=300"))).toHaveLength(1);
    expect(state().runs).toHaveLength(300);
    app.unmount();
  });

  it("keeps the task filter and loaded pages after Run Now under a task filter", async () => {
    const task = { id: "t1", workspaceKey: "ws", workspacePath: "/tmp/project", name: "T", prompt: "P", recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" }, recurrenceSummary: "Daily", enabled: true, nextRunAt: null, lastRunStatus: null, createdAt: "x", updatedAt: "x" };
    const { app, state, calls, container } = createHarness({
      "POST /v1/tasks/t1/actions/run-now": async () => ({ run: makeRun(5000) }),
      "GET /v1/workspace-state": async () => ({ capability: { status: "needs_config", message: "Configure." }, executionProfile: null, tasks: [task], runs: [], runsNextCursor: null })
    });
    await app.mount();
    await (app as any).setRunsTaskFilter("t1");
    await (app as any).loadOlderRuns();
    await (app as any).loadOlderRuns();
    expect(state().runs).toHaveLength(300);
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Run Now")?.click();
    await vi.waitFor(() => expect(calls.some((call) => call.path.includes("limit=300"))).toBe(true));
    const reload = calls.find((call) => call.path.includes("limit=300"))!;
    expect(new URLSearchParams(reload.path.split("?")[1]).get("taskId")).toBe("t1");
    await flush();
    expect(state().runsTaskFilter).toBe("t1");
    expect(state().runs).toHaveLength(300);
    app.unmount();
  });

  it("clears the list and filter before the workspace-state request of a workspace switch", async () => {
    let seen: { runs: number; filter: string | null } | null = null;
    let app!: WorkspaceScheduledPromptsApp;
    const h = createHarness({
      "GET /v1/workspace-state?workspacePath=%2Ftmp%2Fother": async () => {
        const snapshot = (app as any).state.snapshot;
        seen = { runs: snapshot.runs.length, filter: snapshot.runsTaskFilter };
        return { capability: { status: "needs_config", message: "x" }, executionProfile: null, tasks: [], runs: [] };
      }
    });
    app = h.app;
    await app.mount();
    await (app as any).setRunsTaskFilter("t1");
    expect(h.state().runs.length).toBeGreaterThan(0);
    await app.loadFromContext("/tmp/other");
    expect(seen).toEqual({ runs: 0, filter: null });
    expect(h.state().runsTaskFilter).toBeNull();
    app.unmount();
  });
});
