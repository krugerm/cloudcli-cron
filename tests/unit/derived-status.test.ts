import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import type { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { listWorkspaceLedgerRecords, loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";
import { createTestRunStore } from "../helpers/seed.js";

const capability = () => ({ status: "needs_config" as const, message: "not configured" });

describe("derived lastRunStatus", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;
  let store: RunStore;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-derived-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = createTestRunStore();
    scheduler = new SchedulerService(new LocalExecutionAdapter(), store);
  });

  afterEach(async () => {
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function createTask() {
    return scheduler.createTask({
      workspacePath,
      name: "Daily",
      prompt: "Go",
      recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" }
    });
  }

  it("derives status from the latest run and never stores it", async () => {
    const task = await createTask();
    expect(task.lastRunStatus).toBeNull();
    await scheduler.createManualRun(task.id, workspacePath);

    const state = await scheduler.loadWorkspaceState(workspacePath, capability());
    expect(state.tasks[0]?.lastRunStatus).toBe("failed");

    const file = JSON.parse(await readFile(path.join(tempHome, ".cloudcli-workspace-scheduled-prompts", `${workspaceKeyFromPath(workspacePath)}.json`), "utf8"));
    expect(file.tasks[0].lastRunStatus).toBeNull();
  });

  it("falls back to legacyLastRunStatus only when the task has no runs", async () => {
    const task = await createTask();
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.legacyLastRunStatus = "succeeded";
    await saveWorkspaceLedger(ledger);
    expect((await scheduler.loadWorkspaceState(workspacePath, capability())).tasks[0]?.lastRunStatus).toBe("succeeded");

    await scheduler.createManualRun(task.id, workspacePath);
    expect((await scheduler.loadWorkspaceState(workspacePath, capability())).tasks[0]?.lastRunStatus).toBe("failed");
  });

  it("does not copy legacyLastRunStatus into a duplicate", async () => {
    const task = await createTask();
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.legacyLastRunStatus = "failed";
    await saveWorkspaceLedger(ledger);
    const copy = await scheduler.duplicateTask(task.id, workspacePath);
    const stored = (await loadWorkspaceLedger(workspacePath)).tasks.find((entry) => entry.id === copy.id);
    expect(stored && "legacyLastRunStatus" in stored).toBe(false);
    expect(copy.lastRunStatus).toBeNull();
  });

  it("keeps a valid legacyLastRunStatus through coercion and drops an invalid one", async () => {
    await createTask();
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.legacyLastRunStatus = "failed";
    ledger.tasks.push({ ...ledger.tasks[0]!, id: "bogus", legacyLastRunStatus: "nonsense" as never });
    await saveWorkspaceLedger(ledger);
    const record = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspacePath === workspacePath);
    expect(record?.ledger?.tasks.find((entry) => entry.id !== "bogus")?.legacyLastRunStatus).toBe("failed");
    expect(record?.ledger?.tasks.find((entry) => entry.id === "bogus")?.legacyLastRunStatus).toBeUndefined();
  });
});
