import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionView, StateView, WelcomeStep } from '../../../daemon/types.ts';
import type { Intro } from '../../../daemon/intros.ts';
import { AgentAvatar, FOREMAN, type Mood } from '../crew/Avatar.tsx';
import { post } from '../useSwarmville.ts';
import { setVoices, useSound } from '../audio.ts';
import { canSpeak, hush, speak, type Speaker } from '../crew/voice.ts';
import { TownPicker } from '../TownPicker.tsx';
import { StartWork, type Started } from './StartWork.tsx';
import { WELCOME_MOVES } from './moves.ts';

/*
 * The welcome tour, for someone who has just installed Swarmville:
 * setting up → name your town → Pip says hello → the crew introduce themselves → four signs → where to look
 * → start your first job → it opens in Claude Code → watch your agent walk in.
 * One decision per screen, every screen skippable, and Settings → "Replay the welcome" brings it back.
 */

export const STEPS: WelcomeStep[] = ['setup', 'name', 'reveal', 'rollcall', 'signs', 'tabs', 'turn', 'handoff', 'arrival'];
const WEEK = 7 * 24 * 3600_000;
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where the tour is, saved on this machine's Swarmville so it survives reloads and can be resumed. */
export function useWelcome(state: StateView | null) {
  const w = state?.settings.welcome;
  const [local, setLocal] = useState<{ step: WelcomeStep | null; active: boolean } | null>(null);
  const saved = !!w && !w.done && !w.skipped; // still on the tour, as far as the server knows
  const active = local ? local.active : saved;
  const first: WelcomeStep = !state ? 'setup' : state.setup.phase !== 'ready' ? 'setup' : !state.town.chosen ? 'name' : 'reveal';
  const step: WelcomeStep = (local?.step ?? w?.step ?? first);
  const go = useCallback((s: WelcomeStep) => { setLocal({ step: s, active: true }); post('/api/settings', { welcome: { step: s } }); }, []);
  const skip = useCallback((at: WelcomeStep) => { setLocal({ step: at, active: false }); post('/api/settings', { welcome: { skipped: at, step: at } }); }, []);
  const finish = useCallback(() => { setLocal({ step: null, active: false }); post('/api/settings', { welcome: { done: true, step: null, skipped: null } }); }, []);
  const replay = useCallback(() => { setLocal({ step: 'reveal', active: true }); post('/api/settings', { welcome: { done: false, skipped: null, step: 'reveal' } }); }, []);
  // A skipped tour can be finished from the header for a week.
  const resumable = !active && !!w?.skipped && !w.done && Date.now() - w.skipped.at < WEEK ? w.skipped.step : null;
  const resume = useCallback(() => { if (!resumable) return; const at = resumable === 'setup' || resumable === 'name' ? 'reveal' : resumable; setLocal({ step: at, active: true }); post('/api/settings', { welcome: { skipped: null, step: at } }); }, [resumable]);
  const left = resumable ? STEPS.length - STEPS.indexOf(resumable) : 0;
  return { active: !!state && active, step, go, skip, finish, replay, resumable, resume, left };
}
export type WelcomeApi = ReturnType<typeof useWelcome>;

/**
 * Text that types itself out. With a speaker, the line is also said out loud in that character's voice and the typing
 * follows the words as they're spoken; if the browser can't speak (muted, no voices, page not clicked yet) it just types.
 */
function useTypewriter(text: string, speaker: Speaker | null, cps = 48) {
  const [n, setN] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const stop = useRef<() => void>(() => {});
  useEffect(() => {
    setN(0);
    let mode: 'wait' | 'type' | 'speech' | 'done' = speaker ? 'wait' : 'type';
    let t0 = performance.now(), said = 0, speechCps = 15;
    const tick = () => {
      const now = performance.now();
      let k = 0;
      if (mode === 'done' || (mode === 'type' && reduced())) k = text.length;
      // by elapsed time, so a busy frame (the 3D town is drawing) skips ahead instead of slowing the text down
      else if (mode === 'type') k = Math.floor(((now - t0) * cps) / 1000);
      else if (mode === 'speech') {
        const est = Math.floor(((now - t0) * speechCps) / 1000);
        k = said ? Math.max(said, Math.min(est, said + 10)) : est; // stay on the word being said
      }
      setN(Math.min(text.length, k));
    };
    const id = setInterval(tick, 30);
    const sp = speaker ? speak(text, speaker, {
      onStart: (c) => { mode = 'speech'; t0 = performance.now(); speechCps = c; setSpeaking(true); },
      onWord: (end) => { said = Math.max(said, end); },
      onEnd: () => { mode = 'done'; setSpeaking(false); },
      onFail: () => { setSpeaking(false); if (mode !== 'done') { mode = 'type'; t0 = performance.now(); } },
    }) : null;
    stop.current = () => { sp?.cancel(); mode = 'done'; setSpeaking(false); setN(text.length); };
    return () => { clearInterval(id); sp?.cancel(); };
  }, [text, speaker?.key]);
  return { shown: text.slice(0, n), done: n >= text.length && !speaking, finish: () => stop.current() };
}

/** Spoken text: types itself out (and says it out loud), readable all at once by screen readers, click to finish. */
function Said({ text, speaker = null, onDone }: { text: string; speaker?: Speaker | null; onDone?: (done: boolean) => void }) {
  const t = useTypewriter(text, speaker);
  useEffect(() => { onDone?.(t.done); }, [t.done]);
  return (
    <p className="said" onClick={t.finish} title={t.done ? undefined : 'Click to skip ahead'}>
      <span className="sr">{text}</span>
      <span aria-hidden="true">{t.shown}<span className="said-rest">{text.slice(t.shown.length)}</span></span>
    </p>
  );
}

/** Turn the crew's voices on or off. */
function VoiceToggle() {
  const sound = useSound();
  if (!canSpeak()) return null;
  return (
    <button type="button" className="voice-toggle" aria-pressed={sound.voices} onClick={() => { if (sound.voices) hush(); setVoices(!sound.voices); }}
      title={sound.voices ? 'Voices on. Click to mute.' : 'Voices off. Click to hear the crew.'} aria-label={sound.voices ? 'Mute voices' : 'Turn voices on'}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
        {sound.voices ? <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
          : <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}</svg>
    </button>
  );
}

const PIP_VOICE: Speaker = { key: 'foreman', shape: 'pebble' };

/** Pip, the foreman, in the corner of the town with something to say. */
function Pip({ text, children, wide, extra }: { text: string; children?: React.ReactNode; wide?: boolean; extra?: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <div className={`wel-pip${wide ? ' wide' : ''}`} role="dialog" aria-label="Pip, the foreman">
      <div className="wel-bubble">
        <VoiceToggle />
        <Said key={text} text={text} speaker={PIP_VOICE} onDone={setDone} />
        {extra}
        {children ? <div className="wel-actions">{children}</div> : null}
      </div>
      <div className="wel-pip-av"><AgentAvatar agent={FOREMAN} mood="hello" size={104} live talking={!done} /></div>
    </div>
  );
}

const SkipTour = ({ onSkip, label = 'Skip the tour' }: { onSkip: () => void; label?: string }) => <button type="button" className="linkish" onClick={onSkip}>{label}</button>;

export function Welcome({ state, api, setTourFocus, showTown }: { state: StateView; api: WelcomeApi; setTourFocus: (id: string | null) => void; showTown: () => void }) {
  const { step, go, skip, finish } = api;
  const [started, setStarted] = useState<Started | null>(null);
  const hasHistory = state.projects.some((p) => p.sessionsTotal > 0);
  useEffect(() => { if (step !== 'setup' && step !== 'name' && step !== 'tabs') showTown(); }, [step]);
  useEffect(() => { if (step !== 'rollcall' && step !== 'signs' && step !== 'arrival') setTourFocus(null); }, [step]);
  useEffect(() => () => setTourFocus(null), []);

  if (step === 'setup') return <SettingUp state={state} onReady={() => go(state.town.chosen ? 'reveal' : 'name')} />;
  if (step === 'name') return state.town.chosen ? <Advance to={() => go('reveal')} /> : <TownPicker state={state} onDone={() => go('reveal')} />;
  if (step === 'reveal') {
    if (!hasHistory) return (
      <>
        <div className="wel-hiring" aria-hidden="true"><div className="sign">Now hiring<small>Start Claude Code in any project</small></div><i className="post" /></div>
        <Pip text={`Welcome to ${state.town.name}! I'm Pip, the foreman. It's quiet for now: every project you work on with Claude Code becomes a building here, and each Claude session is one of your crew. Let's hire your first one.`}>
          <SkipTour onSkip={() => skip('reveal')} label="Later" /><button className="btn dark" onClick={() => go('turn')}>Start my first job</button>
        </Pip>
      </>
    );
    const n = state.projects.filter((p) => p.sessionsTotal > 0).length;
    return (
      <Pip text={`Welcome to ${state.town.name}! I'm Pip, the foreman. Each of these ${n} buildings is a project you've worked on, and the little folks are your Claude Code agents. Want to meet them?`}>
        <button type="button" className="ghost" onClick={() => skip('reveal')}>I'll look around</button>
        <button type="button" className="btn dark" onClick={() => go('rollcall')}>Meet the crew</button>
      </Pip>
    );
  }
  if (step === 'rollcall') return <RollCall state={state} setTourFocus={setTourFocus} onDone={() => go('signs')} onSkip={() => skip('rollcall')} />;
  if (step === 'signs') return <Signs state={state} setTourFocus={setTourFocus} onDone={() => go('tabs')} onSkip={() => skip('signs')} />;
  if (step === 'tabs') return <TabsCoach onDone={() => go('turn')} onSkip={() => skip('tabs')} />;
  if (step === 'turn') return (
    <div className="wel-card turn" role="dialog" aria-labelledby="turn-title">
      <div className="wel-head"><AgentAvatar agent={FOREMAN} mood="hello" size={56} live /><div><h3 id="turn-title">Want to give someone a job?</h3><p className="muted">Pick a project and how you'd like to start. Planning first is a good habit: nothing gets built until you say so.</p></div></div>
      <StartWork state={state} moves={WELCOME_MOVES} defaultMove="plan" idPrefix="wel" onStarted={(r) => { setStarted(r); go('handoff'); }} secondary={<SkipTour onSkip={finish} label="Maybe later" />} />
    </div>
  );
  if (step === 'handoff') return <Handoff state={state} started={started} onNext={() => go('arrival')} />;
  if (step === 'arrival') return <Arrival state={state} started={started} setTourFocus={setTourFocus} onDone={finish} />;
  return null;
}

function Advance({ to }: { to: () => void }) { useEffect(() => { to(); }, []); return null; }

// ---------- 1. setting up ----------

function SettingUp({ state, onReady }: { state: StateView; onReady: () => void }) {
  const s = state.setup;
  const ready = s.phase === 'ready';
  useEffect(() => { if (ready) { const t = setTimeout(onReady, 1300); return () => clearTimeout(t); } }, [ready]);
  const pct = s.phase === 'reading' ? (s.total ? Math.min(0.85, (s.read / s.total) * 0.85) : 0.05) : s.phase === 'naming' ? 0.92 : 1;
  const row = (done: boolean, text: string) => <li className={done ? 'done' : 'wait'}><i aria-hidden="true">{done ? '✓' : ''}</i>{text}</li>;
  return (
    <div className="wel-setup" role="status" aria-live="polite">
      <div className="wel-setup-in">
        <AgentAvatar agent={FOREMAN} mood="hello" size={88} live />
        <h2>Setting up your town</h2>
        <p className="muted">Reading the work you've already done with Claude Code.</p>
        <ul>
          {row(s.phase !== 'reading', s.phase === 'reading' ? `Reading your past work… ${s.read.toLocaleString()} of ${s.total.toLocaleString()} files` : `Read ${s.shifts.toLocaleString()} shifts of work`)}
          {row(s.projects > 0 && s.phase !== 'reading', s.projects ? `Found ${s.projects} project${s.projects === 1 ? '' : 's'} you've worked on` : 'Looking for your projects…')}
          {s.crew ? row(true, `Met ${s.crew} Claude Code agent${s.crew === 1 ? '' : 's'}, your crew`) : null}
          {s.phase !== 'reading' ? row(ready, ready ? 'Gave your buildings friendly names' : 'Giving your buildings friendly names…') : null}
        </ul>
        <div className="wel-progress" aria-hidden="true"><b style={{ width: `${Math.round(pct * 100)}%` }} /></div>
        <div className="wel-trust">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path d="M12 2.5 4.5 5.4v5.9c0 4.7 3.1 8.9 7.5 10.2 4.4-1.3 7.5-5.5 7.5-10.2V5.4z" fill="currentColor" />
            <path d="m8.4 12.2 2.5 2.5 4.8-5" fill="none" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div><b>Nothing leaves your computer</b><span>Swarmville runs only on this Mac. No account, no servers: your work stays here.</span></div>
        </div>
      </div>
    </div>
  );
}

// ---------- 4. roll call ----------

const JOB_WORD: Record<string, string> = { builder: 'Builder', plumber: 'Plumber', painter: 'Painter', librarian: 'Librarian', inspector: 'Inspector', scout: 'Scout' };

function RollCall({ state, setTourFocus, onDone, onSkip }: { state: StateView; setTourFocus: (id: string | null) => void; onDone: () => void; onSkip: () => void }) {
  const [list, setList] = useState<Intro[] | null>(null);
  const [i, setI] = useState(0);
  const [talking, setTalking] = useState(true);
  const frozen = useRef(new Map<string, string>()); // a line never changes once someone has started hearing it
  useEffect(() => {
    let n = 0, stop = false;
    const load = () => fetch('/api/intros').then((r) => r.json()).then((d: Intro[]) => {
      if (stop) return;
      // keep the first order (who's on site changes while you're reading); later loads only fill in livelier lines
      setList((prev) => (prev ? prev.map((x) => ({ ...x, line: d.find((y) => y.key === x.key)?.line ?? x.line })) : d));
      // the small model writes livelier lines in the background; pick them up for cards not shown yet
      if (d.some((x) => !x.line) && ++n < 8) setTimeout(load, 2000);
    }).catch(() => setList([]));
    load();
    return () => { stop = true; };
  }, []);
  useEffect(() => { if (list && !list.length) onDone(); }, [list]);
  const cur = list?.[i];
  useEffect(() => { if (cur) setTourFocus(cur.projectId); }, [cur?.key]);
  if (!list || !cur) return <div className="wel-card rollcall loading" aria-busy="true"><p className="muted">Gathering the crew…</p></div>;
  if (!frozen.current.has(cur.key)) frozen.current.set(cur.key, cur.line ?? cur.template);
  const text = frozen.current.get(cur.key)!;
  const last = i === list.length - 1;
  const next = () => (last ? onDone() : (setI(i + 1), setTalking(true)));
  const live = state.sessions.find((s) => s.id === cur.sessionId && s.status !== 'ended');
  return (
    <div className="wel-card rollcall" role="dialog" aria-labelledby="rc-name" onKeyDown={(e) => { if (e.key === 'ArrowRight') next(); }}>
      <VoiceToggle />
      <div className="wel-head">
        <div className="av-enter" key={cur.key}><AgentAvatar agent={cur.agent} mood="hello" size={104} live talking={talking} /></div>
        <div>
          <h3 id="rc-name">{cur.agent.name}</h3>
          <p className="muted">{JOB_WORD[cur.agent.job] ?? cur.agent.jobTitle}{cur.projectName ? ` · ${cur.projectName}` : ''}{live ? ' · on site now' : ''}</p>
        </div>
      </div>
      <div className="wel-speech"><Said key={cur.key} text={text} speaker={{ key: cur.agent.key, shape: cur.agent.shape }} onDone={(d) => setTalking(!d)} /></div>
      <div className="wel-foot">
        <button type="button" className="linkish" onClick={onDone}>Skip intros</button>
        <div className="dots" aria-label={`${i + 1} of ${list.length}`}>{list.map((x, j) => <i key={x.key} className={j === i ? 'on' : ''} />)}</div>
        <button type="button" className="btn dark" autoFocus onClick={next}>{last ? 'Show me the signs' : `Next: ${list[i + 1].agent.name}`}</button>
      </div>
      <button type="button" className="linkish wel-skip-all" onClick={onSkip}>Skip the tour</button>
    </div>
  );
}

// ---------- 5. the four signs ----------

type Sign = { id: string; title: string; body: string; mood: Mood; find: (s: StateView) => { session?: SessionView; projectId: string | null } | null };
const SIGNS: Sign[] = [
  { id: 'needs', title: 'A raised hand means they need you', body: 'They’re waiting for a yes, a no, or an answer. Click them to see what they’re asking and approve it right there. Your Mac will ping you too.', mood: 'needs',
    find: (st) => { const s = st.sessions.find((x) => x.status === 'needs_input'); return s ? { session: s, projectId: s.projectId } : null; } },
  { id: 'stuck', title: 'A rain cloud means someone’s stuck', body: 'They’ve hit the same problem again and again. A quick nudge from you usually gets them going.', mood: 'stuck',
    find: (st) => { const s = st.sessions.find((x) => x.stuck && x.status !== 'ended'); return s ? { session: s, projectId: s.projectId } : null; } },
  { id: 'ship', title: 'Fireworks mean work went live', body: 'When a change is approved and merged, the building celebrates. Quiet projects slowly turn from “under construction” to “complete”.', mood: 'shipped',
    find: (st) => { const p = st.projects.find((x) => x.justMerged || x.justShipped); const s = st.sessions.find((x) => x.stamp === 'shipped'); return p ? { projectId: p.id, session: s } : s ? { session: s, projectId: s.projectId } : null; } },
  { id: 'break', title: 'A coffee mug means they’re done for now', body: 'They finished what you asked and are on a break at the café, ready for the next job.', mood: 'break',
    find: (st) => { const s = st.sessions.find((x) => x.status === 'idle' && !x.away); return s ? { session: s, projectId: null } : null; } },
];

function Signs({ state, setTourFocus, onDone, onSkip }: { state: StateView; setTourFocus: (id: string | null) => void; onDone: () => void; onSkip: () => void }) {
  const [i, setI] = useState(0);
  const sign = SIGNS[i];
  const ex = useMemo(() => sign.find(state), [i]); // pin the example for this card
  useEffect(() => { setTourFocus(ex?.projectId ?? null); }, [i]);
  const who = ex?.session;
  const where = who ? state.projects.find((p) => p.id === who.projectId)?.name : ex?.projectId ? state.projects.find((p) => p.id === ex.projectId)?.name : null;
  const a = who?.agent ?? { ...FOREMAN, job: 'none' };
  return (
    <div className="wel-card sign" role="dialog" aria-labelledby="sign-title">
      <div className="wel-head">
        <div className="av-enter" key={sign.id}><AgentAvatar agent={a} mood={sign.mood} size={84} live /></div>
        <div><span className="eyebrow">{i + 1} of {SIGNS.length}</span><h3 id="sign-title">{sign.title}</h3></div>
      </div>
      <p>{sign.body}</p>
      {who || where ? <p className="wel-example">{who ? `Like ${who.agent.name}${where ? ` at ${where}` : ''} right now.` : `Like ${where} right now.`}</p> : null}
      <div className="wel-foot">
        {i ? <button type="button" className="ghost" onClick={() => setI(i - 1)}>Back</button> : <SkipTour onSkip={onSkip} />}
        <div className="dots" aria-hidden="true">{SIGNS.map((s, j) => <i key={s.id} className={j === i ? 'on' : ''} />)}</div>
        <button type="button" className="btn dark" autoFocus onClick={() => (i === SIGNS.length - 1 ? onDone() : setI(i + 1))}>{i === SIGNS.length - 1 ? 'Got it' : 'Next sign'}</button>
      </div>
    </div>
  );
}

// ---------- 6. where to look ----------

function TabsCoach({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = document.querySelector('.bar .tabs') as HTMLElement | null;
    if (!el) return;
    el.classList.add('tour-hl');
    const place = () => { const r = el.getBoundingClientRect(); setPos({ left: Math.max(16, Math.min(r.left, innerWidth - 376)), top: r.bottom + 12 }); };
    place(); addEventListener('resize', place);
    return () => { el.classList.remove('tour-hl'); removeEventListener('resize', place); };
  }, []);
  return (
    <div className="wel-card tabs-coach" role="dialog" aria-labelledby="tabs-title" style={pos ? { left: pos.left, top: pos.top } : undefined}>
      <i className="wel-arrow" aria-hidden="true" />
      <h3 id="tabs-title">Three ways to look</h3>
      <ul className="wel-tabs">
        <li><b>Town</b> shows where work is happening.</li>
        <li><b>Crew</b> shows who needs you. Check it first.</li>
      </ul>
      <div className="wel-foot"><SkipTour onSkip={onSkip} /><button type="button" className="btn dark" autoFocus onClick={onDone}>Got it</button></div>
    </div>
  );
}

// ---------- 8. handoff ----------

function Handoff({ state, started, onNext }: { state: StateView; started: Started | null; onNext: () => void }) {
  const [intros, setIntros] = useState(state.settings.terminalIntros);
  const [copied, setCopied] = useState(false);
  const copy = async () => { if (!started?.command) return; try { await navigator.clipboard.writeText(started.command); setCopied(true); } catch {} };
  const toggle = async (on: boolean) => { setIntros(on); await post('/api/settings', { terminalIntros: on }); };
  return (
    <div className="wel-card handoff" role="dialog" aria-labelledby="handoff-title">
      <h3 id="handoff-title">{started ? `${started.plan ? 'Planning' : 'Work'} is starting in ${started.via === 'vscode' ? 'VS Code' : 'Terminal'}` : 'Your job is starting'}</h3>
      {started ? <p className="muted">{started.message}</p> : null}
      {started?.command ? (
        <div className="wel-cmd">
          <code>{started.command}</code>
          <button type="button" className="ghost small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      ) : null}
      {started?.via === 'terminal' && !state.settings.vscodeConnected ? <p className="sw-note">Use VS Code? Restart it once and Swarmville will open agents right inside it.</p> : null}
      <label className="wel-toggle">
        <input type="checkbox" id="wel-terminal-intros" checked={intros} onChange={(e) => toggle(e.target.checked)} />
        <span className="wel-switch" aria-hidden="true" />
        <span><b>Have agents say hi in the terminal?</b><br /><span className="muted">Each agent opens with its name and where to find it in {state.town.name}, so the terminal and the town match. You can change this in Settings.</span></span>
      </label>
      <div className="wel-foot"><span /><button type="button" className="btn dark" autoFocus onClick={onNext}>Watch the town</button></div>
    </div>
  );
}

// ---------- 9. arrival ----------

function Arrival({ state, started, setTourFocus, onDone }: { state: StateView; started: Started | null; setTourFocus: (id: string | null) => void; onDone: () => void }) {
  const since = started ? started.at - 15_000 : Date.now() - 60_000;
  const arrived = state.sessions.find((s) => s.startedAt && s.startedAt >= since && s.status !== 'ended' && (!started || s.projectId === started.projectId));
  const [waited, setWaited] = useState(0);
  useEffect(() => { const t = setInterval(() => setWaited((w) => w + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { setTourFocus(arrived?.projectId ?? started?.projectId ?? null); }, [arrived?.id]);
  if (arrived) return (
    <Pip text={`That's ${arrived.agent.name}, your newest crew member, walking in at ${state.projects.find((p) => p.id === arrived.projectId)?.name ?? 'the site'}. When anyone needs you, they'll raise a hand here and your Mac will ping you. Have fun!`}>
      <button type="button" className="btn dark" onClick={onDone}>Done</button>
    </Pip>
  );
  return (
    <Pip text={started ? `Keep an eye on ${started.projectName}. As soon as Claude starts, your new crew member walks in right here.` : 'Start Claude Code in any project and your new crew member walks in right here.'}
      extra={waited > 40 ? <p className="sw-note">Nothing yet? Check the {started?.via === 'vscode' ? 'VS Code' : 'Terminal'} window that opened. If Claude asks whether to trust the folder, say yes.</p> : null}>
      <button type="button" className="ghost" onClick={onDone}>Finish the tour</button>
    </Pip>
  );
}

/** Header pill to finish a skipped tour. */
export function TourPill({ api }: { api: WelcomeApi }) {
  if (!api.resumable) return null;
  return <button type="button" className="sum chip tour-pill" onClick={api.resume}>Finish the tour <small>{api.left} step{api.left === 1 ? '' : 's'} left</small></button>;
}

