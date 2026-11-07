import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLogbook } from './useLogbook.ts';
import { CrewView } from './views/CrewView.tsx';
import { DayView } from './views/DayView.tsx';
import { AgentPanel } from './views/AgentPanel.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import { CityView } from './city/CityView.tsx';
import { Settings, TownPicker } from './TownPicker.tsx';
import { ShareSheet } from './share/ShareSheet.tsx';
import { bricks, money, VoiceContext, type Voice } from './copy.ts';
import { compact } from './format.ts';

type View = 'town' | 'crew' | 'day';
const readView = (): View => (location.hash === '#crew' ? 'crew' : location.hash === '#day' ? 'day' : 'town');
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };

function useTheme() {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const [pref, setPref] = useState<'system' | 'light' | 'dark'>((store.get('logbook.theme') as any) || 'system');
  const [sysDark, setSysDark] = useState(media.matches);
  useEffect(() => { const f = () => setSysDark(media.matches); media.addEventListener('change', f); return () => media.removeEventListener('change', f); }, []);
  useEffect(() => {
    if (pref === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = pref;
    store.set('logbook.theme', pref);
  }, [pref]);
  const dark = pref === 'dark' || (pref === 'system' && sysDark);
  return { dark, cycle: () => setPref(pref === 'system' ? (sysDark ? 'light' : 'dark') : pref === 'dark' ? 'light' : 'dark') };
}

type Sel = { kind: 'project' | 'agent'; id: string } | null;

export function App() {
  const { state, conn } = useLogbook();
  const [view, setView] = useState<View>(readView);
  const [sel, setSel] = useState<Sel>(null);
  const [showLots, setShowLots] = useState(store.get('logbook.lots') !== '0');
  const [voice, setVoice] = useState<Voice>((store.get('logbook.voice') as Voice) || 'plain');
  const [modal, setModal] = useState<'settings' | 'town' | 'share' | null>(null);
  const theme = useTheme();
  useEffect(() => { const f = () => setView(readView()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { store.set('logbook.lots', showLots ? '1' : '0'); }, [showLots]);
  useEffect(() => { store.set('logbook.voice', voice); }, [voice]);
  useEffect(() => {
    const n = state?.totals.needs ?? 0;
    document.title = `${n ? `(${n}) ` : ''}${state?.town.name ?? 'Logbook'}`;
  }, [state?.totals.needs, state?.town.name]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSel(null); setModal(null); } };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const go = (v: View) => { location.hash = v; setView(v); };
  const open = useMemo(() => ({ agent: (id: string) => setSel({ kind: 'agent', id }), project: (id: string) => setSel({ kind: 'project', id }) }), []);
  const selectProject = useCallback((id: string | null) => setSel(id ? { kind: 'project', id } : null), []);
  const t = state?.totals;
  const firstLaunch = state && !state.town.chosen;

  return (
    <VoiceContext.Provider value={voice}>
      <div className={`app view-${view}`}>
        <header className="bar">
          <div className="brand"><b>{state?.town.name ?? 'Logbook'}</b><small>a Logbook town</small></div>
          <nav className="tabs" aria-label="View">
            <button className={view === 'town' ? 'on' : ''} onClick={() => go('town')}>Town</button>
            <button className={view === 'crew' ? 'on' : ''} onClick={() => go('crew')}>Crew</button>
            <button className={view === 'day' ? 'on' : ''} onClick={() => go('day')}>Day</button>
          </nav>
          {t ? (
            <div className="summary" aria-live="polite">
              {t.needs ? <button className="sum needs" onClick={() => go('crew')}><b>{t.needs}</b> raised a hand</button> : null}
              <span className="sum"><b>{t.running}</b> building</span>
              <span className="sum"><b>{t.idle}</b> on a coffee break</span>
              <span className="sum"><b>{t.shippedToday}</b> shipped today</span>
              <span className="sum hide-sm"><b>{voice === 'plain' ? t.bricksToday.toLocaleString() : compact(t.tokensToday)}</b> {voice === 'plain' ? 'bricks laid' : 'tokens'}</span>
            </div>
          ) : <div className="summary" />}
          <div className="bar-right">
            {t ? <button className="link hide-sm" onClick={() => go('day')} title="See the day's numbers">Today's cost: {money(t.costToday)}</button> : null}
            {view === 'town' ? <label className="toggle hide-sm"><input type="checkbox" id="show-lots" checked={showLots} onChange={(e) => setShowLots(e.target.checked)} /> For-sale lots</label> : null}
            <div className="seg-toggle" role="group" aria-label="Language">
              <button className={voice === 'plain' ? 'on' : ''} onClick={() => setVoice('plain')}>Plain</button>
              <button className={voice === 'technical' ? 'on' : ''} onClick={() => setVoice('technical')}>Technical</button>
            </div>
            <button className="ghost small" onClick={theme.cycle} aria-label="Toggle day and night">{theme.dark ? 'Day' : 'Night'}</button>
            <button className="ghost small" onClick={() => setModal('settings')} aria-label="Settings">Settings</button>
            <span className={`conn c-${conn}`} title={conn === 'live' ? 'Connected' : conn === 'offline' ? 'Logbook isn’t running. Start it with `npm start`.' : 'Connecting'} />
          </div>
        </header>
        <main className="main">
          {!state ? (
            <div className="loading">{conn === 'offline' ? 'Can’t reach Logbook on this machine. Start it with `npm start` (or `logbook start`).' : 'Opening the town gates…'}</div>
          ) : view === 'town' ? (
            <CityView state={state} selected={sel?.kind === 'project' ? sel.id : null} onSelect={selectProject} onAgent={open.agent} showLots={showLots} dark={theme.dark} onShare={() => setModal('share')} />
          ) : view === 'crew' ? (
            <CrewView state={state} open={open} />
          ) : (
            <DayView state={state} openAgent={open.agent} />
          )}
          {state && sel?.kind === 'project' ? <ProjectPanel id={sel.id} state={state} onClose={() => setSel(null)} openAgent={open.agent} /> : null}
          {state && sel?.kind === 'agent' ? <AgentPanel id={sel.id} state={state} onClose={() => setSel(null)} openProject={open.project} /> : null}
        </main>
        {state && (firstLaunch || modal === 'town') ? <TownPicker state={state} onDone={() => setModal(null)} /> : null}
        {state && modal === 'settings' ? <Settings state={state} onClose={() => setModal(null)} renameTown={() => setModal('town')} /> : null}
        {state && modal === 'share' ? <ShareSheet state={state} onClose={() => setModal(null)} /> : null}
        {t && voice === 'plain' && view !== 'town' ? <div className="sr">{bricks(t.bricksToday)}</div> : null}
      </div>
    </VoiceContext.Provider>
  );
}
