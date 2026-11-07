export type SessionStatus = 'running' | 'needs_input' | 'idle' | 'ended';
/** site: crew there now · needs: someone there raised a hand · construction: worked on in the last 7 days · recent: quiet 7–30 days (just completed) · done: quiet 30+ days · lot: GitHub only */
export type ProjectState = 'site' | 'needs' | 'construction' | 'recent' | 'done' | 'lot';
export type ActionKind = 'edit' | 'run' | 'read' | 'web' | 'delegate' | 'think';
export type Stamp = 'shipped' | 'review' | 'saved' | 'unfinished' | 'scrapped' | 'chat';
export type Size = 'tweak' | 'fix' | 'feature' | 'overhaul';
export type Job = 'builder' | 'plumber' | 'painter' | 'librarian' | 'inspector' | 'scout';

export type Agent = {
  key: string;
  name: string; // "Pip"
  title: string; // "Pip the Plumber"
  job: Job;
  jobTitle: string; // "Plumber"
  shape: string;
  color: string;
  accessory: string;
  role: 'resident' | 'helper' | 'workbench' | 'routine'; // resident: the project's own character · helper: a temporary extra on main · workbench: tied to a worktree/branch · routine: a scheduled job that wakes up, works, sleeps
};

export type SessionView = {
  id: string;
  projectId: string | null;
  agent: Agent;
  title: string;
  status: SessionStatus;
  away: boolean; // idle so long it no longer counts as on site
  action: string | null;
  actionKind: ActionKind | null;
  needsMessage: string | null;
  branch: string | null;
  worktree: string | null;
  cwd: string | null;
  kind: string | null; // interactive | bg
  scheduled: boolean; // a headless run (cron, launchd, a script) rather than someone typing
  startedAt: number | null;
  lastEventAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  tokens: number;
  bricks: number;
  tokensBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number; subagents: number };
  model: string | null;
  costUsd: number;
  costEstimated: boolean;
  linesAdded: number | null;
  linesRemoved: number | null;
  size: Size | null;
  commits: number;
  prUrl: string | null;
  prState: string | null;
  stamp: Stamp | null;
  outcome: string | null;
  lastPrompt: string | null;
  firstPrompt: string | null;
  prompts: number;
  helperActive: boolean;
  stuck: { count: number; problem: string } | null;
  collision: { with: string; file: string } | null;
  lastCheck: { ok: boolean; at: number } | null;
  chatter: string | null;
  filesChanged: number;
};

export type ProjectView = {
  id: string;
  name: string; // plain name ("Support Bot")
  repo: string; // repo folder / GitHub name ("support-assistant")
  nameSource: 'ai' | 'user' | 'auto';
  root: string | null;
  ghFull: string | null;
  ghUrl: string | null;
  ghPrivate: boolean | null;
  ghPushedAt: number | null;
  description: string | null;
  summary: string | null; // one plain sentence on what the project does
  lot: [number, number];
  district: string | null; // neighborhood of similar projects
  state: ProjectState;
  scope: number; // lines added + commits + a little for tokens; see scopeOf
  size: number; // 0..1 relative to the biggest project in town; drives footprint and floors
  floors: number;
  tokens: number;
  bricks: number;
  tokensToday: number;
  costUsd: number;
  sessionsTotal: number;
  liveSessions: number;
  lastActivity: number | null;
  prState: string | null;
  prUrl: string | null;
  justShipped: boolean;
  justMerged: boolean;
  stuck: boolean;
  checksFailing: boolean;
  linesAdded: number;
  commits: number;
};

/**
 * A scheduled job's character. Between runs it sleeps beside its building; when a run starts it
 * wakes up, works (as a normal session), then goes back to sleep.
 */
export type RoutineView = {
  key: string;
  projectId: string;
  agent: Agent;
  title: string;          // what the job does, from its latest run
  prompt: string | null;  // the job's brief
  state: 'awake' | 'asleep';
  liveSessionId: string | null;
  lastSessionId: string;
  runs: number;           // runs in the last 30 days (a burst of retries counts once)
  lastRunAt: number | null;
  lastEndedAt: number | null;
  lastStamp: Stamp | null;
  lastOutcome: string | null;
  intervalMs: number | null; // typical gap between runs, once there are two
  nextAt: number | null;     // a guess from that gap; null when the job doesn't look regular
};

export type GraveEntry = { sessionId: string; agent: Agent; projectName: string; epitaph: string; sub: string; at: number; bricks: number };

export type GithubMeta = {
  syncedAt: number | null;
  accounts: { login: string; repos: number; ok: boolean; error?: string }[];
  note?: string;
};

export type Town = { name: string; chosen: boolean; suggestions: string[]; owner: string };

export type StateView = {
  generatedAt: number;
  town: Town;
  projects: ProjectView[];
  districts: { name: string; x0: number; z0: number; x1: number; z1: number }[];
  sessions: SessionView[];
  routines: RoutineView[];
  graveyard: GraveEntry[];
  totals: {
    live: number; running: number; needs: number; idle: number; doneToday: number; shippedToday: number;
    tokensToday: number; bricksToday: number; costToday: number; waitedTodayMs: number; peakToday: number;
  };
  github: GithubMeta;
  hooks: { lastEventAt: number | null };
  settings: { skylineRepo: string | null; vscodeConnected: boolean; terminalIntros: boolean; welcome: Welcome };
  setup: Setup;
};

/** First run: reading past work, then giving buildings names, then ready. */
export type Setup = { phase: 'reading' | 'naming' | 'ready'; read: number; total: number; projects: number; shifts: number; crew: number };

export type WelcomeStep = 'setup' | 'name' | 'reveal' | 'rollcall' | 'signs' | 'tabs' | 'turn' | 'handoff' | 'arrival';
/** How far someone got through the welcome tour, plus the one-time tips they've seen. */
export type Welcome = { step: WelcomeStep | null; done: boolean; doneAt: number | null; skipped: { at: number; step: WelcomeStep } | null; tips: string[] };

export type Moment = { sessionId: string; ts: number; kind: string; text: string };

export type ProjectDetail = {
  project: ProjectView;
  sessions: SessionView[];
  events: Moment[];
};

export type AgentDetail = {
  agent: Agent;
  session: SessionView;
  project: ProjectView | null;
  career: { shifts: number; shipped: number; since: number | null; usualProject: string | null };
  moments: Moment[];
  claims: { claim: string; verdict: 'true' | 'partly' | 'false' | 'unknown'; evidence: string }[];
  waitedMs: number;
  segments: { start: number; end: number; kind: 'work' | 'wait' | 'idle' }[];
  profile: AgentProfile;
};

/** An agent's track record over the last 30 days, for judging them like a teammate. */
export type AgentProfile = {
  days: number;
  shifts: number;
  finished: number;      // closed shifts that set out to change something (excludes "just a chat")
  delivered: number;     // shipped or sent for review
  shipped: number;
  scrapped: number;      // scrapped or left unfinished
  saves: number;         // commits
  workMs: number;
  interruptions: number; // times they stopped to ask you something or wait for your OK
  waitedMs: number;
  costUsd: number;
  checksOk: number;
  checksFail: number;
  recent: { id: string; title: string; ask: string | null; stamp: Stamp | null; live: boolean; at: number | null }[];
};

export type DayView = {
  date: string;
  start: number;
  end: number;
  lanes: { session: SessionView; segments: { start: number; end: number; kind: 'work' | 'wait' | 'idle' }[]; marks: { ts: number; kind: string }[] }[];
  stats: { waitedMs: number; longestWait: { agent: string; ms: number; at: number } | null; crewMs: number; crew: number; projects: number; peak: number; peakAt: number | null; shipped: number; closed: number; unfinished: number; scrapped: number; bricks: number; costUsd: number };
};

export type WrappedView = {
  month: string;
  label: string;
  mvp: { agent: Agent; shipped: number; scrapped: number; bricks: number; project: string | null } | null;
  peak: number;
  peakAt: number | null;
  stats: { shifts: number; shipped: number; graveyard: number; waitedMs: number; busiestHour: number | null; bricks: number; newBuildings: number; costUsd: number };
};
