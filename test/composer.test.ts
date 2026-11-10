import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendsOnEnter } from '../web/src/welcome/composer.ts';
import { MOVES, MOVES_FOR_JOB } from '../web/src/welcome/moves.ts';

test('Enter sends; Shift+Enter and an unfinished input method do not', () => {
  assert.equal(sendsOnEnter({ key: 'Enter', shiftKey: false }), true);
  assert.equal(sendsOnEnter({ key: 'Enter', shiftKey: true }), false);
  assert.equal(sendsOnEnter({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(sendsOnEnter({ key: 'a', shiftKey: false }), false);
});

test('every way to start has a one-word pill label', () => {
  for (const m of Object.values(MOVES)) assert.match(m.short, /^\S+$/, m.id);
  // The Chats composer shows the builder's three; they should read as Plan / Brainstorm / Build.
  assert.deepEqual(MOVES_FOR_JOB.builder.map((id) => MOVES[id].short), ['Plan', 'Brainstorm', 'Build']);
});
