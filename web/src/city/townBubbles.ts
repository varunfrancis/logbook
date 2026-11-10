import type { SessionView, StateView } from '../../../daemon/types.ts';
import { yourTurn } from '../../../daemon/turn.ts';

/** A "Finished" bubble stays up this long after the agent goes quiet. */
export const FINISHED_FOR = 3 * 60_000;

/** One reply-bubble moment: dismissing it ("Later") lasts until the agent says something new. */
export const bubbleKey = (s: Pick<SessionView, 'id' | 'lastEventAt'>) => `${s.id}:${s.lastEventAt ?? 0}`;

export type TownBubble = { s: SessionView; kind: 'ask' | 'done' };

/**
 * Who gets a reply bubble in the town: agents Swarmville runs that have stopped and reported, either asking you something
 * (a raised hand, or a question the hook didn't catch; stays until you answer or say "Later") or just finished (for a few minutes). Agents in your terminal
 * never do, and neither does the one whose drawer is open.
 */
export function townBubbles(state: Pick<StateView, 'sessions'>, now: number, later: Set<string>, openId: string | null): TownBubble[] {
  const out: TownBubble[] = [];
  for (const s of state.sessions) {
    const asked = s.status === 'needs_input' && s.handKind === 'question';
    if (!s.runner || (s.status !== 'idle' && !asked) || s.away || s.id === openId || (!s.outcome && !asked)) continue;
    if (later.has(bubbleKey(s))) continue;
    if (asked || yourTurn(s.outcome ?? '')) out.push({ s, kind: 'ask' });
    else if (s.lastEventAt && now - s.lastEventAt < FINISHED_FOR) out.push({ s, kind: 'done' });
  }
  return out;
}
