import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PORT, WEB_DIST } from './config.ts';
import { openDb } from './db.ts';
import { scanTranscripts } from './transcripts.ts';
import { readLive, type LiveEntry } from './live.ts';
import { adoptLive, buildState, projectDetail } from './state.ts';
import { handleHook } from './hooks.ts';
import { checkPullRequests, syncGithub } from './github.ts';
import { notifyTransitions } from './notify.ts';
import type { StateView } from './types.ts';

const db = openDb();
let live = new Map<string, LiveEntry>();
let state!: StateView;
let stateJson = '';
let stateHash = '';
const clients = new Set<http.ServerResponse>();

function refresh() {
  live = readLive();
  adoptLive(db, live);
  state = buildState(db, live);
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
function tick() {
  if (ticking) return;
  ticking = true;
  try {
    scanTranscripts(db);
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

function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/hook') {
      const body = await readBody(req);
      res.writeHead(204).end();
      try { handleHook(db, JSON.parse(body)); soon(); } catch {}
      return;
    }
    if (url.pathname === '/api/state') return json(res, 200, stateJson);
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: state\ndata: ${stateJson}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (url.pathname.startsWith('/api/project/')) {
      const d = projectDetail(db, state, live, decodeURIComponent(url.pathname.slice('/api/project/'.length)));
      return d ? json(res, 200, d) : json(res, 404, { error: 'No project with that id' });
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, pid: process.pid });
    // Static web build
    let file = path.join(WEB_DIST, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
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
githubLoop();
setInterval(githubLoop, 10 * 60_000);
setTimeout(prLoop, 5000);
setInterval(prLoop, 2 * 60_000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
