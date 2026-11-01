# Feature Specification: Cron Expressions

**Feature Branch**: `004-cron-expressions`  
**Created**: 2026-11-01  
**Status**: Draft  
**Input**: User description: "Update the scheduler UI to add support for the full range of cron options."  
**Technical design**: [`docs/superpowers/specs/2026-11-01-cron-expressions-design.md`](../../docs/superpowers/specs/2026-11-01-cron-expressions-design.md)

## Clarifications

### Session 2026-10-29

- Q: What does "full range of cron options" mean in the UI? → A: A raw cron expression field with a live plain-English summary and the next run times; no visual builder.
- Q: Which cron syntax? → A: Standard 5 fields plus `L`, `nL`, `#`, `?` and the `@yearly`-style nicknames. `W` is not supported and is rejected with a clear message.
- Q: Where does the work live? → A: The `krugerm/cloudcli-cron` fork; no upstream pull request.

### Session 2026-11-01

- Q: Is run history capped for frequent schedules? → A: No. Since `003-run-event-log`, history is complete and paged, so no caps are added.
- Q: What happens after the scheduler was down for hours with an every-minute schedule? → A: One missed-run record summarising how many runs were missed, not one per occurrence.
- Q: What happens when a run is still going when the next one is due? → A: The next occurrence is skipped without a record; the schedule continues afterwards.

### Session 2026-11-01 (spec review)

- Q: How are nickname case and extra spaces handled? → A: Normalised on the server for every create and update, so stored text is the same from the form and the API.
- Q: How is the frequency warning computed? → A: From the smallest gap among the next 25 runs and the count of runs in the 24 hours starting at the first upcoming run, so the count is never zero whatever day or time it is typed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Schedule with a cron expression (Priority: P1)

A user chooses "Cron expression" as the schedule type, types an expression such as `*/15 9-17 * * MON-FRI`, sees what it means and when it will next run, and saves it.

**Why this priority**: This is the feature. Without it, schedules that run more than once a day or on irregular patterns are impossible.

**Independent Test**: Create a cron task in the form, confirm the summary and next runs, save, and confirm it runs at those times.

**Acceptance Scenarios**:

1. **Given** the schedule form, **When** the user selects "Cron expression", **Then** a cron field appears, the local-time field is hidden, and the time-zone field stays.
2. **Given** a valid expression, **When** the user types it, **Then** the form shows a plain-English summary and the next 5 run times in the task's time zone.
3. **Given** a saved cron task, **When** its times arrive, **Then** it runs at each of them, and each run appears in Recent Runs.
4. **Given** an existing cron task, **When** the user edits it, **Then** the form shows the expression exactly as it was saved.

---

### User Story 2 - Understand a wrong expression (Priority: P1)

A user types an expression the plugin cannot run and is told precisely why, before saving.

**Why this priority**: A cron typo would otherwise silently never run, or run far more often than intended.

**Independent Test**: Type each unsupported form and confirm the specific message and that saving is blocked.

**Acceptance Scenarios**:

1. **Given** `0 9 15W * *`, **When** the user types it, **Then** the form says `W (nearest weekday) is not supported.` and Save is blocked.
2. **Given** a 6-field expression, **When** the user types it, **Then** the form says seconds are not supported and shows the 5-field format.
3. **Given** `* * * * *`, **When** the user types it, **Then** the form warns that it runs as often as every minute, 1,440 times in 24 hours, and still allows saving.
4. **Given** `H 9 * * *` or `0 9 31 4,6,9,11 *`, **When** the user types it, **Then** the form says `H (random values) is not supported.` or `This cron expression never matches a date.` and Save is blocked.

---

### User Story 3 - Frequent schedules stay manageable (Priority: P2)

A user with an every-minute schedule does not get hundreds of history records after the machine was off, and never gets two scheduled copies of the same task running at once.

**Why this priority**: Frequent schedules are the main reason to use cron, and both problems appear only with them.

**Independent Test**: Simulate 8 hours of downtime for an every-minute task; simulate a run that lasts longer than the schedule's interval.

**Acceptance Scenarios**:

1. **Given** an every-minute cron task and 8 hours with the scheduler not running, **When** the scheduler starts again, **Then** history shows one missed-run record saying 479 runs were missed, and the run due within the last 90 seconds starts on that same scheduler pass.
2. **Given** a cron task whose run takes longer than its interval, **When** the next occurrence is due during the run, **Then** no second copy starts and nothing is recorded for the skipped occurrence; the schedule continues after the run ends.
3. **Given** a daily task and 3 days of downtime, **When** the scheduler starts again, **Then** history shows 3 missed-run records, as before.

### Edge Cases

- `WED` in the weekday field is accepted; only `W` in the day-of-month field is rejected. `THU` is accepted; a standalone `H` is rejected.
- `@DAILY` and surrounding spaces are accepted and stored as `@daily`, whether entered in the form or through the API.
- `@midnight` and `@reboot` are rejected with the list of supported nicknames.
- An expression with 3 or 4 fields is rejected (the parser library would otherwise accept some of them).
- A schedule crossing a daylight-saving change runs at the same local time (09:00 stays 09:00); a time inside the skipped spring hour (02:30) runs at 03:30 that day.
- A run longer than its interval during hours of downtime: the backlog is skipped in one step, without records, and the schedule continues.
- An expression whose day-of-month and day-of-week are both set runs when either matches, as in crontab.
- Run Now on a task whose scheduled run is still going starts a manual run.
- A name or expression containing `"` or `<` displays correctly in the form.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The schedule form MUST offer a "Cron expression" schedule type with a text field for the expression.
- **FR-002**: The system MUST accept standard 5-field expressions with `*`, `,`, `-`, `/`, month and weekday names, `?`, `L`, `nL`, `#`, and the nicknames `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@hourly` in any letter case, and MUST store the expression normalised (outer spaces removed, inner spaces collapsed, nicknames lower-cased) whichever way it was entered.
- **FR-003**: The system MUST reject `W`, `H`, 6-field expressions, other field counts, other nicknames, expressions that never match a date, and any expression the parser rejects, each with a specific message, and MUST NOT save a task with a rejected expression.
- **FR-004**: The form MUST show, for a valid expression, a plain-English summary and the next 5 run times in the task's time zone, updated as the user types.
- **FR-005**: The form MUST warn, without blocking, when any two consecutive upcoming runs are less than 5 minutes apart, stating the smallest gap and how many runs fall in 24 hours starting at the first upcoming run, so the count is never zero whatever day or time the expression is typed.
- **FR-006**: Cron schedules MUST be computed in the task's time zone, including daylight-saving changes.
- **FR-007**: The five existing schedule types and their saved data MUST keep working unchanged.
- **FR-008**: Consecutive occurrences of a cron task that could not run within the grace window (scheduler not running, or execution profile not ready) MUST be recorded as one missed-run record that states how many were missed and between which times, and a retried scheduler pass MUST NOT record it twice. (Accepted limit: occurrences that become stale while saving the schedule keeps failing are not recorded.)
- **FR-009**: A scheduled occurrence of a cron task MUST NOT start while any run of the same task (scheduled or manual) is still executing; it MUST be skipped without a history record, and the schedule MUST continue afterwards. Manual runs MUST NOT be blocked by this. The five existing schedule types are not affected (FR-007).
- **FR-010**: Values typed into the form, and task names and summaries in the schedule list, MUST be displayed correctly even when they contain HTML-special characters.
- **FR-011**: User-facing behavior MUST preserve loading, empty, success, error, and recovery states consistent with existing CloudCLI conventions.

### Key Entities *(include if feature involves data)*

- **Cron Recurrence**: A schedule defined by a cron expression and a time zone; stored with the task like the other schedule types.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can create a working every-15-minutes weekday schedule in under 1 minute, without leaving the form.
- **SC-002**: 100% of the rejected forms listed in FR-003 show their specific message, and none can be saved.
- **SC-003**: After 8 hours of downtime, an every-minute task adds exactly 1 missed-run record, not 479.
- **SC-004**: No cron task ever has a scheduled run start while another run of the same task is executing.
- **SC-005**: Existing schedules of the five other types run at the same times before and after the upgrade.

## Assumptions

- The plugin's run history is the event log from `003-run-event-log`, complete and paged.
- `cron-parser` and `cronstrue` are acceptable runtime dependencies (no native code; both bundle for the browser).
- Misses caused by an unconfigured execution profile within the grace window keep today's one-record-per-occurrence behaviour; once stale, cron misses are collapsed whatever the cause.
- The live preview appears once name and prompt are filled in, as for every schedule type today.
