import type { AgentProfile } from '../../../daemon/types.ts';
import { mins, money } from '../copy.ts';

export type Grade = 'good' | 'ok' | 'bad' | 'none';
export type Score = { label: string; value: string; note: string; grade: Grade; help: string };

/** The three numbers you'd judge a teammate on: do they deliver, can they work without you, and are they worth what they cost. */
export function scorecard(p: AgentProfile, api = false): { scores: Score[]; verdict: { grade: Grade; text: string } } {
  const rate = p.finished ? p.delivered / p.finished : null;
  const delivery: Score = rate == null || p.finished < 2
    ? { label: 'Delivers', value: p.finished ? `${p.delivered} of ${p.finished}` : '—', note: p.finished ? 'too few jobs to judge' : 'no finished jobs yet', grade: 'none', help: 'Share of finished jobs that shipped or went for review.' }
    : { label: 'Delivers', value: `${p.delivered} of ${p.finished}`, note: `jobs shipped or in review`, grade: rate >= 0.6 ? 'good' : rate >= 0.3 ? 'ok' : 'bad', help: 'Share of finished jobs that shipped or went for review. Chats that never set out to change anything are left out.' };
  const hours = p.workMs / 3600_000;
  const every = p.interruptions ? p.workMs / p.interruptions : null;
  const independence: Score = hours < 0.25
    ? { label: 'On their own', value: '—', note: 'not enough work yet', grade: 'none', help: 'How long they work before needing you.' }
    : every == null
    ? { label: 'On their own', value: 'Always', note: `never needed you in ${mins(p.workMs)}`, grade: 'good', help: 'How long they work before stopping to ask you something or wait for your OK.' }
    : { label: 'On their own', value: mins(every), note: 'between questions', grade: every >= 60 * 60_000 ? 'good' : every >= 20 * 60_000 ? 'ok' : 'bad', help: 'How long they work before stopping to ask you something or wait for your OK.' };
  const perJob = p.delivered ? p.costUsd / p.delivered : null;
  const perHour = hours >= 0.25 ? p.costUsd / hours : null;
  const cost: Score = perJob != null
    ? { label: 'Cost', value: money(perJob), note: `per job delivered · ${money(p.costUsd)} total`, grade: perJob <= 5 ? 'good' : perJob <= 20 ? 'ok' : 'bad', help: 'What it cost (tokens) for each job that shipped or went for review.' }
    : perHour != null
    ? { label: 'Cost', value: `${money(perHour)}/h`, note: `nothing delivered yet · ${money(p.costUsd)} total`, grade: p.finished >= 2 ? 'bad' : 'none', help: 'Cost per hour of work, until they deliver something.' }
    : { label: 'Cost', value: money(p.costUsd), note: 'spent so far', grade: 'none', help: 'What their work has cost in tokens.' };
  // On the plan the work cost nothing, so there's no cost to judge them on.
  const scores = api ? [delivery, independence, cost] : [delivery, independence];
  const graded = scores.filter((s) => s.grade !== 'none');
  const bad = graded.filter((s) => s.grade === 'bad').length, good = graded.filter((s) => s.grade === 'good').length;
  const verdict = graded.length < 2 ? { grade: 'none' as Grade, text: 'Too early to tell. Check back after a few finished jobs.' }
    : bad >= 2 ? { grade: 'bad' as Grade, text: 'Struggling. Look at what’s going wrong below.' }
    : good >= 2 && !bad ? { grade: 'good' as Grade, text: 'Doing well.' }
    : { grade: 'ok' as Grade, text: mixedText(scores) };
  return { scores, verdict };
}

const STRONG: Record<string, string> = { Delivers: 'Delivers well', 'On their own': 'works well on their own', Cost: 'good value' };
const WEAK: Record<string, string> = { Delivers: 'a lot of their work doesn’t get kept', 'On their own': 'stops to ask you often', Cost: 'costs a lot per job' };

/** A mixed verdict says which part is strong and which isn't, so it doesn't read as contradicting the numbers next to it. */
function mixedText(scores: Score[]): string {
  const strong = scores.filter((s) => s.grade === 'good').map((s) => STRONG[s.label]);
  const weak = scores.filter((s) => s.grade === 'bad' || s.grade === 'ok').map((s) => WEAK[s.label]);
  if (!strong.length || !weak.length) return 'Mixed. Good in places, room to improve.';
  const join = (xs: string[]) => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0];
  const lead = join(strong);
  return `${lead.replace(/^\w/, (c) => c.toUpperCase())}, but ${join(weak)}.`;
}
