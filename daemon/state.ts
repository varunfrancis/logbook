import type { Db, Row } from './db.ts';
import { kvGet } from './db.ts';
import type { LiveEntry } from './live.ts';
import { assignLots, ensureProjectForCwd, spiral } from './projects.ts';
import { floorsFor, projectState, sessionStatus } from './status.ts';
import { githubMeta } from './github.ts';
import { RECENT_MS } from './config.ts';
import type { ProjectDetail, ProjectView, SessionStatus, SessionView, StateView } from './types.ts';

const shorten = (s: string, n = 72) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function toSessionView(s: Row, live: LiveEntry | undefined, now: number): SessionView {
  const status = sessionStatus(s, live, now);
  const sub = s.tok_sub || 0;
  const liveName = live?.name && !/^[a-z0-9]+-[0-9a-f]{1,3}$/i.test(live.name) ? live.name : null; // skip derived names like "cat-f8"
  return {
    id: s.id,
    projectId: s.project_id,
    title: shorten(s.ai_title || liveName || s.first_prompt || live?.name || 'New session'),
    status,
    action: status === 'ended' ? null : status === 'idle' ? 'Waiting for your next message' : s.current_action,
    actionKind: status === 'running' ? (s.action_kind ?? 'think') : null,
    needsMessage: status === 'needs_input' ? (s.needs_message || 'Waiting for your approval') : null,
    branch: s.branch,
    worktree: s.worktree,
    cwd: s.cwd ?? live?.cwd ?? null,
    kind: live?.kind ?? null,
    startedAt: s.started_at,
    lastEventAt: s.last_event_at,
    endedAt: s.ended_at ?? (status === 'ended' ? s.last_event_at : null),
    endReason: s.end_reason,
    tokens: (s.tok_in || 0) + (s.tok_out || 0) + (s.tok_cache_write || 0) + sub,
    tokensBreakdown: { input: s.tok_in || 0, output: s.tok_out || 0, cacheRead: s.tok_cache_read || 0, cacheWrite: s.tok_cache_write || 0, subagents: sub },
    model: s.model,
    costUsd: s.cost_usd,
    linesAdded: s.lines_added,
    linesRemoved: s.lines_removed,
    commits: s.commits || 0,
    prUrl: s.pr_url,
    prState: s.pr_state,
    outcome: s.outcome,
    lastPrompt: s.last_prompt,
    prompts: s.prompts || 0,
    helperActive: status === 'running' && !!s.subagent_at && now - s.subagent_at < 90_000,
  };
}

/** Registry entries for sessions we have never seen (brand-new, no transcript yet) get a row so they show up immediately. */
export function adoptLive(db: Db, live: Map<string, LiveEntry>) {
  for (const e of live.values()) {
    const s = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(e.sessionId) as Row | undefined;
    if (s?.project_id) continue;
    if (!s) db.prepare('INSERT INTO sessions(id, cwd, started_at, last_event_at) VALUES(?, ?, ?, ?)').run(e.sessionId, e.cwd, e.startedAt ?? Date.now(), e.updatedAt ?? e.startedAt ?? Date.now());
    if (e.cwd) {
      const r = ensureProjectForCwd(db, e.cwd);
      db.prepare('UPDATE sessions SET project_id = ?, worktree = COALESCE(worktree, ?), cwd = COALESCE(cwd, ?) WHERE id = ?').run(r.projectId, r.worktree, e.cwd, e.sessionId);
    }
  }
}

type Agg = { tokens: number; today: number; total: number; statuses: SessionStatus[]; lastEnded: number; pr: Row | null; lines: number; commits: number };

export function buildState(db: Db, live: Map<string, LiveEntry>, now = Date.now()): StateView {
  assignLots(db);
  const today = startOfToday();
  const projects = db.prepare('SELECT * FROM projects').all() as Row[];
  const aggRows = db.prepare(`
    SELECT project_id, COUNT(*) AS n,
      SUM(tok_in + tok_out + tok_cache_write + tok_sub) AS tokens,
      SUM(CASE WHEN last_event_at >= ? THEN tok_in + tok_out + tok_cache_write + tok_sub ELSE 0 END) AS today,
      SUM(COALESCE(lines_added, 0)) AS lines, SUM(commits) AS commits
    FROM sessions WHERE project_id IS NOT NULL GROUP BY project_id`).all(today) as Row[];
  const agg = new Map<string, Agg>();
  for (const r of aggRows) agg.set(r.project_id, { tokens: r.tokens || 0, today: r.today || 0, total: r.n, statuses: [], lastEnded: 0, pr: null, lines: r.lines || 0, commits: r.commits || 0 });

  // Sessions worth showing: live ones, anything from the last day, and anything the hooks say is open.
  const liveIds = [...live.keys()];
  const rows = db.prepare(`SELECT * FROM sessions WHERE project_id IS NOT NULL AND (last_event_at >= ? OR id IN (${liveIds.map(() => '?').join(',') || "''"}) OR (hook_state IS NOT NULL AND hook_state != 'ended' AND hook_state_at >= ?))`)
    .all(now - RECENT_MS, ...liveIds, now - RECENT_MS) as Row[];
  const sessions = rows.map((r) => toSessionView(r, live.get(r.id), now));
  for (const s of sessions) {
    const a = agg.get(s.projectId!);
    if (!a) continue;
    a.statuses.push(s.status);
    if (s.status === 'ended') a.lastEnded = Math.max(a.lastEnded, s.endedAt ?? 0);
  }
  const prs = db.prepare(`SELECT project_id, pr_url, pr_state, MAX(last_event_at) AS t FROM sessions WHERE pr_url IS NOT NULL AND last_event_at >= ? GROUP BY project_id`).all(now - 14 * 24 * 3600_000) as Row[];
  for (const pr of prs) { const a = agg.get(pr.project_id); if (a) a.pr = pr; }

  const projectViews: ProjectView[] = projects.map((p) => {
    const a = agg.get(p.id) ?? { tokens: 0, today: 0, total: 0, statuses: [], lastEnded: 0, pr: null, lines: 0, commits: 0 };
    const lastActivity = p.last_activity ?? null;
    const state = projectState({ root: p.root, sessionsTotal: a.total, lastActivity: lastActivity ?? (p.root ? null : null) }, a.statuses, now);
    const liveCount = a.statuses.filter((s) => s !== 'ended').length;
    return {
      id: p.id,
      name: p.name,
      root: p.root,
      ghFull: p.gh_full,
      ghUrl: p.gh_url,
      ghPrivate: p.gh_private == null ? null : !!p.gh_private,
      ghPushedAt: p.gh_pushed_at,
      description: p.gh_description,
      lot: spiral(p.lot ?? 0),
      state,
      floors: state === 'lot' ? 0 : a.total ? floorsFor(a.tokens) : 2,
      tokens: a.tokens,
      tokensToday: a.today,
      sessionsTotal: a.total,
      liveSessions: liveCount,
      lastActivity,
      prState: a.pr?.pr_state ?? (a.pr ? 'open' : null),
      prUrl: a.pr?.pr_url ?? null,
      justShipped: liveCount === 0 && a.lastEnded > 0 && now - a.lastEnded < 6 * 3600_000,
      linesAdded: a.lines,
      commits: a.commits,
    };
  });

  const count = (st: SessionStatus) => sessions.filter((s) => s.status === st).length;
  return {
    generatedAt: now,
    projects: projectViews,
    sessions: sessions.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0)),
    totals: {
      live: sessions.filter((s) => s.status !== 'ended').length,
      running: count('running'),
      needs: count('needs_input'),
      idle: count('idle'),
      doneToday: sessions.filter((s) => s.status === 'ended' && (s.endedAt ?? 0) >= today).length,
      tokensToday: projectViews.reduce((n, p) => n + p.tokensToday, 0),
    },
    github: githubMeta(db),
    hooks: { lastEventAt: kvGet<number | null>(db, 'hooks.lastEventAt', null) },
  };
}

export function projectDetail(db: Db, state: StateView, live: Map<string, LiveEntry>, id: string): ProjectDetail | null {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return null;
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY last_event_at DESC LIMIT 40').all(id) as Row[];
  const sessions = rows.map((r) => toSessionView(r, live.get(r.id), now));
  const ids = sessions.slice(0, 10).map((s) => s.id);
  const events = ids.length
    ? (db.prepare(`SELECT session_id AS sessionId, ts, kind, text FROM events WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT 60`).all(...ids) as any[])
    : [];
  return { project, sessions, events };
}
