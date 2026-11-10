/*
 * The runner: one small process per agent that Swarmville runs itself (no terminal).
 *
 * It owns a headless Claude Code (`claude -p` speaking stream-json both ways) and lives apart from the daemon, so restarting
 * the daemon never stops an agent mid-job. The daemon talks to it over a unix socket next to its files in <data dir>/runners:
 *   <id>.json   who it is (pids, folder, running or not)
 *   <id>.jsonl  the conversation, one line per message, for the chat in the town
 *   <id>.sock   the line to the daemon
 *
 * Runner → daemon (one JSON object per line): {ev:'hello', asks}, {ev:'log', entry}, {ev:'ask', ask}, {ev:'askGone', requestId}, {ev:'exit'}.
 * Daemon → runner: {op:'send', text, images?}, {op:'answer', requestId, response}, {op:'interrupt'}, {op:'stop'}.
 *
 * Built-in modules only, and no imports from the rest of the daemon: it keeps running whatever happens to the daemon's code.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export type RunnerSpec = {
  id: string; // the Claude session id
  cwd: string;
  dir: string; // <data dir>/runners
  bin: string; // the claude CLI
  prompt: string;
  images?: RunnerImage[];
  plan?: boolean;
  /** Build without asking: Claude runs with --dangerously-skip-permissions, so no yes/no on every edit or command. */
  skip?: boolean;
  resume?: boolean; // continue an earlier conversation with this id
};
export type RunnerImage = { mediaType: string; data: string }; // base64
export type RunnerAsk = { requestId: string; toolName: string; input: any; suggestions: unknown[]; at: number };
export type RunnerMeta = { id: string; pid: number; claudePid: number | null; cwd: string; startedAt: number; status: 'running' | 'exited' | 'released'; exitedAt: number | null; skip?: boolean };
/** One line of the conversation as the town shows it. Tool lines keep the raw call; the daemon words them. */
export type RunnerEntry = { at: number; kind: 'you' | 'them' | 'tool' | 'done' | 'note'; text: string; images?: number; tool?: string; input?: unknown; error?: boolean };

/** An agent with nothing to do and nobody waiting on it lets its Claude go after this long; a new message brings it back. */
export const IDLE_MS = 30 * 60_000;

export const runnerPaths = (dir: string, id: string) => ({
  meta: path.join(dir, `${id}.json`), log: path.join(dir, `${id}.jsonl`), sock: sockPath(dir, id), err: path.join(dir, `${id}.err`), spec: path.join(dir, `${id}.spec.json`),
});

/** Unix socket paths are capped near 104 bytes on macOS: a long data folder puts the socket in a private folder under /tmp instead. */
function sockPath(dir: string, id: string): string {
  const p = path.join(dir, `${id}.sock`);
  if (Buffer.byteLength(p) <= 100) return p;
  const short = path.join('/tmp', `sv-${process.getuid?.() ?? 0}`);
  try { fs.mkdirSync(short, { recursive: true, mode: 0o700 }); } catch {}
  return path.join(short, `${id}.sock`);
}

export function claudeArgs(spec: Pick<RunnerSpec, 'id' | 'plan' | 'resume' | 'skip'>): string[] {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
    ...(spec.resume ? ['--resume', spec.id] : ['--session-id', spec.id]),
    ...(spec.plan ? ['--permission-mode', 'plan'] : spec.skip ? ['--dangerously-skip-permissions'] : [])];
}

/** The user message Claude Code reads on stdin. */
export function userMessage(text: string, images: RunnerImage[] = []): object {
  const content = images.length
    ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), ...(text ? [{ type: 'text', text }] : [])]
    : text;
  return { type: 'user', message: { role: 'user', content } };
}

/** What one line of Claude's output adds to the conversation. */
export function entriesFrom(m: any, now = Date.now()): RunnerEntry[] {
  if (m?.type === 'assistant' && m.parent_tool_use_id == null && Array.isArray(m.message?.content)) {
    const out: RunnerEntry[] = [];
    for (const c of m.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ at: now, kind: 'them', text: c.text.trim() });
      if (c?.type === 'tool_use' && typeof c.name === 'string') out.push({ at: now, kind: 'tool', text: c.name, tool: c.name, input: c.input ?? {} });
    }
    return out;
  }
  if (m?.type === 'result') {
    return [{ at: now, kind: 'done', text: typeof m.result === 'string' ? m.result.slice(0, 400) : '', error: m.is_error === true }];
  }
  return [];
}

function main(specPath: string) {
  const spec: RunnerSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  try { fs.unlinkSync(specPath); } catch {} // it may hold pasted images: don't keep them around
  const P = runnerPaths(spec.dir, spec.id);
  const meta: RunnerMeta = { id: spec.id, pid: process.pid, claudePid: null, cwd: spec.cwd, startedAt: Date.now(), status: 'running', exitedAt: null, ...(spec.skip ? { skip: true } : {}) };
  const saveMeta = () => { try { fs.writeFileSync(P.meta, JSON.stringify(meta)); } catch {} };
  const conns = new Set<net.Socket>();
  const asks = new Map<string, RunnerAsk>();
  const tell = (o: object) => { const line = JSON.stringify(o) + '\n'; for (const c of conns) c.write(line); };
  const log = (e: RunnerEntry) => { try { fs.appendFileSync(P.log, JSON.stringify(e) + '\n'); } catch {} tell({ ev: 'log', entry: e }); };

  const env = { ...process.env };
  for (const k of Object.keys(env)) if ((k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR') || k === 'CLAUDECODE') delete env[k];
  const child = spawn(spec.bin, claudeArgs(spec), { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  meta.claudePid = child.pid ?? null;
  saveMeta();

  let lastActive = Date.now();
  let busy = false; // a turn is under way
  const write = (o: object) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n'); };
  const send = (text: string, images: RunnerImage[] = []) => {
    lastActive = Date.now(); busy = true;
    log({ at: Date.now(), kind: 'you', text, ...(images.length ? { images: images.length } : {}) });
    write(userMessage(text, images));
  };

  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: any; try { m = JSON.parse(line); } catch { continue; }
      lastActive = Date.now();
      if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
        const a: RunnerAsk = { requestId: m.request_id, toolName: m.request.tool_name, input: m.request.input ?? {}, suggestions: m.request.permission_suggestions ?? [], at: Date.now() };
        asks.set(a.requestId, a);
        tell({ ev: 'ask', ask: a });
        continue;
      }
      if (m.type === 'control_request') { // nothing else is offered to Claude, so nothing else should come
        write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Not supported by Swarmville' } });
        continue;
      }
      if (m.type === 'control_cancel_request') { if (asks.delete(m.request_id)) tell({ ev: 'askGone', requestId: m.request_id }); continue; }
      if (m.type === 'result') busy = false;
      for (const e of entriesFrom(m)) log(e);
    }
  });
  child.stderr.on('data', (d: Buffer) => { try { fs.appendFileSync(P.err, d); } catch {} });

  const server = net.createServer((c) => {
    conns.add(c);
    c.write(JSON.stringify({ ev: 'hello', asks: [...asks.values()], busy }) + '\n');
    let inbuf = '';
    c.on('data', (d) => {
      inbuf += d.toString('utf8');
      for (let i = inbuf.indexOf('\n'); i >= 0; i = inbuf.indexOf('\n')) {
        const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 1);
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (o.op === 'send' && (typeof o.text === 'string' || Array.isArray(o.images))) send(String(o.text ?? ''), Array.isArray(o.images) ? o.images : []);
        else if (o.op === 'answer' && asks.has(o.requestId)) {
          asks.delete(o.requestId);
          lastActive = Date.now();
          write({ type: 'control_response', response: { subtype: 'success', request_id: o.requestId, response: o.response } });
          tell({ ev: 'askGone', requestId: o.requestId });
        } else if (o.op === 'interrupt') write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } });
        else if (o.op === 'stop') stop();
      }
    });
    c.on('close', () => conns.delete(c));
    c.on('error', () => conns.delete(c));
  });
  try { fs.unlinkSync(P.sock); } catch {}
  server.on('error', (e) => { // with no line to the daemon nobody could talk to it: stop rather than run unseen
    log({ at: Date.now(), kind: 'note', text: `Swarmville couldn’t keep a line open to this agent (${e.message}), so it stopped.`, error: true });
    stop();
  });
  server.listen(P.sock);

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    child.stdin.end(); // Claude finishes what it's writing and exits
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 5000).unref();
  }
  const idle = setInterval(() => { if (!busy && !asks.size && Date.now() - lastActive > IDLE_MS) stop(); }, 60_000);

  child.on('exit', (code) => {
    clearInterval(idle);
    if (code && !stopping) {
      let why = ''; try { why = fs.readFileSync(P.err, 'utf8').trim().split('\n').pop() ?? ''; } catch {}
      log({ at: Date.now(), kind: 'note', text: `Claude stopped unexpectedly${why ? `: ${why.slice(0, 300)}` : ''}.`, error: true });
    }
    meta.status = 'exited'; meta.exitedAt = Date.now(); meta.claudePid = null;
    saveMeta();
    tell({ ev: 'exit' });
    server.close();
    try { fs.unlinkSync(P.sock); } catch {}
    setTimeout(() => process.exit(0), 200);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  if (spec.prompt || spec.images?.length) send(spec.prompt, spec.images ?? []);
}

if (import.meta.main) main(process.argv[2]);
