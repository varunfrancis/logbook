import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { CrewDay, CrewNote, StateView } from '../../../daemon/types.ts';
import { AgentAvatar } from './Avatar.tsx';
import { mins, money, STAT_HELP, useCostView } from '../copy.ts';
import { ago } from '../format.ts';
import { post } from '../useSwarmville.ts';
import { handovers, jobsText, medals, type MedalId } from './medals.ts';

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
      <label htmlFor={`word-${c.projectId}`}>To everyone on {c.name}:</label>
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

function Notes({ notes, now, openProject }: { notes: CrewNote[]; now: number; openProject: (id: string) => void }) {
  return (
    <div className="notes">
      <h3>Your standing notes <small>every agent on that project is told these</small></h3>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            <div className="note-body">
              <div><button className="link" onClick={() => openProject(n.projectId)}><b>{n.projectName}</b></button> <span className="sub">· sent {ago(n.createdAt, now)} · reached {n.reached} session{n.reached === 1 ? '' : 's'}</span></div>
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

type Col = { key: string; label: string; help?: string; get: (c: CrewDay) => number; show: (c: CrewDay) => string; tip?: (c: CrewDay) => string };
const ALL_COLS: Col[] = [
  { key: 'delivered', label: 'Delivered', help: 'Delivered: jobs that ended with work you kept (live, sent for review, or saved).', get: (c) => c.delivered + c.points / 1000, show: (c) => (c.delivered ? String(c.delivered) : '—'), tip: (c) => (c.delivered ? jobsText(c) : '') },
  { key: 'rate', label: 'Hit rate', help: STAT_HELP.hitRate, get: (c) => (c.finished ? c.delivered / c.finished : -1), show: (c) => (c.finished ? `${c.delivered}/${c.finished}` : '—') },
  { key: 'lost', label: 'Scrapped', help: STAT_HELP.scrapped, get: (c) => c.lost, show: (c) => String(c.lost || '—') },
  { key: 'work', label: 'Worked', help: 'Worked: time spent actually working today, not waiting.', get: (c) => c.workMs, show: (c) => (c.workMs ? mins(c.workMs) : '—') },
  { key: 'asks', label: 'Questions', help: 'Questions: how many times they stopped to ask you something.', get: (c) => c.interruptions, show: (c) => String(c.interruptions) },
  { key: 'cost', label: 'Cost', get: (c) => c.costUsd, show: (c) => money(c.costUsd) },
  { key: 'checks', label: 'Checks', help: STAT_HELP.checks, get: (c) => c.checksOk - c.checksFail, show: (c) => (c.checksOk + c.checksFail ? `${c.checksOk}✓ ${c.checksFail}✕` : '—') },
];

function Agents({ c }: { c: CrewDay }) {
  const names = c.agents.map((a) => a.name);
  return (
    <span className="lb-agents" title={c.agents.map((a) => a.title).join(', ')}>
      <span className="crew-faces">{c.agents.slice(0, 4).map((a) => <AgentAvatar key={a.key} agent={a} mood="working" size={22} />)}</span>
      <span>{names.slice(0, 2).join(', ')}{names.length > 2 ? ` +${names.length - 2}` : ''}</span>
    </span>
  );
}

/** Today's crews as one table: the project, its agents, the numbers, and whatever awards it holds. */
export function Leaderboard({ state, now, openProject }: { state: StateView; now: number; openProject: (id: string) => void }) {
  const crews = state.crews ?? [];
  const api = useCostView() === 'api';
  const COLS = api ? ALL_COLS : ALL_COLS.filter((c) => c.key !== 'cost');
  const board = useMemo(() => medals(crews, api), [crews, api]);
  const fresh = useFreshMedals(board);
  const notes = state.notes ?? [];
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'awards', desc: true });
  const [writing, setWriting] = useState<string | null>(null);
  const won = (c: CrewDay) => board.filter((m) => m.holder?.projectId === c.projectId);
  // Default order: most awards first, then most delivered.
  const get = sort.key === 'awards' ? (c: CrewDay) => won(c).length * 1000 + c.delivered + c.points / 1000 : (COLS.find((c) => c.key === sort.key) ?? COLS[0]).get;
  const rows = [...crews].sort((a, b) => (sort.desc ? -1 : 1) * (get(a) - get(b)) || a.name.localeCompare(b.name));
  const sortBy = (key: string) => setSort({ key, desc: sort.key === key ? !sort.desc : true });
  const arrow = (key: string) => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '');
  return (
    <section className="leaderboard">
      <h2>Leaderboard <small>today · resets at midnight</small></h2>
      {crews.length ? (
        <div className="ptable-wrap">
          <table className="ptable crew-table">
            <thead><tr>
              <th>Project</th><th>Agents</th>
              <th aria-sort={sort.key === 'awards' ? (sort.desc ? 'descending' : 'ascending') : 'none'}><button className="sort" onClick={() => sortBy('awards')}>Awards{arrow('awards')}</button></th>
              {COLS.map((c) => (
                <th key={c.key} className="r" title={c.help} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                  <button className="sort" onClick={() => sortBy(c.key)}>{c.label}{arrow(c.key)}</button>
                </th>
              ))}
            </tr></thead>
            <tbody>
              {rows.map((c) => (
                <Fragment key={c.projectId}>
                  <tr onClick={() => openProject(c.projectId)} className={c.flag ? 'flagged' : ''}>
                    <td><b>{c.name}</b></td>
                    <td><Agents c={c} /></td>
                    <td className="awards" onClick={(e) => e.stopPropagation()}>
                      {won(c).map((m) => <span key={m.id} className={`award${fresh.has(m.id) ? ' fresh' : ''}`} title={`${m.label}: ${m.value}`} aria-label={m.label}>{m.icon}</span>)}
                      {c.flag ? (
                        <span className="award-word">
                          <span className="award" title={`Needs a word: ${c.flag.reasons.join(' · ')}`} aria-label="Needs a word">🗣</span>
                          {writing !== c.projectId ? <>
                            <button className="ghost small" onClick={() => setWriting(c.projectId)} title={c.flag.reasons.join(' · ')}>Have a word</button>
                            <button className="ghost small" onClick={() => post('/api/crews/dismiss', { projectId: c.projectId })}>It’s fine</button>
                          </> : null}
                        </span>
                      ) : null}
                    </td>
                    {COLS.map((col) => <td key={col.key} className="r num" title={col.tip?.(c) || undefined}>{col.show(c)}</td>)}
                  </tr>
                  {writing === c.projectId && c.flag ? (
                    <tr className="word-row"><td colSpan={COLS.length + 3}>
                      <div className="sub">Needs a word: {c.flag.reasons.join(' · ')}</div>
                      <Word c={c} onDone={() => setWriting(null)} />
                    </td></tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="empty"><b>Nobody has worked yet today.</b></div>}
      {notes.length ? <Notes notes={notes} now={now} openProject={openProject} /> : null}
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
function track(state: StateView, api: boolean): number {
  const board = medals(state.crews ?? [], api);
  const today = new Date().toDateString();
  if (trackedDay !== today) { trackedDay = today; holders.clear(); for (const m of board) holders.set(m.id, m.holder?.projectId ?? null); return 0; }
  const moved = handovers(holders, board);
  const names = new Map((state.crews ?? []).map((c) => [c.projectId, c.name]));
  for (const { medal, from } of moved) {
    changedAt.set(medal.id, Date.now());
    const who = medal.holder!.name;
    toastQueue = [...toastQueue, { key: `${medal.id}-${Date.now()}`, projectId: medal.holder!.projectId, text: from ? `${medal.icon} ${who} took ${medal.label} from ${names.get(from) ?? 'another project'}` : `${medal.icon} ${who} won ${medal.label}` }].slice(-3);
  }
  for (const m of board) holders.set(m.id, m.holder?.projectId ?? null);
  for (const id of [...holders.keys()]) if (!board.some((m) => m.id === id)) holders.delete(id); // Best value sits out on the plan; forget its holder so turning API prices back on isn't news
  if (moved.length) listeners.forEach((f) => f());
  return moved.length;
}

function useFreshMedals(board: ReturnType<typeof medals>) {
  const now = Date.now();
  return new Set(board.filter((m) => now - (changedAt.get(m.id) ?? 0) < 8000).map((m) => m.id));
}

/** Toasts anywhere in the app when a medal changes hands. */
export function MedalToasts({ state, openProject }: { state: StateView; openProject: (id: string) => void }) {
  const api = useCostView() === 'api';
  const [, force] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => { const f = () => force((n) => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  useEffect(() => {
    track(state, api);
    for (const t of toastQueue) if (!timers.current.has(t.key)) timers.current.set(t.key, setTimeout(() => dismiss(t.key), 9000));
  }, [state, api]);
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
