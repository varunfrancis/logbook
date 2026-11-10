import type { Db, Row } from './db.ts';
import { askClaude } from './naming.ts';
import { isApiError } from './transcripts.ts';

/*
 * What a job did, in words anyone can read. The agent's own last message is written for a programmer
 * ("Merged as PR #98, CI green, kickstarted the daemon…"). Once a turn has settled, the small model rewrites it
 * as one or two plain sentences. Plain voice shows that; Technical keeps the agent's words.
 */

/** Only recent work gets a plain line: older jobs keep the agent's own words rather than spending runs on them. */
const RECENT_MS = 2 * 24 * 3600_000;
/** A turn counts as settled once the agent has been quiet this long, so a summary isn't written mid-reply. */
const SETTLED_MS = 20_000;
let running = false;

/** The model's reply → a plain line, or null when it's unusable. */
export function parsePlainReply(raw: string | null): string | null {
  let text = raw?.trim().replace(/^(summary|answer)\s*:\s*/i, '').replace(/\s+/g, ' ').trim() ?? '';
  // drop quotes only when they wrap the whole reply, so a line that starts with a quoted button name keeps its quote
  const wrap = text.match(/^(["'`])(.*)\1$/);
  if (wrap && !wrap[2].includes(wrap[1])) text = wrap[2].trim();
  if (!text || text.length > 280 || /^(sorry|i can(no|')t|i'm unable)/i.test(text)) return null;
  return text;
}

/** Writes the plain line for one settled job whose newest message hasn't been rewritten yet. Returns true when one was written. */
export async function plainNextOutcome(db: Db, now = Date.now()): Promise<boolean> {
  if (running) return false;
  const s = db.prepare(`SELECT id, ai_title, first_prompt, outcome FROM sessions
    WHERE outcome IS NOT NULL AND current_action IS NULL AND last_event_at > ? AND last_event_at < ?
      AND (plain_for IS NULL OR plain_for != outcome)
    ORDER BY last_event_at DESC LIMIT 1`).get(now - RECENT_MS, now - SETTLED_MS) as Row | undefined;
  if (!s) return false;
  const mark = db.prepare('UPDATE sessions SET plain_for = ?, plain_outcome = ? WHERE id = ?');
  // Short messages and Claude Code's own error lines aren't worth a run.
  if (isApiError(s.outcome) || String(s.outcome).trim().split(/\s+/).length < 6) { mark.run(s.outcome, null, s.id); return false; }
  running = true;
  try {
    const prompt = [
      'An AI coding agent just finished a piece of work. Rewrite its last message for someone who has never written code.',
      s.ai_title || s.first_prompt ? `The job: ${clip(s.ai_title || s.first_prompt, 160)}` : '',
      `The agent's last message:\n${clip(s.outcome, 1200)}`,
      '',
      'Write one or two short sentences (at most 30 words) saying what changed, as the person would notice it, and whether anything is waiting on them.',
      'No pull request numbers, file names, commands, code, version numbers or tool names (no PR, CI, daemon, repo, branch, commit).',
      'If the message ends by asking the person something, end with that question in plain words.',
      'Reply with ONLY the sentences.',
    ].filter(Boolean).join('\n');
    const line = parsePlainReply(await askClaude(prompt));
    mark.run(s.outcome, line, s.id);
    return !!line;
  } finally {
    running = false;
  }
}

const clip = (t: string, n: number) => { const x = String(t).replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
