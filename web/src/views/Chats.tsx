import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, FOREMAN, moodFor } from '../crew/Avatar.tsx';
import { useVoice } from '../copy.ts';
import { ago, tildify } from '../format.ts';
import { GoTo, PrChip } from '../components.tsx';
import { useNow } from '../useSwarmville.ts';
import { chatPreview, chatProjects, chatTask, isUnread, useSeen, type ChatProject } from '../chats.ts';
import { StartWork } from '../welcome/StartWork.tsx';
import { MOVES_FOR_JOB } from '../welcome/moves.ts';
import { AgentChat } from './Chat.tsx';
import { statusLine } from './AgentPanel.tsx';

/*
 * Chats: every task on the left, grouped by project like channels, and the conversation on the right.
 * The conversation is the same AgentChat the drawer uses; this screen adds the list, a header, an optional profile rail,
 * "Give a task", and keys to move between agents.
 */

const RAIL_KEY = 'swarmville.chatRail';
const FOLD_KEY = 'swarmville.chatFolds'; // projects you opened or closed by hand, and which "Done today" lists are open
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };
const readJson = <T,>(k: string, d: T): T => { try { return JSON.parse(store.get(k) || '') as T; } catch { return d; } };
type Folds = { project: Record<string, boolean>; done: Record<string, boolean> };

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
  const [folds, setFoldsRaw] = useState<Folds>(() => readJson(FOLD_KEY, { project: {}, done: {} }));
  const setFolds = (f: Folds) => { setFoldsRaw(f); store.set(FOLD_KEY, JSON.stringify(f)); };
  const [newIn, setNewIn] = useState<string | null>(null); // Give a task, already in this project
  const find = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const projectName = useMemo(() => new Map(state.projects.map((p) => [p.id, p.name])), [state.projects]);
  const list = useMemo(() => chatProjects(state.sessions.map((s) => ({ ...s, projectName: projectName.get(s.projectId ?? '') })), now, query), [state.sessions, projectName, now, query]);
  // A project with nothing live folds to one line (it opens when someone there raises a hand); a search opens everything.
  const projectOpen = (p: ChatProject) => !!query || (folds.project[p.id] ?? (p.live.length > 0 || p.hand || p.empty > 0));
  const doneOpen = (p: ChatProject) => !!query || !!folds.done[p.id];
  const order = [...list.needs.map((x) => x.id), ...list.projects.flatMap((p) => (projectOpen(p) ? [...p.live, ...(doneOpen(p) ? p.done : [])].map((x) => x.id) : []))];

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
  const toggleProject = (p: ChatProject) => setFolds({ ...folds, project: { ...folds.project, [p.id]: !projectOpen(p) } });
  const toggleDone = (p: ChatProject) => setFolds({ ...folds, done: { ...folds.done, [p.id]: !doneOpen(p) } });
  const newTask = (projectId: string | null) => { setNewIn(projectId); setMode('new'); setReading(true); };
  const row = (x: SessionView & { projectName?: string }, withProject = false) => (
    <Row key={x.id} s={x} project={withProject ? x.projectName : undefined} on={mode === 'chat' && x.id === chatId} unread={isUnread(x, seen, since) && x.id !== chatId}
      preview={chatPreview(x, voice)} now={now} onPick={() => pick(x.id)} />
  );

  return (
    <div className={`chats${reading ? ' reading' : ''}${rail && s && mode === 'chat' ? ' with-rail' : ''}`}>
      <aside className="chats-side" aria-label="Agents">
        <div className="chats-top">
          <button type="button" className={`btn chats-new${mode === 'new' ? ' on' : ''}`} onClick={() => newTask(null)}>＋ Give a task</button>
          <label className="chats-find" htmlFor="chats-find">
            <span aria-hidden>⌕</span>
            <input ref={find} id="chats-find" type="search" value={query} placeholder="Find a task or project" autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setQuery(''); }
                if (e.key === 'Enter' && order[0]) { pick(order[0]); setQuery(''); }
              }} />
            <kbd aria-hidden>⌘K</kbd>
          </label>
        </div>
        <nav className="chats-list" ref={listRef} aria-label="Conversations">
          {!list.needs.length && !list.projects.length ? <p className="chats-none">{query ? 'Nothing matches that.' : 'Nobody’s been at work today. Give someone a task to get started.'}</p> : null}
          {list.needs.length ? (
            <section className="chats-group g-needs">
              <h3 className="chats-gh"><i aria-hidden />Needs you<span className="n">{list.needs.length}</span></h3>
              {list.needs.map((x) => row(x, true))}
            </section>
          ) : null}
          {list.projects.map((p) => {
            const open = projectOpen(p);
            return (
              <section key={p.id} className={`chats-project${open ? ' open' : ''}`}>
                <div className="chats-ph">
                  <button type="button" className="chats-ph-name" aria-expanded={open} onClick={() => toggleProject(p)}>
                    <span className="car" aria-hidden>{open ? '▾' : '▸'}</span><b>{p.name}</b>{p.hand ? <span className="hand" title="Someone here needs you" /> : null}
                    <span className="n">{p.live.length ? `${p.live.length} live` : p.done.length ? `${p.done.length} done` : ''}</span>
                  </button>
                  {p.id ? <button type="button" className="chats-ph-add" onClick={() => newTask(p.id)} title={`Give a task in ${p.name}`} aria-label={`Give a task in ${p.name}`}>＋</button> : null}
                </div>
                {open ? <>
                  {p.live.map((x) => row(x))}
                  {p.done.length ? <>
                    <button type="button" className="chats-done" aria-expanded={doneOpen(p)} onClick={() => toggleDone(p)}>{doneOpen(p) ? '▾' : '▸'} {query ? 'Done' : 'Done today'} · {p.done.length}</button>
                    {doneOpen(p) ? p.done.map((x) => row(x)) : null}
                  </> : null}
                  {p.empty ? <p className="chats-emptyline">+{p.empty} open, nothing asked yet</p> : null}
                </> : null}
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
              <div className="chats-id"><b>Give a task{newIn ? ` in ${projectName.get(newIn) ?? 'this project'}` : ''}</b><small>Swarmville starts an agent there, and their chat opens here.</small></div>
            </header>
            <div className="chats-new-body">
              <StartWork key={newIn ?? 'any'} state={state} moves={MOVES_FOR_JOB.builder} projectId={newIn} idPrefix="chats-new" here
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

/** One task: the agent's face (big enough to recognise), what the task is, and what they're asking, doing or last said. */
function Row({ s, project, on, unread, preview, now, onPick }: { s: SessionView; project?: string; on: boolean; unread: boolean; preview: string; now: number; onPick: () => void }) {
  const terminal = !s.runner && (s.status === 'running' || s.status === 'needs_input' || s.status === 'idle');
  const task = chatTask(s) ?? 'Waiting for a task';
  return (
    <button type="button" data-id={s.id} className={`chats-row s-${s.status}${on ? ' on' : ''}${unread ? ' unread' : ''}`} onClick={onPick} aria-current={on ? 'true' : undefined}
      title={`${s.agent.title}${project ? ` · ${project}` : ''}`}>
      <span className="chats-face"><AgentAvatar agent={s.agent} mood={moodFor(s)} size={40} live={s.status === 'running'} /><span className={`chats-dot dot s-${s.away ? 'away' : s.status}`} aria-hidden /></span>
      <span className="chats-who">
        <span className="l1">{task}</span>
        <span className="l3">{s.status === 'needs_input' ? '✋ ' : ''}{project ? `${project} · ` : ''}{preview}</span>
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
        <b>{chatTask(s) ?? s.agent.title}</b>
        <small><span className={`dot s-${st.cls}`} /><span>{st.text}</span>{project ? <><span aria-hidden>·</span><span>{project}</span></> : null}{chatTask(s) ? <><span aria-hidden>·</span><span className="job">{s.agent.title}</span></> : null}</small>
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
