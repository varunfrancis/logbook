import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPreview, chatProjects, chatState, chatTask, chatsBadge, firstLine, isUnread, startOfDay } from '../web/src/chats.ts';

const NOW = new Date(2026, 10, 10, 15, 0).getTime();
const DAY = startOfDay(NOW);
const H = 3600_000;
let n = 0;
const mk = (o: Record<string, unknown> = {}): any => ({
  id: `s${++n}`, status: 'idle', away: false, endedAt: null, lastEventAt: NOW - H, startedAt: NOW - 2 * H, runner: undefined,
  agent: { name: 'Tiki Jr.', title: 'Tiki Jr. the Builder' }, focus: null, title: 'job', prompts: 1, projectId: 'p1', projectName: 'Agent Logbook', action: null, ask: null, needsMessage: null, outcome: null, ...o,
});

test('states and task names', () => {
  assert.equal(chatState(mk({ status: 'needs_input' })), 'needs');
  assert.equal(chatState(mk({ status: 'running' })), 'working');
  assert.equal(chatState(mk({ status: 'idle' })), 'turn');
  assert.equal(chatState(mk({ status: 'idle', away: true })), 'done');
  assert.equal(chatState(mk({ status: 'ended' })), 'done');
  assert.equal(chatTask(mk({ focus: 'Check paid users', title: 'x' })), 'Check paid users');
  assert.equal(chatTask(mk({ title: 'drawer night mode focus' })), 'drawer night mode focus');
  assert.equal(chatTask(mk({ title: 'New session' })), null);
});

test('the list is like Slack: a section per project with live tasks (hands first), one Done today section, empty sessions left out', () => {
  const hand = mk({ status: 'needs_input', focus: 'Approve the plan', projectId: 'p2', projectName: 'CAT Quant Prep', lastEventAt: NOW - 2 * H });
  const turn2 = mk({ status: 'idle', focus: 'Check paid users', projectId: 'p2', projectName: 'CAT Quant Prep', lastEventAt: NOW - H });
  const turn = mk({ status: 'idle', focus: 'Estimate PR timeline', lastEventAt: NOW - 10 * 60_000 });
  const run = mk({ status: 'running', focus: 'Build chat', lastEventAt: NOW - 3 * H });
  const done = mk({ status: 'ended', focus: 'Fix VS Code', endedAt: NOW - 2 * H, lastEventAt: NOW - 2 * H });
  const old = mk({ status: 'ended', focus: 'Fix login', endedAt: DAY - 5 * H, lastEventAt: DAY - 5 * H });
  const empty = mk({ status: 'idle', title: 'New session', prompts: 0 });
  const quiet = mk({ status: 'ended', focus: 'Install deps', projectId: 'p3', projectName: 'Portfolio', endedAt: NOW - H, lastEventAt: NOW - H });
  const { projects, done: doneToday } = chatProjects([quiet, old, done, run, turn, turn2, empty, hand], NOW);
  // the project with a raised hand comes first, and the hand is first in it
  assert.deepEqual(projects.map((p) => [p.name, p.needs]), [['CAT Quant Prep', 1], ['Agent Logbook', 0]]);
  assert.deepEqual(projects[0].live.map((s) => s.id), [hand.id, turn2.id]);
  assert.deepEqual(projects[1].live.map((s) => s.id), [run.id, turn.id]);
  assert.deepEqual(doneToday.map((s) => s.id), [quiet.id, done.id]);
  assert.ok(!projects.flatMap((p) => p.live).some((s) => s.id === empty.id));
  // search: by task or project, older work included
  assert.deepEqual(chatProjects([old, done], NOW, 'login').done.map((s) => s.id), [old.id]);
  assert.deepEqual(chatProjects([quiet, done, turn2], NOW, 'quant').projects.map((p) => p.name), ['CAT Quant Prep']);
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
  // Clocked out: the reply still shows as new on its row, but the tab badge doesn't count it.
  const off = { ...s, id: 'off', status: 'ended', runner: 'off' };
  assert.equal(isUnread(off, {}, since), true);
  assert.equal(chatsBadge([off], {}, since), 0);
  assert.equal(chatsBadge([{ ...s, away: true }], {}, since), 0);
});
