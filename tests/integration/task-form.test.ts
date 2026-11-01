// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTaskForm } from "../../src/client/views/task-form.js";
import { renderScheduleList } from "../../src/client/views/schedule-list.js";
import type { WorkspaceTask } from "../../src/shared/model.js";

function seedForm(section: HTMLElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const field = section.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
    if (!field) {
      continue;
    }
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

describe("task form", () => {
  it("blocks invalid schedules and shows feedback", () => {
    const onSubmit = vi.fn();
    const section = renderTaskForm(null, {
      onSubmit,
      onCancelEdit: vi.fn()
    });

    seedForm(section, {
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      scheduleType: "daily",
      timezone: "Europe/Paris",
      localTime: "25:00"
    });

    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(section.querySelector('[data-testid="task-form-feedback"]')?.textContent).toContain("localTime");
  });

  it("shows a recurrence preview and submits a valid schedule", () => {
    const onSubmit = vi.fn();
    const section = renderTaskForm(null, {
      onSubmit,
      onCancelEdit: vi.fn()
    });

    seedForm(section, {
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      scheduleType: "daily",
      timezone: "Europe/Paris",
      localTime: "09:00"
    });

    const preview = section.querySelector('[data-testid="task-form-preview"]');
    expect(preview?.textContent).toContain("Daily at 09:00");

    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders edit mode and supports canceling edits", () => {
    const task: WorkspaceTask = {
      id: "task-1",
      workspaceKey: "workspace-1",
      workspacePath: "/tmp/project",
      name: "Weekly review",
      prompt: "Review changes",
      recurrence: {
        scheduleType: "weekly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfWeek: "monday"
      },
      recurrenceSummary: "Every monday at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: "2026-04-27T07:00:00.000Z",
      lastRunStatus: null,
      createdAt: "2026-04-26T10:00:00.000Z",
      updatedAt: "2026-04-26T10:00:00.000Z"
    };

    const onCancelEdit = vi.fn();
    const section = renderTaskForm(task, {
      onSubmit: vi.fn(),
      onCancelEdit
    });

    expect(section.querySelector("h2")?.textContent).toContain("Edit");
    section.querySelector<HTMLButtonElement>('[data-testid="cancel-edit"]')?.click();
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
  });
});

describe("task form — cron", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function cronForm(task: WorkspaceTask | null = null) {
    const onSubmit = vi.fn();
    const section = renderTaskForm(task, { onSubmit, onCancelEdit: vi.fn() });
    return { section, onSubmit };
  }
  const submit = (section: HTMLElement) =>
    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const scope = (section: HTMLElement, name: string) =>
    section.querySelector<HTMLElement>(`[data-schedule-scope="${name}"]`);

  it("shows the cron field and hides Local Time when Cron is chosen", () => {
    const { section } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "Europe/Amsterdam" });
    expect(scope(section, "cron")?.hidden).toBe(false);
    expect(scope(section, "timed")?.hidden).toBe(true);
    expect(section.querySelector<HTMLInputElement>('[name="cronExpression"]')?.value).toBe("0 9 * * MON-FRI");
  });

  it("previews the summary and exactly 5 runs in English", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T08:00:00.000Z"));
    const { section } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "Europe/Amsterdam", cronExpression: "0 9 * * MON-FRI" });
    expect(section.querySelector('[data-testid="task-form-summary"]')?.textContent).toBe(
      "At 09:00, Monday through Friday (Europe/Amsterdam)"
    );
    const runs = [...section.querySelectorAll('[data-testid="task-form-run"]')].map((node) => node.textContent);
    expect(runs).toEqual(["Tue 3 Nov 09:00", "Wed 4 Nov 09:00", "Thu 5 Nov 09:00", "Fri 6 Nov 09:00", "Mon 9 Nov 09:00"]);
    expect(section.querySelector('[data-testid="task-form-warning"]')).toBeNull();
  });

  it.each([
    ["0 9 15W * *", "W (nearest weekday) is not supported."],
    ["H 9 * * *", "H (random values) is not supported."]
  ])("blocks %s with its message", (cronExpression, message) => {
    const { section, onSubmit } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "Europe/Amsterdam", cronExpression });
    submit(section);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(section.querySelector('[data-testid="task-form-feedback"]')?.textContent).toBe(message);
  });

  it("warns for a frequent expression and still submits it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00.000Z"));
    const { section, onSubmit } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "UTC", cronExpression: "* * * * *" });
    expect(section.querySelector('[data-testid="task-form-warning"]')?.textContent).toBe(
      "Runs as often as every 1 min, 1,440 times in 24 hours. Each run sends the prompt to Claude."
    );
    submit(section);
    expect(onSubmit).toHaveBeenCalledWith({
      name: "N",
      prompt: "P",
      recurrence: { scheduleType: "cron", timezone: "UTC", expression: "* * * * *" }
    });
  });

  it("submits the normalised expression", () => {
    const { section, onSubmit } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "UTC", cronExpression: "  @DAILY " });
    submit(section);
    expect(onSubmit.mock.calls[0]?.[0].recurrence).toEqual({ scheduleType: "cron", timezone: "UTC", expression: "@daily" });
  });

  const cronTask = (overrides: Partial<WorkspaceTask> = {}): WorkspaceTask => ({
    id: "task-cron",
    workspaceKey: "workspace-1",
    workspacePath: "/tmp/project",
    name: "Cron task",
    prompt: "Go",
    recurrence: { scheduleType: "cron", timezone: "Europe/Amsterdam", expression: "*/15 9-17 * * MON-FRI" },
    recurrenceSummary: "Every 15 minutes, between 09:00 and 17:59, Monday through Friday (Europe/Amsterdam)",
    enabled: true,
    nextRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides
  });

  it("edits a cron task with its stored expression", () => {
    const { section } = cronForm(cronTask());
    expect(section.querySelector<HTMLSelectElement>('[name="scheduleType"]')?.value).toBe("cron");
    expect(section.querySelector<HTMLInputElement>('[name="cronExpression"]')?.value).toBe("*/15 9-17 * * MON-FRI");
  });

  // Review Focus 2
  it("switching a daily task to Cron saves the default", () => {
    const daily = cronTask({ recurrence: { scheduleType: "daily", timezone: "UTC", localTime: "09:00" }, recurrenceSummary: "Daily" });
    const { section, onSubmit } = cronForm(daily);
    seedForm(section, { scheduleType: "cron" });
    submit(section);
    expect(onSubmit.mock.calls[0]?.[0].recurrence).toEqual({ scheduleType: "cron", timezone: "UTC", expression: "0 9 * * MON-FRI" });
  });

  it("renders quotes and angle brackets as text in the form and the schedule list", () => {
    const tricky = 'Say "hi" <b>now</b>';
    const task = cronTask({
      name: tricky,
      recurrence: { scheduleType: "cron", timezone: "Europe/Amsterdam", expression: '0 9 * * "<x>"' },
      recurrenceSummary: `Cron: 0 9 * * "<x>" (Europe/Amsterdam)`
    });
    const { section } = cronForm(task);
    expect(section.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe(tricky);
    expect(section.querySelector<HTMLInputElement>('[name="cronExpression"]')?.value).toBe('0 9 * * "<x>"');
    expect(section.querySelector("b")).toBeNull();

    const list = renderScheduleList([task], {
      onEdit: vi.fn(), onDelete: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onDuplicate: vi.fn(), onRunNow: vi.fn()
    });
    expect(list.querySelector("strong")?.textContent).toBe(tricky);
    expect(list.querySelector(".wsp-task-head p")?.textContent).toBe(`Cron: 0 9 * * "<x>" (Europe/Amsterdam)`);
    expect(list.querySelector("b")).toBeNull();
  });
});
