import { execFile } from 'node:child_process';
import type { StateView } from './types.ts';
import { env } from './legacy.ts';

const prev = new Map<string, string>();
let primed = false;

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function notify(title: string, body: string) {
  if (process.platform !== 'darwin' || env('NO_NOTIFY')) return;
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

/** Fires a macOS notification when a session starts needing you. Skips the first pass so a restart doesn't spam. */
export function notifyTransitions(state: StateView) {
  const names = new Map(state.projects.map((p) => [p.id, p.name]));
  for (const s of state.sessions) {
    const before = prev.get(s.id);
    if (primed && s.status === 'needs_input' && before !== 'needs_input') {
      notify(`${names.get(s.projectId ?? '') ?? 'An agent'} needs you`, `${s.title}: ${s.needsMessage ?? 'Waiting for approval'}`);
    }
    prev.set(s.id, s.status);
  }
  primed = true;
}
