import type { NewRunEvent } from "../shared/model.js";
import { RECOVERY_SUMMARY, STARTED_SUMMARY } from "./run-fold.js";
import { isObject } from "./storage.js";

export interface LegacyRun {
  id: string;
  occurrenceKey: string;
  taskId: string;
  workspaceKey: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  outcomeSummary: string;
  failureReason: string | null;
  retryOfRunId: string | null;
  executionRequest: Record<string, unknown> | null;
}

export const IMPORTABLE_LEGACY_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "missed", "running"]);

export function isLegacyRunEntry(value: unknown): value is LegacyRun {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.occurrenceKey === "string" &&
    typeof value.taskId === "string" &&
    typeof value.workspaceKey === "string" &&
    typeof value.scheduledFor === "string" &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    (typeof value.finishedAt === "string" || value.finishedAt === null) &&
    typeof value.status === "string" &&
    typeof value.outcomeSummary === "string" &&
    (typeof value.failureReason === "string" || value.failureReason === null) &&
    (typeof value.retryOfRunId === "string" || value.retryOfRunId === null) &&
    (isObject(value.executionRequest) || value.executionRequest === null)
  );
}

function normalizeIso(value: string): string | null {
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

/** Recording time used for import order: startedAt ?? finishedAt ?? scheduledFor, normalized. */
export function legacyRecordingTime(run: LegacyRun): string {
  return normalizeIso(run.startedAt ?? run.finishedAt ?? run.scheduledFor) ?? run.scheduledFor;
}

/** Stable sort by recording time; equal times keep their order in the file. */
export function sortLegacyRunsForImport<T extends { run: LegacyRun }>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, time: legacyRecordingTime(entry.run) }))
    .sort((left, right) => left.time.localeCompare(right.time) || left.index - right.index)
    .map((item) => item.entry);
}

/** Events for one v0.2.0 run, or null when the run cannot be imported (counted as invalid). */
export function eventsForLegacyRun(run: LegacyRun, workspaceKey: string, now: string): NewRunEvent[] | null {
  if (!IMPORTABLE_LEGACY_STATUSES.has(run.status)) {
    return null;
  }
  const scheduledFor = normalizeIso(run.scheduledFor);
  const startedAt = run.startedAt === null ? null : normalizeIso(run.startedAt);
  const finishedAt = run.finishedAt === null ? null : normalizeIso(run.finishedAt);
  if (!scheduledFor || (run.startedAt !== null && !startedAt) || (run.finishedAt !== null && !finishedAt)) {
    return null;
  }

  const base = {
    runId: run.id,
    workspaceKey,
    taskId: run.taskId,
    occurrenceKey: run.occurrenceKey,
    scheduledFor,
    retryOfRunId: run.retryOfRunId
  };

  if (run.status === "running") {
    return [
      { ...base, type: "started", at: startedAt ?? scheduledFor, source: "migrated", summary: STARTED_SUMMARY, executionRequest: run.executionRequest },
      { ...base, type: "failed", at: now, source: "recovery", summary: RECOVERY_SUMMARY, failureReason: RECOVERY_SUMMARY }
    ];
  }

  const events: NewRunEvent[] = [];
  if (startedAt) {
    events.push({ ...base, type: "started", at: startedAt, source: "migrated", summary: STARTED_SUMMARY, executionRequest: run.executionRequest });
  }
  events.push({
    ...base,
    type: run.status as "succeeded" | "failed" | "missed",
    at: finishedAt ?? startedAt ?? scheduledFor,
    source: "migrated",
    summary: run.outcomeSummary,
    failureReason: run.failureReason
  });
  return events;
}
