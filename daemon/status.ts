import type { Row } from './db.ts';
import type { LiveEntry } from './live.ts';
import type { ProjectState, SessionStatus } from './types.ts';
import { CONSTRUCTION_MS, LIVE_GRACE_MS, QUIET_AFTER_MS } from './config.ts';

/**
 * Status comes from three sources, strongest first:
 * hook events (exact, real time) > the ~/.claude/sessions registry (alive pid + busy/idle) > transcripts (history).
 */
export function sessionStatus(s: Row, live: LiveEntry | undefined, now: number): SessionStatus {
  const hookFresh = !!s.hook_state_at && now - Math.max(s.hook_state_at, s.last_event_at ?? 0) < LIVE_GRACE_MS;
  if (!live) {
    if (hookFresh && s.hook_state && s.hook_state !== 'ended') return s.hook_state === 'needs_input' ? 'needs_input' : s.hook_state === 'running' ? 'running' : 'idle';
    return 'ended';
  }
  if (s.hook_state === 'needs_input') return 'needs_input';
  if (live.status === 'waiting') return 'needs_input';
  if (live.status === 'busy' || live.status === 'running') return 'running';
  if (s.hook_state === 'running' && hookFresh) return 'running';
  return 'idle';
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
  if (crew.some((s) => s.status === 'running' || (s.status === 'idle' && !s.away))) return 'site';
  if (!p.root && p.sessionsTotal === 0) return 'lot';
  const age = p.lastActivity ? now - p.lastActivity : Infinity;
  if (age < CONSTRUCTION_MS) return 'construction';
  if (age < QUIET_AFTER_MS) return 'recent';
  return 'done';
}
