import { useEffect, useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { liveJobs, type JobWord } from './liveJobs.ts';

const KEY = 'logbook.liveFeed';
const readOpen = () => {
  try { const v = localStorage.getItem(KEY); if (v) return v === 'open'; } catch {}
  return !matchMedia('(max-width: 720px)').matches; // phones start folded
};
const WORD_CLASS: Record<JobWord, string> = { 'Needs you': 'w-needs', Stuck: 'w-stuck', Testing: 'w-test', Building: 'w-build', Planning: 'w-plan' };

/** A card on the Town listing each job an agent is on right now, with one word for where it's at. */
export function LiveFeed({ state, visible, onAgent }: { state: StateView; visible: Set<string> | null; onAgent: (sessionId: string) => void }) {
  const [open, setOpen] = useState(readOpen);
  useEffect(() => { try { localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch {} }, [open]);
  const jobs = liveJobs(state, visible);
  if (!jobs.length) return null;
  const needs = jobs.filter((j) => j.word === 'Needs you').length;
  return (
    <section className={`live-feed${open ? '' : ' closed'}`} aria-label="Live jobs">
      <button className="lf-head" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Fold away' : 'Show live jobs'}>
        <span className="lf-pulse" aria-hidden="true" />
        <span className="lf-title">Live jobs</span>
        <span className={`lf-count${needs ? ' hot' : ''}`}>{jobs.length}{needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : ''}</span>
        <span className="lf-chev" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul className="lf-rows">
          {jobs.map((j) => (
            <li key={j.id}>
              <button className={`lf-row${j.word === 'Needs you' ? ' needs' : ''}`} onClick={() => onAgent(j.id)} title={`Open ${j.session.agent.name}'s card`}>
                <AgentAvatar agent={j.session.agent} mood={moodFor(j.session)} size={32} />
                <span className="lf-body">
                  <span className="lf-top">
                    <span className="lf-job">{j.job}</span>
                    {/* keyed by the word so a change replays the little bounce */}
                    <span key={j.word} className={`lf-word ${WORD_CLASS[j.word]}`}>{j.word}</span>
                  </span>
                  <span className="lf-meta">{j.session.agent.name}{j.project ? ` · ${j.project}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
