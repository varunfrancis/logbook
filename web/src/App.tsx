import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLogbook } from './useLogbook.ts';
import { CrewView } from './views/CrewView.tsx';
import { MedalToasts } from './crew/Leaderboard.tsx';
import { DayView } from './views/DayView.tsx';
import { AgentPanel } from './views/AgentPanel.tsx';
import { AskPopup } from './views/AskPopup.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import { GraveyardPanel } from './views/GraveyardPanel.tsx';
import { CostPanel } from './views/CostPanel.tsx';
import { ProjectPicker } from './ProjectPicker.tsx';
import { CityView } from './city/CityView.tsx';
import { Settings, TownPicker } from './TownPicker.tsx';
import { ShareSheet } from './share/ShareSheet.tsx';
import { bricks, money, VoiceContext, type Bubble, type Voice } from './copy.ts';
import { compact } from './format.ts';
import { setMusic, useSound } from './audio.ts';
import { TourPill, useWelcome, Welcome } from './welcome/Welcome.tsx';
import { ArrivalToasts, Tips } from './welcome/Tips.tsx';
import { SavedToast } from './SavedToast.tsx';
import { AgentAvatar, FOREMAN } from './crew/Avatar.tsx';
import { PipFavicon, townMood } from './crew/PipFavicon.tsx';

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

type Sel = { kind: 'project' | 'agent' | 'ask' | 'graveyard' | 'cost'; id: string } | null;

export function App() {
  const { state, conn } = useLogbook();
  const stateRef = useRef(state); stateRef.current = state;
  const [view, setView] = useState<View>(readView);
  const [sel, setSel] = useState<Sel>(null);
  const [showLots, setShowLots] = useState(store.get('logbook.lots') !== '0');
  const [voice, setVoice] = useState<Voice>((store.get('logbook.voice') as Voice) || 'plain');
  const [bubble, setBubble] = useState<Bubble>(() => { const b = store.get('logbook.bubbleMode'); return b === 'project' || b === 'task' ? b : 'job'; });
  const [modal, setModal] = useState<'settings' | 'town' | 'share' | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const theme = useTheme();
  const welcome = useWelcome(state);
  const [tourFocus, setTourFocus] = useState<string | null>(null);
  const sound = useSound();
  // Header filters: one of the counts (who to highlight) and a set of hidden projects (remembered).
  const [only, setOnly] = useState<'needs' | 'building' | 'break' | 'shipped' | null>(null);
  const [hidden, setHiddenRaw] = useState<Set<string>>(() => { try { return new Set(JSON.parse(store.get('logbook.hiddenProjects') || '[]')); } catch { return new Set(); } });
  const setHidden = (s: Set<string>) => { setHiddenRaw(s); store.set('logbook.hiddenProjects', JSON.stringify([...s])); };
  useEffect(() => { const f = () => setView(readView()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { store.set('logbook.lots', showLots ? '1' : '0'); }, [showLots]);
  useEffect(() => { store.set('logbook.voice', voice); }, [voice]);
  useEffect(() => { store.set('logbook.bubbleMode', bubble); }, [bubble]);
  useEffect(() => {
    const n = state?.totals.needs ?? 0;
    document.title = `${n ? `(${n}) ` : ''}${state?.town.name ?? 'Swarmville'}`;
  }, [state?.totals.needs, state?.town.name]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSel(null); setModal(null); } };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const go = (v: View) => { location.hash = v; setView(v); };
  const open = useMemo(() => ({ agent: (id: string) => setSel({ kind: 'agent', id }), project: (id: string) => setSel({ kind: 'project', id }) }), []);
  // In the town, an agent with a hand up opens just what they're asking (approve it right there), not the whole drawer.
  const townAgent = useCallback((id: string) => {
    const s = stateRef.current?.sessions.find((x) => x.id === id);
    setSel({ kind: s?.status === 'needs_input' ? 'ask' : 'agent', id });
  }, []);
  const selectProject = useCallback((id: string | null) => setSel(id ? { kind: 'project', id } : null), []);
  const t = state?.totals;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const focus = useMemo(() => {
    if (!state) return { sessions: null, projects: null, sessionProjects: new Set<string>() };
    const projects = hidden.size ? new Set(state.projects.filter((p) => !hidden.has(p.id)).map((p) => p.id)) : null;
    if (!only) return { sessions: null, projects, sessionProjects: new Set<string>() };
    const match = state.sessions.filter((s) => only === 'needs' ? s.status === 'needs_input' : only === 'building' ? s.status === 'running' : only === 'break' ? s.status === 'idle'
      : s.status === 'ended' && s.stamp === 'shipped' && (s.endedAt ?? 0) >= today0.getTime());
    return { sessions: new Set(match.map((s) => s.id)), projects, sessionProjects: new Set(match.map((s) => s.projectId ?? '')) };
  }, [state, only, hidden]);
  // The Crew view lists only what the filters let through.
  const crewState = useMemo(() => state && (focus.sessions || focus.projects) ? { ...state, projects: focus.projects ? state.projects.filter((p) => focus.projects!.has(p.id)) : state.projects,
    sessions: state.sessions.filter((s) => (!focus.sessions || focus.sessions.has(s.id)) && (!focus.projects || focus.projects.has(s.projectId ?? ''))),
    routines: (state.routines ?? []).filter((r) => (!focus.projects || focus.projects.has(r.projectId)) && (!focus.sessions || (!!r.liveSessionId && focus.sessions.has(r.liveSessionId)))),
    crews: (state.crews ?? []).filter((c) => !focus.projects || focus.projects.has(c.projectId)),
    notes: (state.notes ?? []).filter((n) => !focus.projects || focus.projects.has(n.projectId)) } : state, [state, focus]);
  const chip = (key: NonNullable<typeof only>, n: number, label: string, cls = '') => (
    <button className={`sum chip ${cls}${only === key ? ' on' : ''}`} aria-pressed={only === key} onClick={() => setOnly(only === key ? null : key)} title={only === key ? 'Show everyone' : `Highlight only these`}><b>{n}</b> {label}</button>
  );
  const firstLaunch = state && !state.town.chosen;

  return (
    <VoiceContext.Provider value={voice}>
      <div className={`app view-${view}${welcome.active && welcome.step !== 'setup' && welcome.step !== 'name' ? ' touring' : ''}`}>
        <header className="bar">
          <div className="brand"><AgentAvatar agent={FOREMAN} mood="hello" size={30} /><div className="brand-text"><b>{state?.town.name ?? 'Swarmville'}</b><small>a Swarmville town</small></div></div>
          <PipFavicon mood={state ? townMood(state.sessions) : 'hello'} />
          <nav className="tabs" aria-label="View">
            <button className={view === 'town' ? 'on' : ''} onClick={() => go('town')}>Town</button>
            <button className={view === 'crew' ? 'on' : ''} onClick={() => go('crew')}>Crew</button>
            <button className={view === 'day' ? 'on' : ''} onClick={() => go('day')}>Day</button>
          </nav>
          {t ? (
            <div className="summary" aria-live="polite">
              {t.needs ? chip('needs', t.needs, 'raised a hand', 'needs') : null}
              {chip('building', t.running, 'building')}
              {chip('break', t.idle, 'on a coffee break')}
              {chip('shipped', t.shippedToday, 'shipped today')}
              {state ? <ProjectPicker state={state} hidden={hidden} setHidden={setHidden} /> : null}
              <TourPill api={welcome} />
              <span className="sum hide-sm"><b>{voice === 'plain' ? t.bricksToday.toLocaleString() : compact(t.tokensToday)}</b> {voice === 'plain' ? 'bricks laid' : 'tokens'}</span>
            </div>
          ) : <div className="summary" />}
          <div className="bar-right">
            {t ? <button className="link hide-sm" onClick={() => setSel(sel?.kind === 'cost' ? null : { kind: 'cost', id: '' })} aria-pressed={sel?.kind === 'cost'} title="See which projects and agents spent it">Today's cost: {money(t.costToday)}</button> : null}
            <button className={`ghost small music${sound.music ? ' on' : ''}`} onClick={() => setMusic(!sound.music)} aria-pressed={sound.music}
              title={sound.music ? 'Background music is on. Click to turn it off' : 'Background music is off. Click to turn it on'}>{sound.music ? '♪ Music on' : '♪ Music off'}</button>
            <button className="ghost small" onClick={theme.cycle} aria-label="Toggle day and night">{theme.dark ? 'Day' : 'Night'}</button>
            <button className="ghost small" onClick={() => setModal('settings')} aria-label="Settings">Settings</button>
            {state && conn === 'offline' ? <span className="conn-off" title="Swarmville isn’t running. Start it with `npm start`.">Offline</span> : null}
          </div>
        </header>
        <main className="main">
          {!state ? (
            <div className="loading">{conn === 'offline' ? 'Can’t reach Swarmville on this machine. Start it with `npm start` (or `logbook start`).' : 'Opening the town gates…'}</div>
          ) : view === 'town' ? (
            <CityView state={state} selected={sel?.kind === 'project' ? sel.id : null} onSelect={selectProject} onAgent={townAgent} onGraveyard={() => setSel({ kind: 'graveyard', id: '' })} focus={focus} showLots={showLots} bubble={bubble} dark={theme.dark} onShare={() => setModal('share')} tourFocus={welcome.active ? tourFocus : null} />
          ) : view === 'crew' ? (
            <CrewView state={crewState!} open={open} />
          ) : (
            <DayView state={state} openAgent={open.agent} />
          )}
          {state && sel?.kind === 'project' ? <ProjectPanel id={sel.id} state={state} onClose={() => setSel(null)} openAgent={open.agent} /> : null}
          {state && sel?.kind === 'cost' ? <CostPanel state={state} onClose={() => setSel(null)} openProject={open.project} openAgent={open.agent} /> : null}
          {state && sel?.kind === 'graveyard' ? <GraveyardPanel state={state} onClose={() => setSel(null)} openAgent={open.agent} /> : null}
          {state && sel?.kind === 'ask' ? <AskPopup key={sel.id} id={sel.id} state={state} onClose={() => setSel(null)} openProfile={open.agent} /> : null}
          {state && sel?.kind === 'agent' ? <AgentPanel id={sel.id} state={state} onClose={() => setSel(null)} openProject={open.project} openAgent={open.agent} /> : null}
          {state && welcome.active ? <Welcome state={state} api={welcome} setTourFocus={setTourFocus} showTown={() => { setSel(null); go('town'); }} /> : null}
          {state && !welcome.active ? <><Tips state={state} view={view} openAgent={open.agent} focusProject={(id) => { go('town'); open.project(id); }} /><ArrivalToasts state={state} openAgent={open.agent} /><MedalToasts state={state} openProject={open.project} /></> : null}
        </main>
        {state && ((firstLaunch && !welcome.active) || modal === 'town') ? <TownPicker state={state} onDone={() => setModal(null)} /> : null}
        {state && modal === 'settings' ? <Settings state={state} onClose={() => setModal(null)} onSaved={() => { setModal(null); setSavedAt(Date.now()); }} renameTown={() => setModal('town')} prefs={{ voice, setVoice, bubble, setBubble, showLots, setShowLots }} replayWelcome={() => { setModal(null); setSel(null); welcome.replay(); }} /> : null}
        {savedAt ? <SavedToast key={savedAt} message="Settings saved" onDone={() => setSavedAt(null)} /> : null}
        {state && modal === 'share' ? <ShareSheet state={state} onClose={() => setModal(null)} /> : null}
        {t && voice === 'plain' && view !== 'town' ? <div className="sr">{bricks(t.bricksToday)}</div> : null}
      </div>
    </VoiceContext.Provider>
  );
}
