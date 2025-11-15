import * as path from "path";
import * as vscode from "vscode";
import {
  ActiveProjectSession,
  DayRecord,
  ProjectIndexEntry,
  ProjectSnapshot,
  SessionEntry,
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

  // Formats a Date into local YYYY-MM-DD (avoids UTC drift in reports)
  private formatLocalDay(date: Date): string {
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, "0");
    const d = `${date.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${d}`;
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

  async shouldFlashWhenIdle(): Promise<boolean> {
    // Check if any workspace folders have actual records on disk
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) {
      return false;
    }

    for (const folder of folders) {
      try {
        const hasRecords = await this.storage.projectHasRecords(
          folder.uri.fsPath
        );
        if (hasRecords) {
          return true;
        }
      } catch {
        // ignore errors for individual folders
      }
    }
    return false;
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

  async getProjectSnapshotByPath(
    projectPath: string
  ): Promise<ProjectSnapshot> {
    const entry = await this.ensureProjectEntry(projectPath);
    return this.getProjectSnapshotById(entry.id);
  }

  async start(
    projectPath: string,
    task: string,
    options?: { startTime?: Date; silent?: boolean }
  ) {
    const startTime = options?.startTime ?? new Date();
    const entry = await this.ensureProjectEntry(projectPath);
    let snapshot = await this.loadLatestSnapshot(entry);

    // Check this specific project for running timer FIRST
    if (snapshot.current) {
      void vscode.window.showWarningMessage(
        `Tickeroo: timer '${snapshot.current.task}' is already running for ${entry.name}. Stop it before starting another timer.`
      );
      return;
    }

    // If there's an active session in this window, stop it
    if (this.activeSession) {
      await this.stop();
    }

    // Now resolve any pending entries
    const clearedSnapshot = await this.ensurePendingEntriesResolved(
      entry,
      snapshot
    );
    if (!clearedSnapshot) {
      return;
    }
    snapshot = clearedSnapshot;

    // Check again after resolving pending entries (in case another window started a timer)
    if (snapshot.current) {
      void vscode.window.showWarningMessage(
        `Tickeroo: timer '${snapshot.current.task}' is already running for ${entry.name}. Stop it before starting another timer.`
      );
      return;
    }
    const startIso = startTime.toISOString();
    const entryDay = this.formatLocalDay(startTime);
    const dayRecord = this.ensureDayRecord(snapshot, entryDay);
    this.ensurePendingEntry(dayRecord, task, startIso);

    snapshot.current = {
      task,
      start: startIso,
      entryDay,
    };
    snapshot.lastTask = task;

    try {
      await this.storage.saveProjectSnapshot(entry.path, snapshot);
    } catch (err: any) {
      if (err?.message?.includes("SNAPSHOT_CONFLICT")) {
        // Another window modified the snapshot; refresh and check again
        const refreshedSnapshot = await this.loadLatestSnapshot(entry);
        if (refreshedSnapshot.current) {
          void vscode.window.showWarningMessage(
            `Tickeroo: timer '${refreshedSnapshot.current.task}' is already running for ${entry.name} (started in another window). Stop it before starting another timer.`
          );
          return;
        }
        // If no conflict now, user can try again
        void vscode.window.showWarningMessage(
          `Tickeroo: Another window modified the timer. Please try starting again.`
        );
        return;
      }
      // Re-throw unexpected errors
      throw err;
    }

    // Verify that the provisional entry actually persisted to disk before declaring start
    try {
      const verify = await this.storage.refreshProjectSnapshot(entry.path);
      const vDay = verify.days[entryDay];
      const hasEntry = !!vDay?.entries?.some((e) => e.start === startIso);
      const currentOk =
        verify.current?.start === startIso && verify.current?.task === task;
      if (!hasEntry || !currentOk) {
        console.error(
          "Tickeroo: start verification failed; entry not found on disk"
        );
        void vscode.window.showErrorMessage(
          "Tickeroo: Failed to persist start entry. Please try starting again."
        );
        return;
      }
    } catch (e) {
      console.error("Tickeroo: verification read failed", e);
      void vscode.window.showErrorMessage(
        "Tickeroo: Could not verify timer start. Please try again."
      );
      return;
    }

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
    // Record activity for the local day
    await this.storage.recordActivity(entry.id, this.formatLocalDay(startTime));

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

    await this.stopTimerForEntry(entry, at);
  }

  private async stopTimerForEntry(entry: ProjectIndexEntry, at?: Date) {
    const snapshot = await this.loadLatestSnapshot(entry);
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
    const stopDay = this.formatLocalDay(effectiveStop);
    const preferredDay = current.entryDay ?? this.formatLocalDay(start);

    let entryInfo =
      this.findSessionEntry(snapshot, preferredDay, current.start) ??
      this.findSessionEntry(snapshot, stopDay, current.start) ??
      this.findSessionEntryAnywhere(snapshot, current.start);

    if (!entryInfo) {
      const fallbackRecord = this.ensureDayRecord(snapshot, stopDay);
      fallbackRecord.entries!.push({
        task: current.task,
        start: current.start,
        seconds: 0,
      });
      entryInfo = {
        day: stopDay,
        index: fallbackRecord.entries!.length - 1,
        entry: fallbackRecord.entries![fallbackRecord.entries!.length - 1],
      };
    }

    // If the session crosses a local day boundary, split it between days
    if (entryInfo.day !== stopDay) {
      // Compute boundary at local midnight of stop day
      const boundary = new Date(effectiveStop);
      boundary.setHours(0, 0, 0, 0);

      // First segment: from start -> boundary
      const firstSeconds = Math.max(
        0,
        Math.round((boundary.getTime() - start.getTime()) / 1000)
      );
      const firstDayRecord = this.ensureDayRecord(snapshot, entryInfo.day);
      entryInfo.entry.task = current.task;
      entryInfo.entry.start = current.start;
      entryInfo.entry.end = boundary.toISOString();
      entryInfo.entry.seconds = firstSeconds;
      firstDayRecord.totalSeconds += firstSeconds;
      firstDayRecord.tasks[current.task] =
        (firstDayRecord.tasks[current.task] || 0) + firstSeconds;

      // Second segment: from boundary -> stop
      const secondSeconds = Math.max(
        0,
        Math.round((effectiveStop.getTime() - boundary.getTime()) / 1000)
      );
      const secondDayRecord = this.ensureDayRecord(snapshot, stopDay);
      secondDayRecord.entries = secondDayRecord.entries || [];
      secondDayRecord.entries.push({
        task: current.task,
        start: boundary.toISOString(),
        end: effectiveStop.toISOString(),
        seconds: secondSeconds,
      });
      secondDayRecord.totalSeconds += secondSeconds;
      secondDayRecord.tasks[current.task] =
        (secondDayRecord.tasks[current.task] || 0) + secondSeconds;
    } else {
      // Single-day session
      const targetDayRecord = this.ensureDayRecord(snapshot, entryInfo.day);
      entryInfo.entry.task = current.task;
      entryInfo.entry.start = current.start;
      entryInfo.entry.end = effectiveStop.toISOString();
      entryInfo.entry.seconds = seconds;
      targetDayRecord.totalSeconds += seconds;
      targetDayRecord.tasks[current.task] =
        (targetDayRecord.tasks[current.task] || 0) + seconds;
    }

    snapshot.lastTask = current.task;
    snapshot.current = null;

    try {
      await this.storage.saveProjectSnapshot(entry.path, snapshot);
      this.projectSnapshots.set(entry.id, { ...snapshot });
    } catch (err: any) {
      if (err?.message?.includes("SNAPSHOT_CONFLICT")) {
        // Another window modified the snapshot; refresh and retry
        console.warn(
          `Tickeroo: Conflict detected while stopping timer for ${entry.name}, retrying...`
        );
        const refreshedSnapshot = await this.loadLatestSnapshot(entry);

        // Check if timer is still running
        if (
          !refreshedSnapshot.current ||
          refreshedSnapshot.current.start !== current.start
        ) {
          // Timer was already stopped by another window
          console.log(`Tickeroo: Timer was already stopped by another window`);
          this.activeSession = null;
          return;
        }

        // Retry the stop operation with refreshed snapshot
        await this.stopTimerForEntry(entry, at);
        return;
      }
      // Re-throw unexpected errors
      throw err;
    }

    this.activeSession = null;
    this.lastTick = effectiveStop.getTime();
    this.persistLastActivity(this.lastTick);
    await this.persistLastProject(entry.id);
    await this.storage.touchProjectUsage(entry.id, effectiveStop);
    entry.lastUsed = effectiveStop.toISOString();
    this.projectIndex.set(entry.id, { ...entry });
    // Record activity for local day(s)
    await this.storage.recordActivity(entry.id, stopDay);
    const startDay = preferredDay;
    if (startDay !== stopDay) {
      await this.storage.recordActivity(entry.id, startDay);
    }
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

    try {
      await this.stop(now);
      await this.start(entry.path, task, { startTime: now, silent: true });
      void vscode.window.showInformationMessage(
        `Tickeroo: switched to '${task}' on ${entry.name}`
      );
    } catch (err: any) {
      console.error(`Tickeroo: Failed to switch task: ${err?.message}`);
      void vscode.window.showErrorMessage(
        `Tickeroo: Failed to switch task. Please try again.`
      );
    }
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

  private async loadLatestSnapshot(
    entry: ProjectIndexEntry
  ): Promise<ProjectSnapshot> {
    const snapshot = await this.storage.refreshProjectSnapshot(entry.path);
    this.projectSnapshots.set(entry.id, snapshot);
    return snapshot;
  }

  private ensureDayRecord(snapshot: ProjectSnapshot, day: string): DayRecord {
    let record = snapshot.days[day];
    if (!record) {
      record = { totalSeconds: 0, tasks: {}, entries: [] };
      snapshot.days[day] = record;
      return record;
    }
    if (!record.entries) {
      record.entries = [];
    }
    return record;
  }

  private ensurePendingEntry(
    dayRecord: DayRecord,
    task: string,
    startIso: string
  ): SessionEntry {
    let entry =
      dayRecord.entries?.find((candidate) => candidate.start === startIso) ??
      null;
    if (entry) {
      entry.task = task;
      entry.seconds = entry.seconds ?? 0;
      if (entry.end) {
        delete entry.end;
      }
      return entry;
    }
    entry = {
      task,
      start: startIso,
      seconds: 0,
    };
    dayRecord.entries!.push(entry);
    return entry;
  }

  private findSessionEntry(
    snapshot: ProjectSnapshot,
    day: string | undefined,
    startIso: string
  ): { day: string; index: number; entry: SessionEntry } | null {
    if (!day) {
      return null;
    }
    const record = snapshot.days[day];
    const entries = record?.entries;
    if (!entries || entries.length === 0) {
      return null;
    }
    const index = entries.findIndex((entry) => entry.start === startIso);
    if (index === -1) {
      return null;
    }
    return { day, index, entry: entries[index] };
  }

  private findSessionEntryAnywhere(
    snapshot: ProjectSnapshot,
    startIso: string
  ): { day: string; index: number; entry: SessionEntry } | null {
    for (const [day, record] of Object.entries(snapshot.days ?? {})) {
      const entries = record.entries;
      if (!entries || entries.length === 0) {
        continue;
      }
      const index = entries.findIndex((entry) => entry.start === startIso);
      if (index !== -1) {
        return { day, index, entry: entries[index] };
      }
    }
    return null;
  }

  private findFirstIncompleteEntry(snapshot: ProjectSnapshot): {
    day: string;
    index: number;
    entry: SessionEntry;
    record: DayRecord;
  } | null {
    for (const [day, record] of Object.entries(snapshot.days ?? {})) {
      const entries = record.entries;
      if (!entries || entries.length === 0) {
        continue;
      }
      const index = entries.findIndex((entry) => !entry.end);
      if (index !== -1) {
        return { day, index, entry: entries[index], record };
      }
    }
    return null;
  }

  private async ensurePendingEntriesResolved(
    entry: ProjectIndexEntry,
    snapshot: ProjectSnapshot
  ): Promise<ProjectSnapshot | null> {
    let currentSnapshot = snapshot;
    while (true) {
      const pending = this.findFirstIncompleteEntry(currentSnapshot);
      if (!pending) {
        return currentSnapshot;
      }
      const choice = await vscode.window.showWarningMessage(
        `Project ${entry.name} has an incomplete record (${pending.day}). Please set the end time before starting a new timer.`,
        { modal: true },
        "Set End Time",
        "Cancel"
      );
      if (choice !== "Set End Time") {
        return null;
      }
      const completed = await this.promptForManualEndTime(
        entry,
        currentSnapshot,
        pending
      );
      if (!completed) {
        return null;
      }

      try {
        await this.storage.saveProjectSnapshot(entry.path, currentSnapshot);
        this.projectSnapshots.set(entry.id, { ...currentSnapshot });
        await this.storage.recordActivity(entry.id, pending.day);
      } catch (err: any) {
        if (err?.message?.includes("SNAPSHOT_CONFLICT")) {
          // Another window modified the snapshot; refresh and restart the resolution process
          console.warn(
            `Tickeroo: Conflict detected while resolving pending entry for ${entry.name}, restarting resolution...`
          );
          currentSnapshot = await this.loadLatestSnapshot(entry);
          // Continue the loop to check for pending entries again
          continue;
        }
        // Re-throw unexpected errors
        throw err;
      }
    }
  }

  private async promptForManualEndTime(
    projectEntry: ProjectIndexEntry,
    snapshot: ProjectSnapshot,
    pending: {
      day: string;
      index: number;
      entry: SessionEntry;
      record: DayRecord;
    }
  ): Promise<boolean> {
    const startDate = new Date(pending.entry.start);
    const placeholder = `${startDate
      .getHours()
      .toString()
      .padStart(2, "0")}:${startDate.getMinutes().toString().padStart(2, "0")}`;
    const input = await vscode.window.showInputBox({
      prompt: `Enter end time for '${pending.entry.task}' in ${projectEntry.name} (${pending.day}) - format: HH:MM`,
      placeHolder: placeholder,
      ignoreFocusOut: true,
      validateInput: (value) => this.validateEndTimeInput(value, startDate),
    });
    if (!input) {
      return false;
    }
    const endDate = this.buildEndDateFromInput(input, startDate);
    if (!endDate) {
      await vscode.window.showErrorMessage("Invalid time format.");
      return false;
    }
    this.finalizeManualEntry(pending.record, pending.entry, endDate);
    void vscode.window.showInformationMessage(
      `End time for '${pending.entry.task}' has been recorded.`
    );
    return true;
  }

  private validateEndTimeInput(value: string, start: Date): string | undefined {
    if (!/^\d{1,2}:\d{2}$/.test(value.trim())) {
      return "Format must be HH:MM";
    }
    const endDate = this.buildEndDateFromInput(value, start);
    if (!endDate) {
      return "Invalid format";
    }
    if (endDate.getTime() < start.getTime()) {
      return "End time cannot be before start time";
    }
    return undefined;
  }

  private buildEndDateFromInput(value: string, baseDate: Date): Date | null {
    const trimmed = value.trim();
    const [hStr, mStr] = trimmed.split(":");
    const hours = Number(hStr);
    const minutes = Number(mStr);
    if (
      Number.isNaN(hours) ||
      Number.isNaN(minutes) ||
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      return null;
    }
    const result = new Date(baseDate);
    result.setHours(hours, minutes, 0, 0);
    return result;
  }

  private finalizeManualEntry(
    dayRecord: DayRecord,
    sessionEntry: SessionEntry,
    endDate: Date
  ) {
    const startDate = new Date(sessionEntry.start);
    const seconds = Math.max(
      0,
      Math.round((endDate.getTime() - startDate.getTime()) / 1000)
    );
    sessionEntry.end = endDate.toISOString();
    sessionEntry.seconds = seconds;
    dayRecord.totalSeconds += seconds;
    dayRecord.tasks[sessionEntry.task] =
      (dayRecord.tasks[sessionEntry.task] || 0) + seconds;
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
    let multipleActiveSessions = 0;

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
          multipleActiveSessions++;
          console.warn(
            `Tickeroo: Multiple active sessions detected! Found timer in ${entry.name} (task: ${snapshot.current.task})`
          );
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

    if (multipleActiveSessions > 0) {
      console.warn(
        `Tickeroo: ${
          multipleActiveSessions + 1
        } active timers detected across projects. Using most recent: ${
          active?.projectName
        } / ${active?.task}`
      );
    }

    this.activeSession = active;
  }
}
