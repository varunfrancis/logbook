import { duckMusic, voicesOn } from '../audio.ts';

/*
 * Every character has a voice: the browser's own speech (on a Mac, the system voices), so it's free and stays on this computer.
 * Who you get is fixed by the character, so Juno always sounds like Juno on this machine. Rounder, smaller shapes speak a little higher.
 */

export type Speaker = { key: string; shape: string };

// System voices that are novelty effects, not people.
const NOVELTY = /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Junior|Organ|Pipe Organ|Princess|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
const PIP_PREFERRED = ['Daniel', 'Rocko', 'Reed', 'Fred', 'Google UK English Male'];
const SHAPE_PITCH: Record<string, number> = { pebble: 1.12, bean: 1.08, pear: 1, capsule: 1.04, cube: 0.86, triangle: 1.18, cloud: 1.22, acorn: 1.1, drop: 1.16, bun: 0.92 };

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

let pool: SpeechSynthesisVoice[] = [];
function loadVoices() {
  if (!canSpeak()) return;
  const all = speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
  // On-device voices first: they start instantly and report each word as it's spoken, which keeps the typing in step.
  const local = all.filter((v) => v.localService);
  pool = (local.length >= 3 ? local : all).sort((a, b) => a.name.localeCompare(b.name));
}
if (canSpeak()) { loadVoices(); speechSynthesis.addEventListener?.('voiceschanged', loadVoices); }

function voiceFor(who: Speaker): { voice: SpeechSynthesisVoice | null; pitch: number; rate: number } {
  if (!pool.length) loadVoices();
  const h = hash(who.key);
  if (who.key === 'foreman') {
    const v = PIP_PREFERRED.map((n) => pool.find((x) => x.name.startsWith(n))).find(Boolean) ?? pool[0] ?? null;
    return { voice: v, pitch: 1, rate: 1.02 };
  }
  const voice = pool.length ? pool[h % pool.length] : null;
  const pitch = Math.min(1.5, Math.max(0.7, (SHAPE_PITCH[who.shape] ?? 1) + (((h >>> 9) % 17) - 8) / 100));
  return { voice, pitch, rate: 1 + ((h >>> 14) % 9) / 100 };
}

export type Speech = { cancel: () => void };
/**
 * Says the line out loud. onWord(charEnd) fires as each word is spoken (so text can be typed in step);
 * onEnd fires when done; onFail fires if the browser won't speak (no voices, sound not allowed yet, muted).
 */
export function speak(text: string, who: Speaker, cb: { onStart?: (estCps: number) => void; onWord?: (end: number) => void; onEnd?: () => void; onFail?: () => void }): Speech {
  const activated = (navigator as any).userActivation?.hasBeenActive ?? true; // speech needs a click on the page first
  if (!canSpeak() || !voicesOn() || !activated) { cb.onFail?.(); return { cancel: () => {} }; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = voiceFor(who);
  if (v.voice) u.voice = v.voice;
  u.pitch = v.pitch; u.rate = v.rate; u.volume = 1;
  let started = false, over = false;
  const finish = (ok: boolean) => { if (over) return; over = true; clearTimeout(guard); duckMusic(false); ok ? cb.onEnd?.() : cb.onFail?.(); };
  u.onstart = () => { started = true; duckMusic(true); cb.onStart?.(14.5 * v.rate); };
  u.onboundary = (e) => { if (e.name === 'word' || e.name === undefined) cb.onWord?.(e.charIndex + (e.charLength || (text.slice(e.charIndex).match(/^\S+/)?.[0].length ?? 0))); };
  u.onend = () => finish(true);
  u.onerror = (e) => finish(e.error === 'interrupted' || e.error === 'canceled' ? true : false);
  // Browsers stay silent until you've clicked the page once; if speech hasn't started soon, just type it.
  const guard = setTimeout(() => { if (!started) { speechSynthesis.cancel(); finish(false); } }, 1500);
  speechSynthesis.speak(u);
  return { cancel: () => { if (!over) { over = true; clearTimeout(guard); duckMusic(false); speechSynthesis.cancel(); } } };
}

export function hush() { if (canSpeak()) speechSynthesis.cancel(); duckMusic(false); }
