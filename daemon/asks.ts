import path from 'node:path';
import type { AskQuestion, AskView } from './types.ts';
import { describeTool } from './describe.ts';

/**
 * Raised hands you can answer from the town.
 *
 * Claude Code's PermissionRequest hook waits (up to its timeout) for an answer while the usual prompt shows in the
 * terminal; whichever answers first wins. The hook script holds its request to the daemon open, so each pending ask
 * here owns a `reply` that ends that request. If you answer in the terminal instead, Claude stops the hook, the
 * request closes and the ask is dropped.
 */

type Pending = { view: AskView; sessionId: string; at: number; suggestions: unknown[]; input: any; reply: (out: object | null) => void };
/** allow / always / deny: a yes or no. answer: picks for a question. changes: a no with a note (plan feedback). */
export type Decision = 'allow' | 'always' | 'deny' | 'answer' | 'changes';
/** Your answer to one question: the choices you picked, and anything you typed under "Something else". */
export type Answer = { picked?: string[]; other?: string };

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
    case 'AskUserQuestion': {
      const questions = askQuestions(i);
      return { tool, title: questions.length > 1 ? `Has ${questions.length} questions for you` : 'Has a question for you', detail: null, detailKind: 'text', questions };
    }
    case 'ExitPlanMode':
      return { tool, title: 'Has a plan and wants to start', detail: typeof i.plan === 'string' ? clip(i.plan.trim(), 4000) : null, detailKind: 'text' };
    default: {
      const d = describeTool(tool, i);
      const json = Object.keys(i).length ? clip(JSON.stringify(i, null, 1), 1500) : null;
      return { tool, title: `Wants to ${d.text.charAt(0).toLowerCase()}${d.text.slice(1)}`.replace(/^Wants to using /, 'Wants to use '), detail: json, detailKind: 'text' };
    }
  }
}

/** The questions in an AskUserQuestion call, tidied for the popup. */
export function askQuestions(input: any): AskQuestion[] {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.filter((q: any) => typeof q?.question === 'string' && q.question.trim()).map((q: any) => ({
    question: q.question,
    header: typeof q.header === 'string' ? q.header : '',
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => typeof o?.label === 'string')
      .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
  }));
}

/**
 * Claude Code's decision for your answers to a question. Picks go back as the question's answers, exactly as if you'd
 * chosen them in the terminal. Claude Code only takes its own choices that way, so when you typed something of your own,
 * the question is turned down with everything you said, and the agent carries on from your words.
 * Null when a question has no answer yet.
 */
export function questionDecision(input: any, answers: Answer[]): object | null {
  const qs = askQuestions(input);
  if (!qs.length || answers.length !== qs.length) return null;
  const tidy = qs.map((q, i) => {
    const labels = new Set(q.options.map((o) => o.label));
    const picked = (answers[i]?.picked ?? []).filter((l) => labels.has(l));
    return { q, picked: q.multiSelect ? picked : picked.slice(0, 1), other: String(answers[i]?.other ?? '').trim().slice(0, 4000) };
  });
  if (tidy.some((t) => !t.picked.length && !t.other)) return null;
  if (tidy.every((t) => !t.other)) {
    const out: Record<string, string> = {};
    for (const t of tidy) out[t.q.question] = t.picked.join(', ');
    return { behavior: 'allow', updatedInput: { ...input, answers: out } };
  }
  const lines = tidy.map((t) => {
    const parts = [t.picked.length ? `picked ${t.picked.map((l) => `"${l}"`).join(', ')}` : '', t.other ? `in their own words: ${t.other}` : ''].filter(Boolean);
    return `- ${t.q.question}\n  ${parts.join('; and ')}`;
  });
  return { behavior: 'deny', message: `The user answered your question${qs.length > 1 ? 's' : ''} from Swarmville, their dashboard, in their own words instead of only picking your options. Treat this as their answer and carry on (don't ask again):\n${lines.join('\n')}` };
}

/** Registers a PermissionRequest. Returns null when it can't be answered from the town. */
export function addAsk(payload: any, reply: (out: object | null) => void, now = Date.now()): AskView | null {
  const tool = String(payload?.tool_name ?? '');
  const sessionId = payload?.session_id;
  if (!tool || typeof sessionId !== 'string') return null;
  if (tool === 'AskUserQuestion' && !askQuestions(payload.tool_input).length) return null; // nothing we could show
  const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [];
  const id = `${now.toString(36)}-${(++seq).toString(36)}`;
  const view: AskView = { id, at: now, canAlways: suggestions.length > 0, ...describeAsk(tool, payload.tool_input) };
  pending.set(id, { view, sessionId, at: now, suggestions, input: payload.tool_input ?? {}, reply });
  return view;
}

/** The hook's request went away (answered in the terminal, timed out, or the agent stopped). */
export function dropAsk(id: string): boolean { return pending.delete(id); }

/**
 * Your answer from the town. Ends the waiting hook with Claude Code's decision object.
 * `answers` goes with "answer" (one per question); `note` with "changes" (what to change in their plan).
 */
export function answerAsk(id: string, decision: Decision, extra: { answers?: Answer[]; note?: string } = {}): { ok: boolean; message?: string } {
  const p = pending.get(id);
  if (!p) return { ok: false, message: 'Already answered, probably in the terminal.' };
  let d: object | null;
  if (p.view.questions && (decision === 'allow' || decision === 'always')) return { ok: false, message: 'Pick an answer first.' };
  if (decision === 'answer') {
    d = questionDecision(p.input, extra.answers ?? []);
    if (!d) return { ok: false, message: 'Answer every question first.' };
  } else if (decision === 'changes') {
    const note = String(extra.note ?? '').trim().slice(0, 4000);
    if (!note) return { ok: false, message: 'Say what should change first.' };
    d = { behavior: 'deny', message: `The user read this from Swarmville, their dashboard, and wants changes before you start:\n${note}\n\nRework it with that in mind and ask again.` };
  } else if (decision === 'deny') {
    d = { behavior: 'deny', message: 'The user said no (answered from their Swarmville town).' };
  } else {
    d = { behavior: 'allow', ...(decision === 'always' && p.suggestions.length ? { updatedPermissions: p.suggestions } : {}) };
  }
  pending.delete(id);
  p.reply({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
  return { ok: true };
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
