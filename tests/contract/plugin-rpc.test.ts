import { describe, expect, it } from "vitest";
import {
  parseCreateTaskRequest,
  parseExecutionProfileRequest,
  type GlobalDashboardActionResponse,
  type GlobalDashboardResponse,
  parseGlobalDashboardQuery,
  parseGlobalDashboardRetryRequest,
  parseListRunsQuery,
  parseUpdateTaskRequest,
  parseWorkspaceScopedRequest
} from "../../src/shared/contracts.js";
import { normalizeExecutionProfile } from "../../src/server/settings.js";
import { PluginRpcClient } from "../../src/client/api.js";

describe("plugin RPC contracts", () => {
  it("parses run list queries", () => {
    expect(parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p&limit=20&before=41&taskId=t1"))).toEqual({
      workspacePath: "/tmp/p",
      limit: 20,
      before: "41",
      taskId: "t1"
    });
    expect(parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p"))).toEqual({
      workspacePath: "/tmp/p",
      limit: undefined,
      before: undefined,
      taskId: undefined
    });
    expect(() => parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p&limit=abc"))).toThrow("limit must be an integer");
    expect(parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p&limit=")).limit).toBeUndefined();
    expect(parseListRunsQuery(new URLSearchParams("workspacePath=/tmp/p&limit=%20")).limit).toBeUndefined();
    expect(() => parseListRunsQuery(new URLSearchParams("limit=5"))).toThrow("workspacePath is required");
  });

  it("parses workspace-scoped payloads", () => {
    expect(parseWorkspaceScopedRequest({ workspacePath: "/tmp/project" })).toEqual({
      workspacePath: "/tmp/project"
    });
  });

  it("parses workspace-scoped lifecycle action payloads", () => {
    for (const payload of [
      { workspacePath: "/tmp/project" }, // pause
      { workspacePath: "/tmp/project" }, // resume
      { workspacePath: "/tmp/project" }, // duplicate
      { workspacePath: "/tmp/project" }, // run-now
      { workspacePath: "/tmp/project" } // retry
    ]) {
      expect(parseWorkspaceScopedRequest(payload)).toEqual({ workspacePath: "/tmp/project" });
    }
  });

  it("parses create-task payloads", () => {
    const parsed = parseCreateTaskRequest({
      workspacePath: "/tmp/project",
      name: "Morning summary",
      prompt: "Summarize open work.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    expect(parsed.name).toBe("Morning summary");
    expect(parsed.recurrence.scheduleType).toBe("daily");
  });

  it("rejects malformed create-task payloads", () => {
    expect(() =>
      parseCreateTaskRequest({
        workspacePath: "/tmp/project",
        name: "Morning summary",
        prompt: "Summarize open work."
      })
    ).toThrow("recurrence must be an object");
  });

  it("rejects invalid update payloads", () => {
    expect(() =>
      parseUpdateTaskRequest({
        workspacePath: "/tmp/project",
        enabled: "yes"
      })
    ).toThrow("enabled must be a boolean");
  });

  it("rejects whitespace-only update strings", () => {
    expect(() =>
      parseUpdateTaskRequest({
        workspacePath: "/tmp/project",
        name: "   "
      })
    ).toThrow("name must be a non-empty string when provided");

    expect(() =>
      parseUpdateTaskRequest({
        workspacePath: "/tmp/project",
        prompt: "   "
      })
    ).toThrow("prompt must be a non-empty string when provided");
  });

  it("parses enabled state updates for pause and resume transitions", () => {
    expect(parseUpdateTaskRequest({
      workspacePath: "/tmp/project",
      enabled: false
    }).enabled).toBe(false);

    expect(parseUpdateTaskRequest({
      workspacePath: "/tmp/project",
      enabled: true
    }).enabled).toBe(true);
  });

  it("parses execution profile payloads", () => {
    const parsed = parseExecutionProfileRequest({
      workspacePath: "/tmp/project",
      command: "codex",
      args: ["exec", "--json"],
      timeoutMs: 120000
    });

    expect(parsed.command).toBe("codex");
    expect(parsed.args[0]).toBe("exec");
  });

  it("accepts an execution profile with no explicit args", () => {
    const parsed = parseExecutionProfileRequest({
      workspacePath: "/tmp/project",
      command: "/usr/local/bin/run-scheduled-prompt",
      args: []
    });

    expect(parsed.command).toContain("run-scheduled-prompt");
    expect(parsed.args).toEqual([]);
  });

  it("normalizes the legacy codex preset arguments", () => {
    const profile = normalizeExecutionProfile({
      workspaceKey: "workspace-1",
      command: "codex",
      args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--ask-for-approval", "never"],
      timeoutMs: 300000,
      mode: "local_command",
      lastValidatedAt: null,
      validationStatus: "needs_config"
    });

    expect(profile?.args).toEqual(["-a", "never", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
  });

  it("parses global dashboard query filters", () => {
    const query = parseGlobalDashboardQuery(
      new URLSearchParams({
        status: "problem",
        workspaceKey: "workspace-1",
        sortBy: "workspace"
      })
    );

    expect(query).toEqual({
      status: "problem",
      workspaceKey: "workspace-1",
      sortBy: "workspace"
    });
  });

  it("defaults global dashboard sorting to urgency", () => {
    const query = parseGlobalDashboardQuery(new URLSearchParams());
    expect(query.sortBy).toBe("urgency");
  });

  it("rejects invalid global dashboard query values", () => {
    expect(() => parseGlobalDashboardQuery(new URLSearchParams({ status: "broken" }))).toThrow(
      "status must be one of: healthy, problem, paused, running, failed, missed, never_run"
    );
  });

  it("parses global retry payloads", () => {
    expect(parseGlobalDashboardRetryRequest({ runId: "run-1" })).toEqual({ runId: "run-1" });
  });

  it("rejects malformed global retry payloads", () => {
    expect(() => parseGlobalDashboardRetryRequest({})).toThrow("runId must be a non-empty string");
  });

  it("captures the global dashboard response baseline fields", () => {
    const response: GlobalDashboardResponse = {
      generatedAt: "2026-04-27T08:00:00.000Z",
      summary: {
        totalJobs: 1,
        activeJobs: 1,
        pausedJobs: 0,
        problemJobs: 1,
        workspacesTotal: 1,
        workspacesDegraded: 0
      },
      jobs: [
        {
          taskId: "task-1",
          workspaceKey: "workspace-1",
          workspacePath: "/tmp/project",
          workspaceLabel: "project",
          name: "Morning summary",
          scheduleType: "daily",
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt: "2026-04-28T07:00:00.000Z",
          lastRunStatus: "never_run",
          lastRunFinishedAt: null,
          latestActionableRunId: null,
          workspaceAvailability: "available",
          workspaceDrilldownAvailable: true,
          availableActions: ["run_now", "pause"]
        }
      ],
      workspaces: [
        {
          workspaceKey: "workspace-1",
          workspacePath: "/tmp/project",
          workspaceLabel: "project",
          status: "available",
          jobCount: 1,
          warning: null
        }
      ],
      partialData: false,
      warnings: []
    };

    expect(response.jobs[0]?.workspaceLabel).toBe("project");
    expect(response.summary.totalJobs).toBe(1);
    expect(response.partialData).toBe(false);
  });

  it("captures the global action response shape", () => {
    const response = {
      task: {
        id: "task-1",
        workspaceKey: "workspace-1",
        workspacePath: "/tmp/project",
        name: "Morning summary",
        prompt: "Summarize",
        recurrence: {
          scheduleType: "daily",
          timezone: "Europe/Paris",
          localTime: "09:00"
        },
        recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
        enabled: false,
        nextRunAt: "2026-04-28T07:00:00.000Z",
        lastRunStatus: "paused",
        createdAt: "2026-04-26T10:00:00.000Z",
        updatedAt: "2026-04-27T08:00:00.000Z"
      },
      run: {
        id: "run-1",
        occurrenceKey: "task-1:2026-04-27T08:00:00.000Z",
        taskId: "task-1",
        workspaceKey: "workspace-1",
        scheduledFor: "2026-04-27T08:00:00.000Z",
        sequence: 1,
        startedAt: "2026-04-27T08:00:01.000Z",
        finishedAt: "2026-04-27T08:00:10.000Z",
        status: "succeeded",
        outcomeSummary: "ok",
        failureReason: null,
        retryOfRunId: null,
        executionRequest: null
      }
    } satisfies GlobalDashboardActionResponse;

    expect(response.task.workspacePath).toBe("/tmp/project");
    expect(response.run?.status).toBe("succeeded");
  });

  it("routes global action RPC helpers to the documented endpoints", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new PluginRpcClient({
      context: {
        theme: "light",
        project: null,
        session: null
      },
      onContextChange: () => () => undefined,
      rpc: async (method, path, body) => {
        calls.push({ method, path, body });
        return {} as never;
      }
    });

    await client.globalRunNow("workspace-1", "task/1");
    await client.globalPauseTask("workspace-1", "task/1");
    await client.globalResumeTask("workspace-1", "task/1");
    await client.globalRetryTask("workspace-1", "task/1", { runId: "run-1" });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/global-jobs/workspace-1/task%2F1/actions/run-now",
        body: undefined
      },
      {
        method: "POST",
        path: "/v1/global-jobs/workspace-1/task%2F1/actions/pause",
        body: undefined
      },
      {
        method: "POST",
        path: "/v1/global-jobs/workspace-1/task%2F1/actions/resume",
        body: undefined
      },
      {
        method: "POST",
        path: "/v1/global-jobs/workspace-1/task%2F1/actions/retry",
        body: { runId: "run-1" }
      }
    ]);
  });

  it("supports all documented global sorts and workspace availability states", () => {
    expect(parseGlobalDashboardQuery(new URLSearchParams({ sortBy: "next_run" })).sortBy).toBe("next_run");
    expect(parseGlobalDashboardQuery(new URLSearchParams({ sortBy: "workspace" })).sortBy).toBe("workspace");
    expect(parseGlobalDashboardQuery(new URLSearchParams({ sortBy: "name" })).sortBy).toBe("name");

    const response: GlobalDashboardResponse = {
      generatedAt: "2026-04-27T08:00:00.000Z",
      summary: {
        totalJobs: 3,
        activeJobs: 2,
        pausedJobs: 1,
        problemJobs: 2,
        workspacesTotal: 2,
        workspacesDegraded: 1
      },
      jobs: [],
      workspaces: [
        {
          workspaceKey: "workspace-1",
          workspacePath: "/tmp/alpha",
          workspaceLabel: "alpha",
          status: "available",
          jobCount: 2,
          warning: null
        },
        {
          workspaceKey: "workspace-2",
          workspacePath: "/tmp/beta",
          workspaceLabel: "beta",
          status: "partial",
          jobCount: 1,
          warning: "Workspace path is unavailable."
        }
      ],
      partialData: true,
      warnings: ["Workspace path is unavailable."]
    };

    expect(response.summary.problemJobs).toBe(2);
    expect(response.workspaces[1]?.status).toBe("partial");
    expect(response.workspaces[1]?.warning).toContain("unavailable");
  });
});
