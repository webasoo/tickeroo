import * as vscode from "vscode";
import { Tracker } from "./tracker";

export class StatusBar {
  private item: vscode.StatusBarItem;
  private tracker: Tracker;
  private interval: NodeJS.Timeout | null = null;

  constructor(tracker: Tracker) {
    this.tracker = tracker;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "timeTracker.showStatusMenu";
    this.item.tooltip = "Local Project Time Tracker — click for actions";
    this.item.show();
  }

  start() {
    console.log("Local Project Time Tracker: status bar started");
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
      this.item.text = `🕒 Time Tracker: idle`;
      this.item.tooltip = `Local Project Time Tracker — click to start tracking or view a report`;
      return;
    }
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
}
