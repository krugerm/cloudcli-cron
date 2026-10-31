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
import { LocalExecutionAdapter } from "./execution-adapter.js";
import { HttpError } from "./http-error.js";
import { STARTED_SUMMARY } from "./run-fold.js";
import type { ListRunsOptions, RunPage, RunStore } from "./run-store.js";
import { createExecutionProfile, normalizeExecutionProfile, resolveExecutionCapability } from "./settings.js";
import { listWorkspaceLedgers, loadWorkspaceLedger, saveWorkspaceLedger } from "./storage.js";

const EXECUTION_GRACE_WINDOW_MS = 90_000;

function nowIso(): string {
  return new Date().toISOString();
}

function taskWithComputedFields(task: WorkspaceTask, afterIso?: string): WorkspaceTask {
  return {
    ...task,
    recurrenceSummary: formatRecurrenceSummary(task.recurrence),
    nextRunAt: computeTaskNextRun(task, afterIso)
  };
}

function isOutsideExecutionGraceWindow(scheduledFor: string, referenceIso: string): boolean {
  const scheduledAt = Date.parse(scheduledFor);
  const referenceAt = Date.parse(referenceIso);
  if (Number.isNaN(scheduledAt) || Number.isNaN(referenceAt)) {
    return true;
  }
  return referenceAt - scheduledAt > EXECUTION_GRACE_WINDOW_MS;
}

export class SchedulerService {
  private readonly inFlightOccurrences = new Set<string>();

  constructor(
    private readonly executionAdapter: LocalExecutionAdapter,
    private readonly runStore: RunStore
  ) {}

  async loadWorkspaceState(workspacePath: string, capability: ExecutionCapability): Promise<WorkspaceStateResponse> {
    const ledger = await this.refreshWorkspaceLedger(workspacePath);
    const page = this.runStore.listRuns(workspaceKeyFromPath(ledger.workspacePath));
    return {
      capability,
      executionProfile: ledger.executionProfile,
      tasks: ledger.tasks,
      runs: page.runs,
      runsNextCursor: page.nextCursor
    };
  }

  async listRuns(workspacePath: string, options: ListRunsOptions = {}): Promise<RunPage> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    return this.runStore.listRuns(workspaceKeyFromPath(ledger.workspacePath), options);
  }

  private requireRun(runId: string): ScheduledRun {
    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new Error("Run was not recorded");
    }
    return run;
  }

  async createTask(request: CreateTaskRequest): Promise<WorkspaceTask> {
    validateRecurrenceDefinition(request.recurrence);
    const ledger = await loadWorkspaceLedger(request.workspacePath);
    const createdAt = nowIso();

    const task: WorkspaceTask = taskWithComputedFields(
      {
        id: randomUUID(),
        workspaceKey: ledger.workspaceKey,
        workspacePath: normalizeWorkspacePath(request.workspacePath),
        name: request.name.trim(),
        prompt: request.prompt.trim(),
        recurrence: request.recurrence,
        recurrenceSummary: "",
        enabled: true,
        nextRunAt: null,
        lastRunStatus: null,
        createdAt,
        updatedAt: createdAt
      },
      createdAt
    );

    ledger.tasks.push(task);
    await saveWorkspaceLedger(ledger);
    return task;
  }

  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<WorkspaceTask> {
    const ledger = await loadWorkspaceLedger(request.workspacePath);
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    if (request.recurrence) {
      validateRecurrenceDefinition(request.recurrence);
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
    const updated = taskWithComputedFields(task, task.updatedAt);
    Object.assign(task, updated);
    await saveWorkspaceLedger(ledger);
    return task;
  }

  async deleteTask(taskId: string, workspacePath: string): Promise<void> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks = ledger.tasks.filter((task) => task.id !== taskId);
    await saveWorkspaceLedger(ledger);
  }

  async pauseTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: false });
  }

  async resumeTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: true });
  }

  async duplicateTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const source = ledger.tasks.find((task) => task.id === taskId);
    if (!source) {
      throw new Error("Task not found");
    }

    const copy = taskWithComputedFields(
      {
        ...source,
        id: randomUUID(),
        name: `${source.name} (Copy)`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastRunStatus: null
      },
      nowIso()
    );

    ledger.tasks.push(copy);
    await saveWorkspaceLedger(ledger);
    return copy;
  }

  async createManualRun(taskId: string, workspacePath: string): Promise<ScheduledRun> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    const scheduledFor = nowIso();
    const run = await this.executeTask(ledger, task, scheduledFor, {
      manual: true
    });
    return run;
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

    return this.executeTask(ledger, task, nowIso(), {
      manual: true,
      retryOfRunId: existing.id
    });
  }

  async saveExecutionProfile(request: ExecutionProfileRequest): Promise<ExecutionProfile> {
    const ledger = await loadWorkspaceLedger(request.workspacePath);
    ledger.executionProfile = createExecutionProfile({
      workspaceKey: ledger.workspaceKey,
      command: request.command,
      args: request.args,
      timeoutMs: request.timeoutMs
    });
    await saveWorkspaceLedger(ledger);
    return ledger.executionProfile;
  }

  async refreshWorkspaceLedger(workspacePath: string): Promise<WorkspaceLedger> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    let changed = false;
    const normalizedProfile = normalizeExecutionProfile(ledger.executionProfile);
    if (JSON.stringify(normalizedProfile) !== JSON.stringify(ledger.executionProfile)) {
      ledger.executionProfile = normalizedProfile;
      changed = true;
    }
    for (const task of ledger.tasks) {
      const nextRunAt = computeTaskNextRun(task, nowIso());
      if (task.nextRunAt !== nextRunAt || task.recurrenceSummary !== formatRecurrenceSummary(task.recurrence)) {
        task.nextRunAt = nextRunAt;
        task.recurrenceSummary = formatRecurrenceSummary(task.recurrence);
        changed = true;
      }
    }
    if (changed) {
      await saveWorkspaceLedger(ledger);
    }
    return ledger;
  }

  async tickWithoutDispatcher(): Promise<void> {
    const ledgers = await listWorkspaceLedgers();
    for (const ledger of ledgers) {
      const tickStartedAt = nowIso();
      let changed = false;
      const capability = resolveExecutionCapability(ledger.executionProfile ?? null);
      for (const task of ledger.tasks) {
        if (!task.enabled || !task.nextRunAt) {
          continue;
        }

        while (task.nextRunAt && task.nextRunAt <= tickStartedAt) {
          const scheduledFor = task.nextRunAt;
          const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
          const alreadyTracked =
            this.inFlightOccurrences.has(occurrenceKey) ||
            this.runStore.hasOccurrence(workspaceKeyFromPath(ledger.workspacePath), occurrenceKey);

          if (alreadyTracked) {
            task.nextRunAt = computeTaskNextRun(task, scheduledFor);
            changed = true;
            continue;
          }

          if (capability.status !== "ready" || isOutsideExecutionGraceWindow(scheduledFor, tickStartedAt)) {
            const missedReason =
              capability.status !== "ready"
                ? capability.message
                : "Automatic execution was unavailable at the scheduled time.";
            this.recordMissedRun(ledger, task, scheduledFor, missedReason);
            changed = true;
            continue;
          }

          await this.executeTask(ledger, task, scheduledFor);
          changed = false;
          break;
        }
      }

      if (changed) {
        await saveWorkspaceLedger(ledger);
      }
    }
  }

  private recordMissedRun(ledger: WorkspaceLedger, task: WorkspaceTask, scheduledFor: string, reason: string): void {
    this.runStore.appendEvent({
      runId: randomUUID(),
      workspaceKey: workspaceKeyFromPath(ledger.workspacePath),
      taskId: task.id,
      occurrenceKey: occurrenceKeyForTask(task.id, scheduledFor),
      scheduledFor,
      retryOfRunId: null,
      type: "missed",
      at: nowIso(),
      source: "scheduler",
      summary: reason,
      failureReason: reason
    });
    task.lastRunStatus = "missed";
    task.nextRunAt = computeTaskNextRun(task, scheduledFor);
  }

  private async executeTask(
    ledger: WorkspaceLedger,
    task: WorkspaceTask,
    scheduledFor: string,
    options?: { manual?: boolean; retryOfRunId?: string | null }
  ): Promise<ScheduledRun> {
    const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
    if (this.inFlightOccurrences.has(occurrenceKey)) {
      throw new Error("This occurrence is already running.");
    }

    const runId = randomUUID();
    const source: RunEventSource = options?.retryOfRunId ? "retry" : options?.manual ? "manual" : "scheduler";
    const base = {
      runId,
      workspaceKey: workspaceKeyFromPath(ledger.workspacePath),
      taskId: task.id,
      occurrenceKey,
      scheduledFor,
      source,
      retryOfRunId: options?.retryOfRunId ?? null
    };
    const profile = ledger.executionProfile;
    const capability = resolveExecutionCapability(profile ?? null);

    if (capability.status !== "ready" || !profile) {
      const blockedStatus: "failed" | "missed" = options?.manual ? "failed" : "missed";
      const blockedSummary = options?.manual
        ? `Manual execution could not start. ${capability.message}`
        : capability.message;
      this.runStore.appendEvent({ ...base, type: blockedStatus, at: nowIso(), summary: blockedSummary, failureReason: blockedSummary });
      task.lastRunStatus = blockedStatus;
      if (!options?.manual) {
        task.nextRunAt = computeTaskNextRun(task, scheduledFor);
      }
      await saveWorkspaceLedger(ledger);
      return this.requireRun(runId);
    }

    this.inFlightOccurrences.add(occurrenceKey);
    const executionRequest = this.executionAdapter.createRequest(task, profile, scheduledFor);
    this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
    if (!options?.manual) {
      task.nextRunAt = computeTaskNextRun(task, scheduledFor);
    }
    task.lastRunStatus = "running";
    await saveWorkspaceLedger(ledger);

    try {
      const result = await this.executionAdapter.execute(task, profile, scheduledFor, executionRequest);
      this.runStore.appendEvent({ ...base, type: result.status, at: nowIso(), summary: result.outcomeSummary, failureReason: result.failureReason });
      task.lastRunStatus = result.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local command execution failed.";
      this.runStore.appendEvent({ ...base, type: "failed", at: nowIso(), summary: message, failureReason: message });
      task.lastRunStatus = "failed";
    } finally {
      this.inFlightOccurrences.delete(occurrenceKey);
    }
    await saveWorkspaceLedger(ledger);
    return this.requireRun(runId);
  }
}
