import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSoundEvents, type Seen } from '../web/src/crew/agentSounds.ts';

const s = (id: string, status: string) => ({ id, status });

test('agent sounds: hand, start and finish from status changes', () => {
  const seen: Seen = new Map([['a', 'running'], ['b', 'idle']]);
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'running'), s('b', 'idle')]), []);
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'needs_input'), s('b', 'idle')]), ['hand']);
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'needs_input'), s('b', 'idle')]), [], 'the same raised hand rings once');
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'running'), s('b', 'idle')]), []);
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'idle'), s('b', 'idle')]), ['finish']);
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'idle'), s('b', 'running')]), [], 'an agent we knew picking up again is not new');
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'idle'), s('b', 'ended')]), ['finish']);
});

test('agent sounds: a new agent starts work on its first move', () => {
  const seen: Seen = new Map();
  assert.deepEqual(agentSoundEvents(seen, [s('n', 'idle')]), [], 'session opened, nothing asked yet');
  assert.deepEqual(agentSoundEvents(seen, [s('n', 'running')]), ['start']);
  assert.deepEqual(agentSoundEvents(seen, [s('m', 'needs_input')]), ['hand'], 'a hand outranks starting');
  assert.deepEqual(agentSoundEvents(seen, [s('x', 'ended')]), [], 'an old finished agent showing up is not news');
});

test('agent sounds: most urgent first, one of each', () => {
  const seen: Seen = new Map([['a', 'running'], ['b', 'running'], ['c', 'running']]);
  assert.deepEqual(agentSoundEvents(seen, [s('a', 'idle'), s('b', 'needs_input'), s('c', 'needs_input'), s('d', 'running')]), ['hand', 'finish', 'start']);
});
