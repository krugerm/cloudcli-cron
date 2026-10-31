// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderExecutionBanner } from "../../src/client/views/execution-banner.js";
import { renderRunHistory } from "../../src/client/views/run-history.js";

describe("execution banner", () => {
  it("applies presets and submits local execution settings", () => {
    const onSave = vi.fn();
    const section = renderExecutionBanner({
      status: "needs_config",
      message: "Configure a local execution command to enable automatic prompt runs."
    }, null, { onSave });

    const preset = section.querySelector<HTMLSelectElement>('[name="preset"]');
    const command = section.querySelector<HTMLInputElement>('[name="command"]');
    const args = section.querySelector<HTMLTextAreaElement>('[name="args"]');
    const timeout = section.querySelector<HTMLInputElement>('[name="timeoutMs"]');

    if (!preset || !command || !args || !timeout) {
      throw new Error("Execution fields failed to render");
    }

    preset.value = "codex";
    preset.dispatchEvent(new Event("change", { bubbles: true }));

    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith({
      command: "codex",
      args: ["-a", "never", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      timeoutMs: 300000
    });
  });
});

describe("run history", () => {
  it("renders status and failure details", () => {
    const onRetry = vi.fn();
    const section = renderRunHistory([
      {
        id: "run-1",
        occurrenceKey: "task-1:2026-04-27T07:00:00.000Z",
        taskId: "task-1",
        workspaceKey: "workspace-1",
        scheduledFor: "2026-04-27T07:00:00.000Z",
        startedAt: "2026-04-27T07:00:01.000Z",
        finishedAt: "2026-04-27T07:00:02.000Z",
        status: "failed",
        outcomeSummary: "Command exited with code 2.",
        failureReason: "Command exited with code 2.",
        retryOfRunId: null,
        executionRequest: null
      }
    ], { onRetry });

    expect(section.textContent).toContain("Failed");
    expect(section.textContent).toContain("Command exited with code 2.");
    expect(section.textContent).toContain("Scheduled for");

    section.querySelector("button")?.click();
    expect(onRetry).toHaveBeenCalledWith("run-1");
  });

  it("renders run output as text instead of executable markup", () => {
    const section = renderRunHistory([
      {
        id: "run-2",
        occurrenceKey: "task-1:2026-04-27T07:00:00.000Z",
        taskId: "task-1",
        workspaceKey: "workspace-1",
        scheduledFor: "2026-04-27T07:00:00.000Z",
        startedAt: "2026-04-27T07:00:01.000Z",
        finishedAt: "2026-04-27T07:00:02.000Z",
        status: "failed",
        outcomeSummary: "<img src=x onerror=alert(1)>",
        failureReason: "<script>alert(1)</script>",
        retryOfRunId: null,
        executionRequest: null
      }
    ], { onRetry: vi.fn() });

    expect(section.querySelector("img")).toBeNull();
    expect(section.querySelector("script")).toBeNull();
    expect(section.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(section.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("run history paging and events", () => {
  const run = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    occurrenceKey: `task-1:${id}`,
    taskId: "task-1",
    workspaceKey: "ws",
    scheduledFor: "2026-04-27T07:00:00.000Z",
    sequence: 1,
    startedAt: "2026-04-27T07:00:01.000Z",
    finishedAt: "2026-04-27T07:00:02.000Z",
    status: "succeeded" as const,
    outcomeSummary: "ok",
    failureReason: null,
    retryOfRunId: null,
    executionRequest: null,
    ...extra
  });

  it("renders the task filter and Load older, and disables Load older while loading", () => {
    const onSelectTask = vi.fn();
    const onLoadOlder = vi.fn();
    const section = renderRunHistory([run("r1")], { onRetry: vi.fn(), onSelectTask, onLoadOlder }, {
      tasks: [{ id: "task-1", name: "Daily" }, { id: "task-2", name: "Weekly" }],
      taskFilter: null,
      hasMore: true
    });
    const select = section.querySelector<HTMLSelectElement>('select[name="runsTaskFilter"]')!;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["All tasks", "Daily", "Weekly"]);
    select.value = "task-2";
    select.dispatchEvent(new Event("change"));
    expect(onSelectTask).toHaveBeenCalledWith("task-2");

    section.querySelector<HTMLButtonElement>('button[data-action="load-older"]')!.click();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    const loading = renderRunHistory([run("r1")], { onRetry: vi.fn(), onLoadOlder }, { hasMore: true, loadingOlder: true });
    expect(loading.querySelector<HTMLButtonElement>('button[data-action="load-older"]')!.disabled).toBe(true);
    expect(renderRunHistory([run("r1")], { onRetry: vi.fn() }, { hasMore: false }).querySelector('[data-action="load-older"]')).toBeNull();
  });

  it("loads events on every History open and shows the retryOf line", async () => {
    const onLoadEvents = vi.fn().mockResolvedValue({
      events: [
        { seq: 1, runId: "r2", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "2026-04-27T07:00:00.000Z", type: "started", at: "2026-04-27T07:00:01.000Z", source: "retry", summary: "Command started." },
        { seq: 2, runId: "r2", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "2026-04-27T07:00:00.000Z", type: "failed", at: "2026-04-27T07:00:02.000Z", source: "recovery", summary: "x" }
      ],
      retryOf: { id: "r1", scheduledFor: "2026-04-26T07:00:00.000Z" }
    });
    const section = renderRunHistory([run("r2", { retryOfRunId: "r1" })], { onRetry: vi.fn(), onLoadEvents });
    const toggle = section.querySelector<HTMLButtonElement>('button[data-action="history"]')!;
    toggle.click();
    await vi.waitFor(() => expect(section.textContent).toContain("Retry of run scheduled for"));
    expect(section.textContent).toContain("started");
    expect(section.textContent).toContain("recovery");
    toggle.click();
    toggle.click();
    await vi.waitFor(() => expect(onLoadEvents).toHaveBeenCalledTimes(2));
  });

  it("shows only the response of the most recent History open", async () => {
    let resolveFirst!: (value: unknown) => void;
    const onLoadEvents = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ events: [{ seq: 9, runId: "r1", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "x", type: "succeeded", at: "2026-04-27T07:00:02.000Z", source: "scheduler", summary: "fresh" }], retryOf: null });
    const section = renderRunHistory([run("r1")], { onRetry: vi.fn(), onLoadEvents });
    const toggle = section.querySelector<HTMLButtonElement>('button[data-action="history"]')!;
    toggle.click();
    toggle.click();
    toggle.click();
    await vi.waitFor(() => expect(section.textContent).toContain("succeeded"));
    resolveFirst({ events: [{ seq: 1, runId: "r1", workspaceKey: "ws", taskId: "task-1", occurrenceKey: "k", scheduledFor: "x", type: "started", at: "2026-04-27T07:00:01.000Z", source: "scheduler", summary: "stale" }], retryOf: null });
    await Promise.resolve();
    const items = section.querySelectorAll(".wsp-run-events li");
    expect(items).toHaveLength(1);
    expect(items[0].textContent!.startsWith("succeeded")).toBe(true);
  });
});
