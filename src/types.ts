export interface TaskRecord {
  [taskName: string]: number; // seconds
}

export interface DayRecord {
  totalSeconds: number;
  tasks: TaskRecord;
  entries?: SessionEntry[];
}

export interface SessionEntry {
  task: string;
  start: string;
  end: string;
  seconds: number;
}

export interface ProjectSnapshot {
  days: {
    [date: string]: DayRecord;
  };
  lastTask?: string;
  current?: ActiveSession | null;
  version?: number;
}

export interface ActiveSession {
  task: string;
  start: string; // ISO string
}

export interface ProjectIndexEntry {
  id: string;
  path: string;
  name: string;
  lastUsed?: string; // ISO string
}

export interface ProjectsIndexFile {
  version: number;
  projects: ProjectIndexEntry[];
}

export interface ActivityLogEntry {
  date: string; // YYYY-MM-DD
  projectId: string;
  projectName: string;
}

export interface ActivityLogFile {
  version: number;
  entries: ActivityLogEntry[];
}

export interface ActiveProjectSession {
  projectId: string;
  projectName: string;
  projectPath: string;
  task: string;
  start: string; // ISO string
}

// Legacy types kept for migration and compatibility with older storage formats.
export interface ProjectRecord {
  days: {
    [date: string]: DayRecord;
  };
  lastTask?: string;
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
