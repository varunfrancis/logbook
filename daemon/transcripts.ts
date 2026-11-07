import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import { describeTool, type ActionKind } from './describe.ts';
import { ensureProjectForCwd, touchProject } from './projects.ts';
import { PROJECTS_DIR } from './config.ts';

export type Delta = {
  sessionId: string | null;
  cwd: string | null;
  branch: string | null;
  first: number | null;
  last: number | null;
  tokIn: number; tokOut: number; tokCR: number; tokCW: number;
  model: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  prompts: number;
  outcome: string | null;
  action: { text: string; kind: ActionKind } | null;
  turnEnded: boolean | null; // true when the last assistant message ended the turn
  commits: number;
  tools: number;
  prUrl: string | null;
  cost: { usd: number; added: number; removed: number } | null;
  lastMsgId: string | null;
};

const PR_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return '';
}

/** Normalizes a typed user prompt; returns null for system-generated messages. */
export function cleanPrompt(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const cmd = t.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return `/${cmd[1].trim()}${args ? ' ' + args : ''}`;
  }
  if (/^(<local-command|<system-reminder|<task-notification|<bash-|Caveat:|\[Request interrupted)/.test(t)) return null;
  return t.replace(/\[Image #\d+\]/g, '').replace(/\s+/g, ' ').trim() || null;
}

/** Pure: folds transcript lines into a delta. `lastMsgId` dedupes streamed copies of one assistant message. */
export function parseLines(lines: string[], lastMsgId: string | null = null): Delta {
  const d: Delta = {
    sessionId: null, cwd: null, branch: null, first: null, last: null,
    tokIn: 0, tokOut: 0, tokCR: 0, tokCW: 0, model: null, aiTitle: null,
    firstPrompt: null, lastPrompt: null, prompts: 0, outcome: null, action: null, turnEnded: null,
    commits: 0, tools: 0, prUrl: null, cost: null, lastMsgId,
  };
  let prPending = false;
  for (const line of lines) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.sessionId) d.sessionId ??= r.sessionId;
    if (r.cwd) d.cwd = r.cwd;
    if (r.gitBranch && r.gitBranch !== 'HEAD') d.branch = r.gitBranch;
    if (r.timestamp) {
      const ts = Date.parse(r.timestamp);
      if (!Number.isNaN(ts)) { d.first ??= ts; d.last = Math.max(d.last ?? 0, ts); }
    }
    switch (r.type) {
      case 'ai-title':
        if (r.aiTitle) d.aiTitle = r.aiTitle;
        break;
      case 'cost-state':
        d.cost = { usd: r.totalCostUSD ?? 0, added: r.totalLinesAdded ?? 0, removed: r.totalLinesRemoved ?? 0 };
        break;
      case 'user': {
        const c = r.message?.content;
        if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) {
          if (prPending) {
            const m = JSON.stringify(c).match(PR_RE);
            if (m) d.prUrl = m[0];
            prPending = false;
          }
          break;
        }
        if (r.isMeta || r.isSidechain) break;
        const p = cleanPrompt(textOf(c));
        if (p) { d.firstPrompt ??= p; d.lastPrompt = p; d.prompts++; d.turnEnded = false; }
        break;
      }
      case 'assistant': {
        const msg = r.message;
        if (!msg) break;
        if (msg.id && msg.id !== d.lastMsgId) {
          const u = msg.usage || {};
          d.tokIn += u.input_tokens || 0;
          d.tokOut += u.output_tokens || 0;
          d.tokCR += u.cache_read_input_tokens || 0;
          d.tokCW += u.cache_creation_input_tokens || 0;
          d.lastMsgId = msg.id;
        }
        if (msg.model && !msg.model.startsWith('<')) d.model = msg.model;
        for (const b of msg.content || []) {
          if (b?.type === 'tool_use') {
            d.tools++;
            d.action = describeTool(b.name, b.input);
            const cmd = b.name === 'Bash' ? String(b.input?.command ?? '') : '';
            if (/\bgit\s+commit\b/.test(cmd)) d.commits++;
            if (/\bgh\s+pr\s+create\b/.test(cmd)) prPending = true;
            d.turnEnded = false;
          } else if (b?.type === 'text' && b.text?.trim()) {
            d.outcome = b.text.trim().slice(0, 700);
          }
        }
        if (msg.stop_reason === 'end_turn') { d.turnEnded = true; d.action = null; }
        break;
      }
    }
  }
  return d;
}

/** Writes a delta into the sessions table (incrementing counters, keeping latest values). */
export function applyDelta(db: Db, d: Delta, transcript: string) {
  if (!d.sessionId) return;
  let s = db.prepare('SELECT id, project_id FROM sessions WHERE id = ?').get(d.sessionId) as Row | undefined;
  if (!s) {
    db.prepare('INSERT INTO sessions(id, transcript) VALUES(?, ?)').run(d.sessionId, transcript);
    s = { id: d.sessionId, project_id: null };
  }
  if (!s.project_id && d.cwd) {
    const { projectId, worktree } = ensureProjectForCwd(db, d.cwd);
    db.prepare('UPDATE sessions SET project_id = ?, worktree = ?, cwd = ? WHERE id = ?').run(projectId, worktree, d.cwd, d.sessionId);
    s.project_id = projectId;
  }
  db.prepare(`UPDATE sessions SET
      transcript = COALESCE(transcript, ?),
      branch = COALESCE(?, branch),
      started_at = COALESCE(started_at, ?),
      last_event_at = MAX(COALESCE(last_event_at, 0), COALESCE(?, 0)),
      tok_in = tok_in + ?, tok_out = tok_out + ?, tok_cache_read = tok_cache_read + ?, tok_cache_write = tok_cache_write + ?,
      model = COALESCE(?, model),
      ai_title = COALESCE(?, ai_title),
      first_prompt = COALESCE(first_prompt, ?),
      last_prompt = COALESCE(?, last_prompt),
      prompts = prompts + ?,
      outcome = COALESCE(?, outcome),
      current_action = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE current_action END,
      action_kind = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE action_kind END,
      commits = commits + ?, tools = tools + ?,
      pr_url = COALESCE(?, pr_url),
      cost_usd = COALESCE(?, cost_usd), lines_added = COALESCE(?, lines_added), lines_removed = COALESCE(?, lines_removed)
    WHERE id = ?`).run(
    transcript, d.branch, d.first, d.last,
    d.tokIn, d.tokOut, d.tokCR, d.tokCW, d.model, d.aiTitle, d.firstPrompt, d.lastPrompt, d.prompts, d.outcome,
    d.action ? 1 : 0, d.action?.text ?? null, d.turnEnded ? 1 : 0,
    d.action ? 1 : 0, d.action?.kind ?? null, d.turnEnded ? 1 : 0,
    d.commits, d.tools, d.prUrl,
    d.cost?.usd ?? null, d.cost?.added ?? null, d.cost?.removed ?? null,
    d.sessionId,
  );
  if (s.project_id && d.last) touchProject(db, s.project_id, d.last);
}

/** Subagent transcripts only add tokens and "a helper is active" timestamps to their parent. */
function applySubagent(db: Db, parentId: string, d: Delta) {
  db.prepare('UPDATE sessions SET tok_sub = tok_sub + ?, subagent_at = MAX(COALESCE(subagent_at, 0), COALESCE(?, 0)) WHERE id = ?')
    .run(d.tokIn + d.tokOut + d.tokCW, d.last, parentId);
}

const CHUNK = 8 * 1024 * 1024;

/** Reads new bytes of one transcript since the stored offset. Returns true when anything changed. */
export function ingestFile(db: Db, file: string): boolean {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return false; }
  const off = db.prepare('SELECT offset, last_msg FROM offsets WHERE path = ?').get(file) as Row | undefined;
  let offset = off?.offset ?? 0;
  if (stat.size < offset) offset = 0; // truncated or rewritten
  if (stat.size === offset) return false;
  const fd = fs.openSync(file, 'r');
  let lastMsg: string | null = off?.last_msg ?? null;
  const subMatch = file.match(/\/([0-9a-f-]{36})\/subagents\/[^/]+\.jsonl$/);
  try {
    let carry: Buffer = Buffer.alloc(0);
    const fileSession = path.basename(file, '.jsonl');
    while (offset < stat.size) {
      const len = Math.min(CHUNK, stat.size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      offset += len;
      const all = carry.length ? Buffer.concat([carry, buf]) : buf;
      const nl = all.lastIndexOf(0x0a);
      if (nl === -1) { carry = all; continue; }
      const lines = all.subarray(0, nl).toString('utf8').split('\n');
      carry = Buffer.from(all.subarray(nl + 1));
      const d = parseLines(lines, lastMsg);
      lastMsg = d.lastMsgId;
      if (subMatch) applySubagent(db, subMatch[1], d);
      else { d.sessionId = fileSession; applyDelta(db, d, file); }
    }
    // Don't consume a trailing partial line; re-read it next time.
    offset -= carry.length;
  } finally {
    fs.closeSync(fd);
  }
  db.prepare('INSERT INTO offsets(path, offset, last_msg) VALUES(?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, last_msg = excluded.last_msg')
    .run(file, offset, lastMsg);
  return true;
}

/** Lists every transcript (and subagent transcript) under ~/.claude/projects. */
export function listTranscripts(dir = PROJECTS_DIR): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  let projects: string[] = [];
  try { projects = fs.readdirSync(dir); } catch { return out; }
  for (const p of projects) {
    const pdir = path.join(dir, p);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(pdir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { out.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
      } else if (e.isDirectory()) {
        const sub = path.join(full, 'subagents');
        let subs: string[] = [];
        try { subs = fs.readdirSync(sub); } catch { continue; }
        for (const s of subs) if (s.endsWith('.jsonl')) {
          try { out.push({ file: path.join(sub, s), mtime: fs.statSync(path.join(sub, s)).mtimeMs }); } catch {}
        }
      }
    }
  }
  return out;
}

const seenMtime = new Map<string, number>();

/** One scan pass: ingests only files whose mtime moved. Main transcripts before subagents so parents exist. */
export function scanTranscripts(db: Db): number {
  const files = listTranscripts().filter((f) => seenMtime.get(f.file) !== f.mtime);
  files.sort((a, b) => Number(a.file.includes('/subagents/')) - Number(b.file.includes('/subagents/')) || a.mtime - b.mtime);
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const f of files) {
      if (ingestFile(db, f.file)) changed++;
      seenMtime.set(f.file, f.mtime);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return changed;
}
