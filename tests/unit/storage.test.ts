import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkspaceLedgerRecords, loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";

describe("storage", () => {
  let tempHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeLedgerWithTask(recurrence: Record<string, unknown>) {
    const ledger = await loadWorkspaceLedger("/tmp/project");
    const now = new Date().toISOString();
    const task = {
      id: "task-cron",
      workspaceKey: ledger.workspaceKey,
      workspacePath: ledger.workspacePath,
      name: "Cron",
      prompt: "Go",
      recurrence,
      recurrenceSummary: "Cron",
      enabled: true,
      nextRunAt: null,
      lastRunStatus: null,
      createdAt: now,
      updatedAt: now
    };
    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, `${ledger.workspaceKey}.json`), JSON.stringify({ ...ledger, tasks: [task] }), "utf8");
    return (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === ledger.workspaceKey);
  }

  it("loads a cron task", async () => {
    const record = await writeLedgerWithTask({ scheduleType: "cron", timezone: "Europe/Paris", expression: "*/15 9-17 * * MON-FRI" });
    expect(record?.warning).toBeNull();
    expect(record?.ledger?.tasks).toHaveLength(1);
  });

  it("drops a cron task that never matches a date, with the existing warning", async () => {
    const record = await writeLedgerWithTask({ scheduleType: "cron", timezone: "Europe/Paris", expression: "0 9 31 4,6,9,11 *" });
    expect(record?.ledger?.tasks).toHaveLength(0);
    expect(record?.warning).toContain("Invalid task entries were ignored.");
  });

  it("creates an empty ledger when no file exists", async () => {
    const ledger = await loadWorkspaceLedger("/tmp/project");
    expect(ledger.tasks).toEqual([]);
    expect(ledger.workspacePath).toBe("/tmp/project");
  });

  it("persists saved ledgers", async () => {
    const ledger = await loadWorkspaceLedger("/tmp/project");
    ledger.tasks.push({
      id: "task-1",
      workspaceKey: ledger.workspaceKey,
      workspacePath: ledger.workspacePath,
      name: "Morning summary",
      prompt: "Summarize",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      },
      recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: null,
      lastRunStatus: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await saveWorkspaceLedger(ledger);

    const reloaded = await loadWorkspaceLedger("/tmp/project");
    expect(reloaded.tasks).toHaveLength(1);
    expect(reloaded.tasks[0]?.name).toBe("Morning summary");
  });

  it("accepts a task with no lastRunStatus and no legacyLastRunStatus", async () => {
    const ledger = await loadWorkspaceLedger("/tmp/project");
    const now = new Date().toISOString();
    const task = {
      id: "task-bare",
      workspaceKey: ledger.workspaceKey,
      workspacePath: ledger.workspacePath,
      name: "Bare",
      prompt: "Go",
      recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
      recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now
    };
    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, `${ledger.workspaceKey}.json`),
      JSON.stringify({ ...ledger, tasks: [task] }),
      "utf8"
    );

    const record = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === ledger.workspaceKey);
    expect(record?.warning).toBeNull();
    expect(record?.ledger?.tasks).toHaveLength(1);
    expect(record?.ledger?.tasks[0]?.lastRunStatus).toBeNull();
    expect(record?.ledger?.tasks[0]?.legacyLastRunStatus).toBeUndefined();
  });

  it("keeps legacyLastRunStatus through a load/save round trip", async () => {
    const ledger = await loadWorkspaceLedger("/tmp/project");
    const now = new Date().toISOString();
    ledger.tasks.push({
      id: "task-legacy",
      workspaceKey: ledger.workspaceKey,
      workspacePath: ledger.workspacePath,
      name: "Legacy",
      prompt: "Go",
      recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
      recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: null,
      lastRunStatus: null,
      legacyLastRunStatus: "succeeded",
      createdAt: now,
      updatedAt: now
    });
    await saveWorkspaceLedger(ledger);
    await saveWorkspaceLedger(await loadWorkspaceLedger("/tmp/project"));

    const reloaded = await loadWorkspaceLedger("/tmp/project");
    expect(reloaded.tasks[0]?.legacyLastRunStatus).toBe("succeeded");
  });

  it("reports unreadable ledgers without dropping readable ones", async () => {
    const ledger = await loadWorkspaceLedger("/tmp/project");
    await saveWorkspaceLedger(ledger);

    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "broken.json"), "{invalid", "utf8");

    const records = await listWorkspaceLedgerRecords();
    expect(records).toHaveLength(2);
    expect(records.some((record) => record.ledger?.workspacePath === "/tmp/project")).toBe(true);
    expect(records.some((record) => record.status === "unavailable" && record.warning?.includes("Ledger could not be read"))).toBe(true);
  });

  it("filters malformed task and run entries while keeping the workspace readable", async () => {
    await mkdir("/tmp/project", { recursive: true });
    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "partial.json"),
      JSON.stringify({
        version: 1,
        workspaceKey: "partial",
        workspacePath: "/tmp/project",
        tasks: [
          null,
          {
            id: "task-1",
            workspaceKey: "partial",
            workspacePath: "/tmp/project",
            name: "Morning summary",
            prompt: "Summarize",
            recurrence: {
              scheduleType: "daily",
              timezone: "Europe/Paris",
              localTime: "09:00"
            },
            recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
            enabled: true,
            nextRunAt: null,
            lastRunStatus: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        runs: [
          null,
          {
            id: "run-1",
            occurrenceKey: "task-1:2026-04-27T08:00:00.000Z",
            taskId: "task-1",
            workspaceKey: "partial",
            scheduledFor: "2026-04-27T08:00:00.000Z",
            startedAt: null,
            finishedAt: null,
            status: "failed",
            outcomeSummary: "failed",
            failureReason: "failed",
            retryOfRunId: null,
            executionRequest: null
          }
        ],
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    const records = await listWorkspaceLedgerRecords();
    const partial = records.find((record) => record.workspaceKey === "partial");

    expect(partial?.status).toBe("partial");
    expect(partial?.ledger?.tasks).toHaveLength(1);
    expect(partial?.warning).toContain("Invalid task entries were ignored.");
    expect(partial?.warning).not.toContain("Invalid run entries");
  });

  it("rejects malformed recurrence payloads during ledger repair", async () => {
    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "recurrence.json"),
      JSON.stringify({
        version: 1,
        workspaceKey: "recurrence",
        workspacePath: "/tmp/project",
        tasks: [
          {
            id: "task-invalid",
            workspaceKey: "recurrence",
            workspacePath: "/tmp/project",
            name: "Broken recurrence",
            prompt: "Broken",
            recurrence: {
              timezone: "Europe/Paris",
              localTime: "09:00"
            },
            recurrenceSummary: "Broken",
            enabled: true,
            nextRunAt: null,
            lastRunStatus: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: "task-valid",
            workspaceKey: "recurrence",
            workspacePath: "/tmp/project",
            name: "Healthy recurrence",
            prompt: "Healthy",
            recurrence: {
              scheduleType: "daily",
              timezone: "Europe/Paris",
              localTime: "09:00"
            },
            recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
            enabled: true,
            nextRunAt: null,
            lastRunStatus: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        runs: [],
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    const records = await listWorkspaceLedgerRecords();
    const record = records.find((entry) => entry.workspaceKey === "recurrence");

    expect(record?.status).toBe("partial");
    expect(record?.ledger?.tasks).toHaveLength(1);
    expect(record?.ledger?.tasks[0]?.id).toBe("task-valid");
    expect(record?.warning).toContain("Invalid task entries were ignored.");
  });

  it("uses the filename-derived workspace key when repairing copied ledgers", async () => {
    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "alpha.json"),
      JSON.stringify({
        version: 1,
        workspaceKey: "duplicate-key",
        workspacePath: "/tmp/alpha",
        tasks: [
          {
            id: "task-alpha",
            workspaceKey: "duplicate-key",
            workspacePath: "/tmp/alpha",
            name: "Alpha task",
            prompt: "Alpha",
            recurrence: {
              scheduleType: "daily",
              timezone: "Europe/Paris",
              localTime: "09:00"
            },
            recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
            enabled: true,
            nextRunAt: null,
            lastRunStatus: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        runs: [],
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "beta.json"),
      JSON.stringify({
        version: 1,
        workspaceKey: "duplicate-key",
        workspacePath: "/tmp/beta",
        tasks: [
          {
            id: "task-beta",
            workspaceKey: "duplicate-key",
            workspacePath: "/tmp/beta",
            name: "Beta task",
            prompt: "Beta",
            recurrence: {
              scheduleType: "daily",
              timezone: "Europe/Paris",
              localTime: "10:00"
            },
            recurrenceSummary: "Daily at 10:00 (Europe/Paris)",
            enabled: true,
            nextRunAt: null,
            lastRunStatus: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        runs: [],
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    const records = await listWorkspaceLedgerRecords();
    const alpha = records.find((entry) => entry.workspaceLabel === "alpha");
    const beta = records.find((entry) => entry.workspaceLabel === "beta");

    expect(alpha?.workspaceKey).toBe("alpha");
    expect(beta?.workspaceKey).toBe("beta");
    expect(alpha?.ledger?.workspaceKey).toBe("alpha");
    expect(beta?.ledger?.workspaceKey).toBe("beta");
    expect(alpha?.ledger?.tasks[0]?.workspaceKey).toBe("alpha");
    expect(beta?.ledger?.tasks[0]?.workspaceKey).toBe("beta");
  });

  it("treats a ledger without runs as available and never writes runs", async () => {
    await mkdir("/tmp/project-v2", { recursive: true });
    const ledger = await loadWorkspaceLedger("/tmp/project-v2");
    (ledger as typeof ledger & { runs?: unknown[] }).runs = [{ stale: true }];
    await saveWorkspaceLedger(ledger);

    const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    const file = JSON.parse(await readFile(path.join(dataDir, `${ledger.workspaceKey}.json`), "utf8"));
    expect(file.version).toBe(2);
    expect("runs" in file).toBe(false);

    const records = await listWorkspaceLedgerRecords();
    const record = records.find((entry) => entry.workspacePath === "/tmp/project-v2");
    expect(record?.status).toBe("available");
    expect(record?.warning).toBeNull();
  });
});
