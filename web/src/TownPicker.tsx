import { useState } from 'react';
import type { StateView } from '../../daemon/types.ts';
import { post } from './useSwarmville.ts';
import { setChime, setMusic, setVoices, useSound } from './audio.ts';
import type { Bubble, Voice } from './copy.ts';

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
  bubble: Bubble; setBubble: (b: Bubble) => void;
  showLots: boolean; setShowLots: (b: boolean) => void;
};

function Seg<T extends string>({ label, value, set, options }: { label: string; value: T; set: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="seg-toggle" role="group" aria-label={label}>
      {options.map(([v, text]) => <button type="button" key={v} className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => set(v)}>{text}</button>)}
    </div>
  );
}

export function Settings({ state, onClose, onSaved, renameTown, prefs, replayWelcome }: { state: StateView; onClose: () => void; onSaved: () => void; renameTown: () => void; prefs: Prefs; replayWelcome: () => void }) {
  const [intros, setIntros] = useState(state.settings.terminalIntros);
  const sound = useSound();
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSaved(); }}>
        <h2 id="settings-title">Settings</h2>
        <div className="setting"><div><b>Language</b><div className="muted">Plain talks in bricks and buildings; Technical shows tokens and tool calls.</div></div>
          <Seg label="Language" value={prefs.voice} set={prefs.setVoice} options={[['plain', 'Plain'], ['technical', 'Technical']]} /></div>
        <div className="setting"><div><b>Agent bubbles</b><div className="muted">What the bubble over each agent in Town says: the job they're on (“Extend the offer”), the project, or the step they're on right now.</div></div>
          <Seg label="Agent bubbles" value={prefs.bubble} set={prefs.setBubble} options={[['job', 'Job'], ['project', 'Project'], ['task', 'Step']]} /></div>
        <div className="setting"><div><b>For-sale lots</b><div className="muted">Empty plots for projects Swarmville knows about but hasn't seen any work on yet.</div></div>
          <label className="toggle"><input type="checkbox" id="show-lots" checked={prefs.showLots} onChange={(e) => prefs.setShowLots(e.target.checked)} /> Show</label></div>
        <div className="setting"><div><b>Town name</b><div className="muted">{state.town.name}</div></div><button type="button" className="ghost" onClick={renameTown}>Rename</button></div>
        <div className="setting"><div><b>Background music</b><div className="muted">A slow, calm loop that plays on every tab. It starts after your first click.</div></div><label className="toggle"><input type="checkbox" checked={sound.music} onChange={(e) => setMusic(e.target.checked)} /> {sound.music ? 'On' : 'Off'}</label></div>
        <div className="setting"><div><b>Crew voices</b><div className="muted">Agents say their introductions out loud on the welcome tour, each in their own voice. Uses your computer's built-in voices.</div></div><label className="toggle"><input type="checkbox" checked={sound.voices} onChange={(e) => setVoices(e.target.checked)} /> {sound.voices ? 'On' : 'Off'}</label></div>
        <div className="setting"><div><b>Heads-up chime</b><div className="muted">A soft ding on the Town when two agents start changing the same file.</div></div><label className="toggle"><input type="checkbox" checked={sound.chime} onChange={(e) => setChime(e.target.checked)} /> {sound.chime ? 'On' : 'Off'}</label></div>
        <div className="setting"><div><b>Agents say hi in the terminal</b><div className="muted">New Claude Code sessions open with their name and where to find them in {state.town.name}, so the terminal and the town match.</div></div><label className="toggle"><input type="checkbox" id="terminal-intros" checked={intros} onChange={(e) => { setIntros(e.target.checked); post('/api/settings', { terminalIntros: e.target.checked }); }} /> {intros ? 'On' : 'Off'}</label></div>
        <div className="setting"><div><b>Welcome tour</b><div className="muted">Meet the crew again and see how the town works. About two minutes.</div></div><button type="button" className="ghost" onClick={replayWelcome}>Replay the welcome</button></div>
        <div className="setting"><div><b>VS Code helper</b><div className="muted">{state.settings.vscodeConnected ? 'Connected. "Go to" opens the right terminal.' : 'Not connected. Run `~/.swarmville/bin/swarmville vscode` (or `node bin/swarmville.ts vscode` in a developer copy) once, then restart VS Code.'}</div></div></div>
        <div className="row end"><button className="btn dark" type="submit">Done</button></div>
      </form>
    </div>
  );
}
