import type { StateView } from '../../daemon/types.ts';
import { ago, compact, duration, firstLine, PROJECT_LABEL, tildify } from './format.ts';
import { CopyResume, PrChip, StatusDot, StatusPill } from './components.tsx';
import { useNow, useProject } from './useLogbook.ts';

export function ProjectPanel({ id, state, onClose }: { id: string; state: StateView; onClose: () => void }) {
  const now = useNow(15000);
  const detail = useProject(id, state.generatedAt - (state.generatedAt % 10000));
  const p = state.projects.find((x) => x.id === id);
  if (!p) return null;
  const sessions = detail?.sessions ?? state.sessions.filter((s) => s.projectId === id);
  const live = sessions.filter((s) => s.status !== 'ended');
  const past = sessions.filter((s) => s.status === 'ended').slice(0, 8);
  const titles = new Map(sessions.map((s) => [s.id, s.title]));

  return (
    <aside className="panel" aria-label={`${p.name} details`}>
      <header className="panel-head">
        <div>
          <h2>{p.name}</h2>
          <div className="panel-sub">
            <span className={`pill p-${p.state}`}>{PROJECT_LABEL[p.state]}{p.liveSessions ? ` · ${p.liveSessions} agent${p.liveSessions > 1 ? 's' : ''}` : ''}</span>
            {p.ghUrl ? <a href={p.ghUrl} target="_blank" rel="noreferrer">{p.ghFull}</a> : null}
          </div>
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close details">×</button>
      </header>
      {p.root ? <div className="path">{tildify(p.root)}</div> : null}
      {p.description ? <p className="muted">{p.description}</p> : null}
      <dl className="stats">
        <div><dt>Tokens</dt><dd>{compact(p.tokens)}</dd></div>
        <div><dt>Today</dt><dd>{compact(p.tokensToday)}</dd></div>
        <div><dt>Sessions</dt><dd>{p.sessionsTotal}</dd></div>
        <div><dt>Commits</dt><dd>{p.commits}</dd></div>
      </dl>
      {p.state === 'lot' ? <p className="muted">This repo is on GitHub but you haven't run an agent in it on this machine. {p.ghPushedAt ? `Last push ${ago(p.ghPushedAt, now)}.` : ''}</p> : null}

      {live.length ? (
        <section>
          <h3>On site now</h3>
          <ul className="plist">
            {live.map((s) => (
              <li key={s.id}>
                <div className="pl-top"><StatusDot status={s.status} /><b>{s.title}</b></div>
                <div className="pl-act">{s.status === 'needs_input' ? s.needsMessage : s.action}</div>
                <div className="pl-meta">
                  <StatusPill status={s.status} />
                  {s.worktree || s.branch ? <span className="where">{s.worktree ?? s.branch}</span> : null}
                  <span className="num">{duration(s.startedAt, now)}</span>
                  <span className="num">{compact(s.tokens)} tok</span>
                  {s.helperActive ? <span className="where">+ helper</span> : null}
                  <PrChip url={s.prUrl} state={s.prState} />
                  <CopyResume s={s} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {past.length ? (
        <section>
          <h3>Recently closed</h3>
          <ul className="plist">
            {past.map((s) => (
              <li key={s.id}>
                <div className="pl-top"><StatusDot status="ended" /><b>{s.title}</b></div>
                {s.outcome ? <details><summary>{firstLine(s.outcome, 140)}</summary><p className="outcome-full">{s.outcome}</p></details> : null}
                <div className="pl-meta">
                  <span className="num">{ago(s.endedAt, now)}</span>
                  <span className="num">{duration(s.startedAt, s.endedAt)}</span>
                  <span className="num">{compact(s.tokens)} tok</span>
                  {s.linesAdded ? <span className="num diff">+{s.linesAdded} −{s.linesRemoved ?? 0}</span> : null}
                  <PrChip url={s.prUrl} state={s.prState} />
                  {s.cwd ? <CopyResume s={s} /> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail?.events.length ? (
        <section>
          <h3>Activity</h3>
          <ol className="timeline">
            {detail.events.slice(0, 25).map((e, i) => (
              <li key={i} className={`ev ev-${e.kind}`}>
                <span className="num">{ago(e.ts, now)}</span>
                <span><i>{titles.get(e.sessionId) ?? 'Session'}</i> · {e.text}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </aside>
  );
}
