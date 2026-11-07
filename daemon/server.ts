import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { CLAUDE_DIR, DATA_DIR, PORT, WEB_DIST } from './config.ts';
import { kvGet, kvSet, openDb, type Row } from './db.ts';
import { purgeOwnRuns, scanProgress, scanTranscripts, transcriptsLeft } from './transcripts.ts';
import { backfillEntrypoints } from './routines.ts';
import { consolidateProjects } from './projects.ts';
import { readLive, type LiveEntry } from './live.ts';
import { adoptLive, agentDetail, buildState, dayView, projectDetail, refreshAgents, wrappedView } from './state.ts';
import { handleHook } from './hooks.ts';
import { stopProcess, systemDeps } from './stop.ts';
import { checkPullRequests, syncGithub } from './github.ts';
import { notifyTransitions } from './notify.ts';
import { stampClosed } from './outcome.ts';
import { labelNextFocus } from './focus.ts';
import { nameNextProject, nameProjectsBatch, renameProject, setTown, summarizeNextProject } from './naming.ts';
import { intros, terminalIntro, writeIntros } from './intros.ts';
import { groupDistricts } from './districts.ts';
import { addNote, dismissFlag, noteContext, notesPending, removeNote, writePendingMarker } from './crews.ts';
import type { Setup, StateView, Welcome } from './types.ts';
import { NEW_WELCOME } from './state.ts';
import { addAsk, answerAsk, asksBySession, dropAsk, settleSession, type Decision } from './asks.ts';

const db = openDb();
let live = new Map<string, LiveEntry>();
let state!: StateView;
let stateJson = '';
let stateHash = '';
const clients = new Set<http.ServerResponse>();
const vscodeClients = new Set<http.ServerResponse>();
const setup: Setup = { phase: 'reading', read: 0, total: 0, projects: 0, shifts: 0, crew: 0 };

function refresh() {
  live = readLive();
  adoptLive(db, live);
  state = buildState(db, live, Date.now(), vscodeClients.size > 0, { ...setup, read: scanProgress.read, total: scanProgress.total });
  const asks = asksBySession();
  if (asks.size) for (const s of state.sessions) s.ask = s.status === 'needs_input' ? asks.get(s.id) ?? null : null;
  const { generatedAt, ...rest } = state;
  const hash = crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex');
  stateJson = JSON.stringify(state);
  writePendingMarker(DATA_DIR, notesPending(db, live));
  if (hash !== stateHash) {
    stateHash = hash;
    notifyTransitions(state);
    for (const c of clients) c.write(`event: state\ndata: ${stateJson}\n\n`);
  }
}

let ticking = false;
let ticks = 0;
function tick() {
  if (ticking) return;
  ticking = true;
  try {
    scanTranscripts(db);
    live = readLive();
    refreshAgents(db, ticks === 0 ? 0 : Date.now() - 2 * 24 * 3600_000, live);
    if (ticks % 150 === 149) { try { if (purgeOwnRuns(db)) soon(); } catch {} } // every ~5 minutes
    if (ticks++ % 15 === 0) { db.prepare("UPDATE sessions SET stamp = NULL WHERE stamp IS NOT NULL AND id IN (" + ([...live.keys()].map(() => '?').join(',') || "''") + ")").run(...live.keys()); stampClosed(db, new Set(live.keys()), ticks === 1 ? 400 : 25); }
    refresh();
  } catch (e) {
    console.error('[logbook] tick failed', e);
  } finally {
    ticking = false;
  }
}

let refreshTimer: NodeJS.Timeout | null = null;
const soon = () => { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 120); };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

function readBody(req: http.IncomingMessage, limit = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const readJson = async (req: http.IncomingMessage) => { try { return JSON.parse(await readBody(req)); } catch { return {}; } };

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** Brings the agent's VS Code terminal forward: the companion extension owns the terminal; without it, just focus VS Code. */
function jump(sessionId: string): { ok: boolean; via: string; message: string } {
  const e = live.get(sessionId);
  if (!e) return { ok: false, via: 'none', message: 'That agent is not running right now.' };
  let shellPid: number | null = null;
  try { shellPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(e.pid)], { encoding: 'utf8' }).trim()) || null; } catch {}
  const payload = JSON.stringify({ sessionId, pid: e.pid, shellPid, cwd: e.cwd });
  for (const c of vscodeClients) c.write(`event: jump\ndata: ${payload}\n\n`);
  if (vscodeClients.size) return { ok: true, via: 'extension', message: 'Opening its terminal in VS Code.' };
  execFile('open', ['-a', 'Visual Studio Code'], () => {});
  return { ok: true, via: 'app', message: 'Brought VS Code forward. Install the Swarmville VS Code helper to jump straight to the terminal.' };
}

/** "Clock out": the VS Code helper closes the agent's terminal tab, and the daemon makes sure Claude itself stops. */
function clockOut(sessionId: string): { ok: boolean; message: string } {
  const e = live.get(sessionId);
  const r = stopProcess(e, systemDeps);
  if (!r.ok || !e) return r;
  let shellPid: number | null = null;
  try { shellPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(e.pid)], { encoding: 'utf8' }).trim()) || null; } catch {}
  const payload = JSON.stringify({ sessionId, pid: e.pid, shellPid });
  for (const c of vscodeClients) c.write(`event: close\ndata: ${payload}\n\n`);
  setTimeout(soon, 2000);
  setTimeout(soon, 7000);
  return r;
}

/*
 * Opening a Claude conversation in a terminal in a project folder: resuming a past shift (claude --resume <id>),
 * or starting a new one from the welcome tour or an agent's "Work with me" buttons.
 * With the VS Code helper: focus (or open) the project's VS Code window, then that window claims the request and opens a terminal.
 * Without it, or if no window claims it within a few seconds: a new Terminal.app window.
 */
type PendingResume = { id: string; cwd: string; root: string; at: number; claimed: boolean; command: string; name: string };
const pendingResumes = new Map<string, PendingResume>();
const VSCODE_BIN = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
function shq(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; }
type Opened = { ok: boolean; via: string; message: string; command?: string };

function openInTerminal(id: string, cwd: string, root: string, command: string, name: string): 'vscode' | 'terminal' {
  const viaTerminal = () => {
    const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(`cd ${shq(cwd)} && ${command}`)}\nend tell`;
    execFile('osascript', ['-e', script], () => {});
  };
  if (vscodeClients.size && fs.existsSync(VSCODE_BIN)) {
    const r: PendingResume = { id, cwd, root, at: Date.now(), claimed: false, command, name };
    pendingResumes.set(id, r);
    execFile(VSCODE_BIN, ['-r', root], () => {});
    const payload = JSON.stringify({ sessionId: id, cwd, root });
    for (const c of vscodeClients) c.write(`event: resume\ndata: ${payload}\n\n`);
    // A freshly opened window needs a moment to load the helper; it asks for pending requests when it connects.
    setTimeout(() => { if (!r.claimed) { pendingResumes.delete(id); viaTerminal(); } }, 12_000);
    return 'vscode';
  }
  viaTerminal();
  return 'terminal';
}

function resume(sessionId: string): Opened {
  if (live.has(sessionId)) return jump(sessionId);
  const s = db.prepare('SELECT s.id, s.cwd, p.root FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(sessionId) as Row | undefined;
  if (!s) return { ok: false, via: 'none', message: 'Couldn’t find that job.' };
  const root = s.root && fs.existsSync(s.root) ? s.root : null;
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : root;
  if (!cwd) return { ok: false, via: 'none', message: 'Its folder no longer exists on this machine.' };
  const moved = cwd !== s.cwd ? ' Its worktree is gone, so it opens in the main project folder.' : '';
  const via = openInTerminal(sessionId, cwd, root ?? cwd, `claude --resume ${sessionId}`, 'Claude (resumed)');
  return { ok: true, via, message: via === 'vscode' ? `Reopening it in VS Code.${moved}` : `Reopening it in Terminal.${moved}` };
}

/** Starts a new Claude Code session in a project with an opening prompt. Plan mode means nothing changes until you approve. */
function launch(projectId: string, prompt: string, plan: boolean): Opened {
  const p = db.prepare('SELECT root FROM projects WHERE id = ?').get(projectId) as Row | undefined;
  if (!p?.root || !fs.existsSync(p.root)) return { ok: false, via: 'none', message: 'That project isn’t on this computer.' };
  const text = prompt.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!text) return { ok: false, via: 'none', message: 'Say what you’d like to work on first.' };
  const command = `claude${plan ? ' --permission-mode plan' : ''} ${shq(text)}`;
  const via = openInTerminal(`launch-${crypto.randomUUID()}`, p.root, p.root, command, plan ? 'Claude (planning)' : 'Claude');
  return {
    ok: true, via, command: `cd ${shq(p.root)} && ${command}`,
    message: via === 'vscode' ? 'Opening it in VS Code.' : 'Opening a new Terminal window. If your Mac asks whether Swarmville may control Terminal, click OK.',
  };
}

/** Only Logbook's own pages (and local tools like the VS Code helper) may change things: other websites can't poke the local server. */
function sameSite(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin; // browsers always send it on a POST; local tools don't
  if (!origin) return true;
  try { const u = new URL(origin); return u.hostname === 'localhost' || u.hostname === '127.0.0.1'; } catch { return false; }
}

/** A new prompt or the end of a turn means any permission prompt still open was settled in the terminal. */
function settleAfter(payload: any) {
  if (['Stop', 'SessionEnd', 'UserPromptSubmit'].includes(payload?.hook_event_name) && typeof payload.session_id === 'string') settleSession(payload.session_id);
}

/** What a hook that waits gets back: the opt-in intro, then the project's notes from you. */
function hookReply(payload: any): object | null {
  const intro = terminalIntro(db, payload, live, state.town.name) as { hookSpecificOutput: { additionalContext: string } } | null;
  const note = noteContext(db, payload, state.town.owner);
  const text = [intro?.hookSpecificOutput.additionalContext, note?.text].filter(Boolean).join('\n\n');
  return text ? { hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: text } } : null;
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/hook') {
      const body = await readBody(req, 8 * 1024 * 1024);
      if (url.searchParams.get('wait')) {
        // A permission prompt: hold the request open until you answer in the town, or the terminal answers first and Claude stops the hook.
        let payload: any = null;
        try { payload = JSON.parse(body); handleHook(db, payload); } catch {}
        const ask = payload?.hook_event_name === 'PermissionRequest' ? addAsk(payload, (out) => {
          if (res.writableEnded) return;
          if (out) json(res, 200, out); else res.writeHead(204).end();
        }) : null;
        if (!ask) { soon(); return void res.writeHead(204).end(); }
        res.on('close', () => { if (dropAsk(ask.id)) soon(); });
        soon();
        return;
      }
      if (url.searchParams.get('reply')) {
        // Session start (and a prompt while a note is waiting): the hook waits briefly for context to hand Claude.
        let out: object | null = null;
        try { const payload = JSON.parse(body); handleHook(db, payload); settleAfter(payload); out = hookReply(payload); soon(); } catch {}
        return out ? json(res, 200, out) : void res.writeHead(204).end();
      }
      res.writeHead(204).end();
      try { const payload = JSON.parse(body); handleHook(db, payload); settleAfter(payload); soon(); } catch {}
      return;
    }
    if (req.method === 'POST' && p.startsWith('/api/') && !sameSite(req)) return json(res, 403, { error: 'Not allowed' });
    if (p === '/api/state') return json(res, 200, stateJson);
    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const isVscode = url.searchParams.get('client') === 'vscode';
      res.write(`retry: 2000\n\n`);
      if (isVscode) { vscodeClients.add(res); soon(); } else { res.write(`event: state\ndata: ${stateJson}\n\n`); clients.add(res); }
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); if (vscodeClients.delete(res)) soon(); });
      return;
    }
    if (p.startsWith('/api/project/')) {
      const rest = decodeURIComponent(p.slice('/api/project/'.length));
      if (req.method === 'POST' && rest.endsWith('/name')) {
        const body = await readJson(req);
        renameProject(db, rest.slice(0, -'/name'.length), typeof body.name === 'string' ? body.name : null);
        refresh();
        return json(res, 200, { ok: true });
      }
      const d = projectDetail(db, state, live, rest);
      return d ? json(res, 200, d) : json(res, 404, { error: 'No project with that id' });
    }
    if (p.startsWith('/api/agent/')) {
      const d = agentDetail(db, state, live, decodeURIComponent(p.slice('/api/agent/'.length)));
      return d ? json(res, 200, d) : json(res, 404, { error: 'No agent with that id' });
    }
    if (p === '/api/intros') {
      // Today's lines are written in the background; the page shows the instant version until they're ready.
      writeIntros(db, live, state.town.owner).catch(() => {});
      return json(res, 200, intros(db, live, state.town.owner));
    }
    if (req.method === 'POST' && p === '/api/launch') {
      const body = await readJson(req);
      return json(res, 200, launch(String(body.projectId ?? ''), String(body.prompt ?? ''), !!body.plan));
    }
    if (req.method === 'POST' && p === '/api/notes') {
      const body = await readJson(req);
      const id = addNote(db, String(body.projectId ?? ''), String(body.text ?? ''));
      refresh();
      return json(res, id ? 200 : 400, id ? { ok: true, id } : { ok: false, error: 'Write a note for a project first.' });
    }
    if (req.method === 'POST' && /^\/api\/notes\/\d+\/remove$/.test(p)) { removeNote(db, Number(p.split('/')[3])); refresh(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/crews/dismiss') { const body = await readJson(req); dismissFlag(db, String(body.projectId ?? '')); refresh(); return json(res, 200, { ok: true }); }
    if (p === '/api/day') return json(res, 200, dayView(db, state, live, url.searchParams.get('date') || today()));
    if (p === '/api/wrapped') return json(res, 200, wrappedView(db, state, url.searchParams.get('month') || today().slice(0, 7)));
    if (req.method === 'POST' && p.startsWith('/api/stop/')) return json(res, 200, clockOut(decodeURIComponent(p.slice('/api/stop/'.length))));
    if (req.method === 'POST' && p.startsWith('/api/ask/')) {
      // Your answer to a raised hand, from the town: allow, always allow (Claude Code's suggested rule), or deny.
      const body = await readJson(req);
      const decision = (['allow', 'always', 'deny'] as const).find((d) => d === body.decision) as Decision | undefined;
      if (!decision) return json(res, 400, { ok: false, message: 'Unknown answer' });
      const ok = answerAsk(decodeURIComponent(p.slice('/api/ask/'.length)), decision);
      soon();
      return json(res, 200, ok ? { ok: true } : { ok: false, message: 'Already answered, probably in the terminal.' });
    }
    if (req.method === 'POST' && p.startsWith('/api/jump/')) return json(res, 200, jump(decodeURIComponent(p.slice('/api/jump/'.length))));
    if (req.method === 'POST' && p.startsWith('/api/resume/claim/')) {
      const r = pendingResumes.get(decodeURIComponent(p.slice('/api/resume/claim/'.length)));
      if (!r || r.claimed || Date.now() - r.at > 60_000) return json(res, 200, { ok: false });
      r.claimed = true; pendingResumes.delete(r.id);
      return json(res, 200, { ok: true, cwd: r.cwd, command: r.command, name: r.name });
    }
    if (p === '/api/resume/pending') return json(res, 200, [...pendingResumes.values()].filter((r) => !r.claimed && Date.now() - r.at < 60_000));
    if (req.method === 'POST' && p.startsWith('/api/resume/')) return json(res, 200, resume(decodeURIComponent(p.slice('/api/resume/'.length))));
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.town === 'string') setTown(db, body.town);
      if ('skylineRepo' in body) kvSet(db, 'settings.skylineRepo', body.skylineRepo ? String(body.skylineRepo) : null);
      if ('terminalIntros' in body) kvSet(db, 'settings.terminalIntros', !!body.terminalIntros);
      if (body.welcome && typeof body.welcome === 'object') {
        const cur: Welcome = { ...NEW_WELCOME, ...kvGet<Partial<Welcome>>(db, 'welcome', {}) };
        const w = body.welcome;
        const next: Welcome = {
          step: 'step' in w ? w.step ?? null : cur.step,
          done: 'done' in w ? !!w.done : cur.done,
          doneAt: w.done && !cur.done ? Date.now() : 'done' in w && !w.done ? null : cur.doneAt,
          skipped: 'skipped' in w ? (w.skipped ? { at: Date.now(), step: w.skipped } : null) : cur.skipped,
          tips: Array.isArray(w.tips) ? [...new Set([...cur.tips, ...w.tips.map(String)])] : cur.tips,
        };
        kvSet(db, 'welcome', next);
      }
      refresh();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/skyline' && req.method === 'POST') {
      const body = await readJson(req);
      const png = Buffer.from(String(body.png ?? '').replace(/^data:image\/png;base64,/, ''), 'base64');
      if (png.length < 100) return json(res, 400, { error: 'No image received' });
      const file = path.join(DATA_DIR, 'skyline.png');
      fs.writeFileSync(file, png);
      const repo = kvGet<string | null>(db, 'settings.skylineRepo', null);
      if (body.push && repo) {
        try {
          const dest = path.join(repo, 'logbook-skyline.png');
          fs.copyFileSync(file, dest);
          execFileSync('git', ['-C', repo, 'add', 'logbook-skyline.png'], { timeout: 10000 });
          try { execFileSync('git', ['-C', repo, 'commit', '-m', 'Update Swarmville skyline'], { timeout: 10000 }); } catch {}
          execFileSync('git', ['-C', repo, 'push'], { timeout: 30000 });
          return json(res, 200, { ok: true, file, pushed: true, markdown: '![My agent town](logbook-skyline.png)' });
        } catch (e: any) {
          return json(res, 200, { ok: false, file, pushed: false, error: `Saved locally, but pushing to ${repo} failed: ${String(e?.message ?? e).slice(0, 200)}` });
        }
      }
      return json(res, 200, { ok: true, file, pushed: false });
    }
    if (p === '/api/health') return json(res, 200, { ok: true, pid: process.pid });
    // Static web build
    let file = path.join(WEB_DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Swarmville is running. Build the web UI with `npm run build`, or run `npm run dev` for the dev server.');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e: any) {
    if (!res.headersSent) json(res, 500, { error: e?.message ?? 'Server error' });
  }
});

/*
 * Boot: start answering right away and read past work in short slices, so a first run can show
 * "Setting up your town" with real counts instead of a page that won't load.
 */
refreshHookScript();
addPermissionHook();
try { const n = purgeOwnRuns(db); if (n) console.log(`[logbook] removed ${n} of Logbook's own background runs from the town`); } catch (e) { console.error('[logbook] cleanup failed', e); }
try { backfillEntrypoints(db); } catch (e) { console.error('[logbook] entrypoint backfill failed', e); }
console.log('[logbook] indexing transcripts…');
const t0 = Date.now();
scanTranscripts(db, Date.now() + 300);
refresh();
server.listen(PORT, '127.0.0.1', () => console.log(`[logbook] http://localhost:${PORT}`));
function bootStep() {
  try { scanTranscripts(db, Date.now() + 400); } catch (e) { console.error('[logbook] reading transcripts failed', e); }
  if (transcriptsLeft() > 0) { refresh(); setTimeout(bootStep, 15); return; }
  try { consolidateProjects(db); } catch (e) { console.error('[logbook] joining duplicate projects failed', e); }
  tick(); // first full pass: characters, outcomes
  console.log(`[logbook] indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${state.projects.length} projects, ${state.totals.live} live sessions`);
  setInterval(tick, 2000);
  firstNames().finally(() => { setup.phase = 'ready'; refresh(); startLoops(); });
}
setTimeout(bootStep, 15);

/** Name every building in one go before the town is revealed (capped, so a slow model never holds up the welcome). */
async function firstNames() {
  if (process.env.LOGBOOK_NO_NAMING) return;
  setup.phase = 'naming'; refresh();
  const cap = new Promise((r) => setTimeout(r, 30_000));
  await Promise.race([(async () => { while (await nameProjectsBatch(db) > 0) refresh(); })().catch(() => {}), cap]);
  writeIntros(db, live, state.town.owner).catch(() => {}); // ready for the roll call by the time the town has a name
}

/**
 * Installs from before raised hands could be answered in the town have every Logbook hook except PermissionRequest:
 * add that one next to them (same command, settings backed up first) so upgrading doesn't need a reinstall.
 */
function addPermissionHook() {
  const file = path.join(CLAUDE_DIR, 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ours = (h: any) => typeof h?.command === 'string' && h.command.includes(path.join(DATA_DIR, 'hook.sh'));
    const mine = Object.values(s.hooks ?? {}).flat().flatMap((g: any) => g?.hooks ?? []).find(ours) as { command: string } | undefined;
    if (!mine || (s.hooks.PermissionRequest ?? []).some((g: any) => (g?.hooks ?? []).some(ours))) return;
    (s.hooks.PermissionRequest ??= []).push({ matcher: '*', hooks: [{ type: 'command', command: mine.command, timeout: 600 }] });
    fs.copyFileSync(file, `${file}.logbook-backup-${Date.now()}`);
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    console.log('[logbook] added the PermissionRequest hook so raised hands can be answered from the town');
  } catch {}
}

/** Keeps ~/.logbook/hook.sh in step with this version, so hook changes don't need a reinstall. */
function refreshHookScript() {
  try {
    const dst = path.join(DATA_DIR, 'hook.sh'), src = path.join(import.meta.dirname, '..', 'hook', 'logbook-hook.sh');
    if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') !== fs.readFileSync(src, 'utf8')) { fs.copyFileSync(src, dst); fs.chmodSync(dst, 0o755); }
  } catch {}
}

async function githubLoop() {
  try { const m = await syncGithub(db); console.log('[logbook] github', m.accounts.map((a) => `${a.login}:${a.ok ? a.repos : a.error}`).join(' ')); soon(); }
  catch (e) { console.error('[logbook] github sync failed', e); }
}
async function prLoop() {
  try { await checkPullRequests(db, new Set(live.keys())); soon(); } catch (e) { console.error('[logbook] PR check failed', e); }
}
/** Keeps each live agent's "current job" label in step with your newest instruction. */
async function focusLoop() {
  try { if (await labelNextFocus(db)) soon(); } catch (e) { console.error('[logbook] job label failed', e); }
}
async function nameLoop() {
  try { if (await nameProjectsBatch(db) > 0 || await nameNextProject(db)) soon(); else if (await groupDistricts(db)) soon(); else if (await summarizeNextProject(db)) soon(); } catch (e) { console.error('[logbook] naming failed', e); }
}
githubLoop();
setInterval(githubLoop, 10 * 60_000);
function startLoops() {
  setTimeout(prLoop, 5000);
  setInterval(prLoop, 2 * 60_000);
  if (!process.env.LOGBOOK_NO_NAMING) { setTimeout(nameLoop, 8000); setInterval(nameLoop, 20_000); setInterval(focusLoop, 4000); }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
