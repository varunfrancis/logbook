export type SessionStatus = 'running' | 'needs_input' | 'idle' | 'ended';
export type ProjectState = 'build' | 'needs' | 'done' | 'quiet' | 'lot';
export type ActionKind = 'edit' | 'run' | 'read' | 'web' | 'delegate' | 'think';

export type SessionView = {
  id: string;
  projectId: string | null;
  title: string;
  status: SessionStatus;
  action: string | null;
  actionKind: ActionKind | null;
  needsMessage: string | null;
  branch: string | null;
  worktree: string | null;
  cwd: string | null;
  kind: string | null; // interactive | bg
  startedAt: number | null;
  lastEventAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  tokens: number;
  tokensBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number; subagents: number };
  model: string | null;
  costUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  commits: number;
  prUrl: string | null;
  prState: string | null;
  outcome: string | null;
  lastPrompt: string | null;
  prompts: number;
  helperActive: boolean;
};

export type ProjectView = {
  id: string;
  name: string;
  root: string | null;
  ghFull: string | null;
  ghUrl: string | null;
  ghPrivate: boolean | null;
  ghPushedAt: number | null;
  description: string | null;
  lot: [number, number];
  state: ProjectState;
  floors: number;
  tokens: number;
  tokensToday: number;
  sessionsTotal: number;
  liveSessions: number;
  lastActivity: number | null;
  prState: string | null;
  prUrl: string | null;
  justShipped: boolean;
  linesAdded: number;
  commits: number;
};

export type GithubMeta = {
  syncedAt: number | null;
  accounts: { login: string; repos: number; ok: boolean; error?: string }[];
  note?: string;
};

export type StateView = {
  generatedAt: number;
  projects: ProjectView[];
  sessions: SessionView[];
  totals: { live: number; running: number; needs: number; idle: number; doneToday: number; tokensToday: number };
  github: GithubMeta;
  hooks: { lastEventAt: number | null };
};

export type ProjectDetail = {
  project: ProjectView;
  sessions: SessionView[];
  events: { sessionId: string; ts: number; kind: string; text: string }[];
};
