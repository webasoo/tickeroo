# Local Project Time Tracker

A small VS Code extension to track time spent on local projects and tasks.

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
