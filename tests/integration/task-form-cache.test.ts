// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/recurrence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/recurrence.js")>();
  return { ...actual, validateRecurrenceDefinition: vi.fn(actual.validateRecurrenceDefinition) };
});

const recurrence = await import("../../src/server/recurrence.js");
const { renderTaskForm } = await import("../../src/client/views/task-form.js");

function type(section: HTMLElement, name: string, value: string): void {
  const field = section.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("task form validation cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-validate an unchanged cron expression while other fields change", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:10.000Z"));
    const section = renderTaskForm(null, { onSubmit: vi.fn(), onCancelEdit: vi.fn() });
    type(section, "prompt", "P");
    type(section, "scheduleType", "cron");
    type(section, "cronExpression", "0 9 31 4,6,9,11 *");
    type(section, "name", "N");
    const validate = vi.mocked(recurrence.validateRecurrenceDefinition);
    validate.mockClear();
    type(section, "name", "Na");
    type(section, "name", "Nam");
    type(section, "name", "Name");
    expect(validate).not.toHaveBeenCalled();
    expect(section.querySelector('[data-testid="task-form-feedback"]')?.textContent).toBe("This cron expression never matches a date.");
  });

  it("re-validates once the minute rolls over", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:10.000Z"));
    const section = renderTaskForm(null, { onSubmit: vi.fn(), onCancelEdit: vi.fn() });
    type(section, "prompt", "P");
    type(section, "scheduleType", "cron");
    type(section, "cronExpression", "0 9 31 4,6,9,11 *");
    type(section, "name", "N");
    const validate = vi.mocked(recurrence.validateRecurrenceDefinition);
    validate.mockClear();
    type(section, "name", "Na");
    expect(validate).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-11-02T10:01:10.000Z"));
    type(section, "name", "Nam");
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
