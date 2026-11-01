# Cron Expressions — Design

**Date:** 2026-11-01
**Branch:** `004-cron-expressions` (from `master` at `e9134a4`, which includes `003-run-event-log`)
**Spec-kit spec:** [`specs/004-cron-expressions/spec.md`](../../../specs/004-cron-expressions/spec.md)

## Goal

Let a user schedule a prompt with a standard cron expression (`*/15 9-17 * * MON-FRI`), so schedules that run more than once a day, or on patterns the five fixed schedule types can't express, become possible.

## Decisions

| Topic | Decision |
|---|---|
| UI | A new **"Cron expression"** schedule type with a raw text field, a live plain-English summary and the next 5 run times. No visual builder. |
| Syntax | 5 fields (`minute hour day-of-month month day-of-week`) with `*` `,` `-` `/`, month and weekday names, `?`, `L` (last day of month), `nL` (last weekday n of month), `#` (`FRI#3`), and the nicknames `@yearly` `@annually` `@monthly` `@weekly` `@daily` `@hourly`. |
| Rejected syntax | `W` (nearest weekday), 6-field expressions (seconds), any other field count, `@midnight`, `@reboot` — each with a specific message. |
| Engine | `cron-parser` ^5.10.2 for parsing and next occurrence (uses `luxon`, already a dependency, for time zones). |
| Summary | `cronstrue` ^3.38.0 (no dependencies), 24-hour format. |
| Existing types | Unchanged: `one_time`, `daily`, `weekdays`, `weekly`, `monthly`. No stored-data migration. |
| Run history | Already complete and paged since `003-run-event-log`; no caps are added. |

Rejected alternatives: a visual cron builder (about 3× the UI work for the same capability); converting the five existing types into cron (needs a data migration and changes `monthly` day-31 semantics); a separate cron scheduler (duplicates missed-run and history logic).

Verified with `cron-parser` 5.10.2 and `cronstrue` 3.38.0 on Node 22.23 (2026-10-31/11-01):

- `next()` returns a time strictly after `currentDate`.
- Time zones and daylight saving: `0 9 1 JAN,JUL *` in `Europe/Amsterdam` gives 08:00Z in January and 07:00Z in July.
- Day-of-month and day-of-week together match if either matches (crontab semantics).
- `cron-parser` accepts 6-field (seconds) and 3-field (`* * *`) expressions and `@midnight`/`@reboot` fail only with "cannot resolve alias", so the plugin's own validation must run first.
- Both libraries bundle with esbuild for the browser (`--platform=browser --format=esm`).

## 1. Model and engine

### Model — `src/shared/model.ts`

- `ScheduleType` gains `"cron"`.
- New `CronRecurrenceDefinition extends BaseRecurrenceDefinition { scheduleType: "cron"; expression: string }` (`timezone` comes from the base). It joins the `RecurrenceDefinition` union.
- The stored `expression` is the user's input with leading/trailing whitespace removed and inner whitespace runs collapsed to one space. Everything else (case, names such as `MON`, nicknames) is kept as typed, so the form shows it back unchanged.

### Validation — `src/server/recurrence.ts`, `case "cron"` of `validateRecurrenceDefinition`

Checks run in this order; the first failure throws `Error` with the exact message shown.

1. Empty after trimming → `Enter a cron expression.`
2. Starts with `@`:
   - one of `@yearly @annually @monthly @weekly @daily @hourly` (case-insensitive) → valid, go to step 5;
   - otherwise → `Unsupported nickname "<value>". Use @yearly, @annually, @monthly, @weekly, @daily or @hourly.`
3. Field count (split on whitespace):
   - 6 → `Seconds are not supported. Use 5 fields: minute hour day-of-month month day-of-week.`
   - not 5 → `A cron expression needs 5 fields: minute hour day-of-month month day-of-week.`
4. The day-of-month field (third) contains `W` or `w` → `W (nearest weekday) is not supported.` Only that field is checked, so `WED` in the weekday field is fine.
5. `CronExpressionParser.parse(expression, { tz: timezone })`. A parser error becomes `Invalid cron expression: <parser message>`.

The time zone is validated first, as for every type (`requireValidZone`).

### Next run — `nextOccurrenceForRecurrence`, `case "cron"`

`CronExpressionParser.parse(expression, { currentDate: afterIso, tz: timezone }).next().toISOString()`, converted to UTC ISO like the other types. `computeTaskNextRun`, the claim, the refresh rule, the edit rule and the dashboard need no change: they already go through this function.

### Summary — `formatRecurrenceSummary`, `case "cron"`

`` `${cronstrue.toString(expression, { use24HourTimeFormat: true })} (${timezone})` ``, e.g. `Every 15 minutes, between 09:00 and 17:59, Monday through Friday (Europe/Amsterdam)`. If `cronstrue` throws (it should not for a validated expression), the summary falls back to `` `Cron: ${expression} (${timezone})` ``.

### Storage

`storage.ts` validates saved recurrences by calling `validateRecurrenceDefinition` (`isRecurrenceDefinition`, `storage.ts:72`), so saved cron tasks load with no storage change. A saved expression that a later library version rejects is dropped with the existing "Invalid task entries were ignored" warning, as for any invalid task.

### Dependencies

`cron-parser` ^5.10.2 and `cronstrue` ^3.38.0 go into `dependencies` (they run on the server and in the browser bundle). `src/client/views/task-form.ts` already imports `src/server/recurrence.ts`, so esbuild bundles both into `dist/index.js`; the browser and the server use the same validation and summary code.

## 2. Form UI — `src/client/views/task-form.ts`

- **Dropdown:** "Cron expression" (`value="cron"`) is added last in Schedule Type.
- **New field** (`data-schedule-scope="cron"`): label "Cron Expression", monospace text input `name="cronExpression"`, placeholder `*/15 9-17 * * MON-FRI`. Help text: `minute hour day-of-month month day-of-week · supports * , - / L # ? and @daily-style nicknames · W not supported`.
- **Default for a new cron task:** `0 9 * * MON-FRI`. Editing an existing cron task fills in its stored expression.
- **Visibility:** Timezone stays visible. Local Time (`data-schedule-scope="timed"`) is hidden for `one_time` and `cron`. The cron field is shown only for `cron`.
- **Escaping:** every value the form writes into HTML attributes or text — the cron expression and, while there, the existing name, prompt, timezone and run-at values — goes through one `escapeHtml` helper (`& < > " '`). Today the form interpolates them unescaped; a typed `"` breaks the input.
- **Preview** (the existing Validation panel, refreshed on input):
  - valid cron → the summary line, then the next 5 run times in the task's time zone, formatted `ccc d LLL HH:mm` (e.g. `Mon 2 Nov 09:00`), one per line;
  - if the gap between the first two of those runs is under 5 minutes → an extra line: `Runs about every <N> min, ~<X> times a day. Each run sends the prompt to Claude.` where `N` is the gap in whole minutes (minimum 1) and `X = round(1440 / N)`. Warning only; Save still works;
  - invalid → the validation message in the existing feedback alert, and Save is blocked, as for other validation errors;
  - other schedule types keep their current single-line preview.

## 3. Scheduler safeguards — `src/server/scheduler.ts`

### Collapse missed cron runs

Applies to `cron` tasks only; the five existing types keep recording each missed occurrence (upstream test "records all missed recurring occurrences in one tick" stays as is).

Inside the claim, when the occurrence would be recorded as `missed` because it is outside the 90 s grace window (`tickStartedAt - scheduledFor > 90 s`):

1. Walk occurrences from `scheduledFor` with `nextOccurrenceForRecurrence`, counting every occurrence `t` with `tickStartedAt - t > 90 s`. Stop at the first occurrence that is not stale, or after 10,000 steps.
2. Append **one** `missed` event for the last stale occurrence `L` (its `scheduledFor` and occurrence key are `L`'s), with `summary` and `failure_reason`:
   - `Missed <N> runs between <first> and <L> (the scheduler was not running).` where times are formatted `yyyy-LL-dd HH:mm` in the task's time zone;
   - when the 10,000-step cap was hit: `Missed 10,000+ runs since <first> (the scheduler was not running).`
   - when `N` is 1: the existing `Automatic execution was unavailable at the scheduled time.`
3. Set `nextRunAt` to the first non-stale occurrence (which may still be due within the grace window, in which case the catch-up loop claims and runs it on the same tick), or, after the cap, to the first occurrence after `tickStartedAt`.

Misses caused by an execution profile that is not ready keep today's behaviour (one `missed` per occurrence, capability message), for every type.

### Skip while the same task is still running

- New in-memory `inFlightTasks: Set<string>` (task IDs) next to `inFlightOccurrences`. A scheduled execution adds the task ID when its `started` event is appended and removes it in `finally`; manual runs and retries do the same.
- In the claim, after the compare-and-set checks pass and before recording anything: if `inFlightTasks.has(task.id)`, set `nextRunAt` to the following occurrence and return `advanced` with **nothing recorded**. Recording each skip as `missed` would turn the dashboard red every minute for a task that is working normally.
- Applies to every schedule type (it can only trigger when a run outlasts the gap to the next occurrence, which in practice means cron).
- Manual runs and retries are never blocked by it.

## 4. Testing and rollout

### Tests

- `tests/unit/recurrence.test.ts`:
  - next run for `*/15 9-17 * * MON-FRI`, `0 9 L * *`, `0 9 * * 5L`, `0 9 * * FRI#3`, `@weekly`, `0 9 ? * MON`;
  - DST: `0 9 1 JAN,JUL *` in `Europe/Amsterdam` → 08:00Z in January, 07:00Z in July;
  - every rejection message in §1 (empty, `@midnight`, `@reboot`, 6 fields, 3 fields, `15W`, `LW`, `60 9 * * *`), and `0 9 * * WED` accepted;
  - stored expression normalisation (outer trim, inner whitespace collapsed);
  - summary text with time zone.
- `tests/integration/task-form.test.ts` (jsdom):
  - choosing Cron shows the cron field and hides Local Time;
  - a valid expression shows the summary and exactly 5 run lines;
  - `15W` shows the message and blocks submit;
  - `* * * * *` shows the frequency warning (`every 1 min, ~1440 times a day`); `*/10 * * * *` does not;
  - editing round-trips the stored expression;
  - a name and an expression containing `"` and `<` render without breaking the inputs.
- `tests/integration/scheduler-concurrency.test.ts` (or `scheduler-loop.test.ts`):
  - `* * * * *` with `nextRunAt` 8 h in the past → one `missed` event saying `Missed 480 runs`, `nextRunAt` within the next minute;
  - a daily task 3 days in the past → still 3 `missed` events;
  - the 10,000+ cap message;
  - a cron task whose run is still executing at the next due occurrence → no second execution, no event recorded, `nextRunAt` advanced; the following occurrence runs once the first finishes;
  - Run Now while a scheduled run of the same task is executing still runs.
- `tests/unit/storage.test.ts`: a ledger with a cron task loads it as valid; an invalid expression is dropped with the existing warning.

### Rollout

1. Spec and design on `004-cron-expressions`; implementation plan; subagent-driven build with per-task review, as for `003`.
2. Version 0.4.0; README "Schedules" section documents the cron type, syntax, rejected syntax and the two safeguards; CHANGELOG entry.
3. Merge to the fork's `master` and push to `krugerm/cloudcli-cron` only (no upstream PR, as for `003`).
4. Update the installed plugin on this machine and on `mantis2` (CloudCLI **Update**; `mantis2` builds in production mode since `e9134a4`).

### Done when

- `npm test`, `npx tsc -p tsconfig.json --noEmit` and `npm run build` pass, plus a production-mode build (`NODE_ENV=production npm install --ignore-scripts && npm run build`).
- In CloudCLI: a cron task `*/2 * * * *` shows its summary and next runs in the form, runs every 2 minutes, and appears in Recent Runs and History.

## Out of scope

- A visual cron builder.
- `W`, seconds, `@midnight`, `@reboot`.
- Changing the five existing schedule types.
- Collapsing misses caused by an unconfigured execution profile.
- The tick awaiting a long execution before moving on to the next task in the same workspace (existing behaviour; the overlap skip above prevents duplicate runs but a long run can still delay other tasks of the same workspace by up to its duration).
