import { useEffect, useState } from 'react';
import type { SessionView } from '../../daemon/types.ts';
import { plainAction, type Voice } from './copy.ts';

/*
 * The Chats screen's list: who's there, in what order, what each row previews, and which replies you haven't opened.
 * Pure functions (plus a little browser storage for "seen"), so the rules are easy to test.
 */

export function startOfDay(now: number): number { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

type S = Pick<SessionView, 'status' | 'away'>;
/** Live: working on it, or waiting for your next message. A raised hand is pinned on its own; the rest is done. */
export type ChatState = 'needs' | 'working' | 'turn' | 'done';
export function chatState(s: S): ChatState {
  if (s.status === 'needs_input') return 'needs';
  if (s.status === 'running') return 'working';
  if (s.status === 'idle' && !s.away) return 'turn';
  return 'done';
}

/** What the row is called: the job they're on, else the conversation's title. Null when nothing was ever asked. */
export function chatTask(s: Pick<SessionView, 'focus' | 'title'>): string | null {
  return s.focus ?? (s.title && !/^new session$/i.test(s.title.trim()) ? s.title : null);
}

type Findable = SessionView & { projectName?: string };
export type ChatProject = { id: string; name: string; hand: boolean; live: Findable[]; done: Findable[]; empty: number; last: number };

/**
 * The list, by project (like channels). Raised hands are pinned on top across projects. In each project: live tasks
 * (working first, then waiting on you), then what finished today. Sessions where nothing was ever asked only count.
 * Without a search: today only. With one: anyone whose task, project or name matches, older ones included.
 */
export function chatProjects(sessions: Findable[], now: number, query = ''): { needs: Findable[]; projects: ChatProject[] } {
  const day = startOfDay(now);
  const q = query.trim().toLowerCase();
  const last = (s: Findable) => s.lastEventAt ?? s.endedAt ?? s.startedAt ?? 0;
  const match = (s: Findable) => !q || [chatTask(s), s.projectName, s.agent.name, s.agent.title].some((x) => x?.toLowerCase().includes(q));
  const needs: Findable[] = [];
  const by = new Map<string, ChatProject>();
  for (const s of [...sessions].sort((a, b) => last(b) - last(a))) {
    const st = chatState(s);
    if (st === 'done' && last(s) < day && !q) continue;
    if (!match(s)) continue;
    const id = s.projectId ?? '';
    const p = by.get(id) ?? { id, name: s.projectName ?? 'Other', hand: false, live: [], done: [], empty: 0, last: 0 };
    by.set(id, p);
    p.last = Math.max(p.last, last(s));
    if (st === 'needs') { needs.push(s); p.hand = true; continue; }
    if (!chatTask(s) && !s.prompts) { if (st !== 'done') p.empty++; continue; }
    if (st === 'done') { if (p.done.length < 30) p.done.push(s); } else p.live.push(s);
  }
  for (const p of by.values()) p.live.sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || last(b) - last(a));
  const projects = [...by.values()].filter((p) => p.live.length || p.done.length || p.empty || p.hand)
    .sort((a, b) => Number(b.hand || b.live.length > 0) - Number(a.hand || a.live.length > 0) || b.last - a.last);
  return { needs, projects };
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
