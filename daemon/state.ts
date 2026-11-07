import path from 'node:path';
import type { Db, Row } from './db.ts';
import { kvGet } from './db.ts';
import type { LiveEntry } from './live.ts';
import { assignLots, ensureProjectForCwd } from './projects.ts';
import { currentDistricts, layoutTown } from './districts.ts';
import { floorsFor, projectState, scopeOf, sessionStatus, buildingSize } from './status.ts';
import { githubMeta } from './github.ts';
import { agentKey, allocateIdentities, helperKey, identityFor, isHeadless, isHelperKey, isResidentKey, isRoutineKey, jobFor, JOB_TITLE, settleJobs } from './identity.ts';
import { routinesView } from './routines.ts';
import { fallbackName, town } from './naming.ts';
import { sizeFor } from './outcome.ts';
import { crewsToday, notesView } from './crews.ts';
import { AWAY_AFTER_MS, DATA_DIR, RECENT_MS } from './config.ts';
import type { Agent, AgentDetail, CostBreakdown, DayView, GraveEntry, ProjectDetail, ProjectView, SessionView, Setup, StateView, Welcome, WrappedView } from './types.ts';

const BRICK = 10_000; // tokens per brick
const shorten = (s: string, n = 72) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const tokensOf = (s: Row) => (s.tok_in || 0) + (s.tok_out || 0) + (s.tok_cache_write || 0) + (s.tok_sub || 0);
const fmtMin = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim(); };

// ---------- cost ----------
let costRate = { at: 0, perToken: new Map<string, number>(), fallback: 15 / 1e6 };
/** $ per token learned from sessions where Claude Code recorded the real cost. Used to estimate live sessions. */
function rateFor(db: Db, model: string | null): number {
  if (Date.now() - costRate.at > 10 * 60_000) {
    const rows = db.prepare('SELECT model, SUM(cost_usd) c, SUM(tok_in + tok_out + tok_cache_write + tok_cache_read) t FROM sessions WHERE cost_usd > 0 GROUP BY model').all() as Row[];
    const m = new Map<string, number>();
    let C = 0, T = 0;
    for (const r of rows) if (r.t > 0) { m.set(r.model, r.c / r.t); C += r.c; T += r.t; }
    costRate = { at: Date.now(), perToken: m, fallback: T ? C / T : 15 / 1e6 };
  }
  return (model && costRate.perToken.get(model)) || costRate.fallback;
}
export function costOf(db: Db, s: Row): { usd: number; estimated: boolean } {
  if (s.cost_usd != null && s.cost_usd > 0) return { usd: s.cost_usd, estimated: false };
  const t = tokensOf(s) + (s.tok_cache_read || 0);
  return { usd: t * rateFor(db, s.model), estimated: true };
}

/** Group sessions' cost by project, then by agent (one character can work several shifts). Biggest spenders first. */
export function breakdownOf(db: Db, rows: Row[], names: Map<string, string>): CostBreakdown {
  const byProject = new Map<string, CostBreakdown[number]>();
  const latest = new Map<string, number>();
  for (const s of rows) {
    if (!s.project_id) continue;
    const { usd, estimated } = costOf(db, s);
    let p = byProject.get(s.project_id);
    if (!p) byProject.set(s.project_id, p = { projectId: s.project_id, name: names.get(s.project_id) ?? path.basename(s.project_id), usd: 0, estimated: false, agents: [] });
    p.usd += usd; p.estimated ||= estimated && usd > 0;
    const agent = agentOf(s);
    // Parallel helpers share a display name ("Iris Jr. the Builder"); one line per name reads better than five identical ones.
    let a = p.agents.find((x) => x.agent.title === agent.title);
    if (!a) p.agents.push(a = { agent, sessionId: s.id, shifts: 0, usd: 0, estimated: false });
    a.shifts++; a.usd += usd; a.estimated ||= estimated && usd > 0;
    const at = s.last_event_at || 0;
    const k = p.projectId + '|' + agent.title;
    if (at >= (latest.get(k) ?? -1)) { latest.set(k, at); a.sessionId = s.id; }
  }
  const spent = (x: { usd: number }) => x.usd >= 0.005; // hide rows that round to $0.00
  const out = [...byProject.values()].filter(spent).sort((a, b) => b.usd - a.usd);
  for (const p of out) p.agents = p.agents.filter(spent).sort((a, b) => b.usd - a.usd);
  return out;
}

// ---------- agents ----------
export function agentOf(s: Row): Agent {
  const key = s.agent_key || agentKey(s);
  const id = identityFor(key);
  const job = (id.job as Agent['job']) || (s.job as Agent['job']) || jobFor(s); // the character's settled job, not this shift's
  const role = isHelperKey(key) ? 'helper' : isResidentKey(key) ? 'resident' : isRoutineKey(key) ? 'routine' : 'workbench';
  return { key, name: id.name, title: `${id.name} the ${JOB_TITLE[job]}`, job, jobTitle: JOB_TITLE[job], shape: id.shape, color: id.color, accessory: id.accessory, role };
}

function chatterFor(v: Omit<SessionView, 'chatter'>, owner: string, now: number): string | null {
  if (v.status === 'ended') return null;
  if (v.stuck) return v.stuck.count >= 4 ? `Same problem, ${v.stuck.count}th time. I'm taking it personally.` : `Hit the same snag ${v.stuck.count} times now.`;
  if (v.status === 'needs_input') return [`Waiting on ${owner}. Again.`, 'Hand up. Anyone?', `Just need a yes from ${owner}.`][v.id.charCodeAt(0) % 3];
  if (v.lastCheck && !v.lastCheck.ok && now - v.lastCheck.at < 5 * 60_000) return 'Checks failed. Small fire. Handling it.';
  if (v.status === 'idle') return v.away ? null : ['Coffee break. Ready when you are.', 'Done what you asked. More?', 'This coffee is getting cold.'][v.id.charCodeAt(1) % 3];
  const a = v.action ?? '';
  const file = a.match(/(?:Editing|Writing|Reading) (\S+)/)?.[1];
  if (v.helperActive) return 'Called in a helper for this one.';
  if (v.scheduled && v.startedAt && now - v.startedAt < 90_000) return ['Alarm went off. On it.', 'Up for my scheduled run.', 'Yawn. Right, the usual job.'][v.id.charCodeAt(2) % 3];
  switch (v.actionKind) {
    case 'edit': return file ? `Hammering away at ${file}.` : 'Building.';
    case 'read': return file === 'package-lock.json' ? 'Reading package-lock.json. Send help.' : file ? `Reading ${file}. Gripping stuff.` : 'Looking around.';
    case 'run': return /check|test/i.test(a) ? 'Checking my work. Fingers crossed.' : `${a.replace(/\.$/, '')}.`;
    case 'web': return 'Doing a bit of research.';
    case 'delegate': return 'Handing part of this to a helper.';
    default: return 'Thinking it through.';
  }
}

export function toSessionView(db: Db, s: Row, live: LiveEntry | undefined, now: number, owner = 'you'): SessionView {
  const status = sessionStatus(s, live, now);
  const sub = s.tok_sub || 0;
  const liveName = live?.name && !/^[a-z0-9]+-[0-9a-f]{1,3}$/i.test(live.name) ? live.name : null;
  const tokens = tokensOf(s);
  const cost = costOf(db, s);
  const away = status === 'idle' && now - (s.last_event_at ?? 0) > AWAY_AFTER_MS;
  const stuck = status !== 'ended' && (s.err_count ?? 0) >= 3 && now - (s.err_at ?? 0) < 30 * 60_000
    ? { count: s.err_count, problem: String(s.err_sig ?? '').replace(/^[^:]+:\s*/, '') } : null;
  const files: { p: string }[] = s.files ? JSON.parse(s.files) : [];
  const base: Omit<SessionView, 'chatter'> = {
    id: s.id,
    projectId: s.project_id,
    agent: agentOf(s),
    title: shorten(s.ai_title || liveName || s.first_prompt || live?.name || 'New session'),
    focus: s.focus ?? null,
    status,
    away,
    action: status === 'ended' ? null : status === 'idle' ? 'Waiting for your next message' : s.current_action,
    actionKind: status === 'running' ? (s.action_kind ?? 'think') : null,
    needsMessage: status === 'needs_input' ? (s.needs_message || 'Waiting for your OK') : null,
    ask: null, // filled in by the server from the hooks that are waiting
    branch: s.branch,
    worktree: s.worktree,
    cwd: s.cwd ?? live?.cwd ?? null,
    kind: live?.kind ?? null,
    scheduled: isHeadless(s),
    startedAt: s.started_at,
    lastEventAt: s.last_event_at,
    endedAt: s.ended_at ?? (status === 'ended' ? s.last_event_at : null),
    endReason: s.end_reason,
    tokens,
    bricks: Math.round(tokens / BRICK),
    tokensBreakdown: { input: s.tok_in || 0, output: s.tok_out || 0, cacheRead: s.tok_cache_read || 0, cacheWrite: s.tok_cache_write || 0, subagents: sub },
    model: s.model,
    costUsd: cost.usd,
    costEstimated: cost.estimated,
    linesAdded: s.lines_added,
    linesRemoved: s.lines_removed,
    size: sizeFor(s.lines_added, s.lines_removed),
    commits: s.commits || 0,
    prUrl: s.pr_url,
    prState: s.pr_state,
    stamp: status === 'ended' ? s.stamp ?? null : null,
    outcome: s.outcome,
    lastPrompt: s.last_prompt,
    firstPrompt: s.first_prompt,
    prompts: s.prompts || 0,
    helperActive: status === 'running' && !!s.subagent_at && now - s.subagent_at < 90_000,
    stuck,
    collision: null,
    lastCheck: s.test_at ? { ok: !!s.test_ok, at: s.test_at } : null,
    filesChanged: files.length,
  };
  return { ...base, chatter: chatterFor(base, owner, now) };
}

/** Two live agents in one project that both changed the same file in the last 20 minutes. */
function markCollisions(rows: Row[], views: SessionView[], now: number) {
  const byProject = new Map<string, { v: SessionView; files: Map<string, number> }[]>();
  rows.forEach((r, i) => {
    const v = views[i];
    if (v.status !== 'running' || !r.files || !v.projectId) return;
    const files = new Map<string, number>();
    const rootGuess = (r.cwd ?? '').replace(/\/\.claude\/worktrees\/[^/]+$/, '');
    for (const f of JSON.parse(r.files) as { p: string; t: number }[]) {
      if (now - f.t > 20 * 60_000) continue;
      const rel = f.p.replace(/^.*\/\.claude\/worktrees\/[^/]+\//, '').replace(rootGuess + '/', '');
      files.set(rel, f.t);
    }
    if (!byProject.has(v.projectId)) byProject.set(v.projectId, []);
    byProject.get(v.projectId)!.push({ v, files });
  });
  for (const crew of byProject.values()) {
    for (const a of crew) for (const b of crew) {
      if (a === b || a.v.collision) continue;
      const shared = [...a.files.keys()].find((f) => b.files.has(f));
      if (shared) a.v.collision = { with: b.v.agent.name, file: path.basename(shared) };
    }
  }
}

/** Registry entries for sessions we have never seen (brand-new, no transcript yet) get a row so they show up immediately. */
export function adoptLive(db: Db, live: Map<string, LiveEntry>) {
  for (const e of live.values()) {
    if (e.cwd?.startsWith(DATA_DIR)) continue;
    const s = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(e.sessionId) as Row | undefined;
    if (s?.project_id) continue;
    if (!s) db.prepare('INSERT INTO sessions(id, cwd, started_at, last_event_at) VALUES(?, ?, ?, ?)').run(e.sessionId, e.cwd, e.startedAt ?? Date.now(), e.updatedAt ?? e.startedAt ?? Date.now());
    if (e.cwd) {
      const r = ensureProjectForCwd(db, e.cwd);
      db.prepare('UPDATE sessions SET project_id = ?, worktree = COALESCE(worktree, ?), cwd = COALESCE(cwd, ?) WHERE id = ?').run(r.projectId, r.worktree, e.cwd, e.sessionId);
    }
  }
}

/**
 * Keeps each recent session's agent key and job current.
 * On main, the earliest live session in a project is the resident; any other live one at the same time is a helper,
 * and stays a helper in history once it has been one.
 */
export function refreshAgents(db: Db, since: number, live: Map<string, LiveEntry>) {
  const rows = db.prepare('SELECT * FROM sessions WHERE project_id IS NOT NULL AND (last_event_at >= ? OR agent_key IS NULL OR id IN (' + ([...live.keys()].map(() => '?').join(',') || "''") + ')) ORDER BY last_event_at DESC').all(since, ...live.keys()) as Row[];
  const upd = db.prepare('UPDATE sessions SET agent_key = ?, job = ? WHERE id = ?');
  const residentBusy = new Map<string, string>(); // project -> live session id holding the resident
  const liveOnMain = rows.filter((s) => live.has(s.id) && isResidentKey(agentKey(s))).sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  for (const s of liveOnMain) {
    const holder = residentBusy.get(s.project_id);
    if (!holder && !isHelperKey(s.agent_key ?? '')) residentBusy.set(s.project_id, s.id);
  }
  const keys: string[] = [];
  for (const s of rows) {
    let key = agentKey(s);
    if (isResidentKey(key)) {
      if (isHelperKey(s.agent_key ?? '')) key = s.agent_key; // once a helper, always that helper
      else if (live.has(s.id) && residentBusy.has(s.project_id) && residentBusy.get(s.project_id) !== s.id) key = helperKey(s.project_id, s.id);
    }
    const job = jobFor(s);
    keys.push(key);
    if (key !== s.agent_key || job !== s.job) upd.run(key, job, s.id);
  }
  // oldest first, so long-running characters keep the names they had
  allocateIdentities(db, [...new Set(keys)].reverse());
  settleJobs(db);
}

export function projectNames(p: Row): { name: string; repo: string; source: ProjectView['nameSource'] } {
  const repo = p.root ? path.basename(p.root) : p.gh_full?.split('/')[1] ?? p.name;
  if (p.display_name) return { name: p.display_name, repo, source: p.display_source === 'user' ? 'user' : 'ai' };
  return { name: p.name === 'Scratch' ? 'Scratch' : fallbackName(repo), repo, source: 'auto' };
}

/** Peak number of agents at once from session intervals (idle gaps longer than AWAY are cut). */
function peakOf(intervals: [number, number][]): { peak: number; at: number | null } {
  const ev: [number, number][] = [];
  for (const [a, b] of intervals) if (b > a) ev.push([a, 1], [b, -1]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0, at: number | null = null;
  for (const [t, d] of ev) { cur += d; if (cur > peak) { peak = cur; at = t; } }
  return { peak, at };
}
function sessionIntervals(db: Db, from: number, to: number): Map<string, [number, number][]> {
  const segs = db.prepare('SELECT session_id, start, end, kind FROM segments WHERE end > ? AND start < ? ORDER BY start').all(from, to) as Row[];
  const out = new Map<string, [number, number][]>();
  for (const g of segs) {
    const end = g.kind === 'idle' ? Math.min(g.end, g.start + AWAY_AFTER_MS) : g.end;
    const a = Math.max(from, g.start), b = Math.min(to, end);
    if (b <= a) continue;
    const list = out.get(g.session_id) ?? [];
    const last = list[list.length - 1];
    if (last && a <= last[1] + 60_000) last[1] = Math.max(last[1], b); else list.push([a, b]);
    out.set(g.session_id, list);
  }
  return out;
}

function graveyard(db: Db, names: Map<string, string>, now: number, live: Map<string, LiveEntry>): GraveEntry[] {
  const rows = (db.prepare(`SELECT * FROM sessions WHERE stamp IN ('scrapped','unfinished') AND last_event_at BETWEEN ? AND ? ORDER BY last_event_at DESC LIMIT 20`)
    .all(now - 30 * 24 * 3600_000, now - 3600_000) as Row[]).filter((s) => !live.has(s.id)).slice(0, 12);
  return rows.map((s) => {
    const task = shorten((s.ai_title || s.first_prompt || 'something').replace(/^\/\S+\s*/, ''), 44).replace(/^\w/, (c: string) => c.toLowerCase());
    const dur = s.started_at && s.last_event_at ? fmtMin(s.last_event_at - s.started_at) : '';
    const saidDone = /\b(done|complete|completed|finished|ready|shipped)\b/i.test(s.outcome ?? '');
    const epitaph = s.stamp === 'unfinished' ? (saidDone ? 'Said "done". Saved nothing.' : `Left “${task}” half-built.`) : `“${task.replace(/^\w/, (c: string) => c.toUpperCase())}” never made it.`;
    return { sessionId: s.id, agent: agentOf(s), projectName: names.get(s.project_id) ?? 'a project', epitaph, sub: s.stamp === 'unfinished' ? `Changes never saved · ${dur}` : `Gave up after ${dur}`, at: s.last_event_at, bricks: Math.round(tokensOf(s) / BRICK) };
  });
}

type Agg = { tokens: number; today: number; total: number; cost: number; crew: { status: SessionView['status']; away: boolean }[]; lastEnded: number; pr: Row | null; lines: number; commits: number; stuck: boolean; failing: boolean };

export const NEW_WELCOME: Welcome = { step: null, done: false, doneAt: null, skipped: null, tips: [] };
const READY: Setup = { phase: 'ready', read: 0, total: 0, projects: 0, shifts: 0, crew: 0 };

export function buildState(db: Db, live: Map<string, LiveEntry>, now = Date.now(), vscodeConnected = false, setup: Setup = READY): StateView {
  assignLots(db);
  const today = startOfDay();
  const t = town(db);
  const projects = db.prepare('SELECT * FROM projects ORDER BY lot').all() as Row[];
  const aggRows = db.prepare(`
    SELECT project_id, COUNT(*) AS n,
      SUM(tok_in + tok_out + tok_cache_write + tok_sub) AS tokens,
      SUM(CASE WHEN last_event_at >= ? THEN tok_in + tok_out + tok_cache_write + tok_sub ELSE 0 END) AS today,
      SUM(COALESCE(cost_usd, 0)) AS cost,
      SUM(COALESCE(lines_added, 0)) AS lines, SUM(commits) AS commits
    FROM sessions WHERE project_id IS NOT NULL GROUP BY project_id`).all(today) as Row[];
  const agg = new Map<string, Agg>();
  for (const r of aggRows) agg.set(r.project_id, { tokens: r.tokens || 0, today: r.today || 0, total: r.n, cost: r.cost || 0, crew: [], lastEnded: 0, pr: null, lines: r.lines || 0, commits: r.commits || 0, stuck: false, failing: false });

  const liveIds = [...live.keys()];
  const rows = db.prepare(`SELECT * FROM sessions WHERE project_id IS NOT NULL AND (last_event_at >= ? OR id IN (${liveIds.map(() => '?').join(',') || "''"}) OR (hook_state IS NOT NULL AND hook_state != 'ended' AND hook_state_at >= ?))`)
    .all(now - RECENT_MS, ...liveIds, now - RECENT_MS) as Row[];
  const sessions = rows.map((r) => toSessionView(db, r, live.get(r.id), now, t.owner));
  markCollisions(rows, sessions, now);
  for (const s of sessions) if (s.collision) s.chatter = `${s.collision.with} keeps touching my ${s.collision.file}.`;
  for (const s of sessions) {
    const a = agg.get(s.projectId!);
    if (!a) continue;
    a.crew.push({ status: s.status, away: s.away });
    if (s.status === 'ended') a.lastEnded = Math.max(a.lastEnded, s.endedAt ?? 0);
    if (s.stuck) a.stuck = true;
    if (s.status !== 'ended' && s.lastCheck && !s.lastCheck.ok && now - s.lastCheck.at < 5 * 60_000) a.failing = true;
  }
  const prs = db.prepare(`SELECT project_id, pr_url, pr_state, MAX(last_event_at) AS t FROM sessions WHERE pr_url IS NOT NULL AND last_event_at >= ? GROUP BY project_id`).all(now - 14 * 24 * 3600_000) as Row[];
  for (const pr of prs) { const a = agg.get(pr.project_id); if (a) a.pr = pr; }
  const merged = new Set((db.prepare('SELECT DISTINCT project_id FROM sessions WHERE pr_merged_at > ?').all(now - 10 * 60_000) as Row[]).map((r) => r.project_id));

  // Neighborhoods: similar projects side by side, a park street between unrelated ones. For-sale lots on the outskirts.
  const inTown = projects.filter((p) => p.root || agg.has(p.id));
  const { groups, ungrouped } = currentDistricts(db, inTown);
  const forSale = projects.filter((p) => !p.root && !agg.has(p.id)).map((p) => p.id);
  const plan = layoutTown(groups, [{ name: 'New in town', ids: ungrouped }, { name: 'For sale', ids: forSale }]);
  const districtOf = new Map<string, string>();
  for (const g of groups) for (const id of g.ids) districtOf.set(id, g.name);

  // Building size is relative: the project with the most scope gets the biggest building in town.
  const maxScope = Math.max(0, ...[...agg.values()].map(scopeOf));
  const projectViews: ProjectView[] = projects.map((p) => {
    const a = agg.get(p.id) ?? { tokens: 0, today: 0, total: 0, cost: 0, crew: [], lastEnded: 0, pr: null, lines: 0, commits: 0, stuck: false, failing: false };
    const scope = scopeOf(a), size = buildingSize(scope, maxScope);
    const state = projectState({ root: p.root, sessionsTotal: a.total, lastActivity: p.last_activity ?? null }, a.crew, now);
    const n = projectNames(p);
    const liveCount = a.crew.filter((s) => s.status !== 'ended' && !s.away).length;
    return {
      id: p.id, name: n.name, repo: n.repo, nameSource: n.source,
      root: p.root, ghFull: p.gh_full, ghUrl: p.gh_url, ghPrivate: p.gh_private == null ? null : !!p.gh_private, ghPushedAt: p.gh_pushed_at,
      description: p.gh_description,
      summary: p.summary ?? p.gh_description ?? null,
      lot: plan.cells.get(p.id) ?? [0, 0],
      district: districtOf.get(p.id) ?? null,
      state,
      scope, size: state === 'lot' ? 0 : size,
      floors: state === 'lot' ? 0 : floorsFor(size),
      tokens: a.tokens, bricks: Math.round(a.tokens / BRICK), tokensToday: a.today, costUsd: a.cost,
      sessionsTotal: a.total, liveSessions: liveCount, lastActivity: p.last_activity ?? null,
      prState: a.pr?.pr_state ?? (a.pr ? 'open' : null), prUrl: a.pr?.pr_url ?? null,
      justShipped: liveCount === 0 && a.lastEnded > 0 && now - a.lastEnded < 6 * 3600_000,
      justMerged: merged.has(p.id), stuck: a.stuck, checksFailing: a.failing,
      linesAdded: a.lines, commits: a.commits,
    };
  });
  const names = new Map(projectViews.map((p) => [p.id, p.name]));

  const todayRows = db.prepare('SELECT * FROM sessions WHERE last_event_at >= ? AND project_id IS NOT NULL').all(today) as Row[];
  const costToday = todayRows.reduce((n, s) => n + costOf(db, s).usd, 0);
  const costBreakdown = breakdownOf(db, todayRows, names);
  const waitedTodayMs = (db.prepare("SELECT SUM(MIN(end, ?) - MAX(start, ?)) w FROM segments WHERE kind = 'wait' AND end > ?").get(now, today, today) as Row).w || 0;
  const peakToday = peakOf([...sessionIntervals(db, today, now).values()].flat()).peak;
  const count = (st: SessionView['status']) => sessions.filter((s) => s.status === st).length;
  const tokensToday = projectViews.reduce((n, p) => n + p.tokensToday, 0);
  return {
    generatedAt: now,
    town: t,
    projects: projectViews,
    sessions: sessions.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0)),
    routines: routinesView(db, sessions, (r) => toSessionView(db, r, live.get(r.id), now, t.owner), now),
    districts: plan.districts.filter((d) => d.name !== 'For sale'),
    graveyard: graveyard(db, names, now, live),
    costBreakdown,
    crews: crewsToday(db, todayRows, live, names, now),
    notes: notesView(db, names, now),
    totals: {
      live: sessions.filter((s) => s.status !== 'ended').length,
      running: count('running'), needs: count('needs_input'), idle: count('idle'),
      doneToday: sessions.filter((s) => s.status === 'ended' && (s.endedAt ?? 0) >= today).length,
      shippedToday: sessions.filter((s) => s.stamp === 'shipped' && (s.endedAt ?? 0) >= today).length,
      tokensToday, bricksToday: Math.round(tokensToday / BRICK), costToday, waitedTodayMs, peakToday,
    },
    github: githubMeta(db),
    hooks: { lastEventAt: kvGet<number | null>(db, 'hooks.lastEventAt', null) },
    settings: {
      skylineRepo: kvGet<string | null>(db, 'settings.skylineRepo', null), vscodeConnected,
      terminalIntros: kvGet<boolean>(db, 'settings.terminalIntros', false),
      welcome: { ...NEW_WELCOME, ...kvGet<Partial<Welcome>>(db, 'welcome', {}) },
    },
    setup: {
      ...setup,
      projects: inTown.filter((p) => agg.has(p.id)).length,
      shifts: (db.prepare('SELECT COUNT(*) n FROM sessions WHERE project_id IS NOT NULL').get() as Row).n,
      crew: (db.prepare("SELECT COUNT(DISTINCT agent_key) n FROM sessions WHERE agent_key IS NOT NULL AND agent_key NOT LIKE '%#resident~%'").get() as Row).n,
    },
  };
}

function momentsFor(db: Db, ids: string[], limit = 80) {
  if (!ids.length) return [];
  return db.prepare(`SELECT session_id AS sessionId, ts, kind, text FROM events WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT ?`).all(...ids, limit) as any[];
}

export function projectDetail(db: Db, state: StateView, live: Map<string, LiveEntry>, id: string): ProjectDetail | null {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return null;
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY last_event_at DESC LIMIT 40').all(id) as Row[];
  const sessions = rows.map((r) => toSessionView(db, r, live.get(r.id), now, state.town.owner));
  return { project, sessions, events: momentsFor(db, sessions.slice(0, 10).map((s) => s.id), 60) };
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Checks the final message's claims against what the session actually did. */
function claimsFor(s: Row, v: SessionView): AgentDetail['claims'] {
  const text = (s.outcome ?? '').toLowerCase();
  const out: AgentDetail['claims'] = [];
  if (/\b(tests?|checks?|build)\b[^.]{0,30}\b(pass|passed|passing|green|succeed)/.test(text)) {
    if (!s.test_at) out.push({ claim: 'Its checks pass', verdict: 'unknown', evidence: 'No check was run during this shift.' });
    else out.push({ claim: 'Its checks pass', verdict: s.test_ok ? 'true' : 'false', evidence: s.test_ok ? `It ran them at ${clock(s.test_at)} and they passed.` : 'The last check it ran failed.' });
  }
  if (/\b(opened|created|raised|submitted)\b[^.]{0,20}\b(pr|pull request)\b/.test(text)) out.push({ claim: 'Sent it for review', verdict: s.pr_url ? 'true' : 'false', evidence: s.pr_url ? `Review request #${s.pr_url.split('/').pop()} ${s.pr_state === 'merged' ? 'is approved and live' : 'is open'}.` : 'No review request was found.' });
  if (/\b(committed|commit(ted)? (the|my|these) changes)\b/.test(text)) out.push({ claim: 'Saved its changes', verdict: (s.commits ?? 0) > 0 ? 'true' : 'false', evidence: (s.commits ?? 0) > 0 ? `${s.commits} save${s.commits > 1 ? 's' : ''} recorded.` : 'No saves recorded.' });
  if (/\b(done|complete|finished|implemented|fixed)\b/.test(text) && v.stamp) {
    const ok = v.stamp === 'shipped' || v.stamp === 'review' || v.stamp === 'saved';
    out.push({ claim: 'The work is done', verdict: ok ? 'true' : v.stamp === 'unfinished' ? 'false' : 'partly', evidence: v.stamp === 'unfinished' ? 'Some changes were never saved.' : v.stamp === 'scrapped' ? 'Nothing it changed was kept.' : v.stamp === 'chat' ? 'It didn’t change anything.' : 'Its changes were kept.' });
  }
  return out;
}

export function agentDetail(db: Db, state: StateView, live: Map<string, LiveEntry>, sessionId: string): AgentDetail | null {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Row | undefined;
  if (!s) return null;
  const v = toSessionView(db, s, live.get(s.id), Date.now(), state.town.owner);
  const key = v.agent.key;
  const career = db.prepare("SELECT COUNT(*) n, SUM(stamp = 'shipped') shipped, MIN(started_at) since FROM sessions WHERE agent_key = ?").get(key) as Row;
  const usual = db.prepare('SELECT project_id, COUNT(*) n FROM sessions WHERE agent_key = ? GROUP BY project_id ORDER BY n DESC LIMIT 1').get(key) as Row | undefined;
  const segments = db.prepare('SELECT start, end, kind FROM segments WHERE session_id = ? ORDER BY start').all(sessionId) as any[];
  return {
    agent: v.agent,
    session: v,
    project: state.projects.find((p) => p.id === s.project_id) ?? null,
    career: { shifts: career.n || 1, shipped: career.shipped || 0, since: career.since ?? s.started_at, usualProject: usual ? state.projects.find((p) => p.id === usual.project_id)?.name ?? null : null },
    moments: momentsFor(db, [sessionId], 200).reverse(),
    claims: claimsFor(s, v),
    waitedMs: segments.filter((g) => g.kind === 'wait').reduce((n, g) => n + (g.end - g.start), 0),
    segments,
    profile: profileFor(db, key, live, state.town.owner),
  };
}

export function profileFor(db: Db, key: string, live: Map<string, LiveEntry>, owner: string): AgentDetail['profile'] {
  const days = 30, since = Date.now() - days * 24 * 3600_000;
  const rows = db.prepare('SELECT * FROM sessions WHERE agent_key = ? AND COALESCE(last_event_at, started_at) >= ? ORDER BY COALESCE(last_event_at, started_at) DESC').all(key, since) as Row[];
  const ids = rows.map((r) => r.id), ph = ids.map(() => '?').join(',');
  const segs = ids.length ? (db.prepare(`SELECT kind, SUM(end - start) ms, COUNT(*) n FROM segments WHERE session_id IN (${ph}) GROUP BY kind`).all(...ids) as Row[]) : [];
  const seg = (k: string) => segs.find((g) => g.kind === k) ?? { ms: 0, n: 0 };
  const closed = rows.filter((r) => !live.has(r.id) && r.stamp);
  // Projects with no GitHub remote can't ship or open a review, so a saved commit is as delivered as it gets there.
  const localOnly = new Set((db.prepare('SELECT id FROM projects WHERE remote IS NULL AND gh_full IS NULL').all() as Row[]).map((r) => r.id));
  const isDelivered = (r: Row) => r.stamp === 'shipped' || r.stamp === 'review' || (r.stamp === 'saved' && localOnly.has(r.project_id));
  const finished = closed.filter((r) => r.stamp !== 'chat');
  const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + (f(r) || 0), 0);
  return {
    days,
    shifts: rows.length,
    finished: finished.length,
    delivered: finished.filter(isDelivered).length,
    shipped: finished.filter((r) => r.stamp === 'shipped').length,
    scrapped: finished.filter((r) => r.stamp === 'scrapped' || r.stamp === 'unfinished').length,
    saves: sum((r) => r.commits),
    workMs: seg('work').ms || 0,
    interruptions: (seg('wait').n || 0) + sum((r) => r.asks),
    waitedMs: seg('wait').ms || 0,
    costUsd: sum((r) => costOf(db, r).usd),
    checksOk: sum((r) => r.tests_ok),
    checksFail: sum((r) => r.tests_fail),
    recent: rows.slice(0, 5).map((r) => ({ id: r.id, title: toSessionView(db, r, live.get(r.id), Date.now(), owner).title, ask: r.last_prompt ?? r.first_prompt ?? null, stamp: live.has(r.id) ? null : r.stamp ?? null, live: live.has(r.id), at: r.ended_at ?? r.last_event_at ?? null })),
  };
}

export function dayView(db: Db, state: StateView, live: Map<string, LiveEntry>, date: string): DayView {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime(), end = start + 24 * 3600_000;
  const now = Date.now();
  const segs = db.prepare('SELECT session_id, start, end, kind FROM segments WHERE end > ? AND start < ? ORDER BY start').all(start, end) as Row[];
  const ids = [...new Set(segs.map((g) => g.session_id))];
  const ph = ids.map(() => '?').join(',');
  const rows = ids.length ? (db.prepare(`SELECT * FROM sessions WHERE id IN (${ph}) AND project_id IS NOT NULL`).all(...ids) as Row[]) : [];
  const marks = ids.length ? (db.prepare(`SELECT session_id, ts, kind FROM events WHERE session_id IN (${ph}) AND ts BETWEEN ? AND ? AND kind IN ('m_commit','m_test_ok','m_test_fail','m_pr')`).all(...ids, start, end) as Row[]) : [];
  const lanes = rows.map((r) => {
    const v = toSessionView(db, r, live.get(r.id), now, state.town.owner);
    return {
      session: v,
      segments: segs.filter((g) => g.session_id === r.id)
        .map((g) => ({ start: Math.max(start, g.start), end: Math.min(end, g.kind === 'idle' ? Math.min(g.end, g.start + AWAY_AFTER_MS) : g.end), kind: g.kind }))
        .filter((g) => g.end > g.start),
      marks: marks.filter((k) => k.session_id === r.id).map((k) => ({ ts: k.ts, kind: k.kind })),
    };
  }).filter((l) => l.segments.length).sort((a, b) => a.segments[0].start - b.segments[0].start);
  let waited = 0, crewMs = 0;
  let longest: DayView['stats']['longestWait'] = null;
  for (const l of lanes) for (const g of l.segments) {
    const ms = g.end - g.start;
    if (g.kind === 'wait') { waited += ms; if (!longest || ms > longest.ms) longest = { agent: l.session.agent.title, ms, at: g.start }; }
    if (g.kind === 'work') crewMs += ms;
  }
  const pk = peakOf([...sessionIntervals(db, start, end).values()].flat());
  const closed = lanes.filter((l) => l.session.status === 'ended' && (l.session.endedAt ?? 0) >= start && (l.session.endedAt ?? 0) < end);
  return {
    date, start, end, lanes,
    stats: {
      waitedMs: waited, longestWait: longest, crewMs, crew: lanes.length, projects: new Set(lanes.map((l) => l.session.projectId)).size,
      peak: pk.peak, peakAt: pk.at,
      shipped: closed.filter((l) => l.session.stamp === 'shipped').length, closed: closed.length,
      unfinished: closed.filter((l) => l.session.stamp === 'unfinished').length, scrapped: closed.filter((l) => l.session.stamp === 'scrapped').length,
      bricks: lanes.reduce((n, l) => n + l.session.bricks, 0), costUsd: lanes.reduce((n, l) => n + l.session.costUsd, 0),
    },
  };
}

export function wrappedView(db: Db, state: StateView, month: string): WrappedView {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1).getTime(), end = new Date(y, m, 1).getTime();
  const rows = db.prepare('SELECT * FROM sessions WHERE project_id IS NOT NULL AND started_at >= ? AND started_at < ?').all(start, end) as Row[];
  const byAgent = new Map<string, { rows: Row[]; shipped: number; scrapped: number; tokens: number }>();
  for (const r of rows) {
    const k = r.agent_key || agentKey(r);
    const e = byAgent.get(k) ?? { rows: [], shipped: 0, scrapped: 0, tokens: 0 };
    e.rows.push(r); e.tokens += tokensOf(r);
    if (r.stamp === 'shipped') e.shipped++;
    if (r.stamp === 'scrapped' || r.stamp === 'unfinished') e.scrapped++;
    byAgent.set(k, e);
  }
  const best = [...byAgent.values()].sort((a, b) => b.shipped - a.shipped || b.tokens - a.tokens)[0];
  const work = db.prepare('SELECT start, end, kind FROM segments WHERE start >= ? AND start < ?').all(start, end) as Row[];
  const hours = new Array(24).fill(0);
  for (const g of work) if (g.kind === 'work') hours[new Date(g.start).getHours()] += g.end - g.start;
  const busiest = hours.some((h) => h > 0) ? hours.indexOf(Math.max(...hours)) : null;
  const pk = peakOf([...sessionIntervals(db, start, end).values()].flat());
  const newBuildings = (db.prepare('SELECT COUNT(*) n FROM (SELECT project_id, MIN(started_at) first FROM sessions WHERE project_id IS NOT NULL GROUP BY project_id) WHERE first >= ? AND first < ?').get(start, end) as Row).n;
  const names = new Map(state.projects.map((p) => [p.id, p.name]));
  return {
    month,
    label: new Date(start).toLocaleString('en', { month: 'long', year: 'numeric' }),
    mvp: best ? { agent: agentOf(best.rows[0]), shipped: best.shipped, scrapped: best.scrapped, bricks: Math.round(best.tokens / BRICK), project: names.get(best.rows[0].project_id) ?? null } : null,
    peak: pk.peak, peakAt: pk.at,
    stats: {
      shifts: rows.length,
      shipped: rows.filter((r) => r.stamp === 'shipped').length,
      graveyard: rows.filter((r) => r.stamp === 'scrapped' || r.stamp === 'unfinished').length,
      waitedMs: work.filter((g) => g.kind === 'wait').reduce((n, g) => n + (g.end - g.start), 0),
      busiestHour: busiest,
      bricks: Math.round(rows.reduce((n, r) => n + tokensOf(r), 0) / BRICK),
      newBuildings,
      costUsd: rows.reduce((n, r) => n + costOf(db, r).usd, 0),
    },
  };
}
