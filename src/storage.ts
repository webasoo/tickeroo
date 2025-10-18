import * as vscode from "vscode";
import { TimeTrackerData } from "./types";

const DATA_DIR_NAME = ".vscode";
const DATA_FILE_NAME = "time-tracker.json";
const GLOBAL_FALLBACK_DIR = "time-tracker";

export async function readData(
  context: vscode.ExtensionContext,
  projectPathHint?: string
): Promise<TimeTrackerData> {
  const { file } = getStoragePaths(context, projectPathHint);
  try {
    const bytes = await vscode.workspace.fs.readFile(file);
    const text = Buffer.from(bytes).toString("utf8");
    try {
      return JSON.parse(text) as TimeTrackerData;
    } catch (err) {
      // If the main file is corrupted, attempt to read a backup .bak file
      try {
        const bakFile = vscode.Uri.joinPath(
          getStoragePaths(context, projectPathHint).folder,
          DATA_FILE_NAME + ".bak"
        );
        const bakBytes = await vscode.workspace.fs.readFile(bakFile);
        const bakText = Buffer.from(bakBytes).toString("utf8");
        const bakData = JSON.parse(bakText) as TimeTrackerData;
        console.warn(
          "time-tracker: main data corrupted, recovered from backup"
        );
        return bakData;
      } catch (e) {
        console.error(
          "time-tracker: failed to parse data and no valid backup found",
          e
        );
        return { projects: {} } as TimeTrackerData;
      }
    }
  } catch (err) {
    return { projects: {} } as TimeTrackerData;
  }
}

export async function writeData(
  context: vscode.ExtensionContext,
  data: TimeTrackerData,
  projectPathHint?: string
): Promise<void> {
  const { file, folder } = getStoragePaths(context, projectPathHint);
  const text = JSON.stringify(data, null, 2);
  const bytes = Buffer.from(text, "utf8");
  try {
    await ensureFolder(folder);
    // Use atomic write: write to a temp file then rename. Also keep a .bak copy.
    const tempFile = vscode.Uri.joinPath(folder, DATA_FILE_NAME + ".tmp");
    const bakFile = vscode.Uri.joinPath(folder, DATA_FILE_NAME + ".bak");
    try {
      // If existing file present, write a backup first.
      await vscode.workspace.fs.stat(file);
      try {
        await vscode.workspace.fs.copy(file, bakFile, { overwrite: true });
      } catch {
        // ignore backup failures
      }
    } catch {
      // file doesn't exist yet
    }
    await vscode.workspace.fs.writeFile(tempFile, bytes);
    // rename (copy+delete) to replace original. Some environments may not support native rename.
    try {
      await vscode.workspace.fs.rename(tempFile, file, { overwrite: true });
    } catch {
      // fallback: copy then delete
      try {
        await vscode.workspace.fs.copy(tempFile, file, { overwrite: true });
        await vscode.workspace.fs.delete(tempFile);
      } catch (e) {
        console.error(
          "Failed to finalize atomic write for time-tracker data",
          e
        );
      }
    }
  } catch (err) {
    console.error("Failed to write time-tracker data", err);
  }
}

function getStoragePaths(
  context: vscode.ExtensionContext,
  projectPathHint?: string
): { file: vscode.Uri; folder: vscode.Uri } {
  if (projectPathHint) {
    const base = vscode.Uri.file(projectPathHint);
    const folder = vscode.Uri.joinPath(base, DATA_DIR_NAME);
    const file = vscode.Uri.joinPath(folder, DATA_FILE_NAME);
    return { file, folder };
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const base = workspaceFolders[0].uri;
    const folder = vscode.Uri.joinPath(base, DATA_DIR_NAME);
    const file = vscode.Uri.joinPath(folder, DATA_FILE_NAME);
    return { file, folder };
  }

  const folder = vscode.Uri.joinPath(
    context.globalStorageUri,
    GLOBAL_FALLBACK_DIR
  );
  const file = vscode.Uri.joinPath(folder, DATA_FILE_NAME);
  return { file, folder };
}

async function ensureFolder(folder: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(folder);
  } catch {
    // ignore
  }
}
