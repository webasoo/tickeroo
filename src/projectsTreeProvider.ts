import * as vscode from "vscode";
import { Tracker } from "./tracker";
import { StorageService } from "./storage";
import { ProjectIndexEntry } from "./types";

export class ProjectsTreeProvider
  implements vscode.TreeDataProvider<ProjectTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ProjectTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly tracker: Tracker,
    private readonly storage: StorageService
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: ProjectTreeItem
  ): Promise<ProjectTreeItem[] | undefined> {
    if (!element) {
      // Root level: return all projects
      const projects = this.tracker.listProjects();
      if (projects.length === 0) {
        return [];
      }

      // Sort by last used (most recent first)
      const sorted = projects.sort((a, b) => {
        const aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
        const bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
        return bTime - aTime;
      });

      return sorted.map(
        (project) => new ProjectTreeItem(project, this.tracker)
      );
    }

    return undefined;
  }
}

class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ProjectIndexEntry,
    private readonly tracker: Tracker
  ) {
    super(project.name, vscode.TreeItemCollapsibleState.None);

    const activeSession = tracker.getActiveSession();
    const isActive = activeSession?.projectId === project.id;

    // Set icon based on active state
    this.iconPath = new vscode.ThemeIcon(
      isActive ? "play-circle" : "folder",
      isActive ? new vscode.ThemeColor("charts.green") : undefined
    );

    // Build description with last used time
    const parts: string[] = [];
    if (isActive && activeSession) {
      parts.push(`▶ ${activeSession.task}`);
    } else if (project.lastUsed) {
      const lastUsedDate = new Date(project.lastUsed);
      const now = new Date();
      const diffMs = now.getTime() - lastUsedDate.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        parts.push("today");
      } else if (diffDays === 1) {
        parts.push("yesterday");
      } else if (diffDays < 7) {
        parts.push(`${diffDays} days ago`);
      } else if (diffDays < 30) {
        parts.push(`${Math.floor(diffDays / 7)} weeks ago`);
      } else {
        parts.push(`${Math.floor(diffDays / 30)} months ago`);
      }
    }

    this.description = parts.join(" • ");

    // Build tooltip
    const tooltipLines: string[] = [];
    tooltipLines.push(`**${project.name}**`);
    tooltipLines.push(`Path: ${project.path}`);
    if (project.lastUsed) {
      tooltipLines.push(
        `Last used: ${new Date(project.lastUsed).toLocaleString()}`
      );
    }
    if (isActive && activeSession) {
      tooltipLines.push(`\n▶ **Active**: ${activeSession.task}`);
    }
    this.tooltip = new vscode.MarkdownString(tooltipLines.join("\n\n"));

    // Set context value for context menu
    this.contextValue = isActive ? "project-active" : "project";

    // Make clickable - show menu for active, start timer for inactive
    if (isActive) {
      this.command = {
        command: "tickeroo.showActiveProjectMenu",
        title: "Show Actions",
        arguments: [project.id],
      };
    } else {
      this.command = {
        command: "tickeroo.startForProject",
        title: "Start Timer",
        arguments: [project.id],
      };
    }
  }
}
