import { useEffect, useRef, useState } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { CityScene } from './scene.ts';
import { frameState, recordTimelapse, dayRange, type Replay } from './timelapse.ts';
import { isoDate, post, useDay } from '../useLogbook.ts';
import { PROJECT, useVoice } from '../copy.ts';
import { BumpToasts } from './BumpToasts.tsx';

export function CityView({ state, selected, onSelect, onAgent, onGraveyard, focus, showLots, dark, onShare }: {
  state: StateView; selected: string | null; onSelect: (id: string | null) => void; onAgent: (sessionId: string) => void; onGraveyard: () => void;
  focus: { sessions: Set<string> | null; projects: Set<string> | null; sessionProjects: Set<string> }; showLots: boolean; dark: boolean; onShare: () => void;
}) {
  const voice = useVoice();
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<CityScene | null>(null);
  const cb = useRef({ onSelect, onAgent, onGraveyard });
  cb.current = { onSelect, onAgent, onGraveyard };
  const day = useDay(isoDate(), state.generatedAt);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [busy, setBusy] = useState<'preview' | 'record' | 'skyline' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const s = new CityScene(host.current!, labels.current!, { onSelect: (id) => cb.current.onSelect(id), onAgent: (id) => cb.current.onAgent(id), onGraveyard: () => cb.current.onGraveyard() });
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, []);
  useEffect(() => { scene.current?.setTheme(dark); if (!busy) scene.current?.setState(state, showLots); }, [dark]);
  useEffect(() => { if (!busy) scene.current?.setState(state, showLots); }, [state, showLots, busy]);
  useEffect(() => { scene.current?.setSelected(selected); }, [selected]);
  useEffect(() => { scene.current?.setFocus(focus.sessions, focus.projects, focus.sessionProjects); }, [focus]);

  const stop = () => { abort.current?.abort(); };
  const preview = () => {
    if (!day || !scene.current) return;
    const [from, to] = dayRange(day);
    const ctrl = new AbortController(); abort.current = ctrl;
    setBusy('preview');
    const t0 = performance.now(), dur = 20_000;
    const loop = () => {
      if (ctrl.signal.aborted || !scene.current) { setBusy(null); setReplay(null); return; }
      const p = Math.min(1, (performance.now() - t0) / dur);
      const t = from + p * (to - from);
      scene.current.setState(frameState(state, day, t), true);
      setReplay({ from, to, t });
      if (p < 1) setTimeout(loop, 120); else { setBusy(null); setReplay(null); }
    };
    loop();
  };
  const record = async () => {
    if (!day || !scene.current) return;
    const ctrl = new AbortController(); abort.current = ctrl;
    setBusy('record'); setMsg(null);
    try {
      const { blob, ext } = await recordTimelapse(scene.current, state, day, { seconds: 20, onFrame: setReplay, signal: ctrl.signal });
      if (!ctrl.signal.aborted) {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${state.town.name.replace(/\W+/g, '-')}-${isoDate()}.${ext}`; a.click();
        setMsg(`Saved a 20-second ${ext.toUpperCase()} to your Downloads.`);
      }
    } catch (e: any) { setMsg(`Recording failed: ${e?.message ?? e}`); }
    setBusy(null); setReplay(null);
  };
  const skyline = async () => {
    if (!scene.current) return;
    setBusy('skyline'); setMsg(null);
    scene.current.fit();
    await new Promise((r) => setTimeout(r, 400));
    const png = scene.current.snapshot();
    const a = document.createElement('a'); a.href = png; a.download = 'logbook-skyline.png'; a.click();
    const r = await post('/api/skyline', { png, push: !!state.settings.skylineRepo });
    setMsg(r.pushed ? 'Skyline updated in your profile repo and pushed. Add ![My agent town](logbook-skyline.png) to your README once.'
      : r.error ? r.error : 'Saved the skyline image. Set your profile repo in Settings to update your README automatically.');
    setBusy(null);
  };

  return (
    <div className="city">
      <div className="city-canvas" ref={host} />
      <div className="city-labels" ref={labels} />
      <BumpToasts state={state} onAgent={onAgent} offset={!!replay} />
      {replay ? (
        <div className="replay-clock" aria-live="off">
          <b>{new Date(replay.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
          <span>{busy === 'record' ? 'Recording time-lapse…' : 'Replaying today'}</span>
          <div className="replay-bar"><i style={{ width: `${((replay.t - replay.from) / (replay.to - replay.from)) * 100}%` }} /></div>
          <button className="ghost small" onClick={stop}>Stop</button>
        </div>
      ) : null}
      <div className="city-actions">
        <button className="btn dark" onClick={onShare}>Share</button>
        <button className="ghost" onClick={preview} disabled={!!busy || !day?.lanes.length}>Replay today</button>
        <button className="ghost" onClick={record} disabled={!!busy || !day?.lanes.length}>Export time-lapse</button>
        <button className="ghost" onClick={skyline} disabled={!!busy}>README skyline</button>
        {msg ? <span className="action-msg" role="status">{msg}</span> : null}
      </div>
      <div className="city-tools">
        <button className="tool" onClick={() => scene.current?.zoomBy(1.25)} aria-label="Zoom in">+</button>
        <button className="tool" onClick={() => scene.current?.zoomBy(0.8)} aria-label="Zoom out">−</button>
        <button className="tool" onClick={() => scene.current?.rotateBy(-90)} aria-label="Turn the town left (Q)" title="Turn left (Q) · or right-drag / shift-drag to spin">⟲</button>
        <button className="tool" onClick={() => scene.current?.rotateBy(90)} aria-label="Turn the town right (E)" title="Turn right (E) · or right-drag / shift-drag to spin">⟳</button>
        <button className="tool" onClick={() => scene.current?.fit()} aria-label="Fit whole town">⤢</button>
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
