import { describe, expect, it } from "vitest";
import {
  CRON_COLLAPSE_CAP,
  computeTaskNextRun,
  cronFrequencyWarning,
  cronNextDue,
  cronStaleWindow,
  cronUpcomingRuns,
  formatRecurrenceSummary,
  nextOccurrenceForRecurrence,
  normalizeRecurrence,
  validateRecurrenceDefinition
} from "../../src/server/recurrence.js";
import type { CronRecurrenceDefinition, WorkspaceTask } from "../../src/shared/model.js";

describe("recurrence", () => {
  it("computes the next daily occurrence", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      },
      "2026-04-26T07:00:00.000Z"
    );

    expect(next).toBeTruthy();
  });

  it("clamps monthly recurrences to the last day of short months", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      },
      "2026-04-28T07:00:00.000Z"
    );

    expect(next?.startsWith("2026-04-30") || next?.startsWith("2026-05-31")).toBe(true);
  });

  it("uses the last valid day for February when the monthly schedule targets the 31st", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      },
      "2026-02-01T00:00:00.000Z"
    );

    expect(next?.startsWith("2026-02-28T08:00")).toBe(true);
  });

  it("returns to the configured day when the following month supports it", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      },
      "2026-02-28T08:00:00.000Z"
    );

    expect(next?.startsWith("2026-03-31T07:00")).toBe(true);
  });

  it("renders human-readable summaries", () => {
    const summary = formatRecurrenceSummary({
      scheduleType: "weekly",
      timezone: "Europe/Paris",
      localTime: "09:00",
      dayOfWeek: "monday"
    });

    expect(summary).toContain("monday");
  });

  it("rejects invalid weekday values", () => {
    expect(() =>
      validateRecurrenceDefinition({
        scheduleType: "weekdays",
        timezone: "Europe/Paris",
        localTime: "09:00",
        weekdays: ["mon" as never]
      })
    ).toThrow("Invalid weekday: mon");
  });
});

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
    ["* * * *", "A cron expression needs 5 fields: minute hour day-of-month month day-of-week."],
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

  it("computes no next run for a task whose saved cron fails validation", () => {
    const task = {
      id: "t",
      enabled: true,
      recurrence: cron("0 9 31 2 *")
    } as unknown as WorkspaceTask;
    expect(computeTaskNextRun(task, after)).toBeNull();
    expect(computeTaskNextRun({ ...task, recurrence: cron("0 9 * * *") }, after)).toBe("2026-11-03T08:00:00.000Z");
    const broken = { ...task, recurrence: { scheduleType: "daily", timezone: AMS, localTime: "25:00" } } as unknown as WorkspaceTask;
    expect(() => computeTaskNextRun(broken, after)).toThrow("localTime must be formatted as HH:mm");
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

    it("reports the shifted run as lastStale when a capped walk starts inside the DST gap window", () => {
      const nightly = cron("30 2 * * *");
      expect(cronStaleWindow(nightly, "2026-03-25T01:30:00.000Z", "2026-03-29T02:15:00.000Z", 2)).toEqual({
        count: 2,
        capped: true,
        lastStale: "2026-03-29T01:30:00.000Z",
        nextDue: "2026-03-30T00:30:00.000Z"
      });
    });

    it("finds the next due run when the walk start lands in the DST gap window", () => {
      const nightly = cron("30 2 * * *");
      for (const staleBefore of ["2026-03-29T02:01:00.000Z", "2026-03-29T02:15:00.000Z", "2026-03-29T02:31:00.000Z"]) {
        expect(cronNextDue(nightly, staleBefore).nextDue).toBe("2026-03-30T00:30:00.000Z");
      }
      expect(cronNextDue(nightly, "2026-03-29T02:15:00.000Z").lastBefore).toBeNull();
    });

    it("bounds the work for a backlog of a year", () => {
      const started = performance.now();
      expect(cronStaleWindow(every, "2025-11-01T00:00:00.000Z", staleBefore, CRON_COLLAPSE_CAP).capped).toBe(true);
      expect(performance.now() - started).toBeLessThan(10_000);
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
});
