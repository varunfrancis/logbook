import { useEffect, useMemo, useRef, useState } from 'react';
import type { CrewDay, CrewNote, StateView } from '../../../daemon/types.ts';
import { AgentAvatar } from './Avatar.tsx';
import { chime } from '../audio.ts';
import { mins, money } from '../copy.ts';
import { ago } from '../format.ts';
import { post } from '../useLogbook.ts';
import { handovers, jobsText, medals, type MedalId } from './medals.ts';

function CrewFaces({ c, size = 26 }: { c: CrewDay; size?: number }) {
  const shown = c.agents.slice(0, 4);
  return (
    <span className="crew-faces" title={c.agents.map((a) => a.title).join(', ')}>
      {shown.map((a) => <AgentAvatar key={a.key} agent={a} mood="working" size={size} />)}
      {c.agents.length > shown.length ? <small>+{c.agents.length - shown.length}</small> : null}
    </span>
  );
}

const crewName = (c: CrewDay) => `${c.name} crew`;
const rate = (r: { finished: number; delivered: number }) => (r.finished ? `${r.delivered} of ${r.finished}` : 'no jobs');

/** "Have a word": a short note to the whole crew, starting from a suggested draft. */
function Word({ c, onDone }: { c: CrewDay; onDone: () => void }) {
  const [text, setText] = useState(c.flag?.draft ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    const r = await post('/api/notes', { projectId: c.projectId, text });
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.error ?? 'Couldn’t save the note.');
  };
  return (
    <form className="word" onSubmit={(e) => { e.preventDefault(); send(); }} onClick={(e) => e.stopPropagation()}>
      <label htmlFor={`word-${c.projectId}`}>To the {crewName(c)}:</label>
      <textarea id={`word-${c.projectId}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1200} autoFocus />
      <p className="sub">Every agent on {c.name} is told this: new sessions when they start, and agents already working on their next turn. It stays until you remove it.</p>
      <div className="row">
        <button className="btn dark" type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
        <button className="ghost" type="button" onClick={onDone}>Cancel</button>
        {err ? <span className="bad-text" role="alert">{err}</span> : null}
      </div>
    </form>
  );
}

function NeedsWord({ c, openProject }: { c: CrewDay; openProject: (id: string) => void }) {
  const [writing, setWriting] = useState(false);
  return (
    <li className="medal-row needs-word" onClick={() => openProject(c.projectId)}>
      <span className="medal-icon" aria-hidden="true">🗣</span>
      <span className="medal-label">Needs a word</span>
      <span className="medal-who"><CrewFaces c={c} /><b>{crewName(c)}</b></span>
      <span className="medal-val">{c.flag!.reasons.join(' · ')}</span>
      {writing ? <Word c={c} onDone={() => setWriting(false)} /> : (
        <span className="row word-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn dark small" onClick={() => setWriting(true)}>Have a word</button>
          <button className="ghost small" onClick={() => post('/api/crews/dismiss', { projectId: c.projectId })}>It’s fine</button>
        </span>
      )}
    </li>
  );
}

function Notes({ notes, now, openProject }: { notes: CrewNote[]; now: number; openProject: (id: string) => void }) {
  return (
    <div className="notes">
      <h3>Your standing notes <small>every agent on that project is told these</small></h3>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            <div className="note-body">
              <div><button className="link" onClick={() => openProject(n.projectId)}><b>{n.projectName} crew</b></button> <span className="sub">· sent {ago(n.createdAt, now)} · reached {n.reached} session{n.reached === 1 ? '' : 's'}</span></div>
              <div className="note-text">{n.text}</div>
              <div className="sub">Delivered: {rate(n.before)} in the week before → {rate(n.since)} since</div>
            </div>
            <button className="ghost small" onClick={() => post(`/api/notes/${n.id}/remove`)}>Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Col = { key: string; label: string; get: (c: CrewDay) => number; show: (c: CrewDay) => string };
const COLS: Col[] = [
  { key: 'points', label: 'Delivered', get: (c) => c.points, show: (c) => (c.delivered ? jobsText(c) : '—') },
  { key: 'rate', label: 'Hit rate', get: (c) => (c.finished ? c.delivered / c.finished : -1), show: (c) => (c.finished ? `${c.delivered}/${c.finished}` : '—') },
  { key: 'lost', label: 'Scrapped', get: (c) => c.lost, show: (c) => String(c.lost || '') },
  { key: 'work', label: 'Worked', get: (c) => c.workMs, show: (c) => (c.workMs ? mins(c.workMs) : '—') },
  { key: 'asks', label: 'Questions', get: (c) => c.interruptions, show: (c) => String(c.interruptions) },
  { key: 'cost', label: 'Cost', get: (c) => c.costUsd, show: (c) => money(c.costUsd) },
  { key: 'checks', label: 'Checks', get: (c) => c.checksOk - c.checksFail, show: (c) => (c.checksOk + c.checksFail ? `${c.checksOk}✓ ${c.checksFail}✕` : '—') },
];

function FullTable({ crews, openProject }: { crews: CrewDay[]; openProject: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'points', desc: true });
  const col = COLS.find((c) => c.key === sort.key) ?? COLS[0];
  const rows = [...crews].sort((a, b) => (sort.desc ? -1 : 1) * (col.get(a) - col.get(b)) || a.name.localeCompare(b.name));
  return (
    <div className="ptable-wrap">
      <table className="ptable crew-table">
        <thead><tr><th>Crew</th>{COLS.map((c) => (
          <th key={c.key} className="r" aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
            <button className="sort" onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : true })}>{c.label}{sort.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
          </th>
        ))}</tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.projectId} onClick={() => openProject(c.projectId)}>
              <td><span className="medal-who"><CrewFaces c={c} size={22} /><b>{c.name}</b></span></td>
              {COLS.map((col) => <td key={col.key} className="r num">{col.show(c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Today's medals on the Crew tab: one crew per category, plus a gentle "needs a word" for a crew having a rough day. */
export function Leaderboard({ state, now, openProject }: { state: StateView; now: number; openProject: (id: string) => void }) {
  const crews = state.crews ?? [];
  const board = useMemo(() => medals(crews), [crews]);
  const fresh = useFreshMedals(board);
  const flagged = crews.filter((c) => c.flag);
  const notes = state.notes ?? [];
  const finished = crews.filter((c) => c.finished).length;
  return (
    <section className="leaderboard">
      <h2>Today’s medals <small>resets at midnight · {finished ? `${finished} crew${finished === 1 ? ' has' : 's have'} finished work today` : 'whole crews per project, judged together'}</small></h2>
      {crews.length ? (
        <ul className="medals">
          {board.map((m) => (
            <li key={m.id} className={`medal-row${m.holder ? '' : ' empty'}${fresh.has(m.id) ? ' fresh' : ''}`} onClick={() => m.holder && openProject(m.holder.projectId)} title={m.help}>
              <span className="medal-icon" aria-hidden="true">{m.icon}</span>
              <span className="medal-label">{m.label}</span>
              {m.holder ? <>
                <span className="medal-who"><CrewFaces c={m.holder} /><b>{crewName(m.holder)}</b></span>
                <span className="medal-val">{m.value}{m.runnerUp ? <small>runner-up: {m.runnerUp.crew.name}, {m.runnerUp.value}</small> : null}</span>
              </> : <span className="medal-val muted">Nobody yet</span>}
            </li>
          ))}
          {flagged.map((c) => <NeedsWord key={c.projectId} c={c} openProject={openProject} />)}
        </ul>
      ) : <div className="empty"><b>No medals yet today.</b> They’re handed out as crews finish jobs.</div>}
      {notes.length ? <Notes notes={notes} now={now} openProject={openProject} /> : null}
      {crews.length ? (
        <details className="fold crew-full">
          <summary><h3>Full table <small>every crew, every column</small></h3></summary>
          <FullTable crews={crews} openProject={openProject} />
        </details>
      ) : null}
    </section>
  );
}

// ---------- medals changing hands ----------

// Module-level so switching tabs doesn't replay old handovers.
const holders = new Map<MedalId, string | null>();
const changedAt = new Map<MedalId, number>();
const listeners = new Set<() => void>();
let toastQueue: { key: string; text: string; projectId: string }[] = [];
let trackedDay = '';

/** Compares medal holders with last time; returns how many medals changed hands. The first look each day only records them. */
function track(state: StateView): number {
  const board = medals(state.crews ?? []);
  const today = new Date().toDateString();
  if (trackedDay !== today) { trackedDay = today; holders.clear(); for (const m of board) holders.set(m.id, m.holder?.projectId ?? null); return 0; }
  const moved = handovers(holders, board);
  const names = new Map((state.crews ?? []).map((c) => [c.projectId, c.name]));
  for (const { medal, from } of moved) {
    changedAt.set(medal.id, Date.now());
    const who = `${medal.holder!.name} crew`;
    toastQueue = [...toastQueue, { key: `${medal.id}-${Date.now()}`, projectId: medal.holder!.projectId, text: from ? `${medal.icon} ${who} took ${medal.label} from ${names.get(from) ?? 'another crew'}` : `${medal.icon} ${who} won ${medal.label}` }].slice(-3);
  }
  for (const m of board) holders.set(m.id, m.holder?.projectId ?? null);
  if (moved.length) listeners.forEach((f) => f());
  return moved.length;
}

function useFreshMedals(board: ReturnType<typeof medals>) {
  const now = Date.now();
  return new Set(board.filter((m) => now - (changedAt.get(m.id) ?? 0) < 8000).map((m) => m.id));
}

/** Toasts anywhere in the app when a medal changes hands. */
export function MedalToasts({ state, openProject }: { state: StateView; openProject: (id: string) => void }) {
  const [, force] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => { const f = () => force((n) => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  useEffect(() => {
    if (track(state)) chime();
    for (const t of toastQueue) if (!timers.current.has(t.key)) timers.current.set(t.key, setTimeout(() => dismiss(t.key), 9000));
  }, [state]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const dismiss = (key: string) => { toastQueue = toastQueue.filter((t) => t.key !== key); timers.current.delete(key); force((n) => n + 1); };
  if (!toastQueue.length) return null;
  return (
    <div className="medal-toasts" role="status" aria-live="polite">
      {toastQueue.map((t) => (
        <div key={t.key} className="bump-toast medal-toast">
          <button className="bump-text link" onClick={() => { openProject(t.projectId); dismiss(t.key); }}>{t.text}</button>
          <button className="bump-x" onClick={() => dismiss(t.key)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
