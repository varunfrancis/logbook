import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { post } from '../useSwarmville.ts';
import { MOVES, type MoveId } from './moves.ts';
import { sendsOnEnter } from './composer.ts';

export type Started = { ok: boolean; via: string; message: string; command?: string; sessionId?: string; projectId: string; projectName: string; at: number; plan: boolean };

/**
 * Pick a project and a way to start, say what it's about, and Swarmville opens Claude Code there.
 * Used on the welcome tour ("Your turn"), on every agent's profile ("Work with me"), and, with
 * `look="composer"`, as the chat-style box on the Chats "new" page.
 */
export function StartWork({ state, moves, defaultMove, projectId, onStarted, idPrefix = 'sw', secondary, here = false, look = 'form' }: {
  state: StateView; moves: MoveId[]; defaultMove?: MoveId; projectId?: string | null; onStarted: (r: Started) => void; idPrefix?: string; secondary?: React.ReactNode;
  /** Swarmville runs the agent itself: no terminal, you talk to it in its chat. */
  here?: boolean;
  /** `composer`: one rounded box like ChatGPT's, with the project and the way to start as pills inside it. */
  look?: 'form' | 'composer';
}) {
  const projects = useMemo(() => state.projects.filter((p) => p.root).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)), [state.projects]);
  const [pid, setPid] = useState(projectId ?? projects[0]?.id ?? '');
  const [move, setMove] = useState<MoveId>(defaultMove ?? moves[0]);
  const [what, setWhat] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const project = projects.find((p) => p.id === pid);
  const m = MOVES[move];
  const needsText = move !== 'explain' && move !== 'review';

  if (!projects.length) return <p className="muted">No projects on this computer yet. Open Terminal in any project folder and type <code>claude</code> to start your first one.</p>;

  const start = async () => {
    if (!project || busy) return;
    if (needsText && !what.trim()) { setErr('Say in a few words what it’s about.'); return; }
    setBusy(true); setErr(null);
    const prompt = m.prompt(what.trim(), project.name);
    const r = await post('/api/launch', { projectId: project.id, prompt, plan: m.plan, skip: !!m.skip, here });
    setBusy(false);
    if (!r.ok) { setErr(r.message ?? 'Couldn’t start it.'); return; }
    onStarted({ ...r, projectId: project.id, projectName: project.name, at: Date.now(), plan: m.plan });
  };
  const cta = busy ? 'Starting…' : move === 'plan' ? 'Start planning' : move === 'brainstorm' ? 'Start brainstorming' : 'Start';
  const ask = move === 'fix' ? 'What’s wrong?' : move === 'explain' ? 'What should they explain? (optional)' : move === 'review' ? 'What should they look at? (optional)' : 'What’s it about?';

  if (look === 'composer') {
    return <Composer {...{ idPrefix, projects, project, pid, setPid, fixedProject: !!projectId, moves, move, setMove, what, setWhat, setErr, err, busy, cta, ask, here, needsText, start }} />;
  }

  return (
    <form className="startwork" onSubmit={(e) => { e.preventDefault(); start(); }}>
      {projectId ? null : (
        <label className="sw-field">
          <span className="field-label">Project</span>
          <select id={`${idPrefix}-project`} className="field" value={pid} onChange={(e) => setPid(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <div className="sw-moves" role="radiogroup" aria-label="How to start">
        {moves.map((id) => (
          <button type="button" key={id} role="radio" aria-checked={move === id} className={`sw-move${move === id ? ' on' : ''}`} onClick={() => setMove(id)}>
            <b>{MOVES[id].label}</b><span>{MOVES[id].hint}</span>
          </button>
        ))}
      </div>
      <label className="sw-field">
        <span className="field-label">{ask}</span>
        <input id={`${idPrefix}-what`} className="field" value={what} onChange={(e) => { setWhat(e.target.value); setErr(null); }} placeholder={m.placeholder} maxLength={400} />
      </label>
      <div className="sw-notes">
        {m.plan ? <p className="sw-note">Starts in plan mode: nothing changes until you approve the plan.</p>
          : m.skip ? <p className="sw-note">Starts changing files in this project right away, without asking permission for each step. Want to see a plan first? Pick {MOVES.plan.label}.</p> : null}
        {here ? <p className="sw-note">Runs here in Swarmville: you’ll chat with them in the town. You can take over in a terminal any time.</p> : null}
      </div>
      {err ? <p className="sw-err" role="alert">{err}</p> : null}
      <div className={`row ${secondary ? 'between' : 'end'}`}>
        {secondary}
        <button className="btn dark" type="submit" disabled={busy || !project}>{cta}</button>
      </div>
    </form>
  );
}

/** Stroke icons for the pills (Lucide-style paths, 24×24). */
const ICON: Partial<Record<MoveId, string>> = {
  plan: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  brainstorm: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
  build: 'm14 7 3 3M5 19l9-9M14.5 4.5l5 5-2 2-5-5z',
  fix: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  review: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};
const Icon = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';

function Composer({ idPrefix, projects, project, pid, setPid, fixedProject, moves, move, setMove, what, setWhat, setErr, err, busy, cta, ask, here, needsText, start }: {
  idPrefix: string; projects: StateView['projects']; project?: StateView['projects'][number]; pid: string; setPid: (id: string) => void; fixedProject: boolean;
  moves: MoveId[]; move: MoveId; setMove: (id: MoveId) => void; what: string; setWhat: (s: string) => void; setErr: (s: string | null) => void; err: string | null;
  busy: boolean; cta: string; ask: string; here: boolean; needsText: boolean; start: () => void;
}) {
  const m = MOVES[move];
  const ta = useRef<HTMLTextAreaElement>(null);
  // Grow with what's typed, up to a few lines, then scroll inside the box.
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [what]);
  const note = m.plan ? 'Plan mode: nothing changes until you approve the plan.'
    : m.skip ? 'Starts changing files right away, without asking each step.'
    : `${m.hint}.`;
  const ready = !!project && !busy && (!needsText || !!what.trim());

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); start(); }}>
      <h1 className="composer-title">What should we work on?</h1>
      <div className="composer-box" onClick={(e) => { if (e.target === e.currentTarget) ta.current?.focus(); }}>
        <label htmlFor={`${idPrefix}-what`} className="sr-only">{ask}</label>
        <textarea id={`${idPrefix}-what`} ref={ta} rows={2} autoFocus value={what} maxLength={400} placeholder={m.placeholder}
          onChange={(e) => { setWhat(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (sendsOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); start(); } }} />
        <div className="composer-bar">
          {fixedProject ? (
            <span className="composer-pill static" title="Project"><Icon d={FOLDER} size={16} /><span className="composer-pill-name">{project?.name}</span></span>
          ) : (
            <label className="composer-pill picker" title="Project">
              <Icon d={FOLDER} size={16} /><span className="composer-pill-name">{project?.name ?? 'Pick a project'}</span><Icon d="m6 9 6 6 6-6" size={14} />
              <select id={`${idPrefix}-project`} aria-label="Project" value={pid} onChange={(e) => setPid(e.target.value)}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <div className="composer-moves" role="radiogroup" aria-label="How to start">
            {moves.map((id) => (
              <button type="button" key={id} role="radio" aria-checked={move === id} title={MOVES[id].label}
                className={`composer-pill${move === id ? ' on' : ''}`} onClick={() => { setMove(id); ta.current?.focus(); }}>
                {ICON[id] ? <Icon d={ICON[id]} /> : null}<span>{MOVES[id].short}</span>
              </button>
            ))}
          </div>
          <button type="submit" className={`composer-send${busy ? ' busy' : ''}`} disabled={!ready} aria-label={cta} title={`${cta} (Enter)`}>
            <Icon d="M12 19V5M5 12l7-7 7 7" size={18} />
          </button>
        </div>
      </div>
      {err ? <p className="sw-err composer-err" role="alert">{err}</p> : null}
      <p className="composer-note">{busy ? 'Starting an agent…' : note}{here ? ' You’ll chat with them here, and can take over in a terminal any time.' : ''}</p>
    </form>
  );
}
