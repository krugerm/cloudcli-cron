import { access, copyFile, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUN_STATUSES, type NewRunEvent } from "../shared/model.js";
import { normalizeWorkspacePath, workspaceKeyFromPath } from "../shared/workspace.js";
import { eventsForLegacyRun, isLegacyRunEntry, sortLegacyRunsForImport, type LegacyRun } from "./legacy-runs.js";
import type { RunStore, TaskRunSummary } from "./run-store.js";
import { ensureLedgerDataDir, isObject, ledgerDataRoot, STORAGE_VERSION } from "./storage.js";

interface MigrationOptions {
  log?: (line: string) => void;
  now?: string;
}

function isRunStatus(value: unknown): value is string {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/**
 * One-time import of v0.2.0 ledger runs (design §3 "Migration").
 * Returns the derived workspace keys whose import failed (the frozen workspaces).
 */
export async function migrateLedgerRuns(store: RunStore, options: MigrationOptions = {}): Promise<Set<string>> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? new Date().toISOString();
  await ensureLedgerDataDir();
  const root = ledgerDataRoot();
  const frozen = new Set<string>();

  const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const filePath = path.join(root, name);
    let raw: unknown;
    try {
      raw = await readJson(filePath);
    } catch {
      continue; // unreadable ledgers are reported by listWorkspaceLedgerRecords
    }
    if (!isObject(raw) || !Array.isArray(raw.runs)) {
      continue;
    }

    // Derive the key before the backup so a failing backup freezes the workspace too.
    if (typeof raw.workspacePath !== "string" || !raw.workspacePath.trim()) {
      log(`[scheduled-prompts] ${name}: workspacePath is missing; run history not imported`);
      continue;
    }
    const derivedKey = workspaceKeyFromPath(raw.workspacePath);
    const targetPath = path.join(root, `${derivedKey}.json`);

    try {
      const stem = name.slice(0, -".json".length);
      const backupPath = path.join(root, `${stem}.v1.json.bak`);
      if (!(await exists(backupPath))) {
        await copyFile(filePath, `${backupPath}.tmp`);
        await rename(`${backupPath}.tmp`, backupPath);
      }

      if (targetPath !== filePath && (await exists(targetPath))) {
        const target = await readJson(targetPath).catch(() => null);
        if (isObject(target) && target.migratedFrom === name) {
          await unlink(filePath);
          log(`[scheduled-prompts] ${name}: removed leftover of an interrupted import into ${derivedKey}.json`);
          continue;
        }
        log(`[scheduled-prompts] ledger name conflict: ${name} vs ${derivedKey}.json; run history not imported`);
        continue;
      }

      const events = collectEvents(store, name, stem, raw.runs, derivedKey, now, log);
      store.appendEvents(events);
      await rewriteLedger(store, raw, name, filePath, targetPath, derivedKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[scheduled-prompts] ${name}: run history import failed (${message}); it will be retried at the next start`);
      frozen.add(derivedKey);
    }
  }
  return frozen;
}

function collectEvents(
  store: RunStore,
  name: string,
  stem: string,
  entries: unknown[],
  workspaceKey: string,
  now: string,
  log: (line: string) => void
): NewRunEvent[] {
  let invalid = 0;
  const candidates: Array<{ run: LegacyRun; events: NewRunEvent[] }> = [];
  for (const entry of entries) {
    if (!isLegacyRunEntry(entry) || !isRunStatus(entry.status)) {
      invalid += 1;
      continue;
    }
    const events = eventsForLegacyRun(entry, workspaceKey, now);
    if (!events) {
      invalid += 1;
      continue;
    }
    candidates.push({ run: entry, events });
  }

  const seen = new Set<string>();
  const events: NewRunEvent[] = [];
  for (const candidate of sortLegacyRunsForImport(candidates)) {
    const id = candidate.run.id;
    if (seen.has(id)) {
      invalid += 1;
      continue;
    }
    seen.add(id);
    if (store.hasRun(id)) {
      const existing = store.getRun(id);
      if (existing && existing.workspaceKey !== workspaceKey) {
        invalid += 1;
        log(`[scheduled-prompts] ${name}: run id ${id} already imported from ${existing.workspaceKey}`);
      }
      continue; // same workspace: an earlier interrupted import already committed it
    }
    events.push(...candidate.events);
  }
  if (invalid) {
    log(`[scheduled-prompts] ${name}: ${invalid} run entries could not be imported (kept in ${stem}.v1.json.bak)`);
  }
  return events;
}

async function rewriteLedger(
  store: RunStore,
  raw: Record<string, unknown>,
  name: string,
  filePath: string,
  targetPath: string,
  workspaceKey: string
): Promise<void> {
  const workspacePath = normalizeWorkspacePath(raw.workspacePath as string);
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const taskIds = tasks.filter(isObject).map((task) => String(task.id));
  const summaries = store.taskRunSummaries(workspaceKey, taskIds);

  const v2: Record<string, unknown> = {
    ...raw,
    version: STORAGE_VERSION,
    workspaceKey,
    workspacePath,
    tasks: tasks.map((task) => (isObject(task) ? migrateTask(task, workspaceKey, workspacePath, summaries) : task))
  };
  delete v2.runs;
  if (targetPath !== filePath) {
    v2.migratedFrom = name;
  }

  await writeFile(`${targetPath}.tmp`, `${JSON.stringify(v2, null, 2)}\n`, "utf8");
  await rename(`${targetPath}.tmp`, targetPath);
  if (targetPath !== filePath) {
    await unlink(filePath);
  }
}

function migrateTask(
  task: Record<string, unknown>,
  workspaceKey: string,
  workspacePath: string,
  summaries: Map<string, TaskRunSummary>
): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...task, workspaceKey, workspacePath, lastRunStatus: null };
  delete migrated.legacyLastRunStatus;
  const hasRuns = Boolean(summaries.get(String(task.id))?.latest);
  const stored = task.lastRunStatus;
  if (!hasRuns && isRunStatus(stored)) {
    migrated.legacyLastRunStatus = stored === "running" ? "failed" : stored;
  }
  return migrated;
}
