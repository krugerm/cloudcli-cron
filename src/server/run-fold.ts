import type { RunEvent, RunStatus, ScheduledRun, WorkspaceTask } from "../shared/model.js";

export const STARTED_SUMMARY = "Command started.";
export const RECOVERY_SUMMARY = "Plugin server restarted while this run was in progress.";
export const MISSED_UNAVAILABLE_SUMMARY = "Automatic execution was unavailable at the scheduled time.";
export const SAVE_FAILED_SUMMARY = "Could not save the schedule; run not started.";

export function foldRun(events: RunEvent[]): ScheduledRun {
  if (!events.length) {
    throw new Error("foldRun needs at least one event");
  }
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const started = ordered.find((entry) => entry.type === "started");

  return {
    id: first.runId,
    occurrenceKey: first.occurrenceKey,
    taskId: first.taskId,
    workspaceKey: first.workspaceKey,
    scheduledFor: first.scheduledFor,
    sequence: first.seq,
    startedAt: started?.at ?? null,
    finishedAt: last.type === "started" ? null : last.at,
    status: last.type === "started" ? "running" : last.type,
    outcomeSummary: last.summary,
    failureReason: last.failureReason ?? null,
    retryOfRunId: first.retryOfRunId ?? null,
    executionRequest: started?.executionRequest ?? null
  };
}

export function deriveLastRunStatus(task: WorkspaceTask, latest: ScheduledRun | null | undefined): RunStatus | null {
  return latest?.status ?? task.legacyLastRunStatus ?? null;
}
