import { useEffect, useRef, useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { useVoice } from '../copy.ts';

type Bump = { key: string; a: { id: string; name: string }; b: { id: string | null; name: string }; file: string; project: string | null };

const SHOW_MS = 9000;
const QUIET_MS = 20 * 60_000; // don't repeat the same pair + file within this window
// Module-level so switching tabs (which unmounts the town) doesn't replay old heads-ups.
const lastShown = new Map<string, number>();

/** Finds pairs of agents currently bumping into each other (both changing the same file). */
function bumpsIn(state: StateView): Bump[] {
  const byName = new Map(state.sessions.filter((s) => s.status === 'running').map((s) => [s.agent.name, s]));
  const out = new Map<string, Bump>();
  for (const s of state.sessions) {
    if (!s.collision) continue;
    const other = byName.get(s.collision.with);
    const pair = [s.agent.name, s.collision.with].sort();
    const key = `${s.projectId}|${pair.join('+')}|${s.collision.file}`;
    if (out.has(key)) continue;
    out.set(key, {
      key, file: s.collision.file,
      a: { id: s.id, name: s.agent.name },
      b: { id: other?.id ?? null, name: s.collision.with },
      project: state.projects.find((p) => p.id === s.projectId)?.name ?? null,
    });
  }
  return [...out.values()];
}

/** Small, self-dismissing FYI cards on the Town when two agents start working on the same file. */
export function BumpToasts({ state, onAgent }: { state: StateView; onAgent: (id: string) => void }) {
  const voice = useVoice();
  const [toasts, setToasts] = useState<(Bump & { at: number })[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = (key: string) => {
    clearTimeout(timers.current.get(key)); timers.current.delete(key);
    setToasts((ts) => ts.filter((t) => t.key !== key));
  };

  useEffect(() => {
    const now = Date.now();
    const fresh = bumpsIn(state).filter((b) => now - (lastShown.get(b.key) ?? 0) > QUIET_MS);
    if (!fresh.length) return;
    fresh.forEach((b) => lastShown.set(b.key, now));
    setToasts((ts) => [...ts.filter((t) => !fresh.some((f) => f.key === t.key)), ...fresh.map((f) => ({ ...f, at: now }))].slice(-3));
    for (const f of fresh) {
      clearTimeout(timers.current.get(f.key));
      timers.current.set(f.key, setTimeout(() => dismiss(f.key), SHOW_MS));
    }
  }, [state]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  if (!toasts.length) return null;
  const who = (p: { id: string | null; name: string }) =>
    p.id ? <button className="bump-name" onClick={() => onAgent(p.id!)}>{p.name}</button> : <b>{p.name}</b>;
  return (
    <div className="bump-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.key} className="bump-toast">
          <span className="bump-icon" aria-hidden="true">!</span>
          <div className="bump-body">
            <div className="bump-title">{voice === 'plain' ? 'Heads up' : 'Collision'}{t.project ? <small> · {t.project}</small> : null}</div>
            <div className="bump-text">
              {voice === 'plain'
                ? <>{who(t.a)} and {who(t.b)} are both changing <code>{t.file}</code></>
                : <>{who(t.a)} ↔ {who(t.b)} on <code>{t.file}</code></>}
            </div>
          </div>
          <button className="bump-x" onClick={() => dismiss(t.key)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
