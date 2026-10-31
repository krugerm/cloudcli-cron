# Feature Specification: Run Event Log

**Feature Branch**: `003-run-event-log`  
**Created**: 2026-10-29  
**Status**: Draft  
**Input**: User description: "Keep the complete history of scheduled prompt runs. Move the runs into an append-only SQLite file."  
**Technical design**: [`docs/superpowers/specs/2026-10-29-run-event-log-design.md`](../../docs/superpowers/specs/2026-10-29-run-event-log-design.md)

## Clarifications

### Session 2026-10-29

- Q: What does "append-only" mean for a run that changes state (running → succeeded)? → A: An event log. Every state change is a new row; rows are never updated or deleted. A run's current state is its latest event.
- Q: One database for all workspaces, or one per workspace? → A: One `runs.db` for all workspaces, with a workspace column.
- Q: What happens to runs already stored in the workspace JSON files? → A: Imported once on startup, after a backup copy of each JSON file is saved.
- Q: Which SQLite library? → A: The built-in `node:sqlite`. The plugin requires Node 22.13 or later.
- Q: Should history be pruned? → A: No. Complete history is kept.

### Session 2026-10-31 (design review)

- Q: Where does a task's last run status come from once runs leave the JSON file? → A: It is derived from the run history whenever tasks are served, and no longer stored.
- Q: How are task edits protected from being overwritten by a finishing run? → A: Task changes go through a per-workspace lock that reloads the file before writing, and a finishing run writes nothing to the task file.

### Session 2026-10-31 (second design review)

- Q: How is a scheduled occurrence prevented from running twice when ticks overlap? → A: Each occurrence is claimed under the per-workspace lock only if the freshly loaded task is enabled and its next run time still equals that occurrence.
- Q: What status does an upgraded task show if the old cap removed all its runs? → A: Its last stored status, kept as a legacy value until it runs again.

### Session 2026-10-31 (third design review)

- Q: Can loading a workspace page cause a due run to be skipped? → A: No. Refreshing a workspace never moves a next-run time that is already due; the scheduler runs it or records it as missed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep every run (Priority: P1)

A user with frequent schedules opens Recent Runs weeks later and can page back to any run, for any task, without other tasks' history having been pushed out.

**Why this priority**: Today history is capped at 500 runs per workspace, shared by all tasks. Sub-daily schedules would erase history within hours.

**Independent Test**: Seed more than 500 runs for one task and a few for another, then verify both tasks' runs are all reachable through paging.

**Acceptance Scenarios**:

1. **Given** a workspace with 10,000 recorded runs, **When** the user opens Recent Runs, **Then** the newest 100 are shown and a "Load older runs" control is available.
2. **Given** the user clicks "Load older runs" repeatedly, **When** the oldest run is reached, **Then** the control disappears and no run was shown twice or skipped.
3. **Given** one task has produced thousands of runs, **When** the user filters Recent Runs to another task, **Then** all of that task's runs are present and pageable.

---

### User Story 2 - See how a run reached its state (Priority: P2)

A user investigating a failed or odd run opens its history and sees each state change with its time and cause.

**Why this priority**: The event log exists for this. It also explains runs closed automatically after a restart.

**Independent Test**: Execute a run, then open its history and verify the started and finished events with times and source.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** the user opens its History, **Then** they see `started` and `succeeded` (or `failed`) with local times and the source (scheduler, manual, retry).
2. **Given** a retried run, **When** the user opens the retry's History, **Then** it shows "Retry of run scheduled for <time>" and the original run's history is unchanged.

---

### User Story 3 - Runs interrupted by a restart are closed (Priority: P2)

A user whose machine restarted mid-run no longer sees that run stuck as "running" forever.

**Why this priority**: Today such runs stay "running" indefinitely and mislead the dashboard.

**Independent Test**: Start a run, stop the plugin server before it finishes, start it again, and check the run's state.

**Acceptance Scenarios**:

1. **Given** a run was in progress when the plugin server stopped, **When** the server starts again, **Then** the run shows as failed with "Plugin server restarted while this run was in progress.", a `recovery` event in its history, and the task's last status is failed.

---

### User Story 4 - Upgrade keeps existing history (Priority: P1)

A user upgrading from v0.2.0 keeps all runs previously stored in the workspace JSON files.

**Why this priority**: Losing history on upgrade is unacceptable.

**Independent Test**: Start the new version against a data directory produced by v0.2.0 and compare run lists before and after.

**Acceptance Scenarios**:

1. **Given** v0.2.0 workspace files with runs, **When** the new version starts, **Then** every valid run appears in Recent Runs with the same status, times and summary, and each original file is kept as `<original file stem>.v1.json.bak`.
2. **Given** the import was interrupted, **When** the server starts again, **Then** the import completes with no duplicated runs.

### Edge Cases

- A workspace file contains invalid run entries: they are skipped during import, kept in the backup, and their count is written to the plugin server log.
- A task is paused, edited or deleted while one of its runs is executing: the change survives the end of the run.
- An error while processing one workspace during a scheduler tick: other workspaces are still processed and the plugin server keeps running.
- A retry request names a run from a different workspace: it is rejected as "Run not found".
- A v0.2.0 task whose runs were all pushed out by the old cap: it keeps its last known status instead of showing "never run".
- A workspace file whose name does not match its workspace path: it is moved to the expected name during import; if an unrelated file already has that name, both are left untouched and the conflict is logged.
- A run with an unknown status in a v0.2.0 file: it is skipped and counted; the rest of the file imports.
- `runs.db` cannot be opened or is from a newer plugin version: the plugin server stops at startup with the file path and reason.
- Node older than 22.13, or 23.0–23.3: the plugin server stops at startup with "Scheduled Prompt needs Node 22.13+ (found X)".
- Runs are recorded out of schedule order (catch-up after downtime, delayed runs): runs are listed newest-recorded first, so paging neither skips nor repeats them.
- A task's prompt or name is edited while an occurrence is due: the occurrence is not dropped; it runs, or is recorded as missed if the scheduler reaches it outside the grace window.
- Importing a workspace's v0.2.0 runs fails: that workspace is shown as unavailable and is neither scheduled nor editable until the import succeeds at a later start; no history is lost.
- Two v0.2.0 files map to the same workspace: the second is not imported, and the conflict is logged for manual resolution (accepted limit).
- A workspace or task is deleted: its events remain in `runs.db`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST record every run state change as a new row in a single SQLite database, `runs.db`, in the plugin's existing data directory.
- **FR-002**: The database MUST reject updates and deletes of recorded events.
- **FR-003**: The system MUST derive each run's current state (status, start time, finish time, summary, failure reason) from its events and expose it in the existing run format, so existing API consumers keep working.
- **FR-004**: The system MUST NOT cap or prune run history.
- **FR-005**: The run list API MUST support cursor paging (`before`) and an optional `taskId` filter, and return a `nextCursor`; callers that pass neither MUST receive the newest runs, newest first. Without `limit`, the default page size changes from 500 to 100.
- **FR-006**: The system MUST expose a run's events in order through `GET /v1/runs/:id/events`.
- **FR-007**: On startup, the system MUST close every run left in progress with a `failed` event marked as recovery.
- **FR-008**: On startup, the system MUST import runs from v0.2.0 workspace files into `runs.db`, keep a backup of each file, and remove `runs` from the workspace file. The import MUST be safe to repeat.
- **FR-009**: Task definitions MUST remain in the per-workspace JSON files.
- **FR-010**: The workspace view MUST offer a task filter, "Load older runs" when more runs exist, and a per-run History view; refreshing after an action MUST keep showing as many runs as were loaded (up to 500), and MUST NOT skip or repeat runs when older pages are loaded afterwards.
- **FR-011**: The plugin server MUST refuse to start on Node versions where `node:sqlite` needs a flag (below 22.13, and 23.0–23.3) with an explicit message.
- **FR-012**: User-facing behavior MUST preserve loading, empty, success, error, and recovery states consistent with existing CloudCLI conventions.
- **FR-013**: A task's last run status MUST be derived from the run history whenever the task has runs in it, so the two can never disagree; a stored value is used only for upgraded tasks with no runs (FR-018).
- **FR-014**: Changes to a task made while one of its runs executes MUST NOT be overwritten when the run finishes.
- **FR-015**: A failure while processing one workspace in a scheduler tick MUST NOT stop other workspaces or terminate the plugin server.
- **FR-016**: Run lookups for retry and history MUST be limited to the requesting workspace, and a run from another workspace MUST be reported as not found (HTTP 404).
- **FR-017**: Each scheduled occurrence MUST execute at most once, even when scheduler ticks overlap, and MUST NOT execute after the user has rescheduled, paused or deleted its task. Viewing a workspace MUST NOT cause a due occurrence to be skipped: it still runs or is recorded as missed.
- **FR-018**: A task whose v0.2.0 runs were all removed by the old 500-run cap MUST keep showing its last known status after upgrade, until it runs again.

### Key Entities *(include if feature involves data)*

- **Run Event**: One state change of one run: run, task, workspace, occurrence, scheduled time, event type (started, succeeded, failed, missed), time, source (scheduler, manual, retry, recovery, migrated), summary, failure reason, retry link, execution request.
- **Run**: The current state of a run, derived from its events; same shape as the existing `ScheduledRun`.
- **Run Page**: A slice of runs for a workspace (optionally one task) plus the cursor for the next slice.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With 500,000 recorded events, the first page of a workspace's runs loads in under 50 ms.
- **SC-002**: With 500,000 recorded events across 20 tasks, the global dashboard's per-task run summaries complete in under 50 ms.
- **SC-003**: Recording one event takes under 5 ms.
- **SC-004**: 100% of valid v0.2.0 runs are present after upgrade, with identical status, start and finish instants (stored in normalized ISO 8601 form), and summaries (runs that were still `running` are closed as failed by recovery).
- **SC-005**: After a restart, 0 runs remain in the "running" state from before the restart.
- **SC-006**: Finishing a run never rewrites the workspace JSON file; starting a scheduled run rewrites it only to advance the next run time.

## Assumptions

- Rolling back to v0.2.0 requires restoring the `.v1.json.bak` files; task edits made after the upgrade are lost, and runs recorded after the upgrade stay only in `runs.db`.
- The plugin server runs on the `node` found on the PATH, as started by CloudCLI, and users of CloudCLI run Node 22 (CloudCLI targets Node 22).
- Several KB of storage per run (captured output and the prompt) is acceptable; an every-minute task grows `runs.db` by roughly 2–3 GB per year. Retention is a likely follow-up feature.
- Statuses `scheduled` and `canceled` are never produced today and need no event type.
- Cron expressions (sub-daily schedules) are delivered separately in `004-cron-expressions`, building on this feature.
