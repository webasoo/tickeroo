import * as vscode from "vscode";
import { TimeTrackerData } from "./types";
import { readData, writeData } from "./storage";

const LAST_PROJECT_KEY = "timeTracker.lastProjectPath";
const LAST_ACTIVITY_KEY = "timeTracker.lastActivity";

export class Tracker {
  private context: vscode.ExtensionContext;
  private data: TimeTrackerData = { projects: {} };
  private timerInterval: NodeJS.Timeout | null = null;
  private lastTick: number = Date.now();
  private idleThreshold = 5 * 60 * 1000; // 5 minutes
  private lastProjectPath: string | null = null;
  private lastPersistedActivity = 0;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async init() {
    const storedProject =
      this.context.globalState.get<string>(LAST_PROJECT_KEY) ?? undefined;
    const lastActivityMs =
      this.context.globalState.get<number>(LAST_ACTIVITY_KEY) ?? undefined;
    if (lastActivityMs) {
      this.lastPersistedActivity = lastActivityMs;
    }
    this.data = await readData(this.context, storedProject);
    if (this.data.current) {
      const currentStart = new Date(this.data.current.start).getTime();
      const nowMs = Date.now();
      const candidate = Math.max(
        currentStart,
        Math.min(lastActivityMs ?? nowMs, nowMs)
      );
      await this.stop(new Date(candidate));
    }
    this.startTicker();
    if (this.data.current) {
      await this.persistLastProject(this.data.current.project);
    } else if (this.lastProjectPath) {
      // already persisted during stop; nothing to do
    } else if (storedProject) {
      this.lastProjectPath = storedProject;
    } else {
      const projects = Object.keys(this.data.projects || {});
      if (projects.length > 0) {
        await this.persistLastProject(projects[0]);
      }
    }
  }

  private startTicker() {
    if (this.timerInterval) return;
    this.timerInterval = setInterval(() => this.onTick(), 1000);
  }

  private stopTicker() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval as any);
      this.timerInterval = null;
    }
  }

  private onTick() {
    const now = Date.now();
    if (now - this.lastTick > this.idleThreshold) {
      // consider idle; do not accumulate
      return;
    }
    this.lastTick = now;
    this.persistLastActivity(now);
  }

  touchActivity() {
    this.lastTick = Date.now();
    this.persistLastActivity(this.lastTick);
  }

  private ensureProjectRecord(projectPath: string) {
    if (!this.data.projects[projectPath]) {
      this.data.projects[projectPath] = { days: {} };
    }
    this.lastProjectPath = projectPath;
    return this.data.projects[projectPath];
  }

  private async persistLastProject(projectPath: string) {
    this.lastProjectPath = projectPath;
    try {
      await this.context.globalState.update(LAST_PROJECT_KEY, projectPath);
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

  async start(
    project: string,
    task: string,
    options?: { startTime?: Date; silent?: boolean }
  ) {
    const startTime = options?.startTime ?? new Date();
    this.data.current = {
      project,
      task,
      start: startTime.toISOString(),
    };
    const projectRecord = this.ensureProjectRecord(project);
    projectRecord.lastTask = task;
    await this.persistLastProject(project);
    this.lastTick = startTime.getTime();
    this.persistLastActivity(this.lastTick);
    await writeData(this.context, this.data, project);
    console.log(
      `Local Project Time Tracker: started timer for ${project} / ${task}`
    );
    if (!options?.silent) {
      try {
        vscode.window.showInformationMessage(
          `Time Tracker: started '${task}' on ${
            project.split("/").pop() || project
          }`
        );
      } catch (e) {
        // ignore if UI not available
      }
    }
  }

  async stop(at?: Date) {
    if (!this.data.current) return;
    const stopTime = at ? new Date(at) : new Date();
    const start = new Date(this.data.current.start);
    const effectiveStop =
      stopTime.getTime() < start.getTime() ? start : stopTime;
    const seconds = Math.max(
      0,
      Math.round((effectiveStop.getTime() - start.getTime()) / 1000)
    );
    const day = effectiveStop.toISOString().slice(0, 10);
    const projectPath = this.data.current.project;
    const project = this.ensureProjectRecord(projectPath);
    if (!project.days[day]) {
      project.days[day] = { totalSeconds: 0, tasks: {} };
    }
    const dayRec = project.days[day];
    dayRec.totalSeconds += seconds;
    dayRec.tasks[this.data.current.task] =
      (dayRec.tasks[this.data.current.task] || 0) + seconds;
    if (!dayRec.entries) {
      dayRec.entries = [];
    }
    dayRec.entries.push({
      task: this.data.current.task,
      start: this.data.current.start,
      end: effectiveStop.toISOString(),
      seconds,
    });
    project.lastTask = this.data.current.task;
    this.data.current = null;
    this.lastTick = effectiveStop.getTime();
    this.persistLastActivity(this.lastTick);
    await this.persistLastProject(projectPath);
    await writeData(this.context, this.data, projectPath);
  }

  async switchTask(task: string) {
    if (!this.data.current) return;
    const projectPath = this.data.current.project;
    const now = new Date();
    await this.stop(now);
    await this.start(projectPath, task, { startTime: now, silent: true });
  }

  getData() {
    return this.data;
  }
}
