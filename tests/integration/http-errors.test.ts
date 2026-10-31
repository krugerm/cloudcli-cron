import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { startHttpServer } from "../../src/server/http.js";
import { HttpError } from "../../src/server/http-error.js";
import type { RunStore } from "../../src/server/run-store.js";
import type { SchedulerService } from "../../src/server/scheduler.js";

describe("http error mapping", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function post(scheduler: Partial<SchedulerService>, url: string): Promise<Response> {
    server = await startHttpServer(scheduler as SchedulerService, {} as RunStore);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral port");
    }
    return fetch(`http://127.0.0.1:${address.port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspacePath: "/tmp/project" })
    });
  }

  it("uses the HttpError status", async () => {
    const response = await post(
      {
        retryRun: async () => {
          throw new HttpError(404, "Run not found");
        }
      },
      "/v1/runs/run-1/actions/retry"
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Run not found" });
  });

  it("keeps 400 for plain errors", async () => {
    const response = await post(
      {
        retryRun: async () => {
          throw new Error("Task not found");
        }
      },
      "/v1/runs/run-1/actions/retry"
    );
    expect(response.status).toBe(400);
  });
});
