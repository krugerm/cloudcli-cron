import * as os from "node:os";
import path from "node:path";
import type http from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { startHttpServer } from "../../src/server/http.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";

const daily = { scheduleType: "daily" as const, timezone: "Europe/Paris", localTime: "09:00" };

describe("runs API", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let workspacePath: string;
  let store: RunStore;
  let scheduler: SchedulerService;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-runs-api-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    store = new RunStore(":memory:");
    scheduler = new SchedulerService(new LocalExecutionAdapter(), store);
    server = await startHttpServer(scheduler, store);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  const get = async (url: string) => {
    const response = await fetch(`${baseUrl}${url}`);
    return { status: response.status, body: await response.json() };
  };

  it("pages with before, filters by taskId and validates limit and cursor", async () => {
    const a = await scheduler.createTask({ workspacePath, name: "A", prompt: "A", recurrence: daily });
    const b = await scheduler.createTask({ workspacePath, name: "B", prompt: "B", recurrence: daily });
    for (let index = 0; index < 3; index += 1) {
      await scheduler.createManualRun(a.id, workspacePath);
      await scheduler.createManualRun(b.id, workspacePath);
    }
    const wp = encodeURIComponent(workspacePath);

    const first = await get(`/v1/runs?workspacePath=${wp}&limit=4`);
    expect(first.status).toBe(200);
    expect(first.body.runs).toHaveLength(4);
    const second = await get(`/v1/runs?workspacePath=${wp}&limit=4&before=${first.body.nextCursor}`);
    expect(second.body.runs).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.runs, ...second.body.runs].map((run: { id: string }) => run.id);
    expect(new Set(ids).size).toBe(6);

    const filtered = await get(`/v1/runs?workspacePath=${wp}&taskId=${a.id}`);
    expect(filtered.body.runs.every((run: { taskId: string }) => run.taskId === a.id)).toBe(true);
    expect(filtered.body.runs).toHaveLength(3);

    expect(await get(`/v1/runs?workspacePath=${wp}&limit=abc`)).toEqual({ status: 400, body: { error: "limit must be an integer" } });
    expect(await get(`/v1/runs?workspacePath=${wp}&before=xyz`)).toEqual({ status: 400, body: { error: "invalid cursor" } });
  });

  it("returns a run's events with retryOf, and 404 for another workspace", async () => {
    const task = await scheduler.createTask({ workspacePath, name: "A", prompt: "A", recurrence: daily });
    const original = await scheduler.createManualRun(task.id, workspacePath);
    const retry = await scheduler.retryRun(original.id, workspacePath);
    const wp = encodeURIComponent(workspacePath);

    const events = await get(`/v1/runs/${retry.id}/events?workspacePath=${wp}`);
    expect(events.status).toBe(200);
    expect(events.body.events.map((entry: { type: string; source: string }) => [entry.type, entry.source])).toEqual([["failed", "retry"]]);
    expect(events.body.retryOf).toEqual({ id: original.id, scheduledFor: original.scheduledFor });

    const plain = await get(`/v1/runs/${original.id}/events?workspacePath=${wp}`);
    expect(plain.body.retryOf).toBeNull();

    const otherPath = encodeURIComponent(path.join(tempHome, "other"));
    expect(await get(`/v1/runs/${original.id}/events?workspacePath=${otherPath}`)).toEqual({ status: 404, body: { error: "Run not found" } });
    expect(await get(`/v1/runs/missing/events?workspacePath=${wp}`)).toEqual({ status: 404, body: { error: "Run not found" } });
  });
});
