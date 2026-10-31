import http from "node:http";
import { URL } from "node:url";
import type {
  GlobalDashboardActionResponse,
  GlobalDashboardResponse,
  GlobalDashboardRetryRequest,
  ExecutionProfileResponse,
  ListRunsResponse,
  RunEventsResponse,
  RunResponse,
  TaskResponse,
  WorkspaceStateResponse
} from "../shared/contracts.js";
import {
  parseCreateTaskRequest,
  parseExecutionProfileRequest,
  parseGlobalDashboardQuery,
  parseGlobalDashboardRetryRequest,
  parseListRunsQuery,
  parseUpdateTaskRequest,
  parseWorkspaceScopedRequest
} from "../shared/contracts.js";
import type { ExecutionCapability, ExecutionProfile } from "../shared/model.js";
import { buildGlobalDashboardSnapshot, readGlobalTaskState, resolveGlobalTask } from "./dashboard.js";
import { HttpError } from "./http-error.js";
import type { RunStore } from "./run-store.js";
import { resolveExecutionCapability } from "./settings.js";
import { SchedulerService } from "./scheduler.js";

function json<T>(response: http.ServerResponse, statusCode: number, body: T): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function noContent(response: http.ServerResponse): void {
  response.statusCode = 204;
  response.end();
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createCapability(headers: http.IncomingHttpHeaders, profile: ExecutionProfile | null): ExecutionCapability {
  void headers;
  return resolveExecutionCapability(profile ?? null);
}

async function loadTaskAfterAction(
  workspaceKey: string,
  taskId: string,
  runStore: RunStore
) {
  return readGlobalTaskState(workspaceKey, taskId, runStore);
}

export function createHttpHandler(scheduler: SchedulerService, runStore: RunStore): http.RequestListener {
  return async (request, response) => {
    try {
      if (!request.url || !request.method) {
        json(response, 400, { error: "Invalid request" });
        return;
      }

      const url = new URL(request.url, "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/workspace-state") {
        const workspacePath = url.searchParams.get("workspacePath");
        if (!workspacePath) {
          throw new Error("workspacePath is required");
        }
        const payload: WorkspaceStateResponse = await scheduler.loadWorkspaceState(workspacePath, (profile) =>
          createCapability(request.headers, profile)
        );
        json(response, 200, payload);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/global-dashboard") {
        const payload: GlobalDashboardResponse = await buildGlobalDashboardSnapshot(
          parseGlobalDashboardQuery(url.searchParams),
          runStore
        );
        json(response, 200, payload);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/runs") {
        const query = parseListRunsQuery(url.searchParams);
        const page = await scheduler.listRuns(query.workspacePath, {
          limit: query.limit,
          before: query.before ?? null,
          taskId: query.taskId ?? null
        });
        json(response, 200, { runs: page.runs, nextCursor: page.nextCursor } satisfies ListRunsResponse);
        return;
      }

      if (request.method === "GET" && segments[0] === "v1" && segments[1] === "runs" && segments[2] && segments[3] === "events" && segments.length === 4) {
        const workspacePath = url.searchParams.get("workspacePath");
        if (!workspacePath) {
          throw new Error("workspacePath is required");
        }
        const payload: RunEventsResponse = await scheduler.listRunEvents(decodeURIComponent(segments[2]), workspacePath);
        json(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const task = await scheduler.createTask(parseCreateTaskRequest(await readJsonBody(request)));
        const payload: TaskResponse = { task };
        json(response, 201, payload);
        return;
      }

      if (request.method === "PUT" && url.pathname === "/v1/execution-profile") {
        const profile = await scheduler.saveExecutionProfile(parseExecutionProfileRequest(await readJsonBody(request)));
        const capability = createCapability(request.headers, profile);
        const payload: ExecutionProfileResponse = { capability, executionProfile: profile };
        json(response, 200, payload);
        return;
      }

      if (segments[0] === "v1" && segments[1] === "tasks" && segments[2]) {
        const taskId = segments[2];

        if (request.method === "PATCH" && segments.length === 3) {
          const task = await scheduler.updateTask(taskId, parseUpdateTaskRequest(await readJsonBody(request)));
          const payload: TaskResponse = { task };
          json(response, 200, payload);
          return;
        }

        if (request.method === "DELETE" && segments.length === 3) {
          const workspacePath = url.searchParams.get("workspacePath");
          if (!workspacePath) {
            throw new Error("workspacePath is required");
          }
          await scheduler.deleteTask(taskId, workspacePath);
          noContent(response);
          return;
        }

        if (request.method === "POST" && segments[3] === "actions" && segments[4]) {
          const scoped = parseWorkspaceScopedRequest(await readJsonBody(request));
          switch (segments[4]) {
            case "pause": {
              const task = await scheduler.pauseTask(taskId, scoped.workspacePath);
              json(response, 200, { task } satisfies TaskResponse);
              return;
            }
            case "resume": {
              const task = await scheduler.resumeTask(taskId, scoped.workspacePath);
              json(response, 200, { task } satisfies TaskResponse);
              return;
            }
            case "duplicate": {
              const task = await scheduler.duplicateTask(taskId, scoped.workspacePath);
              json(response, 201, { task } satisfies TaskResponse);
              return;
            }
            case "run-now": {
              const run = await scheduler.createManualRun(taskId, scoped.workspacePath);
              json(response, 202, { run } satisfies RunResponse);
              return;
            }
            default:
              break;
          }
        }
      }

      if (segments[0] === "v1" && segments[1] === "runs" && segments[2] && request.method === "POST" && segments[3] === "actions" && segments[4] === "retry") {
        const scoped = parseWorkspaceScopedRequest(await readJsonBody(request));
        const run = await scheduler.retryRun(segments[2], scoped.workspacePath);
        json(response, 202, { run } satisfies RunResponse);
        return;
      }

      if (
        segments[0] === "v1" &&
        segments[1] === "global-jobs" &&
        segments[2] &&
        segments[3] &&
        request.method === "POST" &&
        segments[4] === "actions" &&
        segments[5]
      ) {
        const workspaceKey = segments[2];
        const taskId = segments[3];
        const target = await resolveGlobalTask(workspaceKey, taskId, runStore);

        switch (segments[5]) {
          case "run-now": {
            const run = await scheduler.createManualRun(taskId, target.workspacePath);
            const task = await loadTaskAfterAction(workspaceKey, taskId, runStore);
            json(response, 202, { task, run } satisfies GlobalDashboardActionResponse);
            return;
          }
          case "pause": {
            const task = await scheduler.pauseTask(taskId, target.workspacePath);
            json(response, 200, { task } satisfies GlobalDashboardActionResponse);
            return;
          }
          case "resume": {
            const task = await scheduler.resumeTask(taskId, target.workspacePath);
            json(response, 200, { task } satisfies GlobalDashboardActionResponse);
            return;
          }
          case "retry": {
            const retryRequest: GlobalDashboardRetryRequest = parseGlobalDashboardRetryRequest(await readJsonBody(request));
            if (target.latestActionableRunId !== retryRequest.runId) {
              throw new Error("runId must match the latest actionable run for this task");
            }
            const run = await scheduler.retryRun(retryRequest.runId, target.workspacePath);
            const task = await loadTaskAfterAction(workspaceKey, taskId, runStore);
            json(response, 202, { task, run } satisfies GlobalDashboardActionResponse);
            return;
          }
          default:
            break;
        }
      }

      json(response, 404, { error: "Route not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      json(response, error instanceof HttpError ? error.status : 400, { error: message });
    }
  };
}

export async function startHttpServer(scheduler: SchedulerService, runStore: RunStore): Promise<http.Server> {
  const server = http.createServer(createHttpHandler(scheduler, runStore));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server;
}
