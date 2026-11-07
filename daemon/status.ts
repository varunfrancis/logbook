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

/** Building height: grows with lifetime tokens on a log scale. 100k ≈ 3 floors, 1M ≈ 5, 10M ≈ 7. */
export function floorsFor(tokens: number): number {
  if (tokens <= 0) return 1;
  return Math.max(1, Math.min(10, 1 + Math.round(Math.log10(Math.max(tokens, 1e4) / 1e4) * 2)));
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
