import { useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar } from '../crew/Avatar.tsx';
import { finishedAt, prNum, todayView } from '../crew/today.ts';
import { ago, firstLine } from '../format.ts';
import { useNow } from '../useLogbook.ts';

const NONE = new Set<string>();

/** Everything that merged and went live today, by project, newest first. Opened from Crew → Today. */
export function ShippedPanel({ state, onClose, openProject, openAgent }: { state: StateView; onClose: () => void; openProject: (id: string) => void; openAgent: (id: string) => void }) {
  const now = useNow(30000);
  const t = todayView(state.sessions, NONE, now);
  const [chats, setChats] = useState(false);
  const name = (id: string | null) => state.projects.find((p) => p.id === id)?.name ?? 'Unknown project';

  return (
    <aside className="panel shipped-panel" aria-label="What shipped today">
      <header className="panel-head">
        <div>
          <h2>Shipped today: {t.shipped}</h2>
          <div className="panel-sub">Merged and live, by project. Newest first.</div>
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close what shipped today">×</button>
      </header>
      {!t.done.length ? <p className="muted">Nothing has merged yet today.</p> : (
        <ul className="cost-list shipped-list">
          {t.done.map(({ projectId, items }) => (
            <li key={projectId}>
              <button className="cost-row cost-project" onClick={() => openProject(projectId)} title={`Open ${name(projectId)}`}>
                <b>{name(projectId)}</b><span className="num">{items.length} shipped</span>
              </button>
              <ul>
                {items.map((s) => {
                  const said = firstLine(s.outcome, 160);
                  return (
                    <li key={s.id}>
                      <button className="cost-row shipped-item" onClick={() => openAgent(s.id)} title={`Open ${s.agent.title}`}>
                        <AgentAvatar agent={s.agent} mood="shipped" size={26} />
                        <span className="shipped-body">
                          <span className="shipped-top"><b>{s.title}</b><span className="num">{prNum(s.prUrl) ?? ''}</span></span>
                          <span className="shipped-meta">{s.agent.title} · {ago(finishedAt(s), now)}</span>
                          {said ? <span className="shipped-said">{said}</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {t.chats.length ? (
        <div className="today-chats">
          <button className="link" onClick={() => setChats(!chats)}>{chats ? 'Hide the' : 'Also'} {t.chats.length} chat{t.chats.length === 1 ? '' : 's'} that didn't change anything {chats ? '▴' : '›'}</button>
          {chats ? <ul>{t.chats.map((s) => <li key={s.id} onClick={() => openAgent(s.id)}><b>{s.title}</b> <span className="sub">· {s.agent.name} · {name(s.projectId)}</span></li>)}</ul> : null}
        </div>
      ) : null}
    </aside>
  );
}
