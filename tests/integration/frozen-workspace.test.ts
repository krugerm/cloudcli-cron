import * as os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { FROZEN_WORKSPACE_WARNING, listWorkspaceLedgerRecords, setFrozenWorkspaceKeys } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

describe("frozen workspaces", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let store: RunStore;
  let dataDir: string;
  let workspacePath: string;
  let key: string;

  function v1Ledger(nextRunAt: string) {
    return {
      version: 1,
      workspaceKey: "x",
      workspacePath,
      tasks: [
        {
          id: "t1",
          workspaceKey: "x",
          workspacePath,
          name: "T",
          prompt: "P",
          recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
          recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
          enabled: true,
          nextRunAt,
          lastRunStatus: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z"
        }
      ],
      runs: [{ id: "r1" }],
      executionProfile: null,
      updatedAt: "2026-04-01T00:00:00.000Z"
    };
  }

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-frozen-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    workspacePath = path.join(tempHome, "frozen-ws");
    key = workspaceKeyFromPath(workspacePath);
    store = new RunStore(":memory:");
    await writeFile(path.join(dataDir, "misnamed.json"), JSON.stringify(v1Ledger(new Date(Date.now() - 60_000).toISOString())), "utf8");
    setFrozenWorkspaceKeys(new Set([key]));
  });

  afterEach(async () => {
    setFrozenWorkspaceKeys(new Set());
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("reports the workspace unavailable with the frozen warning", async () => {
    // The workspace directory exists, so only the freeze can make it unavailable.
    await mkdir(workspacePath, { recursive: true });
    const record = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === "misnamed");
    expect(record?.status).toBe("unavailable");
    expect(record?.warning).toContain(FROZEN_WORKSPACE_WARNING);
  });

  it("returns 409 for edits, state loads, Run Now and Retry, and creates no derived ledger file", async () => {
    const scheduler = new SchedulerService(new LocalExecutionAdapter(), store, new Set([key]));
    const pending = { status: 409, message: "Run history import pending" };
    await expect(scheduler.loadWorkspaceState(workspacePath, () => ({ status: "needs_config", message: "x" }))).rejects.toMatchObject(pending);
    await expect(scheduler.createTask({ workspacePath, name: "N", prompt: "P", recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" } })).rejects.toMatchObject(pending);
    await expect(scheduler.createManualRun("t1", workspacePath)).rejects.toMatchObject(pending);
    await expect(scheduler.retryRun("r1", workspacePath)).rejects.toMatchObject(pending);
    expect(existsSync(path.join(dataDir, `${key}.json`))).toBe(false);
  });

  it("is skipped by the tick", async () => {
    // A correctly named ledger with a due, enabled task: without the freeze the tick would claim it.
    await unlink(path.join(dataDir, "misnamed.json"));
    const ledgerPath = path.join(dataDir, `${key}.json`);
    await writeFile(ledgerPath, JSON.stringify({ ...v1Ledger(new Date(Date.now() - 60_000).toISOString()), version: 2, workspaceKey: key, runs: undefined }), "utf8");
    const before = await readFile(ledgerPath, "utf8");
    const scheduler = new SchedulerService(new LocalExecutionAdapter(), store, new Set([key]));
    const stderrLines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk));
      return true;
    });
    try {
      await scheduler.tickWithoutDispatcher();
    } finally {
      stderr.mockRestore();
    }
    expect(store.listRuns(key).runs).toHaveLength(0);
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    // Skipped outright, not attempted and rejected by the 409 gate (which would log a tick error).
    expect(stderrLines.filter((line) => line.includes("tick error"))).toEqual([]);
  });
});
