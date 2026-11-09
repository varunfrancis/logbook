import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from './config.ts';

/** Claude Code writes one file per running process to ~/.claude/sessions/<pid>.json. */
export type LiveEntry = {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: string; // interactive | bg | ...
  status: string; // busy | idle | waiting | ...
  name: string | null;
  updatedAt: number | null;
  startedAt: number | null;
};

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export function readLive(dir = SESSIONS_DIR): Map<string, LiveEntry> {
  const out = new Map<string, LiveEntry>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!d?.sessionId || !d?.pid || !alive(d.pid)) continue;
      out.set(d.sessionId, {
        pid: d.pid, sessionId: d.sessionId, cwd: d.cwd, kind: d.kind ?? 'interactive',
        status: d.status ?? 'idle', name: d.name ?? null, updatedAt: d.updatedAt ?? null, startedAt: d.startedAt ?? null,
      });
    } catch {}
  }
  return out;
}

/**
 * The agent's process and everything above it, nearest first. A background agent runs a few `claude` processes
 * below the one its parent agent started, so the terminal that shows it is several levels up, not its direct parent.
 */
export function ancestry(pid: number, parentOf: (pid: number) => number | null, max = 16): number[] {
  const out: number[] = [];
  for (let p: number | null = pid; p && p > 1 && out.length < max && !out.includes(p); p = parentOf(p)) out.push(p);
  return out;
}
