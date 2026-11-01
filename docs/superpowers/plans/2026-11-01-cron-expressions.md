# Cron Expressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Cron expression" schedule type to the Scheduled Prompt plugin, with server-side validation, a live summary/next-runs/frequency-warning preview in the form, and two scheduler safeguards (collapsed missed runs after downtime, no overlapping scheduled runs of one cron task).

**Architecture:** `cron-parser` computes occurrences and `cronstrue` writes summaries, both called only from `src/server/recurrence.ts`, which the browser form already imports (esbuild bundles both). The scheduler's existing compare-and-set claim gains cron-only branches: a collapsed `missed` event keyed on the first stale occurrence, and a skip while a `runningTasks` count is above zero. The form adds one field and a richer preview; views escape user values.

**Tech Stack:** TypeScript 5.9 (ES2022, NodeNext), Node ≥ 22.13, luxon 3.7, `cron-parser` ^5.10.2, `cronstrue` ^3.38.0, vitest 3 (+ jsdom), esbuild.

**Spec:** `docs/superpowers/specs/2026-11-01-cron-expressions-design.md` (the design; "§N" refers to it) and `specs/004-cron-expressions/spec.md` (FR/SC numbers), both at commit `8358457`. Read both before starting any task; the design wins over this plan on any conflict.

## Global Constraints

- **Baseline:** on `8358457`, `npm test` gives 28 test files and 199 tests passing; `npx tsc -p tsconfig.json --noEmit` exits 0. Every task ends with both green.
- **Dependencies:** `cron-parser` ^5.10.2 and `cronstrue` ^3.38.0 go in `dependencies` (not devDependencies; the plugin builds in production mode on hosts with `NODE_ENV=production`). No other new dependencies.
- **Library access:** only `src/server/recurrence.ts` imports `cron-parser` and `cronstrue`. Import forms (verified to compile under this repo's NodeNext settings): `import { CronExpressionParser } from "cron-parser";` and `import cronstrue from "cronstrue";`.
- **Existing types unchanged:** `one_time`, `daily`, `weekdays`, `weekly`, `monthly` keep their behaviour and stored data (FR-007). Every cron-specific scheduler branch checks `scheduleType === "cron"`.
- **Grace window:** stale means `tickStartedAt − scheduledFor > 90 s` (existing `EXECUTION_GRACE_WINDOW_MS = 90_000`); `staleBeforeIso = tickStartedAt − 90 s`; an occurrence is stale iff it is strictly before `staleBeforeIso`.
- **Collapse cap:** `CRON_COLLAPSE_CAP = 1440`.
- **Exact strings** (verbatim from the design):
  - `Enter a cron expression.`
  - `Unsupported nickname "<value>". Use @yearly, @annually, @monthly, @weekly, @daily or @hourly.` (`<value>` = normalised, lower-cased)
  - `Seconds are not supported. Use 5 fields: minute hour day-of-month month day-of-week.`
  - `A cron expression needs 5 fields: minute hour day-of-month month day-of-week.`
  - `H (random values) is not supported.`
  - `W (nearest weekday) is not supported.`
  - `This cron expression never matches a date.`
  - `Invalid cron expression: <parser message>`
  - `Missed <count> runs between <first> and <last> (<reason>).` / `Missed 1,440 or more runs between <first> and <last> (<reason>).` with `<reason>` = `the scheduler did not run them in time` or the capability message without its trailing `.`
  - `Runs as often as every <N> min, <X> times in 24 hours. Each run sends the prompt to Claude.`
- **Formats:** collapse times `yyyy-LL-dd HH:mm ZZZZ`, preview run times `ccc d LLL HH:mm`, both via luxon in the task's time zone with `setLocale("en")`; counts via `toLocaleString("en-US")`.
- **Workspace key rule (from 003):** every RunStore call uses `workspaceKeyFromPath(ledger.workspacePath)`.
- **Commits:** one commit per task, subject given in each task.

## Review Focus

Five inputs or conditions the design implies but its test list does not pin, most likely first. Each has a test in the task named.

1. **Lower-case or mixed-case weekday/month names in an expression** (`0 9 * * mon-fri`, `0 9 1 jan *`): a reasonable person expects them to work exactly like upper case. Test: Task 1 (`recurrence.test.ts`, "accepts lower-case names").
2. **A user switches an existing daily task to Cron and saves without touching the expression**: the default `0 9 * * MON-FRI` is saved and runs. Test: Task 3 (`task-form.test.ts`, "switching a daily task to Cron saves the default").
3. **A time zone typo with a cron expression** (`Europe/Amsterdm`): the existing `Invalid timezone: …` message, not a cron-parser error. Test: Task 1 (`recurrence.test.ts`, "reports an invalid time zone before the expression").
4. **Tabs or newlines pasted inside an expression** (`0\t9 *\n* *`): normalised like spaces and accepted. Test: Task 1 (`recurrence.test.ts`, "normalises tabs and newlines").
5. **An overlapping run of a cron task whose execution fails** (adapter throws): the running count still returns to 0, so the schedule resumes. Test: Task 2 (`scheduler-cron.test.ts`, "a failing execution still releases the running count").

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `package.json`, `package-lock.json` | modify | add `cron-parser`, `cronstrue` to `dependencies` (Task 1); version 0.4.0 (Task 4) |
| `src/shared/model.ts` | modify | `ScheduleType` gains `"cron"`; `CronRecurrenceDefinition` |
| `src/server/recurrence.ts` | modify | normalisation, cron validation, occurrences, summary, `cronNextDue`, `cronStaleWindow` (Task 1); `cronUpcomingRuns`, `cronFrequencyWarning` (Task 3) |
| `src/server/run-fold.ts` | modify | `cronMissedSummary` (collapse message) |
| `src/server/scheduler.ts` | modify | normalisation in create/update; `runningTasks`; claim steps 1–6; `runManually` restructure; catch-up progress guard |
| `src/client/escape.ts` | create | `escapeHtml(value)` |
| `src/client/views/task-form.ts` | modify | cron option/field/default/visibility/preview/warning/cache; escaping |
| `src/client/views/schedule-list.ts` | modify | escape task name and summary |
| `tests/unit/recurrence.test.ts` | modify | cron engine tests |
| `tests/unit/storage.test.ts` | modify | cron task loads; never-matching dropped |
| `tests/integration/scheduler-cron.test.ts` | create | collapse, overlap, normalisation, running-count tests |
| `tests/integration/task-form.test.ts` | modify | form tests |
| `tests/integration/task-form-cache.test.ts` | create | validation cache test (isolated module mock) |
| `README.md`, `CHANGELOG.md`, `manifest.json` | modify | docs, 0.4.0 |

## Task overview

| # | Task | Ends with |
|---|---|---|
| 1 | Cron engine: dependencies, model, normalisation, validation, occurrences, summary, stale window | engine + storage tests green |
| 2 | Scheduler safeguards: normalisation, running count, claim steps 1–6, collapse, manual-run restructure | scheduler tests green |
| 3 | UI: cron field, preview, frequency warning, validation cache, escaping | jsdom tests green |
| 4 | Docs, version 0.4.0, production build check | release-ready branch |

---

### Task 1: Cron engine

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Modify: `src/shared/model.ts:1` (ScheduleType), `:44-57` (definitions and union)
- Modify: `src/server/recurrence.ts` (whole file gains cron branches and helpers)
- Test: `tests/unit/recurrence.test.ts` (append a `describe("cron", …)`), `tests/unit/storage.test.ts` (two cases)

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `src/server/recurrence.ts`):
  - `CRON_COLLAPSE_CAP = 1440`
  - `normalizeCronExpression(expression: string): string`
  - `normalizeRecurrence(recurrence: RecurrenceDefinition): RecurrenceDefinition`
  - `validateRecurrenceDefinition` (now handles `cron`)
  - `nextOccurrenceForRecurrence` (now handles `cron`)
  - `formatRecurrenceSummary` (now handles `cron`)
  - `cronNextDue(recurrence: CronRecurrenceDefinition, staleBeforeIso: string): { nextDue: string; lastBefore: string | null }`
  - `cronStaleWindow(recurrence: CronRecurrenceDefinition, fromIso: string, staleBeforeIso: string, cap: number): { count: number; capped: boolean; lastStale: string; nextDue: string }`
- Produces (from `src/shared/model.ts`): `ScheduleType` includes `"cron"`; `interface CronRecurrenceDefinition extends BaseRecurrenceDefinition { scheduleType: "cron"; expression: string }`.

- [ ] **Step 1: Add the dependencies**

```bash
npm install --save cron-parser@^5.10.2 cronstrue@^3.38.0
```

Expected: `package.json` `dependencies` now lists `cron-parser` and `cronstrue`; `npm test` still 199 passing.

- [ ] **Step 2: Write the failing engine tests**

In `tests/unit/recurrence.test.ts`, **replace** the existing `import { formatRecurrenceSummary, … } from "../../src/server/recurrence.js";` line with the import block below (the `vitest` import stays), and append the rest of the block at the end of the file:

```ts
import {
  CRON_COLLAPSE_CAP,
  cronNextDue,
  cronStaleWindow,
  formatRecurrenceSummary,
  nextOccurrenceForRecurrence,
  normalizeRecurrence,
  validateRecurrenceDefinition
} from "../../src/server/recurrence.js";
import type { CronRecurrenceDefinition } from "../../src/shared/model.js";

const AMS = "Europe/Amsterdam";
const cron = (expression: string, timezone = AMS): CronRecurrenceDefinition => ({ scheduleType: "cron", timezone, expression });
const messageOf = (expression: unknown, timezone = AMS): string => {
  try {
    validateRecurrenceDefinition({ scheduleType: "cron", timezone, expression } as unknown as CronRecurrenceDefinition);
    return "OK";
  } catch (error) {
    return (error as Error).message;
  }
};

describe("cron", () => {
  const after = "2026-11-02T08:00:00.000Z";

  it.each([
    ["*/15 9-17 * * MON-FRI", "2026-11-02T08:15:00.000Z"],
    ["0 9 L * *", "2026-11-30T08:00:00.000Z"],
    ["0 9 * * 5L", "2026-11-27T08:00:00.000Z"],
    ["0 9 * * FRI#3", "2026-11-20T08:00:00.000Z"],
    ["@weekly", "2026-11-07T23:00:00.000Z"],
    ["@DAILY", "2026-11-02T23:00:00.000Z"],
    ["0 9 ? * MON", "2026-11-09T08:00:00.000Z"],
    ["0 9 * * THU", "2026-11-05T08:00:00.000Z"],
    ["0 9 * * WED", "2026-11-04T08:00:00.000Z"]
  ])("computes the next run of %s", (expression, expected) => {
    expect(nextOccurrenceForRecurrence(cron(expression), after)).toBe(expected);
  });

  // Review Focus 1
  it("accepts lower-case names", () => {
    expect(nextOccurrenceForRecurrence(cron("0 9 * * mon-fri"), after)).toBe("2026-11-03T08:00:00.000Z");
    expect(nextOccurrenceForRecurrence(cron("0 9 1 jan *"), after)).toBe("2027-01-01T08:00:00.000Z");
  });

  it("keeps local time across daylight saving", () => {
    expect(nextOccurrenceForRecurrence(cron("0 9 1 JAN,JUL *"), "2026-12-15T00:00:00.000Z")).toBe("2027-01-01T08:00:00.000Z");
    expect(nextOccurrenceForRecurrence(cron("0 9 1 JAN,JUL *"), "2027-06-15T00:00:00.000Z")).toBe("2027-07-01T07:00:00.000Z");
    expect(nextOccurrenceForRecurrence(cron("30 2 * * *"), "2026-03-28T12:00:00.000Z")).toBe("2026-03-29T01:30:00.000Z");
    const hourly: string[] = [];
    let cursor = "2026-10-24T22:00:00.000Z";
    for (let index = 0; index < 6; index += 1) {
      cursor = nextOccurrenceForRecurrence(cron("0 * * * *"), cursor)!;
      hourly.push(cursor);
    }
    expect([...hourly].sort()).toEqual(hourly);
    expect(new Set(hourly).size).toBe(6);
  });

  it.each([
    [undefined, "Enter a cron expression."],
    [5, "Enter a cron expression."],
    ["", "Enter a cron expression."],
    ["   ", "Enter a cron expression."],
    ["@midnight", 'Unsupported nickname "@midnight". Use @yearly, @annually, @monthly, @weekly, @daily or @hourly.'],
    ["@REBOOT", 'Unsupported nickname "@reboot". Use @yearly, @annually, @monthly, @weekly, @daily or @hourly.'],
    ["*/5 * * * * *", "Seconds are not supported. Use 5 fields: minute hour day-of-month month day-of-week."],
    ["* * *", "A cron expression needs 5 fields: minute hour day-of-month month day-of-week."],
    ["H 9 * * *", "H (random values) is not supported."],
    ["0 H/2 * * *", "H (random values) is not supported."],
    ["h(0-29) 9 * * *", "H (random values) is not supported."],
    ["0 9 15W * *", "W (nearest weekday) is not supported."],
    ["0 9 LW * *", "W (nearest weekday) is not supported."],
    ["60 9 * * *", "Invalid cron expression: Constraint error, got value 60 expected range 0-59"],
    ["0 9 31 4,6,9,11 *", "This cron expression never matches a date."],
    ["0 9 31 2 *", "This cron expression never matches a date."]
  ])("rejects %j with its message", (expression, message) => {
    expect(messageOf(expression)).toBe(message);
  });

  it.each(["0 9 * * THU", "0 9 * * WED", "@DAILY", "  @Weekly ", "0 9 * 2 MON#5"])("accepts %j", (expression) => {
    expect(messageOf(expression)).toBe("OK");
  });

  // Review Focus 3
  it("reports an invalid time zone before the expression", () => {
    expect(messageOf("H 9 * * *", "Europe/Amsterdm")).toBe("Invalid timezone: Europe/Amsterdm");
  });

  it("normalises the expression and leaves other types alone", () => {
    expect(normalizeRecurrence(cron("  0   9 *  * MON-FRI "))).toEqual(cron("0 9 * * MON-FRI"));
    expect(normalizeRecurrence(cron(" @DAILY "))).toEqual(cron("@daily"));
    const daily = { scheduleType: "daily" as const, timezone: AMS, localTime: "09:00" };
    expect(normalizeRecurrence(daily)).toBe(daily);
    const broken = { scheduleType: "cron", timezone: AMS, expression: 5 } as unknown as CronRecurrenceDefinition;
    expect(normalizeRecurrence(broken)).toBe(broken);
  });

  // Review Focus 4
  it("normalises tabs and newlines", () => {
    expect(normalizeRecurrence(cron("0\t9 *\n* *"))).toEqual(cron("0 9 * * *"));
    expect(messageOf("0\t9 *\n* *")).toBe("OK");
  });

  it("summarises in 24-hour English with the time zone, and falls back when cronstrue cannot", () => {
    expect(formatRecurrenceSummary(cron("*/15 9-17 * * MON-FRI"))).toBe(
      "Every 15 minutes, between 09:00 and 17:59, Monday through Friday (Europe/Amsterdam)"
    );
    expect(formatRecurrenceSummary(cron("0 9 L * *"))).toBe("At 09:00, on the last day of the month (Europe/Amsterdam)");
    expect(formatRecurrenceSummary(cron("@DAILY"))).toBe("At 00:00 (Europe/Amsterdam)");
    expect(formatRecurrenceSummary(cron("H 9 * * *"))).toBe("Cron: H 9 * * * (Europe/Amsterdam)");
  });

  it("accepts an un-normalised stored nickname", () => {
    expect(nextOccurrenceForRecurrence(cron("@DAILY"), after)).toBe("2026-11-02T23:00:00.000Z");
  });

  describe("stale window", () => {
    const tick = "2026-11-01T12:00:10.000Z";
    const staleBefore = "2026-11-01T11:58:40.000Z";
    const every = cron("* * * * *", "UTC");

    it("counts the 479 stale runs of an 8-hour gap and finds the next due run", () => {
      expect(cronStaleWindow(every, "2026-11-01T04:00:00.000Z", staleBefore, CRON_COLLAPSE_CAP)).toEqual({
        count: 479,
        capped: false,
        lastStale: "2026-11-01T11:58:00.000Z",
        nextDue: "2026-11-01T11:59:00.000Z"
      });
      expect(new Date(Date.parse(tick) - 90_000).toISOString()).toBe(staleBefore);
    });

    it("caps the count and still reports the true last stale run", () => {
      expect(cronStaleWindow(every, "2026-10-31T11:00:00.000Z", staleBefore, CRON_COLLAPSE_CAP)).toEqual({
        count: 1440,
        capped: true,
        lastStale: "2026-11-01T11:58:00.000Z",
        nextDue: "2026-11-01T11:59:00.000Z"
      });
      expect(cronStaleWindow(every, "2026-10-31T11:59:00.000Z", staleBefore, CRON_COLLAPSE_CAP)).toMatchObject({
        count: 1440,
        capped: false
      });
    });

    it("bounds the work for a backlog of a year", () => {
      const started = performance.now();
      expect(cronStaleWindow(every, "2025-11-01T00:00:00.000Z", staleBefore, CRON_COLLAPSE_CAP).capped).toBe(true);
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    it("counts the run that daylight saving shifts to 03:30", () => {
      const nightly = cron("30 2 * * *");
      expect(cronStaleWindow(nightly, "2026-03-27T01:30:00.000Z", "2026-03-29T12:00:00.000Z", CRON_COLLAPSE_CAP)).toEqual({
        count: 3,
        capped: false,
        lastStale: "2026-03-29T01:30:00.000Z",
        nextDue: "2026-03-30T00:30:00.000Z"
      });
      expect(cronStaleWindow(nightly, "2026-03-29T01:30:00.000Z", "2026-03-29T12:00:00.000Z", CRON_COLLAPSE_CAP).count).toBe(1);
      expect(cronNextDue(nightly, "2026-03-29T01:15:00.000Z").nextDue).toBe("2026-03-29T01:30:00.000Z");
    });
  });
});
```

- [ ] **Step 3: Write the failing storage tests**

Add to `tests/unit/storage.test.ts` inside `describe("storage", …)`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/recurrence.test.ts tests/unit/storage.test.ts`
Expected: FAIL — `CRON_COLLAPSE_CAP`/`cronNextDue`/`cronStaleWindow`/`normalizeRecurrence` are not exported (SyntaxError/undefined), and "loads a cron task" fails because `validateRecurrenceDefinition` throws "Unsupported schedule type".

- [ ] **Step 5: Extend the model**

In `src/shared/model.ts` replace line 1 and add the definition before the `RecurrenceDefinition` union:

```ts
export type ScheduleType = "one_time" | "daily" | "weekdays" | "weekly" | "monthly" | "cron";
```

```ts
export interface CronRecurrenceDefinition extends BaseRecurrenceDefinition {
  scheduleType: "cron";
  expression: string;
}

export type RecurrenceDefinition =
  | OneTimeRecurrenceDefinition
  | DailyRecurrenceDefinition
  | WeekdaysRecurrenceDefinition
  | WeeklyRecurrenceDefinition
  | MonthlyRecurrenceDefinition
  | CronRecurrenceDefinition;
```

- [ ] **Step 6: Implement the engine in `src/server/recurrence.ts`**

Add imports at the top:

```ts
import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import type {
  CronRecurrenceDefinition,
  MonthlyRecurrenceDefinition,
  RecurrenceDefinition,
  WeekdayName,
  WorkspaceTask
} from "../shared/model.js";
```

Add after `resolveMonthlyDay`:

```ts
export const CRON_COLLAPSE_CAP = 1440;

const CRON_NICKNAMES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@hourly"]);
const CRON_FIELDS_HELP = "minute hour day-of-month month day-of-week";
const NEVER_MATCHES = "This cron expression never matches a date.";

export function normalizeCronExpression(expression: string): string {
  const collapsed = expression.trim().replace(/\s+/g, " ");
  return collapsed.startsWith("@") ? collapsed.toLowerCase() : collapsed;
}

/** The only normaliser (design §1); other types and non-string expressions are returned unchanged. */
export function normalizeRecurrence(recurrence: RecurrenceDefinition): RecurrenceDefinition {
  if (recurrence.scheduleType !== "cron" || typeof recurrence.expression !== "string") {
    return recurrence;
  }
  return { ...recurrence, expression: normalizeCronExpression(recurrence.expression) };
}

function cronIso(date: { toISOString(): string | null }): string {
  const iso = date.toISOString();
  if (!iso) {
    throw new Error("cron-parser returned an invalid date");
  }
  return iso;
}

function parseCron(recurrence: CronRecurrenceDefinition, currentDate: string) {
  return CronExpressionParser.parse(normalizeCronExpression(recurrence.expression), {
    currentDate,
    tz: recurrence.timezone
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateCronExpression(rawExpression: unknown, timezone: string): void {
  const expression = typeof rawExpression === "string" ? normalizeCronExpression(rawExpression) : "";
  if (!expression) {
    throw new Error("Enter a cron expression.");
  }
  if (expression.startsWith("@")) {
    if (!CRON_NICKNAMES.has(expression)) {
      throw new Error(`Unsupported nickname "${expression}". Use @yearly, @annually, @monthly, @weekly, @daily or @hourly.`);
    }
  } else {
    const fields = expression.split(" ");
    if (fields.length === 6) {
      throw new Error(`Seconds are not supported. Use 5 fields: ${CRON_FIELDS_HELP}.`);
    }
    if (fields.length !== 5) {
      throw new Error(`A cron expression needs 5 fields: ${CRON_FIELDS_HELP}.`);
    }
    if (fields.some((field) => /(^|[^a-z])h(?![a-z])/i.test(field))) {
      throw new Error("H (random values) is not supported.");
    }
    if (/w/i.test(fields[2]!)) {
      throw new Error("W (nearest weekday) is not supported.");
    }
  }
  let parsed;
  try {
    parsed = CronExpressionParser.parse(expression, { tz: timezone });
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(message.includes("Invalid explicit day of month definition") ? NEVER_MATCHES : `Invalid cron expression: ${message}`);
  }
  try {
    parsed.next();
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(message.includes("loop limit") ? NEVER_MATCHES : `Invalid cron expression: ${message}`);
  }
}

/** First occurrence at or after staleBeforeIso, walking from 61 minutes earlier (design §1, DST quirk). */
export function cronNextDue(
  recurrence: CronRecurrenceDefinition,
  staleBeforeIso: string
): { nextDue: string; lastBefore: string | null } {
  const iterator = parseCron(recurrence, new Date(Date.parse(staleBeforeIso) - 61 * 60_000).toISOString());
  let lastBefore: string | null = null;
  for (;;) {
    const candidate = cronIso(iterator.next());
    if (candidate >= staleBeforeIso) {
      return { nextDue: candidate, lastBefore };
    }
    lastBefore = candidate;
  }
}

/** Forward-only walk from the claimed occurrence (design §1); work bounded by cap + ~61 steps. */
export function cronStaleWindow(
  recurrence: CronRecurrenceDefinition,
  fromIso: string,
  staleBeforeIso: string,
  cap: number
): { count: number; capped: boolean; lastStale: string; nextDue: string } {
  const iterator = parseCron(recurrence, fromIso);
  let count = 1;
  let lastStale = fromIso;
  let capped = false;
  for (;;) {
    const candidate = cronIso(iterator.next());
    if (candidate >= staleBeforeIso) {
      break;
    }
    if (count >= cap) {
      capped = true;
      break;
    }
    count += 1;
    lastStale = candidate;
  }
  const due = cronNextDue(recurrence, staleBeforeIso);
  if (capped) {
    lastStale = due.lastBefore ?? cronIso(parseCron(recurrence, staleBeforeIso).prev());
  }
  return { count, capped, lastStale, nextDue: due.nextDue };
}
```

In `validateRecurrenceDefinition`, add before `default:`:

```ts
    case "cron":
      validateCronExpression(recurrence.expression, recurrence.timezone);
      return;
```

In `nextOccurrenceForRecurrence`, add before `default:`:

```ts
    case "cron":
      return cronIso(parseCron(recurrence, afterUtc.toISO()!).next());
```

In `formatRecurrenceSummary`, add before `default:`:

```ts
    case "cron": {
      const expression = normalizeCronExpression(recurrence.expression);
      try {
        return `${cronstrue.toString(expression, { use24HourTimeFormat: true })} (${recurrence.timezone})`;
      } catch {
        return `Cron: ${expression} (${recurrence.timezone})`;
      }
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/recurrence.test.ts tests/unit/storage.test.ts`
Expected: PASS (all new and existing cases).

- [ ] **Step 8: Full suite and type check**

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all test files pass (199 + the new cases), tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/shared/model.ts src/server/recurrence.ts tests/unit/recurrence.test.ts tests/unit/storage.test.ts
git commit -m "plan(t01): Cron engine"
```

---

### Task 2: Scheduler safeguards

**Files:**
- Modify: `src/server/run-fold.ts` (add `cronMissedSummary`)
- Modify: `src/server/scheduler.ts` (imports; `createTask`; `updateTask`; `runningTasks`; `tickWorkspace`; `claimOccurrence`; `runManually`)
- Test: `tests/integration/scheduler-cron.test.ts` (create)

**Interfaces:**
- Consumes (Task 1): `normalizeRecurrence`, `cronNextDue`, `cronStaleWindow`, `CRON_COLLAPSE_CAP`, `CronRecurrenceDefinition`.
- Produces: `cronMissedSummary(window: { count: number; capped: boolean; lastStale: string }, firstIso: string, timezone: string, notReadyMessage: string | null): string` exported from `src/server/run-fold.ts`; `SchedulerService` private `runningTasks: Map<string, number>` (tests read it through a cast).

- [ ] **Step 1: Write the failing scheduler tests**

Create `tests/integration/scheduler-cron.test.ts`:

```ts
import * as os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalExecutionAdapter, type ExecutionResult } from "../../src/server/execution-adapter.js";
import { MISSED_UNAVAILABLE_SUMMARY } from "../../src/server/run-fold.js";
import { RunStore } from "../../src/server/run-store.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";
import type { RecurrenceDefinition } from "../../src/shared/model.js";

const everyMinute: RecurrenceDefinition = { scheduleType: "cron", timezone: "UTC", expression: "* * * * *" };
const daily: RecurrenceDefinition = { scheduleType: "daily", timezone: "UTC", localTime: "09:00" };
const T = "2026-11-01T12:00:00.000Z";
const TICK = "2026-11-01T12:00:10.000Z";
const NOT_READY = "Configure a local execution command to enable automatic prompt runs";

type Claim = { kind: string; nextRunAt: string | null };
type Internals = {
  claimOccurrence(workspacePath: string, taskId: string, scheduledFor: string, tickStartedAt: string): Promise<Claim>;
  runningTasks: Map<string, number>;
};

describe("cron scheduler safeguards", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;
  let store: RunStore;
  let adapter: LocalExecutionAdapter;
  let scheduler: SchedulerService;
  let key: string;
  let gates: Array<(result: ExecutionResult) => void>;

  const internals = () => scheduler as unknown as Internals;
  const succeeded = (): ExecutionResult => ({
    status: "succeeded",
    outcomeSummary: "ok",
    failureReason: null,
    executionRequest: { command: "x", args: [], cwd: workspacePath, promptTransport: "stdin" }
  });

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-cron-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new RunStore(":memory:");
    adapter = new LocalExecutionAdapter();
    gates = [];
    vi.spyOn(adapter, "execute").mockImplementation(() => new Promise((resolve) => gates.push(resolve)));
    scheduler = new SchedulerService(adapter, store);
    key = workspaceKeyFromPath(workspacePath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    store.close();
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function readyProfile() {
    await scheduler.saveExecutionProfile({ workspacePath, command: process.execPath, args: ["-e", ""], timeoutMs: 10_000 });
  }

  async function createTask(recurrence: RecurrenceDefinition, name = "Cron") {
    return scheduler.createTask({ workspacePath, name, prompt: "Go", recurrence });
  }

  async function setNextRunAt(taskId: string, iso: string) {
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks.find((entry) => entry.id === taskId)!.nextRunAt = iso;
    await saveWorkspaceLedger(ledger);
  }

  async function nextRunAtOf(taskId: string) {
    return (await loadWorkspaceLedger(workspacePath)).tasks.find((entry) => entry.id === taskId)!.nextRunAt;
  }

  async function waitFor(condition: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition never met");
  }

  describe("collapse", () => {
    it("records one missed event for an 8-hour gap, keyed on the first stale run", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
      const outcome = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", TICK);
      expect(outcome).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T11:59:00.000Z" });
      const runs = store.listRuns(key).runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "missed",
        scheduledFor: "2026-11-01T04:00:00.000Z",
        outcomeSummary:
          "Missed 479 runs between 2026-11-01 04:00 UTC and 2026-11-01 11:58 UTC (the scheduler did not run them in time)."
      });
      expect(await nextRunAtOf(task.id)).toBe("2026-11-01T11:59:00.000Z");
    });

    it("starts the run due within the grace window on the same tick", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(TICK));
      await readyProfile();
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
      const tick = scheduler.tickWithoutDispatcher();
      await waitFor(() => gates.length === 1);
      gates[0]!(succeeded());
      await tick;
      const statuses = store.listRuns(key).runs.map((run) => [run.status, run.scheduledFor]);
      expect(statuses).toEqual([
        ["succeeded", "2026-11-01T11:59:00.000Z"],
        ["missed", "2026-11-01T04:00:00.000Z"]
      ]);
    });

    it("uses the capability message as the reason when the profile is not ready", async () => {
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
      await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", TICK);
      expect(store.listRuns(key).runs[0]?.outcomeSummary).toBe(
        `Missed 479 runs between 2026-11-01 04:00 UTC and 2026-11-01 11:58 UTC (${NOT_READY}).`
      );
    });

    it("caps the count at 1,440", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, "2026-10-31T11:00:00.000Z");
      await internals().claimOccurrence(workspacePath, task.id, "2026-10-31T11:00:00.000Z", TICK);
      expect(store.listRuns(key).runs[0]?.outcomeSummary).toBe(
        "Missed 1,440 or more runs between 2026-10-31 11:00 UTC and 2026-11-01 11:58 UTC (the scheduler did not run them in time)."
      );
    });

    it("groups thousands and uses today's text for a single stale run", async () => {
      await readyProfile();
      const many = await createTask(everyMinute, "Many");
      await setNextRunAt(many.id, "2026-10-31T15:59:00.000Z");
      await internals().claimOccurrence(workspacePath, many.id, "2026-10-31T15:59:00.000Z", TICK);
      const one = await createTask(everyMinute, "One");
      await setNextRunAt(one.id, "2026-11-01T11:58:00.000Z");
      await internals().claimOccurrence(workspacePath, one.id, "2026-11-01T11:58:00.000Z", TICK);
      const summaries = store.listRuns(key).runs.map((run) => run.outcomeSummary);
      expect(summaries).toContain(
        "Missed 1,200 runs between 2026-10-31 15:59 UTC and 2026-11-01 11:58 UTC (the scheduler did not run them in time)."
      );
      expect(summaries).toContain(MISSED_UNAVAILABLE_SUMMARY);
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "does not record a second event when a retried tick computes a different window",
      async () => {
        await readyProfile();
        const task = await createTask(everyMinute);
        await setNextRunAt(task.id, "2026-11-01T04:00:00.000Z");
        const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
        await chmod(dataDir, 0o500);
        try {
          await expect(
            internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", TICK)
          ).rejects.toThrow();
        } finally {
          await chmod(dataDir, 0o700);
        }
        expect(await nextRunAtOf(task.id)).toBe("2026-11-01T04:00:00.000Z");
        const retry = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T04:00:00.000Z", "2026-11-01T12:00:40.000Z");
        expect(retry).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T12:00:00.000Z" });
        expect(store.listRuns(key).runs).toHaveLength(1);
      }
    );

    it("keeps one missed event per occurrence for a daily task", async () => {
      await readyProfile();
      const task = await createTask(daily);
      await setNextRunAt(task.id, "2026-10-30T09:00:00.000Z");
      let scheduledFor: string | null = "2026-10-30T09:00:00.000Z";
      while (scheduledFor && scheduledFor <= TICK) {
        scheduledFor = (await internals().claimOccurrence(workspacePath, task.id, scheduledFor, TICK)).nextRunAt;
      }
      expect(store.listRuns(key).runs.map((run) => run.status)).toEqual(["missed", "missed", "missed"]);
    });
  });

  describe("overlap", () => {
    async function startScheduled(taskId: string, scheduledFor: string) {
      await setNextRunAt(taskId, scheduledFor);
      return internals().claimOccurrence(workspacePath, taskId, scheduledFor, new Date(Date.parse(scheduledFor) + 5_000).toISOString());
    }

    it("skips a due run while the same cron task is running, without a record", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      expect((await startScheduled(task.id, T)).kind).toBe("started");
      await setNextRunAt(task.id, "2026-11-01T12:01:00.000Z");
      const skip = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T12:01:00.000Z", "2026-11-01T12:01:05.000Z");
      expect(skip).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T12:02:00.000Z" });
      expect(store.listRuns(key).runs).toHaveLength(1);
    });

    it("jumps a stale backlog in one claim while running, without a record", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      expect((await startScheduled(task.id, "2026-11-01T08:00:00.000Z")).kind).toBe("started");
      await setNextRunAt(task.id, "2026-11-01T09:00:00.000Z");
      const skip = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T09:00:00.000Z", TICK);
      expect(skip).toEqual({ kind: "advanced", nextRunAt: "2026-11-01T11:59:00.000Z" });
      expect(store.listRuns(key).runs).toHaveLength(1);
    });

    it("keeps counting a scheduled run after an overlapping manual run ends", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      const tickPromise = (async () => {
        const claim = await startScheduled(task.id, T);
        expect(claim.kind).toBe("started");
      })();
      await tickPromise;
      const manual = scheduler.createManualRun(task.id, workspacePath);
      await waitFor(() => gates.length === 1);
      expect(internals().runningTasks.get(task.id)).toBe(2);
      gates[0]!(succeeded());
      await manual;
      expect(internals().runningTasks.get(task.id)).toBe(1);
      await setNextRunAt(task.id, "2026-11-01T12:01:00.000Z");
      const skip = await internals().claimOccurrence(workspacePath, task.id, "2026-11-01T12:01:00.000Z", "2026-11-01T12:01:05.000Z");
      expect(skip.kind).toBe("advanced");
    });

    it("does not change the count when a manual run's started append throws", async () => {
      await readyProfile();
      const task = await createTask(everyMinute);
      expect((await startScheduled(task.id, T)).kind).toBe("started");
      const original = store.appendEvent.bind(store);
      vi.spyOn(store, "appendEvent").mockImplementation((event) => {
        if (event.source === "manual" && event.type === "started") throw new Error("disk full");
        original(event);
      });
      await expect(scheduler.createManualRun(task.id, workspacePath)).rejects.toThrow("disk full");
      expect(internals().runningTasks.get(task.id)).toBe(1);
    });

    it("still starts a daily task while a manual run of it executes", async () => {
      await readyProfile();
      const task = await createTask(daily);
      const manual = scheduler.createManualRun(task.id, workspacePath);
      await waitFor(() => gates.length === 1);
      expect((await startScheduled(task.id, "2026-11-01T09:00:00.000Z")).kind).toBe("started");
      gates[0]!(succeeded());
      await manual;
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "releases the count when the claim's save fails after started",
      async () => {
        await readyProfile();
        const task = await createTask(everyMinute);
        await setNextRunAt(task.id, T);
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const dataDir = path.join(tempHome, ".cloudcli-workspace-scheduled-prompts");
        await chmod(dataDir, 0o500);
        try {
          await expect(internals().claimOccurrence(workspacePath, task.id, T, "2026-11-01T12:00:05.000Z")).rejects.toThrow();
        } finally {
          await chmod(dataDir, 0o700);
        }
        expect(internals().runningTasks.get(task.id) ?? 0).toBe(0);
      }
    );

    // Review Focus 5
    it("a failing execution still releases the running count", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T12:00:05.000Z"));
      await readyProfile();
      vi.mocked(adapter.execute).mockRejectedValueOnce(new Error("crashed"));
      const task = await createTask(everyMinute);
      await setNextRunAt(task.id, T);
      await scheduler.tickWithoutDispatcher();
      expect(store.listRuns(key).runs[0]).toMatchObject({ status: "failed", outcomeSummary: "crashed" });
      expect(internals().runningTasks.get(task.id) ?? 0).toBe(0);
    });
  });

  describe("normalisation", () => {
    it("stores nicknames and spacing normalised on create and update", async () => {
      const task = await createTask({ scheduleType: "cron", timezone: "UTC", expression: "  @DAILY " });
      expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.recurrence).toEqual({
        scheduleType: "cron",
        timezone: "UTC",
        expression: "@daily"
      });
      await scheduler.updateTask(task.id, {
        workspacePath,
        recurrence: { scheduleType: "cron", timezone: "UTC", expression: " 0  9 * *  * " }
      });
      expect((await loadWorkspaceLedger(workspacePath)).tasks[0]?.recurrence).toMatchObject({ expression: "0 9 * * *" });
    });

    it("keeps nextRunAt when an edit repeats the stored expression with different spacing", async () => {
      const task = await createTask({ scheduleType: "cron", timezone: "UTC", expression: "0 9 * * *" });
      await setNextRunAt(task.id, "2026-11-01T09:00:00.000Z");
      await scheduler.updateTask(task.id, {
        workspacePath,
        prompt: "Edited",
        recurrence: { scheduleType: "cron", timezone: "UTC", expression: "  0 9  * * * " }
      });
      expect(await nextRunAtOf(task.id)).toBe("2026-11-01T09:00:00.000Z");
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/scheduler-cron.test.ts`
Expected: FAIL — collapse tests see per-occurrence `missed` events with `MISSED_UNAVAILABLE_SUMMARY`, overlap tests see a second `started`, `runningTasks` is undefined, normalisation tests see `"  @DAILY "`.

- [ ] **Step 3: Add `cronMissedSummary` to `src/server/run-fold.ts`**

Add the import and function:

```ts
import { DateTime } from "luxon";
```

```ts
function formatCollapseTime(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(timezone).setLocale("en").toFormat("yyyy-LL-dd HH:mm ZZZZ");
}

/** The collapsed missed-run message (design §3 "Collapse"). */
export function cronMissedSummary(
  window: { count: number; capped: boolean; lastStale: string },
  firstIso: string,
  timezone: string,
  notReadyMessage: string | null
): string {
  if (window.count === 1) {
    return notReadyMessage ?? MISSED_UNAVAILABLE_SUMMARY;
  }
  const reason = notReadyMessage ? notReadyMessage.replace(/\.$/, "") : "the scheduler did not run them in time";
  const between = `between ${formatCollapseTime(firstIso, timezone)} and ${formatCollapseTime(window.lastStale, timezone)} (${reason}).`;
  return window.capped
    ? `Missed 1,440 or more runs ${between}`
    : `Missed ${window.count.toLocaleString("en-US")} runs ${between}`;
}
```

- [ ] **Step 4: Update imports and add the running count in `src/server/scheduler.ts`**

Replace the recurrence and run-fold imports:

```ts
import {
  computeTaskNextRun,
  CRON_COLLAPSE_CAP,
  cronNextDue,
  cronStaleWindow,
  formatRecurrenceSummary,
  normalizeRecurrence,
  occurrenceKeyForTask,
  validateRecurrenceDefinition
} from "./recurrence.js";
```

```ts
import {
  cronMissedSummary,
  deriveLastRunStatus,
  MISSED_UNAVAILABLE_SUMMARY,
  SAVE_FAILED_SUMMARY,
  STARTED_SUMMARY
} from "./run-fold.js";
```

Inside `SchedulerService`, after `inFlightOccurrences`:

```ts
  /** Executing runs per task (design §3 "Running-task count"); read only for cron tasks. */
  private readonly runningTasks = new Map<string, number>();

  private incrementRunning(taskId: string): void {
    this.runningTasks.set(taskId, (this.runningTasks.get(taskId) ?? 0) + 1);
  }

  private decrementRunning(taskId: string): void {
    const remaining = (this.runningTasks.get(taskId) ?? 0) - 1;
    if (remaining > 0) {
      this.runningTasks.set(taskId, remaining);
    } else {
      this.runningTasks.delete(taskId);
    }
  }
```

- [ ] **Step 5: Normalise in `createTask` and `updateTask`**

Replace the start of `createTask`:

```ts
  async createTask(request: CreateTaskRequest): Promise<WorkspaceTask> {
    const recurrence = normalizeRecurrence(request.recurrence);
    validateRecurrenceDefinition(recurrence);
    return this.mutateLedger(request.workspacePath, (ledger) => {
```

and inside it use `recurrence` instead of `request.recurrence` for `recurrence:` and `recurrenceSummary:`.

Replace `updateTask`:

```ts
  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<WorkspaceTask> {
    const normalized = request.recurrence ? { ...request, recurrence: normalizeRecurrence(request.recurrence) } : request;
    return this.mutateLedger(normalized.workspacePath, (ledger) =>
      this.derivedCopy(ledger, this.updateTaskLocked(ledger, taskId, normalized))
    );
  }
```

- [ ] **Step 6: Release the count and guard progress in `tickWorkspace`**

Replace the loop body of `tickWorkspace`:

```ts
      while (scheduledFor && scheduledFor <= tickStartedAt) {
        const outcome = await this.claimOccurrence(snapshot.workspacePath, viewTask.id, scheduledFor, tickStartedAt);
        if (outcome.kind === "started") {
          try {
            await this.executeAndRecord(outcome.run);
          } finally {
            this.inFlightOccurrences.delete(outcome.run.base.occurrenceKey);
            this.decrementRunning(outcome.run.base.taskId);
          }
          break;
        }
        if (outcome.kind === "skipped") {
          break;
        }
        if (outcome.nextRunAt !== null && outcome.nextRunAt <= scheduledFor) {
          logTickError(new Error(`next run ${outcome.nextRunAt} is not after ${scheduledFor}; stopping catch-up`), snapshot.workspaceKey);
          break;
        }
        scheduledFor = outcome.nextRunAt;
      }
```

- [ ] **Step 7: Replace `claimOccurrence` with the claim order of §3**

```ts
  /** Compare-and-set inside the lock; claim order design §3 steps 1–6. */
  private async claimOccurrence(
    workspacePath: string,
    taskId: string,
    scheduledFor: string,
    tickStartedAt: string
  ): Promise<ClaimOutcome> {
    const claim: { addedKey?: string; started?: ClaimedRun } = {};
    try {
      return await this.mutateLedger(workspacePath, (ledger): ClaimOutcome => {
        const task = ledger.tasks.find((entry) => entry.id === taskId);
        if (!task || !task.enabled || task.nextRunAt !== scheduledFor) {
          return { kind: "skipped", nextRunAt: null };
        }
        const workspaceKey = workspaceKeyFromPath(ledger.workspacePath);
        const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
        const stale = isOutsideExecutionGraceWindow(scheduledFor, tickStartedAt);
        const staleBeforeIso = new Date(Date.parse(tickStartedAt) - EXECUTION_GRACE_WINDOW_MS).toISOString();
        const cronRecurrence = task.recurrence.scheduleType === "cron" ? task.recurrence : null;

        // Step 1: already known.
        if (this.inFlightOccurrences.has(occurrenceKey) || this.runStore.hasOccurrence(workspaceKey, occurrenceKey)) {
          task.nextRunAt = cronRecurrence && stale
            ? cronNextDue(cronRecurrence, staleBeforeIso).nextDue
            : computeTaskNextRun(task, scheduledFor);
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        // Step 2: cron task still running.
        if (cronRecurrence && (this.runningTasks.get(task.id) ?? 0) > 0) {
          task.nextRunAt = stale
            ? cronNextDue(cronRecurrence, staleBeforeIso).nextDue
            : computeTaskNextRun(task, scheduledFor);
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        const base: RunBase = {
          runId: randomUUID(),
          workspaceKey,
          taskId: task.id,
          occurrenceKey,
          scheduledFor,
          source: "scheduler",
          retryOfRunId: null
        };
        const profile = ledger.executionProfile;
        const capability = resolveExecutionCapability(profile ?? null);
        const notReadyMessage = capability.status !== "ready" || !profile ? capability.message : null;

        // Step 3: cron, stale → collapse, keyed on the first stale occurrence.
        if (cronRecurrence && stale) {
          const window = cronStaleWindow(cronRecurrence, scheduledFor, staleBeforeIso, CRON_COLLAPSE_CAP);
          task.nextRunAt = window.nextDue;
          const summary = cronMissedSummary(window, scheduledFor, cronRecurrence.timezone, notReadyMessage);
          this.runStore.appendEvent({ ...base, type: "missed", at: nowIso(), summary, failureReason: summary });
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        task.nextRunAt = computeTaskNextRun(task, scheduledFor);

        // Steps 4–5: profile not ready, or other types stale → one missed event (as today).
        if (notReadyMessage !== null || stale) {
          const summary = notReadyMessage ?? MISSED_UNAVAILABLE_SUMMARY;
          this.runStore.appendEvent({ ...base, type: "missed", at: nowIso(), summary, failureReason: summary });
          return { kind: "advanced", nextRunAt: task.nextRunAt };
        }

        // Step 6: start.
        const executionRequest = this.executionAdapter.createRequest(task, profile!, scheduledFor);
        this.inFlightOccurrences.add(occurrenceKey);
        claim.addedKey = occurrenceKey;
        this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
        claim.started = { base, task: { ...task }, profile: profile!, executionRequest };
        this.incrementRunning(task.id);
        return { kind: "started", nextRunAt: task.nextRunAt, run: claim.started };
      });
    } catch (error) {
      if (claim.addedKey) {
        this.inFlightOccurrences.delete(claim.addedKey);
      }
      if (claim.started) {
        this.decrementRunning(claim.started.base.taskId);
        try {
          this.runStore.appendEvent({
            ...claim.started.base,
            type: "failed",
            at: nowIso(),
            summary: SAVE_FAILED_SUMMARY,
            failureReason: SAVE_FAILED_SUMMARY
          });
        } catch (appendError) {
          logTickError(appendError, claim.started.base.workspaceKey);
        }
      }
      throw error;
    }
  }
```

- [ ] **Step 8: Restructure `runManually`**

Replace the part after the not-ready branch:

```ts
    const executionRequest = this.executionAdapter.createRequest(task, profile, base.scheduledFor);
    this.runStore.appendEvent({ ...base, type: "started", at: nowIso(), summary: STARTED_SUMMARY, executionRequest });
    this.inFlightOccurrences.add(base.occurrenceKey);
    this.incrementRunning(task.id);
    try {
      await this.executeAndRecord({ base, task, profile, executionRequest });
    } finally {
      this.inFlightOccurrences.delete(base.occurrenceKey);
      this.decrementRunning(task.id);
    }
    return this.requireRun(runId);
```

- [ ] **Step 9: Run the scheduler tests to verify they pass**

Run: `npx vitest run tests/integration/scheduler-cron.test.ts tests/integration/scheduler-concurrency.test.ts tests/integration/scheduler-loop.test.ts`
Expected: PASS, including the unchanged "records all missed recurring occurrences in one tick" test in `scheduler-loop.test.ts`.

- [ ] **Step 10: Full suite and type check**

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: all green, tsc exits 0.

- [ ] **Step 11: Commit**

```bash
git add src/server/run-fold.ts src/server/scheduler.ts tests/integration/scheduler-cron.test.ts
git commit -m "plan(t02): Scheduler safeguards"
```

---

### Task 3: UI

**Files:**
- Create: `src/client/escape.ts`
- Modify: `src/server/recurrence.ts` (add `cronUpcomingRuns`, `cronFrequencyWarning`)
- Modify: `src/client/views/task-form.ts` (imports; `recurrenceFields`; `buildRecurrence`; preview; visibility)
- Modify: `src/client/views/schedule-list.ts:46-47`
- Test: `tests/unit/recurrence.test.ts` (warning cases), `tests/integration/task-form.test.ts` (form and list cases), `tests/integration/task-form-cache.test.ts` (create)

**Interfaces:**
- Consumes (Task 1): `normalizeRecurrence`, `validateRecurrenceDefinition`, `formatRecurrenceSummary`, `CronRecurrenceDefinition`.
- Produces:
  - `escapeHtml(value: string): string` from `src/client/escape.ts`
  - `cronUpcomingRuns(recurrence: CronRecurrenceDefinition, fromIso: string, count: number): string[]` and `cronFrequencyWarning(recurrence: CronRecurrenceDefinition, nowIso: string): string | null` from `src/server/recurrence.ts`
  - form DOM hooks: input `name="cronExpression"`, preview children `[data-testid="task-form-summary"]`, `[data-testid="task-form-run"]` (×5), `[data-testid="task-form-warning"]`

- [ ] **Step 1: Write the failing warning tests**

Append inside `describe("cron", …)` in `tests/unit/recurrence.test.ts` (add `cronFrequencyWarning`, `cronUpcomingRuns` to the import):

```ts
  it.each([
    ["* * * * *", "2026-11-02T10:00:00.000Z", "Runs as often as every 1 min, 1,440 times in 24 hours. Each run sends the prompt to Claude."],
    ["* 9 * * *", "2026-11-02T10:00:00.000Z", "Runs as often as every 1 min, 60 times in 24 hours. Each run sends the prompt to Claude."],
    ["* 9 * * MON-FRI", "2026-11-06T10:00:00.000Z", "Runs as often as every 1 min, 60 times in 24 hours. Each run sends the prompt to Claude."],
    ["0,2 9 * * *", "2026-11-02T09:01:00.000Z", "Runs as often as every 2 min, 2 times in 24 hours. Each run sends the prompt to Claude."],
    ["*/2 * * * *", "2026-11-02T10:00:00.000Z", "Runs as often as every 2 min, 720 times in 24 hours. Each run sends the prompt to Claude."],
    ["*/10 * * * *", "2026-11-02T10:00:00.000Z", null]
  ])("frequency warning for %s at %s", (expression, now, expected) => {
    expect(cronFrequencyWarning(cron(expression, "UTC"), now)).toBe(expected);
  });

  it("lists upcoming runs", () => {
    expect(cronUpcomingRuns(cron("0 9 * * MON-FRI"), "2026-11-02T08:00:00.000Z", 3)).toEqual([
      "2026-11-03T08:00:00.000Z",
      "2026-11-04T08:00:00.000Z",
      "2026-11-05T08:00:00.000Z"
    ]);
  });
```

- [ ] **Step 2: Write the failing form and list tests**

Append to `tests/integration/task-form.test.ts` (add `afterEach` to the vitest import, and import `renderScheduleList`):

```ts
import { renderScheduleList } from "../../src/client/views/schedule-list.js";

describe("task form — cron", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function cronForm(task: WorkspaceTask | null = null) {
    const onSubmit = vi.fn();
    const section = renderTaskForm(task, { onSubmit, onCancelEdit: vi.fn() });
    return { section, onSubmit };
  }
  const submit = (section: HTMLElement) =>
    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const scope = (section: HTMLElement, name: string) =>
    section.querySelector<HTMLElement>(`[data-schedule-scope="${name}"]`);

  it("shows the cron field and hides Local Time when Cron is chosen", () => {
    const { section } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "Europe/Amsterdam" });
    expect(scope(section, "cron")?.hidden).toBe(false);
    expect(scope(section, "timed")?.hidden).toBe(true);
    expect(section.querySelector<HTMLInputElement>('[name="cronExpression"]')?.value).toBe("0 9 * * MON-FRI");
  });

  it("previews the summary and exactly 5 runs in English", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T08:00:00.000Z"));
    const { section } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "Europe/Amsterdam", cronExpression: "0 9 * * MON-FRI" });
    expect(section.querySelector('[data-testid="task-form-summary"]')?.textContent).toBe(
      "At 09:00, Monday through Friday (Europe/Amsterdam)"
    );
    const runs = [...section.querySelectorAll('[data-testid="task-form-run"]')].map((node) => node.textContent);
    expect(runs).toEqual(["Tue 3 Nov 09:00", "Wed 4 Nov 09:00", "Thu 5 Nov 09:00", "Fri 6 Nov 09:00", "Mon 9 Nov 09:00"]);
    expect(section.querySelector('[data-testid="task-form-warning"]')).toBeNull();
  });

  it.each([
    ["0 9 15W * *", "W (nearest weekday) is not supported."],
    ["H 9 * * *", "H (random values) is not supported."]
  ])("blocks %s with its message", (cronExpression, message) => {
    const { section, onSubmit } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "Europe/Amsterdam", cronExpression });
    submit(section);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(section.querySelector('[data-testid="task-form-feedback"]')?.textContent).toBe(message);
  });

  it("warns for a frequent expression and still submits it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00.000Z"));
    const { section, onSubmit } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "UTC", cronExpression: "* * * * *" });
    expect(section.querySelector('[data-testid="task-form-warning"]')?.textContent).toBe(
      "Runs as often as every 1 min, 1,440 times in 24 hours. Each run sends the prompt to Claude."
    );
    submit(section);
    expect(onSubmit).toHaveBeenCalledWith({
      name: "N",
      prompt: "P",
      recurrence: { scheduleType: "cron", timezone: "UTC", expression: "* * * * *" }
    });
  });

  it("submits the normalised expression", () => {
    const { section, onSubmit } = cronForm();
    seedForm(section, { name: "N", prompt: "P", scheduleType: "cron", timezone: "UTC", cronExpression: "  @DAILY " });
    submit(section);
    expect(onSubmit.mock.calls[0]?.[0].recurrence).toEqual({ scheduleType: "cron", timezone: "UTC", expression: "@daily" });
  });

  const cronTask = (overrides: Partial<WorkspaceTask> = {}): WorkspaceTask => ({
    id: "task-cron",
    workspaceKey: "workspace-1",
    workspacePath: "/tmp/project",
    name: "Cron task",
    prompt: "Go",
    recurrence: { scheduleType: "cron", timezone: "Europe/Amsterdam", expression: "*/15 9-17 * * MON-FRI" },
    recurrenceSummary: "Every 15 minutes, between 09:00 and 17:59, Monday through Friday (Europe/Amsterdam)",
    enabled: true,
    nextRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides
  });

  it("edits a cron task with its stored expression", () => {
    const { section } = cronForm(cronTask());
    expect(section.querySelector<HTMLSelectElement>('[name="scheduleType"]')?.value).toBe("cron");
    expect(section.querySelector<HTMLInputElement>('[name="cronExpression"]')?.value).toBe("*/15 9-17 * * MON-FRI");
  });

  // Review Focus 2
  it("switching a daily task to Cron saves the default", () => {
    const daily = cronTask({ recurrence: { scheduleType: "daily", timezone: "UTC", localTime: "09:00" }, recurrenceSummary: "Daily" });
    const { section, onSubmit } = cronForm(daily);
    seedForm(section, { scheduleType: "cron" });
    submit(section);
    expect(onSubmit.mock.calls[0]?.[0].recurrence).toEqual({ scheduleType: "cron", timezone: "UTC", expression: "0 9 * * MON-FRI" });
  });

  it("renders quotes and angle brackets as text in the form and the schedule list", () => {
    const tricky = 'Say "hi" <b>now</b>';
    const task = cronTask({
      name: tricky,
      recurrence: { scheduleType: "cron", timezone: "Europe/Amsterdam", expression: '0 9 * * "<x>"' },
      recurrenceSummary: `Cron: 0 9 * * "<x>" (Europe/Amsterdam)`
    });
    const { section } = cronForm(task);
    expect(section.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe(tricky);
    expect(section.querySelector<HTMLInputElement>('[name="cronExpression"]')?.value).toBe('0 9 * * "<x>"');
    expect(section.querySelector("b")).toBeNull();

    const list = renderScheduleList([task], {
      onEdit: vi.fn(), onDelete: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onDuplicate: vi.fn(), onRunNow: vi.fn()
    });
    expect(list.querySelector("strong")?.textContent).toBe(tricky);
    expect(list.querySelector(".wsp-task-head p")?.textContent).toBe(`Cron: 0 9 * * "<x>" (Europe/Amsterdam)`);
    expect(list.querySelector("b")).toBeNull();
  });
});
```

Create `tests/integration/task-form-cache.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/recurrence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/recurrence.js")>();
  return { ...actual, validateRecurrenceDefinition: vi.fn(actual.validateRecurrenceDefinition) };
});

const recurrence = await import("../../src/server/recurrence.js");
const { renderTaskForm } = await import("../../src/client/views/task-form.js");

function type(section: HTMLElement, name: string, value: string): void {
  const field = section.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("task form validation cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-validate an unchanged cron expression while other fields change", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:10.000Z"));
    const section = renderTaskForm(null, { onSubmit: vi.fn(), onCancelEdit: vi.fn() });
    type(section, "prompt", "P");
    type(section, "scheduleType", "cron");
    type(section, "cronExpression", "0 9 31 4,6,9,11 *");
    type(section, "name", "N");
    const validate = vi.mocked(recurrence.validateRecurrenceDefinition);
    validate.mockClear();
    type(section, "name", "Na");
    type(section, "name", "Nam");
    type(section, "name", "Name");
    expect(validate).not.toHaveBeenCalled();
    expect(section.querySelector('[data-testid="task-form-feedback"]')?.textContent).toBe("This cron expression never matches a date.");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/recurrence.test.ts tests/integration/task-form.test.ts tests/integration/task-form-cache.test.ts`
Expected: FAIL — `cronFrequencyWarning`/`cronUpcomingRuns` not exported; no `cronExpression` field / no `cron` option; the schedule list renders a `<b>` element; the cache test sees validation calls.

- [ ] **Step 4: Add `cronUpcomingRuns` and `cronFrequencyWarning` to `src/server/recurrence.ts`**

```ts
export function cronUpcomingRuns(recurrence: CronRecurrenceDefinition, fromIso: string, count: number): string[] {
  const iterator = parseCron(recurrence, fromIso);
  return Array.from({ length: count }, () => cronIso(iterator.next()));
}

const WARNING_GAP_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Design §2: smallest gap over the next 25 runs; count in the 24 h from the first upcoming run. */
export function cronFrequencyWarning(recurrence: CronRecurrenceDefinition, nowIso: string): string | null {
  const upcoming = cronUpcomingRuns(recurrence, nowIso, 25).map((iso) => Date.parse(iso));
  let smallestGap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < upcoming.length; index += 1) {
    smallestGap = Math.min(smallestGap, upcoming[index]! - upcoming[index - 1]!);
  }
  if (smallestGap >= WARNING_GAP_MS) {
    return null;
  }
  const windowStart = upcoming[0]!;
  const windowEnd = windowStart + DAY_MS;
  const counter = parseCron(recurrence, new Date(windowStart - 1).toISOString());
  let runs = 0;
  while (runs < CRON_COLLAPSE_CAP && Date.parse(cronIso(counter.next())) < windowEnd) {
    runs += 1;
  }
  const minutes = Math.max(1, Math.floor(smallestGap / 60_000));
  return `Runs as often as every ${minutes} min, ${runs.toLocaleString("en-US")} times in 24 hours. Each run sends the prompt to Claude.`;
}
```

- [ ] **Step 5: Create `src/client/escape.ts`**

```ts
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes a user-controlled value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}
```

- [ ] **Step 6: Escape the schedule list**

In `src/client/views/schedule-list.ts`, add `import { escapeHtml } from "../escape.js";` and replace lines 46–47:

```ts
          <strong>${escapeHtml(task.name)}</strong>
          <p>${escapeHtml(task.recurrenceSummary)}</p>
```

- [ ] **Step 7: Update `src/client/views/task-form.ts`**

Imports:

```ts
import { DateTime } from "luxon";
import type { CreateTaskRequest } from "../../shared/contracts.js";
import type {
  CronRecurrenceDefinition,
  DailyRecurrenceDefinition,
  MonthlyRecurrenceDefinition,
  OneTimeRecurrenceDefinition,
  RecurrenceDefinition,
  ScheduleType,
  WeekdayName,
  WeekdaysRecurrenceDefinition,
  WeeklyRecurrenceDefinition,
  WorkspaceTask
} from "../../shared/model.js";
import {
  cronFrequencyWarning,
  cronUpcomingRuns,
  formatRecurrenceSummary,
  nextOccurrenceForRecurrence,
  normalizeRecurrence,
  validateRecurrenceDefinition
} from "../../server/recurrence.js";
import { escapeHtml } from "../escape.js";

const DEFAULT_CRON_EXPRESSION = "0 9 * * MON-FRI";
```

In `recurrenceFields`, add after the `dayOfMonth` constant:

```ts
  const cronExpression = recurrence?.scheduleType === "cron" ? recurrence.expression : DEFAULT_CRON_EXPRESSION;
```

and change the template: add the option, escape values, add the field (keep everything else as it is):

```ts
        <option value="monthly"${scheduleType === "monthly" ? " selected" : ""}>Monthly</option>
        <option value="cron"${scheduleType === "cron" ? " selected" : ""}>Cron expression</option>
```

```ts
      <input id="wsp-timezone" name="timezone" value="${escapeHtml(timezone)}" placeholder="Europe/Paris">
```

```ts
      <input id="wsp-local-time" name="localTime" value="${escapeHtml(localTime)}" placeholder="09:00" inputmode="numeric">
```

```ts
      <input id="wsp-run-at" name="runAt" value="${escapeHtml(runAt)}" placeholder="2026-04-26T09:00:00.000Z">
```

and append after the monthly field `</div>`:

```ts
    <div class="wsp-field wsp-field-span-2" data-schedule-scope="cron">
      <label for="wsp-cron-expression">Cron Expression</label>
      <input id="wsp-cron-expression" name="cronExpression" value="${escapeHtml(cronExpression)}" placeholder="*/15 9-17 * * MON-FRI" spellcheck="false" style="font-family: ui-monospace, monospace">
      <p>minute hour day-of-month month day-of-week · supports * , - / L # ? and @daily-style nicknames · W and H not supported</p>
    </div>
```

In `buildRecurrence`, add before `default:`:

```ts
    case "cron":
      return normalizeRecurrence({
        scheduleType,
        timezone,
        expression: String(formData.get("cronExpression") ?? "")
      } satisfies CronRecurrenceDefinition);
```

In `renderTaskForm`'s template, escape the name and prompt:

```ts
          <input id="wsp-name" name="name" value="${escapeHtml(task?.name ?? "")}" required placeholder="Morning summary">
```

```ts
          <textarea id="wsp-prompt" name="prompt" rows="6" required placeholder="Summarize the workspace and highlight blockers.">${escapeHtml(task?.prompt ?? "")}</textarea>
```

In `syncVisibility`, replace the `timed` toggle and add the cron toggle:

```ts
    toggle("timed", scheduleType !== "one_time" && scheduleType !== "cron");
    toggle("cron", scheduleType === "cron");
```

Add the cron preview helpers above `renderTaskForm`:

```ts
type CronPreview = { ok: true; summary: string; runs: string[]; warning: string | null } | { ok: false; message: string };

function formatPreviewRun(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(timezone).setLocale("en").toFormat("ccc d LLL HH:mm");
}

function buildCronPreview(recurrence: CronRecurrenceDefinition): CronPreview {
  try {
    validateRecurrenceDefinition(recurrence);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Invalid schedule." };
  }
  const now = new Date().toISOString();
  return {
    ok: true,
    summary: formatRecurrenceSummary(recurrence),
    runs: cronUpcomingRuns(recurrence, now, 5).map((iso) => formatPreviewRun(iso, recurrence.timezone)),
    warning: cronFrequencyWarning(recurrence, now)
  };
}

function previewLine(testId: string, text: string): HTMLElement {
  const line = document.createElement("div");
  line.dataset.testid = testId;
  line.textContent = text;
  return line;
}
```

Inside `renderTaskForm`, before `refreshPreview`, add the cache:

```ts
  let cronCache: { key: string; preview: CronPreview } | null = null;
  const cronPreviewFor = (recurrence: CronRecurrenceDefinition): CronPreview => {
    const key = `${recurrence.expression}|${recurrence.timezone}|${new Date().toISOString().slice(0, 16)}`;
    if (cronCache?.key !== key) {
      cronCache = { key, preview: buildCronPreview(recurrence) };
    }
    return cronCache.preview;
  };
```

Replace the `try { … } catch { … }` block in `refreshPreview` with:

```ts
    try {
      const recurrence = buildRecurrence(formData);
      if (recurrence.scheduleType === "cron") {
        const cronPreview = cronPreviewFor(recurrence);
        if (!cronPreview.ok) {
          preview.textContent = "Preview unavailable.";
          feedback.textContent = cronPreview.message;
          return null;
        }
        preview.replaceChildren(
          previewLine("task-form-summary", cronPreview.summary),
          ...cronPreview.runs.map((run) => previewLine("task-form-run", run)),
          ...(cronPreview.warning ? [previewLine("task-form-warning", cronPreview.warning)] : [])
        );
        return recurrence;
      }
      validateRecurrenceDefinition(recurrence);
      preview.textContent = summarizeDraft(recurrence);
      return recurrence;
    } catch (error) {
      preview.textContent = "Preview unavailable.";
      feedback.textContent = error instanceof Error ? error.message : "Invalid schedule.";
      return null;
    }
```

- [ ] **Step 8: Run the UI tests to verify they pass**

Run: `npx vitest run tests/unit/recurrence.test.ts tests/integration/task-form.test.ts tests/integration/task-form-cache.test.ts`
Expected: PASS.

- [ ] **Step 9: Full suite, type check and build**

Run: `npm test && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: all green; `dist/index.js` builds (esbuild bundles `cron-parser` and `cronstrue`).

- [ ] **Step 10: Commit**

```bash
git add src/client/escape.ts src/server/recurrence.ts src/client/views/task-form.ts src/client/views/schedule-list.ts tests/unit/recurrence.test.ts tests/integration/task-form.test.ts tests/integration/task-form-cache.test.ts
git commit -m "plan(t03): UI"
```

---

### Task 4: Docs, version 0.4.0 and production build check

**Files:**
- Modify: `README.md` (What It Does, Create A Schedule, Execution Timing, Known Limits; new "Cron Expressions" section)
- Modify: `CHANGELOG.md`, `package.json`, `manifest.json`, `package-lock.json`

**Interfaces:**
- Consumes: everything above. Produces: docs and version only; no code changes.

- [ ] **Step 1: Update `README.md`**

In **What It Does**, after `  - monthly` add:

```markdown
  - cron expressions (`*/15 9-17 * * MON-FRI`), with a live summary, next runs and a frequency warning
```

After the **3. Create A Schedule** section, add:

````markdown
### Cron Expressions

Choose **Cron expression** as the schedule type and enter 5 fields: `minute hour day-of-month month day-of-week`, evaluated in the task's time zone.

- Supported: `*` `,` `-` `/`, month and weekday names, `?`, `L` (last day of the month), `5L` (last Friday), `FRI#3` (third Friday), and `@yearly` `@annually` `@monthly` `@weekly` `@daily` `@hourly` in any case.
- Not supported (rejected with a message): `W` (nearest weekday), `H` (random values), seconds (6 fields), `@midnight`, `@reboot`, and expressions that never match a date such as `0 9 31 2 *`.
- When day-of-month and day-of-week are both set, a run happens when either matches (as in crontab).
- The preview shows the plain-English meaning and the next 5 runs; schedules that run less than 5 minutes apart get a warning.

```text
*/15 9-17 * * MON-FRI   every 15 minutes, 09:00–17:59, Monday to Friday
0 9 L * *               09:00 on the last day of each month
0 9 * * FRI#3           09:00 on the third Friday
@daily                  every day at 00:00
```
````

In **Execution Timing**, add:

```markdown
- After downtime, a cron task records one `missed` entry summarising how many runs were missed and between which times, then continues with the next due run.
- A cron task never starts a scheduled run while another run of the same task is still executing; the skipped occurrence is not recorded.
```

In **Known Limits**, remove `- No cron syntax`.

- [ ] **Step 2: Update `CHANGELOG.md` and the versions**

Insert above `## [0.3.0]`:

```markdown
## [0.4.0] - 2026-11-01

### Added

- "Cron expression" schedule type: standard 5-field syntax with `L`, `#`, `?` and `@daily`-style nicknames, a live plain-English summary, the next 5 runs and a warning for schedules less than 5 minutes apart.
- Specific messages for unsupported cron syntax (`W`, `H`, seconds, other nicknames) and for expressions that never match a date.
- After downtime, missed runs of a cron task are recorded as one summarised entry.
- A cron task skips a scheduled run while another run of the same task is still executing.

### Fixed

- Quotes and angle brackets in task names and form values no longer break the form or the schedule list.
```

Set `"version": "0.4.0"` in `package.json` and `manifest.json`, then:

```bash
npm install --package-lock-only
```

Expected: `package-lock.json` root `version` is `0.4.0`.

- [ ] **Step 3: Verify, including a production-mode build in a fresh copy**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npm run build
T=$(mktemp -d) && git ls-files -z | xargs -0 -I{} cp --parents {} "$T"/ && cp package.json package-lock.json "$T"/ && (cd "$T" && NODE_ENV=production npm install --ignore-scripts --no-audit --no-fund >/dev/null && NODE_ENV=production npm run build && ls dist/index.js dist/server.js); rm -rf "$T"
```

Expected: tests and tsc green; both builds succeed and list `dist/index.js` and `dist/server.js`.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md package.json manifest.json package-lock.json
git commit -m "plan(t04): Docs, version 0.4.0"
```

- [ ] **Step 5: Manual verification (design "Done when") — controller, not the implementer**

1. Merge to the fork's `master`, push to `krugerm/cloudcli-cron`, update the installed plugin (this machine and `mantis2`).
2. In CloudCLI, create a cron task `*/2 * * * *`: the form shows its summary ("Every 2 minutes (…)"), 5 next runs and the frequency warning ("Runs as often as every 2 min, 720 times in 24 hours. …").
3. Save it with a ready execution profile; within 5 minutes Recent Runs shows two runs 2 minutes apart, each with a History.

---

## Self-review (completed while writing)

- **Spec coverage:**
  - FR-001/004/005/010: Task 3.
  - FR-002/003/006: Task 1.
  - FR-007: Tasks 1–2 (cron-only branches; daily per-occurrence test; existing scheduler tests stay green).
  - FR-008: Task 2 (collapse, cap, not-ready reason, retry without duplicate).
  - FR-009: Task 2 (overlap, manual runs, daily unaffected).
  - FR-011: Task 3 (existing feedback/preview states reused).
  - SC-001–005: Tasks 1–3 tests; SC-001 by manual verification (Task 4).
- **Placeholder scan:** no "TBD"/"TODO"/"implement later"/"similar to Task" in this file.
- **Type consistency:** `CronRecurrenceDefinition`, `normalizeRecurrence`, `cronNextDue`, `cronStaleWindow`, `CRON_COLLAPSE_CAP`, `cronMissedSummary`, `cronUpcomingRuns`, `cronFrequencyWarning`, `escapeHtml`, `runningTasks` are named identically in every task.
- **Exact outputs:** every expected date, summary, warning and collapse string in the tests above was produced by running a prototype of this code against `cron-parser` 5.10.3, `cronstrue` 3.38.0 and luxon 3.7.2 on 2026-11-01.
- **Review Focus:** 1 → Task 1 (lower-case names); 2 → Task 3 (switch to Cron saves default); 3 → Task 1 (time zone before expression); 4 → Task 1 (tabs/newlines); 5 → Task 2 (failing execution releases the count).
