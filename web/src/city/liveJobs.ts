import type { SessionView, StateView } from '../../../daemon/types.ts';

/** The one word the Town's live feed shows for a job. */
export type JobWord = 'Needs you' | 'Stuck' | 'Testing' | 'Building' | 'Planning';

export type LiveJob = { id: string; job: string; word: JobWord; session: SessionView; project: string | null };

/**
 * What an agent is up to, in one word. Once they've changed files, a quick look at another file
 * still counts as Building, so the word doesn't flicker back to Planning mid-job.
 */
export function jobWord(s: Pick<SessionView, 'status' | 'stuck' | 'actionKind' | 'helperActive' | 'filesChanged'>): JobWord {
  if (s.status === 'needs_input') return 'Needs you';
  if (s.stuck) return 'Stuck';
  if (s.actionKind === 'run') return 'Testing';
  if (s.actionKind === 'edit' || s.actionKind === 'delegate' || s.helperActive || s.filesChanged > 0) return 'Building';
  return 'Planning';
}

const machineName = /^[0-9a-f]{6,}$|^[a-z0-9]+-[0-9a-f]{1,3}$|^[a-z0-9]+-f\d+$/i;

/**
 * The job an agent is on, as a short label: the live focus label (rewritten on each new instruction),
 * else Claude Code's session title unless it's a machine name. Shared by the Town feed and the Crew cards.
 */
export function jobLabel(s: Pick<SessionView, 'focus' | 'title'>): string {
  return s.focus ?? (s.title && !machineName.test(s.title) ? s.title : 'Getting started');
}

const ORDER: Record<JobWord, number> = { 'Needs you': 0, Stuck: 1, Testing: 2, Building: 2, Planning: 2 };
/**
 * Jobs agents are on right now: working or waiting on you. Coffee breaks and finished shifts drop
 * off at once. Hands up first, then stuck, then oldest first so rows don't jump around.
 */
export function liveJobs(state: Pick<StateView, 'sessions' | 'projects'>, visible?: Set<string> | null): LiveJob[] {
  const names = new Map(state.projects.map((p) => [p.id, p.name]));
  return state.sessions
    .filter((s) => (s.status === 'running' || s.status === 'needs_input') && !(visible && s.projectId && !visible.has(s.projectId)))
    .map((s) => ({
      id: s.id,
      job: jobLabel(s),
      word: jobWord(s),
      session: s,
      project: s.projectId ? names.get(s.projectId) ?? null : null,
    }))
    .sort((a, b) => ORDER[a.word] - ORDER[b.word] || (a.session.startedAt ?? 0) - (b.session.startedAt ?? 0));
}
