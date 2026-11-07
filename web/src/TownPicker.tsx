import { useState } from 'react';
import type { StateView } from '../../daemon/types.ts';
import { post } from './useLogbook.ts';
import type { Voice } from './copy.ts';

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

export type Prefs = {
  voice: Voice; setVoice: (v: Voice) => void;
  bubble: 'project' | 'task'; setBubble: (b: 'project' | 'task') => void;
  showLots: boolean; setShowLots: (b: boolean) => void;
};

function Seg<T extends string>({ label, value, set, options }: { label: string; value: T; set: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="seg-toggle" role="group" aria-label={label}>
      {options.map(([v, text]) => <button type="button" key={v} className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => set(v)}>{text}</button>)}
    </div>
  );
}

export function Settings({ state, onClose, renameTown, prefs }: { state: StateView; onClose: () => void; renameTown: () => void; prefs: Prefs }) {
  const [repo, setRepo] = useState(state.settings.skylineRepo ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => { e.preventDefault(); await post('/api/settings', { skylineRepo: repo || null }); setSaved(true); }}>
        <h2 id="settings-title">Settings</h2>
        <div className="setting"><div><b>Language</b><div className="muted">Plain talks in bricks and buildings; Technical shows tokens and tool calls.</div></div>
          <Seg label="Language" value={prefs.voice} set={prefs.setVoice} options={[['plain', 'Plain'], ['technical', 'Technical']]} /></div>
        <div className="setting"><div><b>Agent bubbles</b><div className="muted">What the bubble over each agent in Town says: the project they're on, or the task they're doing right now.</div></div>
          <Seg label="Agent bubbles" value={prefs.bubble} set={prefs.setBubble} options={[['project', 'Project'], ['task', 'Task']]} /></div>
        <div className="setting"><div><b>For-sale lots</b><div className="muted">Empty plots for projects Logbook knows about but hasn't seen any work on yet.</div></div>
          <label className="toggle"><input type="checkbox" id="show-lots" checked={prefs.showLots} onChange={(e) => prefs.setShowLots(e.target.checked)} /> Show</label></div>
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
