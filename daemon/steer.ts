import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import type { LiveEntry } from './live.ts';

/*
 * Messages to an agent working in your terminal, typed in the town. Swarmville can't type into a terminal it didn't open,
 * so the message waits here and rides along with the agent's next step: the hook after their next tool call (or your next
 * prompt) hands it to Claude as added context. The hook only asks the daemon when steer.pending exists, so steps don't wait otherwise.
 */

/** Messages older than this that never reached the agent are dropped: the moment they were about has passed. */
const STALE_MS = 6 * 3600_000;

export type Steer = { at: number; text: string; delivered: boolean };

export function addSteer(db: Db, sessionId: string, text: string, now = Date.now()): number | null {
  const clean = text.replace(/\r\n?/g, '\n').trim().slice(0, 4000);
  if (!clean) return null;
  return Number(db.prepare('INSERT INTO steers(session_id, text, created_at) VALUES(?, ?, ?)').run(sessionId, clean, now).lastInsertRowid);
}

/** What you've sent this agent from the town lately, oldest first, and whether each has reached them yet. */
export function steersFor(db: Db, sessionId: string, now = Date.now()): Steer[] {
  return (db.prepare('SELECT text, created_at, delivered_at FROM steers WHERE session_id = ? AND created_at > ? ORDER BY created_at').all(sessionId, now - 24 * 3600_000) as Row[])
    .map((r) => ({ at: r.created_at, text: r.text, delivered: r.delivered_at != null }));
}

/** The hook reply text for a working agent with messages waiting, marking them delivered; null when there are none. */
export function steerContext(db: Db, p: any, owner: string, now = Date.now()): string | null {
  const event = p?.hook_event_name;
  if ((event !== 'PostToolUse' && event !== 'UserPromptSubmit') || typeof p.session_id !== 'string') return null;
  const rows = db.prepare('SELECT id, text FROM steers WHERE session_id = ? AND delivered_at IS NULL AND created_at > ? ORDER BY created_at').all(p.session_id, now - STALE_MS) as Row[];
  if (!rows.length) return null;
  const mark = db.prepare('UPDATE steers SET delivered_at = ? WHERE id = ?');
  for (const r of rows) mark.run(now, r.id);
  return [
    `${rows.length === 1 ? 'A message' : 'Messages'} from ${owner}, the person you work for, sent from Swarmville (their dashboard) while you were working:`,
    ...rows.map((r) => `> ${String(r.text).replace(/\n/g, '\n> ')}`),
    'Take it into account from now on. Acknowledge it in one short line, then carry on (or change course if it asks you to).',
  ].join('\n');
}

/** True when an agent working right now has a message from you that hasn't reached them yet. */
export function steerPending(db: Db, live: Map<string, LiveEntry>, now = Date.now()): boolean {
  const ids = [...live.keys()];
  if (!ids.length) return false;
  return !!db.prepare(`SELECT 1 FROM steers WHERE delivered_at IS NULL AND created_at > ? AND session_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`).get(now - STALE_MS, ...ids);
}

let last: boolean | null = null;
export function writeSteerMarker(dir: string, pending: boolean) {
  if (pending === last) return;
  last = pending;
  const file = path.join(dir, 'steer.pending');
  try { if (pending) fs.writeFileSync(file, '1'); else fs.rmSync(file, { force: true }); } catch {}
}
