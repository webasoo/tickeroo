# Tickeroo

Tickeroo is a small VS Code extension to track time spent on local projects and tasks.

## Features

- **Projects Sidebar**: Manage all your tracked projects from a dedicated sidebar view
  - View all projects with their last-used timestamps
  - See active timers with the ▶ icon and current task name
  - Right-click context menu for quick actions (rename, delete, show report)
  - Click on projects to start/stop timers or switch tasks
- **Time Tracking**: Start and stop timers for different tasks within projects
- **Status Bar Integration**: Quick access to timer controls and status
- **Reports**: Generate detailed time reports with CSV export
- **Multi-Window Support**: Safe concurrent usage across multiple VS Code windows with optimistic locking

## Usage

1. Open the Tickeroo sidebar from the Activity Bar (clock icon)
2. Click on a project to start tracking time
3. For active projects, click to see options: Stop, Switch Task, or Show Report
4. Use the status bar item for quick timer controls
5. Right-click any project for additional actions (rename, delete, show report)

## Installation and Development

Installation and run:

1. Install dependencies:

```bash
npm install
```

2. Open this folder in VS Code and press F5 to run the extension in the Extension Development Host.

Example `time-tracker.json` structure (stored in `.vscode/time-tracker.json`):

```json
{
  "projects": {
    "/path/to/project": {
      "days": {
        "2025-10-16": {
          "totalSeconds": 3600,
          "tasks": {
            "Feature X": 1800,
            "Bug Fix": 1800
          }
        }
      }
    }
  },
  "current": {
    "project": "/path/to/project",
    "task": "Feature X",
    "start": "2025-10-16T12:00:00.000Z"
  }
}
```

## Publishing Summary

- **Local VSIX build/install**

  - `npm install` then `npm run compile`
  - `npx vsce package` (or use global `vsce`) to create `tickeroo-<version>.vsix`
  - Install locally with `code --install-extension tickeroo-<version>.vsix`

- **Marketplace publish**
  1. Create a publisher in the VS Code Marketplace (Azure DevOps) and generate a Personal Access Token with `Packaging: Read & Manage`
  2. Run `npx vsce login <publisher-name>` once to store the token
  3. Update `version` in `package.json`, then run `npx vsce publish` (optionally with `--yarn` if you use yarn)
  4. Publishing updates requires repeating steps 2–3 with the new version number
