import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShipped, needsDecision, todayView, type TodaySession } from '../web/src/crew/today.ts';

const NOW = new Date(2026, 10, 7, 18, 0).getTime();
const H = 3600_000;
const s = (id: string, o: Partial<TodaySession> = {}): TodaySession => ({
  id, status: 'ended', stamp: null, prState: null, prUrl: null, endedAt: NOW - H, lastEventAt: NOW - H,
  kind: null, scheduled: false, projectId: 'p1', ...o,
});

test('today: a merged review counts as shipped, even while a background job sits open', () => {
  assert.equal(isShipped(s('a', { stamp: 'shipped' })), true);
  assert.equal(isShipped(s('b', { status: 'idle', kind: 'bg', prState: 'merged', endedAt: null })), true);
  // still working: not done yet, it's on the Building list
  assert.equal(isShipped(s('c', { status: 'running', prState: 'merged' })), false);
});

test('today: what needs a decision from you', () => {
  assert.equal(needsDecision(s('a', { stamp: 'review', prState: 'open', prUrl: 'x/pull/1' }), NOW), 'review');
  assert.equal(needsDecision(s('b', { stamp: 'unfinished' }), NOW), 'unfinished');
  assert.equal(needsDecision(s('c', { stamp: 'scrapped' }), NOW), 'scrapped');
  // a review that merged later is done; one that was closed is settled
  assert.equal(needsDecision(s('d', { stamp: 'review', prState: 'merged' }), NOW), null);
  assert.equal(needsDecision(s('e', { stamp: 'review', prState: 'closed' }), NOW), null);
  // background job that opened a review and stopped
  assert.equal(needsDecision(s('f', { status: 'idle', kind: 'bg', prState: 'open', prUrl: 'x/pull/2' }), NOW), 'review');
  // an interactive session you're still in, a chat, a scheduled run, and anything older than a week
  assert.equal(needsDecision(s('g', { status: 'idle', kind: 'interactive', prState: 'open', prUrl: 'x/pull/3' }), NOW), null);
  assert.equal(needsDecision(s('h', { stamp: 'chat' }), NOW), null);
  assert.equal(needsDecision(s('i', { stamp: 'unfinished', scheduled: true }), NOW), null);
  assert.equal(needsDecision(s('j', { stamp: 'unfinished', endedAt: NOW - 8 * 24 * H }), NOW), null);
});

test('today: groups shipped work by project, drops what you let go, counts chats', () => {
  const v = todayView([
    s('a', { stamp: 'shipped' }),
    s('b', { stamp: 'shipped', projectId: 'p2' }),
    s('c', { status: 'idle', kind: 'bg', prState: 'merged', projectId: 'p2' }),
    s('d', { stamp: 'shipped', endedAt: NOW - 30 * H }), // yesterday
    s('e', { stamp: 'unfinished' }),
    s('f', { stamp: 'scrapped' }),
    s('g', { stamp: 'chat' }),
  ], new Set(['f']), NOW);
  assert.equal(v.shipped, 3);
  assert.deepEqual(v.done.map((p) => [p.projectId, p.items.length]), [['p2', 2], ['p1', 1]]);
  assert.deepEqual(v.decide.map((x) => [x.s.id, x.why]), [['e', 'unfinished']]);
  assert.deepEqual(v.chats.map((x) => x.id), ['g']);
});
