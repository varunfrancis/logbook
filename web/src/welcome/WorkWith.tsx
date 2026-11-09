import { useState } from 'react';
import type { SessionView, StateView } from '../../../daemon/types.ts';
import { StartWork, type Started } from './StartWork.tsx';
import { MOVES_FOR_JOB } from './moves.ts';

/**
 * "Work with Juno": start a new job in their project the way their job suggests. Folded away until you open it.
 * Swarmville runs the new agent itself, and its chat opens straight away.
 */
export function WorkWith({ state, s, openAgent }: { state: StateView; s: SessionView; openAgent?: (sessionId: string) => void }) {
  const project = state.projects.find((p) => p.id === s.projectId);
  if (!project?.root) return null;
  return (
    <details className="profile-block workwith">
      <summary><h3>Work with {s.agent.name}</h3><span className="muted">Start a new job at {project.name}</span></summary>
      <GiveTask state={state} projectId={project.id} moves={MOVES_FOR_JOB[s.agent.job] ?? MOVES_FOR_JOB.builder} idPrefix={`ww-${s.id}`} openAgent={openAgent} />
    </details>
  );
}

/** The form that hands a new task to an agent Swarmville runs, then opens their chat (or says what went wrong). */
export function GiveTask({ state, projectId, moves, idPrefix, openAgent }: { state: StateView; projectId: string; moves: Parameters<typeof StartWork>[0]['moves']; idPrefix: string; openAgent?: (sessionId: string) => void }) {
  const [done, setDone] = useState<Started | null>(null);
  if (done) return (
    <div className="ww-done">
      <p>{done.message}</p>
      <button type="button" className="ghost small" onClick={() => setDone(null)}>Start another</button>
    </div>
  );
  return <StartWork state={state} moves={moves} projectId={projectId} idPrefix={idPrefix} here
    onStarted={(r) => { if (r.sessionId && openAgent) openAgent(r.sessionId); else setDone(r); }} />;
}
