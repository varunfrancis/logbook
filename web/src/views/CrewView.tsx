import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProjectView, RoutineView, SessionView, StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { bricks, PROJECT, SIZE, STAMP_NOTE, plainAction, useVoice } from '../copy.ts';
import { ago, compact, duration, every, firstLine, nextRunText, tildify } from '../format.ts';
import { ClockOut, Empty, GoTo, PrChip, Stamp } from '../components.tsx';
import { useNow } from '../useLogbook.ts';
import { Leaderboard } from '../crew/Leaderboard.tsx';

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

/** Text that changes in place: a light sweeps the box, the old line slides up and out, the new one slides in.
 *  Each line stays up at least a moment so a busy agent doesn't flicker. */
function Swap({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const last = useRef(0);
  useEffect(() => {
    if (text === shown) { setPhase((p) => (p === 'out' ? 'idle' : p)); return; } // changed back before the swap landed
    const wait = Math.max(0, last.current + 1400 - Date.now());
    const t0 = setTimeout(() => setPhase('out'), wait);
    const t1 = setTimeout(() => { setShown(text); setPhase('in'); last.current = Date.now(); }, wait + 320);
    return () => { clearTimeout(t0); clearTimeout(t1); };
  }, [text, shown]);
  useEffect(() => {
    if (phase !== 'in') return;
    const t = setTimeout(() => setPhase('idle'), 380);
    return () => clearTimeout(t);
  }, [phase, shown]);
  return <span className={`swap s-${phase}`} title={shown}><span key={shown}>{shown}</span></span>;
}

/** Per-agent offset so the building cards don't all jiggle in unison. */
const jiggleDelay = (id: string) => `${-([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 5000)}ms`;

function WorkCard({ s, p, now, open, focused }: { s: SessionView; p?: ProjectView; now: number; open: Open; focused: boolean }) {
  const voice = useVoice();
  const flag = s.stuck
    ? { cls: 'bad', label: voice === 'plain' ? 'Stuck' : 'Looping', text: voice === 'plain' ? `Stuck: hit the same problem ${s.stuck.count} times` : `Looping: ${s.stuck.problem}` }
    : s.collision
    ? { cls: 'warn', label: voice === 'plain' ? 'Bumping into someone' : 'Collision', text: voice === 'plain' ? `Bumping into ${s.collision.with}: both are changing ${s.collision.file}` : `Collision with ${s.collision.with} on ${s.collision.file}` }
    : s.lastCheck && !s.lastCheck.ok && now - s.lastCheck.at < 10 * 60_000
    ? { cls: 'bad', label: voice === 'plain' ? 'Check failed' : 'Tests failed', text: voice === 'plain' ? 'Its last check failed. Fixing it.' : 'Last test run failed' }
    : null;
  return (
    <article className={`work${flag ? ' f-' + flag.cls : ''}${focused ? ' focused' : ''}`} style={{ animationDelay: jiggleDelay(s.id) }} onClick={() => open.agent(s.id)}>
      <div className="work-head">
        <AgentAvatar agent={s.agent} mood={moodFor(s)} size={60} />
        <div className="work-who"><b className="agent-name">{s.agent.title}</b><div className="sub">{s.agent.role === 'resident' ? `Resident of ${p?.name}` : s.agent.role === 'helper' ? `Helping on ${p?.name}` : s.agent.role === 'routine' ? `Scheduled job · ${p?.name}` : p?.name}{voice === 'technical' && (s.worktree || s.branch) ? ` · ${s.worktree ?? s.branch}` : ''}</div></div>
        {flag ? <span className={`flag ${flag.cls}`} title={flag.text}>{flag.label}</span> : null}
      </div>
      <div className="task" title={s.title}>{s.title}</div>
      <div className="now">Right now: <Swap text={plainAction(s.action, voice) ?? 'thinking'} /></div>
      <div className="meta"><span>{duration(s.startedAt, now)}</span><span>{voice === 'plain' ? bricks(s.bricks) : `${compact(s.tokens)} tok`}</span>{s.helperActive ? <span>+ helper</span> : null}<GoTo s={s} /></div>
    </article>
  );
}

/** A scheduled job: asleep between runs, awake (and also on the Building list) while one is going. */
function RoutineCard({ r, p, now, open }: { r: RoutineView; p?: ProjectView; now: number; open: Open }) {
  const awake = r.state === 'awake';
  const next = nextRunText(r.nextAt, now);
  return (
    <article className={`routine${awake ? ' awake' : ''}`} onClick={() => open.agent(r.liveSessionId ?? r.lastSessionId)}>
      <AgentAvatar agent={r.agent} mood={awake ? 'working' : 'out'} size={52} />
      <div className="routine-body">
        <div className="routine-top">
          <div><b className="agent-name">{r.agent.title}</b><div className="sub">{p?.name}</div></div>
          <span className={`pill ${awake ? 's-running' : 's-asleep'}`}>{awake ? 'Awake · on a run' : 'Asleep'}</span>
        </div>
        <div className="task" title={r.prompt ?? r.title}>{r.title}</div>
        <div className="meta">
          {awake ? <span>Woke up {ago(r.lastRunAt, now)}</span> : <span>Last ran {ago(r.lastRunAt, now)}</span>}
          {!awake && r.lastStamp ? <Stamp stamp={r.lastStamp} /> : null}
          {r.intervalMs ? <span>{every(r.intervalMs)}</span> : null}
          {next ? <span>Up again {next}</span> : null}
          <span className="muted">{r.runs} run{r.runs === 1 ? '' : 's'} this month</span>
        </div>
        {!awake && r.lastOutcome ? <div className="sub routine-out">{firstLine(r.lastOutcome, 140)}</div> : null}
      </div>
    </article>
  );
}

/** A section you can fold away. Starts closed unless you left it open last time. */
function Fold({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  const key = `logbook.crew.fold.${id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  return (
    <section>
      <details className="fold" open={open} onToggle={(e) => {
        const o = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(o);
        try { localStorage.setItem(key, o ? '1' : '0'); } catch { /* private window */ }
      }}>
        <summary><h2>{title} {note != null ? <small>{note}</small> : null}</h2></summary>
        {open ? children : null}
      </details>
    </section>
  );
}

const finishedAt = (s: SessionView) => (s.status === 'ended' ? s.endedAt : s.lastEventAt) ?? 0;

/** What each agent just finished: the job, and the first line of what they said when they stopped. */
function FinishedList({ items, projects, now, open }: { items: SessionView[]; projects: Map<string, ProjectView>; now: number; open: Open }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 6);
  if (!items.length) return <Empty title="Nothing finished yet today." />;
  return (
    <>
      <ul className="closed finished">
        {shown.map((s) => {
          const said = firstLine(s.outcome, 220);
          return (
            <li key={s.id} onClick={() => open.agent(s.id)}>
              <AgentAvatar agent={s.agent} mood={s.status === 'ended' ? moodFor(s) : 'break'} size={36} />
              <div className="closed-body">
                <div><b>{s.title}</b> <span className="sub">· {s.agent.name} · {projects.get(s.projectId ?? '')?.name}</span></div>
                {said ? <div className="said" title={s.outcome ?? ''}>{said}</div> : null}
              </div>
              {s.status === 'ended' ? (s.stamp ? <Stamp stamp={s.stamp} /> : <span className="pill s-ended">Clocked out</span>) : <span className="pill s-idle">{s.away ? 'Away' : 'On a break'}</span>}
              <PrChip url={s.prUrl} state={s.prState} />
              <ClockOut s={s} />
              <span className="muted when">{ago(finishedAt(s), now)}</span>
            </li>
          );
        })}
      </ul>
      {items.length > 6 ? <button className="ghost more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${items.length - 6} more`}</button> : null}
    </>
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
  const finished = [...idle, ...closed].sort((a, b) => finishedAt(b) - finishedAt(a));
  const order = [...needs, ...working];
  // Keyboard focus sticks to an agent (not a slot in the list) and only shows once you start using j/k.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focus = order.findIndex((s) => s.id === focusId);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'j') setFocusId(order[focus < 0 ? 0 : Math.min(order.length - 1, focus + 1)]?.id ?? null);
      if (e.key === 'k') setFocusId(order[focus < 0 ? 0 : Math.max(0, focus - 1)]?.id ?? null);
      if (e.key === 'Escape') setFocusId(null);
      const s = order[focus];
      if (!s) return;
      if (e.key === 'Enter') fetch(`/api/jump/${encodeURIComponent(s.id)}`, { method: 'POST' });
      if (e.key === 'o') open.agent(s.id);
    };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [order, focus, open]);
  useEffect(() => { // using the mouse puts the keyboard highlight away
    const clear = () => setFocusId(null);
    addEventListener('pointerdown', clear);
    return () => removeEventListener('pointerdown', clear);
  }, []);
  const town = state.projects.filter((p) => p.state !== 'lot').sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

  return (
    <div className="crew">
      <section>
        <h2>Raised a hand <small>they can't continue without you</small></h2>
        {needs.length ? <div className="grid hands">{needs.map((s) => <HandCard key={s.id} s={s} p={projects.get(s.projectId ?? '')} now={now} open={open} focused={s.id === focusId} />)}</div>
          : <Empty title="Nobody is waiting on you." />}
      </section>
      <section>
        <h2>Building <small>{working.length} at work</small></h2>
        {working.length ? <div className="grid works">{working.map((s) => <WorkCard key={s.id} s={s} p={projects.get(s.projectId ?? '')} now={now} open={open} focused={s.id === focusId} />)}</div>
          : <Empty title="Nobody is building right now.">Start <code>claude</code> in any project and they'll clock in here within a couple of seconds.</Empty>}
      </section>
      <section>
        <h2>Just finished <small>what they did before their break</small></h2>
        <FinishedList items={finished} projects={projects} now={now} open={open} />
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
      <Leaderboard state={state} now={now} openProject={open.project} />
      {state.routines?.length ? (
        <Fold id="scheduled" title="Scheduled" note={`${state.routines.length} · jobs that wake up, do their run, and go back to sleep`}>
          <div className="grid routines">{state.routines.map((r) => <RoutineCard key={r.key} r={r} p={projects.get(r.projectId)} now={now} open={open} />)}</div>
        </Fold>
      ) : null}
      <Fold id="closed" title="Clocked out today" note={closed.length}>
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
      </Fold>
      <Fold id="town" title="The town" note={`${town.length} buildings`}>
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
      </Fold>
      <footer className="keys"><span><kbd>j</kbd>/<kbd>k</kbd> move</span><span><kbd>↵</kbd> go to agent</span><span><kbd>o</kbd> open profile</span></footer>
    </div>
  );
}
