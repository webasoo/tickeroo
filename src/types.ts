export interface TaskRecord {
  [taskName: string]: number; // seconds
}

export interface DayRecord {
  totalSeconds: number;
  tasks: TaskRecord;
  entries?: SessionEntry[];
}

export interface ProjectRecord {
  days: {
    [date: string]: DayRecord;
  };
  lastTask?: string;
}

export interface SessionEntry {
  task: string;
  start: string;
  end: string;
  seconds: number;
}

export interface TimeTrackerData {
  projects: {
    [projectPath: string]: ProjectRecord;
  };
  current?: {
    project: string;
    task: string;
    start: string; // ISO string
  } | null;
}
