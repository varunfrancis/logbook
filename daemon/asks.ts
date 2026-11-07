import path from 'node:path';
import type { AskView } from './types.ts';
import { describeTool } from './describe.ts';

/**
 * Raised hands you can answer from the town.
 *
 * Claude Code's PermissionRequest hook waits (up to its timeout) for an answer while the usual prompt shows in the
 * terminal; whichever answers first wins. The hook script holds its request to the daemon open, so each pending ask
 * here owns a `reply` that ends that request. If you answer in the terminal instead, Claude stops the hook, the
 * request closes and the ask is dropped.
 */

/** Tools whose prompt is a question or form rather than a yes/no: these are answered in the terminal. */
const TERMINAL_ONLY = new Set(['AskUserQuestion']);

type Pending = { view: AskView; sessionId: string; at: number; suggestions: unknown[]; reply: (out: object | null) => void };
export type Decision = 'allow' | 'always' | 'deny';

const pending = new Map<string, Pending>();
let seq = 0;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** What the popup shows: a plain sentence plus the exact thing they want to run or change. */
export function describeAsk(tool: string, input: any = {}): Omit<AskView, 'id' | 'canAlways' | 'at'> {
  const i = input || {};
  const file = typeof (i.file_path || i.notebook_path) === 'string' ? (i.file_path || i.notebook_path) as string : null;
  switch (tool) {
    case 'Bash':
      return { tool, title: i.description ? `Wants to run: ${clip(String(i.description), 90)}` : 'Wants to run a command', detail: clip(String(i.command ?? '').trim(), 2000), detailKind: 'command' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { tool, title: `Wants to edit ${file ? path.basename(file) : 'a file'}`, detail: file, detailKind: 'path' };
    case 'Write':
      return { tool, title: `Wants to write ${file ? path.basename(file) : 'a file'}`, detail: file, detailKind: 'path' };
    case 'WebFetch':
      return { tool, title: 'Wants to read a web page', detail: typeof i.url === 'string' ? i.url : null, detailKind: 'path' };
    case 'ExitPlanMode':
      return { tool, title: 'Has a plan and wants to start', detail: typeof i.plan === 'string' ? clip(i.plan.trim(), 4000) : null, detailKind: 'text' };
    default: {
      const d = describeTool(tool, i);
      const json = Object.keys(i).length ? clip(JSON.stringify(i, null, 1), 1500) : null;
      return { tool, title: `Wants to ${d.text.charAt(0).toLowerCase()}${d.text.slice(1)}`.replace(/^Wants to using /, 'Wants to use '), detail: json, detailKind: 'text' };
    }
  }
}

/** Registers a PermissionRequest. Returns null when this one should be answered in the terminal. */
export function addAsk(payload: any, reply: (out: object | null) => void, now = Date.now()): AskView | null {
  const tool = String(payload?.tool_name ?? '');
  const sessionId = payload?.session_id;
  if (!tool || typeof sessionId !== 'string' || TERMINAL_ONLY.has(tool)) return null;
  const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [];
  const id = `${now.toString(36)}-${(++seq).toString(36)}`;
  const view: AskView = { id, at: now, canAlways: suggestions.length > 0, ...describeAsk(tool, payload.tool_input) };
  pending.set(id, { view, sessionId, at: now, suggestions, reply });
  return view;
}

/** The hook's request went away (answered in the terminal, timed out, or the agent stopped). */
export function dropAsk(id: string): boolean { return pending.delete(id); }

/** Your answer from the town. Ends the waiting hook with Claude Code's decision object. */
export function answerAsk(id: string, decision: Decision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  const d = decision === 'deny'
    ? { behavior: 'deny', message: 'The user said no (answered from their Swarmville town).' }
    : { behavior: 'allow', ...(decision === 'always' && p.suggestions.length ? { updatedPermissions: p.suggestions } : {}) };
  p.reply({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
  return true;
}

/** The oldest open ask for each session (one at a time, like the terminal). */
export function asksBySession(): Map<string, AskView> {
  const out = new Map<string, AskView>();
  for (const p of pending.values()) { const cur = out.get(p.sessionId); if (!cur || p.at < cur.at) out.set(p.sessionId, p.view); }
  return out;
}

/** The turn ended or a new one began (Stop, SessionEnd, a new prompt): anything still open was settled elsewhere. */
export function settleSession(sessionId: string): boolean {
  let n = 0;
  for (const [id, p] of pending) if (p.sessionId === sessionId) { pending.delete(id); p.reply(null); n++; }
  return n > 0;
}
