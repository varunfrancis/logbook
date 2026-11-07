import { createContext, useContext } from 'react';
import type { ProjectState, SessionStatus, Size, Stamp } from '../../daemon/types.ts';

/** Plain is the default voice. Technical shows the raw terms for days you want them. */
export type Voice = 'plain' | 'technical';
export const VoiceContext = createContext<Voice>('plain');
export const useVoice = () => useContext(VoiceContext);

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
    .replace(/^Delegating: /, 'handing off: ')
    .replace(/^Thinking$/, 'thinking')
    .replace(/^\w/, (c) => c.toLowerCase());
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
