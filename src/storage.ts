import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import {
  ActivityLogEntry,
  ActivityLogFile,
  ProjectIndexEntry,
  ProjectSnapshot,
  ProjectsIndexFile,
  TimeTrackerData,
} from "./types";
import { snapshotHasRecords } from "./historyUtils";

const DATA_DIR_NAME = ".vscode";
const DATA_FILE_NAME = "time-tracker.json";
const GLOBAL_FALLBACK_DIR = "time-tracker";
const INDEX_FILE_NAME = "projects_index.json";
const ACTIVITY_LOG_FILE_NAME = "activity_log.json";

const SNAPSHOT_VERSION = 1;
const INDEX_VERSION = 1;
const ACTIVITY_LOG_VERSION = 1;

interface LegacySnapshotMigration {
  projectPath: string;
  snapshot: ProjectSnapshot;
}

export class StorageService {
  private readonly context: vscode.ExtensionContext;
  private readonly projectCache = new Map<string, ProjectSnapshot>();
  private index: ProjectsIndexFile = { version: INDEX_VERSION, projects: [] };
  private activityLog: ActivityLogFile = {
    version: ACTIVITY_LOG_VERSION,
    entries: [],
  };
  private initialized = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.ensureGlobalStorage();
    await this.loadIndex();
    await this.loadActivityLog();
    await this.migrateLegacyStorage();
    this.initialized = true;
  }

  // #region Project snapshots

  async getProjectSnapshot(projectPath: string): Promise<ProjectSnapshot> {
    const normalized = this.normalizePath(projectPath);
    const cached = this.projectCache.get(normalized);
    if (cached) {
      return cached;
    }

    const snapshot = await this.readProjectSnapshot(normalized);
    this.projectCache.set(normalized, snapshot);
    return snapshot;
  }

  async refreshProjectSnapshot(projectPath: string): Promise<ProjectSnapshot> {
    const normalized = this.normalizePath(projectPath);
    const snapshot = await this.readProjectSnapshot(normalized);
    this.projectCache.set(normalized, snapshot);
    return snapshot;
  }

  async saveProjectSnapshot(
    projectPath: string,
    snapshot: ProjectSnapshot
  ): Promise<void> {
    const normalized = this.normalizePath(projectPath);
    const { folder, file } = this.getProjectStoragePaths(normalized);

    // Optimistic locking: check if file was modified since we read it
    const currentOnDisk = await this.readProjectSnapshot(normalized);

    // Always check lastModified timestamps, regardless of cache state
    if (
      snapshot.lastModified !== undefined &&
      currentOnDisk.lastModified !== undefined &&
      currentOnDisk.lastModified !== snapshot.lastModified
    ) {
      // File was modified by another window
      throw new Error(
        "SNAPSHOT_CONFLICT: Another window has modified this project"
      );
    }

    const serializable = {
      ...snapshot,
      version: SNAPSHOT_VERSION,
      lastModified: Date.now(),
    } satisfies ProjectSnapshot;
    const bytes = Buffer.from(JSON.stringify(serializable, null, 2), "utf8");

    await this.ensureFolder(folder);
    await this.atomicWrite(file, bytes);
    this.projectCache.set(normalized, { ...serializable });
  }

  async deleteProjectSnapshot(projectPath: string): Promise<void> {
    const normalized = this.normalizePath(projectPath);
    const { file } = this.getProjectStoragePaths(normalized);
    try {
      await vscode.workspace.fs.delete(file, { recursive: false });
    } catch {
      // ignore missing files
    }
    this.projectCache.delete(normalized);
  }

  async projectHasRecords(projectPath: string): Promise<boolean> {
    const normalized = this.normalizePath(projectPath);
    const { file } = this.getProjectStoragePaths(normalized);
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      return false;
    }

    const snapshot = await this.refreshProjectSnapshot(normalized);
    return snapshotHasRecords(snapshot);
  }

  // #endregion

  // #region Index management

  getProjectsIndex(): ProjectsIndexFile {
    return this.index;
  }

  listProjects(): ProjectIndexEntry[] {
    return [...this.index.projects];
  }

  findProjectByPath(projectPath: string): ProjectIndexEntry | undefined {
    const normalized = this.normalizePath(projectPath);
    return this.index.projects.find((entry) => entry.path === normalized);
  }

  findProjectById(projectId: string): ProjectIndexEntry | undefined {
    return this.index.projects.find((entry) => entry.id === projectId);
  }

  async upsertProjectMetadata(
    projectPath: string,
    displayName?: string
  ): Promise<ProjectIndexEntry> {
    const normalized = this.normalizePath(projectPath);
    let existing = this.findProjectByPath(normalized);
    if (existing) {
      if (displayName && existing.name !== displayName) {
        existing = { ...existing, name: displayName };
        await this.replaceIndexEntry(existing);
      }
      return existing;
    }

    const id = this.computeProjectId(normalized);
    const name = displayName ?? path.basename(normalized) ?? normalized;
    const entry: ProjectIndexEntry = { id, path: normalized, name };
    this.index.projects.push(entry);
    await this.persistIndex();
    return entry;
  }

  async updateProjectName(projectId: string, name: string): Promise<void> {
    const entry = this.findProjectById(projectId);
    if (!entry || entry.name === name) {
      return;
    }
    entry.name = name;
    await this.persistIndex();
  }

  async updateProjectPath(projectId: string, newPath: string): Promise<void> {
    const entry = this.findProjectById(projectId);
    if (!entry) {
      return;
    }
    const normalized = this.normalizePath(newPath);
    entry.path = normalized;
    await this.persistIndex();
  }

  async touchProjectUsage(projectId: string, timestamp: Date): Promise<void> {
    const entry = this.findProjectById(projectId);
    if (!entry) {
      return;
    }
    entry.lastUsed = timestamp.toISOString();
    await this.persistIndex();
  }

  private async replaceIndexEntry(entry: ProjectIndexEntry): Promise<void> {
    const index = this.index.projects.findIndex((e) => e.id === entry.id);
    if (index === -1) {
      this.index.projects.push(entry);
    } else {
      this.index.projects[index] = entry;
    }
    await this.persistIndex();
  }

  // #endregion

  // #region Activity log

  getActivityLog(): ActivityLogFile {
    return this.activityLog;
  }

  async recordActivity(
    projectId: string,
    projectName: string,
    date: string
  ): Promise<void> {
    if (!date) {
      return;
    }
    const normalizedDate = date.slice(0, 10);
    const existing = this.activityLog.entries.find(
      (entry) => entry.date === normalizedDate && entry.projectId === projectId
    );
    if (existing) {
      if (existing.projectName !== projectName) {
        existing.projectName = projectName;
        await this.persistActivityLog();
      }
      return;
    }
    this.activityLog.entries.push({
      date: normalizedDate,
      projectId,
      projectName,
    });
    await this.persistActivityLog();
  }

  getProjectsTouchedBetween(startDate: string, endDate: string): Set<string> {
    const from = startDate.slice(0, 10);
    const to = endDate.slice(0, 10);
    const result = new Set<string>();
    for (const entry of this.activityLog.entries) {
      if (entry.date >= from && entry.date <= to) {
        result.add(entry.projectId);
      }
    }
    return result;
  }

  // #endregion

  // #region Legacy migration

  private async migrateLegacyStorage(): Promise<void> {
    const legacyCandidates: Array<{ uri: vscode.Uri; removeAfter?: boolean }> =
      [];

    const globalFallbackFolder = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      GLOBAL_FALLBACK_DIR
    );
    legacyCandidates.push({
      uri: vscode.Uri.joinPath(globalFallbackFolder, DATA_FILE_NAME),
      removeAfter: true,
    });

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
      legacyCandidates.push({
        uri: vscode.Uri.joinPath(folder.uri, DATA_DIR_NAME, DATA_FILE_NAME),
      });
    }

    for (const candidate of legacyCandidates) {
      let legacy: TimeTrackerData | undefined;
      try {
        const bytes = await vscode.workspace.fs.readFile(candidate.uri);
        const text = Buffer.from(bytes).toString("utf8");
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && parsed.projects) {
          legacy = parsed as TimeTrackerData;
        }
      } catch {
        // ignore missing or unreadable files
        continue;
      }

      if (!legacy) {
        continue;
      }

      const migrations = this.buildLegacyMigrations(legacy);
      for (const migration of migrations) {
        await this.saveProjectSnapshot(
          migration.projectPath,
          migration.snapshot
        );
        const metadata = await this.upsertProjectMetadata(
          migration.projectPath
        );
        await this.ingestActivityFromSnapshot(metadata, migration.snapshot);
      }

      if (candidate.removeAfter) {
        try {
          await vscode.workspace.fs.delete(candidate.uri, { recursive: false });
        } catch {
          // ignore failures
        }
      }

      // Only need to migrate once; data replicated across files.
      break;
    }

    await this.persistIndex();
    await this.persistActivityLog();
  }

  private buildLegacyMigrations(
    legacy: TimeTrackerData
  ): LegacySnapshotMigration[] {
    const result: LegacySnapshotMigration[] = [];
    const entries = Object.entries(legacy.projects ?? {});
    for (const [projectPath, record] of entries) {
      const normalized = this.normalizePath(projectPath);
      const snapshot: ProjectSnapshot = {
        days: record?.days ? { ...record.days } : {},
        lastTask: record?.lastTask,
        current:
          legacy.current && legacy.current.project === projectPath
            ? {
                task: legacy.current.task,
                start: legacy.current.start,
              }
            : null,
        version: SNAPSHOT_VERSION,
      };
      result.push({ projectPath: normalized, snapshot });
    }
    return result;
  }

  private async ingestActivityFromSnapshot(
    entry: ProjectIndexEntry,
    snapshot: ProjectSnapshot
  ): Promise<void> {
    const dates = new Set<string>();
    for (const [day] of Object.entries(snapshot.days ?? {})) {
      dates.add(day.slice(0, 10));
    }
    for (const date of dates) {
      await this.recordActivity(entry.id, entry.name, date);
    }
  }

  // #endregion

  // #region Helpers

  private normalizePath(projectPath: string): string {
    if (!projectPath) {
      return projectPath;
    }
    return path.normalize(projectPath);
  }

  private getProjectStoragePaths(projectPath: string): {
    folder: vscode.Uri;
    file: vscode.Uri;
  } {
    const base = vscode.Uri.file(projectPath);
    const folder = vscode.Uri.joinPath(base, DATA_DIR_NAME);
    const file = vscode.Uri.joinPath(folder, DATA_FILE_NAME);
    return { folder, file };
  }

  private async ensureFolder(folder: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(folder);
    } catch {
      // Ignore inability to create; downstream writes will surface errors.
    }
  }

  private async readProjectSnapshot(
    projectPath: string
  ): Promise<ProjectSnapshot> {
    const { file } = this.getProjectStoragePaths(projectPath);
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && parsed.projects) {
        // Detected a legacy aggregate file; migrate into per-project snapshots.
        const legacy = parsed as TimeTrackerData;
        const migrations = this.buildLegacyMigrations(legacy);
        for (const migration of migrations) {
          const metadata = await this.upsertProjectMetadata(
            migration.projectPath
          );
          await this.saveProjectSnapshot(
            migration.projectPath,
            migration.snapshot
          );
          await this.ingestActivityFromSnapshot(metadata, migration.snapshot);
        }
        return (
          migrations.find((m) => m.projectPath === projectPath)?.snapshot ?? {
            days: {},
          }
        );
      }
      return {
        days: parsed?.days ?? {},
        lastTask: parsed?.lastTask,
        current: parsed?.current ?? null,
        version: parsed?.version ?? SNAPSHOT_VERSION,
        lastModified: parsed?.lastModified ?? 0,
      } satisfies ProjectSnapshot;
    } catch {
      return { days: {}, lastModified: Date.now() };
    }
  }

  private computeProjectId(projectPath: string): string {
    return createHash("sha1").update(projectPath).digest("hex");
  }

  private async atomicWrite(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
    const folder = uri.with({ path: uri.path.replace(/\/?[^\/]+$/, "") });
    await this.ensureFolder(folder);
    const tempUri = uri.with({ path: `${uri.path}.tmp` });
    const backupUri = uri.with({ path: `${uri.path}.bak` });
    try {
      await vscode.workspace.fs.writeFile(tempUri, bytes);
      try {
        await vscode.workspace.fs.stat(uri);
        try {
          await vscode.workspace.fs.copy(uri, backupUri, { overwrite: true });
        } catch {
          // ignore backup failures
        }
      } catch {
        // no existing file
      }
      try {
        await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
      } catch {
        await vscode.workspace.fs.copy(tempUri, uri, { overwrite: true });
        await vscode.workspace.fs.delete(tempUri);
      }
    } catch (err) {
      console.error("Tickeroo: failed to write storage file", err);
      try {
        await vscode.workspace.fs.delete(tempUri);
      } catch {
        // ignore cleanup failures
      }
    }
  }

  private async ensureGlobalStorage(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    } catch {
      // ignore
    }
  }

  private getIndexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, INDEX_FILE_NAME);
  }

  private getActivityLogUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.globalStorageUri,
      ACTIVITY_LOG_FILE_NAME
    );
  }

  private async loadIndex(): Promise<void> {
    const uri = this.getIndexUri();
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text) as ProjectsIndexFile;
      if (parsed?.projects) {
        this.index = parsed;
      }
    } catch {
      this.index = { version: INDEX_VERSION, projects: [] };
    }
  }

  private async loadActivityLog(): Promise<void> {
    const uri = this.getActivityLogUri();
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text) as ActivityLogFile;
      if (parsed?.entries) {
        this.activityLog = parsed;
      }
    } catch {
      this.activityLog = { version: ACTIVITY_LOG_VERSION, entries: [] };
    }
  }

  private async persistIndex(): Promise<void> {
    const uri = this.getIndexUri();
    const serialized = Buffer.from(
      JSON.stringify(
        {
          version: INDEX_VERSION,
          projects: this.index.projects,
        } satisfies ProjectsIndexFile,
        null,
        2
      ),
      "utf8"
    );
    await this.atomicWrite(uri, serialized);
  }

  private async persistActivityLog(): Promise<void> {
    const uri = this.getActivityLogUri();
    const serialized = Buffer.from(
      JSON.stringify(
        {
          version: ACTIVITY_LOG_VERSION,
          entries: this.activityLog.entries,
        } satisfies ActivityLogFile,
        null,
        2
      ),
      "utf8"
    );
    await this.atomicWrite(uri, serialized);
  }

  // #endregion
}
