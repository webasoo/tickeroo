import * as vscode from "vscode";
import { Tracker } from "./tracker";
import { StatusBar } from "./statusBar";
import { ReportProvider } from "./reportProvider";

let tracker: Tracker | null = null;
let statusBar: StatusBar | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Local Project Time Tracker activating");

  tracker = new Tracker(context);
  await tracker.init();

  // create status bar as early as possible so it's visible in the Dev Host
  statusBar = new StatusBar(tracker);
  statusBar.start();

  // On activation, offer a one-time prompt to start tracking. Show workspace folders,
  // recent projects, or allow selecting a folder.
  void (async function maybePromptInitialProject() {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const data = tracker!.getData();

    const items: vscode.QuickPickItem[] = [];

    // Workspace folders (if any)
    if (workspaceFolders.length > 0) {
      items.push({ label: "--- Workspace folders ---" });
      for (const f of workspaceFolders) {
        items.push({ label: f.name, description: f.uri.fsPath });
      }
    }

    // Recent projects from stored data (most-recent first based on lastProjectPath)
    const recentPaths = Object.keys(data.projects || {});
    const lastProject = context.globalState.get<string>(
      "timeTracker.lastProjectPath"
    );
    const sorted = recentPaths.sort((a, b) => {
      if (a === lastProject) return -1;
      if (b === lastProject) return 1;
      return 0;
    });
    if (sorted.length > 0) {
      items.push({ label: "--- Recent projects ---" });
      for (const p of sorted) {
        items.push({ label: p.split("/").pop() || p, description: p });
      }
    }

    items.push({
      label: "Select folder…",
      description: "Browse for a folder to track",
    });

    // Non-blocking; show quick pick but don't force the user
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select project to track (optional)",
      ignoreFocusOut: true,
    });
    if (!pick) return;

    if (pick.label === "Select folder…") {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      if (!chosen || chosen.length === 0) return;
      const folderPath = chosen[0].fsPath;
      const task = await promptForTask(folderPath, {
        placeholder: "Select task to start or create a new one",
      });
      if (!task) return;
      await tracker!.start(folderPath, task);
      tracker!.touchActivity();
      return;
    }

    // Otherwise we have a description for the project path
    const projectPath = pick.description ?? pick.label;
    const task = await promptForTask(projectPath, {
      placeholder: "Select task to start or create a new one",
    });
    if (!task) return;
    await tracker!.start(projectPath, task);
    tracker!.touchActivity();
  })();

  const reportProvider = new ReportProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.startTimer", async () => {
      // Build an improved pick: workspace, recent, select folder
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      const data = tracker!.getData();
      const items: vscode.QuickPickItem[] = [];

      if (workspaceFolders.length > 0) {
        items.push({ label: "--- Workspace folders ---" });
        for (const f of workspaceFolders) {
          items.push({ label: f.name, description: f.uri.fsPath });
        }
      }

      const recent = Object.keys(data.projects || {});
      const lastProject = context.globalState.get<string>(
        "timeTracker.lastProjectPath"
      );
      const sorted = recent.sort((a, b) =>
        a === lastProject ? -1 : b === lastProject ? 1 : 0
      );
      if (sorted.length > 0) {
        items.push({ label: "--- Recent projects ---" });
        for (const p of sorted) {
          items.push({ label: p.split("/").pop() || p, description: p });
        }
      }

      items.push({
        label: "Select folder…",
        description: "Browse for a folder to track",
      });

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select project to track",
      });
      if (!pick) return;
      let projectPath: string | undefined;
      if (pick.label === "Select folder…") {
        const chosen = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
        });
        if (!chosen || chosen.length === 0) return;
        projectPath = chosen[0].fsPath;
      } else {
        projectPath = pick.description ?? pick.label;
      }
      if (!projectPath) return;
      const task = await promptForTask(projectPath, {
        placeholder: "Select task to start or create a new one",
      });
      if (!task) return;
      await tracker!.start(projectPath, task);
      tracker!.touchActivity();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.stopTimer", async () => {
      await tracker!.stop();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.switchTask", async () => {
      const data = tracker!.getData();
      if (!data.current) {
        vscode.window.showInformationMessage("No active timer");
        return;
      }
      const task = await promptForTask(data.current.project, {
        placeholder: "Select a new task or create one",
        excludeTask: data.current.task,
        fallbackValue: data.current.task,
      });
      if (!task) return;
      await tracker!.switchTask(task);
      tracker!.touchActivity();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.showReport", async () => {
      reportProvider.show(() => tracker!.getData());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("timeTracker.showStatusMenu", async () => {
      if (!tracker) {
        return;
      }
      type StatusAction = "start" | "stop" | "switch" | "report";
      interface StatusMenuItem extends vscode.QuickPickItem {
        action: StatusAction;
      }
      const data = tracker.getData();
      const items: StatusMenuItem[] = [];
      if (data.current) {
        const projectName =
          data.current.project.split("/").pop() || data.current.project;
        items.push({
          label: "Stop timer",
          description: `${projectName} — ${data.current.task}`,
          action: "stop",
        });
        items.push({
          label: "Switch task",
          description: `${projectName} — ${data.current.task}`,
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
        label: "Show report",
        description: "View today's tracked time by project and task",
        action: "report",
      });

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Time Tracker actions",
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
        case "report":
          await vscode.commands.executeCommand("timeTracker.showReport");
          break;
      }
    })
  );

  let pendingAutoStop: NodeJS.Timeout | null = null;
  const clearPendingAutoStop = () => {
    if (pendingAutoStop) {
      clearTimeout(pendingAutoStop);
      pendingAutoStop = null;
    }
  };
  const scheduleAutoStop = () => {
    clearPendingAutoStop();
    pendingAutoStop = setTimeout(async () => {
      pendingAutoStop = null;
      if (!tracker) {
        return;
      }
      if (
        !vscode.window.state.focused &&
        vscode.window.visibleTextEditors.length === 0 &&
        tracker.getData().current
      ) {
        await tracker.stop();
      }
    }, 700);
  };

  // Activity listeners for idle detection
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => tracker!.touchActivity())
  );
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!tracker) {
        return;
      }
      if (!state.focused) {
        scheduleAutoStop();
        return;
      }
      tracker.touchActivity();
      clearPendingAutoStop();
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      if (!tracker) {
        return;
      }
      if (editors.length === 0 && !vscode.window.state.focused) {
        scheduleAutoStop();
      } else {
        tracker.touchActivity();
        clearPendingAutoStop();
      }
    })
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

  // Save on shutdown
  context.subscriptions.push({
    dispose: async () => {
      if (tracker) await tracker.stop();
    },
  });
  context.subscriptions.push({
    dispose: () => {
      clearPendingAutoStop();
    },
  });
}

export function deactivate() {
  // nothing special — stop handled in dispose
}

interface TaskPromptOptions {
  placeholder?: string;
  excludeTask?: string;
  fallbackValue?: string;
}

async function promptForTask(
  projectPath: string,
  options: TaskPromptOptions = {}
): Promise<string | undefined> {
  if (!tracker) {
    return undefined;
  }

  const data = tracker.getData();
  const projectRecord = data.projects[projectPath];

  type TaskAction = "task" | "new";
  interface TaskQuickPickItem extends vscode.QuickPickItem {
    action: TaskAction;
    task?: string;
  }

  const items: TaskQuickPickItem[] = [];
  const seen = new Set<string>();

  const lastTask = projectRecord?.lastTask;
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
  if (projectRecord?.days) {
    for (const day of Object.values(projectRecord.days)) {
      for (const taskName of Object.keys(day.tasks)) {
        if (!taskName) {
          continue;
        }
        historicalTasks.add(taskName);
      }
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
    placeHolder: options.placeholder ?? "Select task",
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
