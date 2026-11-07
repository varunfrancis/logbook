import type { CrewDay, Size } from '../../../daemon/types.ts';
import { mins, money } from '../copy.ts';

export type MedalId = 'shipped' | 'aim' | 'independent' | 'value' | 'clean';
export type Medal = { id: MedalId; icon: string; label: string; help: string; holder: CrewDay | null; value: string; runnerUp: { crew: CrewDay; value: string } | null };

const SIZE_WORD: Record<Size, [string, string]> = { overhaul: ['overhaul', 'overhauls'], feature: ['feature', 'features'], fix: ['fix', 'fixes'], tweak: ['tweak', 'tweaks'] };
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** "3 jobs (1 feature, 2 fixes)" */
export function jobsText(c: CrewDay): string {
  const parts = (Object.keys(SIZE_WORD) as Size[]).filter((s) => c.sizes[s]).map((s) => `${c.sizes[s]} ${SIZE_WORD[s][c.sizes[s] === 1 ? 0 : 1]}`);
  return `${plural(c.delivered, 'job')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

type Rule = {
  id: MedalId; icon: string; label: string; help: string;
  eligible: (c: CrewDay) => boolean;
  score: (c: CrewDay) => number; // higher wins
  value: (c: CrewDay) => string;
};

const between = (c: CrewDay) => (c.interruptions ? c.workMs / c.interruptions : Infinity);

export const RULES: Rule[] = [
  {
    id: 'shipped', icon: '🏆', label: 'Most shipped', help: 'Most work shipped or sent for review today, bigger jobs counting for more (tweak 1, fix 2, feature 3, overhaul 5).',
    eligible: (c) => c.delivered > 0, score: (c) => c.points, value: jobsText,
  },
  {
    id: 'aim', icon: '🎯', label: 'Best hit rate', help: 'Share of finished jobs that shipped or went for review. Needs 2 finished jobs today.',
    eligible: (c) => c.finished >= 2 && c.delivered > 0, score: (c) => c.delivered / c.finished + c.finished / 1000,
    value: (c) => `${c.delivered} of ${c.finished} finished jobs delivered`,
  },
  {
    id: 'independent', icon: '🧘', label: 'Most independent', help: 'Longest stretch of work between stopping to ask you something or wait for your OK. Needs 15 minutes of work today.',
    eligible: (c) => c.workMs >= 15 * 60_000, score: (c) => (c.interruptions ? between(c) : 1e12 + c.workMs),
    value: (c) => (c.interruptions ? `${mins(between(c))} between questions` : `never needed you in ${mins(c.workMs)}`),
  },
  {
    id: 'value', icon: '💰', label: 'Best value', help: 'Lowest cost for each job shipped or sent for review. Needs 2 finished jobs today.',
    eligible: (c) => c.finished >= 2 && c.delivered > 0, score: (c) => -c.costUsd / c.delivered,
    value: (c) => `${money(c.costUsd / c.delivered)} per delivered job`,
  },
  {
    id: 'clean', icon: '✅', label: 'Cleanest work', help: 'Checks passing, no loops, nothing thrown away. Needs 2 check runs today.',
    eligible: (c) => c.checksOk + c.checksFail >= 2 && c.checksOk > 0,
    score: (c) => c.checksOk / (c.checksOk + c.checksFail) - c.stuck * 0.5 - c.lost * 0.25 + c.checksOk / 1000,
    value: (c) => `${plural(c.checksOk, 'check')} passed${c.checksFail ? `, ${c.checksFail} failed` : ', none failed'}${c.stuck ? ` · looped ${c.stuck}×` : ''}${c.lost ? ` · ${c.lost} scrapped` : ''}`,
  },
];

/** Ties go to whoever got there first. */
const order = (r: Rule) => (a: CrewDay, b: CrewDay) => r.score(b) - r.score(a) || (a.firstDeliveredAt ?? Infinity) - (b.firstDeliveredAt ?? Infinity) || a.name.localeCompare(b.name);

export function medals(crews: CrewDay[]): Medal[] {
  return RULES.map((r) => {
    const ranked = crews.filter(r.eligible).sort(order(r));
    const [first, second] = ranked;
    return { id: r.id, icon: r.icon, label: r.label, help: r.help, holder: first ?? null, value: first ? r.value(first) : '', runnerUp: second ? { crew: second, value: r.value(second) } : null };
  });
}

/** Medals that changed hands since last time (a first holder of the day counts too). */
export function handovers(prev: Map<MedalId, string | null>, next: Medal[]): { medal: Medal; from: string | null }[] {
  const out: { medal: Medal; from: string | null }[] = [];
  for (const m of next) {
    if (!prev.has(m.id)) continue; // first look: nothing to compare against
    const before = prev.get(m.id) ?? null, now = m.holder?.projectId ?? null;
    if (now && now !== before) out.push({ medal: m, from: before });
  }
  return out;
}
