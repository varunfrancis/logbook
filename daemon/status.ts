import type { Row } from './db.ts';
import type { LiveEntry } from './live.ts';
import type { ProjectState, SessionStatus } from './types.ts';
import { AWAY_AFTER_MS, BG_AWAY_AFTER_MS, CONSTRUCTION_MS, LIVE_GRACE_MS, QUIET_AFTER_MS } from './config.ts';
import { jobVerdict, type JobVerdict } from './transcripts.ts';

const HEADLESS_QUIET_MS = 3 * 60_000;

/**
 * Status comes from three sources, strongest first:
 * hook events (exact, real time) > the ~/.claude/sessions registry (alive pid + busy/idle) > transcripts (history).
 */
export function sessionStatus(s: Row, live: LiveEntry | undefined, now: number): SessionStatus {
  const hookFresh = !!s.hook_state_at && now - Math.max(s.hook_state_at, s.last_event_at ?? 0) < LIVE_GRACE_MS;
  if (!live) {
    // a headless run (cron) may never register a live process or fire hooks: trust a transcript that is still mid-turn
    if (s.entrypoint === 'sdk-cli' && s.current_action && now - (s.last_event_at ?? 0) < HEADLESS_QUIET_MS && s.hook_state !== 'ended') return 'running';
    if (hookFresh && s.hook_state && s.hook_state !== 'ended') return s.hook_state === 'needs_input' ? 'needs_input' : s.hook_state === 'running' ? 'running' : 'idle';
    return 'ended';
  }
  if (s.hook_state === 'needs_input') return 'needs_input';
  if (live.status === 'waiting') return 'needs_input';
  if (live.status === 'busy' || live.status === 'running') return 'running';
  if (s.hook_state === 'running' && hookFresh) return 'running';
  // A background job that reported `result:` or `failed:` has delivered: it clocks out rather than waiting at the café
  // until someone deletes the job. A reply to it brings it straight back.
  if (live.kind === 'bg' && finishedJob(s)) return 'ended';
  return 'idle';
}

/** The closing line of a session's last reply, from the parsed column or, for rows read before it existed, the stored reply. */
export function verdictOf(s: Row): JobVerdict | null {
  return s.job_verdict != null ? (s.job_verdict || null) : jobVerdict(s.outcome);
}
const finishedJob = (s: Row) => { const v = verdictOf(s); return v === 'result' || v === 'failed'; };

/**
 * Idle long enough to stop counting as on a coffee break. Terminals wait 2 h for you; a background job that
 * hasn't asked for anything waits 30 min, since nobody is sitting at it.
 */
export function isAway(s: Row, live: LiveEntry | undefined, now: number): boolean {
  const limit = live?.kind === 'bg' && verdictOf(s) !== 'needs' ? BG_AWAY_AFTER_MS : AWAY_AFTER_MS;
  return now - (s.last_event_at ?? 0) > limit;
}

/** How much a project amounts to: code written and commits landed, plus a little for read-heavy work that ships no lines (2k tokens ≈ 1 line). */
export function scopeOf(a: { lines: number; commits: number; tokens: number }): number {
  return Math.max(0, a.lines) + Math.max(0, a.commits) * 150 + Math.max(0, a.tokens) / 2000;
}

/** Building size, 0..1, relative to the biggest project in town. Every dimension grows with the cube root, so a building's volume tracks its scope. */
export function buildingSize(scope: number, maxScope: number): number {
  if (maxScope <= 0 || scope <= 0) return 0;
  return Math.min(1, Math.cbrt(scope / maxScope));
}

export const MAX_FLOORS = 10;

/** Building height from its size: 1 floor for a sketch, MAX_FLOORS for the biggest project in town. */
export function floorsFor(size: number): number {
  return Math.max(1, Math.min(MAX_FLOORS, Math.round(size * MAX_FLOORS)));
}

export function projectState(p: { root: string | null; sessionsTotal: number; lastActivity: number | null }, crew: { status: SessionStatus; away?: boolean }[], now: number): ProjectState {
  if (crew.some((s) => s.status === 'needs_input')) return 'needs';
  // Crew on site means someone is in the building working. Agents on a coffee break are at the café, so their project shows its usual stage.
  if (crew.some((s) => s.status === 'running')) return 'site';
  if (!p.root && p.sessionsTotal === 0) return 'lot';
  const age = p.lastActivity ? now - p.lastActivity : Infinity;
  if (age < CONSTRUCTION_MS) return 'construction';
  if (age < QUIET_AFTER_MS) return 'recent';
  return 'done';
}
