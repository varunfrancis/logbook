import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar } from '../crew/Avatar.tsx';
import { ago, firstLine } from '../format.ts';
import { Empty } from '../components.tsx';
import { useNow } from '../useSwarmville.ts';
import { jobLabel, onBreak } from '../city/liveJobs.ts';
import { saidOf, useVoice } from '../copy.ts';

/** Everyone at the café: done with what you asked and ready for the next job. Click one to see what they did. */
export function CafePanel({ state, onClose, openAgent }: { state: StateView; onClose: () => void; openAgent: (id: string) => void }) {
  const now = useNow(30000);
  const voice = useVoice();
  const names = new Map(state.projects.map((p) => [p.id, p.name]));
  const crew = state.sessions.filter(onBreak).sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
  return (
    <aside className="panel" aria-label="Café">
      <header className="panel-head">
        <h2>Café</h2>
        <button className="ghost close" onClick={onClose} aria-label="Close">×</button>
      </header>
      <p className="sub">Agents here finished what you asked and are waiting for their next job. Click one to see what they did or give them more.</p>
      {crew.length ? (
        <ul className="graves">
          {crew.map((s) => (
            <li key={s.id} onClick={() => openAgent(s.id)}>
              <AgentAvatar agent={s.agent} mood="break" size={36} />
              <div>
                <div className="epitaph">{s.agent.name} · {jobLabel(s)}</div>
                <div className="sub">{names.get(s.projectId ?? '') ?? 'a project'} · finished {ago(s.lastEventAt, now)}</div>
                {s.outcome ? <div className="sub">{firstLine(saidOf(s, voice), 120)}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : <Empty title="The café is quiet. Everyone is either working or has clocked out." />}
    </aside>
  );
}
