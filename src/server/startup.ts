import type http from "node:http";
import path from "node:path";
import { LocalExecutionAdapter } from "./execution-adapter.js";
import { startHttpServer } from "./http.js";
import { migrateLedgerRuns } from "./migrate-runs.js";
import type { RunStore } from "./run-store.js";
import { logTickError, SchedulerService } from "./scheduler.js";
import { ensureLedgerDataDir, ledgerDataRoot, setFrozenWorkspaceKeys } from "./storage.js";

export interface PluginServerHandle {
  port: number;
  scheduler: SchedulerService;
  runStore: RunStore;
  stop(): Promise<void>;
}

export async function startPluginServer(
  options: { tickIntervalMs?: number; now?: () => string } = {}
): Promise<PluginServerHandle> {
  const now = options.now ?? (() => new Date().toISOString());
  await ensureLedgerDataDir();
  const dbPath = path.join(ledgerDataRoot(), "runs.db");

  let runStore: RunStore;
  try {
    const { RunStore } = await import("./run-store.js");
    runStore = new RunStore(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open run history database ${dbPath}: ${message}`);
  }

  const frozenKeys = await migrateLedgerRuns(runStore, { now: now() });
  setFrozenWorkspaceKeys(frozenKeys);
  runStore.recoverInterruptedRuns(now());

  const scheduler = new SchedulerService(new LocalExecutionAdapter(), runStore, frozenKeys);
  const server: http.Server = await startHttpServer(scheduler, runStore);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server port");
  }

  const timer = setInterval(() => {
    scheduler.tickWithoutDispatcher().catch((error: unknown) => logTickError(error));
  }, options.tickIntervalMs ?? 30_000);
  timer.unref();

  return {
    port: address.port,
    scheduler,
    runStore,
    async stop() {
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runStore.close();
    }
  };
}
