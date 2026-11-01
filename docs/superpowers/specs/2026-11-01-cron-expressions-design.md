# Cron Expressions — Design

**Date:** 2026-11-01 (revised after four review rounds)
**Branch:** `004-cron-expressions` (from `master` at `e9134a4`, which includes `003-run-event-log`)
**Spec-kit spec:** [`specs/004-cron-expressions/spec.md`](../../../specs/004-cron-expressions/spec.md)

## Goal

Let a user schedule a prompt with a standard cron expression (`*/15 9-17 * * MON-FRI`), so schedules that run more than once a day, or on patterns the five fixed schedule types can't express, become possible.

## Decisions

| Topic | Decision |
|---|---|
| UI | A new **"Cron expression"** schedule type with a raw text field, a live plain-English summary and the next 5 run times. No visual builder. |
| Syntax | 5 fields (`minute hour day-of-month month day-of-week`) with `*` `,` `-` `/`, month and weekday names, `?`, `L`, `nL`, `#`, and the nicknames `@yearly` `@annually` `@monthly` `@weekly` `@daily` `@hourly`. |
| Rejected syntax | `W`, `H`, 6-field expressions (seconds), any other field count, other nicknames, expressions that never match a date — each with a specific message. |
| Engine | `cron-parser` ^5.10.2 for parsing and occurrences (uses `luxon`, already a dependency, for time zones). |
| Summary | `cronstrue` ^3.38.0 (no dependencies), 24-hour format. |
| Existing types | Unchanged: `one_time`, `daily`, `weekdays`, `weekly`, `monthly`. No stored-data migration. |
| Run history | Already complete and paged since `003-run-event-log`; no caps are added. |

Rejected alternatives: a visual cron builder (about 3× the UI work for the same capability); converting the five existing types into cron (needs a data migration and changes `monthly` day-31 semantics); a separate cron scheduler (duplicates missed-run and history logic).

### Verified library behaviour

`cron-parser` 5.10.x and `cronstrue` 3.38.0 on Node 22.23 (2026-11-01). The plan's tests pin each point.

- `next()` returns an instant strictly after `currentDate`; `prev()` strictly before.
- Quirk around the spring DST gap: for `30 2 * * *` in `Europe/Amsterdam`, the 2026-03-29 run is shifted to 03:30 local (01:30Z). `next()` from any start between 01:00Z and 01:30Z skips it (returns 2026-03-30), and `prev()` skips it too. Starting from an earlier occurrence, or more than an hour before, returns it. The helpers below never start inside such a window.
- Time zones and daylight saving: `0 9 1 JAN,JUL *` in `Europe/Amsterdam` → 08:00Z in January, 07:00Z in July. A time inside the skipped spring hour (`30 2 * * *` on 2026-03-29) runs at 03:30 local. Occurrences are distinct, strictly increasing UTC instants.
- Day-of-month and day-of-week together match if either matches (crontab semantics).
- The parser **accepts** 6-field and 3-field input and `H` (a random value per parse), and nicknames only in lower case; `@midnight`/`@reboot` fail with "cannot resolve alias". `cronstrue` also needs lower-case nicknames and throws on `H`.
- Some expressions parse but never match (e.g. `0 9 31 4,6,9,11 *`): `next()` throws `Invalid expression, loop limit exceeded` (≈ 340 ms).
- Iterating one parser instance: 1,440 steps ≈ 55 ms (`* * * * *`), ≈ 280 ms (`0 9 L * *`).
- Both libraries bundle with esbuild for the browser (`--platform=browser --format=esm`, ≈ 415 KB, no Node built-ins).

## 1. Model and engine

### Model — `src/shared/model.ts`

- `ScheduleType` gains `"cron"`.
- New `CronRecurrenceDefinition extends BaseRecurrenceDefinition { scheduleType: "cron"; expression: string }` (`timezone` comes from the base). It joins the `RecurrenceDefinition` union.

### Normalisation — `normalizeRecurrence(recurrence)` in `src/server/recurrence.ts`

One exported function returns a copy of the recurrence; for `cron` it sets `expression` to:

- leading and trailing whitespace removed, inner whitespace runs collapsed to one space;
- a nickname (starts with `@`) lower-cased; all other text kept as typed (names such as `MON`, case of `L`).

Other schedule types, and a `cron` recurrence whose `expression` is not a string, are returned unchanged (validation then reports the missing expression). It is the **only** function that normalises; every function that reads a cron expression calls it first. Callers:

- `SchedulerService.createTask` and `updateTask` (on `request.recurrence`, before validation and before storing), so API clients and the form store the same text;
- the form, before validating and previewing;
- internally, `validateRecurrenceDefinition`, `nextOccurrenceForRecurrence`, `cronStaleWindow` and `formatRecurrenceSummary`, so a hand-edited ledger holding `@DAILY` is handled the same as `@daily`.

The stored expression is the normalised one; editing shows it.

### Validation — `case "cron"` of `validateRecurrenceDefinition`

Runs on the expression **after** `normalizeRecurrence` (validation normalises internally first, so a direct call with raw input behaves the same). The time zone is validated first, as for every type. Then, in this order, the first failure throws `Error` with the exact message:

1. `expression` missing, not a string, or empty → `Enter a cron expression.`
2. Starts with `@`:
   - `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@hourly` → go to step 6;
   - otherwise → `Unsupported nickname "<value>". Use @yearly, @annually, @monthly, @weekly, @daily or @hourly.` (`<value>` is the normalised, lower-cased text)
3. Field count (split on single spaces):
   - 6 → `Seconds are not supported. Use 5 fields: minute hour day-of-month month day-of-week.`
   - not 5 → `A cron expression needs 5 fields: minute hour day-of-month month day-of-week.`
4. Any field contains `H` or `h` not adjacent to another letter (regex per field: `/(^|[^a-z])h(?![a-z])/i`, so `THU` is fine) → `H (random values) is not supported.`
5. The day-of-month field (third) contains `W` or `w` → `W (nearest weekday) is not supported.` Only that field is checked, so `WED` in the weekday field is fine.
6. `CronExpressionParser.parse(expression, { tz: timezone })`, then one `next()`.
   - Parse error whose message contains `Invalid explicit day of month definition` (e.g. `0 9 31 2 *`) → `This cron expression never matches a date.`
   - Any other parse error → `Invalid cron expression: <parser message>`.
   - `next()` error whose message contains `loop limit` → `This cron expression never matches a date.`
   - Any other `next()` error → `Invalid cron expression: <message>`.

Because storage validates saved tasks with this function (`isRecurrenceDefinition`, `storage.ts:72`), a saved task that fails it is dropped with the existing "Invalid task entries were ignored" warning, and can never reach the scheduler.

### Occurrences — `src/server/recurrence.ts`

- `nextOccurrenceForRecurrence`, `case "cron"`: `parse(expression, { currentDate: afterIso, tz }).next()` → UTC ISO. `computeTaskNextRun`, the claim, the refresh rule, the edit rule and the dashboard already use it.
- An occurrence is *stale* when it is strictly before `staleBeforeIso` = `tickStartedAt − 90 s` (the grace rule `tickStartedAt − t > 90 s`).
- New exported helper `cronNextDue(recurrence, staleBeforeIso)` → `{ nextDue, lastBefore }`: one parser instance at `currentDate: staleBeforeIso − 61 min`; call `next()` until the result is at or after `staleBeforeIso` (at most ~61 steps for an every-minute expression). `nextDue` is that result; `lastBefore` is the previous result if it was at or after the start, else `null`. Used by claim steps 1 and 2 (no counting) and by `cronStaleWindow`.
- New exported helper `cronStaleWindow(recurrence, fromIso, staleBeforeIso, cap)` for the collapse (§3). `fromIso` is the claimed occurrence (the task's `nextRunAt`) and is stale by definition of the caller. One parser instance at `currentDate: fromIso`; `count` starts at 1 with `lastStale = fromIso`; then repeatedly:
  - if `count` has reached `cap` → stop, `capped: true`;
  - call `next()`; if the result is at or after `staleBeforeIso` → stop, `capped: false`;
  - otherwise `count += 1`, `lastStale` = the result.

  It returns `count` (≥ 1), `capped`, `nextDue` = `cronNextDue(recurrence, staleBeforeIso).nextDue`, and `lastStale`; when `capped`, `lastStale` is `cronNextDue(…).lastBefore` if not null, else `parse(…, { currentDate: staleBeforeIso }).prev()` (only the message's end time depends on it). The work is bounded by `cap` + ~61 steps.
- Safety: the scheduler's catch-up loop stops (and logs) if a computed next run is not strictly after the occurrence it advanced from. `next()` guarantees this; the guard prevents an infinite loop if a library update ever breaks it.

### Summary — `formatRecurrenceSummary`, `case "cron"`

`` `${cronstrue.toString(expression, { use24HourTimeFormat: true })} (${timezone})` ``, e.g. `Every 15 minutes, between 09:00 and 17:59, Monday through Friday (Europe/Amsterdam)`. If `cronstrue` throws, the summary is `` `Cron: ${expression} (${timezone})` ``.

### Dependencies

`cron-parser` ^5.10.2 and `cronstrue` ^3.38.0 go into `dependencies`. `src/client/views/task-form.ts` already imports `src/server/recurrence.ts`, so esbuild bundles both into `dist/index.js`; browser and server share validation, normalisation and summary code.

## 2. UI

### Form — `src/client/views/task-form.ts`

- **Dropdown:** "Cron expression" (`value="cron"`) is added last in Schedule Type.
- **Field** (`data-schedule-scope="cron"`): label "Cron Expression", monospace text input `name="cronExpression"`, placeholder `*/15 9-17 * * MON-FRI`. Help text: `minute hour day-of-month month day-of-week · supports * , - / L # ? and @daily-style nicknames · W and H not supported`.
- **Default:** `0 9 * * MON-FRI` for a new task, and when an existing non-cron task is switched to Cron. Editing a cron task fills in its stored expression.
- **Visibility:** Timezone stays visible. Local Time (`data-schedule-scope="timed"`) is hidden for `one_time` and `cron`. The cron field is shown only for `cron`.
- **Preview** (the existing Validation panel; it refreshes on input and, as today for every type, appears once name and prompt are filled in):
  - valid cron → the summary line, then the next 5 run times in the task's time zone, formatted with luxon `ccc d LLL HH:mm` in locale `en` (e.g. `Mon 2 Nov 09:00`), one per line;
  - **frequency warning:** over the next 25 occurrences from now, take the smallest gap `G` between consecutive runs; if `G < 5 min`, add `Runs as often as every <N> min, <X> times in 24 hours. Each run sends the prompt to Claude.` where `N` = `G` in whole minutes (minimum 1) and `X` = the number of occurrences in the 24 hours starting at the first upcoming run (start inclusive, end exclusive), formatted with `en-US` grouping (at most `1,440`, i.e. every minute). Starting at the first upcoming run keeps `X` above zero whatever day and time the expression is typed; `G` and `X` can still differ with the moment of typing for irregular expressions. The warning never blocks Save;
  - invalid → the validation message in the existing feedback alert; Save is blocked, as for other validation errors;
  - other schedule types keep their current single-line preview;
  - the form keeps the result for the last (normalised expression, time zone, current minute) it validated and reuses it while none changes, so a slow expression (a never-matching one takes ≈ 400 ms to reject) is evaluated once rather than on every keystroke elsewhere in the form, and the next-run times refresh each minute;
  - the multi-line preview is built from element nodes whose text is set with `textContent` (one element per line), as the panel uses `textContent` today.

### Escaping — one `escapeHtml` helper (`& < > " '`) in `src/client/`

Every user-controlled value that the views interpolate into HTML goes through it:

- task form: cron expression, name, prompt, timezone, run-at, local time;
- schedule list (`schedule-list.ts`): task name and recurrence summary (a cron fallback summary contains the raw expression).

Today both views interpolate these unescaped; a `"` breaks an input and a `<` is parsed as markup.

## 3. Scheduler safeguards — `src/server/scheduler.ts`

### Running-task count

- New in-memory `runningTasks: Map<string, number>` (task ID → number of executing runs of that task), next to `inFlightOccurrences`.
- Increment only after the `started` `appendEvent` call has returned. In the claim, at the point where `claim.started` is set. In `runManually` (manual runs and retries), the code is restructured to: append `started` (outside any `try`); then add the occurrence key to `inFlightOccurrences` and increment `runningTasks`; then `try { executeAndRecord } finally { remove the key; decrement }` — so an append that throws changes neither set.
- Decrement (deleting the entry at 0) exactly once per increment: the `finally` after `executeAndRecord` in `tickWorkspace` and in `runManually`, **and** the claim's `catch` when `claim.started` is set (the save failed after `started` was appended, so no execution follows). In the claim's `catch` the decrement happens before, and regardless of, the `SAVE_FAILED_SUMMARY` append (which has its own `try/catch`).
- The count is read only by claim step 2, and only for `cron` tasks.
- After a process restart the map is empty; startup recovery has already closed the previous runs as `failed`. Whether an orphaned child process from the previous server keeps running is outside this feature.

### Claim order for a due occurrence

Inside the existing compare-and-set claim, after `task exists && task.enabled && task.nextRunAt === scheduledFor` holds (otherwise skip, unchanged). Let `stale` = `tickStartedAt - scheduledFor > 90 s` (today's grace rule).

1. **Already known** (`inFlightOccurrences.has(key) || hasOccurrence(workspaceKey, key)`):
   - `cron` and `stale` → set `nextRunAt` to `cronNextDue(recurrence, tickStartedAt − 90 s)` (a retried collapse jumps the backlog without recording again);
   - otherwise → advance to the following occurrence, as today.
2. **Cron task still running** (`cron` and `runningTasks.get(task.id) > 0`):
   - `stale` → set `nextRunAt` to `cronNextDue(recurrence, tickStartedAt − 90 s)` (jumps the whole stale backlog in one claim), record nothing;
   - not stale → set `nextRunAt` to the following occurrence, record nothing.
   Return `advanced`. Manual runs and retries are never blocked by this check. The five existing types never take this step: they keep today's behaviour, including starting a scheduled run while a manual run of the same task is executing.
3. **Cron, stale** → collapse (below). Applies whatever the reason the occurrence could not run (scheduler down, or execution profile not ready).
4. **Not stale, profile not ready** → one `missed` event with the capability message, as today (every type).
5. **Other types, stale** → one `missed` event per occurrence, as today (upstream test "records all missed recurring occurrences in one tick" stays as is).
6. Otherwise → start the run, as today, and increment `runningTasks`.

### Collapse (step 3)

With `w = cronStaleWindow(recurrence, scheduledFor, tickStartedAt − 90 s, 1440)`:

1. `nextRunAt = w.nextDue`. This may be ≤ `tickStartedAt` (due within the grace window); the catch-up loop then claims and runs it on the same tick.
2. Append **one** `missed` event keyed on the **first** stale occurrence: its `scheduledFor` and occurrence key are the claimed `scheduledFor`'s. (Step 1 already returned if that key was recorded, so a retried claim after a failed save never appends a second event, whatever window a later tick computes.) `summary` and `failure_reason`:
   - `count` = 1 → today's text: the capability message if the profile is not ready, else `Automatic execution was unavailable at the scheduled time.`
   - `count` > 1, not capped → `Missed <count> runs between <first> and <last> (<reason>).`
   - capped → `Missed 1,440 or more runs between <first> and <last> (<reason>).`
   
   where `<first>` = `scheduledFor` and `<last>` = `w.lastStale`, both formatted with luxon `yyyy-LL-dd HH:mm ZZZZ` in the task's time zone and locale `en` (e.g. `2026-11-01 02:00 GMT+1`; the offset disambiguates the repeated autumn hour); `<count>` is formatted with `en-US` digit grouping (`479`, `1,200`); `<reason>` = `the scheduler did not run them in time`, or the capability message with any trailing `.` removed when the profile is not ready.

Example: `* * * * *`, `nextRunAt` 8 h before a tick at `T + 10 s` where `T` is on a minute boundary → stale occurrences are `T−8h … T−2min` (479), one `missed` event keyed on `T−8h` says `Missed 479 runs between … (the scheduler did not run them in time).`, `nextRunAt` = `T−1min`, which the same tick then starts.

The existing failure handling is unchanged: a failed save after the collapsed `missed` leaves `nextRunAt` as it was; the next claim finds that occurrence key recorded (step 1) and jumps to `nextDue` without recording again. Accepted limit: occurrences that become stale *between* that failed save and the retry are not recorded (they exist only while ledger saves are failing). A failed save after `started` appends `SAVE_FAILED_SUMMARY` and now also decrements `runningTasks`.

## 4. Testing and rollout

### Tests

- `tests/unit/recurrence.test.ts`:
  - next run for `*/15 9-17 * * MON-FRI`, `0 9 L * *`, `0 9 * * 5L`, `0 9 * * FRI#3`, `@weekly`, `@DAILY` (normalised), `0 9 ? * MON`, `0 9 * * THU`, `0 9 * * WED`;
  - DST: `0 9 1 JAN,JUL *` in `Europe/Amsterdam` → 08:00Z / 07:00Z; `30 2 * * *` on 2026-03-29 → 03:30 local; hourly across 2026-10-25 → strictly increasing distinct instants;
  - every rejection message in §1 (missing/non-string, empty, `@midnight`, `@reboot`, 6 fields, 3 fields, `H 9 * * *`, `0 H/2 * * *`, `15W`, `LW`, `60 9 * * *`, `0 9 31 4,6,9,11 *`, `0 9 31 2 *`);
  - `nextOccurrenceForRecurrence` and the summary accept an un-normalised stored `@DAILY`;
  - `normalizeRecurrence` (outer trim, inner whitespace, nickname case, other text untouched, other types unchanged);
  - `cronStaleWindow` (count, lastStale, nextDue, cap and its cost bound; `30 2 * * *` in `Europe/Amsterdam`: from 2026-03-27 → count 3 incl. the shifted 03:30 run; from 2026-03-29T01:30Z itself → count 1); `cronNextDue` with `staleBeforeIso` = 2026-03-29T01:15Z → 2026-03-29T01:30Z;
  - summary text with time zone, and the fallback.
- `tests/integration/task-form.test.ts` (jsdom):
  - choosing Cron shows the cron field and hides Local Time;
  - a valid expression shows the summary and exactly 5 run lines (locale `en`);
  - `15W` and `H 9 * * *` show their messages and block submit;
  - warning: `* * * * *` → `every 1 min, 1,440 times`; `* 9 * * *` at 10:00 → `every 1 min, 60 times`; `* 9 * * MON-FRI` on a Friday at 10:00 → `60 times`; `0,2 9 * * *` at 09:01 → warns; `*/10 * * * *` → no warning;
  - typing in the name field does not re-validate an unchanged expression (validation called once; clock pinned so no minute boundary is crossed);
  - editing round-trips the stored expression;
  - a name and an expression containing `"` and `<` render without breaking the inputs; the schedule list shows them as text.
- `tests/integration/scheduler-concurrency.test.ts`:
  - collapse: the 8 h example above (pinned clock, ready profile) → one event `Missed 479 runs …`, then the `T−1min` occurrence starts on the same tick;
  - collapse with the profile not ready → one event with the capability message as reason;
  - cap message for a backlog over 1,440;
  - a failed save after the collapsed `missed`, retried by a tick 30 s later (different `lastStale`) → no second event, `nextRunAt` jumps to that tick's `nextDue`;
  - collapse message formatting: `en` locale offset, `1,200`-style grouping, no doubled full stop with a not-ready profile;
  - a daily task 3 days behind → still 3 `missed` events;
  - overlap: a cron run still executing at the next due occurrence → no second execution, nothing recorded, `nextRunAt` advanced; the next occurrence after the run ends runs once;
  - overlap with a stale backlog during a run → one claim jumps to `nextDue`, nothing recorded;
  - manual run during a scheduled cron run → runs; after the manual run ends the scheduled run is still counted (no second scheduled copy starts);
  - a daily task due during a manual run of the same task → starts as today (the overlap guard is cron-only);
  - a failed save after `started` → `runningTasks` is back to 0 and the next occurrence can run;
  - a manual run whose `started` append throws during a scheduled cron run → the scheduled run is still counted (no second scheduled copy starts).
- `tests/unit/storage.test.ts`: a ledger with a cron task loads it; one with `0 9 31 4,6,9,11 *` drops it with the existing warning.
- Create/update over the API with `"  @DAILY "` stores `@daily`.

### Rollout

1. Spec and design on `004-cron-expressions`; implementation plan; subagent-driven build with per-task review, as for `003`.
2. Version 0.4.0; README documents the cron type, syntax, rejected syntax and both safeguards; CHANGELOG entry.
3. Merge to the fork's `master` and push to `krugerm/cloudcli-cron` only (no upstream PR, as for `003`).
4. Update the installed plugin on this machine and on `mantis2`.

### Done when

- `npm test`, `npx tsc -p tsconfig.json --noEmit` and `npm run build` pass, plus a production-mode build (`NODE_ENV=production npm install --ignore-scripts && npm run build`).
- In CloudCLI (plugin running from the built `dist/`): creating a cron task `*/2 * * * *` shows its summary, next runs and frequency warning in the form; saved, it runs every 2 minutes and its runs appear in Recent Runs and History.

## Out of scope

- A visual cron builder.
- `W`, `H`, seconds, `@midnight`, `@reboot`.
- Changing the five existing schedule types.
- Live preview before name and prompt are filled in (the form's existing behaviour for every type).
- A tick awaits each execution before moving on, so a long run delays later workspaces in the same tick; overlapping ticks still pick up other tasks within 30 s (existing behaviour).
- Orphaned child processes after a server restart.
