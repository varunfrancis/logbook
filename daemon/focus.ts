import type { Db, Row } from './db.ts';
import { askClaude } from './naming.ts';

/*
 * The job an agent is on right now ("Extend the offer"). Claude Code's own session title is written once,
 * from the first message, so an agent given a second job in the same session would keep its first label.
 * After each new instruction with substance, the small model either writes a fresh 2–5 word label or says it's the same job.
 */

/** Messages that carry on the current job rather than start one: "yes, build it", "merge it", "fix all". */
export function carriesOn(prompt: string): boolean {
  const t = prompt.replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('/')) return true;
  const words = t.split(' ').filter((w) => /\w/.test(w));
  return words.length < 4;
}

/** The model's reply → a label, 'same', or null when it's unusable. */
export function parseFocusReply(raw: string | null): string | 'same' | null {
  const line = raw?.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.replace(/^(label|answer)\s*:\s*/i, '').replace(/^["'`*]+|["'`*.]+$/g, '').trim() ?? '';
  if (!line) return null;
  if (/^same$/i.test(line)) return 'same';
  const words = line.split(/\s+/);
  if (words.length > 7 || line.length > 48) return null;
  return line.replace(/^\w/, (c) => c.toUpperCase());
}

const LIVE_FOR_MS = 6 * 3600_000;
let running = false;

/** Labels one live session whose newest instruction hasn't been looked at yet. Returns true when a label changed. */
export async function labelNextFocus(db: Db, now = Date.now()): Promise<boolean> {
  if (running) return false;
  const rows = db.prepare(`SELECT id, ai_title, first_prompt, last_prompt, focus FROM sessions
    WHERE ended_at IS NULL AND last_prompt IS NOT NULL AND last_event_at > ? AND (focus_for IS NULL OR focus_for != last_prompt)
    ORDER BY last_event_at DESC LIMIT 20`).all(now - LIVE_FOR_MS) as Row[];
  const mark = db.prepare('UPDATE sessions SET focus_for = ?, focus = COALESCE(?, focus) WHERE id = ?');
  // Follow-ups never need the model: note them as seen and keep the current label.
  const s = rows.find((r) => { if (!carriesOn(r.last_prompt)) return true; mark.run(r.last_prompt, null, r.id); return false; });
  if (!s) return false;
  running = true;
  try {
    const current = s.focus || s.ai_title || null;
    const prompt = [
      'You write the label shown over an AI coding agent on a dashboard, saying which piece of work it is on.',
      current ? `Current label: ${current}` : 'There is no label yet.',
      s.first_prompt && s.first_prompt !== s.last_prompt ? `First request in this session: ${clip(s.first_prompt, 240)}` : '',
      `Newest message from the user:\n${clip(s.last_prompt, 700)}`,
      '',
      current ? 'If the newest message only approves or ships the work already under way (yes, go ahead, merge it, deploy it, thanks), reply exactly SAME.' : '',
      current ? 'If it asks for any change, fix, investigation, explanation or new feature, write a new label, even when it is related to the current one.' : '',
      'Otherwise reply with ONLY a 2-5 word label for the work the newest message asks for: sentence case, starting with a verb, no quotes, no final punctuation.',
      'Examples: Extend the offer, Fix login redirect, Move toast to bottom, Explain cost spike.',
    ].filter(Boolean).join('\n');
    const reply = parseFocusReply(await askClaude(prompt));
    if (reply == null) { mark.run(s.last_prompt, null, s.id); return false; }
    const label = reply === 'same' ? null : reply;
    mark.run(s.last_prompt, label, s.id);
    return !!label && label !== s.focus;
  } finally {
    running = false;
  }
}

const clip = (t: string, n: number) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
