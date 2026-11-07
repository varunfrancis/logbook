import { useEffect, useMemo, useRef, useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar, FOREMAN } from '../crew/Avatar.tsx';
import { post } from '../useLogbook.ts';

/*
 * After the welcome, Pip explains the rest the first time it actually happens, pointing at the real thing.
 * Each tip shows once, ever.
 */
type Tip = { id: string; text: string; projectId: string | null; sessionId?: string };

function pending(state: StateView, view: string, seen: Set<string>, doneAt: number): Tip | null {
  const name = (pid: string | null) => state.projects.find((p) => p.id === pid)?.name ?? 'a project';
  const tips: (() => Tip | null)[] = [
    () => { const s = state.sessions.find((x) => x.status === 'needs_input'); return s ? { id: 'needs', sessionId: s.id, projectId: s.projectId, text: `${s.agent.name} raised a hand at ${name(s.projectId)}. They need a yes, a no, or an answer from you. Click them to jump to their terminal. Your Mac pings you for these too.` } : null; },
    () => { const s = state.sessions.find((x) => x.stuck && x.status !== 'ended'); return s ? { id: 'stuck', sessionId: s.id, projectId: s.projectId, text: `See the rain cloud over ${name(s.projectId)}? ${s.agent.name} has hit the same problem ${s.stuck!.count} times. A nudge from you usually helps.` } : null; },
    () => { const p = state.projects.find((x) => x.checksFailing); return p ? { id: 'fire', projectId: p.id, text: `A small fire at ${p.name} means checks just failed. That's normal mid-job. Only worry if it's still burning when they clock out.` } : null; },
    () => { const p = state.projects.find((x) => x.justMerged); return p ? { id: 'ship', projectId: p.id, text: `Fireworks! Work on ${p.name} just went live. Want to show it off? The Share button makes a card for it.` } : null; },
    () => { const g = state.graveyard.find((x) => x.at > doneAt); return g ? { id: 'grave', projectId: null, text: `Some of ${g.agent.name}'s work on ${g.projectName} didn't make it, so it got a tombstone in the graveyard. Nothing disappears without a trace here.` } : null; },
    () => (view === 'day' ? { id: 'bricks', projectId: null, text: 'This is your day, one lane per agent. Effort is counted in bricks: one brick is about 10,000 tokens of work. Switch to Technical in the header to see raw numbers.' } : null),
  ];
  for (const f of tips) { const t = f(); if (t && !seen.has(t.id)) return t; }
  return null;
}

export function Tips({ state, view, openAgent, focusProject }: { state: StateView; view: string; openAgent: (sid: string) => void; focusProject: (id: string) => void }) {
  const w = state.settings.welcome;
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const seen = useMemo(() => new Set([...w.tips, ...dismissed]), [w.tips, dismissed]);
  const tip = (w.done || w.skipped) ? pending(state, view, seen, w.doneAt ?? w.skipped?.at ?? 0) : null;
  if (!tip) return null;
  const got = () => { setDismissed(new Set([...dismissed, tip.id])); post('/api/settings', { welcome: { tips: [tip.id] } }); };
  return (
    <div className="wel-tip" role="status">
      <AgentAvatar agent={FOREMAN} mood="hello" size={52} live />
      <div>
        <p>{tip.text}</p>
        <div className="wel-actions">
          {tip.sessionId ? <button type="button" className="ghost small" onClick={() => { openAgent(tip.sessionId!); got(); }}>Show me</button>
            : tip.projectId ? <button type="button" className="ghost small" onClick={() => { focusProject(tip.projectId!); got(); }}>Show me</button> : null}
          <button type="button" className="btn dark small" onClick={got}>Got it</button>
        </div>
      </div>
    </div>
  );
}

/** "Bea joined the crew": a small note whenever a new agent starts, on every tab. Several at once become one note. */
export function ArrivalToasts({ state, openAgent }: { state: StateView; openAgent: (sid: string) => void }) {
  const seen = useRef<Set<string> | null>(null);
  const [toast, setToast] = useState<{ ids: string[]; at: number } | null>(null);
  useEffect(() => {
    const ids = state.sessions.map((s) => s.id);
    if (!seen.current) { seen.current = new Set(ids); return; } // everyone already here when the page opened
    const fresh = state.sessions.filter((s) => !seen.current!.has(s.id) && s.status !== 'ended' && s.startedAt && Date.now() - s.startedAt < 120_000);
    ids.forEach((id) => seen.current!.add(id));
    if (fresh.length) setToast((t) => ({ ids: [...(t && Date.now() - t.at < 8000 ? t.ids : []), ...fresh.map((s) => s.id)], at: Date.now() }));
  }, [state.sessions]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);
  if (!toast) return null;
  const list = toast.ids.map((id) => state.sessions.find((s) => s.id === id)).filter(Boolean) as StateView['sessions'];
  if (!list.length) return null;
  const one = list.length === 1 ? list[0] : null;
  const where = one ? state.projects.find((p) => p.id === one.projectId)?.name : null;
  return (
    <button type="button" className="arrival-toast" onClick={() => { openAgent(list[0].id); setToast(null); }}>
      <span className="arrival-avs">{list.slice(0, 3).map((s) => <AgentAvatar key={s.id} agent={s.agent} mood="hello" size={34} live />)}</span>
      <span>{one ? <><b>{one.agent.name}</b> joined the crew<br /><span className="muted">{where ?? 'New on site'}</span></> : <><b>{list.length} new crew</b> on site<br /><span className="muted">{list.slice(0, 3).map((s) => s.agent.name).join(', ')}</span></>}</span>
    </button>
  );
}
