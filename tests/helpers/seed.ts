import { RunStore } from "../../src/server/run-store.js";
import { saveWorkspaceLedger } from "../../src/server/storage.js";
import { eventsForLegacyRun, sortLegacyRunsForImport, type LegacyRun } from "../../src/server/legacy-runs.js";
import { STARTED_SUMMARY } from "../../src/server/run-fold.js";
import type { WorkspaceLedger } from "../../src/shared/model.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

/** A ledger fixture written in the v0.2.0 shape (runs inline). */
export type LegacyLedgerFixture = Omit<WorkspaceLedger, "version"> & { version?: number; runs?: LegacyRun[] };

export function createTestRunStore(): RunStore {
  return new RunStore(":memory:");
}

/**
 * Records fixture runs as events under the workspace's derived key.
 * A `running` fixture stays running (one `started` event): fixtures describe live state, not an import.
 */
export function seedRuns(store: RunStore, workspacePath: string, runs: LegacyRun[]): void {
  const workspaceKey = workspaceKeyFromPath(workspacePath);
  const now = new Date().toISOString();
  for (const { run } of sortLegacyRunsForImport(runs.map((entry) => ({ run: entry })))) {
    if (run.status === "running") {
      store.appendEvent({
        runId: run.id,
        workspaceKey,
        taskId: run.taskId,
        occurrenceKey: run.occurrenceKey,
        scheduledFor: run.scheduledFor,
        retryOfRunId: run.retryOfRunId,
        type: "started",
        at: run.startedAt ?? run.scheduledFor,
        source: "scheduler",
        summary: STARTED_SUMMARY,
        executionRequest: run.executionRequest
      });
      continue;
    }
    const events = eventsForLegacyRun(run, workspaceKey, now);
    if (!events) {
      throw new Error(`fixture run ${run.id} cannot be seeded`);
    }
    store.appendEvents(events);
  }
}

export async function seedLedger(store: RunStore, fixture: LegacyLedgerFixture): Promise<void> {
  const { runs = [], ...rest } = fixture;
  await saveWorkspaceLedger({ ...rest, version: 2 } as WorkspaceLedger);
  seedRuns(store, rest.workspacePath, runs);
}
