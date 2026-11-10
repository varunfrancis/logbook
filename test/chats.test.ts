import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatGroup, chatList, chatPreview, chatsBadge, firstLine, isUnread, startOfDay } from '../web/src/chats.ts';

const NOW = new Date(2026, 10, 10, 15, 0).getTime();
const DAY = startOfDay(NOW);
const H = 3600_000;
let n = 0;
const mk = (o: Record<string, unknown> = {}): any => ({
  id: `s${++n}`, status: 'idle', away: false, endedAt: null, lastEventAt: NOW - H, startedAt: NOW - 2 * H, runner: undefined,
  agent: { name: 'Tiki Jr.', title: 'Tiki Jr. the Builder' }, focus: null, title: 'job', action: null, ask: null, needsMessage: null, outcome: null, ...o,
});

test('groups agents: hand up, working, your turn, earlier today, older', () => {
  assert.equal(chatGroup(mk({ status: 'needs_input' }), DAY), 'needs');
  assert.equal(chatGroup(mk({ status: 'running' }), DAY), 'working');
  assert.equal(chatGroup(mk({ status: 'idle' }), DAY), 'turn');
  assert.equal(chatGroup(mk({ status: 'idle', away: true, lastEventAt: NOW - 3 * H }), DAY), 'earlier');
  assert.equal(chatGroup(mk({ status: 'ended', endedAt: NOW - 2 * H }), DAY), 'earlier');
  assert.equal(chatGroup(mk({ status: 'ended', endedAt: DAY - H }), DAY), 'older');
});

test('the list shows today in group order, newest first; search also finds older agents by job or project', () => {
  const old = mk({ status: 'ended', endedAt: DAY - 5 * H, focus: 'Fix login', agent: { name: 'Kip', title: 'Kip the Builder' } });
  const a = mk({ status: 'idle', lastEventAt: NOW - 2 * H });
  const b = mk({ status: 'idle', lastEventAt: NOW - H });
  const c = mk({ status: 'running', projectName: 'CAT Quant Prep' });
  const d = mk({ status: 'needs_input' });
  const list = chatList([old, a, b, c, d], NOW);
  assert.deepEqual(list.map((g) => g.group), ['needs', 'working', 'turn']);
  assert.deepEqual(list[2].items.map((s) => s.id), [b.id, a.id]);
  assert.deepEqual(chatList([old, a], NOW, 'login').map((g) => [g.group, g.items[0].id]), [['older', old.id]]);
  assert.deepEqual(chatList([old, a, c], NOW, 'quant').flatMap((g) => g.items.map((s) => s.id)), [c.id]);
});

test('previews say what they ask, what they are doing, or the first line of their reply', () => {
  assert.equal(chatPreview(mk({ status: 'needs_input', ask: { title: 'Run npm test?' } }), 'plain'), 'Run npm test?');
  assert.equal(chatPreview(mk({ status: 'running', action: 'Reading Chat.tsx' }), 'plain'), 'Reading Chat');
  assert.equal(chatPreview(mk({ outcome: '## Done\n\n**Merged** as [#99](https://x)' }), 'plain'), 'Done');
  assert.equal(chatPreview(mk({ outcome: null }), 'plain'), 'Ready for your next message');
  assert.equal(firstLine('---\n- **Merged** as [#99](https://x)'), 'Merged as #99');
  assert.equal(firstLine('x'.repeat(200), 20)?.length, 20);
});

test('unread: only Swarmville-run agents that stopped after you last looked, and only since you started using Chats', () => {
  const since = NOW - 5 * H;
  const s = mk({ runner: 'on', status: 'idle', lastEventAt: NOW - H });
  assert.equal(isUnread(s, {}, since), true);
  assert.equal(isUnread(s, { [s.id]: NOW - 30_000 }, since), false);
  assert.equal(isUnread({ ...s, status: 'running' }, {}, since), false);
  assert.equal(isUnread({ ...s, runner: undefined }, {}, since), false); // in your terminal: you saw it there
  assert.equal(isUnread(s, {}, NOW), false);
  assert.equal(chatsBadge([s, mk({ status: 'needs_input' }), mk()], {}, since), 2);
});
