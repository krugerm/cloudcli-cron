import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUN_STATUSES } from "../shared/model.js";
import type {
  RecurrenceDefinition,
  WorkspaceAvailabilityState,
  WorkspaceLedger,
  WorkspaceTask
} from "../shared/model.js";
import { normalizeWorkspacePath, projectNameFromWorkspacePath, workspaceKeyFromPath } from "../shared/workspace.js";
import { validateRecurrenceDefinition } from "./recurrence.js";

export const STORAGE_VERSION = 2;
const DATA_DIR_NAME = ".cloudcli-workspace-scheduled-prompts";

export const FROZEN_WORKSPACE_WARNING =
  "Run history import failed; it will be retried at the next start. See the plugin log.";

let frozenWorkspaceKeys: ReadonlySet<string> = new Set();

/** Derived workspace keys whose v0.2.0 import failed at startup (design §3 "Migration"). */
export function setFrozenWorkspaceKeys(keys: ReadonlySet<string>): void {
  frozenWorkspaceKeys = new Set(keys);
}

export interface WorkspaceLedgerRecord extends WorkspaceAvailabilityState {
  ledger: WorkspaceLedger | null;
}

export function ledgerDataRoot(): string {
  return path.join(os.homedir(), DATA_DIR_NAME);
}

function workspaceLedgerPath(workspacePath: string): string {
  return path.join(ledgerDataRoot(), `${workspaceKeyFromPath(workspacePath)}.json`);
}

function createEmptyLedger(workspacePath: string): WorkspaceLedger {
  const normalized = normalizeWorkspacePath(workspacePath);
  return {
    version: STORAGE_VERSION,
    workspaceKey: workspaceKeyFromPath(normalized),
    workspacePath: normalized,
    tasks: [],
    executionProfile: null,
    updatedAt: new Date().toISOString()
  };
}

export async function ensureLedgerDataDir(): Promise<void> {
  await mkdir(ledgerDataRoot(), { recursive: true });
}

async function readLedgerFile(filePath: string): Promise<WorkspaceLedger | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as WorkspaceLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecurrenceDefinition(value: unknown): value is RecurrenceDefinition {
  if (!isObject(value)) {
    return false;
  }

  try {
    validateRecurrenceDefinition(value as unknown as RecurrenceDefinition);
    return true;
  } catch {
    return false;
  }
}

function isTaskEntry(value: unknown): value is WorkspaceTask {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.workspaceKey === "string" &&
    typeof value.workspacePath === "string" &&
    typeof value.name === "string" &&
    typeof value.prompt === "string" &&
    isRecurrenceDefinition(value.recurrence) &&
    typeof value.recurrenceSummary === "string" &&
    typeof value.enabled === "boolean" &&
    (typeof value.nextRunAt === "string" || value.nextRunAt === null) &&
    (value.lastRunStatus === undefined || typeof value.lastRunStatus === "string" || value.lastRunStatus === null) &&
    (value.legacyLastRunStatus === undefined || typeof value.legacyLastRunStatus === "string" || value.legacyLastRunStatus === null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function filterLedgerEntries<T>(
  values: unknown,
  guard: (value: unknown) => value is T
): { entries: T[]; repaired: boolean } {
  if (!Array.isArray(values)) {
    return { entries: [], repaired: true };
  }

  const entries = values.filter(guard);
  return {
    entries,
    repaired: entries.length !== values.length
  };
}

function coerceLedgerShape(raw: unknown, fallbackWorkspaceKey: string): { ledger: WorkspaceLedger; warning: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("ledger JSON must be an object");
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.workspacePath !== "string" || !record.workspacePath.trim()) {
    throw new Error("workspacePath is missing");
  }
  const workspacePath = normalizeWorkspacePath(record.workspacePath);
  const workspaceKey = fallbackWorkspaceKey;
  const { entries: tasks, repaired: repairedTasks } = filterLedgerEntries(record.tasks, isTaskEntry);
  const executionProfile =
    record.executionProfile && typeof record.executionProfile === "object"
      ? (record.executionProfile as WorkspaceLedger["executionProfile"])
      : null;

  const repairNotes: string[] = [];
  if (!Array.isArray(record.tasks)) {
    repairNotes.push("Ledger metadata was partially repaired while loading.");
  }
  if (repairedTasks) {
    repairNotes.push("Invalid task entries were ignored.");
  }
  if (typeof record.workspaceKey === "string" && record.workspaceKey.trim() && record.workspaceKey.trim() !== workspaceKey) {
    repairNotes.push("Ledger workspace key was repaired from the filename.");
  }

  return {
    ledger: {
      version: typeof record.version === "number" ? record.version : STORAGE_VERSION,
      workspaceKey,
      workspacePath,
      tasks: tasks.map((task) => {
        const coerced: WorkspaceTask = {
          ...task,
          lastRunStatus: task.lastRunStatus ?? null,
          workspaceKey,
          workspacePath
        };
        if (typeof task.legacyLastRunStatus === "string" && (RUN_STATUSES as readonly string[]).includes(task.legacyLastRunStatus)) {
          coerced.legacyLastRunStatus = task.legacyLastRunStatus;
        } else {
          delete coerced.legacyLastRunStatus;
        }
        return coerced;
      }),
      executionProfile,
      updatedAt:
        typeof record.updatedAt === "string" && record.updatedAt.trim()
          ? record.updatedAt.trim()
          : new Date().toISOString(),
      ...(typeof record.migratedFrom === "string" ? { migratedFrom: record.migratedFrom } : {})
    },
    warning: repairNotes.length ? repairNotes.join(" ") : null
  };
}

async function workspacePathIsReadable(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspectLedgerFile(filePath: string, fileName: string): Promise<WorkspaceLedgerRecord> {
  const fallbackWorkspaceKey = fileName.replace(/\.json$/u, "");

  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    const { ledger, warning } = coerceLedgerShape(raw, fallbackWorkspaceKey);
    const workspaceReadable = await workspacePathIsReadable(ledger.workspacePath);
    const workspaceLabel = projectNameFromWorkspacePath(ledger.workspacePath);
    const frozen = frozenWorkspaceKeys.has(workspaceKeyFromPath(ledger.workspacePath));
    const warningParts = [
      warning,
      workspaceReadable ? null : "Workspace path is unavailable.",
      frozen ? FROZEN_WORKSPACE_WARNING : null
    ].filter((value): value is string => Boolean(value));

    return {
      workspaceKey: ledger.workspaceKey,
      workspacePath: ledger.workspacePath,
      workspaceLabel,
      status: frozen ? "unavailable" : warningParts.length ? (workspaceReadable ? "partial" : "unavailable") : "available",
      jobCount: ledger.tasks.length,
      warning: warningParts.length ? warningParts.join(" ") : null,
      ledger
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ledger could not be read.";
    return {
      workspaceKey: fallbackWorkspaceKey,
      workspacePath: `unknown:${fallbackWorkspaceKey}`,
      workspaceLabel: `Workspace ${fallbackWorkspaceKey.slice(0, 8)}`,
      status: "unavailable",
      jobCount: 0,
      warning: `Ledger could not be read. ${message}`,
      ledger: null
    };
  }
}

export async function loadWorkspaceLedger(workspacePath: string): Promise<WorkspaceLedger> {
  await ensureLedgerDataDir();
  const normalized = normalizeWorkspacePath(workspacePath);
  const ledger = await readLedgerFile(workspaceLedgerPath(normalized));
  return ledger ?? createEmptyLedger(normalized);
}

export async function saveWorkspaceLedger(ledger: WorkspaceLedger): Promise<void> {
  await ensureLedgerDataDir();
  ledger.updatedAt = new Date().toISOString();
  ledger.version = STORAGE_VERSION;

  const { runs: _legacyRuns, ...rest } = ledger as WorkspaceLedger & { runs?: unknown };
  void _legacyRuns;
  const persisted = { ...rest, tasks: rest.tasks.map((task) => ({ ...task, lastRunStatus: null })) };
  const filePath = workspaceLedgerPath(ledger.workspacePath);
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function deleteWorkspaceLedger(workspacePath: string): Promise<void> {
  await ensureLedgerDataDir();
  try {
    await unlink(workspaceLedgerPath(workspacePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function listWorkspaceLedgers(): Promise<WorkspaceLedger[]> {
  const records = await listWorkspaceLedgerRecords();
  return records
    .map((record) => record.ledger)
    .filter((ledger): ledger is WorkspaceLedger => ledger !== null);
}

export async function listWorkspaceLedgerRecords(): Promise<WorkspaceLedgerRecord[]> {
  await ensureLedgerDataDir();
  const entries = await readdir(ledgerDataRoot(), { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => inspectLedgerFile(path.join(ledgerDataRoot(), entry.name), entry.name))
  );

  return records.sort((left, right) => left.workspaceLabel.localeCompare(right.workspaceLabel));
}
