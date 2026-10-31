import path from "node:path";
import { LocalExecutionAdapter } from "./server/execution-adapter.js";
import { startHttpServer } from "./server/http.js";
import { SchedulerService } from "./server/scheduler.js";
import { ensureLedgerDataDir, ledgerDataRoot } from "./server/storage.js";

async function main(): Promise<void> {
  await ensureLedgerDataDir();
  const { RunStore } = await import("./server/run-store.js");
  const runStore = new RunStore(path.join(ledgerDataRoot(), "runs.db"));
  const scheduler = new SchedulerService(new LocalExecutionAdapter(), runStore);
  const server = await startHttpServer(scheduler, runStore);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server port");
  }

  setInterval(() => {
    void scheduler.tickWithoutDispatcher();
  }, 30_000).unref();

  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
