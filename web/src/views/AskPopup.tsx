import { useEffect, useRef, useState } from 'react';
import type { AskQuestion, AskView, SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { GoTo } from '../components.tsx';
import { duration } from '../format.ts';
import { post, useNow } from '../useSwarmville.ts';
import { yourTurn } from '../../../daemon/turn.ts';

type Decision = 'allow' | 'always' | 'deny' | 'answer' | 'changes';
type Answer = { picked: string[]; other: string };
const DONE: Record<Decision, string> = {
  allow: 'Approved.', always: 'Approved, and they won’t ask about this again.', deny: 'Told them no.',
  answer: 'Sent.', changes: 'Sent your changes. They’ll rework it and ask again.',
};

/**
 * What a raised hand is asking, answered on the spot: clicking an agent with a hand up in the town opens this instead of
 * their profile drawer. Permission prompts get Approve / Deny, questions get their choices (or your own words), and a
 * plan can go back with the changes you want. The terminal prompt stays up meanwhile; whichever answers first wins.
 */
/** Answering a raised hand: sends your decision and keeps what to say once it's in. Shared by the popup and the chat. */
export function useAsk(s: SessionView | undefined) {
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answer = async (decision: Decision, extra: { answers?: Answer[]; note?: string } = {}) => {
    if (!s?.ask || busy) return;
    setBusy(true); setErr(null);
    const r = await post(`/api/ask/${encodeURIComponent(s.ask.id)}`, { decision, ...extra });
    setBusy(false);
    if (r.ok) setDone(`${DONE[decision]}${decision === 'deny' || decision === 'changes' ? '' : ` ${s.agent.name} is back to work.`}`);
    else if (/first/.test(r.message ?? '')) setErr(r.message);
    else setDone(r.message ?? 'That one was already answered.');
  };
  return { done, setDone, busy, err, answer };
}

/** The choices for what they asked: Approve / Deny, a plan to approve or change, or their questions. */
export function AskBody({ s, busy, answer, focus = true }: { s: SessionView; busy: boolean; answer: ReturnType<typeof useAsk>['answer']; focus?: boolean }) {
  const a = s.ask;
  return !a ? <TerminalOnly s={s} />
    : a.questions?.length ? <Questions key={a.id} qs={a.questions} busy={busy} onSend={(answers) => answer('answer', { answers })} />
    : a.tool === 'ExitPlanMode' ? <Plan key={a.id} a={a} busy={busy} focus={focus} onAnswer={answer} />
    : <Permission key={a.id} a={a} busy={busy} focus={focus} onAnswer={answer} />;
}

export function AskPopup({ id, state, onClose, openProfile }: { id: string; state: StateView; onClose: () => void; openProfile: (id: string) => void }) {
  const now = useNow(15000);
  const s = state.sessions.find((x) => x.id === id);
  const { done, setDone, busy, err, answer } = useAsk(s);
  const seen = useRef<string | null>(s?.ask?.id ?? null);

  // Answered in the terminal (or the agent moved on) while this was open: say so, then get out of the way.
  const settled = !s || s.status !== 'needs_input' || (seen.current && s.ask?.id !== seen.current);
  useEffect(() => {
    if (settled && !done) setDone(s?.status === 'ended' ? 'They clocked out.' : 'Answered in the terminal.');
  }, [settled]);
  useEffect(() => { if (done) { const t = setTimeout(onClose, 1400); return () => clearTimeout(t); } }, [done]);
  useEffect(() => { if (s?.ask && !seen.current) seen.current = s.ask.id; }, [s?.ask?.id]);

  if (!s) return null;
  const project = state.projects.find((p) => p.id === s.projectId);
  const a = s.ask;
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

        {done ? <p className="ask-done" role="status">{done}</p>
          : !a && s.handKind === 'question' && s.runner ? <Reply s={s} onSent={(words) => setDone(`Sent “${words.length > 60 ? words.slice(0, 59) + '…' : words}”. ${s.agent.name} is back to work.`)} />
          : <AskBody s={s} busy={busy} answer={answer} />}
        {err && !done ? <p className="ask-err" role="alert">{err}</p> : null}

        {!done ? (
          <footer className="ask-foot">
            {a ? <GoTo s={s} /> : <span />}
            <button className="link" onClick={() => openProfile(s.id)}>Full profile</button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** Their last reply asked you something: answer it like any message, picking one of the answers it offered or in your own words. */
function Reply({ s, onSent }: { s: SessionView; onSent: (words: string) => void }) {
  const answers = yourTurn(s.outcome ?? '')?.answers ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const words = text.trim() || answers.find((x) => x.label === picked)?.say || '';
  const send = async () => {
    if (!words || busy) return;
    setBusy(true); setErr(null);
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/send`, { text: words });
    setBusy(false);
    if (r.ok) onSent(words); else setErr(r.message ?? 'Couldn’t send it.');
  };
  return (
    <>
      <div className="ask-body">
        <p className="ask-title" id="ask-q-reply">{s.needsMessage}</p>
        {answers.length ? (
          <div className="ask-opts" role="radiogroup" aria-labelledby="ask-q-reply">
            {answers.map((x) => (
              <button key={x.label} type="button" className={`ask-opt${picked === x.label ? ' on' : ''}`} role="radio" aria-checked={picked === x.label}
                onClick={() => setPicked(x.label)} disabled={busy}>
                <i className="ask-dot" aria-hidden="true" /><b>{x.label}</b>
              </button>
            ))}
          </div>
        ) : null}
        <textarea className="ask-input" rows={2} value={text} disabled={busy} aria-label={`Reply to ${s.agent.name}`} autoFocus={!answers.length}
          placeholder={answers.length ? 'Something else… (type your own answer)' : `Reply to ${s.agent.name}…`}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} />
        {err ? <p className="ask-err" role="alert">{err}</p> : null}
      </div>
      <div className="ask-actions"><button className="btn approve" onClick={send} disabled={busy || !words}>Send answer</button></div>
    </>
  );
}

function TerminalOnly({ s }: { s: SessionView }) {
  return (
    <>
      <div className="ask-body">
        <p className="ask-title">{s.needsMessage ?? 'Waiting for you'}</p>
        <p className="sub">{s.handKind === 'question' ? 'They asked this in their terminal. Answer them there.' : 'This one needs an answer in their terminal.'}</p>
      </div>
      <div className="ask-actions"><GoTo s={s} primary /></div>
    </>
  );
}

function Detail({ a }: { a: AskView }) {
  if (!a.detail) return null;
  return a.detailKind === 'command' ? <pre className="ask-detail cmd"><code>{a.detail}</code></pre>
    : a.detailKind === 'path' ? <code className="ask-detail path">{a.detail}</code>
    : <pre className="ask-detail">{a.detail}</pre>;
}

function Permission({ a, busy, focus, onAnswer }: { a: AskView; busy: boolean; focus: boolean; onAnswer: (d: Decision) => void }) {
  const approve = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focus) approve.current?.focus(); }, []);
  return (
    <>
      <div className="ask-body"><p className="ask-title">{a.title}</p><Detail a={a} /></div>
      <div className="ask-actions">
        <button ref={approve} className="btn approve" onClick={() => onAnswer('allow')} disabled={busy}>Approve</button>
        {a.canAlways ? <button className="ghost" onClick={() => onAnswer('always')} disabled={busy} title="Approve, and let them do this again without asking">Always allow</button> : null}
        <button className="ghost deny" onClick={() => onAnswer('deny')} disabled={busy}>Deny</button>
      </div>
    </>
  );
}

/** A plan ready to start: approve it, or send it back with what should change. */
function Plan({ a, busy, focus, onAnswer }: { a: AskView; busy: boolean; focus: boolean; onAnswer: (d: Decision, extra?: { note?: string }) => void }) {
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (changing) box.current?.focus(); }, [changing]);
  if (changing) {
    return (
      <>
        <div className="ask-body">
          <p className="ask-title">What should change?</p>
          <textarea id="plan-note" ref={box} className="ask-input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Do step 3 first, and show me a mockup before step 2."
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) onAnswer('changes', { note }); }} />
        </div>
        <div className="ask-actions">
          <button className="btn approve" onClick={() => onAnswer('changes', { note })} disabled={busy || !note.trim()}>Send changes</button>
          <button className="ghost" onClick={() => setChanging(false)} disabled={busy}>Back to the plan</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="ask-body"><p className="ask-title">{a.title}</p><Detail a={a} /></div>
      <div className="ask-actions">
        <button className="btn approve" onClick={() => onAnswer('allow')} disabled={busy} autoFocus={focus}>Approve</button>
        <button className="ghost" onClick={() => setChanging(true)} disabled={busy}>Ask for changes</button>
        <button className="ghost deny" onClick={() => onAnswer('deny')} disabled={busy}>Deny</button>
      </div>
    </>
  );
}

/** One page per question: pick from their choices, or say it in your own words. */
function Questions({ qs, busy, onSend }: { qs: AskQuestion[]; busy: boolean; onSend: (answers: Answer[]) => void }) {
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => qs.map(() => ({ picked: [], other: '' })));
  const q = qs[i];
  const cur = answers[i];
  const set = (next: Answer) => setAnswers((all) => all.map((x, j) => (j === i ? next : x)));
  const toggle = (label: string) => set({ ...cur, picked: q.multiSelect ? (cur.picked.includes(label) ? cur.picked.filter((l) => l !== label) : [...cur.picked, label]) : [label] });
  const answered = (x: Answer) => x.picked.length > 0 || x.other.trim().length > 0;
  const last = i === qs.length - 1;
  const ready = answered(cur);
  const next = () => { if (!ready) return; if (last) onSend(answers); else setI(i + 1); };

  return (
    <>
      <div className="ask-body">
        <div className="ask-qhead">
          {q.header ? <span className="ask-chip">{q.header}</span> : null}
          {qs.length > 1 || q.multiSelect ? <span className="ask-of">{qs.length > 1 ? `${i + 1} of ${qs.length}` : ''}{q.multiSelect ? `${qs.length > 1 ? ' · ' : ''}pick any` : ''}</span> : null}
        </div>
        <p className="ask-title" id={`ask-q-${i}`}>{q.question}</p>
        <div className="ask-opts" role={q.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={`ask-q-${i}`}>
          {q.options.map((o) => {
            const on = cur.picked.includes(o.label);
            const rec = /\(recommended\)\s*$/i.test(o.label);
            return (
              <button key={o.label} type="button" className={`ask-opt${q.multiSelect ? ' multi' : ''}${on ? ' on' : ''}`}
                role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => toggle(o.label)} disabled={busy}>
                <i className="ask-dot" aria-hidden="true" />
                <b>{rec ? o.label.replace(/\s*\(recommended\)\s*$/i, '') : o.label}{rec ? <span className="ask-rec">Suggested</span> : null}</b>
                {o.description ? <span>{o.description}</span> : null}
              </button>
            );
          })}
        </div>
        <textarea id={`ask-other-${i}`} className="ask-input" rows={2} value={cur.other} disabled={busy} aria-label="Something else, in your own words"
          placeholder={q.options.length ? 'Something else… (type your own answer)' : 'Your answer'}
          onChange={(e) => set({ ...cur, other: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) next(); }} />
      </div>
      <div className="ask-actions">
        <button className="btn approve" onClick={next} disabled={busy || !ready}>{last ? (qs.length > 1 ? 'Send answers' : 'Send answer') : 'Next question →'}</button>
        {i > 0 ? <button className="ghost" onClick={() => setI(i - 1)} disabled={busy}>← Back</button> : null}
      </div>
    </>
  );
}
