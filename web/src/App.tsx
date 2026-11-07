import { useEffect, useState } from 'react';
import { useLogbook } from './useLogbook.ts';
import { Dashboard } from './Dashboard.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import { CityView } from './city/CityView.tsx';
import { compact } from './format.ts';

type View = 'city' | 'dashboard';
const readView = (): View => (location.hash === '#dashboard' ? 'dashboard' : 'city');
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

export function App() {
  const { state, conn } = useLogbook();
  const [view, setView] = useState<View>(readView);
  const [selected, setSelected] = useState<string | null>(null);
  const [showLots, setShowLots] = useState(store.get('logbook.lots') !== '0');
  const theme = useTheme();
  useEffect(() => { const f = () => setView(readView()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { store.set('logbook.lots', showLots ? '1' : '0'); }, [showLots]);
  useEffect(() => {
    const n = state?.totals.needs ?? 0;
    document.title = n ? `(${n}) Logbook` : 'Logbook';
  }, [state?.totals.needs]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const go = (v: View) => { location.hash = v; setView(v); };
  const t = state?.totals;

  return (
    <div className={`app view-${view}`}>
      <header className="bar">
        <div className="brand">Logbook<span className="brand-dot" /></div>
        <nav className="tabs" aria-label="View">
          <button className={view === 'city' ? 'on' : ''} onClick={() => go('city')}>City</button>
          <button className={view === 'dashboard' ? 'on' : ''} onClick={() => go('dashboard')}>Dashboard</button>
        </nav>
        {t ? (
          <div className="summary" aria-live="polite">
            {t.needs ? <span className="sum needs"><b>{t.needs}</b> need{t.needs === 1 ? 's' : ''} you</span> : null}
            <span className="sum"><b>{t.running}</b> working</span>
            <span className="sum"><b>{t.idle}</b> idle</span>
            <span className="sum"><b>{t.doneToday}</b> closed today</span>
            <span className="sum hide-sm"><b>{compact(t.tokensToday)}</b> tokens today</span>
          </div>
        ) : <div className="summary" />}
        <div className="bar-right">
          {view === 'city' ? (
            <label className="toggle hide-sm"><input type="checkbox" id="show-lots" checked={showLots} onChange={(e) => setShowLots(e.target.checked)} /> GitHub-only lots</label>
          ) : null}
          <button className="ghost small" onClick={theme.cycle} aria-label="Toggle dark mode">{theme.dark ? 'Day' : 'Night'}</button>
          <span className={`conn c-${conn}`} title={conn === 'live' ? 'Connected to the logbook daemon' : conn === 'offline' ? 'Daemon not reachable. Is `logbook start` running?' : 'Connecting'} />
        </div>
      </header>
      <main className="main">
        {!state ? (
          <div className="loading">{conn === 'offline' ? 'Can’t reach the logbook daemon on this machine. Start it with `npm start` (or `logbook start`).' : 'Reading your agents’ logbooks…'}</div>
        ) : view === 'city' ? (
          <CityView state={state} selected={selected} onSelect={setSelected} showLots={showLots} dark={theme.dark} />
        ) : (
          <Dashboard state={state} onOpenProject={setSelected} />
        )}
        {state && selected ? <ProjectPanel id={selected} state={state} onClose={() => setSelected(null)} /> : null}
      </main>
    </div>
  );
}
