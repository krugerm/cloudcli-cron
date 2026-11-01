import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import { DateTime } from "luxon";
import type {
  CronRecurrenceDefinition,
  MonthlyRecurrenceDefinition,
  RecurrenceDefinition,
  WeekdayName,
  WorkspaceTask
} from "../shared/model.js";

const WEEKDAY_TO_INDEX: Record<WeekdayName, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7
};

function requireValidZone(timezone: string): void {
  const sample = DateTime.now().setZone(timezone);
  if (!sample.isValid) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function parseLocalTime(localTime: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(localTime);
  if (!match) {
    throw new Error("localTime must be formatted as HH:mm");
  }

  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function candidateAt(date: any, localTime: string): any {
  const { hour, minute } = parseLocalTime(localTime);
  return date.set({ hour, minute, second: 0, millisecond: 0 });
}

function lastDayOfMonth(year: number, month: number, timezone: string): number {
  return DateTime.fromObject({ year, month, day: 1 }, { zone: timezone }).endOf("month").day;
}

function resolveMonthlyDay(definition: MonthlyRecurrenceDefinition, year: number, month: number): number {
  const maxDay = lastDayOfMonth(year, month, definition.timezone);
  return Math.min(definition.dayOfMonth, maxDay);
}

export const CRON_COLLAPSE_CAP = 1440;

const CRON_NICKNAMES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@hourly"]);
const CRON_FIELDS_HELP = "minute hour day-of-month month day-of-week";
const NEVER_MATCHES = "This cron expression never matches a date.";

function normalizeCronExpression(expression: string): string {
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
    if (due.lastBefore) {
      lastStale = due.lastBefore;
    } else {
      // The 61-minute walk started inside a DST gap window; prev() can skip the shifted run,
      // so step forward from it (stepping from an occurrence returns the shifted run).
      const forward = parseCron(recurrence, cronIso(parseCron(recurrence, staleBeforeIso).prev()));
      let last = cronIso(parseCron(recurrence, staleBeforeIso).prev());
      for (;;) {
        const candidate = cronIso(forward.next());
        if (candidate >= staleBeforeIso) {
          break;
        }
        last = candidate;
      }
      lastStale = last;
    }
  }
  return { count, capped, lastStale, nextDue: due.nextDue };
}

export function validateRecurrenceDefinition(recurrence: RecurrenceDefinition): void {
  requireValidZone(recurrence.timezone);

  switch (recurrence.scheduleType) {
    case "one_time": {
      const instant = DateTime.fromISO(recurrence.runAt, { zone: "utc" });
      if (!instant.isValid) {
        throw new Error("runAt must be a valid ISO timestamp");
      }
      return;
    }
    case "daily":
      parseLocalTime(recurrence.localTime);
      return;
    case "weekdays":
      parseLocalTime(recurrence.localTime);
      if (!recurrence.weekdays.length) {
        throw new Error("weekday schedules require at least one weekday");
      }
      for (const weekday of recurrence.weekdays) {
        if (!(weekday in WEEKDAY_TO_INDEX)) {
          throw new Error(`Invalid weekday: ${weekday}`);
        }
      }
      return;
    case "weekly":
      parseLocalTime(recurrence.localTime);
      if (!(recurrence.dayOfWeek in WEEKDAY_TO_INDEX)) {
        throw new Error("weekly schedules require a valid dayOfWeek");
      }
      return;
    case "monthly":
      parseLocalTime(recurrence.localTime);
      if (!Number.isInteger(recurrence.dayOfMonth) || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31) {
        throw new Error("monthly schedules require a dayOfMonth between 1 and 31");
      }
      return;
    case "cron":
      validateCronExpression(recurrence.expression, recurrence.timezone);
      return;
    default:
      throw new Error("Unsupported schedule type");
  }
}

export function nextOccurrenceForRecurrence(
  recurrence: RecurrenceDefinition,
  afterIso: string = new Date().toISOString()
): string | null {
  validateRecurrenceDefinition(recurrence);
  const afterUtc = DateTime.fromISO(afterIso, { zone: "utc" });
  const zoned = afterUtc.setZone(recurrence.timezone);

  switch (recurrence.scheduleType) {
    case "one_time": {
      const runAt = DateTime.fromISO(recurrence.runAt, { zone: "utc" });
      return runAt > afterUtc ? runAt.toUTC().toISO() : null;
    }
    case "daily": {
      let candidate = candidateAt(zoned, recurrence.localTime);
      if (candidate <= zoned) {
        candidate = candidate.plus({ days: 1 });
      }
      return candidate.toUTC().toISO();
    }
    case "weekdays": {
      const allowed = new Set(recurrence.weekdays.map((weekday) => WEEKDAY_TO_INDEX[weekday]));
      for (let offset = 0; offset <= 14; offset += 1) {
        const day = zoned.plus({ days: offset });
        if (!allowed.has(day.weekday)) {
          continue;
        }
        const candidate = candidateAt(day, recurrence.localTime);
        if (candidate > zoned) {
          return candidate.toUTC().toISO();
        }
      }
      return null;
    }
    case "weekly": {
      const targetWeekday = WEEKDAY_TO_INDEX[recurrence.dayOfWeek];
      for (let offset = 0; offset <= 14; offset += 1) {
        const day = zoned.plus({ days: offset });
        if (day.weekday !== targetWeekday) {
          continue;
        }
        const candidate = candidateAt(day, recurrence.localTime);
        if (candidate > zoned) {
          return candidate.toUTC().toISO();
        }
      }
      return null;
    }
    case "monthly": {
      for (let offset = 0; offset <= 24; offset += 1) {
        const monthDate = zoned.plus({ months: offset }).startOf("month");
        const day = resolveMonthlyDay(recurrence, monthDate.year, monthDate.month);
        const candidate = candidateAt(monthDate.set({ day }), recurrence.localTime);
        if (candidate > zoned) {
          return candidate.toUTC().toISO();
        }
      }
      return null;
    }
    case "cron":
      return cronIso(parseCron(recurrence, afterUtc.toISO()!).next());
    default:
      return null;
  }
}

export function formatRecurrenceSummary(recurrence: RecurrenceDefinition): string {
  switch (recurrence.scheduleType) {
    case "one_time":
      return `One-time at ${DateTime.fromISO(recurrence.runAt, { zone: "utc" })
        .setZone(recurrence.timezone)
        .toFormat("yyyy-LL-dd HH:mm")} (${recurrence.timezone})`;
    case "daily":
      return `Daily at ${recurrence.localTime} (${recurrence.timezone})`;
    case "weekdays":
      return `${recurrence.weekdays.join(", ")} at ${recurrence.localTime} (${recurrence.timezone})`;
    case "weekly":
      return `Every ${recurrence.dayOfWeek} at ${recurrence.localTime} (${recurrence.timezone})`;
    case "monthly":
      return `Monthly on day ${recurrence.dayOfMonth} at ${recurrence.localTime} (${recurrence.timezone})`;
    case "cron": {
      const expression = normalizeCronExpression(recurrence.expression);
      try {
        return `${cronstrue.toString(expression, { use24HourTimeFormat: true })} (${recurrence.timezone})`;
      } catch {
        return `Cron: ${expression} (${recurrence.timezone})`;
      }
    }
    default:
      return "Unknown recurrence";
  }
}

export function computeTaskNextRun(task: WorkspaceTask, afterIso?: string): string | null {
  if (!task.enabled) {
    return null;
  }
  if (task.recurrence.scheduleType === "cron") {
    try {
      validateRecurrenceDefinition(task.recurrence);
    } catch {
      // A hand-edited ledger must not fail the load: such a task is listed but never scheduled.
      return null;
    }
  }
  return nextOccurrenceForRecurrence(task.recurrence, afterIso);
}

export function occurrenceKeyForTask(taskId: string, scheduledFor: string): string {
  return `${taskId}:${scheduledFor}`;
}
