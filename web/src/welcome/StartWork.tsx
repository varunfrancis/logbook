import { useMemo, useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { post } from '../useLogbook.ts';
import { MOVES, type MoveId } from './moves.ts';

export type Started = { ok: boolean; via: string; message: string; command?: string; projectId: string; projectName: string; at: number; plan: boolean };

/**
 * Pick a project and a way to start, say what it's about, and Logbook opens Claude Code there.
 * Used on the welcome tour ("Your turn") and on every agent's profile ("Work with me").
 */
export function StartWork({ state, moves, defaultMove, projectId, onStarted, idPrefix = 'sw', secondary }: {
  state: StateView; moves: MoveId[]; defaultMove?: MoveId; projectId?: string | null; onStarted: (r: Started) => void; idPrefix?: string; secondary?: React.ReactNode;
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
    if (!project) return;
    if (needsText && !what.trim()) { setErr('Say in a few words what it’s about.'); return; }
    setBusy(true); setErr(null);
    const prompt = m.prompt(what.trim(), project.name);
    const r = await post('/api/launch', { projectId: project.id, prompt, plan: m.plan });
    setBusy(false);
    if (!r.ok) { setErr(r.message ?? 'Couldn’t start it.'); return; }
    onStarted({ ...r, projectId: project.id, projectName: project.name, at: Date.now(), plan: m.plan });
  };

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
        <span className="field-label">{move === 'fix' ? 'What’s wrong?' : move === 'explain' ? 'What should they explain? (optional)' : move === 'review' ? 'What should they look at? (optional)' : 'What’s it about?'}</span>
        <input id={`${idPrefix}-what`} className="field" value={what} onChange={(e) => { setWhat(e.target.value); setErr(null); }} placeholder={m.placeholder} maxLength={400} />
      </label>
      {m.plan ? <p className="sw-note">Starts in plan mode: nothing changes until you approve the plan.</p> : null}
      {err ? <p className="sw-err" role="alert">{err}</p> : null}
      <div className={`row ${secondary ? 'between' : 'end'}`}>
        {secondary}
        <button className="btn dark" type="submit" disabled={busy || !project}>{busy ? 'Starting…' : move === 'plan' ? 'Start planning' : move === 'brainstorm' ? 'Start brainstorming' : 'Start'}</button>
      </div>
    </form>
  );
}
