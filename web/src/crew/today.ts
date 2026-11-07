import type { SessionView } from '../../../daemon/types.ts';

/*
 * The Crew tab's Today section: what still needs a call from you, and what got done.
 * Kept free of React so the rules can be tested on their own.
 */

/** How long an undecided job stays on the list before it drops off by itself. */
export const DECIDE_DAYS = 7;

export type TodaySession = Pick<SessionView, 'id' | 'status' | 'stamp' | 'prState' | 'prUrl' | 'endedAt' | 'lastEventAt' | 'kind' | 'scheduled' | 'projectId'>;

/** "#441" from a pull request link. */
export const prNum = (url: string | null) => (url ? `#${url.split('/').pop()}` : null);

export const finishedAt =(s: TodaySession) => (s.status === 'ended' ? s.endedAt : s.lastEventAt) ?? 0;

const startOfDay = (now: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Done = merged and live. A background job whose review merged counts too, even while its session sits open. */
export function isShipped(s: TodaySession): boolean {
  if (s.status === 'running' || s.status === 'needs_input') return false;
  return s.stamp === 'shipped' || s.prState === 'merged';
}

export const shippedToday = (s: TodaySession, now = Date.now()) => isShipped(s) && finishedAt(s) >= startOfDay(now);

/** Why a finished job still needs you, or null if it doesn't. */
export function needsDecision(s: TodaySession, now = Date.now()): 'review' | 'unfinished' | 'scrapped' | null {
  if (s.scheduled || isShipped(s) || finishedAt(s) < now - DECIDE_DAYS * 24 * 3600_000) return null;
  const openReview = !!s.prUrl && s.prState === 'open';
  if (s.status === 'ended') {
    if (s.stamp === 'review') return s.prState === 'closed' ? null : 'review';
    if (s.stamp === 'unfinished' || s.stamp === 'scrapped') return s.stamp;
    return null;
  }
  // A background job that opened a review and stopped: the session stays open, but the next step is yours.
  if (s.status === 'idle' && s.kind === 'bg' && openReview) return 'review';
  return null;
}

export type TodayView<S extends TodaySession> = {
  decide: { s: S; why: 'review' | 'unfinished' | 'scrapped' }[];
  done: { projectId: string; items: S[] }[];
  shipped: number;
  chats: S[];
};

export function todayView<S extends TodaySession>(sessions: S[], letGo: ReadonlySet<string>, now = Date.now()): TodayView<S> {
  const day0 = startOfDay(now);
  const decide = sessions
    .filter((s) => !letGo.has(s.id))
    .map((s) => ({ s, why: needsDecision(s, now) }))
    .filter((x): x is { s: S; why: 'review' | 'unfinished' | 'scrapped' } => x.why !== null)
    .sort((a, b) => finishedAt(b.s) - finishedAt(a.s));
  const byProject = new Map<string, S[]>();
  for (const s of sessions) {
    if (!shippedToday(s, now)) continue;
    const k = s.projectId ?? '';
    byProject.set(k, [...(byProject.get(k) ?? []), s]);
  }
  const done = [...byProject.entries()]
    .map(([projectId, items]) => ({ projectId, items: items.sort((a, b) => finishedAt(b) - finishedAt(a)) }))
    .sort((a, b) => b.items.length - a.items.length);
  const chats = sessions.filter((s) => s.status === 'ended' && s.stamp === 'chat' && finishedAt(s) >= day0);
  return { decide, done, shipped: done.reduce((n, p) => n + p.items.length, 0), chats };
}
