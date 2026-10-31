import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/server/run-store.js";
import { startPluginServer } from "../../src/server/startup.js";
import { listWorkspaceLedgerRecords, setFrozenWorkspaceKeys } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

describe("startPluginServer", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-startup-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setFrozenWorkspaceKeys(new Set());
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  // Review Focus 5: plugin killed mid-run
  it("closes a run interrupted by a previous process, without writing the ledger", async () => {
    const workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    const key = workspaceKeyFromPath(workspacePath);
    const ledgerFile = path.join(dataDir, `${key}.json`);
    await writeFile(
      ledgerFile,
      JSON.stringify({ version: 2, workspaceKey: key, workspacePath, tasks: [], executionProfile: null, updatedAt: "2026-04-01T00:00:00.000Z" }),
      "utf8"
    );
    const before = await readFile(ledgerFile, "utf8");

    const previous = new RunStore(path.join(dataDir, "runs.db"));
    previous.appendEvent({
      runId: "live",
      workspaceKey: key,
      taskId: "t1",
      occurrenceKey: "t1:x",
      scheduledFor: "2026-04-27T07:00:00.000Z",
      type: "started",
      at: "2026-04-27T07:00:01.000Z",
      source: "scheduler",
      summary: "Command started."
    });
    previous.close();

    const handle = await startPluginServer({ tickIntervalMs: 3_600_000, now: () => "2026-10-31T00:00:00.000Z" });
    try {
      expect(handle.runStore.getRun("live")).toMatchObject({ status: "failed", outcomeSummary: "Plugin server restarted while this run was in progress." });
      expect(handle.runStore.listEvents("live").at(-1)?.source).toBe("recovery");
      const response = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(response.status).toBe(200);
      expect(await readFile(ledgerFile, "utf8")).toBe(before);
    } finally {
      await handle.stop();
    }
  });

  it("imports v0.2.0 runs at startup before serving", async () => {
    const workspacePath = path.join(tempHome, "legacy");
    await mkdir(workspacePath, { recursive: true });
    const key = workspaceKeyFromPath(workspacePath);
    await writeFile(
      path.join(dataDir, `${key}.json`),
      JSON.stringify({
        version: 1,
        workspaceKey: key,
        workspacePath,
        tasks: [],
        runs: [
          {
            id: "old",
            occurrenceKey: "t:x",
            taskId: "t",
            workspaceKey: key,
            scheduledFor: "2026-04-27T07:00:00.000Z",
            startedAt: null,
            finishedAt: "2026-04-27T07:02:00.000Z",
            status: "missed",
            outcomeSummary: "late",
            failureReason: "late",
            retryOfRunId: null,
            executionRequest: null
          }
        ],
        executionProfile: null,
        updatedAt: "2026-04-01T00:00:00.000Z"
      }),
      "utf8"
    );
    const handle = await startPluginServer({ tickIntervalMs: 3_600_000 });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/v1/runs?workspacePath=${encodeURIComponent(workspacePath)}`);
      expect((await response.json()).runs.map((run: { id: string }) => run.id)).toEqual(["old"]);
    } finally {
      await handle.stop();
    }
  });

  async function writeLegacyLedger(workspacePath: string, runs: unknown[]): Promise<string> {
    const key = workspaceKeyFromPath(workspacePath);
    await writeFile(
      path.join(dataDir, `${key}.json`),
      JSON.stringify({ version: 1, workspaceKey: key, workspacePath, tasks: [], runs, executionProfile: null, updatedAt: "2026-04-01T00:00:00.000Z" }),
      "utf8"
    );
    return key;
  }

  function legacyRun(key: string, status: string) {
    return {
      id: "old",
      occurrenceKey: "t:x",
      taskId: "t",
      workspaceKey: key,
      scheduledFor: "2026-04-27T07:00:00.000Z",
      startedAt: "2026-04-27T07:00:01.000Z",
      finishedAt: null,
      status,
      outcomeSummary: "x",
      failureReason: null,
      retryOfRunId: null,
      executionRequest: null
    };
  }

  it("freezes a workspace whose import failed: unavailable in listings and mutations answer 409", async () => {
    const workspacePath = path.join(tempHome, "frozen");
    await mkdir(workspacePath, { recursive: true });
    const key = workspaceKeyFromPath(workspacePath);
    await writeLegacyLedger(workspacePath, [legacyRun(key, "failed")]);
    // A directory at the backup's temp path makes the backup step, and so the import, fail.
    await mkdir(path.join(dataDir, `${key}.v1.json.bak.tmp`));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const handle = await startPluginServer({ tickIntervalMs: 3_600_000 });
    try {
      const records = await listWorkspaceLedgerRecords();
      expect(records.find((record) => record.workspaceKey === key)).toMatchObject({ status: "unavailable" });
      const base = `http://127.0.0.1:${handle.port}`;
      const state = await fetch(`${base}/v1/workspace-state?workspacePath=${encodeURIComponent(workspacePath)}`);
      expect(state.status).toBe(409);
      expect(JSON.stringify(await state.json())).toContain("Run history import pending");
    } finally {
      await handle.stop();
    }
  });

  // Migration closes a legacy "running" run itself, so recovering first would give the same
  // outcome here; this pins that the run is closed exactly once, never twice.
  it("closes a migrated running run exactly once", async () => {
    const workspacePath = path.join(tempHome, "running");
    await mkdir(workspacePath, { recursive: true });
    const key = workspaceKeyFromPath(workspacePath);
    await writeLegacyLedger(workspacePath, [legacyRun(key, "running")]);
    const handle = await startPluginServer({ tickIntervalMs: 3_600_000, now: () => "2026-10-31T00:00:00.000Z" });
    try {
      const events = handle.runStore.listEvents("old");
      expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(events.filter((event) => event.source === "recovery")).toHaveLength(1);
    } finally {
      await handle.stop();
    }
  });

  it("fails with the database path when runs.db cannot be opened", async () => {
    await mkdir(path.join(dataDir, "runs.db"));
    await expect(startPluginServer({ tickIntervalMs: 3_600_000 })).rejects.toThrow(path.join(dataDir, "runs.db"));
  });

  it("logs a rejected tick instead of leaving an unhandled rejection", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startPluginServer({ tickIntervalMs: 10 });
    try {
      vi.spyOn(handle.scheduler, "tickWithoutDispatcher").mockRejectedValue(new Error("tick boom"));
      await vi.waitFor(() => {
        expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("tick error") && String(chunk).includes("tick boom"))).toBe(true);
      });
    } finally {
      await handle.stop();
    }
  });
});
