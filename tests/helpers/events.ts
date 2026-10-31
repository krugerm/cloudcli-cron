import type { NewRunEvent } from "../../src/shared/model.js";

export function newEvent(partial: Partial<NewRunEvent> & Pick<NewRunEvent, "runId" | "type">): NewRunEvent {
  return {
    workspaceKey: "ws-a",
    taskId: "task-1",
    occurrenceKey: `task-1:${partial.runId}`,
    scheduledFor: "2026-04-27T07:00:00.000Z",
    at: "2026-04-27T07:00:01.000Z",
    source: "scheduler",
    summary: partial.type === "started" ? "Command started." : "done",
    ...partial
  };
}
