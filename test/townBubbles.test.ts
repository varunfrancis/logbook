import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINISHED_FOR, bubbleKey, townBubbles } from '../web/src/city/townBubbles.ts';

const NOW = 1_800_000_000_000;
const s = (o: Record<string, unknown>) => ({ id: 'a', runner: 'on', status: 'idle', away: false, outcome: 'Done.', lastEventAt: NOW - 1000, ...o }) as any;

test('agents Swarmville runs get a bubble: asking, or just finished', () => {
  const state = { sessions: [
    s({ id: 'ask', outcome: 'Tests pass. Want me to open a PR?' }),
    s({ id: 'done', outcome: 'Fixed the retries and pushed.' }),
    s({ id: 'old', outcome: 'Fixed it.', lastEventAt: NOW - FINISHED_FOR - 1 }),
    s({ id: 'oldask', outcome: 'Which flow do you mean?', lastEventAt: NOW - 86_400_000 }),
  ] };
  assert.deepEqual(townBubbles(state, NOW, new Set(), null).map((b) => `${b.s.id}:${b.kind}`), ['ask:ask', 'done:done', 'oldask:ask']);
});

test('no bubble for terminal agents, busy agents, the open drawer, or after "Later"', () => {
  const state = { sessions: [
    s({ id: 'term', runner: undefined, outcome: 'Want me to open a PR?' }),
    s({ id: 'busy', status: 'running', outcome: 'Want me to open a PR?' }),
    s({ id: 'open', outcome: 'Want me to open a PR?' }),
    s({ id: 'later', outcome: 'Want me to open a PR?' }),
  ] };
  const later = new Set([bubbleKey(state.sessions[3])]);
  assert.deepEqual(townBubbles(state, NOW, later, 'open'), []);
  // "Later" lasts until they say something new
  state.sessions[3].lastEventAt = NOW;
  assert.deepEqual(townBubbles(state, NOW, later, 'open').map((b) => b.s.id), ['later']);
});

test('a raised hand for a question gets the reply bubble; a permission hand does not', () => {
  const state = { sessions: [
    s({ id: 'q', status: 'needs_input', handKind: 'question', needsMessage: 'Should I merge it?', outcome: 'needs input: Should I merge it?' }),
    s({ id: 'perm', status: 'needs_input', handKind: null, needsMessage: 'Claude needs your permission to use Bash', outcome: 'Running the tests.' }),
    s({ id: 'qterm', runner: undefined, status: 'needs_input', handKind: 'question', needsMessage: 'Which terminal?' }),
  ] };
  assert.deepEqual(townBubbles(state, NOW, new Set(), null).map((b) => `${b.s.id}:${b.kind}`), ['q:ask']);
});
