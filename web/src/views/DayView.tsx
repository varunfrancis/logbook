import { useMemo, useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { bricks, clock, mins, money, useVoice } from '../copy.ts';
import { isoDate, useDay, useNow } from '../useLogbook.ts';

const MARK: Record<string, { sym: string; cls: string; label: string }> = {
  m_commit: { sym: 'S', cls: 'mk-save', label: 'saved progress' },
  m_test_ok: { sym: '✓', cls: 'mk-ok', label: 'checked its work' },
  m_test_fail: { sym: '✕', cls: 'mk-bad', label: 'hit a snag' },
  m_pr: { sym: 'R', cls: 'mk-pr', label: 'sent for review' },
};

export function DayView({ state, openAgent }: { state: StateView; openAgent: (id: string) => void }) {
  const voice = useVoice();
  const now = useNow(30000);
  const [date, setDate] = useState(isoDate());
  const day = useDay(date, state.generatedAt);
  const names = useMemo(() => new Map(state.projects.map((p) => [p.id, p.name])), [state.projects]);
  const shift = (n: number) => { const d = new Date(date + 'T12:00'); d.setDate(d.getDate() + n); setDate(isoDate(d)); };
  const isToday = date === isoDate();
  if (!day) return <div className="loading">Loading the day…</div>;
  // Show the part of the day that had work, padded, at least 8 hours.
  const segs = day.lanes.flatMap((l) => l.segments);
  let from = segs.length ? Math.min(...segs.map((g) => g.start)) : day.start + 8 * 3600_000;
  let to = segs.length ? Math.max(...segs.map((g) => g.end), isToday ? now : 0) : day.start + 18 * 3600_000;
  from = Math.max(day.start, Math.floor((from - 1800_000) / 3600_000) * 3600_000);
  to = Math.min(day.end, Math.ceil((to + 1800_000) / 3600_000) * 3600_000);
  if (to - from < 8 * 3600_000) to = Math.min(day.end, from + 8 * 3600_000);
  const pct = (t: number) => `${(((t - from) / (to - from)) * 100).toFixed(3)}%`;
  const hours: number[] = [];
  const step = to - from > 14 * 3600_000 ? 3 : 2;
  for (let t = from; t <= to; t += step * 3600_000) hours.push(t);
  const st = day.stats;
  const label = isToday ? 'Today' : new Date(date + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="day">
      <div className="day-nav">
        <button className="ghost" onClick={() => shift(-1)} aria-label="Previous day">‹</button>
        <b>{label}</b>
        <button className="ghost" onClick={() => shift(1)} disabled={isToday} aria-label="Next day">›</button>
      </div>
      <div className="stat-grid">
        <div className="stat hot"><span>Hands raised, waiting on you</span><b>{mins(st.waitedMs)}</b><small>{st.longestWait ? `Longest: ${st.longestWait.agent}, ${mins(st.longestWait.ms)} at ${clock(st.longestWait.at)}` : 'Nobody had to wait.'}</small></div>
        <div className="stat"><span>Crew hours worked</span><b>{mins(st.crewMs)}</b><small>{st.crew} crew across {st.projects} project{st.projects === 1 ? '' : 's'}</small></div>
        <div className="stat"><span>Biggest crew</span><b>{st.peak} at once</b><small>{st.peakAt ? `at ${clock(st.peakAt)}` : '—'}</small></div>
        <div className="stat"><span>Shipped</span><b>{st.shipped} <em>of {st.closed} who clocked out</em></b><small>{st.unfinished} left unfinished, {st.scrapped} scrapped · {voice === 'plain' ? bricks(st.bricks) : ''} · {money(st.costUsd)}</small></div>
      </div>
      <section className="lanes-box">
        {day.lanes.length ? (
          <div className="lanes" style={{ ['--rows' as string]: day.lanes.length }}>
            <div className="lane hours"><span />
              <div className="track">{hours.map((t) => <span key={t} style={{ left: pct(t) }}>{new Date(t).toLocaleTimeString([], { hour: 'numeric' })}</span>)}</div>
            </div>
            {day.lanes.map((l) => (
              <div className="lane" key={l.session.id}>
                <button className="who" onClick={() => openAgent(l.session.id)}>
                  <AgentAvatar agent={l.session.agent} mood={moodFor(l.session)} size={30} />
                  <span><b>{l.session.agent.title}</b><small>{names.get(l.session.projectId ?? '')}</small></span>
                </button>
                <div className="track">
                  {l.segments.map((g, i) => <span key={i} className={`seg ${g.kind}`} style={{ left: pct(g.start), width: `calc(${pct(g.end)} - ${pct(g.start)})` }} title={`${g.kind === 'work' ? 'Building' : g.kind === 'wait' ? 'Hand raised' : 'Coffee break'}: ${clock(g.start)}–${clock(g.end)}`} />)}
                  {l.marks.map((m, i) => MARK[m.kind] ? <span key={'m' + i} className={`mark ${MARK[m.kind].cls}`} style={{ left: pct(m.ts) }} title={`${MARK[m.kind].label} at ${clock(m.ts)}`}>{MARK[m.kind].sym}</span> : null)}
                </div>
              </div>
            ))}
            {isToday && now > from && now < to ? <div className="nowline" style={{ left: `calc(220px + 12px + (100% - 232px) * ${(now - from) / (to - from)})` }}><span>now</span></div> : null}
          </div>
        ) : <div className="empty"><b>No crew worked this day.</b></div>}
      </section>
      <div className="legend-row">
        <span><i className="sw work" />Building</span><span><i className="sw wait" />Hand raised, waiting on you</span><span><i className="sw idle" />Coffee break</span>
        <span>S saved progress · ✓ checked its work · ✕ hit a snag · R sent for review</span>
      </div>
    </div>
  );
}
