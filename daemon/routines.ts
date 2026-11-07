import fs from 'node:fs';
import type { Db, Row } from './db.ts';
import { isRoutineKey } from './identity.ts';
import type { RoutineView, SessionView } from './types.ts';

/*
 * Scheduled jobs: headless `claude -p` runs (cron, launchd, scripts). Every run of the same job in the
 * same project is one character (see routineKey). Between runs that character sleeps beside its
 * building; a run wakes it up.
 */

const DAY = 24 * 3600_000;
/** Runs this close together are one wake-up (retries, a batch of variants). */
export const BURST_MS = 15 * 60_000;
/** A job that hasn't run in this long has left town, unless it usually runs less often than that. */
const KEEP_MS = 14 * DAY;
const MAX_KEEP_MS = 45 * DAY;

/** Older transcripts were read before the entrypoint was recorded: peek at their first lines once. */
export function backfillEntrypoints(db: Db) {
  const rows = db.prepare("SELECT id, transcript FROM sessions WHERE entrypoint IS NULL AND transcript IS NOT NULL").all() as Row[];
  if (!rows.length) return 0;
  const set = db.prepare('UPDATE sessions SET entrypoint = ?, agent_key = CASE WHEN ? = \'sdk-cli\' THEN NULL ELSE agent_key END WHERE id = ?');
  let headless = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      let ep = '';
      try {
        const fd = fs.openSync(r.transcript, 'r');
        try {
          const buf = Buffer.alloc(32 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          ep = buf.subarray(0, n).toString('utf8').match(/"entrypoint"\s*:\s*"([^"]+)"/)?.[1] ?? '';
        } finally { fs.closeSync(fd); }
      } catch {}
      if (ep === 'sdk-cli') headless++;
      set.run(ep, ep, r.id); // '' = looked, nothing there
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return headless;
}

/** Start times of separate wake-ups (bursts collapsed), oldest first. */
export function wakeStarts(starts: number[]): number[] {
  const out: number[] = [];
  for (const t of [...starts].sort((a, b) => a - b)) if (!out.length || t - out[out.length - 1] > BURST_MS) out.push(t);
  return out;
}

/** Typical gap between wake-ups (median), and whether it's regular enough to guess the next one. */
export function cadence(wakes: number[]): { intervalMs: number | null; regular: boolean } {
  if (wakes.length < 2) return { intervalMs: null, regular: false };
  const gaps = wakes.slice(1).map((t, i) => t - wakes[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // regular: most gaps within 35% of the median (cron-like), or just one gap to go on
  const close = gaps.filter((g) => Math.abs(g - median) <= median * 0.35).length;
  return { intervalMs: median, regular: gaps.length === 1 || close / gaps.length >= 0.6 };
}

export function nextRun(lastWake: number | null, c: { intervalMs: number | null; regular: boolean }, now: number): number | null {
  if (!lastWake || !c.intervalMs || !c.regular) return null;
  let next = lastWake + c.intervalMs;
  if (next < now - c.intervalMs) return null; // missed a couple: don't pretend we know
  while (next < now - BURST_MS) next += c.intervalMs;
  return next;
}

/** Every scheduled job still around, awake or asleep. `views` are the current session views (for live runs). */
export function routinesView(db: Db, views: SessionView[], toView: (r: Row) => SessionView, now = Date.now()): RoutineView[] {
  const rows = db.prepare("SELECT * FROM sessions WHERE agent_key LIKE '%#routine:%' AND project_id IS NOT NULL AND COALESCE(started_at, last_event_at) >= ? ORDER BY COALESCE(started_at, last_event_at)")
    .all(now - MAX_KEEP_MS) as Row[];
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    if (!isRoutineKey(r.agent_key)) continue;
    const list = byKey.get(r.agent_key) ?? [];
    list.push(r);
    byKey.set(r.agent_key, list);
  }
  const liveByKey = new Map<string, SessionView>();
  for (const v of views) if (v.status !== 'ended' && isRoutineKey(v.agent.key)) liveByKey.set(v.agent.key, v);
  const out: RoutineView[] = [];
  for (const [key, runs] of byKey) {
    const last = runs[runs.length - 1];
    const lastAt = last.started_at ?? last.last_event_at ?? null;
    const wakes = wakeStarts(runs.map((r) => r.started_at ?? r.last_event_at).filter(Boolean));
    const c = cadence(wakes);
    const liveView = liveByKey.get(key) ?? null;
    const keep = Math.min(MAX_KEEP_MS, Math.max(KEEP_MS, (c.intervalMs ?? 0) * 3));
    if (!liveView && (!lastAt || now - lastAt > keep)) continue;
    const lastView = liveView ?? toView(last);
    const ended = runs.filter((r) => r.id !== liveView?.id).at(-1);
    const endedView = ended ? (ended === last ? lastView : toView(ended)) : null;
    out.push({
      key,
      projectId: last.project_id,
      agent: lastView.agent,
      title: lastView.title,
      prompt: last.first_prompt ?? null,
      state: liveView ? 'awake' : 'asleep',
      liveSessionId: liveView?.id ?? null,
      lastSessionId: last.id,
      runs: wakes.filter((t) => t >= now - 30 * DAY).length,
      lastRunAt: lastAt,
      lastEndedAt: endedView?.endedAt ?? null,
      lastStamp: endedView?.stamp ?? null,
      lastOutcome: endedView?.outcome ?? null,
      intervalMs: c.intervalMs,
      nextAt: liveView ? null : nextRun(wakes.at(-1) ?? null, c, now),
    });
  }
  return out.sort((a, b) => Number(b.state === 'awake') - Number(a.state === 'awake') || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
}
