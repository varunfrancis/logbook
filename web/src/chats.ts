import { useEffect, useState } from 'react';
import type { SessionView } from '../../daemon/types.ts';
import { plainAction, type Voice } from './copy.ts';

/*
 * The Chats screen's list: who's there, in what order, what each row previews, and which replies you haven't opened.
 * Pure functions (plus a little browser storage for "seen"), so the rules are easy to test.
 */

export type ChatGroup = 'needs' | 'working' | 'turn' | 'earlier' | 'older';
export const GROUPS: { id: ChatGroup; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'turn', label: 'Your turn' },
  { id: 'earlier', label: 'Earlier today' },
  { id: 'older', label: 'Older' },
];

type S = Pick<SessionView, 'status' | 'away' | 'endedAt' | 'lastEventAt'>;

/** Hand up first, then working, then waiting on your next message; anyone who left today folds under "Earlier today". */
export function chatGroup(s: S, dayStart: number): ChatGroup {
  if (s.status === 'needs_input') return 'needs';
  if (s.status === 'running') return 'working';
  if (s.status === 'idle' && !s.away) return 'turn';
  return (s.endedAt ?? s.lastEventAt ?? 0) >= dayStart ? 'earlier' : 'older';
}

export function startOfDay(now: number): number { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

type Findable = SessionView & { projectName?: string };

/**
 * The list, grouped and in order (newest activity first in each group). Without a search: today's crew only.
 * With one: anyone whose name, job or project matches, including older agents.
 */
export function chatList(sessions: Findable[], now: number, query = ''): { group: ChatGroup; items: Findable[] }[] {
  const day = startOfDay(now);
  const q = query.trim().toLowerCase();
  const match = (s: Findable) => !q || [s.agent.name, s.agent.title, s.focus, s.title, s.projectName].some((t) => t?.toLowerCase().includes(q));
  const by = new Map<ChatGroup, Findable[]>();
  for (const s of sessions) {
    if (!match(s)) continue;
    const g = chatGroup(s, day);
    if (g === 'older' && !q) continue;
    by.set(g, [...(by.get(g) ?? []), s]);
  }
  const last = (s: Findable) => s.lastEventAt ?? s.endedAt ?? s.startedAt ?? 0;
  return GROUPS.filter((g) => by.has(g.id)).map((g) => ({ group: g.id, items: by.get(g.id)!.sort((a, b) => last(b) - last(a)).slice(0, g.id === 'older' ? 30 : undefined) }));
}

/** The first readable line of a reply, without Markdown marks. */
export function firstLine(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  for (const raw of text.split('\n')) {
    const t = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
    if (t && !/^[-=|: ]+$/.test(t)) return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
  }
  return null;
}

/** One line under the agent's name: what they're asking, doing, or last said. */
export function chatPreview(s: Pick<SessionView, 'status' | 'action' | 'ask' | 'needsMessage' | 'outcome'>, voice: Voice): string {
  if (s.status === 'needs_input') return s.ask?.questions?.[0]?.question ?? s.ask?.title ?? s.needsMessage ?? 'Waiting for your answer';
  if (s.status === 'running') { const a = plainAction(s.action, voice) ?? 'thinking'; return a.charAt(0).toUpperCase() + a.slice(1); }
  return firstLine(s.outcome) ?? (s.status === 'idle' ? 'Ready for your next message' : 'Clocked out');
}

/**
 * A reply you haven't opened: an agent Swarmville runs has stopped and said something since you last had their chat open.
 * (Agents in your terminal answer you there, so they never count.)
 */
export function isUnread(s: Pick<SessionView, 'id' | 'status' | 'runner' | 'lastEventAt'>, seen: Record<string, number>, since: number): boolean {
  if (!s.runner || s.status === 'running' || s.status === 'needs_input') return false;
  return (s.lastEventAt ?? 0) > Math.max(seen[s.id] ?? 0, since);
}

/** The Chats badge: raised hands plus replies you haven't opened. */
export function chatsBadge(sessions: SessionView[], seen: Record<string, number>, since: number): number {
  return sessions.filter((s) => s.status === 'needs_input' || isUnread(s, seen, since)).length;
}

// ---- "Seen", kept in this browser ----

const SEEN_KEY = 'swarmville.chatSeen';
const SINCE_KEY = 'swarmville.chatSince';
const SEEN_EVENT = 'swarmville:chatseen';
const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** Replies from before you first had Swarmville's chats don't count as unread. */
function since(): number {
  const v = read<number>(SINCE_KEY, 0);
  if (v) return v;
  const now = Date.now(); write(SINCE_KEY, now); return now;
}

/** Called while an agent's chat is open (in the drawer or in Chats). */
export function markSeen(id: string, at = Date.now()) {
  const m = read<Record<string, number>>(SEEN_KEY, {});
  if ((m[id] ?? 0) >= at) return;
  m[id] = at;
  const keys = Object.keys(m);
  if (keys.length > 400) keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - 400).forEach((k) => delete m[k]);
  write(SEEN_KEY, m);
  window.dispatchEvent(new Event(SEEN_EVENT));
}

export function useSeen(): { seen: Record<string, number>; since: number } {
  const [v, setV] = useState(() => ({ seen: read<Record<string, number>>(SEEN_KEY, {}), since: since() }));
  useEffect(() => {
    const f = () => setV({ seen: read<Record<string, number>>(SEEN_KEY, {}), since: since() });
    window.addEventListener(SEEN_EVENT, f);
    window.addEventListener('storage', f);
    return () => { window.removeEventListener(SEEN_EVENT, f); window.removeEventListener('storage', f); };
  }, []);
  return v;
}
