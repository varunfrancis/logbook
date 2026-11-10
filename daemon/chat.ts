import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.ts';
import { describeTool } from './describe.ts';
import { cleanPrompt } from './transcripts.ts';
import type { ChatLine } from './types.ts';

/*
 * The conversation with an agent you started in a terminal, read from its Claude Code transcript, so its drawer can open
 * on the chat just like an agent Swarmville runs. Same lines as the runner's log: what you said, what they said, and
 * their tool calls in plain words.
 */

/** What you typed, as you typed it (newlines kept); null for messages Claude Code writes itself. */
function yourText(raw: string): string | null {
  const plain = cleanPrompt(raw);
  if (!plain) return null;
  if (plain.startsWith('/') && /<command-name>/.test(raw)) return plain; // a slash command: show it as typed
  return raw.replace(/\[Image #\d+\]/g, '').trim() || null;
}

const at = (e: any) => { const t = Date.parse(e?.timestamp ?? ''); return Number.isFinite(t) ? t : 0; };

/** Pure: transcript lines → chat lines, oldest first. */
export function chatFromTranscript(lines: string[], limit = 300): ChatLine[] {
  const out: ChatLine[] = [];
  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue;
    let e: any;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.isSidechain || e.isMeta || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const content = e.message?.content;
    if (e.type === 'user') {
      if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) continue; // a tool's output, not you
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
      const images = Array.isArray(content) ? content.filter((b: any) => b?.type === 'image').length : 0;
      const said = yourText(text);
      if (said || images) out.push({ at: at(e), kind: 'you', text: said ?? '', ...(images ? { images } : {}) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) {
        const prev = out.at(-1);
        // one reply can arrive as several lines (one per block): keep it as one message
        if (prev?.kind === 'them' && prev.id === e.message?.id && prev.id) prev.text += '\n\n' + String(b.text).trim();
        else out.push({ at: at(e), kind: 'them', text: String(b.text).trim(), id: e.message?.id });
      } else if (b?.type === 'tool_use') {
        const d = describeTool(String(b.name ?? ''), b.input ?? {});
        out.push({ at: at(e), kind: 'tool', text: d.text, tool: d.kind });
      }
    }
  }
  for (const l of out) delete l.id;
  return out.slice(-limit);
}

const found = new Map<string, string>();
/** The transcript file, even if Claude Code moved it since we noted it (a session that switched into a worktree changes project folder). */
export function transcriptFile(stored: string | null | undefined, sessionId: string, projectsDir = PROJECTS_DIR): string | null {
  if (stored && fs.existsSync(stored)) return stored;
  const hit = found.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) { found.set(sessionId, f); return f; }
    }
  } catch {}
  return null;
}

const TAIL = 4 * 1024 * 1024; // long sessions: the last few MB hold the recent conversation
const cache = new Map<string, { key: string; lines: ChatLine[] }>();

/** The chat from a transcript file, re-read only when the file changes. */
export function transcriptChat(file: string | null | undefined, limit = 300): ChatLine[] {
  if (!file) return [];
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return []; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.lines;
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, st.size - TAIL);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const lines = chatFromTranscript(text.split('\n'), limit);
  if (cache.size > 50) cache.clear();
  cache.set(file, { key, lines });
  return lines;
}

/** One conversation from both places: the transcript for what came before Swarmville ran them, then the runner's log. */
export function mergeChat(fromTranscript: ChatLine[], fromRunner: ChatLine[], limit = 300): ChatLine[] {
  if (!fromRunner.length) return fromTranscript.slice(-limit);
  const first = fromRunner[0].at;
  return [...fromTranscript.filter((l) => l.at && l.at < first), ...fromRunner].slice(-limit);
}
