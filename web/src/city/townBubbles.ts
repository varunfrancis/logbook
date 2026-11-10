import type { SessionView, StateView } from '../../../daemon/types.ts';
import { yourTurn } from '../turn.ts';

/** A "Finished" bubble stays up this long after the agent goes quiet. */
export const FINISHED_FOR = 3 * 60_000;

/** One reply-bubble moment: dismissing it ("Later") lasts until the agent says something new. */
export const bubbleKey = (s: Pick<SessionView, 'id' | 'lastEventAt'>) => `${s.id}:${s.lastEventAt ?? 0}`;

export type TownBubble = { s: SessionView; kind: 'ask' | 'done' };

/**
 * Who gets a reply bubble in the town: agents Swarmville runs that have stopped and reported (idle), either asking
 * you something (stays until you answer or say "Later") or just finished (for a few minutes). Agents in your terminal
 * never do, and neither does the one whose drawer is open.
 */
export function townBubbles(state: Pick<StateView, 'sessions'>, now: number, later: Set<string>, openId: string | null): TownBubble[] {
  const out: TownBubble[] = [];
  for (const s of state.sessions) {
    if (!s.runner || s.status !== 'idle' || s.away || s.id === openId || !s.outcome) continue;
    if (later.has(bubbleKey(s))) continue;
    if (yourTurn(s.outcome)) out.push({ s, kind: 'ask' });
    else if (s.lastEventAt && now - s.lastEventAt < FINISHED_FOR) out.push({ s, kind: 'done' });
  }
  return out;
}
