import type { ShipPhase, ShipView } from '../../../daemon/types.ts';

/* "Ship it" progress, kept free of React so the rules can be tested on their own. */

export type TrackStep = { label: string; state: 'ok' | 'now' | 'bad' | 'todo' };

/** The plain steps, ticked from what really happened (commits, the review, its checks). */
export function shipTrack(sh: Pick<ShipView, 'phase' | 'commits' | 'prUrl' | 'onGithub'>): TrackStep[] {
  const saved = sh.commits > 0 || !!sh.prUrl;
  const at: Record<ShipPhase, number> = { working: saved ? 2 : 0, review: 3, checks: 3, failing: 3, ready: 4, live: 5, stopped: saved ? 2 : 0 };
  const labels = sh.onGithub ? ['Finish it', 'Save it', 'Send for review', 'Checks pass', 'You put it live'] : ['Finish it', 'Save it'];
  const i = Math.min(at[sh.phase], labels.length);
  return labels.map((label, k) => ({
    label,
    state: k < i ? 'ok' : k > i ? 'todo' : sh.phase === 'failing' || sh.phase === 'stopped' ? 'bad' : 'now',
  }));
}
