import { useEffect, useRef, useState } from 'react';
import type { SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { GoTo } from '../components.tsx';
import { duration } from '../format.ts';
import { post, useNow } from '../useLogbook.ts';

type Decision = 'allow' | 'always' | 'deny';
const DONE: Record<Decision, string> = { allow: 'Approved.', always: 'Approved, and they won’t ask about this again.', deny: 'Told them no.' };

/**
 * What a raised hand is asking, answered on the spot: clicking an agent with a hand up in the town opens this instead of
 * their profile drawer. Permission prompts get Approve / Deny right here; questions point you to their terminal.
 */
export function AskPopup({ id, state, onClose, openProfile }: { id: string; state: StateView; onClose: () => void; openProfile: (id: string) => void }) {
  const now = useNow(15000);
  const s = state.sessions.find((x) => x.id === id);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seen = useRef<string | null>(s?.ask?.id ?? null);
  const approve = useRef<HTMLButtonElement>(null);

  // Answered in the terminal (or the agent moved on) while this was open: say so, then get out of the way.
  const settled = !s || s.status !== 'needs_input' || (seen.current && s.ask?.id !== seen.current);
  useEffect(() => {
    if (settled && !done) setDone(s?.status === 'ended' ? 'They clocked out.' : 'Answered in the terminal.');
  }, [settled]);
  useEffect(() => { if (done) { const t = setTimeout(onClose, 1400); return () => clearTimeout(t); } }, [done]);
  useEffect(() => { if (s?.ask && !seen.current) seen.current = s.ask.id; }, [s?.ask?.id]);
  useEffect(() => { approve.current?.focus(); }, [!!s?.ask]);

  const answer = async (decision: Decision) => {
    if (!s?.ask || busy) return;
    setBusy(true);
    const r = await post(`/api/ask/${encodeURIComponent(s.ask.id)}`, { decision });
    setBusy(false);
    setDone(r.ok ? `${DONE[decision]} ${decision === 'deny' ? '' : `${s.agent.name} is back to work.`}`.trim() : r.message ?? 'That one was already answered.');
  };

  if (!s) return null;
  const project = state.projects.find((p) => p.id === s.projectId);
  return (
    <div className="ask-scrim" onClick={onClose}>
      <div className="ask-pop" role="dialog" aria-modal="true" aria-labelledby="ask-title" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <header className="ask-head">
          <AgentAvatar agent={s.agent} mood={moodFor(s)} size={48} />
          <div className="ask-who">
            <h2 id="ask-title">{s.agent.name} raised a hand</h2>
            <span className="sub">{project?.name ?? 'A project'}{s.status === 'needs_input' ? ` · waiting ${duration(s.lastEventAt, now)}` : ''}</span>
          </div>
          <button className="ghost close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {done ? <p className="ask-done" role="status">{done}</p> : <AskBody s={s} />}

        {!done ? (
          s.ask ? (
            <div className="ask-actions">
              <button ref={approve} className="btn approve" onClick={() => answer('allow')} disabled={busy}>Approve</button>
              {s.ask.canAlways ? <button className="ghost" onClick={() => answer('always')} disabled={busy} title="Approve, and let them do this again without asking">Always allow</button> : null}
              <button className="ghost deny" onClick={() => answer('deny')} disabled={busy}>Deny</button>
            </div>
          ) : (
            <div className="ask-actions"><GoTo s={s} primary /></div>
          )
        ) : null}
        {!done ? (
          <footer className="ask-foot">
            {s.ask ? <GoTo s={s} /> : null}
            <button className="link" onClick={() => openProfile(s.id)}>Full profile</button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function AskBody({ s }: { s: SessionView }) {
  const a = s.ask;
  if (!a) {
    return (
      <div className="ask-body">
        <p className="ask-title">{s.needsMessage ?? 'Waiting for you'}</p>
        <p className="sub">This one needs an answer in their terminal.</p>
      </div>
    );
  }
  return (
    <div className="ask-body">
      <p className="ask-title">{a.title}</p>
      {a.detail ? (a.detailKind === 'command' ? <pre className="ask-detail cmd"><code>{a.detail}</code></pre>
        : a.detailKind === 'path' ? <code className="ask-detail path">{a.detail}</code>
        : <pre className="ask-detail">{a.detail}</pre>) : null}
    </div>
  );
}
