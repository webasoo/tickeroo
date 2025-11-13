# Tickeroo Workflow Guide

This document explains, step by step, how the extension behaves in every major scenario. It is intended for both developers maintaining the code and future automation agents that need to understand the control flow quickly.

## Terminology

- **Snapshot** – the per-project JSON file stored at `.vscode/time-tracker.json`. It is the single source of truth on disk for `days`, `entries`, and the currently running task. Each VS Code window caches the parsed snapshot in memory, but every mutation re-reads the file to stay in sync across windows.
- **Session** – the in-memory representation of the current timer (`snapshot.current`) that the tracker keeps updating while VS Code is running. Only one session can exist per project. When the timer stops (explicitly or during shutdown), the current session is written back to the snapshot so the file always reflects the latest elapsed time.

## 1. Activation / Workspace Open

1. VS Code loads `src/extension.ts` and calls `activate`.
2. `StorageService` (`src/storage.ts`) initializes on-disk data under `.vscode/time-tracker.json` per project and a global index/activity log under the extension's global storage.
3. `Tracker` (`src/tracker.ts`) initializes:
   - Loads the projects index and every project's snapshot.
   - Detects whether any snapshot has an unfinished session (`snapshot.current`) and resurrects the most recent one as the active session so the user can stop it.
   - Starts a 1-second ticker to persist "last activity" timestamps (used for idle detection).
4. UI helpers (`StatusBar`, `ReportProvider`, `ProjectsTreeProvider`) start and register commands.
5. `ProjectsTreeProvider` (`src/projectsTreeProvider.ts`) creates the sidebar tree view:
   - Displays all projects from the global index
   - Shows active projects with ▶ icon and task name
   - Shows inactive projects with relative timestamps (today, yesterday, X days ago)
   - Provides click handlers and context menus for project management

## 2. Starting a Timer (`tickeroo.startTimer`)

1. The command resolves a `ProjectIndexEntry` either from the current workspace folder list, by prompting the user, or directly from the sidebar tree view (by clicking an inactive project).
2. `Tracker.start()` refreshes the project's snapshot **from disk** to avoid stale state across windows.
3. `ensurePendingEntriesResolved()` checks the snapshot for any session entries without an `end` value:
   - If one exists, the user must supply an end time (HH:MM) before proceeding.
   - The helper computes the duration, updates the day totals, saves the snapshot, and restarts the scan until no incomplete entries remain.
4. If the snapshot still reports an active session (`snapshot.current`), a warning message appears:`Tickeroo: timer '…' is already running…`. The start request stops here, so a second window cannot hijack a running timer.
5. If everything is clear:
   - `snapshot.current` is set to the new task and start time.
   - A placeholder entry (`dayRecord.entries`) is inserted immediately, ensuring at least a partial record exists.
   - The snapshot is saved, the active session cache is updated, `lastProjectId`/`lastActivity` are persisted, and an activity log entry is recorded.

## 3. Stopping a Timer (`tickeroo.stopTimer`)

1. The tracker refreshes the snapshot from disk and loads `snapshot.current`.
   - Can be triggered from the command palette, status bar menu, or by clicking an active project in the sidebar and choosing "Stop".
2. The stop time defaults to `now.` It never precedes the recorded start.
3. The tracker locates the placeholder entry that matches the session's `start`. If the timer crossed midnight, the entry is moved to the stop day.
4. The entry receives its final `end` timestamp and duration in seconds. The owning day's totals and per-task seconds are incremented.
5. `snapshot.current` is cleared, project metadata (`lastUsed`) is updated, and the activity log stores the day touched.

## 4. Manual Closure of Stale Entries

- Whenever a user attempts to start a timer and an entry lacks `end`, the extension opens a modal warning.
- The user must enter `HH:MM`. The tracker validates the format, ensures the end time is not before the start, and writes the computed duration.
- This guarantees the file always contains either fully closed sessions or an explicit placeholder created moments before a timer actually runs.

## 5. Multi-Window Guarantees

- Every mutation (start/stop/manual close) begins by reloading the snapshot from disk via `StorageService.refreshProjectSnapshot`, so concurrent VS Code windows never operate on stale data.
- **Optimistic locking:** Before saving, the extension compares `snapshot.lastModified` timestamps. If both the in-memory snapshot and the on-disk snapshot have `lastModified` values and they differ, a `SNAPSHOT_CONFLICT` error is raised. For new projects (no snapshot file yet), the absence of `lastModified` avoids false-positive conflicts. On conflict, operations like `stop()` or resolving pending entries refresh the snapshot and retry automatically.
- Starting a timer also requires a clean snapshot: pending entries must be closed, and any existing `snapshot.current` blocks new timers with a warning. This prevents two windows from running the same project simultaneously.

## 6. Background Ticker & Idle Tracking

- While a timer is active, `Tracker.onTick()` runs every second.
- Elapsed seconds accumulate in memory only; the JSON snapshot is not mutated every tick. As soon as `stop()` (or disposal during shutdown) runs, the in-memory session is finalized and persisted to the snapshot.
- If the user is idle for more than five minutes (`idleThreshold`), the ticker pauses updates to avoid falsely extending activity.
- `lastActivity` timestamps are stored in VS Code's `globalState`, letting the tracker estimate when the last action occurred if VS Code crashes.

## 7. Status Bar Behavior

- `StatusBar` (`src/statusBar.ts`) creates a VS Code status bar item aligned left with command `tickeroo.showStatusMenu`.
- When no timer is running it shows `🕒 Tickeroo: idle`. **If the workspace has historical data** (i.e., one or more project snapshot files contain actual time records), the status bar flashes between colors to remind the user that tracking is off. The flasher checks on-disk snapshots at runtime via `storage.projectHasRecords()`, so deleting a project's `.vscode/time-tracker.json` or clearing its records immediately disables flashing.
- When a session is active it renders `🕑 <task> (HH:MM:SS)` by computing the elapsed time **in memory** every second; stopping the timer is the point where that duration is persisted to the snapshot.
- Clicking the item opens the quick actions menu (start/stop/switch/report) so the entire workflow can be driven from the status bar without using the command palette.

## 8. Reports (`tickeroo.showReport*`)

1. `ReportProvider` requests a date range from the user (predefined or custom).
   - Can be triggered from the command palette or by right-clicking a project in the sidebar and selecting "Show Report".
2. It queries the global activity log to identify which projects have data in that range, then loads each snapshot.
3. For every day within the range, the provider lists totals, per-task breakdowns, and the ordered session entries (including pending ones labeled "Pending").
4. Users can export the result to CSV; incomplete entries leave blank end/duration cells, signaling that manual repair is still required.

## 9. Projects Sidebar Tree View

- `ProjectsTreeProvider` (`src/projectsTreeProvider.ts`) implements VS Code's `TreeDataProvider` interface to display projects in a dedicated sidebar view.
- **Tree Item Display**:
  - Active projects show with ▶ icon and description shows the current task name
  - Inactive projects show with 📁 icon and description shows relative time since last use (today, yesterday, X days/weeks/months ago)
  - Tooltips provide full project path
- **Click Behavior**:
  - Clicking an inactive project starts a timer (same as `tickeroo.startTimer`)
  - Clicking an active project shows a quick-pick menu with options: Stop, Switch Task, Show Report
- **Context Menu** (right-click):
  - **Rename Project**: Changes the project's display name in the index
  - **Delete Project**: Removes the project from the index and deletes its snapshot file
  - **Show Report**: Opens the report view for that specific project
- **Auto-refresh**: The tree view automatically refreshes when timers start, stop, or switch, keeping the UI in sync with the tracker state.

## 10. Data Layout Summary

- **Per-project snapshot** (`.vscode/time-tracker.json`): stores `days`, `lastTask`, `current` session, and `lastModified` timestamp for optimistic locking.
- **Day record**: totals, per-task seconds, and detailed `entries` (`task`, `start`, optional `end`, `seconds`).
- **Global index** (`projects_index.json` in extension global storage): project metadata (`id`, `path`, `name`, `lastUsed`).
- **Activity log** (`activity_log.json` in extension global storage): per-day list of projects touched (`date`, `projectId`), used for faster report filtering and tracking which days had activity.

Understanding these steps should make it straightforward to reason about new features (e.g., automated repair flows or UI changes) without re-reading the entire codebase.
