import { useState } from 'react';
import type { SessionView, StateView } from '../../../daemon/types.ts';
import { StartWork, type Started } from './StartWork.tsx';
import { MOVES_FOR_JOB } from './moves.ts';

/** "Work with Juno": start a new job in their project the way their job suggests. Folded away until you open it. */
export function WorkWith({ state, s }: { state: StateView; s: SessionView }) {
  const [done, setDone] = useState<Started | null>(null);
  const project = state.projects.find((p) => p.id === s.projectId);
  if (!project?.root) return null;
  return (
    <details className="profile-block workwith">
      <summary><h3>Work with {s.agent.name}</h3><span className="muted">Start a new job at {project.name}</span></summary>
      {done ? (
        <div className="ww-done">
          <p>{done.message}</p>
          <button type="button" className="ghost small" onClick={() => setDone(null)}>Start another</button>
        </div>
      ) : <StartWork state={state} moves={MOVES_FOR_JOB[s.agent.job] ?? MOVES_FOR_JOB.builder} projectId={project.id} idPrefix={`ww-${s.id}`} onStarted={setDone} />}
    </details>
  );
}
