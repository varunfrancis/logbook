import { useEffect, useState } from 'react';
import { saidOf, useVoice } from '../copy.ts';
import { createPortal } from 'react-dom';
import type { SessionView, StateView } from '../../../daemon/types.ts';
import { bubbleKey as keyOf, townBubbles, type TownBubble as TownBubbleT } from './townBubbles.ts';
import type { CityScene } from './scene.ts';
import { yourTurn } from '../../../daemon/turn.ts';
import { didSummary } from '../format.ts';
import { post } from '../useSwarmville.ts';
import { HIGH_FIVE } from '../views/Chat.tsx';

/*
 * Replying from the town: when an agent Swarmville runs stops to ask you something, its bubble in the town gets
 * answers you can tap and a small reply box, so you can answer without opening the drawer. Agents who just finished
 * get a short "Finished" bubble with a high-five. Agents in your own terminal keep "Go to" (no typing into terminals).
 */

const LATER_KEY = 'swarmville.townLater';
const readLater = (): string[] => { try { return JSON.parse(localStorage.getItem(LATER_KEY) ?? '[]'); } catch { return []; } };
const saveLater = (keys: string[]) => { try { localStorage.setItem(LATER_KEY, JSON.stringify(keys.slice(-200))); } catch {} };
type Bubble = TownBubbleT;

export function TownReplies({ state, scene, openAgent, openId }: { state: StateView; scene: CityScene | null; openAgent: (sessionId: string) => void; openId: string | null }) {
  const [later, setLater] = useState(() => new Set(readLater()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const dismiss = (s: SessionView) => setLater((cur) => { const n = new Set(cur).add(keyOf(s)); saveLater([...n]); return n; });
  if (!scene) return null;
  return <>{townBubbles(state, now, later, openId).map((b) => <TownBubble key={b.s.id} b={b} scene={scene} openAgent={openAgent} dismiss={dismiss} />)}</>;
}

function TownBubble({ b, scene, openAgent, dismiss }: { b: Bubble; scene: CityScene; openAgent: (sessionId: string) => void; dismiss: (s: SessionView) => void }) {
  const voice = useVoice();
  const { s, kind } = b;
  const [host] = useState(() => { const d = document.createElement('div'); d.className = `town-reply ${kind}`; return d; });
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fived, setFived] = useState(false);
  useEffect(() => { host.className = `town-reply ${kind}`; }, [kind]);
  useEffect(() => { scene.attachReply(s.id, host); return () => scene.attachReply(s.id, null); }, [scene, s.id]);

  const name = s.agent.name;
  // the question their raised hand is about, with the answers their reply offered
  const replyTurn = kind === 'ask' ? yourTurn(s.outcome ?? '') : null;
  const turn = kind !== 'ask' ? null : s.handKind === 'question' && s.needsMessage ? { question: s.needsMessage, answers: replyTurn?.answers ?? [] } : replyTurn;
  const send = async (words: string) => {
    if (!words.trim() || sent) return;
    setErr(null);
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/send`, { text: words });
    if (r.ok) setSent(words); else setErr(r.message ?? 'Couldn’t send it.');
  };
  const highFive = async () => {
    if (fived) return;
    setFived(true);
    window.dispatchEvent(new CustomEvent(HIGH_FIVE, { detail: { sessionId: s.id } }));
    await post(`/api/agent/${encodeURIComponent(s.id)}/highfive`);
  };

  const body = sent ? (
    <>
      <div className="tr-who"><b>{name}</b><span className="tr-pill ok">On it</span></div>
      <p className="tr-sent"><span aria-hidden>✓</span> “{sent.length > 80 ? sent.slice(0, 79) + '…' : sent}” sent. Back to work.</p>
    </>
  ) : kind === 'ask' && turn ? (
    <>
      <div className="tr-who"><b>{name}</b><span className="tr-pill">Your turn</span></div>
      <p className="tr-q">{turn.question}</p>
      {turn.answers.length ? <div className="tr-chips">{turn.answers.map((a) => <button key={a.label} type="button" onClick={() => send(a.say)}>{a.label}</button>)}</div> : null}
      <form className="tr-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <label className="sr" htmlFor={`tr-${s.id}`}>Reply to {name}</label>
        <input id={`tr-${s.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${name}…`} autoComplete="off" />
        <button type="submit" disabled={!text.trim()} aria-label="Send">↑</button>
      </form>
      {err ? <p className="tr-err" role="status">{err}</p> : null}
      <div className="tr-foot"><button type="button" onClick={() => openAgent(s.id)}>Open chat ⤢</button><button type="button" onClick={() => dismiss(s)}>Later</button></div>
    </>
  ) : (
    <>
      <div className="tr-who"><b>{name}</b><span className="tr-pill ok">Finished</span></div>
      <p className="tr-q">{didSummary(saidOf(s, voice), 110) || 'Done for now.'}</p>
      <div className="tr-foot">
        <button type="button" className={`tr-hi5${fived ? ' done' : ''}`} onClick={highFive} disabled={fived} title="A cheer for them. It isn’t sent to them and doesn’t wake them."><span aria-hidden>✋</span> {fived ? 'High-fived!' : 'High-five'}</button>
        <button type="button" onClick={() => openAgent(s.id)}>Open chat ⤢</button>
        <button type="button" onClick={() => dismiss(s)} aria-label="Hide">×</button>
      </div>
    </>
  );
  return createPortal(<div className="tr-card" onPointerDown={(e) => e.stopPropagation()}>{body}</div>, host);
}
