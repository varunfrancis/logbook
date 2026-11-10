import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TownReplies } from './TownReplies.tsx';
import type { StateView } from '../../../daemon/types.ts';
import { CityScene } from './scene.ts';
import { PROJECT, useVoice, type Bubble } from '../copy.ts';
import { BumpToasts } from './BumpToasts.tsx';
import { LiveFeed } from './LiveFeed.tsx';

export function CityView({ state, selected, onSelect, onAgent, onGraveyard, focus, showLots, bubble, dark, onShare, tourFocus = null, openAgentId = null }: {
  /** tourFocus: a building the welcome tour is pointing at; the camera flies there and names it. */
  tourFocus?: string | null;
  /** The agent whose drawer is open: their town reply bubble steps aside. */
  openAgentId?: string | null;
  state: StateView; selected: string | null; onSelect: (id: string | null) => void; onAgent: (sessionId: string) => void; onGraveyard: () => void;
  focus: { sessions: Set<string> | null; projects: Set<string> | null; sessionProjects: Set<string> }; showLots: boolean; bubble: Bubble; dark: boolean; onShare: () => void;
}) {
  const voice = useVoice();
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<CityScene | null>(null);
  const [ready, setReady] = useState<CityScene | null>(null); // the scene, once it exists (children's effects run before ours)
  const cb = useRef({ onSelect, onAgent, onGraveyard });
  cb.current = { onSelect, onAgent, onGraveyard };
  const activeCount = state.projects.filter((p) => p.state === 'site' || p.state === 'needs').length;

  useEffect(() => {
    const s = new CityScene(host.current!, labels.current!, { onSelect: (id) => cb.current.onSelect(id), onAgent: (id) => cb.current.onAgent(id), onGraveyard: () => cb.current.onGraveyard() });
    scene.current = s;
    setReady(s);
    return () => { s.dispose(); scene.current = null; setReady(null); };
  }, []);
  useEffect(() => { scene.current?.setBubble(bubble); }, [bubble]);
  // a high-five from an agent's chat: they cheer in the town too
  useEffect(() => {
    const f = (e: Event) => { const sid = (e as CustomEvent).detail?.sessionId; if (sid) scene.current?.highFive(sid); };
    window.addEventListener('swarmville:highfive', f);
    return () => window.removeEventListener('swarmville:highfive', f);
  }, []);
  useEffect(() => { scene.current?.setTheme(dark); scene.current?.setState(state, showLots); }, [dark]);
  useEffect(() => { scene.current?.setState(state, showLots); }, [state, showLots]);
  useEffect(() => { scene.current?.setSelected(selected); }, [selected]);
  // the agent drawer dims the town: it keeps moving behind it at a gentler frame rate
  useEffect(() => { ready?.setBackdrop(!!openAgentId); }, [ready, openAgentId]);
  useEffect(() => {
    if (!tourFocus) return;
    // after the first render so the building exists
    const t = setTimeout(() => { scene.current?.setSelected(tourFocus); scene.current?.focus(tourFocus, 'left'); }, 60);
    return () => { clearTimeout(t); scene.current?.setSelected(selected); };
  }, [tourFocus]);
  useEffect(() => { scene.current?.setFocus(focus.sessions, focus.projects, focus.sessionProjects); }, [focus]);

  return (
    <div className="city">
      <div className="city-canvas" ref={host} />
      <div className="city-labels" ref={labels} />
      <TownReplies state={state} scene={ready} openAgent={onAgent} openId={openAgentId} />
      <div className="town-left">
        <BumpToasts state={state} onAgent={onAgent} />
      </div>
      <LiveFeed state={state} visible={focus.projects} onAgent={onAgent} />
      <div className="city-actions">
        <button className="btn dark" onClick={onShare} title="Post a card of your AI crew: your org chart or their payroll">Show off</button>
      </div>
      <div className="city-tools">
        <span className="tool-hint">Pan <kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd> or <kbd>WASD</kbd></span>
        <Tool k="+" label="Zoom in" title="Zoom in (+) · or scroll" onClick={() => scene.current?.zoomBy(1.25)}>+</Tool>
        <Tool k="−" label="Zoom out" title="Zoom out (−) · or scroll" onClick={() => scene.current?.zoomBy(0.8)}>−</Tool>
        <Tool k="Q" label="Turn the town left" title="Turn left (Q) · or right-drag / shift-drag to spin" onClick={() => scene.current?.rotateBy(-90)}>⟲</Tool>
        <Tool k="E" label="Turn the town right" title="Turn right (E) · or right-drag / shift-drag to spin" onClick={() => scene.current?.rotateBy(90)}>⟳</Tool>
        <Tool k="G" label="Focus on active projects" disabled={!activeCount} onClick={() => scene.current?.focusActive()}
          title={activeCount ? `Focus on the ${activeCount} active project${activeCount === 1 ? '' : 's'} (G)` : 'No one is working right now'}>
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M3 7V4a1 1 0 0 1 1-1h3M13 3h3a1 1 0 0 1 1 1v3M17 13v3a1 1 0 0 1-1 1h-3M7 17H4a1 1 0 0 1-1-1v-3" /><circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none" />
          </svg>
        </Tool>
        <Tool k="F" label="Fit whole town" title="Fit whole town (F)" onClick={() => scene.current?.fit()}>⤢</Tool>
      </div>
      <div className="legend">
        <span><i className="p-site" />{PROJECT[voice].site}</span>
        <span><i className="p-needs" />{PROJECT[voice].needs}</span>
        <span><i className="p-construction" />{PROJECT[voice].construction} <small>last 7 days</small></span>
        <span><i className="p-recent" />{PROJECT[voice].recent} <small>7–30 days</small></span>
        <span><i className="p-done" />{PROJECT[voice].done}</span>
        <span><i className="p-lot" />{PROJECT[voice].lot}</span>
      </div>
    </div>
  );
}

/** A camera button with its keyboard shortcut shown beside it. */
function Tool({ k, label, title, disabled, onClick, children }: { k: string; label: string; title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className={`tool-row${disabled ? ' off' : ''}`}>
      <kbd className="tool-key" aria-hidden="true">{k}</kbd>
      <button className="tool" onClick={onClick} disabled={disabled} aria-label={`${label} (${k})`} aria-keyshortcuts={k === '−' ? '-' : k} title={title}>{children}</button>
    </div>
  );
}
