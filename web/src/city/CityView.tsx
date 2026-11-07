import { useEffect, useRef } from 'react';
import type { StateView } from '../../../daemon/types.ts';
import { CityScene } from './scene.ts';

export function CityView({ state, selected, onSelect, showLots, dark }: {
  state: StateView; selected: string | null; onSelect: (id: string | null) => void; showLots: boolean; dark: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<CityScene | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const s = new CityScene(host.current!, labels.current!, { onSelect: (id) => onSelectRef.current(id) });
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, []);
  useEffect(() => { scene.current?.setTheme(dark); scene.current?.setState(state, showLots); }, [dark]);
  useEffect(() => { scene.current?.setState(state, showLots); }, [state, showLots]);
  useEffect(() => { scene.current?.setSelected(selected); }, [selected]);

  return (
    <div className="city">
      <div className="city-canvas" ref={host} />
      <div className="city-labels" ref={labels} />
      <div className="city-tools">
        <button className="tool" onClick={() => scene.current?.zoomBy(1.25)} aria-label="Zoom in">+</button>
        <button className="tool" onClick={() => scene.current?.zoomBy(0.8)} aria-label="Zoom out">−</button>
        <button className="tool" onClick={() => scene.current?.fit()} aria-label="Fit whole city">⤢</button>
      </div>
      <div className="legend">
        <span><i className="p-build" />Building</span>
        <span><i className="p-needs" />Needs you</span>
        <span><i className="p-done" />Complete</span>
        <span><i className="p-quiet" />Quiet 30d+</span>
        <span><i className="p-lot" />GitHub only</span>
      </div>
    </div>
  );
}
