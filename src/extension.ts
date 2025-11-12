import * as path from "path";
import * as vscode from "vscode";
import { StorageService } from "./storage";
import { Tracker } from "./tracker";
import { StatusBar } from "./statusBar";
import { ReportProvider } from "./reportProvider";

let storage: StorageService | null = null;
let tracker: Tracker | null = null;
let statusBar: StatusBar | null = null;
let reportProvider: ReportProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Tickeroo activating");

  storage = new StorageService(context);
  tracker = new Tracker(context, storage);
  await tracker.init();

  statusBar = new StatusBar(tracker);
  statusBar.start();

  reportProvider = new ReportProvider(context, storage);

  void maybePromptInitialProject();

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.startTimer", async () => {
      if (!tracker) {
        return;
      }
      const pick = await pickWorkspaceProject({
        placeHolder: "Select project to track",
        includeOther: true,
      });
      if (!pick) {
        return;
      }
      if (pick === "other") {
        await vscode.commands.executeCommand(
          "timeTracker.startTimerOutsideWorkspace"
        );
        return;
      }
      await handleStartForProject(
        pick.projectPath,
        pick.projectLabel,
        pick.projectId
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.startTimerOutsideWorkspace", async () => {
      if (!tracker) {
        return;
      }
      const pick = await pickGlobalProject();
      if (!pick) {
        return;
      }
      if (pick.action === "browse") {
        const chosen = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
        });
        if (!chosen || chosen.length === 0) {
          return;
        }
        await handleStartForProject(chosen[0].fsPath);
        return;
      }
      await handleStartForProject(
        pick.projectPath,
        pick.projectLabel,
        pick.projectId
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.stopTimer", async () => {
      if (!tracker) {
        return;
      }
      await tracker.stop();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.switchTask", async () => {
      if (!tracker) {
        return;
      }
      const session = tracker.getActiveSession();
      if (!session) {
        vscode.window.showInformationMessage("No active timer");
        return;
      }
      const task = await promptForTask(session.projectPath, {
        placeholder: "Select a new task or create one",
        excludeTask: session.task,
        fallbackValue: session.task,
        projectLabel: session.projectName,
      });
      if (!task) {
        return;
      }
      await tracker.switchTask(task);
      tracker.touchActivity();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.showReport", async () => {
      if (!reportProvider) {
        return;
      }
      interface ReportScopePick extends vscode.QuickPickItem {
        command: string;
      }
      const scopeItems: ReportScopePick[] = [
        {
          label: "Current project",
          description: "Focus on your most recent project",
          command: "timeTracker.showCurrentProjectReport",
        },
        {
          label: "All projects",
          description: "Aggregate every tracked project",
          command: "timeTracker.showAllProjectsReport",
        },
      ];
      const pick = await vscode.window.showQuickPick<ReportScopePick>(
        scopeItems,
        {
          placeHolder: "Select report scope",
        }
      );
      if (!pick) {
        return;
      }
      await vscode.commands.executeCommand(pick.command);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "timeTracker.showCurrentProjectReport",
      async () => {
        if (!reportProvider || !tracker) {
          return;
        }
        const entry = tracker.getMostRecentProjectEntry();
        if (!entry) {
          vscode.window.showInformationMessage(
            "Tickeroo: no tracked projects available for reporting."
          );
          return;
        }
        await reportProvider.showProject(entry);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "timeTracker.showAllProjectsReport",
      async () => {
        if (!reportProvider) {
          return;
        }
        await reportProvider.showAllProjects();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.showStatusMenu", async () => {
      if (!tracker) {
        return;
      }
      type StatusAction =
        | "start"
        | "stop"
        | "switch"
        | "reportCurrent"
        | "reportAll";
      interface StatusMenuItem extends vscode.QuickPickItem {
        action: StatusAction;
      }

      const session = tracker.getActiveSession();
      const items: StatusMenuItem[] = [];
      if (session) {
        items.push({
          label: "Stop timer",
          description: `${session.projectName} — ${session.task}`,
          action: "stop",
        });
        items.push({
          label: "Switch task",
          description: `${session.projectName} — ${session.task}`,
          action: "switch",
        });
      } else {
        items.push({
          label: "Start timer",
          description: "Begin tracking time for a project",
          action: "start",
        });
      }
      items.push({
        label: "Report current project",
        description: "Review the most recent project's activity",
        action: "reportCurrent",
      });
      items.push({
        label: "Report all projects",
        description: "Aggregate time across every project",
        action: "reportAll",
      });

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Tickeroo actions",
      });
      if (!pick) {
        return;
      }

      switch (pick.action) {
        case "start":
          await vscode.commands.executeCommand("timeTracker.startTimer");
          break;
        case "stop":
          await vscode.commands.executeCommand("timeTracker.stopTimer");
          break;
        case "switch":
          await vscode.commands.executeCommand("timeTracker.switchTask");
          break;
        case "reportCurrent":
          await vscode.commands.executeCommand(
            "timeTracker.showCurrentProjectReport"
          );
          break;
        case "reportAll":
          await vscode.commands.executeCommand(
            "timeTracker.showAllProjectsReport"
          );
          break;
      }
    })
  );

  // Activity listeners for idle detection
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => tracker?.touchActivity())
  );
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!tracker) {
        return;
      }
      if (state.focused) {
        tracker.touchActivity();
      }
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => tracker?.touchActivity())
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      if (!tracker) {
        return;
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        await tracker.stop();
      }
    })
  );

  context.subscriptions.push({
    dispose: async () => {
      if (tracker) {
        await tracker.dispose();
      }
    },
  });
}

export function deactivate() {
  // nothing special — tracker disposed via subscriptions
}

interface WorkspacePickResult {
  projectPath: string;
  projectLabel: string;
  projectId?: string;
}

async function maybePromptInitialProject(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!tracker) {
    return;
  }
  if (!storage || folders.length === 0) {
    tracker.setWorkspaceHasTrackedHistory(false);
    return;
  }

  const hasHistory = await workspaceHasRecordedHistory(folders);
  tracker.setWorkspaceHasTrackedHistory(hasHistory);
  if (!hasHistory) {
    return;
  }

  const pick = await pickWorkspaceProject({
    placeHolder: "Select project to track (optional)",
    includeOther: true,
    optional: true,
  });
  if (!pick) {
    return;
  }
  if (pick === "other") {
    await vscode.commands.executeCommand(
      "timeTracker.startTimerOutsideWorkspace"
    );
    return;
  }
  await handleStartForProject(
    pick.projectPath,
    pick.projectLabel,
    pick.projectId
  );
}

async function workspaceHasRecordedHistory(
  folders: readonly vscode.WorkspaceFolder[]
): Promise<boolean> {
  if (!storage) {
    return false;
  }
  for (const folder of folders) {
    try {
      const hasRecords = await storage.projectHasRecords(folder.uri.fsPath);
      if (hasRecords) {
        return true;
      }
    } catch {
      // ignore per-folder errors; fallback to prompting when possible
    }
  }
  return false;
}

async function handleStartForProject(
  projectPath: string,
  projectLabel?: string,
  projectId?: string
): Promise<void> {
  if (!tracker) {
    return;
  }
  let resolvedPath = projectPath;
  if (projectId) {
    const exists = await pathExists(resolvedPath);
    if (!exists) {
      const choice = await vscode.window.showWarningMessage(
        `${projectLabel ?? "Project"} path not found. Update location?`,
        "Locate…",
        "Cancel"
      );
      if (choice !== "Locate…") {
        return;
      }
      const replacement = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      if (!replacement || replacement.length === 0) {
        return;
      }
      resolvedPath = replacement[0].fsPath;
      await tracker.updateProjectPath(projectId, resolvedPath);
    }
  }

  const task = await promptForTask(resolvedPath, {
    placeholder: projectLabel
      ? `Select task for ${projectLabel}`
      : "Select task to start or create a new one",
    projectLabel,
  });
  if (!task) {
    return;
  }
  await tracker.start(resolvedPath, task);
  tracker.touchActivity();
}

async function pickWorkspaceProject(options: {
  placeHolder: string;
  includeOther?: boolean;
  optional?: boolean;
}): Promise<WorkspacePickResult | "other" | undefined> {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    return undefined;
  }

  interface WorkspacePickItem extends vscode.QuickPickItem {
    projectPath?: string;
    projectLabel?: string;
    projectId?: string;
    action?: "other";
  }

  const items: WorkspacePickItem[] = [];
  if (folders.length > 0) {
    items.push({
      label: "Workspace folders",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const folder of folders) {
      const projectPath = folder.uri.fsPath;
      const entry = storage?.findProjectByPath(projectPath);
      items.push({
        label: entry?.name ?? folder.name,
        description: projectPath,
        projectPath,
        projectLabel: entry?.name ?? folder.name,
        projectId: entry?.id,
      });
    }
  }

  if (options.includeOther) {
    items.push({
      label: "Other projects…",
      description: "Select from known projects or browse",
      action: "other",
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: options.placeHolder,
    ignoreFocusOut: !options.optional,
  });

  if (!pick) {
    return undefined;
  }

  if (pick.action === "other") {
    return "other";
  }

  if (pick.projectPath && pick.projectLabel) {
    return {
      projectPath: pick.projectPath,
      projectLabel: pick.projectLabel,
      projectId: pick.projectId,
    };
  }

  return undefined;
}

async function pickGlobalProject(): Promise<
  | {
      action: "existing";
      projectId: string;
      projectPath: string;
      projectLabel: string;
    }
  | { action: "browse" }
  | undefined
> {
  if (!tracker) {
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders || [];
  const known = tracker.listProjects();
  const outside = known.filter((entry) => !isInsideWorkspace(entry.path, folders));

  interface GlobalPickItem extends vscode.QuickPickItem {
    action: "existing" | "browse";
    projectId?: string;
    projectPath?: string;
    projectLabel?: string;
  }

  const items: GlobalPickItem[] = [];
  if (outside.length > 0) {
    items.push({
      label: "Tracked projects",
      kind: vscode.QuickPickItemKind.Separator,
      action: "existing",
    });
    for (const entry of outside) {
      items.push({
        label: entry.name,
        description: entry.path,
        action: "existing",
        projectId: entry.id,
        projectPath: entry.path,
        projectLabel: entry.name,
      });
    }
  }

  items.push({
    label: "Browse for folder…",
    description: "Track a project outside this workspace",
    action: "browse",
  });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: outside.length
      ? "Select tracked project or browse"
      : "Browse for a project to track",
  });
  if (!pick) {
    return undefined;
  }
  if (pick.action === "browse") {
    return { action: "browse" };
  }
  if (pick.projectId && pick.projectPath && pick.projectLabel) {
    return {
      action: "existing",
      projectId: pick.projectId,
      projectPath: pick.projectPath,
      projectLabel: pick.projectLabel,
    };
  }
  return undefined;
}

function isInsideWorkspace(
  projectPath: string,
  folders: readonly vscode.WorkspaceFolder[]
): boolean {
  for (const folder of folders) {
    const workspacePath = folder.uri.fsPath;
    const relative = path.relative(workspacePath, projectPath);
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
    return true;
  } catch {
    return false;
  }
}

interface TaskPromptOptions {
  placeholder?: string;
  excludeTask?: string;
  fallbackValue?: string;
  projectLabel?: string;
}

async function promptForTask(
  projectPath: string,
  options: TaskPromptOptions = {}
): Promise<string | undefined> {
  if (!tracker) {
    return undefined;
  }

  const snapshot = await tracker.getProjectSnapshotByPath(projectPath);

  type TaskAction = "task" | "new";
  interface TaskQuickPickItem extends vscode.QuickPickItem {
    action: TaskAction;
    task?: string;
  }

  const items: TaskQuickPickItem[] = [];
  const seen = new Set<string>();

  const lastTask = snapshot.lastTask;
  if (lastTask && lastTask !== options.excludeTask) {
    items.push({
      label: lastTask,
      description: "Last used task",
      action: "task",
      task: lastTask,
    });
    seen.add(lastTask);
  }

  const historicalTasks = new Set<string>();
  for (const day of Object.values(snapshot.days ?? {})) {
    for (const taskName of Object.keys(day.tasks ?? {})) {
      if (!taskName) {
        continue;
      }
      historicalTasks.add(taskName);
    }
  }

  const sortedTasks = Array.from(historicalTasks).sort((a, b) =>
    a.localeCompare(b)
  );

  for (const taskName of sortedTasks) {
    if (taskName === options.excludeTask) {
      continue;
    }
    if (seen.has(taskName)) {
      continue;
    }
    items.push({
      label: taskName,
      description: "Previously tracked task",
      action: "task",
      task: taskName,
    });
    seen.add(taskName);
  }

  items.push({
    label: "Enter new task…",
    description: "Type a different task name",
    action: "new",
  });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder:
      options.placeholder ??
      (options.projectLabel
        ? `Select task for ${options.projectLabel}`
        : "Select task"),
    ignoreFocusOut: true,
  });

  if (!pick) {
    return undefined;
  }

  if (pick.action === "new") {
    const input = await vscode.window.showInputBox({
      prompt: "Task name",
      value: options.fallbackValue ?? lastTask ?? "",
      ignoreFocusOut: true,
    });
    const trimmed = input?.trim();
    return trimmed ? trimmed : undefined;
  }

  return pick.task;
}
