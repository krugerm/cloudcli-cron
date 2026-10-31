import * as os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLedgerRuns } from "../../src/server/migrate-runs.js";
import { eventsForLegacyRun } from "../../src/server/legacy-runs.js";
import { RunStore } from "../../src/server/run-store.js";
import { listWorkspaceLedgerRecords } from "../../src/server/storage.js";
import { RECOVERY_SUMMARY } from "../../src/server/run-fold.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

const NOW = "2026-10-31T12:00:00.000Z";

function v1Run(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    occurrenceKey: `task-1:${id}`,
    taskId: "task-1",
    workspaceKey: "whatever",
    scheduledFor: "2026-04-27T07:00:00.000Z",
    startedAt: "2026-04-27T07:00:01.000Z",
    finishedAt: "2026-04-27T07:00:09.000Z",
    status: "succeeded",
    outcomeSummary: `ok ${id}`,
    failureReason: null,
    retryOfRunId: null,
    executionRequest: null,
    ...extra
  };
}

function v1Task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspaceKey: "whatever",
    workspacePath: "/ignored",
    name: id,
    prompt: "P",
    recurrence: { scheduleType: "daily", timezone: "Europe/Paris", localTime: "09:00" },
    recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
    enabled: true,
    nextRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...extra
  };
}

describe("migrateLedgerRuns", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let dataDir: string;
  let store: RunStore;
  let logs: string[];
  const log = (line: string) => logs.push(line);

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-migrate-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
    await mkdir(dataDir, { recursive: true });
    store = new RunStore(":memory:");
    logs = [];
  });

  afterEach(async () => {
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writeV1(name: string, workspacePath: string, runs: unknown[], tasks: unknown[] = [v1Task("task-1")], extra: Record<string, unknown> = {}) {
    await writeFile(path.join(dataDir, name), JSON.stringify({ version: 1, workspaceKey: "x", workspacePath, tasks, runs, executionProfile: null, updatedAt: NOW, ...extra }), "utf8");
  }

  const readJson = async (name: string) => JSON.parse(await readFile(path.join(dataDir, name), "utf8"));

  it("imports a matching-name v1 file into events, a v2 file at the same path, and a .bak", async () => {
    const workspacePath = "/tmp/alpha";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1"), v1Run("r2", { status: "failed", failureReason: "boom", startedAt: "2026-04-27T08:00:01.000Z", finishedAt: "2026-04-27T08:00:05.000Z" })]);

    const frozen = await migrateLedgerRuns(store, { log, now: NOW });

    expect(frozen.size).toBe(0);
    expect(existsSync(path.join(dataDir, `${key}.v1.json.bak`))).toBe(true);
    const v2 = await readJson(`${key}.json`);
    expect(v2.version).toBe(2);
    expect("runs" in v2).toBe(false);
    expect(v2.workspaceKey).toBe(key);
    expect(v2.tasks[0].workspaceKey).toBe(key);
    expect("migratedFrom" in v2).toBe(false);
    const runs = store.listRuns(key).runs;
    expect(runs.map((run) => run.id)).toEqual(["r2", "r1"]);
    expect(runs[1]).toMatchObject({ status: "succeeded", startedAt: "2026-04-27T07:00:01.000Z", finishedAt: "2026-04-27T07:00:09.000Z", outcomeSummary: "ok r1", failureReason: null });
    expect(runs[0]).toMatchObject({ status: "failed", failureReason: "boom" });
    expect(store.listEvents("r1")[0]?.summary).toBe("Command started.");
  });

  it("closes a running entry with started + recovery failed", async () => {
    const workspacePath = "/tmp/running";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("live", { status: "running", finishedAt: null })]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listEvents("live").map((entry) => [entry.type, entry.source, entry.at])).toEqual([
      ["started", "migrated", "2026-04-27T07:00:01.000Z"],
      ["failed", "recovery", NOW]
    ]);
    expect(store.listEvents("live")[1]?.summary).toBe(RECOVERY_SUMMARY);
  });

  it("does not duplicate after a crash between commit and rewrite", async () => {
    const workspacePath = "/tmp/crash";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1")]);
    const original = await readFile(path.join(dataDir, `${key}.json`), "utf8");
    await migrateLedgerRuns(store, { log, now: NOW });
    await writeFile(path.join(dataDir, `${key}.json`), original, "utf8");
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listEvents("r1")).toHaveLength(2);
    expect("runs" in (await readJson(`${key}.json`))).toBe(false);
  });

  it("counts invalid, unknown-status, scheduled/canceled and duplicate entries and imports the rest", async () => {
    const workspacePath = "/tmp/invalid";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [
      null,
      v1Run("ok"),
      v1Run("weird", { status: "exploded" }),
      v1Run("sched", { status: "scheduled" }),
      v1Run("bad-time", { startedAt: "not a date" }),
      v1Run("ok", { outcomeSummary: "duplicate" })
    ]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listRuns(key).runs.map((run) => run.id)).toEqual(["ok"]);
    expect(store.getRun("ok")?.outcomeSummary).toBe("ok ok");
    expect(logs.some((line) => line.includes("5 run entries could not be imported"))).toBe(true);
  });

  it("sets legacyLastRunStatus only for tasks without imported runs, mapping running to failed", async () => {
    const workspacePath = "/tmp/legacy";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1")], [
      v1Task("task-1", { lastRunStatus: "succeeded" }),
      v1Task("task-2", { lastRunStatus: "missed" }),
      v1Task("task-3", { lastRunStatus: "running" }),
      v1Task("task-4", { lastRunStatus: null })
    ]);
    await migrateLedgerRuns(store, { log, now: NOW });
    const tasks = (await readJson(`${key}.json`)).tasks;
    expect(tasks.map((task: Record<string, unknown>) => [task.id, task.lastRunStatus, task.legacyLastRunStatus])).toEqual([
      ["task-1", null, undefined],
      ["task-2", null, "missed"],
      ["task-3", null, "failed"],
      ["task-4", null, undefined]
    ]);
  });

  it("orders imported runs by recording time so a later retry sorts above an earlier run", async () => {
    const workspacePath = "/tmp/order";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [
      v1Run("retry", { retryOfRunId: "a", startedAt: "2026-04-29T07:00:00.000Z", finishedAt: "2026-04-29T07:00:05.000Z" }),
      v1Run("b", { scheduledFor: "2026-04-28T07:00:00.000Z", startedAt: "2026-04-28T07:00:01.000Z", finishedAt: "2026-04-28T07:00:05.000Z" }),
      v1Run("a")
    ]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listRuns(key).runs.map((run) => run.id)).toEqual(["retry", "b", "a"]);
  });

  // Review Focus 1: trailing slash and offset timestamps
  it("moves a misnamed file to its derived name, normalizing workspacePath and timestamps", async () => {
    const normalizedPath = path.join(tempHome, "misnamed");
    await mkdir(normalizedPath, { recursive: true });
    const workspacePath = `${normalizedPath}/`;
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1("copied.json", workspacePath, [v1Run("r1", { scheduledFor: "2026-04-27T09:00:00+02:00", startedAt: "2026-04-27T09:00:01+02:00", finishedAt: "2026-04-27T09:00:09+02:00" })]);
    await migrateLedgerRuns(store, { log, now: NOW });

    expect(existsSync(path.join(dataDir, "copied.json"))).toBe(false);
    expect(existsSync(path.join(dataDir, "copied.v1.json.bak"))).toBe(true);
    const moved = await readJson(`${key}.json`);
    expect(moved).toMatchObject({ migratedFrom: "copied.json", workspaceKey: key, workspacePath: normalizedPath });
    expect(moved.tasks[0].workspacePath).toBe(normalizedPath);
    expect(store.getRun("r1")).toMatchObject({ workspaceKey: key, scheduledFor: "2026-04-27T07:00:00.000Z" });
    const record = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === key);
    expect(record).toMatchObject({ status: "available", warning: null });
  });

  it("removes a leftover original after an interrupted rename", async () => {
    const workspacePath = "/tmp/leftover";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1("orig.json", workspacePath, [v1Run("r1")]);
    await writeFile(path.join(dataDir, `${key}.json`), JSON.stringify({ version: 2, workspaceKey: key, workspacePath, tasks: [], migratedFrom: "orig.json", executionProfile: null, updatedAt: NOW }), "utf8");
    store.appendEvents(eventsForLegacyRun(v1Run("r1") as never, key, NOW)!);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(existsSync(path.join(dataDir, "orig.json"))).toBe(false);
  });

  it("keeps the original and logs a conflict when it holds a run id the store lacks (partial rollback)", async () => {
    const workspacePath = "/tmp/partial";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1("orig.json", workspacePath, [v1Run("r1"), v1Run("r2")]);
    await writeFile(path.join(dataDir, `${key}.json`), JSON.stringify({ version: 2, workspaceKey: key, workspacePath, tasks: [], migratedFrom: "orig.json", executionProfile: null, updatedAt: NOW }), "utf8");
    store.appendEvents(eventsForLegacyRun(v1Run("r1") as never, key, NOW)!);
    const frozen = await migrateLedgerRuns(store, { log, now: NOW });
    expect(existsSync(path.join(dataDir, "orig.json"))).toBe(true);
    expect(logs.some((line) => line.includes("ledger name conflict: orig.json"))).toBe(true);
    expect(frozen.size).toBe(0);
  });

  it("leaves both files untouched on a name conflict, even when the target has runs: []", async () => {
    const workspacePath = "/tmp/conflict";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1("stray.json", workspacePath, [v1Run("r1")]);
    await writeV1(`${key}.json`, workspacePath, [], [v1Task("other")]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(existsSync(path.join(dataDir, "stray.json"))).toBe(true);
    expect(logs.some((line) => line.includes("ledger name conflict: stray.json"))).toBe(true);
    expect(store.hasRun("r1")).toBe(false);
  });

  it("counts a run id already imported from another workspace as invalid", async () => {
    const pathA = "/tmp/a";
    const pathB = "/tmp/b";
    await writeV1(`${workspaceKeyFromPath(pathA)}.json`, pathA, [v1Run("shared")]);
    await writeV1(`${workspaceKeyFromPath(pathB)}.json`, pathB, [v1Run("shared")]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(store.listEvents("shared").every((entry) => entry.workspaceKey === store.getRun("shared")!.workspaceKey)).toBe(true);
    expect(logs.some((line) => line.includes("run id shared already imported from"))).toBe(true);
  });

  it("scopes legacyLastRunStatus to the workspace for a copied ledger with the same task ids", async () => {
    const pathA = "/tmp/copy-a";
    const pathB = "/tmp/copy-b";
    await writeV1(`${workspaceKeyFromPath(pathA)}.json`, pathA, [v1Run("only-a")], [v1Task("task-1", { lastRunStatus: "succeeded" })]);
    await writeV1(`${workspaceKeyFromPath(pathB)}.json`, pathB, [], [v1Task("task-1", { lastRunStatus: "failed" })]);
    await migrateLedgerRuns(store, { log, now: NOW });
    expect((await readJson(`${workspaceKeyFromPath(pathB)}.json`)).tasks[0].legacyLastRunStatus).toBe("failed");
    expect(store.taskRunSummaries(workspaceKeyFromPath(pathB), ["task-1"]).get("task-1")?.latest).toBeNull();
  });

  it("freezes the derived key when the import fails and leaves the file unchanged", async () => {
    const workspacePath = "/tmp/fails";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1")]);
    vi.spyOn(store, "appendEvents").mockImplementation(() => {
      throw new Error("disk full");
    });
    const frozen = await migrateLedgerRuns(store, { log, now: NOW });
    expect([...frozen]).toEqual([key]);
    expect(Array.isArray((await readJson(`${key}.json`)).runs)).toBe(true);
    vi.restoreAllMocks();
    const retried = await migrateLedgerRuns(store, { log, now: NOW });
    expect(retried.size).toBe(0);
    expect(store.hasRun("r1")).toBe(true);
  });

  it("freezes the derived key when the backup copy fails and leaves the file with its runs", async () => {
    const workspacePath = "/tmp/backup-fails";
    const key = workspaceKeyFromPath(workspacePath);
    await writeV1(`${key}.json`, workspacePath, [v1Run("r1")]);
    // A directory at the backup's temp path makes the copy fail.
    await mkdir(path.join(dataDir, `${key}.v1.json.bak.tmp`));
    const frozen = await migrateLedgerRuns(store, { log, now: NOW });
    expect([...frozen]).toEqual([key]);
    expect(Array.isArray((await readJson(`${key}.json`)).runs)).toBe(true);
    expect(store.hasRun("r1")).toBe(false);
  });

  it("skips files without runs and is a no-op the second time", async () => {
    const workspacePath = "/tmp/noop";
    const key = workspaceKeyFromPath(workspacePath);
    await writeFile(path.join(dataDir, `${key}.json`), JSON.stringify({ version: 2, workspaceKey: key, workspacePath, tasks: [], executionProfile: null, updatedAt: NOW }), "utf8");
    const before = await readFile(path.join(dataDir, `${key}.json`), "utf8");
    await migrateLedgerRuns(store, { log, now: NOW });
    await migrateLedgerRuns(store, { log, now: NOW });
    expect(await readFile(path.join(dataDir, `${key}.json`), "utf8")).toBe(before);
    expect(existsSync(path.join(dataDir, `${key}.v1.json.bak`))).toBe(false);
  });
});
