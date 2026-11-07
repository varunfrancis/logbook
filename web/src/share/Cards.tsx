import type { DayView, GraveEntry, StateView, WrappedView } from '../../../daemon/types.ts';
import { AgentAvatar } from '../crew/Avatar.tsx';
import { mins, money, STAMP } from '../copy.ts';

/*
 * Share cards. They only ever see plain names (or "Project A, B…" when names are hidden):
 * repo names, branches, files and prompts never reach these components.
 */
export type Privacy = { names: boolean; costs: boolean };
export const alias = (i: number) => `Project ${String.fromCharCode(65 + (i % 26))}`;

function useAlias(state: StateView, privacy: Privacy) {
  const order = [...state.projects].sort((a, b) => b.tokens - a.tokens).map((p) => p.id);
  return (projectId: string | null | undefined, name: string) => (privacy.names ? name : alias(Math.max(0, order.indexOf(projectId ?? ''))));
}

const dateLabel = (ts: number) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

export function WaitedCard({ state, day }: { state: StateView; day: DayView; privacy: Privacy }) {
  const per = day.lanes.map((l) => ({ s: l.session, ms: l.segments.filter((g) => g.kind === 'wait').reduce((n, g) => n + g.end - g.start, 0) }))
    .filter((x) => x.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, 4);
  const max = per[0]?.ms || 1;
  const pctDay = day.stats.crewMs ? Math.round((day.stats.waitedMs / (day.stats.crewMs + day.stats.waitedMs)) * 100) : 0;
  return (
    <div className="card waited">
      <div className="waited-main">
        <div className="lead">Today my agents waited on me for</div>
        <div className="huge">{mins(day.stats.waitedMs).replace(' min', 'm').replace(' h ', 'h ')}</div>
        <div className="note">That's {pctDay}% of their day spent with a hand raised, waiting for me to say yes.</div>
      </div>
      <div className="waited-side">
        <div className="kicker">Most patient crew</div>
        {per.length ? per.map((x) => (
          <div className="wrow" key={x.s.id}>
            <AgentAvatar agent={x.s.agent} mood="needs" size={48} />
            <b>{x.s.agent.name}</b>
            <div className="bar"><i style={{ width: `${(x.ms / max) * 100}%` }} /></div>
            <span>{mins(x.ms)}</span>
          </div>
        )) : <div className="note">Nobody waited today. Suspicious.</div>}
        {per[0] ? <div className="note">{per[0].s.agent.title} waited {mins(per[0].ms)} for an answer.</div> : null}
      </div>
      <footer><span>{state.town.name} · {dateLabel(day.start)} · a crew of {day.stats.crew} · {day.stats.projects} project{day.stats.projects === 1 ? '' : 's'}</span><b>logbook</b></footer>
    </div>
  );
}

export function GraveyardCard({ state, graves, privacy }: { state: StateView; graves: GraveEntry[]; privacy: Privacy }) {
  const name = useAlias(state, privacy);
  const shown = graves.slice(0, 4);
  const month = new Date().toLocaleString('en', { month: 'long' });
  return (
    <div className="card grave">
      <div className="moon" />
      <div className="hill" /><div className="ground" />
      <div className="grave-title"><b>My agent graveyard</b><span>{state.town.name}, {month} so far · they tried their best</span></div>
      <div className="stones">
        {shown.length ? shown.map((g, i) => (
          <div className="stone" key={g.sessionId} style={{ height: 300 + ((i * 37) % 50) }}>
            <AgentAvatar agent={g.agent} mood="out" size={64} />
            <b>RIP {g.agent.name}</b>
            <span>{g.epitaph}</span>
            <small>{name(state.projects.find((p) => p.name === g.projectName)?.id, g.projectName)} · {g.bricks} bricks</small>
          </div>
        )) : <div className="stone empty-stone"><b>Nobody here yet</b><span>Every agent kept their work this month.</span></div>}
      </div>
      <footer><span>{graves.length} crew lost · {graves.reduce((n, g) => n + g.bricks, 0)} bricks</span><b>logbook</b></footer>
    </div>
  );
}

export function ReceiptCard({ state, day, privacy }: { state: StateView; day: DayView; privacy: Privacy }) {
  const name = useAlias(state, privacy);
  const names = new Map(state.projects.map((p) => [p.id, p.name]));
  const items = day.lanes.map((l) => l.session).sort((a, b) => b.costUsd - a.costUsd);
  const top = items.slice(0, 9), rest = items.slice(9);
  const shipped = items.filter((s) => s.stamp === 'shipped').length;
  const sizes = items.reduce((m, s) => { if (s.size) m[s.size] = (m[s.size] ?? 0) + 1; return m; }, {} as Record<string, number>);
  const total = items.reduce((n, s) => n + s.costUsd, 0);
  const status = (s: (typeof items)[number]) => (s.stamp ? STAMP.plain[s.stamp] : s.status === 'needs_input' ? 'Hand raised' : s.stuck ? 'Stuck' : s.status === 'running' ? 'Still building' : 'On a break').toUpperCase();
  const price = (n: number) => (privacy.costs ? money(n) : '');
  return (
    <div className="card receipt-wrap">
      <div className="receipt">
        <div className="rc-head"><b>{state.town.name.toUpperCase()}</b><span>BUILDERS' YARD &amp; CO.</span><span>{new Date(day.start).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}</span><span>FOREMAN: {state.town.owner.toUpperCase()}</span></div>
        <hr />
        {top.map((s) => (
          <div className="rc-item" key={s.id}>
            <div><b>{name(s.projectId, names.get(s.projectId ?? '') ?? '').toUpperCase()}: {s.title.toUpperCase().slice(0, 26)}</b><span>{status(s).startsWith('SCRAPPED') && privacy.costs ? 'VOID ' : ''}{price(s.costUsd)}</span></div>
            <small>  {status(s)} · {s.agent.title}</small>
          </div>
        ))}
        {rest.length ? <div className="rc-item"><div><b>ODD JOBS ({rest.length} MORE)</b><span>{price(rest.reduce((n, s) => n + s.costUsd, 0))}</span></div></div> : null}
        <hr />
        <div className="rc-line"><span>HANDS RAISED, WAITING ON YOU {mins(day.stats.waitedMs).toUpperCase()}</span><span>NO CHARGE</span></div>
        <div className="rc-line"><span>BRICKS LAID</span><span>{day.stats.bricks.toLocaleString()}</span></div>
        <div className="rc-line"><span>CREW ON SHIFT</span><span>{day.stats.crew}</span></div>
        <div className="rc-line"><span>{Object.entries(sizes).map(([k, v]) => `${v} ${k.toUpperCase()}${v > 1 ? 'S' : ''}`).join(' · ') || 'NO CHANGES'}</span><span /></div>
        <hr />
        {privacy.costs ? <><div className="rc-total"><span>TOTAL</span><span>{money(total)}</span></div>
          <div className="rc-line"><span>COST PER THING SHIPPED</span><span>{shipped ? money(total / shipped) : '—'}</span></div></> : <div className="rc-total"><span>SHIPPED</span><span>{shipped}</span></div>}
        <div className="barcode" />
        <div className="rc-foot"><b>*** THANK YOU FOR SHIPPING ***</b><span>NO REFUNDS ON UNFINISHED WORK</span></div>
      </div>
    </div>
  );
}

export function WrappedCards({ state, w }: { state: StateView; w: WrappedView }) {
  const rank = w.peak >= 20 ? 'Tycoon' : w.peak >= 10 ? 'Mayor' : w.peak >= 6 ? 'Foreman' : w.peak >= 3 ? 'Builder' : 'Apprentice';
  const hour = w.stats.busiestHour == null ? '—' : new Date(2026, 0, 1, w.stats.busiestHour).toLocaleTimeString([], { hour: 'numeric' });
  const month = w.label.split(' ')[0];
  return (
    <div className="card wrapped">
      <div className="story s1">
        <div className="bars"><i className="on" /><i /><i /></div>
        <div className="kicker">{state.town.name} Wrapped · {month}</div>
        <div className="big-q">Your MVP agent was</div>
        {w.mvp ? <>
          <div className="hero"><AgentAvatar agent={w.mvp.agent} mood="shipped" size={220} /></div>
          <div className="mvp">{w.mvp.agent.name}<small>the {w.mvp.agent.jobTitle}</small></div>
          <div className="tiles"><div><b>{w.mvp.shipped}</b>things shipped</div><div><b>{w.mvp.scrapped}</b>scrapped</div><div><b>{w.mvp.bricks.toLocaleString()}</b>bricks laid</div><div><b>{w.mvp.project ?? '—'}</b>favourite project</div></div>
        </> : <div className="mvp">Nobody yet</div>}
      </div>
      <div className="story s2">
        <div className="bars"><i className="on" /><i className="on" /><i /></div>
        <div className="big-q">At your busiest you ran</div>
        <div className="giant">{w.peak}</div>
        <div className="sub2">crew on site at once{w.peakAt ? <><br /><span>{new Date(w.peakAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span></> : null}</div>
        <div className="ranks"><div className="kicker">Your rank</div>
          <div className="rank-row">{['Builder', 'Foreman', 'Mayor', 'Tycoon'].map((r) => <span key={r} className={r === rank ? 'on' : ''}>{r}<br />{{ Builder: '3+', Foreman: '6+', Mayor: '10+', Tycoon: '20+' }[r]}</span>)}</div>
        </div>
      </div>
      <div className="story s3">
        <div className="bars"><i className="on" /><i className="on" /><i className="on" /></div>
        <div className="big-q">Your {month} in {state.town.name}</div>
        {[['Shifts worked', w.stats.shifts], ['Things shipped', w.stats.shipped], ['In the graveyard', w.stats.graveyard], ['Hands raised, waiting on you', mins(w.stats.waitedMs)], ['Busiest hour', hour], ['Bricks laid', w.stats.bricks.toLocaleString()], ['New buildings', w.stats.newBuildings]].map(([k, v]) => (
          <div className="kv" key={String(k)}><span>{k}</span><b>{v}</b></div>
        ))}
        <footer><span /><b>logbook</b></footer>
      </div>
    </div>
  );
}
