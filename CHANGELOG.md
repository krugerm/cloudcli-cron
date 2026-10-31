# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project uses semantic version tags for GitHub releases.

## [0.3.0] - 2026-10-31

### Added

- Complete run history in an append-only SQLite event log (`runs.db`), with "Load older runs" paging, a per-task filter and a per-run event History.
- One-time import of v0.2.0 run history at startup, with a `.v1.json.bak` backup per workspace.
- Runs interrupted by a plugin restart are closed as failed with a recovery event.

### Fixed

- A task paused, edited or deleted while its run executed was overwritten when the run finished.
- Two overlapping scheduler ticks could start the same occurrence twice.
- Opening a workspace between a run's due time and the next tick silently skipped that run.
- Editing a task's prompt inside the due window skipped the due run.
- An error in one workspace stopped the scheduler tick and could crash the plugin server.

### Changed

- Requires Node.js 22.13+ (or 23.4+).
- `GET /v1/runs` without `limit` now returns 100 runs (was up to 500); page with `before`. An empty `limit=` counts as absent.
- Workspace-state `runs` is now the first 100 runs, with `runsNextCursor` to page further.
- Retrying an unknown or foreign run now answers 404 (was 400).
- Workspaces whose run history import is pending or failed answer 409 "Run history import pending".
- `ScheduledRun` gains a `sequence` field.

## [0.1.0] - 2026-04-26

Initial public release of `Scheduled Prompt`, a local-first CloudCLI / ClaudeCodeUI plugin for workspace-scoped scheduled prompts.

### Added

- Plugin tab UI for creating and editing scheduled prompts per workspace
- Supported schedule types:
  - one-time
  - daily
  - selected weekdays
  - weekly
  - monthly
- Local execution through configurable commands with presets for:
  - Codex
  - Claude Code
  - Gemini CLI
- Per-workspace persistence for schedules, execution settings, and run history
- Schedule lifecycle controls:
  - pause
  - resume
  - duplicate
  - delete
  - run now
  - retry
- Recent run history with `running`, `succeeded`, `failed`, and `missed` states
- Workspace-scoped recurrence summaries and next-run previews
- Initial user documentation in [README.md](/home/sorg/CloudCLI/cloudcli-cron/README.md)
- Quickstart and feature design artifacts under [specs/001-workspace-scheduled-prompts](/home/sorg/CloudCLI/cloudcli-cron/specs/001-workspace-scheduled-prompts)

### Changed

- Final plugin display name set to `Scheduled Prompt`
- Codex preset normalized to use the supported global approval flags layout

### Fixed

- Safe rendering of run output and failure text in the UI without HTML injection
- Validation of whitespace-only task updates and invalid weekday values
- Scheduler behavior for repeated missed recurring runs after downtime
- UI reconciliation so failed refreshes do not incorrectly show success states

### Quality

- Automated coverage for:
  - RPC contract validation
  - recurrence edge cases
  - scheduler integration
  - execution adapter behavior
  - frontend jsdom interaction flows
  - lightweight performance fixture for 100 tasks and 500 runs
