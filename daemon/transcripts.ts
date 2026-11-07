import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import { describeTool, type ActionKind } from './describe.ts';
import { ensureProjectForCwd, touchProject } from './projects.ts';
import { DATA_DIR, isOwnRun, OWN_PROMPT, PROJECTS_DIR } from './config.ts';

/** Parser state carried across incremental reads of one transcript (persisted in offsets.state). */
export type ParseState = {
  lastMsgId: string | null;
  workStart: number | null; // a turn is in progress since…
  lastEnd: number | null; // last turn ended at…
  ask: { id: string; ts: number; q: string } | null; // AskUserQuestion waiting for an answer
  tests: Record<string, number>; // tool_use id -> ts, for test commands awaiting results
  prPending: string | null; // tool_use id of a `gh pr create`
  tools: Record<string, string>; // tool_use id -> short label (for error signatures)
};
export const freshState = (): ParseState => ({ lastMsgId: null, workStart: null, lastEnd: null, ask: null, tests: {}, prPending: null, tools: {} });

export type Moment = { ts: number; kind: 'm_prompt' | 'm_ask' | 'm_test_ok' | 'm_test_fail' | 'm_error' | 'm_commit' | 'm_pr' | 'm_done'; text: string };
export type Segment = { start: number; end: number; kind: 'work' | 'wait' | 'idle' };

export type Delta = {
  sessionId: string | null;
  entrypoint: string | null; // cli · sdk-cli (headless `claude -p`, e.g. a cron job) · claude-desktop …
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
  /** A background job's closing status line: undefined = no change, null = cleared by a new message. See jobVerdict. */
  verdict?: JobVerdict | null;
  action: { text: string; kind: ActionKind } | null;
  turnEnded: boolean | null;
  commits: number;
  tools: number;
  edits: number; reads: number; webs: number; asks: number;
  files: { p: string; t: number }[];
  errors: { sig: string; t: number }[];
  testsOk: number; testsFail: number; lastTest: { t: number; ok: boolean } | null;
  prUrl: string | null;
  cost: { usd: number; added: number; removed: number } | null;
  moments: Moment[];
  segments: Segment[];
  state: ParseState;
};

export type JobVerdict = 'result' | 'failed' | 'needs';
/** Background jobs end their report with a `result:`, `failed:` or `needs input:` line. The last one in a reply wins. */
export function jobVerdict(text: string | null | undefined): JobVerdict | null {
  const all = [...String(text ?? '').matchAll(/^\s*(result|failed|needs input):/gim)];
  const w = all.at(-1)?.[1].toLowerCase();
  return w === 'result' ? 'result' : w === 'failed' ? 'failed' : w ? 'needs' : null;
}

const PR_RE = /https:\/\/github\.com\/[^/\s"\\]+\/[^/\s"\\]+\/pull\/\d+/;
const TEST_RE = /\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|vitest|jest|pytest|py\.test|go test|cargo test|rspec|mocha|playwright test|phpunit|node --test|make test|tox)\b/;

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

/** A short, stable fingerprint of an error so repeats of "the same problem" can be counted. */
export function errorSig(label: string, text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => /error|fail|exception|cannot|not found|denied|refused|traceback/i.test(l)) ?? text.split('\n')[0] ?? '';
  return `${label}: ${line.replace(/\d+/g, '#').replace(/(["'`]).*?\1/g, '…').replace(/\s+/g, ' ').slice(0, 90)}`.trim();
}

/** Pure: folds transcript lines into a delta, carrying parser state between calls. */
export function parseLines(lines: string[], prev: ParseState | string | null = null): Delta {
  const st: ParseState = typeof prev === 'object' && prev ? structuredClone(prev) : { ...freshState(), lastMsgId: (prev as string) ?? null };
  const d: Delta = {
    sessionId: null, entrypoint: null, cwd: null, branch: null, first: null, last: null,
    tokIn: 0, tokOut: 0, tokCR: 0, tokCW: 0, model: null, aiTitle: null,
    firstPrompt: null, lastPrompt: null, prompts: 0, outcome: null, action: null, turnEnded: null,
    commits: 0, tools: 0, edits: 0, reads: 0, webs: 0, asks: 0, files: [], errors: [],
    testsOk: 0, testsFail: 0, lastTest: null, prUrl: null, cost: null, moments: [], segments: [], state: st,
  };
  const endWork = (ts: number) => {
    if (st.workStart && ts > st.workStart) d.segments.push({ start: st.workStart, end: ts, kind: 'work' });
    st.workStart = null; st.lastEnd = ts;
  };
  for (const line of lines) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.sessionId) d.sessionId ??= r.sessionId;
    if (r.entrypoint) d.entrypoint ??= r.entrypoint;
    if (r.cwd) d.cwd = r.cwd;
    if (r.gitBranch && r.gitBranch !== 'HEAD') d.branch = r.gitBranch;
    let ts = 0;
    if (r.timestamp) {
      ts = Date.parse(r.timestamp);
      if (!Number.isNaN(ts)) { d.first ??= ts; d.last = Math.max(d.last ?? 0, ts); } else ts = 0;
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
          for (const b of c) {
            if (b?.type !== 'tool_result') continue;
            const id = b.tool_use_id as string;
            const body = typeof b.content === 'string' ? b.content : textOf(b.content) || JSON.stringify(b.content ?? '');
            const isErr = b.is_error === true;
            if (st.prPending && id === st.prPending) {
              const m = body.match(PR_RE);
              if (m) { d.prUrl = m[0]; if (ts) d.moments.push({ ts, kind: 'm_pr', text: m[0] }); }
              st.prPending = null;
            }
            if (id in st.tests) {
              const ok = !isErr && !/\b(\d+ (failed|failing)|FAIL\b|failures?:\s*[1-9])/.test(body);
              ok ? d.testsOk++ : d.testsFail++;
              if (ts) { d.lastTest = { t: ts, ok }; d.moments.push({ ts, kind: ok ? 'm_test_ok' : 'm_test_fail', text: ok ? 'Checks passed' : 'Checks failed' }); }
              delete st.tests[id];
            }
            if (st.ask && id === st.ask.id) {
              if (ts > st.ask.ts) d.segments.push({ start: st.ask.ts, end: ts, kind: 'wait' });
              st.ask = null;
            }
            if (isErr && ts && !/user (rejected|denied|doesn't want)|interrupted/i.test(body)) {
              const sig = errorSig(st.tools[id] ?? 'tool', body);
              d.errors.push({ sig, t: ts });
            }
            delete st.tools[id];
          }
          break;
        }
        if (r.isMeta || r.isSidechain) break;
        const p = cleanPrompt(textOf(c));
        if (p) {
          d.firstPrompt ??= p; d.lastPrompt = p; d.prompts++; d.turnEnded = false; d.verdict = null;
          if (ts) {
            if (st.lastEnd && !st.workStart && ts > st.lastEnd) d.segments.push({ start: st.lastEnd, end: ts, kind: 'idle' });
            if (st.workStart) endWork(ts); // interrupted turn
            st.workStart = ts; st.lastEnd = null;
            d.moments.push({ ts, kind: 'm_prompt', text: p.slice(0, 300) });
          }
        }
        break;
      }
      case 'assistant': {
        const msg = r.message;
        if (!msg) break;
        if (msg.id && msg.id !== st.lastMsgId) {
          const u = msg.usage || {};
          d.tokIn += u.input_tokens || 0;
          d.tokOut += u.output_tokens || 0;
          d.tokCR += u.cache_read_input_tokens || 0;
          d.tokCW += u.cache_creation_input_tokens || 0;
          st.lastMsgId = msg.id;
        }
        if (ts && !st.workStart) st.workStart = ts; // work we didn't see start (e.g. resumed)
        if (msg.model && !msg.model.startsWith('<')) d.model = msg.model;
        for (const b of msg.content || []) {
          if (b?.type === 'tool_use') {
            d.tools++;
            const a = describeTool(b.name, b.input);
            d.action = a;
            st.tools[b.id] = b.name === 'Bash' ? `Bash ${String(b.input?.command ?? '').split(/\s+/).slice(0, 2).join(' ')}` : b.name;
            const cmd = b.name === 'Bash' ? String(b.input?.command ?? '') : '';
            if (a.kind === 'edit') {
              d.edits++;
              const fp = b.input?.file_path || b.input?.notebook_path;
              if (fp && ts) d.files.push({ p: String(fp), t: ts });
            } else if (a.kind === 'read') d.reads++;
            else if (a.kind === 'web') d.webs++;
            if (/\bgit\s+commit\b/.test(cmd)) { d.commits++; if (ts) d.moments.push({ ts, kind: 'm_commit', text: 'Saved progress' }); }
            if (/\bgh\s+pr\s+create\b/.test(cmd)) st.prPending = b.id;
            if (TEST_RE.test(cmd)) st.tests[b.id] = ts;
            if (b.name === 'AskUserQuestion') {
              d.asks++;
              const q = String(b.input?.questions?.[0]?.question ?? 'a question');
              if (ts) { st.ask = { id: b.id, ts, q }; d.moments.push({ ts, kind: 'm_ask', text: q.slice(0, 300) }); }
            }
            d.turnEnded = false;
          } else if (b?.type === 'text' && b.text?.trim()) {
            d.outcome = b.text.trim().slice(0, 1500);
            d.verdict = jobVerdict(b.text);
          }
        }
        if (msg.stop_reason === 'end_turn') {
          d.turnEnded = true; d.action = null;
          if (ts) endWork(ts);
        }
        break;
      }
    }
  }
  d.state = st;
  return d;
}

const JSON_FILES_CAP = 40;
const ownSessions = new Set<string>();

/**
 * Removes Logbook's own small-model runs that were recorded as work before they could be recognized
 * (e.g. from a test install whose folder is gone), and any project they left behind with nothing else in it.
 */
export function purgeOwnRuns(db: Db): number {
  const ids = (db.prepare('SELECT id, first_prompt FROM sessions WHERE first_prompt IS NOT NULL').all() as Row[]).filter((r) => OWN_PROMPT.test(r.first_prompt)).map((r) => r.id);
  // Bare session starts from a naming folder (a test copy's hook fired, nothing was ever said or read).
  for (const r of db.prepare(`SELECT id, cwd FROM sessions WHERE transcript IS NULL AND COALESCE(prompts, 0) = 0 AND COALESCE(tok_in, 0) + COALESCE(tok_out, 0) = 0 AND cwd IS NOT NULL`).all() as Row[]) {
    if (/\/\.?(logbook-)?namer$/.test(r.cwd)) ids.push(r.id);
  }
  for (const id of ids) {
    ownSessions.add(id);
    for (const t of ['events', 'segments']) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
  // A project whose folder is a Logbook naming folder and that has no other sessions.
  const empty = db.prepare(`SELECT id, root FROM projects p WHERE root IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = p.id)`).all() as Row[];
  for (const p of empty) if (/\/\.?(logbook-)?namer$/.test(p.root)) db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  return ids.length;
}

/** Writes a delta into the sessions table (incrementing counters, keeping latest values). */
export function applyDelta(db: Db, d: Delta, transcript: string) {
  if (!d.sessionId) return;
  if (isOwnRun(d.cwd)) return; // Logbook's own helper runs
  // ...wherever they ran: a test copy's folder may be gone by now, but the request still starts the same way
  if (ownSessions.has(d.sessionId)) return;
  if (d.firstPrompt && OWN_PROMPT.test(d.firstPrompt)) { ownSessions.add(d.sessionId); db.prepare('DELETE FROM sessions WHERE id = ?').run(d.sessionId); return; }
  let s = db.prepare('SELECT id, project_id, files, err_sig, err_count, err_at FROM sessions WHERE id = ?').get(d.sessionId) as Row | undefined;
  if (!s) {
    db.prepare('INSERT INTO sessions(id, transcript) VALUES(?, ?)').run(d.sessionId, transcript);
    s = { id: d.sessionId, project_id: null, files: null, err_sig: null, err_count: 0, err_at: null };
  }
  if (!s.project_id && d.cwd) {
    const { projectId, worktree } = ensureProjectForCwd(db, d.cwd);
    db.prepare('UPDATE sessions SET project_id = ?, worktree = ?, cwd = ? WHERE id = ?').run(projectId, worktree, d.cwd, d.sessionId);
    s.project_id = projectId;
  }
  // recent files (most recent last, unique, capped)
  let files: { p: string; t: number }[] = s.files ? JSON.parse(s.files) : [];
  if (d.files.length) {
    for (const f of d.files) { files = files.filter((x) => x.p !== f.p); files.push(f); }
    files = files.slice(-JSON_FILES_CAP);
  }
  // "same problem again" streak: same signature within 20 minutes keeps counting
  let errSig: string | null = s.err_sig, errCount: number = s.err_count || 0, errAt: number | null = s.err_at;
  for (const e of d.errors) {
    if (e.sig === errSig && errAt && e.t - errAt < 20 * 60_000) errCount++;
    else { errSig = e.sig; errCount = 1; }
    errAt = e.t;
  }
  if (d.lastTest?.ok && errCount) { errCount = 0; } // a passing check clears "stuck"
  db.prepare(`UPDATE sessions SET
      transcript = COALESCE(transcript, ?),
      entrypoint = COALESCE(entrypoint, ?),
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
      job_verdict = CASE WHEN ? = 1 THEN ? ELSE job_verdict END,
      current_action = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE current_action END,
      action_kind = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE action_kind END,
      commits = commits + ?, tools = tools + ?, edits = edits + ?, reads = reads + ?, webs = webs + ?, asks = asks + ?,
      tests_ok = tests_ok + ?, tests_fail = tests_fail + ?,
      test_at = COALESCE(?, test_at), test_ok = COALESCE(?, test_ok),
      files = ?, err_sig = ?, err_count = ?, err_at = ?,
      pr_url = COALESCE(?, pr_url),
      cost_usd = COALESCE(?, cost_usd), lines_added = COALESCE(?, lines_added), lines_removed = COALESCE(?, lines_removed)
    WHERE id = ?`).run(
    transcript, d.entrypoint, d.branch, d.first, d.last,
    d.tokIn, d.tokOut, d.tokCR, d.tokCW, d.model, d.aiTitle, d.firstPrompt, d.lastPrompt, d.prompts, d.outcome,
    d.verdict !== undefined ? 1 : 0, d.verdict ?? '', // '' = read, no verdict; NULL = never read
    d.action ? 1 : 0, d.action?.text ?? null, d.turnEnded ? 1 : 0,
    d.action ? 1 : 0, d.action?.kind ?? null, d.turnEnded ? 1 : 0,
    d.commits, d.tools, d.edits, d.reads, d.webs, d.asks, d.testsOk, d.testsFail,
    d.lastTest?.t ?? null, d.lastTest ? (d.lastTest.ok ? 1 : 0) : null,
    files.length ? JSON.stringify(files) : null, errSig, errCount, errAt,
    d.prUrl,
    d.cost?.usd ?? null, d.cost?.added ?? null, d.cost?.removed ?? null,
    d.sessionId,
  );
  const seg = db.prepare('INSERT INTO segments(session_id, start, end, kind) VALUES(?, ?, ?, ?)');
  for (const g of d.segments) seg.run(d.sessionId, g.start, g.end, g.kind);
  const ev = db.prepare('INSERT OR IGNORE INTO events(session_id, ts, kind, text) VALUES(?, ?, ?, ?)');
  for (const m of d.moments) ev.run(d.sessionId, m.ts, m.kind, m.text);
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
  const off = db.prepare('SELECT offset, last_msg, state FROM offsets WHERE path = ?').get(file) as Row | undefined;
  let offset = off?.offset ?? 0;
  let state: ParseState = off?.state ? JSON.parse(off.state) : { ...freshState(), lastMsgId: off?.last_msg ?? null };
  if (stat.size < offset) { offset = 0; state = freshState(); }
  if (stat.size === offset) return false;
  const fd = fs.openSync(file, 'r');
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
      const d = parseLines(lines, state);
      state = d.state;
      if (subMatch) applySubagent(db, subMatch[1], d);
      else { d.sessionId = fileSession; applyDelta(db, d, file); }
    }
    offset -= carry.length;
  } finally {
    fs.closeSync(fd);
  }
  db.prepare('INSERT INTO offsets(path, offset, last_msg, state) VALUES(?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, last_msg = excluded.last_msg, state = excluded.state')
    .run(file, offset, state.lastMsgId, JSON.stringify({ ...state, tools: {} }));
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
/** Files read so far vs. found, for the first-run "Setting up your town" screen. */
export const scanProgress = { read: 0, total: 0 };

export function scanTranscripts(db: Db, deadline = Infinity): number {
  const files = listTranscripts().filter((f) => seenMtime.get(f.file) !== f.mtime);
  files.sort((a, b) => Number(a.file.includes('/subagents/')) - Number(b.file.includes('/subagents/')) || a.mtime - b.mtime);
  if (!scanProgress.total) scanProgress.total = files.length;
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const f of files) {
      if (Date.now() > deadline) break; // the rest is picked up on the next call
      if (ingestFile(db, f.file)) changed++;
      seenMtime.set(f.file, f.mtime);
      scanProgress.read++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return changed;
}

/** Transcripts not read yet (changed since last read). */
export const transcriptsLeft = () => listTranscripts().filter((f) => seenMtime.get(f.file) !== f.mtime).length;
