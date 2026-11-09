import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { LiveEntry } from './live.ts';
import { runnerPaths, type RunnerAsk, type RunnerEntry, type RunnerImage, type RunnerMeta, type RunnerSpec } from './runner.ts';

/*
 * The daemon's side of agents that Swarmville runs itself (runner.ts): starting them, keeping a line open to each one
 * (and picking it up again after a restart), passing on your messages and answers, and bringing a finished one back
 * (claude --resume, same conversation) when you message it again.
 */

const RUNNER_TS = path.join(import.meta.dirname, 'runner.ts');

export type RunnerEvents = {
  /** Claude is waiting on a yes/no, a question or a plan. Call `answer` with Claude Code's decision. */
  ask: (sessionId: string, ask: RunnerAsk, answer: (decision: object) => void) => void;
  /** That ask was settled some other way (Claude withdrew it, or the agent stopped). */
  askGone: (sessionId: string, requestId: string) => void;
  /** Anything changed: a message, a turn ending, the agent starting or stopping. */
  change: (sessionId: string) => void;
};

type Link = { sock: net.Socket | null; connecting: boolean; asks: Set<string> };
export type Opened = { ok: boolean; message: string; sessionId?: string };

export const pidAlive = (pid: number | null | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
};

export class Runners {
  private links = new Map<string, Link>();
  readonly dir: string;
  private events: RunnerEvents;
  private bin: () => string | null;
  private runnerScript: string;
  constructor(dir: string, events: RunnerEvents, bin: () => string | null, runnerScript = RUNNER_TS) {
    this.dir = dir; this.events = events; this.bin = bin; this.runnerScript = runnerScript;
    fs.mkdirSync(dir, { recursive: true });
  }

  meta(id: string): RunnerMeta | null {
    try { return JSON.parse(fs.readFileSync(runnerPaths(this.dir, id).meta, 'utf8')); } catch { return null; }
  }
  /** Swarmville runs (or ran, and still looks after) this agent. Not once you've taken it over in a terminal. */
  knows(id: string): boolean { if (!safeId(id)) return false; const m = this.meta(id); return !!m && m.status !== 'released'; }
  /** Its Claude is up right now. */
  running(id: string): boolean { const m = this.meta(id); return !!m && m.status === 'running' && pidAlive(m.pid); }
  /** Every agent Swarmville looks after: 'on' while it runs, 'off' once it has clocked out (a message brings it back). */
  states(): Map<string, 'on' | 'off'> {
    const out = new Map<string, 'on' | 'off'>();
    for (const id of this.ids()) { const m = this.meta(id); if (m && m.status !== 'released') out.set(id, m.status === 'running' && pidAlive(m.pid) ? 'on' : 'off'); }
    return out;
  }
  /** "Take over in terminal": from now on the terminal has it, and Swarmville no longer brings it back by itself. */
  release(id: string) {
    const m = this.meta(id);
    if (m) fs.writeFileSync(runnerPaths(this.dir, id).meta, JSON.stringify({ ...m, status: 'released' }));
  }

  /** Starts a new agent (or brings back `resume`'s conversation) in `cwd`, with a first message. */
  start(o: { cwd: string; prompt: string; images?: RunnerImage[]; plan?: boolean; resume?: string }): Opened {
    const bin = this.bin();
    if (!bin) return { ok: false, message: 'Couldn’t find Claude Code on this computer. Install it, then try again.' };
    if (o.resume && this.running(o.resume)) return { ok: false, message: 'They’re already running.' };
    const id = o.resume ?? crypto.randomUUID();
    const P = runnerPaths(this.dir, id);
    const spec: RunnerSpec = { id, cwd: o.cwd, dir: this.dir, bin, prompt: o.prompt, images: o.images, plan: o.plan, resume: !!o.resume };
    fs.writeFileSync(P.spec, JSON.stringify(spec), { mode: 0o600 });
    // the runner's own trouble (not Claude's) lands here
    const out = fs.openSync(path.join(this.dir, `${id}.runner.log`), 'a');
    const child = spawn(process.execPath, ['--no-warnings', this.runnerScript, P.spec], { cwd: o.cwd, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.closeSync(out);
    // it's "running" from the first moment, so the town shows it at once
    fs.writeFileSync(P.meta, JSON.stringify({ id, pid: child.pid ?? 0, claudePid: null, cwd: o.cwd, startedAt: Date.now(), status: 'running', exitedAt: null } satisfies RunnerMeta));
    this.links.delete(id);
    this.connectSoon(id);
    return { ok: true, sessionId: id, message: o.resume ? 'Back at work.' : 'Started. They’re working on it here in Swarmville.' };
  }

  /** Your next message: straight to a running agent, or it brings a finished one back with it. */
  send(id: string, text: string, images: RunnerImage[] = [], cwd?: string | null): Opened {
    if (!safeId(id)) return { ok: false, message: 'Which agent?' };
    const l = this.links.get(id);
    if (l?.sock && this.running(id)) {
      l.sock.write(JSON.stringify({ op: 'send', text, images }) + '\n');
      return { ok: true, message: 'Sent.', sessionId: id };
    }
    if (this.running(id)) return { ok: false, message: 'Still connecting to them. Try again in a moment.' };
    const where = cwd ?? this.meta(id)?.cwd;
    if (!where || !fs.existsSync(where)) return { ok: false, message: 'Their folder is gone from this computer.' };
    return this.start({ cwd: where, prompt: text, images, resume: id });
  }

  interrupt(id: string): boolean { return this.op(id, { op: 'interrupt' }); }

  /** Ends the agent's Claude (the conversation is kept). Resolves once it has stopped. */
  stop(id: string, timeoutMs = 8000): Promise<boolean> {
    if (!this.running(id)) return Promise.resolve(true);
    if (!this.op(id, { op: 'stop' })) { const m = this.meta(id); try { if (m?.pid) process.kill(m.pid, 'SIGTERM'); } catch {} }
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => { if (!this.running(id)) resolve(true); else if (Date.now() - t0 > timeoutMs) resolve(false); else setTimeout(check, 150); };
      check();
    });
  }

  /** The conversation so far, oldest first. */
  chat(id: string, limit = 300): RunnerEntry[] {
    if (!safeId(id)) return [];
    let raw = '';
    try { raw = fs.readFileSync(runnerPaths(this.dir, id).log, 'utf8'); } catch { return []; }
    const out: RunnerEntry[] = [];
    for (const line of raw.split('\n').slice(-limit - 1)) { if (line) { try { out.push(JSON.parse(line)); } catch {} } }
    return out.slice(-limit);
  }

  /** Running agents as entries in the live list, for any the Claude Code registry doesn't list itself. */
  addLive(live: Map<string, LiveEntry>) {
    for (const id of this.ids()) {
      if (live.has(id)) continue;
      const m = this.meta(id);
      if (!m || m.status !== 'running' || !pidAlive(m.pid)) continue;
      live.set(id, { pid: m.claudePid ?? m.pid, sessionId: id, cwd: m.cwd, kind: 'swarmville', status: 'busy', name: null, updatedAt: Date.now(), startedAt: m.startedAt });
    }
  }

  /** Every tick: pick up runners we have no line to (a fresh daemon, or one just started), and tidy ones that died. */
  scan() {
    for (const id of this.ids()) {
      const m = this.meta(id);
      if (!m || m.status !== 'running') continue;
      if (!pidAlive(m.pid)) {
        try { fs.writeFileSync(runnerPaths(this.dir, id).meta, JSON.stringify({ ...m, status: 'exited', exitedAt: Date.now(), claudePid: null })); } catch {}
        this.drop(id);
        continue;
      }
      const l = this.links.get(id);
      if (!l || (!l.sock && !l.connecting)) this.connect(id);
    }
  }

  ids(): string[] {
    try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && !f.endsWith('.spec.json')).map((f) => f.slice(0, -5)).filter(safeId); } catch { return []; }
  }

  private op(id: string, o: object): boolean {
    const l = this.links.get(id);
    if (!l?.sock) return false;
    l.sock.write(JSON.stringify(o) + '\n');
    return true;
  }

  private connectSoon(id: string, tries = 40) {
    const P = runnerPaths(this.dir, id);
    if (fs.existsSync(P.sock)) return this.connect(id);
    if (tries > 0 && this.running(id)) setTimeout(() => this.connectSoon(id, tries - 1), 100);
  }

  private connect(id: string) {
    const l: Link = this.links.get(id) ?? { sock: null, connecting: false, asks: new Set() };
    this.links.set(id, l);
    if (l.connecting || l.sock) return;
    l.connecting = true;
    const sock = net.createConnection(runnerPaths(this.dir, id).sock);
    let buf = '';
    sock.on('connect', () => { l.sock = sock; l.connecting = false; this.events.change(id); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (o.ev === 'hello') for (const a of o.asks ?? []) this.raise(id, l, a);
        else if (o.ev === 'ask') this.raise(id, l, o.ask);
        else if (o.ev === 'askGone') { l.asks.delete(o.requestId); this.events.askGone(id, o.requestId); }
        if (o.ev === 'log' || o.ev === 'exit' || o.ev === 'hello') this.events.change(id);
      }
    });
    const gone = () => { if (this.links.get(id) === l) this.drop(id); this.events.change(id); };
    sock.on('error', gone);
    sock.on('close', gone);
  }

  private raise(id: string, l: Link, a: RunnerAsk) {
    if (!a?.requestId || l.asks.has(a.requestId)) return;
    l.asks.add(a.requestId);
    this.events.ask(id, a, (decision) => {
      l.asks.delete(a.requestId);
      this.op(id, { op: 'answer', requestId: a.requestId, response: controlResponse(decision, a.input) });
    });
  }

  private drop(id: string) {
    const l = this.links.get(id);
    if (!l) return;
    this.links.delete(id);
    for (const r of l.asks) this.events.askGone(id, r);
    try { l.sock?.destroy(); } catch {}
  }
}

/** Session ids are uuids; nothing else ever becomes a file name. */
export const safeId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * Claude Code's permission answer over stdio: the same decision the PermissionRequest hook gives, except a yes must
 * carry the tool's input (as-is unless the answer changed it, like a question's picks).
 */
export function controlResponse(decision: any, input: unknown): object {
  if (decision?.behavior === 'allow') return { behavior: 'allow', updatedInput: decision.updatedInput ?? input, ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}) };
  return { behavior: 'deny', message: String(decision?.message ?? 'The user said no.') };
}
