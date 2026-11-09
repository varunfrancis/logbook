import { useEffect, useRef, useState } from 'react';
import type { StateView } from '../../daemon/types.ts';

/** Header dropdown: tick the projects you want to see. Hidden projects lose their name tag and crew in the town, and drop out of the Crew view.
 *  Starts on "only with crew on site", which follows agents as they arrive and leave; ticking a box switches to a hand-picked set. */
export function ProjectPicker({ state, hidden, setHidden, liveOnly, setLiveOnly }: { state: StateView; hidden: Set<string>; setHidden: (s: Set<string>) => void; liveOnly: boolean; setLiveOnly: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('mousedown', f); return () => removeEventListener('mousedown', f);
  }, [open]);
  const projects = state.projects.filter((p) => p.state !== 'lot').sort((a, b) => Number(b.liveSessions > 0) - Number(a.liveSessions > 0) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const shown = projects.filter((p) => !hidden.has(p.id)).length;
  const toggle = (id: string) => { const n = new Set(hidden); n.has(id) ? n.delete(id) : n.add(id); setHidden(n); };
  return (
    <div className="picker" ref={ref}>
      <button className={`ghost small${hidden.size && !liveOnly ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        Projects: {liveOnly ? (hidden.size ? `on site (${shown})` : 'all') : hidden.size ? `${shown} of ${projects.length}` : 'all'} ▾
      </button>
      {open ? (
        <div className="picker-pop" role="dialog" aria-label="Choose projects">
          <div className="picker-actions">
            <button className={`link${liveOnly ? ' on' : ''}`} aria-pressed={liveOnly} onClick={setLiveOnly}>Only with crew on site</button>
            <button className={`link${!liveOnly && !hidden.size ? ' on' : ''}`} onClick={() => setHidden(new Set())}>Show all</button>
            <button className="link" onClick={() => setHidden(new Set(projects.map((p) => p.id)))}>None</button>
          </div>
          <ul>
            {projects.map((p) => (
              <li key={p.id}><label>
                <input type="checkbox" checked={!hidden.has(p.id)} onChange={() => toggle(p.id)} />
                <span>{p.name}</span>{p.liveSessions ? <small className="live">{p.liveSessions} on site</small> : <small>{p.district ?? ''}</small>}
              </label></li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
