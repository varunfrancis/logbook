import { useEffect, useMemo, useState } from 'react';
import type { ProjectView, SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { bricks, PROJECT, SIZE, STAMP_NOTE, plainAction, useVoice } from '../copy.ts';
import { ago, compact, duration, firstLine, tildify } from '../format.ts';
import { Empty, GoTo, PrChip, Stamp } from '../components.tsx';
import { useNow } from '../useLogbook.ts';

type Open = { agent: (id: string) => void; project: (id: string) => void };

function HandCard({ s, p, now, open, focused }: { s: SessionView; p?: ProjectView; now: number; open: Open; focused: boolean }) {
  return (
    <article className={`hand${focused ? ' focused' : ''}`} onClick={() => open.agent(s.id)}>
      <AgentAvatar agent={s.agent} mood="needs" size={84} />
      <div className="hand-body">
        <div className="hand-top">
          <div><b className="agent-name">{s.agent.title}</b><div className="sub">{p?.name}</div></div>
          <span className="wait">waiting {duration(s.lastEventAt, now)}</span>
        </div>
        <div className="ask">{s.needsMessage}</div>
        <div className="row"><GoTo s={s} primary /><button className="ghost" onClick={(e) => { e.stopPropagation(); open.agent(s.id); }}>Show the details</button></div>
      </div>
    </article>
  );
}

function WorkCard({ s, p, now, open, focused }: { s: SessionView; p?: ProjectView; now: number; open: Open; focused: boolean }) {
  const voice = useVoice();
  const flag = s.stuck
    ? { cls: 'bad', text: voice === 'plain' ? `Stuck: hit the same problem ${s.stuck.count} times` : `Looping: ${s.stuck.problem}` }
    : s.collision
    ? { cls: 'warn', text: voice === 'plain' ? `Bumping into ${s.collision.with}: both are changing ${s.collision.file}` : `Collision with ${s.collision.with} on ${s.collision.file}` }
    : s.lastCheck && !s.lastCheck.ok && now - s.lastCheck.at < 10 * 60_000
    ? { cls: 'bad', text: voice === 'plain' ? 'Its last check failed. Fixing it.' : 'Last test run failed' }
    : null;
  return (
    <article className={`work${flag ? ' f-' + flag.cls : ''}${focused ? ' focused' : ''}`} onClick={() => open.agent(s.id)}>
      <div className="work-head">
        <AgentAvatar agent={s.agent} mood={moodFor(s)} size={60} />
        <div><b className="agent-name">{s.agent.title}</b><div className="sub">{p?.name}{voice === 'technical' && (s.worktree || s.branch) ? ` · ${s.worktree ?? s.branch}` : ''}</div></div>
      </div>
      <div className="task">{s.title}</div>
      <div className="now">Right now: {plainAction(s.action, voice) ?? 'thinking'}</div>
      {flag ? <div className={`flag ${flag.cls}`}>{flag.text}</div> : null}
      <div className="meta"><span>{duration(s.startedAt, now)}</span><span>{voice === 'plain' ? bricks(s.bricks) : `${compact(s.tokens)} tok`}</span>{s.helperActive ? <span>+ helper</span> : null}<GoTo s={s} /></div>
    </article>
  );
}

export function CrewView({ state, open }: { state: StateView; open: Open }) {
  const voice = useVoice();
  const now = useNow(15000);
  const projects = useMemo(() => new Map(state.projects.map((p) => [p.id, p])), [state.projects]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const needs = state.sessions.filter((s) => s.status === 'needs_input').sort((a, b) => (a.lastEventAt ?? 0) - (b.lastEventAt ?? 0));
  const working = state.sessions.filter((s) => s.status === 'running');
  const idle = state.sessions.filter((s) => s.status === 'idle');
  const closed = state.sessions.filter((s) => s.status === 'ended' && (s.endedAt ?? 0) >= today.getTime());
  const order = [...needs, ...working];
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'j') setFocus((i) => Math.min(order.length - 1, i + 1));
      if (e.key === 'k') setFocus((i) => Math.max(0, i - 1));
      const s = order[focus];
      if (!s) return;
      if (e.key === 'Enter') fetch(`/api/jump/${encodeURIComponent(s.id)}`, { method: 'POST' });
      if (e.key === 'o') open.agent(s.id);
    };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [order, focus, open]);
  const town = state.projects.filter((p) => p.state !== 'lot').sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

  return (
    <div className="crew">
      <section>
        <h2>Raised a hand <small>they can't continue without you</small></h2>
        {needs.length ? <div className="grid hands">{needs.map((s, i) => <HandCard key={s.id} s={s} p={projects.get(s.projectId ?? '')} now={now} open={open} focused={focus === i} />)}</div>
          : <Empty title="Nobody is waiting on you." />}
      </section>
      <section>
        <h2>Building <small>{working.length} at work</small></h2>
        {working.length ? <div className="grid works">{working.map((s, i) => <WorkCard key={s.id} s={s} p={projects.get(s.projectId ?? '')} now={now} open={open} focused={focus === needs.length + i} />)}</div>
          : <Empty title="Nobody is building right now.">Start <code>claude</code> in any project and they'll clock in here within a couple of seconds.</Empty>}
      </section>
      {idle.length ? (
        <section>
          <h2>On a coffee break <small>finished what you asked, ready for more</small></h2>
          <div className="chips">
            {idle.map((s) => (
              <button key={s.id} className={`chip-agent${s.away ? ' away' : ''}`} onClick={() => open.agent(s.id)}>
                <AgentAvatar agent={s.agent} mood="break" size={30} /><b>{s.agent.name}</b><span>{projects.get(s.projectId ?? '')?.name}</span><span className="muted">{s.away ? `away ${ago(s.lastEventAt, now).replace(' ago', '')}` : duration(s.lastEventAt, now)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <section>
        <h2>Clocked out today <small>{closed.length}</small></h2>
        {closed.length ? (
          <ul className="closed">
            {closed.map((s) => (
              <li key={s.id} onClick={() => open.agent(s.id)}>
                {s.stamp ? <Stamp stamp={s.stamp} /> : <span className="stamp st-pending">Checking…</span>}
                <AgentAvatar agent={s.agent} mood={moodFor(s)} size={36} />
                <div className="closed-body">
                  <div><b>{s.title}</b> <span className="sub">· {s.agent.title} · {projects.get(s.projectId ?? '')?.name}</span></div>
                  <div className="sub">{s.stamp ? STAMP_NOTE[s.stamp] : ''} {firstLine(s.outcome, 120)}</div>
                </div>
                {s.size ? <span className="size">{SIZE[s.size]}</span> : null}
                <PrChip url={s.prUrl} state={s.prState} />
              </li>
            ))}
          </ul>
        ) : <Empty title="Nobody has clocked out yet today." />}
      </section>
      <section>
        <h2>The town <small>{town.length} buildings</small></h2>
        <div className="ptable-wrap">
          <table className="ptable">
            <thead><tr><th>Building</th><th>Stage</th><th className="r">On site</th><th className="r">Shifts</th><th className="r">{voice === 'plain' ? 'Bricks' : 'Tokens'}</th><th className="r">Last work</th></tr></thead>
            <tbody>
              {town.map((p) => (
                <tr key={p.id} onClick={() => open.project(p.id)}>
                  <td><b>{p.name}</b><div className="path">{voice === 'technical' ? tildify(p.root) || p.ghFull : p.repo}</div></td>
                  <td><span className={`pill p-${p.state}`}>{PROJECT[voice][p.state]}</span></td>
                  <td className="r num">{p.liveSessions || ''}</td>
                  <td className="r num">{p.sessionsTotal}</td>
                  <td className="r num">{voice === 'plain' ? p.bricks.toLocaleString() : compact(p.tokens)}</td>
                  <td className="r num">{ago(p.lastActivity, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <footer className="keys"><span><kbd>j</kbd>/<kbd>k</kbd> move</span><span><kbd>↵</kbd> go to agent</span><span><kbd>o</kbd> open profile</span></footer>
    </div>
  );
}
