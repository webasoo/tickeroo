import * as vscode from "vscode";
import { TimeTrackerData } from "./types";

export class ReportProvider {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public show(getData: () => TimeTrackerData) {
    const data = getData();
    const panel = vscode.window.createWebviewPanel(
      "timeTrackerReport",
      "Time Tracker Report",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
      }
    );
    panel.webview.html = this.getHtml(data);
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.command === "export") {
        const latest = getData();
        await this.exportCsv(latest);
      }
    });
  }

  private getHtml(data: TimeTrackerData) {
    const today = new Date().toISOString().slice(0, 10);
    let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body { font-family: sans-serif; padding: 16px; }
      h2, h3 { margin-bottom: 8px; }
      table { border-collapse: collapse; margin-top: 8px; margin-bottom: 24px; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
      th { background-color: #f0f0f0; }
      button { margin-top: 16px; padding: 6px 12px; }
    </style></head><body>`;
    html += `<h2>Daily report — ${today}</h2>`;
    for (const projectPath of Object.keys(data.projects || {})) {
      const project = data.projects[projectPath];
      const day = project.days[today];
      if (!day) continue;
      html += `<h3>${projectPath.split("/").pop() || projectPath}</h3>`;
      html += `<p>Total: ${formatSeconds(day.totalSeconds)}</p>`;
      html += `<ul>`;
      for (const task of Object.keys(day.tasks)) {
        html += `<li>${task}: ${formatSeconds(day.tasks[task])}</li>`;
      }
      html += `</ul>`;
      if (day.entries && day.entries.length > 0) {
        const sortedEntries = [...day.entries].sort((a, b) =>
          a.start.localeCompare(b.start)
        );
        html += `<table><thead><tr><th>Task</th><th>Start</th><th>End</th><th>Duration</th></tr></thead><tbody>`;
        for (const entry of sortedEntries) {
          const start = new Date(entry.start).toLocaleString();
          const end = new Date(entry.end).toLocaleString();
          html += `<tr><td>${entry.task}</td><td>${start}</td><td>${end}</td><td>${formatSeconds(entry.seconds)}</td></tr>`;
        }
        html += `</tbody></table>`;
      }
    }
    html += `<button id="export">Export to CSV</button>`;
    html += `<script>
      const vscodeApi = acquireVsCodeApi();
      const exportButton = document.getElementById('export');
      if (exportButton) {
        exportButton.addEventListener('click', () => {
          vscodeApi.postMessage({ command: 'export' });
        });
      }
    </script>`;
    html += `</body></html>`;
    return html;
  }

  private async exportCsv(data: TimeTrackerData) {
    const today = new Date().toISOString().slice(0, 10);
    const rows: string[] = ["Project,Task,Start,End,Seconds,Formatted"];

    for (const projectPath of Object.keys(data.projects || {})) {
      const project = data.projects[projectPath];
      const day = project.days[today];
      if (!day) {
        continue;
      }
      const projectName = projectPath.split("/").pop() || projectPath;
      const entries =
        day.entries && day.entries.length > 0
          ? [...day.entries].sort((a, b) => a.start.localeCompare(b.start))
          : [];

      if (entries.length > 0) {
        for (const entry of entries) {
          rows.push(
            `${this.escapeCsv(projectName)},${this.escapeCsv(
              entry.task
            )},${this.escapeCsv(entry.start)},${this.escapeCsv(
              entry.end
            )},${entry.seconds},${formatSeconds(entry.seconds)}`
          );
        }
      } else if (day.tasks && Object.keys(day.tasks).length > 0) {
        for (const [taskName, seconds] of Object.entries(day.tasks)) {
          rows.push(
            `${this.escapeCsv(projectName)},${this.escapeCsv(
              taskName
            )},,,${seconds},${formatSeconds(seconds)}`
          );
        }
      } else {
        rows.push(
          `${this.escapeCsv(projectName)},,,,${day.totalSeconds},${formatSeconds(
            day.totalSeconds
          )}`
        );
      }
    }

    if (rows.length === 1) {
      vscode.window.showInformationMessage(
        "Time Tracker: no data to export for today."
      );
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    let defaultUri: vscode.Uri | undefined;
    if (workspaceFolders && workspaceFolders.length > 0) {
      defaultUri = vscode.Uri.joinPath(
        workspaceFolders[0].uri,
        `.vscode/time-tracker-report-${today}.csv`
      );
    }

    if (!defaultUri) {
      defaultUri = vscode.Uri.joinPath(
        this.context.globalStorageUri,
        `time-tracker-report-${today}.csv`
      );
    }

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        CSV: ["csv"],
      },
      saveLabel: "Export",
    });

    if (!saveUri) {
      return;
    }

    const content = rows.join("\n");
    const bytes = Buffer.from(content, "utf8");
    await vscode.workspace.fs.writeFile(saveUri, bytes);
    vscode.window.showInformationMessage(
      `Time Tracker: exported report to ${saveUri.fsPath}`
    );
  }

  private escapeCsv(value: string) {
    if (/[",\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}

function formatSeconds(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}
