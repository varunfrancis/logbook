import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar } from '../crew/Avatar.tsx';
import { bricks } from '../copy.ts';
import { ago } from '../format.ts';
import { Empty } from '../components.tsx';
import { useNow } from '../useSwarmville.ts';

/** Every shift from the last 30 days that was scrapped or left unfinished. Click one for the full story. */
export function GraveyardPanel({ state, onClose, openAgent }: { state: StateView; onClose: () => void; openAgent: (id: string) => void }) {
  const now = useNow(60000);
  const graves = state.graveyard ?? [];
  return (
    <aside className="panel" aria-label="Graveyard">
      <header className="panel-head">
        <h2>Graveyard</h2>
        <button className="ghost close" onClick={onClose} aria-label="Close">×</button>
      </header>
      <p className="sub">Work from the last 30 days that was scrapped, or left with changes never saved. Worth a look: some of it may be worth picking back up.</p>
      {graves.length ? (
        <ul className="graves">
          {graves.map((g) => (
            <li key={g.sessionId} onClick={() => openAgent(g.sessionId)}>
              <AgentAvatar agent={g.agent} mood="out" size={36} />
              <div>
                <div className="epitaph">{g.epitaph}</div>
                <div className="sub">{g.agent.title} · {g.projectName} · {ago(g.at, now)}</div>
                <div className="sub">{g.sub}{g.bricks ? ` · ${bricks(g.bricks)}` : ''}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : <Empty title="Nothing buried. Every shift kept its work." />}
    </aside>
  );
}
