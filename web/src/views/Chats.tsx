import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, FOREMAN, moodFor } from '../crew/Avatar.tsx';
import { useVoice } from '../copy.ts';
import { ago, tildify } from '../format.ts';
import { GoTo, PrChip } from '../components.tsx';
import { useNow } from '../useSwarmville.ts';
import { chatList, chatPreview, GROUPS, isUnread, useSeen, type ChatGroup } from '../chats.ts';
import { StartWork } from '../welcome/StartWork.tsx';
import { MOVES_FOR_JOB } from '../welcome/moves.ts';
import { AgentChat } from './Chat.tsx';
import { statusLine } from './AgentPanel.tsx';

/*
 * Chats: every agent on the left, the conversation on the right, like a team chat app.
 * The conversation is the same AgentChat the drawer uses; this screen adds the list, a header, an optional profile rail,
 * "Give a task", and keys to move between agents.
 */

const RAIL_KEY = 'swarmville.chatRail';
const FOLD_KEY = 'swarmville.chatFoldEarlier';
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };

export function Chats({ state, chatId, setChatId, openProject, openAsk, openProfile }: {
  state: StateView; chatId: string | null; setChatId: (id: string | null) => void;
  openProject: (id: string) => void; openAsk: (sessionId: string) => void; openProfile: (sessionId: string) => void;
}) {
  const voice = useVoice();
  const now = useNow(30000);
  const { seen, since } = useSeen();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'chat' | 'new'>('chat');
  const [reading, setReading] = useState(!!chatId); // phones: the list, or one conversation
  const [rail, setRail] = useState(store.get(RAIL_KEY) === '1');
  const [foldEarlier, setFoldEarlier] = useState(store.get(FOLD_KEY) !== '0');
  const find = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const projectName = useMemo(() => new Map(state.projects.map((p) => [p.id, p.name])), [state.projects]);
  const groups = useMemo(() => chatList(state.sessions.map((s) => ({ ...s, projectName: projectName.get(s.projectId ?? '') })), now, query), [state.sessions, projectName, now, query]);
  const isFolded = (g: ChatGroup) => g === 'earlier' && foldEarlier && !query;
  const order = groups.flatMap((g) => (isFolded(g.group) ? [] : g.items.map((s) => s.id)));

  // Nothing picked yet (or they're gone): open whoever's first in the list.
  const s = state.sessions.find((x) => x.id === chatId) ?? null;
  useEffect(() => { if (!chatId && order[0] && mode === 'chat') setChatId(order[0]); }, [chatId, order[0], mode]);

  const pick = (id: string) => { setChatId(id); setMode('chat'); setReading(true); };
  const step = (by: number) => {
    if (!order.length) return;
    const i = order.indexOf(chatId ?? '');
    const next = order[(i < 0 ? 0 : i + by + order.length) % order.length];
    pick(next);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); find.current?.focus(); find.current?.select(); return; }
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  });
  const toggleRail = () => { setRail(!rail); store.set(RAIL_KEY, rail ? '0' : '1'); };
  const toggleFold = () => { setFoldEarlier(!foldEarlier); store.set(FOLD_KEY, foldEarlier ? '0' : '1'); };

  return (
    <div className={`chats${reading ? ' reading' : ''}${rail && s && mode === 'chat' ? ' with-rail' : ''}`}>
      <aside className="chats-side" aria-label="Agents">
        <div className="chats-top">
          <button type="button" className={`btn chats-new${mode === 'new' ? ' on' : ''}`} onClick={() => { setMode('new'); setReading(true); }}>＋ Give a task</button>
          <label className="chats-find" htmlFor="chats-find">
            <span aria-hidden>⌕</span>
            <input ref={find} id="chats-find" type="search" value={query} placeholder="Find an agent or job" autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setQuery(''); }
                if (e.key === 'Enter' && order[0]) { pick(order[0]); setQuery(''); }
              }} />
            <kbd aria-hidden>⌘K</kbd>
          </label>
        </div>
        <nav className="chats-list" ref={listRef} aria-label="Conversations">
          {!groups.length ? <p className="chats-none">{query ? 'No agent matches that.' : 'Nobody’s been at work today. Give someone a task to get started.'}</p> : null}
          {groups.map((g) => {
            const label = GROUPS.find((x) => x.id === g.group)!.label;
            const folded = isFolded(g.group);
            return (
              <section key={g.group} className={`chats-group g-${g.group}`}>
                {g.group === 'earlier' && !query
                  ? <button type="button" className="chats-gh fold" aria-expanded={!folded} onClick={toggleFold}><i aria-hidden />{label} <span aria-hidden>{folded ? '▸' : '▾'}</span><span className="n">{g.items.length}</span></button>
                  : <h3 className="chats-gh"><i aria-hidden />{label}<span className="n">{g.items.length}</span></h3>}
                {folded ? null : g.items.map((x) => (
                  <Row key={x.id} s={x} project={x.projectName} on={mode === 'chat' && x.id === chatId} unread={isUnread(x, seen, since) && x.id !== chatId}
                    preview={chatPreview(x, voice)} now={now} onPick={() => pick(x.id)} />
                ))}
              </section>
            );
          })}
        </nav>
      </aside>

      <section className="chats-main" aria-label="Conversation">
        {mode === 'new' ? (
          <>
            <header className="chats-head">
              <button type="button" className="ghost small chats-back" onClick={() => setReading(false)} aria-label="Back to the list">‹</button>
              <AgentAvatar agent={FOREMAN} mood="hello" size={38} />
              <div className="chats-id"><b>Give a task</b><small>Pick a project. Swarmville starts an agent there, and their chat opens here.</small></div>
            </header>
            <div className="chats-new-body">
              <StartWork state={state} moves={MOVES_FOR_JOB.builder} idPrefix="chats-new" here
                onStarted={(r) => { if (r.sessionId) pick(r.sessionId); }} />
            </div>
          </>
        ) : s ? (
          <>
            <Head s={s} project={projectName.get(s.projectId ?? '')} rail={rail} toggleRail={toggleRail} back={() => setReading(false)} />
            <AgentChat key={s.id} s={s} openAsk={openAsk} />
          </>
        ) : chatId ? (
          <p className="chats-empty">Getting them ready…</p>
        ) : (
          <p className="chats-empty">Pick someone on the left, or give a new task.</p>
        )}
      </section>

      {rail && s && mode === 'chat' ? <Rail s={s} project={projectName.get(s.projectId ?? '')} openProject={openProject} openProfile={openProfile} now={now} /> : null}
    </div>
  );
}

function Row({ s, project, on, unread, preview, now, onPick }: { s: SessionView; project?: string; on: boolean; unread: boolean; preview: string; now: number; onPick: () => void }) {
  const terminal = !s.runner && (s.status === 'running' || s.status === 'needs_input' || s.status === 'idle');
  const job = s.focus ?? (/^new session$/i.test(s.title) ? null : s.title); // "New session" says nothing: leave the line out
  return (
    <button type="button" data-id={s.id} className={`chats-row s-${s.status}${on ? ' on' : ''}${unread ? ' unread' : ''}`} onClick={onPick} aria-current={on ? 'true' : undefined}>
      <span className="chats-face"><AgentAvatar agent={s.agent} mood={moodFor(s)} size={36} /><span className={`chats-dot dot s-${s.away ? 'away' : s.status}`} aria-hidden /></span>
      <span className="chats-who">
        <span className="l1"><b>{s.agent.name}</b>{project ? <span className="proj">{project}</span> : null}</span>
        {job ? <span className="l2">{job}</span> : null}
        <span className="l3">{s.status === 'needs_input' ? '✋ ' : ''}{preview}</span>
      </span>
      <span className="chats-meta">
        <span>{s.status === 'running' ? 'now' : ago(s.lastEventAt ?? s.endedAt, now).replace(' ago', '')}</span>
        {unread ? <span className="chats-new-dot" title="New reply" /> : terminal ? <span className="chats-term" title="Running in your terminal: read here, reply there">›_</span> : null}
      </span>
    </button>
  );
}

function Head({ s, project, rail, toggleRail, back }: { s: SessionView; project?: string; rail: boolean; toggleRail: () => void; back: () => void }) {
  const voice = useVoice();
  const now = useNow(15000);
  const st = statusLine(s, voice, now);
  return (
    <header className="chats-head">
      <button type="button" className="ghost small chats-back" onClick={back} aria-label="Back to the list">‹</button>
      <AgentAvatar agent={s.agent} mood={moodFor(s)} size={38} live={s.status !== 'ended'} />
      <div className="chats-id">
        <b>{s.agent.title}</b>
        <small><span className={`dot s-${st.cls}`} /><span>{st.text}</span>{project ? <><span aria-hidden>·</span><span>{project}</span></> : null}{s.focus ? <><span aria-hidden>·</span><span className="job">{s.focus}</span></> : null}</small>
      </div>
      <button type="button" className={`ghost small chats-prof${rail ? ' on' : ''}`} aria-pressed={rail} onClick={toggleRail} title="Show who they are and what they’re working on">Profile</button>
    </header>
  );
}

function Rail({ s, project, openProject, openProfile, now }: { s: SessionView; project?: string; openProject: (id: string) => void; openProfile: (id: string) => void; now: number }) {
  const a = s.agent;
  return (
    <aside className="chats-rail" aria-label={`About ${a.name}`}>
      <AgentAvatar agent={a} mood={moodFor(s)} size={72} live={s.status !== 'ended'} />
      <h3>{a.title}</h3>
      <dl>
        {project && s.projectId ? <><dt>Project</dt><dd><button type="button" className="link" onClick={() => openProject(s.projectId!)}>{project}</button></dd></> : null}
        {s.focus ? <><dt>Job</dt><dd>{s.focus}</dd></> : null}
        {s.branch ? <><dt>Branch</dt><dd><code>{s.branch}</code></dd></> : null}
        {s.cwd ? <><dt>Folder</dt><dd><code>{tildify(s.cwd)}</code></dd></> : null}
        <dt>Runs in</dt><dd>{s.runner ? 'Swarmville' : s.scheduled ? 'A scheduled job' : 'Your terminal'}</dd>
        {s.startedAt ? <><dt>Started</dt><dd>{ago(s.startedAt, now)}</dd></> : null}
      </dl>
      <div className="row">{s.prUrl ? <PrChip url={s.prUrl} state={s.prState} /> : null}{s.status !== 'ended' && !s.runner ? <GoTo s={s} /> : null}</div>
      <button type="button" className="link chats-full" onClick={() => openProfile(s.id)}>Full profile, scorecard and jobs ›</button>
    </aside>
  );
}
