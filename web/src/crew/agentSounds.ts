import { useEffect, useRef } from 'react';
import { agentSound, type AgentSound } from '../audio.ts';

type Sess = { id: string; status: string };
/** What we remember between updates: each agent's last status. */
export type Seen = Map<string, string>;

const working = (status: string) => status === 'running' || status === 'needs_input';

/**
 * Which sounds an update calls for, comparing every agent with how it was last time:
 *  - hand: an agent raised a hand (asks for permission or input)
 *  - start: an agent we haven't seen before starts working
 *  - finish: an agent that was working finished (its turn ended, or it clocked out)
 * At most one of each kind per update, most urgent first. `seen` is updated in place.
 */
export function agentSoundEvents(seen: Seen, sessions: Sess[]): AgentSound[] {
  const out = new Set<AgentSound>();
  for (const s of sessions) {
    const before = seen.get(s.id);
    if (s.status === 'needs_input' && before !== 'needs_input') out.add('hand');
    else if (before === undefined && working(s.status)) out.add('start');
    else if (before === 'running' && (s.status === 'idle' || s.status === 'ended')) out.add('finish');
    // A brand-new agent that hasn't started work yet stays unseen, so its first move still counts as starting.
    if (before !== undefined || working(s.status)) seen.set(s.id, s.status);
  }
  return (['hand', 'finish', 'start'] as const).filter((k) => out.has(k));
}

/** Plays a sound when an agent raises a hand, a new agent starts work, or an agent finishes. The first look only records who's there. */
export function useAgentSounds(sessions: Sess[] | undefined) {
  const seen = useRef<Seen | null>(null);
  useEffect(() => {
    if (!sessions) return;
    if (!seen.current) { seen.current = new Map(sessions.map((s) => [s.id, s.status])); return; }
    const [first] = agentSoundEvents(seen.current, sessions);
    if (first) agentSound(first); // one sound per update, the most urgent, so a busy town doesn't clatter
  }, [sessions]);
}
