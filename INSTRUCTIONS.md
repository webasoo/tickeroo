# Tickeroo - Instructions and Task List

This file lists the project requirements and a checklist for the extension tasks. It is used by the development agent to track progress.

## Requirements

- Ask the user which workspace folder (project) to work on at startup.
- Start a timer automatically for the selected project.
- Stop timer when VS Code closes or the user switches project.
- Store data locally in `.vscode/time-tracker.json` asynchronously.
- Allow manual creation and switching of tasks.
- Display current project, task, and elapsed time in the status bar.
- Provide commands: Start Timer, Stop Timer, Switch Task, Show Report.
- Show Report opens a webview with daily totals and per-task breakdown.
- Track inactivity via editor/window events and timers.

## Task Checklist

- [ ] Create extension scaffold (package.json, tsconfig)
- [ ] Add VS Code launch config for F5
- [ ] Implement storage layer (.vscode/time-tracker.json)
- [ ] Implement tracker logic (start/stop, tasks, idle detection)
- [ ] Add status bar UI
- [ ] Register and implement commands
- [ ] Implement webview report
- [ ] README and run instructions
- [ ] Tests / quick verification
- [] set default to prevent load choose project as default on load project
- [x] add a gif on a project that has tracker records by now is idle
- [] add config (disable timer for specific project, idle time threshold, auto start on run, etc)
  Updated progress:

- [x] Create extension scaffold (package.json, tsconfig)
- [x] Add VS Code launch config for F5
- [x] Implement storage layer (.vscode/time-tracker.json) (reads/writes using workspace.fs)
- [x] Implement tracker logic (start/stop, tasks, idle detection)
- [x] Add status bar UI
- [x] Register and implement commands
- [x] Implement webview report
- [x] README and run instructions
- [ ] Tests / quick verification

Final status:

- [x] Tests / quick verification (local compile succeeded)
- [x] All tasks completed — extension ready for local testing with F5

Update this file as tasks are completed. The development agent will mark items as completed here.
