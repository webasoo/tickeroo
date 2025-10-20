import * as vscode from "vscode";
import { Tracker } from "./tracker";
import { TimeTrackerData } from "./types";

export class StatusBar {
  private item: vscode.StatusBarItem;
  private tracker: Tracker;
  private interval: NodeJS.Timeout | null = null;
  private flashState = false;

  constructor(tracker: Tracker) {
    this.tracker = tracker;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "timeTracker.showStatusMenu";
    this.item.tooltip = "Tickeroo — click for actions";
    this.item.show();
  }

  start() {
    this.update();
    this.interval = setInterval(() => this.update(), 1000) as any;
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval as any);
      this.interval = null;
    }
    this.item.dispose();
  }

  private update() {
    const data = this.tracker.getData();
    const cur = data.current;
    if (!cur) {
      const hasTrackedHistory = this.hasTrackedHistory(data);
      if (hasTrackedHistory) {
        this.flashState = !this.flashState;
        // const icon = this.flashState ? "🟡" : "🕒";
        const icon = "🕒";
        this.item.text = `${icon} Tickeroo: idle`;
        this.item.color = this.flashState
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
      } else {
        this.flashState = false;
        this.item.text = `🕒 Tickeroo: idle`;
      }
      this.item.tooltip = `Tickeroo — click to start tracking or view a report`;
      return;
    }

    this.flashState = false;
    const start = new Date(cur.start);
    const seconds = Math.max(
      0,
      Math.round((Date.now() - start.getTime()) / 1000)
    );
    const hh = Math.floor(seconds / 3600)
      .toString()
      .padStart(2, "0");
    const mm = Math.floor((seconds % 3600) / 60)
      .toString()
      .padStart(2, "0");
    const ss = (seconds % 60).toString().padStart(2, "0");
    const projectName = cur.project.split("/").pop() || cur.project;
    this.item.text = `🕑 ${projectName} — ${cur.task} (${hh}:${mm}:${ss})`;
    this.item.tooltip = `${cur.project} — ${cur.task}\nClick for more actions`;
  }

  private hasTrackedHistory(data: TimeTrackerData) {
    const projects = data.projects ?? {};
    return Object.values(projects).some((project) =>
      Object.values(project.days ?? {}).some(
        (day) =>
          day.totalSeconds > 0 ||
          Object.keys(day.tasks ?? {}).length > 0 ||
          (day.entries?.length ?? 0) > 0
      )
    );
  }
}
