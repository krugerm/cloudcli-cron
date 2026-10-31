import { randomUUID } from "node:crypto";
import type {
  CreateTaskRequest,
  ExecutionProfileRequest,
  UpdateTaskRequest,
  WorkspaceStateResponse
} from "../shared/contracts.js";
import type {
  ExecutionCapability,
  ExecutionProfile,
  RunEventSource,
  ScheduledRun,
  WorkspaceLedger,
  WorkspaceTask
} from "../shared/model.js";
import { normalizeWorkspacePath, workspaceKeyFromPath } from "../shared/workspace.js";
import {
  computeTaskNextRun,
  formatRecurrenceSummary,
  occurrenceKeyForTask,
  validateRecurrenceDefinition
} from "./recurrence.js";
import type { ExecutionRequestMetadata, LocalExecutionAdapter } from "./execution-adapter.js";
import { HttpError } from "./http-error.js";
import { deriveLastRunStatus, MISSED_UNAVAILABLE_SUMMARY, SAVE_FAILED_SUMMARY, STARTED_SUMMARY } from "./run-fold.js";
import type { ListRunsOptions, RunPage, RunStore } from "./run-store.js";
import { createExecutionProfile, normalizeExecutionProfile, resolveExecutionCapability } from "./settings.js";
import { listWorkspaceLedgers, loadWorkspaceLedger, saveWorkspaceLedger } from "./storage.js";

const EXECUTION_GRACE_WINDOW_MS = 90_000;

function nowIso(): string {
  return new Date().toISOString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isValidRecurrence(recurrence: WorkspaceTask["recurrence"]): boolean {
  try {
    validateRecurrenceDefinition(recurrence);
    return true;
  } catch {
    return false;
  }
}

function isOutsideExecutionGraceWindow(scheduledFor: string, referenceIso: string): boolean {
  const scheduledAt = Date.parse(scheduledFor);
  const referenceAt = Date.parse(referenceIso);
  if (Number.isNaN(scheduledAt) || Number.isNaN(referenceAt)) {
    return true;
  }
  return referenceAt - scheduledAt > EXECUTION_GRACE_WINDOW_MS;
}

function manualOccurrenceKey(taskId: string, runId: string): string {
  return `${taskId}:manual:${runId}`;
}

export function logTickError(error: unknown, workspaceKey?: string): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[scheduled-prompts] tick error${workspaceKey ? ` (workspace ${workspaceKey})` : ""}: ${detail}\n`);
}

interface RunBase {
  runId: string;
  workspaceKey: string;
  taskId: string;
  occurrenceKey: string;
  scheduledFor: string;
  source: RunEventSource;
  retryOfRunId: string | null;
}

interface ClaimedRun {
  base: RunBase;
  task: WorkspaceTask;
  profile: ExecutionProfile;
  executionRequest: ExecutionRequestMetadata;
}

type ClaimOutcome =
  | { kind: "skipped"; nextRunAt: null }
  | { kind: "advanced"; nextRunAt: string | null }
  | { kind: "started"; nextRunAt: string | null; run: ClaimedRun };

export class SchedulerService {
  private readonly inFlightOccurrences = new Set<string>();
  private readonly ledgerLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly executionAdapter: LocalExecutionAdapter,
    private readonly runStore: RunStore
  ) {}

  /** Per-workspace lock; reloads the ledger, runs fn, saves only if fn changed it. Not re-entrant. */
  private async mutateLedger<T>(workspacePath: string, fn: (ledger: WorkspaceLedger) => T | Promise<T>): Promise<T> {
    const lockKey = workspaceKeyFromPath(workspacePath);
    const previous = this.ledgerLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.ledgerLocks.set(lockKey, chained);
    await previous;
    try {
      const ledger = await loadWorkspaceLedger(workspacePath);
      const before = JSON.stringify(ledger);
      const result = await fn(ledger);
      if (JSON.stringify(ledger) !== before) {
        await saveWorkspaceLedger(ledger);
      }
      return result;
    } finally {
      release();
      if (this.ledgerLocks.get(lockKey) === chained) {
        this.ledgerLocks.delete(lockKey);
      }
    }
  }

  private withDerivedStatus(workspaceKey: string, tasks: WorkspaceTask[]): WorkspaceTask[] {
    const summaries = this.runStore.taskRunSummaries(workspaceKey, tasks.map((task) => task.id));
    return tasks.map((task) => ({
      ...task,
      lastRunStatus: deriveLastRunStatus(task, summaries.get(task.id)?.latest)
    }));
  }

  private requireRun(runId: string): ScheduledRun {
    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new Error("Run was not recorded");
    }
    return run;
  }

  /** The refresh never moves a nextRunAt that is already due: the tick owns past-due slots. */
  private refreshLocked(ledger: WorkspaceLedger): void {
    const normalizedProfile = normalizeExecutionProfile(ledger.executionProfile);
    if (JSON.stringify(normalizedProfile) !== JSON.stringify(ledger.executionProfile)) {
      ledger.executionProfile = normalizedProfile;
    }
    const now = nowIso();
    for (const task of ledger.tasks) {
      task.recurrenceSummary = formatRecurrenceSummary(task.recurrence);
      const due = task.enabled && task.nextRunAt !== null && task.nextRunAt <= now;
      if (!due) {
        task.nextRunAt = computeTaskNextRun(task, now);
      }
    }
  }

  async loadWorkspaceState(
    workspacePath: string,
    capabilityFor: (profile: ExecutionProfile | null) => ExecutionCapability
  ): Promise<WorkspaceStateResponse> {
    return this.mutateLedger(workspacePath, (ledger) => {
      this.refreshLocked(ledger);
      const workspaceKey = workspaceKeyFromPath(ledger.workspacePath);
      const page = this.runStore.listRuns(workspaceKey);
      return {
        capability: capabilityFor(ledger.executionProfile),
        executionProfile: ledger.executionProfile,
        tasks: this.withDerivedStatus(workspaceKey, ledger.tasks),
        runs: page.runs,
        runsNextCursor: page.nextCursor
      };
    });
  }

  /** Read-only: no lock, no refresh, no save. */
  async listRuns(workspacePath: string, options: ListRunsOptions = {}): Promise<RunPage> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    return this.runStore.listRuns(workspaceKeyFromPath(ledger.workspacePath), options);
  }

  async createTask(request: CreateTaskRequest): Promise<WorkspaceTask> {
    validateRecurrenceDefinition(request.recurrence);
    const task = await this.mutateLedger(request.workspacePath, (ledger) => {
      const createdAt = nowIso();
      const created: WorkspaceTask = {
        id: randomUUID(),
        workspaceKey: ledger.workspaceKey,
        workspacePath: normalizeWorkspacePath(request.workspacePath),
        name: request.name.trim(),
        prompt: request.prompt.trim(),
        recurrence: request.recurrence,
        recurrenceSummary: formatRecurrenceSummary(request.recurrence),
        enabled: true,
        nextRunAt: null,
        lastRunStatus: null,
        createdAt,
        updatedAt: createdAt
      };
      created.nextRunAt = computeTaskNextRun(created, createdAt);
      ledger.tasks.push(created);
      return { ...created };
    });
    return this.withDerivedStatus(workspaceKeyFromPath(request.workspacePath), [task])[0]!;
  }

  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<WorkspaceTask> {
    const task = await this.mutateLedger(request.workspacePath, (ledger) => this.updateTaskLocked(ledger, taskId, request));
    return this.withDerivedStatus(workspaceKeyFromPath(request.workspacePath), [task])[0]!;
  }

  /** nextRunAt rules (design §2 "nextRunAt on task edits"); the first matching row wins. */
  private updateTaskLocked(ledger: WorkspaceLedger, taskId: string, request: UpdateTaskRequest): WorkspaceTask {
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    const wasEnabled = task.enabled;
    let recurrenceChanged = false;
    if (request.recurrence) {
      validateRecurrenceDefinition(request.recurrence);
      recurrenceChanged = !isValidRecurrence(task.recurrence) || canonicalJson(request.recurrence) !== canonicalJson(task.recurrence);
      task.recurrence = request.recurrence;
    }
    if (request.name !== undefined) {
      task.name = request.name.trim();
    }
    if (request.prompt !== undefined) {
      task.prompt = request.prompt.trim();
    }
    if (request.enabled !== undefined) {
      task.enabled = request.enabled;
    }
    task.updatedAt = nowIso();
    task.recurrenceSummary = formatRecurrenceSummary(task.recurrence);

    if (wasEnabled && !task.enabled) {
      task.nextRunAt = null;
    } else if (!wasEnabled && task.enabled) {
      task.nextRunAt = computeTaskNextRun(task, task.updatedAt);
    } else if (recurrenceChanged) {
      task.nextRunAt = computeTaskNextRun(task, task.updatedAt);
    }
    return { ...task };
  }

  async deleteTask(taskId: string, workspacePath: string): Promise<void> {
    await this.mutateLedger(workspacePath, (ledger) => {
      ledger.tasks = ledger.tasks.filter((task) => task.id !== taskId);
    });
  }

  async pauseTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: false });
  }

  async resumeTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: true });
  }

  async duplicateTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    const copy = await this.mutateLedger(workspacePath, (ledger) => {
      const source = ledger.tasks.find((task) => task.id === taskId);
      if (!source) {
        throw new Error("Task not found");
      }
      const createdAt = nowIso();
      const duplicate: WorkspaceTask = {
        ...source,
        id: randomUUID(),
        name: `${source.name} (Copy)`,
        createdAt,
        updatedAt: createdAt,
        lastRunStatus: null
      };
      delete duplicate.legacyLastRunStatus;
      duplicate.recurrenceSummary = formatRecurrenceSummary(duplicate.recurrence);
      duplicate.nextRunAt = computeTaskNextRun(duplicate, createdAt);
      ledger.tasks.push(duplicate);
      return { ...duplicate };
    });
    return this.withDerivedStatus(workspaceKeyFromPath(workspacePath), [copy])[0]!;
  }

  async saveExecutionProfile(request: ExecutionProfileRequest): Promise<ExecutionProfile> {
    return this.mutateLedger(request.workspacePath, (ledger) => {
      ledger.executionProfile = createExecutionProfile({
        workspaceKey: ledger.workspaceKey,
        command: request.command,
        args: request.args,
        timeoutMs: request.timeoutMs
      });
      return ledger.executionProfile;
    });
  }

  async createManualRun(taskId: string, workspacePath: string): Promise<ScheduledRun> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    return this.runManually(ledger, { ...task }, null);
  }

  async retryRun(runId: string, workspacePath: string): Promise<ScheduledRun> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const existing = this.runStore.getRun(runId);
    if (!existing || existing.workspaceKey !== workspaceKeyFromPath(ledger.workspacePath)) {
      throw new HttpError(404, "Run not found");
    }
    const task = ledger.tasks.find((entry) => entry.id === existing.taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    return this.runManually(ledger, { ...task }, existing.id);
  }

  /** Manual runs and retries never claim and never move nextRunAt. */
  private async runManually(ledger: WorkspaceLedger, task: WorkspaceTask, retryOfRunId: string | null): Promise<ScheduledRun> {
    const runId = randomUUID();
    const base: RunBase = {
      runId,
      workspaceKey: workspaceKeyFromPath(ledger.workspacePath),
      taskId: task.id,
      occurrenceKey: manualOccurrenceKey(task.id, runId),
      scheduledFor: nowIso(),
      source: retryOfRunId ? "retry" : "manual",
      retryOfRunId
    };
    const profile = ledger.executionProfile;
    const capability = resolveExecutionCapability(profile ?? null);
    if (capability.status !== "ready" || !profile) {
      const summary = `Manual execution could not start. ${capability.message}`;
      this.runStore.appendEvent({ ...base, type: "failed", at: nowIso(), summary, failureReason: summary });
      return this.requireRun(runId);
    }

    const executionRequest = this.executionAdapter.createRequest(task, profile, base.scheduledFor);
    this.inFlightOccurrences.add(base.occurrenceKey);
    try {
      this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
      await this.executeAndRecord({ base, task, profile, executionRequest });
    } finally {
      this.inFlightOccurrences.delete(base.occurrenceKey);
    }
    return this.requireRun(runId);
  }

  /** Runs the adapter outside any lock and appends the final event. */
  private async executeAndRecord(run: ClaimedRun): Promise<void> {
    let final: { type: "succeeded" | "failed"; summary: string; failureReason: string | null };
    try {
      const result = await this.executionAdapter.execute(run.task, run.profile, run.base.scheduledFor, run.executionRequest);
      final = { type: result.status, summary: result.outcomeSummary, failureReason: result.failureReason };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local command execution failed.";
      final = { type: "failed", summary: message, failureReason: message };
    }
    this.runStore.appendEvent({ ...run.base, ...final, at: nowIso() });
  }

  async tickWithoutDispatcher(): Promise<void> {
    const ledgers = await listWorkspaceLedgers();
    for (const snapshot of ledgers) {
      const workspaceKey = workspaceKeyFromPath(snapshot.workspacePath);
      try {
        await this.tickWorkspace(snapshot);
      } catch (error) {
        logTickError(error, workspaceKey);
      }
    }
  }

  private async tickWorkspace(snapshot: WorkspaceLedger): Promise<void> {
    const tickStartedAt = nowIso();
    for (const viewTask of snapshot.tasks) {
      let scheduledFor = viewTask.enabled ? viewTask.nextRunAt : null;
      while (scheduledFor && scheduledFor <= tickStartedAt) {
        const outcome = await this.claimOccurrence(snapshot.workspacePath, viewTask.id, scheduledFor, tickStartedAt);
        if (outcome.kind === "started") {
          try {
            await this.executeAndRecord(outcome.run);
          } finally {
            this.inFlightOccurrences.delete(outcome.run.base.occurrenceKey);
          }
          break;
        }
        if (outcome.kind === "skipped") {
          break;
        }
        scheduledFor = outcome.nextRunAt;
      }
    }
  }

  /** Compare-and-set inside the lock (design §2 "Claiming a scheduled occurrence"). */
  private async claimOccurrence(
    workspacePath: string,
    taskId: string,
    scheduledFor: string,
    tickStartedAt: string
  ): Promise<ClaimOutcome> {
    const claim: { addedKey?: string; started?: ClaimedRun } = {};
    try {
      return await this.mutateLedger(workspacePath, (ledger): ClaimOutcome => {
        const task = ledger.tasks.find((entry) => entry.id === taskId);
        if (!task || !task.enabled || task.nextRunAt !== scheduledFor) {
          return { kind: "skipped", nextRunAt: null };
        }
        const workspaceKey = workspaceKeyFromPath(ledger.workspacePath);
        const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
        task.nextRunAt = computeTaskNextRun(task, scheduledFor);
        if (this.inFlightOccurrences.has(occurrenceKey) || this.runStore.hasOccurrence(workspaceKey, occurrenceKey)) {
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        const base: RunBase = {
          runId: randomUUID(),
          workspaceKey,
          taskId: task.id,
          occurrenceKey,
          scheduledFor,
          source: "scheduler",
          retryOfRunId: null
        };
        const profile = ledger.executionProfile;
        const capability = resolveExecutionCapability(profile ?? null);
        if (capability.status !== "ready" || !profile || isOutsideExecutionGraceWindow(scheduledFor, tickStartedAt)) {
          const summary = capability.status !== "ready" ? capability.message : MISSED_UNAVAILABLE_SUMMARY;
          this.runStore.appendEvent({ ...base, type: "missed", at: nowIso(), summary, failureReason: summary });
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        const executionRequest = this.executionAdapter.createRequest(task, profile, scheduledFor);
        this.inFlightOccurrences.add(occurrenceKey);
        claim.addedKey = occurrenceKey;
        this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
        claim.started = { base, task: { ...task }, profile, executionRequest };
        return { kind: "started", nextRunAt: task.nextRunAt, run: claim.started };
      });
    } catch (error) {
      if (claim.addedKey) {
        this.inFlightOccurrences.delete(claim.addedKey);
      }
      if (claim.started) {
        this.runStore.appendEvent({
          ...claim.started.base,
          type: "failed",
          at: nowIso(),
          summary: SAVE_FAILED_SUMMARY,
          failureReason: SAVE_FAILED_SUMMARY
        });
      }
      throw error;
    }
  }
}
