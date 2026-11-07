import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { DATA_DIR, PORT, WEB_DIST } from './config.ts';
import { kvGet, kvSet, openDb } from './db.ts';
import { scanTranscripts } from './transcripts.ts';
import { readLive, type LiveEntry } from './live.ts';
import { adoptLive, agentDetail, buildState, dayView, projectDetail, refreshAgents, wrappedView } from './state.ts';
import { handleHook } from './hooks.ts';
import { checkPullRequests, syncGithub } from './github.ts';
import { notifyTransitions } from './notify.ts';
import { stampClosed } from './outcome.ts';
import { nameNextProject, renameProject, setTown } from './naming.ts';
import { groupDistricts } from './districts.ts';
import type { StateView } from './types.ts';

const db = openDb();
let live = new Map<string, LiveEntry>();
let state!: StateView;
let stateJson = '';
let stateHash = '';
const clients = new Set<http.ServerResponse>();
const vscodeClients = new Set<http.ServerResponse>();

function refresh() {
  live = readLive();
  adoptLive(db, live);
  state = buildState(db, live, Date.now(), vscodeClients.size > 0);
  const { generatedAt, ...rest } = state;
  const hash = crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex');
  stateJson = JSON.stringify(state);
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
  return { ok: true, via: 'app', message: 'Brought VS Code forward. Install the Logbook VS Code helper to jump straight to the terminal.' };
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/hook') {
      const body = await readBody(req, 8 * 1024 * 1024);
      res.writeHead(204).end();
      try { handleHook(db, JSON.parse(body)); soon(); } catch {}
      return;
    }
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
    if (p === '/api/day') return json(res, 200, dayView(db, state, live, url.searchParams.get('date') || today()));
    if (p === '/api/wrapped') return json(res, 200, wrappedView(db, state, url.searchParams.get('month') || today().slice(0, 7)));
    if (req.method === 'POST' && p.startsWith('/api/jump/')) return json(res, 200, jump(decodeURIComponent(p.slice('/api/jump/'.length))));
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.town === 'string') setTown(db, body.town);
      if ('skylineRepo' in body) kvSet(db, 'settings.skylineRepo', body.skylineRepo ? String(body.skylineRepo) : null);
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
          try { execFileSync('git', ['-C', repo, 'commit', '-m', 'Update Logbook skyline'], { timeout: 10000 }); } catch {}
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
      return res.end('Logbook daemon is running. Build the web UI with `npm run build`, or run `npm run dev` for the dev server.');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e: any) {
    if (!res.headersSent) json(res, 500, { error: e?.message ?? 'Server error' });
  }
});

console.log('[logbook] indexing transcripts…');
const t0 = Date.now();
tick();
console.log(`[logbook] indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${state.projects.length} projects, ${state.totals.live} live sessions`);

server.listen(PORT, '127.0.0.1', () => console.log(`[logbook] http://localhost:${PORT}`));
setInterval(tick, 2000);

async function githubLoop() {
  try { const m = await syncGithub(db); console.log('[logbook] github', m.accounts.map((a) => `${a.login}:${a.ok ? a.repos : a.error}`).join(' ')); soon(); }
  catch (e) { console.error('[logbook] github sync failed', e); }
}
async function prLoop() {
  try { await checkPullRequests(db, new Set(live.keys())); soon(); } catch (e) { console.error('[logbook] PR check failed', e); }
}
async function nameLoop() {
  try { if (await nameNextProject(db)) soon(); else if (await groupDistricts(db)) soon(); } catch (e) { console.error('[logbook] naming failed', e); }
}
githubLoop();
setInterval(githubLoop, 10 * 60_000);
setTimeout(prLoop, 5000);
setInterval(prLoop, 2 * 60_000);
if (!process.env.LOGBOOK_NO_NAMING) { setTimeout(nameLoop, 8000); setInterval(nameLoop, 20_000); }

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
