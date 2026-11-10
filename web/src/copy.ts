import { createContext, useContext } from 'react';
import type { ProjectState, SessionStatus, Size, Stamp } from '../../daemon/types.ts';

/** Plain is the default voice. Technical shows the raw terms for days you want them. */
export type Voice = 'plain' | 'technical';
export const VoiceContext = createContext<Voice>('plain');
export const useVoice = () => useContext(VoiceContext);

/** Claude Code runs on your Claude plan, so by default nothing reads as spent. 'api' shows what the same tokens would cost at API prices. */
export type CostView = 'plan' | 'api';
export const CostContext = createContext<CostView>('plan');
export const useCostView = () => useContext(CostContext);
export const PLAN_NOTE = 'Included in your Claude plan. To see what it would cost at API prices, turn that on in Settings.';
/** A cost as the user has chosen to see it: $0 on the plan, API prices otherwise. */
export const priced = (view: CostView, usd: number) => (view === 'api' ? money(usd) : '$0');

/** What the numbers on screen mean, for hover help. Written for someone who has never seen a terminal. */
export const STAT_HELP = {
  bricks: 'Bricks measure how much work the agents did: the more they read, think and write, the more bricks they lay. One brick is 10,000 tokens, the little word-pieces AI reads and writes.',
  shifts: 'Shifts: how many times an agent has worked here. Each conversation with Claude is one shift.',
  saves: 'Saves: how many times the agents saved their progress to the project’s history (a git commit).',
  hitRate: 'Hit rate: of the jobs they finished, how many ended with work you kept.',
  scrapped: 'Scrapped: jobs that ended with their changes thrown away or never saved.',
  checks: 'Checks: automatic tests that ran on their work. ✓ passed, ✕ failed.',
} as const;

export const STATUS: Record<Voice, Record<SessionStatus, string>> = {
  plain: { running: 'Building', needs_input: 'Raised a hand', idle: 'Coffee break', ended: 'Clocked out' },
  technical: { running: 'Running', needs_input: 'Needs input', idle: 'Idle', ended: 'Ended' },
};

export const STAMP: Record<Voice, Record<Stamp, string>> = {
  plain: { shipped: 'Shipped', review: 'Sent for review', saved: 'Saved, not sent', unfinished: 'Left unfinished', scrapped: 'Scrapped', chat: 'Just a chat' },
  technical: { shipped: 'Merged', review: 'PR open', saved: 'Committed', unfinished: 'Uncommitted changes', scrapped: 'No changes kept', chat: 'No edits' },
};
export const STAMP_NOTE: Record<Stamp, string> = {
  shipped: 'Live now.',
  review: 'Waiting for someone to review and approve it.',
  saved: 'Saved on its own workbench. Not sent for review yet.',
  unfinished: 'Some of its changes were never saved.',
  scrapped: 'It changed things, but nothing was kept.',
  chat: 'Answered questions or researched. Didn’t change anything.',
};

export const SIZE: Record<Size, string> = { tweak: 'Tweak', fix: 'Fix', feature: 'Feature', overhaul: 'Overhaul' };

export const PROJECT: Record<Voice, Record<ProjectState, string>> = {
  plain: { site: 'Crew on site', needs: 'Raised a hand', construction: 'Under construction', recent: 'Just completed', done: 'Complete', lot: 'For sale' },
  technical: { site: 'Active sessions', needs: 'Needs input', construction: 'Active < 7d', recent: 'Quiet 7–30d', done: 'Quiet 30d+', lot: 'Not cloned' },
};

/** "Editing Tooltip.tsx" → "changing Tooltip" in plain voice. */
export function plainAction(action: string | null, voice: Voice): string | null {
  if (!action || voice === 'technical') return action;
  return action
    .replace(/^Editing (\S+?)(\.\w+)?$/, 'changing $1')
    .replace(/^Writing (\S+?)(\.\w+)?$/, 'writing $1')
    .replace(/^Reading (\S+?)(\.\w+)?$/, 'reading $1')
    .replace(/^Searching for /, 'looking for ')
    .replace(/^Committing changes$/, 'saving progress')
    .replace(/^Opening a pull request$/, 'sending it for review')
    .replace(/^Pushing to GitHub$/, 'uploading its work')
    .replace(/^Running (npm|pnpm|yarn|bun) (run )?test.*$/i, 'checking its work')
    // a raw command line ("Running mdls -name kMDItem… ~/Mov…") means nothing to most people
    .replace(/^Running (?=.*[-/~=$|]).*$/, 'running a command on your computer')
    .replace(/^Delegating: /, 'handing off: ')
    .replace(/^Thinking$/, 'thinking')
    .replace(/^\w/, (c) => c.toLowerCase());
}

/** What an agent is doing, in 2–3 words, for the label over their head in the town. */
/** What the bubble over an agent in Town says. */
export type Bubble = 'job' | 'project' | 'task';

/** The job an agent is on, from its live job label or session title ("Extend the offer"), trimmed to fit a bubble. Null until there's a real title. */
export function shortJob(title: string | null | undefined, max = 30): string | null {
  const t = (title ?? '').replace(/^\/\S+\s*/, '').replace(/[`"“”]/g, '').replace(/\s+/g, ' ').replace(/…$/, '').trim();
  if (!t || /^new session$/i.test(t)) return null;
  if (!/\s/.test(t) && /\d/.test(t)) return null; // an id like "5e313808" or "swarmville-f1", not a job
  const cap = (x: string) => x.replace(/^\w/, (c) => c.toUpperCase());
  if (t.length <= max) return cap(t.replace(/[.,:;!?]+$/, ''));
  const cut = t.slice(0, max + 1).replace(/\s+\S*$/, '');
  return cap(cut || t.slice(0, max)).replace(/[\s.,:;!?-]+$/, '').replace(/\s+(and|or|the|a|an|to|of|for|with|in|on|at|from|into)$/i, '') + '…';
}

export function shortDoing(s: { status: string; away?: boolean; action: string | null; stuck?: unknown }): string {
  if (s.status === 'needs_input') return 'needs you';
  if (s.away) return 'napping';
  if (s.status === 'idle') return 'coffee break';
  if (s.status === 'ended') return 'clocked out';
  if (s.stuck) return 'stuck';
  const a = plainAction(s.action, 'plain');
  if (!a) return 'thinking';
  const clean = a.replace(/\S*\/(\S+)/g, '$1') // paths → just the file name
    .replace(/^running (npm|pnpm|yarn|bun) (run )?build.*$/i, 'building the app')
    .replace(/^running (npm|pnpm|yarn|bun) (run )?(\S+).*$/i, 'running $3')
    .replace(/\b(the|a|an)\s+/gi, '');
  const words = clean.replace(/[`"'“”]/g, '').replace(/[,:;(].*$/, '').replace(/\.(tsx?|jsx?|md|json|css|py|sh|ya?ml)\b/g, '').split(/\s+/).filter(Boolean);
  const out = words.slice(0, 3);
  while (out.length > 1 && /^(and|or|the|a|an|to|of|for|with|in|on|at|from|into|then)$/i.test(out[out.length - 1])) out.pop(); // don't end on a dangling word
  return out.join(' ').replace(/[/\\]\S*$/, '') || 'thinking';
}

export const bricks = (n: number) => `${n.toLocaleString()} brick${n === 1 ? '' : 's'}`;
export const money = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);
export function mins(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return ms > 0 ? '<1 min' : '0 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
