import { useSyncExternalStore } from 'react';

/*
 * Sound for the town, made live with Web Audio (no audio files):
 *  - a slow, warm lo-fi loop (soft pad chords, a round bass note, sparse plucked melody with an echo)
 *  - a gentle two-note chime used as an FYI (e.g. two agents bumping into each other)
 * Browsers only allow sound after the first click or key press, so everything waits for that.
 * Music keeps playing when the browser tab is in the background, and carries on through a reload:
 * the song position is kept in sessionStorage, and if the browser lets the reloaded page play sound
 * (Chrome does once you've clicked the page before), it picks up where it was instead of waiting for a click.
 */

type Prefs = { music: boolean; chime: boolean; voices: boolean };
const KEY = 'logbook.sound';
const read = (): Prefs => {
  try { return { music: true, chime: true, voices: true, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { music: true, chime: true, voices: true }; }
};
let prefs = read();
const subs = new Set<() => void>();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} subs.forEach((f) => f()); };

export function setMusic(on: boolean) { prefs = { ...prefs, music: on }; save(); sync(); }
export function setChime(on: boolean) { prefs = { ...prefs, chime: on }; save(); }
/** Agents speak their introductions out loud (welcome tour). */
export function setVoices(on: boolean) { prefs = { ...prefs, voices: on }; save(); }
export const voicesOn = () => prefs.voices;
export function useSound() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => prefs);
}

// ---------- engine ----------
let ctx: AudioContext | null = null;
let musicBus: GainNode, fxIn: GainNode, out: DynamicsCompressorNode;
let timer: ReturnType<typeof setInterval> | null = null;
let nextTime = 0, step = 0;
let unlocked = false;

const BPM = 68;
const EIGHTH = 60 / BPM / 2;
const STEPS_PER_CHORD = 16; // two bars of eighths
const MUSIC_LEVEL = 0.55;
// Fmaj7 → Em7 → Dm7 → Cmaj7, voiced low and close; the bass plays the root an octave below.
const CHORDS = [
  { pad: [53, 57, 60, 64], bass: 41 },
  { pad: [52, 55, 59, 62], bass: 40 },
  { pad: [50, 53, 57, 60], bass: 38 },
  { pad: [48, 52, 55, 59], bass: 36 },
];
const SCALE = [72, 74, 76, 79, 81, 84, 86]; // C major pentatonic, upper register
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  out = ctx.createDynamicsCompressor();
  out.threshold.value = -18; out.ratio.value = 3; out.connect(ctx.destination);
  musicBus = ctx.createGain(); musicBus.gain.value = 0; musicBus.connect(out);
  // A soft echo the plucks are sent into.
  fxIn = ctx.createGain(); fxIn.gain.value = 1;
  const delay = ctx.createDelay(2); delay.delayTime.value = EIGHTH * 3;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 1800;
  const wet = ctx.createGain(); wet.gain.value = 0.35;
  fxIn.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(wet); wet.connect(musicBus);
  return ctx;
}

function pad(notes: number[], t: number, dur: number, attack = 1.8) {
  const c = ctx!;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 850; lp.Q.value = 0.3;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + attack);
  g.gain.setValueAtTime(1, t + dur - 0.2);
  g.gain.linearRampToValueAtTime(0, t + dur + 1.6); // overlaps into the next chord
  lp.connect(g); g.connect(musicBus);
  for (const n of notes) for (const detune of [-6, 6]) {
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = hz(n); o.detune.value = detune;
    const v = c.createGain(); v.gain.value = 0.028;
    o.connect(v); v.connect(lp); o.start(t); o.stop(t + dur + 1.7);
  }
}

function bass(m: number, t: number) {
  const c = ctx!;
  const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = hz(m);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.2, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + EIGHTH * 5);
  o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + EIGHTH * 5 + 0.05);
}

function pluck(m: number, t: number, level = 0.09) {
  const c = ctx!;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3200, t); lp.frequency.exponentialRampToValueAtTime(900, t + 0.6);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0008, t + 1.5);
  for (const [type, mult, lvl] of [['triangle', 1, 1], ['sine', 2, 0.25]] as const) {
    const o = c.createOscillator(); o.type = type; o.frequency.value = hz(m) * mult;
    const v = c.createGain(); v.gain.value = lvl; o.connect(v); v.connect(lp); o.start(t); o.stop(t + 1.6);
  }
  lp.connect(g); g.connect(musicBus); g.connect(fxIn);
}

let lastNote = 3;
function schedule() {
  const c = ctx!;
  if (nextTime < c.currentTime) nextTime = c.currentTime + 0.05;
  // Background tabs get their timers slowed (to ~1/s or less), so queue notes further ahead there.
  const ahead = document.hidden ? 4 : 1.2;
  while (nextTime < c.currentTime + ahead) {
    const chord = CHORDS[Math.floor(step / STEPS_PER_CHORD) % CHORDS.length];
    const s = step % STEPS_PER_CHORD;
    if (s === 0) pad(chord.pad, nextTime, EIGHTH * STEPS_PER_CHORD);
    if (s === 0 || s === 8 || (s === 14 && Math.random() < 0.4)) bass(chord.bass, nextTime);
    // Sparse melody: mostly on the beat, small steps from the last note, resting often.
    const onBeat = s % 2 === 0;
    if (Math.random() < (onBeat ? 0.32 : 0.12)) {
      lastNote = Math.max(0, Math.min(SCALE.length - 1, lastNote + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]));
      const swing = onBeat ? 0 : EIGHTH * 0.12;
      pluck(SCALE[lastNote], nextTime + swing, onBeat ? 0.09 : 0.06);
    }
    nextTime += EIGHTH; step++;
  }
  savePos();
}

// ---------- carrying on through a reload ----------
const POS_KEY = 'logbook.musicPos';
type Pos = { step: number; lastNote: number; at: number }; // `at`: wall-clock ms when `step` plays
function savePos() {
  if (!ctx || !timer) return;
  const pos: Pos = { step, lastNote, at: Date.now() + (nextTime - ctx.currentTime) * 1000 };
  try { sessionStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
}
function clearPos() { try { sessionStorage.removeItem(POS_KEY); } catch {} }
/** Where the song was before this page loaded, if it was playing in this tab moments ago. */
function savedPos(): Pos | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null') as Pos | null;
    return p && Date.now() - p.at < 10 * 60_000 ? p : null;
  } catch { return null; }
}
let resumeFrom = typeof window !== 'undefined' ? savedPos() : null;

let ducked = false;
/** Turns the music down while someone is speaking, and back up after. */
export function duckMusic(on: boolean) {
  ducked = on;
  if (ctx && timer) { musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setTargetAtTime(on ? MUSIC_LEVEL * 0.25 : MUSIC_LEVEL, ctx.currentTime, on ? 0.15 : 0.9); }
}

/** Starts or stops the loop to match the setting and whether sound is allowed yet. Plays on in background tabs. */
function sync() {
  const want = prefs.music && unlocked;
  if (want) {
    const c = ensure(); if (!c) return;
    c.resume().catch(() => {});
    let fade = 0.8;
    if (!timer) {
      step = 0; nextTime = c.currentTime + 0.1;
      if (resumeFrom) {
        // Pick the song up where it would be now, and bring in the chord already underway.
        step = resumeFrom.step + Math.max(0, Math.ceil((Date.now() - resumeFrom.at) / 1000 / EIGHTH));
        lastNote = resumeFrom.lastNote;
        const left = STEPS_PER_CHORD - (step % STEPS_PER_CHORD);
        if (left < STEPS_PER_CHORD) pad(CHORDS[Math.floor(step / STEPS_PER_CHORD) % CHORDS.length].pad, nextTime, left * EIGHTH, 0.4);
        resumeFrom = null; fade = 0.3;
      }
      schedule(); timer = setInterval(schedule, 250);
    }
    musicBus.gain.cancelScheduledValues(c.currentTime);
    musicBus.gain.setTargetAtTime(ducked ? MUSIC_LEVEL * 0.25 : MUSIC_LEVEL, c.currentTime, fade);
  } else if (ctx && timer) {
    musicBus.gain.cancelScheduledValues(ctx.currentTime);
    musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    clearInterval(timer); timer = null; // already-scheduled notes fade out under the bus
    clearPos();
  }
}

/** A soft two-note "ding-dong" for low-key heads-ups. Silent until the page has been clicked once. */
export function chime() {
  if (!prefs.chime || !unlocked) return;
  const c = ensure(); if (!c) return;
  c.resume().catch(() => {});
  const t0 = c.currentTime + 0.02;
  [[88, 0], [83, 0.16]].forEach(([m, dt]) => { // E6 then B5
    const t = t0 + dt;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0008, t + 1.1);
    g.connect(out);
    for (const [mult, lvl] of [[1, 1], [2.01, 0.12]]) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = hz(m) * mult;
      const v = c.createGain(); v.gain.value = lvl; o.connect(v); v.connect(g); o.start(t); o.stop(t + 1.2);
    }
  });
}

if (typeof window !== 'undefined') {
  const unlock = () => {
    unlocked = true;
    ensure()?.resume().catch(() => {});
    sync();
    removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true);
  };
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', unlock, true);
  // Reloaded while the music was playing: start straight away if the browser allows sound without a new click.
  if (prefs.music && resumeFrom) {
    const c = ensure();
    c?.resume().then(() => { if (c.state === 'running' && !unlocked) unlock(); }).catch(() => {});
  }
  addEventListener('pagehide', savePos);
  // Chrome keeps "you've clicked this page" across a reload the page itself starts, but not across one started by the
  // browser (⌘R / Ctrl+R / F5), so sound would be blocked again. While music is playing, do those reloads from the page.
  addEventListener('keydown', (e) => {
    const reloadKey = e.key === 'F5' || ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r');
    if (reloadKey && timer && !e.defaultPrevented) { e.preventDefault(); savePos(); location.reload(); }
  });
  // Some browsers suspend the audio context in the background; nudge it back (and top up the queue) on any visibility change.
  document.addEventListener('visibilitychange', () => { sync(); if (ctx && timer) schedule(); });
}
