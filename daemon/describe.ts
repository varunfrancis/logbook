import path from 'node:path';

/** What a builder is doing in the city: drives the animation. */
export type ActionKind = 'edit' | 'run' | 'read' | 'web' | 'delegate' | 'think';

const short = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const base = (p: unknown) => (typeof p === 'string' && p ? path.basename(p) : '');

/** Turns a tool call into a short human sentence plus an animation kind. */
export function describeTool(name: string, input: any = {}): { text: string; kind: ActionKind } {
  const i = input || {};
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { text: `${name === 'Write' ? 'Writing' : 'Editing'} ${base(i.file_path || i.notebook_path) || 'a file'}`, kind: 'edit' };
    case 'Read':
      return { text: `Reading ${base(i.file_path) || 'a file'}`, kind: 'read' };
    case 'Grep':
      return { text: `Searching for "${short(String(i.pattern ?? ''), 32)}"`, kind: 'read' };
    case 'Glob':
      return { text: `Looking for ${short(String(i.pattern ?? 'files'), 32)}`, kind: 'read' };
    case 'Bash': {
      const cmd = String(i.command ?? '').trim();
      if (/\bgit\s+commit\b/.test(cmd)) return { text: 'Committing changes', kind: 'run' };
      if (/\bgh\s+pr\s+create\b/.test(cmd)) return { text: 'Opening a pull request', kind: 'run' };
      if (/\bgit\s+push\b/.test(cmd)) return { text: 'Pushing to GitHub', kind: 'run' };
      return { text: i.description ? short(String(i.description), 56) : `Running ${short(cmd.split('\n')[0], 40)}`, kind: 'run' };
    }
    case 'WebFetch':
    case 'WebSearch':
      return { text: name === 'WebSearch' ? `Searching the web for "${short(String(i.query ?? ''), 30)}"` : 'Reading a web page', kind: 'web' };
    case 'Task':
    case 'Agent':
      return { text: `Delegating: ${short(String(i.description ?? 'subtask'), 40)}`, kind: 'delegate' };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { text: 'Updating the plan', kind: 'think' };
    case 'AskUserQuestion':
      return { text: 'Asking you a question', kind: 'think' };
    default:
      if (name.startsWith('mcp__')) {
        const [, server = 'tool', tool = ''] = name.split('__');
        return { text: `Using ${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}${tool ? ` · ${tool.replace(/_/g, ' ')}` : ''}`, kind: 'web' };
      }
      return { text: `Using ${name}`, kind: 'think' };
  }
}
