// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { WorkspaceScheduledPromptsApp } from "../../src/client/app.js";
import type { PluginAPI } from "../../src/types.js";

function createApi(): PluginAPI {
  return {
    context: {
      theme: "light",
      project: { name: "project", path: "/tmp/project" },
      session: null
    },
    onContextChange: () => () => undefined,
    rpc: async (method, path) => {
      if (method === "GET" && path.startsWith("/v1/workspace-state")) {
        return {
          capability: { status: "needs_config", message: "Configure execution." },
          executionProfile: null,
          tasks: [],
          runs: []
        };
      }
      if (method === "GET" && path.startsWith("/v1/global-dashboard")) {
        return {
          generatedAt: "2026-04-27T08:00:00.000Z",
          summary: {
            totalJobs: 0,
            activeJobs: 0,
            pausedJobs: 0,
            problemJobs: 0,
            workspacesTotal: 0,
            workspacesDegraded: 0
          },
          jobs: [],
          workspaces: [],
          partialData: false,
          warnings: []
        };
      }
      if (method === "GET" && path.startsWith("/v1/runs?")) {
        return { runs: [], nextCursor: null };
      }
      throw new Error(`Unexpected RPC: ${method} ${path}`);
    }
  };
}

describe("app reconciliation", () => {
  it("does not show success when workspace refresh fails after an action", async () => {
    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, createApi());
    await app.mount();

    const stateStore = (app as any).state;
    (app as any).loadFromContext = async () => {
      stateStore.patch({
        busy: false,
        error: "Reload failed.",
        successMessage: null
      });
      return false;
    };

    await (app as any).reconcileWorkspaceState("/tmp/project", "Schedule deleted.", null);

    expect(container.textContent).toContain("Reload failed.");
    expect(container.textContent).not.toContain("Schedule deleted.");

    app.unmount();
  }, 10_000);

  it("renders banner text literally instead of as HTML", async () => {
    const container = document.createElement("div");
    const app = new WorkspaceScheduledPromptsApp(container, createApi());
    await app.mount();

    (app as any).state.patch({ busy: false, error: null, successMessage: "Created <b>x</b>" });

    expect(container.textContent).toContain("Created <b>x</b>");
    expect(container.querySelector(".wsp-banner b")).toBeNull();

    app.unmount();
  });
});
