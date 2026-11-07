import { useState } from 'react';
import type { StateView } from '../../daemon/types.ts';
import { post } from './useLogbook.ts';

/** First launch: name your town. Also used from Settings to rename it. */
export function TownPicker({ state, onDone }: { state: StateView; onDone: () => void }) {
  const [pick, setPick] = useState(state.town.name);
  const [custom, setCustom] = useState('');
  const name = custom.trim() || pick;
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="town-title">
      <form className="modal town" onSubmit={async (e) => { e.preventDefault(); await post('/api/settings', { town: name }); onDone(); }}>
        <h2 id="town-title">Name your town</h2>
        <p className="muted">Every project you work on is a building here, and your agents are the crew. What should we call the place?</p>
        <div className="town-options">
          {state.town.suggestions.map((s) => (
            <label key={s} className={`town-opt${!custom && pick === s ? ' on' : ''}`}>
              <input type="radio" name="town" checked={!custom && pick === s} onChange={() => { setPick(s); setCustom(''); }} />{s}
            </label>
          ))}
        </div>
        <label htmlFor="town-custom" className="field-label">Or write your own</label>
        <input id="town-custom" className="field" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Shipwright Bay" maxLength={40} />
        <div className="row end"><button className="btn dark" type="submit">Welcome to {name}</button></div>
      </form>
    </div>
  );
}

export function Settings({ state, onClose, renameTown }: { state: StateView; onClose: () => void; renameTown: () => void }) {
  const [repo, setRepo] = useState(state.settings.skylineRepo ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => { e.preventDefault(); await post('/api/settings', { skylineRepo: repo || null }); setSaved(true); }}>
        <h2 id="settings-title">Settings</h2>
        <div className="setting"><div><b>Town name</b><div className="muted">{state.town.name}</div></div><button type="button" className="ghost" onClick={renameTown}>Rename</button></div>
        <div className="setting col">
          <label htmlFor="skyline-repo"><b>Skyline for your GitHub profile</b></label>
          <div className="muted">A local clone of your profile README repo (the one named after your username). "Update README skyline" saves the picture there, commits it and pushes.</div>
          <input id="skyline-repo" className="field" value={repo} onChange={(e) => { setRepo(e.target.value); setSaved(false); }} placeholder="/Users/you/Work/your-username" />
        </div>
        <div className="setting"><div><b>VS Code helper</b><div className="muted">{state.settings.vscodeConnected ? 'Connected. "Go to" opens the right terminal.' : 'Not connected. Run `node bin/logbook.ts vscode` once, then reload VS Code.'}</div></div></div>
        <div className="row end">{saved ? <span className="muted">Saved</span> : null}<button type="button" className="ghost" onClick={onClose}>Close</button><button className="btn dark" type="submit">Save</button></div>
      </form>
    </div>
  );
}
