import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import type { LiveEntry } from './live.ts';
import { agentOf, costOf, startOfDay } from './state.ts';
import { sizeFor } from './outcome.ts';
import type { Agent, CrewDay, CrewNote, Size } from './types.ts';

/*
 * Today's crews: everyone who worked on a project today (its resident, helpers and branch agents), judged together.
 * The web turns these totals into medals; the daemon also raises "needs a word" when a crew had a rough day,
 * and keeps the manager's notes that every agent on that project is told about.
 */

const POINTS: Record<Size, number> = { tweak: 1, fix: 2, feature: 3, overhaul: 5 };
const DAY_MS = 24 * 3600_000;
const isoDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Projects with no GitHub remote can't ship or open a review, so a saved commit is as delivered as it gets there. */
function localOnlyProjects(db: Db) {
  return new Set((db.prepare('SELECT id FROM projects WHERE remote IS NULL AND gh_full IS NULL').all() as Row[]).map((r) => r.id));
}

/** How a shift turned out. Closed shifts have a stamp from git; a shift still open only counts once its PR exists. */
function outcomeOf(r: Row, live: boolean): 'delivered' | 'kept' | 'lost' | 'chat' | null {
  const stamp = live ? (r.pr_state === 'merged' ? 'shipped' : r.pr_url && r.pr_state !== 'closed' ? 'review' : null) : r.stamp;
  if (!stamp) return null;
  if (stamp === 'shipped' || stamp === 'review') return 'delivered';
  if (stamp === 'saved') return 'kept';
  if (stamp === 'scrapped' || stamp === 'unfinished') return 'lost';
  return 'chat';
}

const ADVICE = {
  lost: 'Finish what you start: commit your work as you go, and if a job turns out to be the wrong idea, stop and tell me instead of leaving half-done changes behind.',
  stuck: 'When the same error comes back twice, stop and tell me what is going wrong instead of trying the same fix again.',
  checks: 'Run the checks before you say you are done, and fix anything that fails before moving on.',
  delivery: 'Take each job all the way: commit, push and open a pull request unless I say otherwise.',
};

type Dismissed = { date: string; ids: string[] };

export function crewsToday(db: Db, rows: Row[], live: Map<string, LiveEntry>, names: Map<string, string>, now = Date.now()): CrewDay[] {
  const today = startOfDay(new Date(now));
  const localOnly = localOnlyProjects(db);
  const byProject = new Map<string, Row[]>();
  for (const r of rows) if (r.project_id && (r.last_event_at ?? 0) >= today) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
  const ids = [...byProject.values()].flat().map((r) => r.id);
  const segs = ids.length
    ? (db.prepare(`SELECT session_id, kind, MIN(end, ?) - MAX(start, ?) ms FROM segments WHERE end > ? AND session_id IN (${ids.map(() => '?').join(',')})`).all(now, today, today, ...ids) as Row[])
    : [];
  const dismissed = kvGet<Dismissed>(db, 'crews.dismissed', { date: '', ids: [] });
  const quiet = new Set(dismissed.date === isoDay(now) ? dismissed.ids : []);
  for (const n of db.prepare('SELECT project_id FROM notes WHERE created_at >= ? AND removed_at IS NULL').all(today) as Row[]) quiet.add(n.project_id);

  const out: CrewDay[] = [];
  for (const [projectId, list] of byProject) {
    const mine = new Set(list.map((r) => r.id));
    const seg = (kind: string) => segs.filter((g) => mine.has(g.session_id) && g.kind === kind);
    const agents = new Map<string, Agent>();
    for (const r of [...list].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))) {
      const a = agentOf(r);
      if (![...agents.values()].some((x) => x.title === a.title)) agents.set(a.key, a);
    }
    const c: CrewDay = {
      projectId, name: names.get(projectId) ?? path.basename(projectId),
      agents: [...agents.values()].sort((a, b) => Number(b.role === 'resident') - Number(a.role === 'resident')),
      shifts: list.length, finished: 0, delivered: 0, points: 0, sizes: {}, lost: 0,
      workMs: seg('work').reduce((n, g) => n + Math.max(0, g.ms), 0),
      waitedMs: seg('wait').reduce((n, g) => n + Math.max(0, g.ms), 0),
      interruptions: seg('wait').length + list.reduce((n, r) => n + (r.asks || 0), 0),
      costUsd: list.reduce((n, r) => n + costOf(db, r).usd, 0),
      checksOk: list.reduce((n, r) => n + (r.tests_ok || 0), 0),
      checksFail: list.reduce((n, r) => n + (r.tests_fail || 0), 0),
      stuck: 0, firstDeliveredAt: null, flag: null,
    };
    let stuckOn: string | null = null;
    for (const r of list) {
      if ((r.err_count ?? 0) >= 3 && (r.err_at ?? 0) >= today) { c.stuck++; stuckOn ??= String(r.err_sig ?? '').replace(/^[^:]+:\s*/, '').slice(0, 60) || null; }
      let o = outcomeOf(r, live.has(r.id));
      if (o === 'kept' && localOnly.has(projectId)) o = 'delivered';
      if (!o || o === 'chat') continue;
      c.finished++;
      if (o === 'lost') c.lost++;
      if (o !== 'delivered') continue;
      c.delivered++;
      const size = sizeFor(r.lines_added, r.lines_removed);
      c.points += size ? POINTS[size] : 1;
      if (size) c.sizes[size] = (c.sizes[size] ?? 0) + 1;
      const at = r.pr_merged_at ?? r.ended_at ?? r.last_event_at ?? now;
      c.firstDeliveredAt = Math.min(c.firstDeliveredAt ?? at, at);
    }
    if (!quiet.has(projectId)) {
      const reasons: string[] = [], advice: string[] = [];
      if (c.lost >= 2) { reasons.push(`${c.lost} jobs scrapped or left unfinished`); advice.push(ADVICE.lost); }
      if (c.stuck) { reasons.push(stuckOn ? `stuck in a loop on “${stuckOn}”` : 'stuck in a loop'); advice.push(ADVICE.stuck); }
      if (c.checksFail >= 3 && c.checksFail > c.checksOk) { reasons.push(`checks failed ${c.checksFail} times`); advice.push(ADVICE.checks); }
      if (c.finished >= 3 && c.delivered / c.finished < 1 / 3) { reasons.push(`only ${c.delivered} of ${c.finished} finished jobs delivered`); advice.push(ADVICE.delivery); }
      if (reasons.length) c.flag = { reasons, draft: advice.join(' ') };
    }
    if (c.finished || c.workMs >= 60_000 || c.costUsd >= 0.01) out.push(c); // a window opened and closed without doing anything isn't a crew
  }
  return out.sort((a, b) => b.points - a.points || b.finished - a.finished || a.name.localeCompare(b.name));
}

/** "It's fine": hides a crew's flag for the rest of today. */
export function dismissFlag(db: Db, projectId: string, now = Date.now()) {
  const cur = kvGet<Dismissed>(db, 'crews.dismissed', { date: '', ids: [] });
  const date = isoDay(now);
  kvSet(db, 'crews.dismissed', { date, ids: [...new Set([...(cur.date === date ? cur.ids : []), projectId])] });
}

/** "Let it go": a finished job you've decided not to pick back up, taken off the Crew tab's Today list for good. */
export function letGo(db: Db, sessionId: string, undo = false) {
  const cur = kvGet<string[]>(db, 'today.letGo', []);
  const next = undo ? cur.filter((id) => id !== sessionId) : [...new Set([...cur, sessionId])];
  kvSet(db, 'today.letGo', next.slice(-500)); // older entries have long since aged off the list anyway
}

export const letGoIds = (db: Db) => kvGet<string[]>(db, 'today.letGo', []);

// ---------- the manager's notes ----------

export function addNote(db: Db, projectId: string, text: string, now = Date.now()): number | null {
  const clean = text.trim().slice(0, 1200);
  if (!clean || !(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId))) return null;
  return Number(db.prepare('INSERT INTO notes(project_id, text, created_at) VALUES(?, ?, ?)').run(projectId, clean, now).lastInsertRowid);
}

export function removeNote(db: Db, id: number, now = Date.now()) {
  db.prepare('UPDATE notes SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now, id);
}

/** Finished and delivered jobs for a project between two times, from closed shifts. */
function record(db: Db, projectId: string, from: number, to: number, localOnly: Set<string>) {
  const rows = db.prepare("SELECT stamp FROM sessions WHERE project_id = ? AND stamp IS NOT NULL AND stamp != 'chat' AND COALESCE(ended_at, last_event_at) >= ? AND COALESCE(ended_at, last_event_at) < ?").all(projectId, from, to) as Row[];
  const delivered = rows.filter((r) => r.stamp === 'shipped' || r.stamp === 'review' || (r.stamp === 'saved' && localOnly.has(projectId))).length;
  return { finished: rows.length, delivered };
}

export function notesView(db: Db, names: Map<string, string>, now = Date.now()): CrewNote[] {
  const rows = db.prepare('SELECT n.*, (SELECT COUNT(*) FROM note_reach r WHERE r.note_id = n.id) reached FROM notes n WHERE removed_at IS NULL ORDER BY created_at DESC').all() as Row[];
  const localOnly = localOnlyProjects(db);
  return rows.map((n) => ({
    id: n.id, projectId: n.project_id, projectName: names.get(n.project_id) ?? path.basename(n.project_id),
    text: n.text, createdAt: n.created_at, reached: n.reached,
    before: record(db, n.project_id, n.created_at - 7 * DAY_MS, n.created_at, localOnly),
    since: record(db, n.project_id, n.created_at, now + 1, localOnly),
  }));
}

/**
 * The hook reply that hands a session its project's notes. A starting session (also after /clear or a compaction,
 * which forget earlier context) gets all of them; a session already at work gets only the ones it hasn't seen,
 * on its next prompt.
 */
export function noteContext(db: Db, p: any, owner: string, now = Date.now()): { event: string; text: string } | null {
  const event = p?.hook_event_name;
  if ((event !== 'SessionStart' && event !== 'UserPromptSubmit') || typeof p.session_id !== 'string') return null;
  const s = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(p.session_id) as Row | undefined;
  if (!s?.project_id) return null;
  const notes = db.prepare(`SELECT id, text FROM notes WHERE project_id = ? AND removed_at IS NULL
    ${event === 'UserPromptSubmit' ? 'AND id NOT IN (SELECT note_id FROM note_reach WHERE session_id = ?)' : ''} ORDER BY created_at`)
    .all(...(event === 'UserPromptSubmit' ? [s.project_id, p.session_id] : [s.project_id])) as Row[];
  if (!notes.length) return null;
  for (const n of notes) db.prepare('INSERT OR IGNORE INTO note_reach(note_id, session_id, at) VALUES(?, ?, ?)').run(n.id, p.session_id, now);
  const fresh = event === 'UserPromptSubmit';
  const text = [
    `${fresh ? 'New note' : 'Standing notes'} from ${owner}, the person you work for, about how work on this project should go (sent through Swarmville, their dashboard).`,
    'Follow these for the rest of this session; they apply to every task here:',
    ...notes.map((n) => `- ${n.text}`),
    fresh ? 'Briefly acknowledge the note in one line, then carry on.' : 'No need to mention these unless they are relevant.',
  ].join('\n');
  return { event, text };
}

/**
 * True when a working agent hasn't seen one of its project's notes yet. The hook script checks for a marker
 * file before each prompt, so prompts only wait for the daemon when there's actually something to hand over.
 */
export function notesPending(db: Db, live: Map<string, LiveEntry>): boolean {
  const ids = [...live.keys()];
  if (!ids.length) return false;
  const r = db.prepare(`SELECT 1 FROM sessions s JOIN notes n ON n.project_id = s.project_id AND n.removed_at IS NULL
    WHERE s.id IN (${ids.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM note_reach r WHERE r.note_id = n.id AND r.session_id = s.id) LIMIT 1`).get(...ids);
  return !!r;
}

let lastPending: boolean | null = null;
export function writePendingMarker(dir: string, pending: boolean) {
  if (pending === lastPending) return;
  lastPending = pending;
  const file = path.join(dir, 'notes.pending');
  try { if (pending) fs.writeFileSync(file, '1'); else fs.rmSync(file, { force: true }); } catch {}
}
