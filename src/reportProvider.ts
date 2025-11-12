import * as vscode from "vscode";
import { StorageService } from "./storage";
import { DayRecord, ProjectIndexEntry } from "./types";

interface ReportRange {
  label: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

interface ProjectReportDay {
  date: string;
  record: DayRecord;
}

interface ProjectReport {
  entry: ProjectIndexEntry;
  days: ProjectReportDay[];
}

interface ReportData {
  heading: string;
  range: ReportRange;
  projects: ProjectReport[];
}

export class ReportProvider {
  private readonly context: vscode.ExtensionContext;
  private readonly storage: StorageService;
  private latest: ReportData | null = null;

  constructor(context: vscode.ExtensionContext, storage: StorageService) {
    this.context = context;
    this.storage = storage;
  }

  async showAllProjects(): Promise<void> {
    const range = await this.pickRange();
    if (!range) {
      return;
    }
    const projects = await this.buildReport(range);
    const report: ReportData = {
      heading: "All projects",
      range,
      projects,
    };
    await this.renderReport(report, `Tickeroo Report — ${range.label}`);
  }

  async showProject(entry: ProjectIndexEntry): Promise<void> {
    const range = await this.pickRange();
    if (!range) {
      return;
    }
    const projects = await this.buildReport(range, { projectIds: [entry.id] });
    const report: ReportData = {
      heading: entry.name,
      range,
      projects,
    };
    await this.renderReport(report, `Tickeroo Report — ${entry.name}`);
  }

  private async pickRange(): Promise<ReportRange | undefined> {
    const today = new Date();
    const todayStr = formatDate(today);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const last7 = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    const last30 = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);

    interface RangePickItem extends vscode.QuickPickItem {
      range?: ReportRange;
      action?: "custom";
    }

    const items: RangePickItem[] = [
      {
        label: "Today",
        description: `${todayStr}`,
        range: { label: "Today", start: todayStr, end: todayStr },
      },
      {
        label: "Yesterday",
        description: `${formatDate(yesterday)}`,
        range: {
          label: "Yesterday",
          start: formatDate(yesterday),
          end: formatDate(yesterday),
        },
      },
      {
        label: "Last 7 days",
        description: `${formatDate(last7)} — ${todayStr}`,
        range: {
          label: "Last 7 days",
          start: formatDate(last7),
          end: todayStr,
        },
      },
      {
        label: "Last 30 days",
        description: `${formatDate(last30)} — ${todayStr}`,
        range: {
          label: "Last 30 days",
          start: formatDate(last30),
          end: todayStr,
        },
      },
      {
        label: "Custom range…",
        description: "Choose start and end dates",
        action: "custom",
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select report range",
    });

    if (!pick) {
      return undefined;
    }

    if (pick.range) {
      return pick.range;
    }

    if (pick.action === "custom") {
      const startInput = await vscode.window.showInputBox({
        prompt: "Start date (YYYY-MM-DD)",
        value: formatDate(last7),
        ignoreFocusOut: true,
        validateInput: validateDate,
      });
      if (!startInput) {
        return undefined;
      }
      const endInput = await vscode.window.showInputBox({
        prompt: "End date (YYYY-MM-DD)",
        value: todayStr,
        ignoreFocusOut: true,
        validateInput: validateDate,
      });
      if (!endInput) {
        return undefined;
      }
      const start = startInput.trim();
      const end = endInput.trim();
      if (start > end) {
        vscode.window.showWarningMessage(
          "Tickeroo: start date must be on or before the end date."
        );
        return undefined;
      }
      return {
        label: `${start} – ${end}`,
        start,
        end,
      };
    }

    return undefined;
  }

  private async buildReport(
    range: ReportRange,
    options?: { projectIds?: string[] }
  ): Promise<ProjectReport[]> {
    await this.storage.init();
    const touched = this.storage.getProjectsTouchedBetween(
      range.start,
      range.end
    );

    const candidateIds = new Set<string>(
      options?.projectIds && options.projectIds.length > 0
        ? options.projectIds.filter((id): id is string => Boolean(id))
        : touched
    );
    if (candidateIds.size === 0) {
      return [];
    }

    const projects: ProjectReport[] = [];
    for (const projectId of candidateIds) {
      const entry = this.storage.findProjectById(projectId);
      if (!entry) {
        continue;
      }
      const snapshot = await this.storage.getProjectSnapshot(entry.path);
      const days: ProjectReportDay[] = [];
      for (const [date, record] of Object.entries(snapshot.days ?? {})) {
        if (date < range.start || date > range.end) {
          continue;
        }
        const hasData =
          record.totalSeconds > 0 ||
          Object.keys(record.tasks ?? {}).length > 0 ||
          (record.entries?.length ?? 0) > 0;
        if (!hasData) {
          continue;
        }
        days.push({ date, record });
      }
      if (days.length === 0) {
        continue;
      }
      days.sort((a, b) => a.date.localeCompare(b.date));
      projects.push({ entry, days });
    }

    projects.sort((a, b) => a.entry.name.localeCompare(b.entry.name));

    return projects;
  }

  private async renderReport(report: ReportData, panelTitle: string) {
    if (report.projects.length === 0) {
      vscode.window.showInformationMessage(
        `Tickeroo: no tracked activity between ${report.range.start} and ${report.range.end}.`
      );
      return;
    }

    this.latest = report;

    const panel = vscode.window.createWebviewPanel(
      "timeTrackerReport",
      panelTitle,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
      }
    );

    panel.webview.html = this.getHtml(report);
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.command === "export") {
        const current = this.latest;
        if (!current) {
          return;
        }
        await this.exportCsv(current);
      }
    });
  }

  private getHtml(report: ReportData) {
    const parts: string[] = [];
    parts.push(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body { font-family: sans-serif; padding: 16px; }
      h2 { margin-bottom: 4px; }
      h3 { margin: 24px 0 8px; }
      h4 { margin: 16px 0 4px; }
      .path { color: #666; font-size: 12px; margin: 0 0 8px; }
      .range { color: #333; font-size: 13px; margin-bottom: 16px; }
      table { border-collapse: collapse; margin-top: 4px; margin-bottom: 16px; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
      th { background-color: #f0f0f0; }
      ul { margin: 4px 0 12px; padding-left: 20px; }
      button { margin-top: 16px; padding: 6px 12px; }
    </style></head><body>`);
    parts.push(`<h2>${escapeHtml(report.heading)}</h2>`);
    if (report.range.start === report.range.end) {
      parts.push(`<p class="range">${report.range.label} — ${report.range.start}</p>`);
    } else {
      parts.push(
        `<p class="range">${report.range.label} — ${report.range.start} to ${report.range.end}</p>`
      );
    }

    for (const project of report.projects) {
      const totalSeconds = project.days.reduce(
        (sum, day) => sum + (day.record.totalSeconds || 0),
        0
      );
      parts.push(`<h3>${escapeHtml(project.entry.name)}</h3>`);
      parts.push(
        `<p class="path">${escapeHtml(project.entry.path)}</p>`
      );
      parts.push(`<p>Total: ${formatSeconds(totalSeconds)}</p>`);

      for (const day of project.days) {
        parts.push(`<h4>${day.date}</h4>`);
        parts.push(`
          <p>Daily total: ${formatSeconds(day.record.totalSeconds || 0)}</p>
        `);
        const tasks = Object.entries(day.record.tasks ?? {});
        if (tasks.length > 0) {
          parts.push(`<ul>`);
          for (const [taskName, seconds] of tasks) {
            parts.push(
              `<li>${escapeHtml(taskName)}: ${formatSeconds(seconds)}</li>`
            );
          }
          parts.push(`</ul>`);
        }

        const entries = day.record.entries;
        if (entries && entries.length > 0) {
          const sortedEntries = [...entries].sort((a, b) =>
            a.start.localeCompare(b.start)
          );
          parts.push(
            `<table><thead><tr><th>Task</th><th>Start</th><th>End</th><th>Duration</th></tr></thead><tbody>`
          );
          for (const entry of sortedEntries) {
            parts.push(
              `<tr><td>${escapeHtml(entry.task)}</td><td>${escapeHtml(
                new Date(entry.start).toLocaleString()
              )}</td><td>${escapeHtml(
                new Date(entry.end).toLocaleString()
              )}</td><td>${formatSeconds(entry.seconds)}</td></tr>`
            );
          }
          parts.push(`</tbody></table>`);
        }
      }
    }

    parts.push(`<button id="export">Export to CSV</button>`);
    parts.push(`<script>
      const vscodeApi = acquireVsCodeApi();
      const exportButton = document.getElementById('export');
      if (exportButton) {
        exportButton.addEventListener('click', () => {
          vscodeApi.postMessage({ command: 'export' });
        });
      }
    </script>`);
    parts.push(`</body></html>`);
    return parts.join("");
  }

  private async exportCsv(report: ReportData) {
    const rows: string[] = [
      "Project,Date,Task,Start,End,Seconds,Formatted",
    ];

    for (const project of report.projects) {
      for (const day of project.days) {
        const entries = day.record.entries && day.record.entries.length > 0
          ? [...day.record.entries].sort((a, b) => a.start.localeCompare(b.start))
          : [];

        if (entries.length > 0) {
          for (const entry of entries) {
            rows.push(
              `${this.escapeCsv(project.entry.name)},${day.date},${this.escapeCsv(
                entry.task
              )},${this.escapeCsv(entry.start)},${this.escapeCsv(
                entry.end
              )},${entry.seconds},${formatSeconds(entry.seconds)}`
            );
          }
        } else {
          const tasks = Object.entries(day.record.tasks ?? {});
          if (tasks.length > 0) {
            for (const [taskName, seconds] of tasks) {
              rows.push(
                `${this.escapeCsv(project.entry.name)},${day.date},${this.escapeCsv(
                  taskName
                )},,,${seconds},${formatSeconds(seconds)}`
              );
            }
          } else {
            const total = day.record.totalSeconds || 0;
            rows.push(
              `${this.escapeCsv(project.entry.name)},${day.date},,,,${total},${formatSeconds(
                total
              )}`
            );
          }
        }
      }
    }

    if (rows.length === 1) {
      vscode.window.showInformationMessage(
        "Tickeroo: no data available for export."
      );
      return;
    }

    const safeHeading = report.heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report";
    const defaultFileName = `tickeroo-${safeHeading}-${report.range.start}-${report.range.end}.csv`;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let defaultUri: vscode.Uri | undefined;
    if (workspaceFolders && workspaceFolders.length > 0) {
      defaultUri = vscode.Uri.joinPath(
        workspaceFolders[0].uri,
        `.vscode/${defaultFileName}`
      );
    }
    if (!defaultUri) {
      defaultUri = vscode.Uri.joinPath(this.context.globalStorageUri, defaultFileName);
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
      `Tickeroo: exported report to ${saveUri.fsPath}`
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validateDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return "Use YYYY-MM-DD format.";
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date.";
  }
  return undefined;
}
