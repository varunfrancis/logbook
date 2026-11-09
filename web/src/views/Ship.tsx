import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectView, SessionView, ShipPhase, ShipView } from '../../../daemon/types.ts';
import { Avatar, AgentAvatar, FOREMAN, moodFor } from '../crew/Avatar.tsx';
import { firstLine } from '../format.ts';
import { GoTo } from '../components.tsx';
import { post } from '../useSwarmville.ts';
import { prNum } from '../crew/today.ts';
import { shipTrack } from '../crew/shipTrack.ts';

/*
 * "Ship it": send the agent behind a finished job back to take it all the way to review, then put it live yourself.
 * The agent never merges; "Put it live" here is the only way it goes live (see daemon/ship.ts).
 */

/** Confirm before an agent is sent back: who, what they'll do, and that going live stays your call. */
export function ShipSheet({ s, project, onClose, onStarted }: { s: SessionView; project?: ProjectView; onClose: () => void; onStarted: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = s.agent.name;
  const onGithub = !!project?.ghFull;
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [onClose]);
  const go = async () => {
    setBusy(true);
    const r = await post(`/api/ship/${encodeURIComponent(s.id)}`);
    setBusy(false);
    if (!r.ok) { setErr(r.message ?? 'Couldn’t start it.'); return; }
    onStarted(r.message ?? 'On its way.');
    onClose();
  };
  // On the page itself, not inside the Today column, so nothing in the lists can show through it.
  return createPortal(
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="ship-title" onClick={onClose}>
      <div className="modal ship-sheet" onClick={(e) => e.stopPropagation()}>
        <h2 id="ship-title">Ship “{s.title}”?</h2>
        <div className="ship-pip">
          <Avatar {...FOREMAN} mood="hello" size={52} />
          <p className="ship-bubble">{name} will pick it up where they left off and take it all the way to {onGithub ? 'review' : 'saved'}. You decide when it goes live.</p>
        </div>
        <ol className="ship-plan">
          <li><b>Finish what's left</b>{s.outcome ? <small>“{firstLine(s.outcome, 140)}”</small> : null}</li>
          <li><b>Make sure it works</b><small>Runs the project's own checks.</small></li>
          <li><b>Save it on its own branch</b><small>So nothing else is touched.</small></li>
          {onGithub ? <>
            <li><b>Send it for review</b><small>And wait for the automated checks. If they fail, {name} fixes them (up to 3 tries).</small></li>
            <li><b>You put it live</b><small>When the checks pass, a Put it live button shows up here in Today. Nothing goes live without it.</small></li>
          </> : <li><b>Stop there</b><small>{project?.name ?? 'This project'} isn't on GitHub, so there's no review to send.</small></li>}
        </ol>
        <p className="muted small">{name} opens in VS Code (or Terminal) so you can watch. Anything that needs your OK still raises a hand, as usual.</p>
        {err ? <p className="ship-err" role="alert">{err}</p> : null}
        <div className="row end">
          <button className="ghost" onClick={onClose}>Not now</button>
          <button className="btn ship" onClick={go} disabled={busy} autoFocus>{busy ? 'Starting…' : 'Ship it'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Two clicks to merge, and the second one says exactly what happens. */
export function PutLive({ sessionId, prUrl, onDone }: { sessionId: string; prUrl: string | null; onDone?: (msg: string) => void }) {
  const [step, setStep] = useState<'idle' | 'sure' | 'busy'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const go = async () => {
    setStep('busy');
    const r = await post(`/api/ship/${encodeURIComponent(sessionId)}/live`);
    setStep('idle');
    if (r.ok) onDone?.(r.message ?? 'It’s live.');
    else setMsg(r.message ?? 'It didn’t go live.');
  };
  if (step === 'sure' || step === 'busy') {
    return (
      <span className="put-live-sure">
        <span>Merge {prNum(prUrl) ?? 'the review'} and put it live?</span>
        <button className="btn ship small" onClick={go} disabled={step === 'busy'}>{step === 'busy' ? 'Putting it live…' : 'Yes, put it live'}</button>
        <button className="ghost small" onClick={() => setStep('idle')} disabled={step === 'busy'}>Cancel</button>
      </span>
    );
  }
  return (
    <>
      <button className="btn ship small" onClick={() => { setMsg(null); setStep('sure'); }}>Put it live</button>
      {msg ? <span className="ship-err small" role="alert">{msg}</span> : null}
    </>
  );
}

const LABEL: Record<ShipPhase, string> = {
  working: 'Shipping', review: 'Sent for review', checks: 'Checks running', failing: 'Needs a fix', ready: 'Ready for you', stopped: 'Stopped', live: 'Shipped',
};
const STAMP_CLASS: Record<ShipPhase, string> = {
  working: 'st-live', review: 'st-review', checks: 'st-live', failing: 'st-fix', ready: 'st-ready', stopped: 'st-unfinished', live: 'st-shipped',
};

/** What it says under the title: the agent's own last sentence while working, otherwise where things stand. */
function line(sh: ShipView, cur: SessionView | undefined, name: string): string {
  const said = firstLine(cur?.outcome ?? null, 200);
  switch (sh.phase) {
    case 'working': return cur?.status === 'needs_input' ? `${name} raised a hand: ${cur.needsMessage ?? 'they need your OK.'}` : `${name} is on it.`;
    case 'review': return said || `Sent for review. ${name} is still tidying up.`;
    case 'checks': return 'Sent for review. Waiting for the automated checks.';
    case 'failing': return said || 'The automated checks failed.';
    case 'ready': return 'The checks passed. It goes live when you say so.';
    case 'live': return 'It’s live.';
    case 'stopped': return !sh.onGithub && sh.commits > 0 ? 'Saved on this computer. This project isn’t on GitHub, so that’s as far as it goes.' : said || `${name} stopped before sending it for review.`;
  }
}

export function ShipRow({ sh, sessions, project, onOpen, onMessage }: {
  sh: ShipView; sessions: SessionView[]; project?: ProjectView; onOpen: (id: string) => void; onMessage: (m: string) => void;
}) {
  const cur = sessions.find((s) => s.id === sh.sessionId);
  const orig = sessions.find((s) => s.id === sh.id) ?? cur;
  const [msg, setMsg] = useState<string | null>(null);
  if (!orig) return null;
  const name = orig.agent.name;
  const savedOnly = !sh.onGithub && sh.phase === 'stopped' && sh.commits > 0;
  const act = async (path: string) => {
    const r = await post(`/api/ship/${encodeURIComponent(sh.id)}${path}`);
    if (!r.ok) setMsg(r.message ?? 'That didn’t work.'); else if (r.message) onMessage(r.message);
  };
  return (
    <li className={`ship-row ph-${sh.phase}`} onClick={() => onOpen(sh.sessionId)}>
      <span className={`stamp ${savedOnly ? 'st-saved' : STAMP_CLASS[sh.phase]}`}>{savedOnly ? 'Saved' : LABEL[sh.phase]}</span>
      <AgentAvatar agent={(cur ?? orig).agent} mood={sh.phase === 'live' ? 'shipped' : sh.phase === 'failing' ? 'stuck' : cur ? moodFor(cur) : 'out'} size={36} />
      <div className="closed-body">
        <div><b>{orig.title}</b> <span className="sub">· {orig.agent.title} · {project?.name ?? 'Unknown project'}</span></div>
        <div className="said">{line(sh, cur, name)}</div>
      </div>
      {sh.phase !== 'live' && !savedOnly ? (
        <ol className="ship-track" aria-label="Progress">
          {shipTrack(sh).map((st) => <li key={st.label} className={st.state}>{st.label}</li>)}
        </ol>
      ) : null}
      <span className="today-acts" onClick={(e) => e.stopPropagation()}>
        {sh.phase === 'ready' && sh.prSession ? <PutLive sessionId={sh.prSession} prUrl={sh.prUrl} onDone={onMessage} /> : null}
        {sh.phase === 'failing' ? <button className="btn ship small" onClick={() => act('/fix')}>Fix the checks</button> : null}
        {sh.phase === 'stopped' && !savedOnly ? <button className="btn ship small" onClick={() => act('')}>Ship it again</button> : null}
        {sh.prUrl && sh.phase !== 'live' ? <a className="ghost small" href={sh.prUrl} target="_blank" rel="noreferrer">Open the review {prNum(sh.prUrl)}</a> : null}
        {cur && sh.phase !== 'live' ? <GoTo s={cur} /> : null}
        {sh.phase === 'stopped' || sh.phase === 'live' ? <button className="ghost small" onClick={() => act('/clear')} title="Take it off this list. Its record stays.">{sh.phase === 'live' ? 'Done' : 'Let it go'}</button> : null}
        {msg ? <span className="ship-err small" role="alert">{msg}</span> : null}
      </span>
    </li>
  );
}
