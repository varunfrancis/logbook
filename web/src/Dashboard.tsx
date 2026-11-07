import { useMemo } from 'react';
import type { ProjectView, SessionView, StateView } from '../../daemon/types.ts';
import { ago, compact, duration, firstLine, PROJECT_LABEL, tildify } from './format.ts';
import { CopyResume, Empty, PrChip, StatusDot, StatusPill } from './components.tsx';
import { useNow } from './useLogbook.ts';

function SessionRow({ s, project, now, onOpen }: { s: SessionView; project?: ProjectView; now: number; onOpen: () => void }) {
  const where = s.worktree ? `${s.worktree}` : s.branch && s.branch !== 'main' && s.branch !== 'master' ? s.branch : null;
  const live = s.status !== 'ended';
  return (
    <li className={`srow s-${s.status}`}>
      <button className="srow-main" onClick={onOpen}>
        <StatusDot status={s.status} />
        <div className="srow-body">
          <div className="srow-top">
            <span className="proj">{project?.name ?? 'Unknown project'}</span>
            {where ? <span className="where">{where}</span> : null}
            {s.kind === 'bg' ? <span className="where">background</span> : null}
          </div>
          <div className="srow-title">{s.title}</div>
          <div className="srow-detail">
            {s.status === 'needs_input' ? <span className="needs">{s.needsMessage}</span>
              : live ? <span>{s.action ?? 'Working'}</span>
              : <span className="outcome">{firstLine(s.outcome) || 'No summary'}</span>}
          </div>
        </div>
      </button>
      <div className="srow-meta">
        <StatusPill status={s.status} />
        <span className="num" title="Session length">{live ? duration(s.startedAt, now) : ago(s.endedAt, now)}</span>
        <span className="num" title="Tokens (input + output + cache writes)">{compact(s.tokens)} tok</span>
        {s.linesAdded ? <span className="num diff" title="Lines added / removed">+{s.linesAdded} −{s.linesRemoved ?? 0}</span> : null}
        <PrChip url={s.prUrl} state={s.prState} />
        {live || s.cwd ? <CopyResume s={s} /> : null}
      </div>
    </li>
  );
}

export function Dashboard({ state, onOpenProject }: { state: StateView; onOpenProject: (id: string) => void }) {
  const now = useNow(15000);
  const projects = useMemo(() => new Map(state.projects.map((p) => [p.id, p])), [state.projects]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const needs = state.sessions.filter((s) => s.status === 'needs_input');
  const working = state.sessions.filter((s) => s.status === 'running' || s.status === 'idle')
    .sort((a, b) => (a.status === b.status ? (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0) : a.status === 'running' ? -1 : 1));
  const done = state.sessions.filter((s) => s.status === 'ended');
  const active = state.projects.filter((p) => p.state !== 'lot').sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const row = (s: SessionView) => <SessionRow key={s.id} s={s} project={projects.get(s.projectId ?? '')} now={now} onOpen={() => s.projectId && onOpenProject(s.projectId)} />;

  return (
    <div className="dash">
      <section>
        <h2><span className="h-dot s-needs_input" />Needs you <span className="count">{needs.length}</span></h2>
        {needs.length ? <ul className="slist">{needs.map(row)}</ul> : <Empty title="Nothing is waiting on you." />}
      </section>
      <section>
        <h2><span className="h-dot s-running" />Active <span className="count">{working.length}</span></h2>
        {working.length ? <ul className="slist">{working.map(row)}</ul> : <Empty title="No agents running right now.">Start <code>claude</code> in any repo and it shows up here within a couple of seconds.</Empty>}
      </section>
      <section>
        <h2><span className="h-dot s-ended" />Closed in the last 24 hours <span className="count">{done.length}</span></h2>
        {done.length ? <ul className="slist">{done.slice(0, 40).map(row)}</ul> : <Empty title="No sessions closed in the last day." />}
      </section>
      <section>
        <h2>Projects <span className="count">{active.length}</span></h2>
        <div className="ptable-wrap">
          <table className="ptable">
            <thead><tr><th>Project</th><th>State</th><th className="r">Agents</th><th className="r">Sessions</th><th className="r">Tokens</th><th className="r">Last activity</th></tr></thead>
            <tbody>
              {active.map((p) => (
                <tr key={p.id} onClick={() => onOpenProject(p.id)}>
                  <td><b>{p.name}</b><div className="path">{tildify(p.root) || p.ghFull}</div></td>
                  <td><span className={`pill p-${p.state}`}>{PROJECT_LABEL[p.state]}</span></td>
                  <td className="r num">{p.liveSessions || ''}</td>
                  <td className="r num">{p.sessionsTotal}</td>
                  <td className="r num">{compact(p.tokens)}</td>
                  <td className="r num">{ago(p.lastActivity, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
