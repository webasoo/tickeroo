import * as path from "path";
import * as vscode from "vscode";
import {
  ActiveProjectSession,
  ProjectIndexEntry,
  ProjectSnapshot,
} from "./types";
import { StorageService } from "./storage";
import { snapshotHasRecords } from "./historyUtils";

const LAST_PROJECT_KEY = "timeTracker.lastProjectId";
const LAST_ACTIVITY_KEY = "timeTracker.lastActivity";

export class Tracker {
  private readonly context: vscode.ExtensionContext;
  private readonly storage: StorageService;
  private readonly projectSnapshots = new Map<string, ProjectSnapshot>();
  private readonly projectIndex = new Map<string, ProjectIndexEntry>();
  private timerInterval: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private readonly idleThreshold = 5 * 60 * 1000; // 5 minutes
  private lastPersistedActivity = 0;
  private initialized = false;

  private activeSession: ActiveProjectSession | null = null;
  private lastProjectId: string | null = null;
  private workspaceHasHistory = false;

  constructor(context: vscode.ExtensionContext, storage: StorageService) {
    this.context = context;
    this.storage = storage;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.storage.init();
    await this.refreshIndex();

    const lastProjectId =
      this.context.globalState.get<string>(LAST_PROJECT_KEY) ?? null;
    if (lastProjectId) {
      this.lastProjectId = lastProjectId;
    }

    const lastActivityMs =
      this.context.globalState.get<number>(LAST_ACTIVITY_KEY) ?? undefined;
    if (lastActivityMs) {
      this.lastPersistedActivity = lastActivityMs;
    }

    await this.loadSnapshots();

    if (this.activeSession && lastActivityMs) {
      const currentStart = new Date(this.activeSession.start).getTime();
      const nowMs = Date.now();
      const candidate = Math.max(
        currentStart,
        Math.min(lastActivityMs ?? nowMs, nowMs)
      );
      await this.stop(new Date(candidate));
    }

    this.startTicker();
    this.initialized = true;
  }

  private startTicker() {
    if (this.timerInterval) {
      return;
    }
    this.timerInterval = setInterval(() => this.onTick(), 1000);
  }

  private stopTicker() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval as any);
      this.timerInterval = null;
    }
  }

  private onTick() {
    if (!this.activeSession) {
      return;
    }
    const now = Date.now();
    if (now - this.lastTick > this.idleThreshold) {
      return;
    }
    this.lastTick = now;
    this.persistLastActivity(now);
  }

  touchActivity() {
    this.lastTick = Date.now();
    this.persistLastActivity(this.lastTick);
  }

  getActiveSession(): ActiveProjectSession | null {
    return this.activeSession;
  }

  listProjects() {
    return Array.from(this.projectIndex.values()).map((entry) => ({
      ...entry,
    }));
  }

  getProjectEntry(projectId: string): ProjectIndexEntry | undefined {
    const entry = this.projectIndex.get(projectId);
    return entry ? { ...entry } : undefined;
  }

  getMostRecentProjectEntry(): ProjectIndexEntry | undefined {
    if (this.activeSession) {
      const active = this.projectIndex.get(this.activeSession.projectId);
      return active ? { ...active } : undefined;
    }
    if (this.lastProjectId) {
      const last = this.projectIndex.get(this.lastProjectId);
      if (last) {
        return { ...last };
      }
    }
    let candidate: ProjectIndexEntry | undefined;
    let latestTs = -Infinity;
    for (const entry of this.projectIndex.values()) {
      if (!entry.lastUsed) {
        continue;
      }
      const ts = Date.parse(entry.lastUsed);
      if (!Number.isNaN(ts) && ts > latestTs) {
        candidate = entry;
        latestTs = ts;
      }
    }
    if (candidate) {
      return { ...candidate };
    }
    // Fallback: return the first known project, if any.
    const first = this.projectIndex.values().next();
    if (!first.done) {
      return { ...first.value };
    }
    return undefined;
  }

  getCachedSnapshot(projectId: string): ProjectSnapshot | undefined {
    const snapshot = this.projectSnapshots.get(projectId);
    if (!snapshot) {
      return undefined;
    }
    return snapshot;
  }

  hasTrackedHistory(): boolean {
    for (const snapshot of this.projectSnapshots.values()) {
      if (snapshotHasRecords(snapshot)) {
        return true;
      }
    }
    return false;
  }

  setWorkspaceHasTrackedHistory(value: boolean): void {
    this.workspaceHasHistory = value;
  }

  shouldFlashWhenIdle(): boolean {
    return this.workspaceHasHistory;
  }

  async getProjectSnapshotById(projectId: string): Promise<ProjectSnapshot> {
    const entry = this.projectIndex.get(projectId);
    if (!entry) {
      throw new Error(`Unknown project id: ${projectId}`);
    }
    const cached = this.projectSnapshots.get(projectId);
    if (cached) {
      return cached;
    }
    const snapshot = await this.storage.getProjectSnapshot(entry.path);
    this.projectSnapshots.set(projectId, snapshot);
    return snapshot;
  }

  async getProjectSnapshotByPath(projectPath: string): Promise<ProjectSnapshot> {
    const entry = await this.ensureProjectEntry(projectPath);
    return this.getProjectSnapshotById(entry.id);
  }

  async start(
    projectPath: string,
    task: string,
    options?: { startTime?: Date; silent?: boolean }
  ) {
    if (this.activeSession) {
      await this.stop();
    }
    const startTime = options?.startTime ?? new Date();
    const entry = await this.ensureProjectEntry(projectPath);
    const snapshot = await this.getProjectSnapshotById(entry.id);

    snapshot.current = {
      task,
      start: startTime.toISOString(),
    };
    snapshot.lastTask = task;

    await this.storage.saveProjectSnapshot(entry.path, snapshot);
    this.projectSnapshots.set(entry.id, { ...snapshot });

    this.activeSession = {
      projectId: entry.id,
      projectName: entry.name,
      projectPath: entry.path,
      task,
      start: snapshot.current.start,
    };

    await this.persistLastProject(entry.id);
    this.lastTick = startTime.getTime();
    this.persistLastActivity(this.lastTick);
    await this.storage.touchProjectUsage(entry.id, startTime);
    entry.lastUsed = startTime.toISOString();
    this.projectIndex.set(entry.id, { ...entry });
    await this.storage.recordActivity(
      entry.id,
      entry.name,
      startTime.toISOString()
    );

    console.log(`Tickeroo: started timer for ${entry.name} / ${task}`);
    if (!options?.silent) {
      void vscode.window.showInformationMessage(
        `Tickeroo: started '${task}' on ${entry.name}`
      );
    }
  }

  async stop(at?: Date) {
    if (!this.activeSession) {
      return;
    }

    const session = this.activeSession;
    const entry = this.projectIndex.get(session.projectId);
    if (!entry) {
      this.activeSession = null;
      return;
    }

    const snapshot = await this.getProjectSnapshotById(entry.id);
    const current = snapshot.current;
    if (!current) {
      this.activeSession = null;
      return;
    }

    const stopTime = at ? new Date(at) : new Date();
    const start = new Date(current.start);
    const effectiveStop =
      stopTime.getTime() < start.getTime() ? start : stopTime;
    const seconds = Math.max(
      0,
      Math.round((effectiveStop.getTime() - start.getTime()) / 1000)
    );
    const day = effectiveStop.toISOString().slice(0, 10);

    if (!snapshot.days[day]) {
      snapshot.days[day] = { totalSeconds: 0, tasks: {} };
    }
    const dayRec = snapshot.days[day];
    dayRec.totalSeconds += seconds;
    dayRec.tasks[current.task] = (dayRec.tasks[current.task] || 0) + seconds;
    if (!dayRec.entries) {
      dayRec.entries = [];
    }
    dayRec.entries.push({
      task: current.task,
      start: current.start,
      end: effectiveStop.toISOString(),
      seconds,
    });

    snapshot.lastTask = current.task;
    snapshot.current = null;

    await this.storage.saveProjectSnapshot(entry.path, snapshot);
    this.projectSnapshots.set(entry.id, { ...snapshot });

    this.activeSession = null;
    this.lastTick = effectiveStop.getTime();
    this.persistLastActivity(this.lastTick);
    await this.persistLastProject(entry.id);
    await this.storage.touchProjectUsage(entry.id, effectiveStop);
    entry.lastUsed = effectiveStop.toISOString();
    this.projectIndex.set(entry.id, { ...entry });
    await this.storage.recordActivity(entry.id, entry.name, day);
  }

  async switchTask(task: string) {
    const session = this.activeSession;
    if (!session) {
      return;
    }
    const entry = this.projectIndex.get(session.projectId);
    if (!entry) {
      return;
    }
    const now = new Date();
    await this.stop(now);
    await this.start(entry.path, task, { startTime: now, silent: true });
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    await this.storage.updateProjectName(projectId, trimmed);
    await this.refreshIndex();
  }

  async updateProjectPath(projectId: string, newPath: string): Promise<void> {
    await this.storage.updateProjectPath(projectId, newPath);
    await this.refreshIndex();
    this.projectSnapshots.delete(projectId);
  }

  async dispose(): Promise<void> {
    this.stopTicker();
    await this.stop();
  }

  private async ensureProjectEntry(
    projectPath: string
  ): Promise<ProjectIndexEntry> {
    const normalized = path.normalize(projectPath);
    const existing = this.storage.findProjectByPath(normalized);
    if (existing) {
      const clone = { ...existing };
      this.projectIndex.set(existing.id, clone);
      return clone;
    }

    const defaultName = path.basename(normalized) || normalized;
    const name = await this.promptForProjectName(defaultName);
    const entry = await this.storage.upsertProjectMetadata(normalized, name);
    const clone = { ...entry };
    this.projectIndex.set(entry.id, clone);
    return clone;
  }

  private async promptForProjectName(defaultName: string): Promise<string> {
    const input = await vscode.window.showInputBox({
      prompt: "Display name for project",
      value: defaultName,
      ignoreFocusOut: true,
    });
    const trimmed = input?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : defaultName;
  }

  private async persistLastProject(projectId: string) {
    this.lastProjectId = projectId;
    try {
      await this.context.globalState.update(LAST_PROJECT_KEY, projectId);
    } catch {
      // ignore persistence errors
    }
  }

  private persistLastActivity(timestamp: number) {
    if (timestamp <= 0) {
      return;
    }
    if (timestamp - this.lastPersistedActivity < 1000) {
      this.lastPersistedActivity = timestamp;
      return;
    }
    this.lastPersistedActivity = timestamp;
    void this.context.globalState.update(LAST_ACTIVITY_KEY, timestamp);
  }

  private async refreshIndex(): Promise<void> {
    const index = this.storage.listProjects();
    this.projectIndex.clear();
    for (const entry of index) {
      this.projectIndex.set(entry.id, { ...entry });
    }
  }

  private async loadSnapshots(): Promise<void> {
    this.projectSnapshots.clear();
    let active: ActiveProjectSession | null = null;
    for (const entry of this.projectIndex.values()) {
      const snapshot = await this.storage.getProjectSnapshot(entry.path);
      this.projectSnapshots.set(entry.id, snapshot);
      if (snapshot.current) {
        if (!active) {
          active = {
            projectId: entry.id,
            projectName: entry.name,
            projectPath: entry.path,
            task: snapshot.current.task,
            start: snapshot.current.start,
          };
        } else {
          // If we detect multiple active sessions, prefer the most recent start.
          const existingStart = new Date(active.start).getTime();
          const candidateStart = new Date(snapshot.current.start).getTime();
          if (candidateStart > existingStart) {
            active = {
              projectId: entry.id,
              projectName: entry.name,
              projectPath: entry.path,
              task: snapshot.current.task,
              start: snapshot.current.start,
            };
          }
        }
      }
    }
    this.activeSession = active;
  }
}
