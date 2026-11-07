import { execFileSync } from 'node:child_process';
import type { LiveEntry } from './live.ts';

/*
 * Clocking an agent out from Swarmville: the VS Code helper closes its terminal tab (which ends Claude with it),
 * and the daemon makes sure the Claude process itself stops: SIGTERM, then SIGKILL if it hangs on.
 * Claude writes its transcript as it goes, so the conversation can be resumed later.
 */
export type StopDeps = {
  /** The process's command line, or null if it's gone. */
  command: (pid: number) => string | null;
  alive: (pid: number) => boolean;
  signal: (pid: number, sig: NodeJS.Signals) => void;
  later: (fn: () => void, ms: number) => void;
};

export type StopResult = { ok: boolean; message: string };

/** Only signal a process that really is Claude, so a recycled pid never takes down something else. */
export function isClaude(command: string | null): boolean {
  return !!command && /(^|[/\s])claude(\s|$)|\/claude\/versions\//.test(command);
}

export function stopProcess(e: LiveEntry | undefined, deps: StopDeps, graceMs = 1500, killMs = 5000): StopResult {
  if (!e) return { ok: false, message: 'That agent isn’t running any more.' };
  if (!isClaude(deps.command(e.pid))) return { ok: false, message: 'Couldn’t find their Claude process, so nothing was stopped.' };
  // Give the helper a moment to close the terminal first; that ends Claude on its own.
  deps.later(() => {
    if (!deps.alive(e.pid)) return;
    try { deps.signal(e.pid, 'SIGTERM'); } catch {}
    deps.later(() => { if (deps.alive(e.pid) && isClaude(deps.command(e.pid))) { try { deps.signal(e.pid, 'SIGKILL'); } catch {} } }, killMs);
  }, graceMs);
  return { ok: true, message: 'Clocked out. The conversation is saved; resume it any time.' };
}

export const systemDeps: StopDeps = {
  command: (pid) => { try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null; } catch { return null; } },
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; } },
  signal: (pid, sig) => process.kill(pid, sig),
  later: (fn, ms) => { setTimeout(fn, ms); },
};
