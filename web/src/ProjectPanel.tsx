import { useState } from 'react';
import type { StateView } from '../../daemon/types.ts';
import { AgentAvatar, moodFor } from './crew/Avatar.tsx';
import { money, PROJECT, plainAction, STATUS, useVoice } from './copy.ts';
import { ago, compact, duration, firstLine, tildify } from './format.ts';
import { GoTo, PrChip, Stamp } from './components.tsx';
import { post, useNow, useProject } from './useLogbook.ts';

export function ProjectPanel({ id, state, onClose, openAgent }: { id: string; state: StateView; onClose: () => void; openAgent: (id: string) => void }) {
  const voice = useVoice();
  const now = useNow(15000);
  const detail = useProject(id, state.generatedAt);
  const p = state.projects.find((x) => x.id === id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!p) return null;
  const sessions = detail?.sessions ?? state.sessions.filter((s) => s.projectId === id);
  const live = sessions.filter((s) => s.status !== 'ended');
  const past = sessions.filter((s) => s.status === 'ended').slice(0, 8);
  const save = async () => { await post(`/api/project/${encodeURIComponent(p.id)}/name`, { name: draft }); setEditing(false); };

  return (
    <aside className="panel" aria-label={`${p.name} details`}>
      <header className="panel-head">
        <div style={{ minWidth: 0 }}>
          {editing ? (
            <form className="rename" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <label htmlFor="rename-input" className="sr">Building name</label>
              <input id="rename-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} />
              <button className="btn dark" type="submit">Save</button>
              <button className="ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          ) : (
            <h2>{p.name} <button className="ghost small" onClick={() => { setDraft(p.name); setEditing(true); }}>Rename</button></h2>
          )}
          <div className="panel-sub">
            <span className={`pill p-${p.state}`}>{PROJECT[voice][p.state]}{p.liveSessions ? ` · ${p.liveSessions} on site` : ''}</span>
            <span className="muted">{p.repo}</span>
            {p.ghUrl ? <a href={p.ghUrl} target="_blank" rel="noreferrer">GitHub</a> : null}
          </div>
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close details">×</button>
      </header>
      {p.description ? <p className="muted">{p.description}</p> : null}
      {voice === 'technical' && p.root ? <div className="path">{tildify(p.root)}</div> : null}
      <dl className="stats">
        <div><dt>{voice === 'plain' ? 'Bricks laid' : 'Tokens'}</dt><dd>{voice === 'plain' ? p.bricks.toLocaleString() : compact(p.tokens)}</dd></div>
        <div><dt>Cost</dt><dd>{money(p.costUsd)}</dd></div>
        <div><dt>Shifts</dt><dd>{p.sessionsTotal}</dd></div>
        <div><dt>{voice === 'plain' ? 'Saves' : 'Commits'}</dt><dd>{p.commits}</dd></div>
      </dl>
      {p.state === 'lot' ? <p className="muted">For sale: this repo is on GitHub but nobody has worked on it from this machine. {p.ghPushedAt ? `Last upload ${ago(p.ghPushedAt, now)}.` : ''}</p> : null}

      {live.length ? (
        <section>
          <h3>On site now</h3>
          <ul className="plist">
            {live.map((s) => (
              <li key={s.id} onClick={() => openAgent(s.id)}>
                <div className="pl-top"><AgentAvatar agent={s.agent} mood={moodFor(s)} size={40} /><div><b>{s.agent.title}</b><div className="sub">{s.title}</div></div></div>
                <div className="pl-act">{s.status === 'needs_input' ? s.needsMessage : s.status === 'running' ? `Right now: ${plainAction(s.action, voice)}` : STATUS[voice][s.status]}</div>
                <div className="pl-meta"><span className={`pill s-${s.status}`}>{STATUS[voice][s.status]}</span><span className="num">{duration(s.startedAt, now)}</span><PrChip url={s.prUrl} state={s.prState} /><GoTo s={s} /></div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {past.length ? (
        <section>
          <h3>Recently clocked out</h3>
          <ul className="plist">
            {past.map((s) => (
              <li key={s.id} onClick={() => openAgent(s.id)}>
                <div className="pl-top"><AgentAvatar agent={s.agent} mood={moodFor(s)} size={36} /><div><b>{s.title}</b><div className="sub">{s.agent.title} · {ago(s.endedAt, now)}</div></div></div>
                {s.outcome ? <div className="sub">{firstLine(s.outcome, 140)}</div> : null}
                <div className="pl-meta">{s.stamp ? <Stamp stamp={s.stamp} /> : null}<PrChip url={s.prUrl} state={s.prState} /></div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
