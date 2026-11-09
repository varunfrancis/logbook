import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runners, controlResponse, safeId } from '../daemon/runners.ts';
import { claudeArgs, entriesFrom, userMessage } from '../daemon/runner.ts';
import { addRunnerAsk, answerAsk, asksBySession, settleSession } from '../daemon/asks.ts';

const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); }
};

test('stream-json in and out: messages, images, the arguments', () => {
  assert.deepEqual(userMessage('hi'), { type: 'user', message: { role: 'user', content: 'hi' } });
  const withImage = userMessage('look', [{ mediaType: 'image/png', data: 'AAA' }]) as any;
  assert.deepEqual(withImage.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } });
  assert.deepEqual(withImage.message.content[1], { type: 'text', text: 'look' });
  const id = '0f9b7d2e-1111-4222-8333-944455556666';
  assert.ok(claudeArgs({ id }).join(' ').includes(`--permission-prompt-tool stdio --session-id ${id}`));
  assert.ok(claudeArgs({ id, resume: true, plan: true }).join(' ').endsWith(`--resume ${id} --permission-mode plan`));
});

test('what Claude says becomes chat lines; a subagent\'s chatter stays out', () => {
  const said = entriesFrom({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: ' Done. ' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts' } }] } }, 5);
  assert.deepEqual(said, [{ at: 5, kind: 'them', text: 'Done.' }, { at: 5, kind: 'tool', text: 'Edit', tool: 'Edit', input: { file_path: '/a/b.ts' } }]);
  assert.deepEqual(entriesFrom({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'inner' }] } }), []);
  assert.equal(entriesFrom({ type: 'result', result: 'ok', is_error: true }, 1)[0].error, true);
  assert.deepEqual(entriesFrom({ type: 'system', subtype: 'init' }), []);
});

test('a yes over stdio carries the tool input; a no carries the reason', () => {
  assert.deepEqual(controlResponse({ behavior: 'allow' }, { command: 'ls' }), { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.deepEqual(controlResponse({ behavior: 'allow', updatedInput: { answers: { Q: 'A' } }, updatedPermissions: [1] }, {}), { behavior: 'allow', updatedInput: { answers: { Q: 'A' } }, updatedPermissions: [1] });
  assert.deepEqual(controlResponse({ behavior: 'deny', message: 'No thanks' }, {}), { behavior: 'deny', message: 'No thanks' });
  assert.equal(safeId('../../etc/passwd'), false);
});

test('a runner agent\'s ask survives turn events, and the answer goes back as a decision', () => {
  const got: any[] = [];
  const v = addRunnerAsk('runner-ask-1', 'AskUserQuestion', { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] }, [], (d) => got.push(d))!;
  assert.ok(v.questions?.length);
  settleSession('runner-ask-1'); // a prompt or a turn ending: no terminal answered it, so it stays
  assert.equal(asksBySession().get('runner-ask-1')?.id, v.id);
  assert.equal(answerAsk(v.id, 'answer', { answers: [{ picked: ['B'] }] }).ok, true);
  assert.deepEqual(got[0].updatedInput.answers, { 'Which?': 'B' });
});

test('runner end to end with a stand-in Claude: start, answer, follow up, clock out, come back, hand over', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-runners-'));
  const argsFile = path.join(dir, 'args.jsonl');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.resolve(import.meta.dirname, 'fixtures/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });
  process.env.FAKE_CLAUDE_ARGS = argsFile;
  const asks: { id: string; tool: string; answer: (d: object) => void }[] = [];
  let changes = 0;
  const r = new Runners(path.join(dir, 'runners'), {
    ask: (id, a, answer) => asks.push({ id, tool: a.toolName, answer }),
    askGone: () => {},
    change: () => { changes++; },
  }, () => bin);
  t.after(async () => { for (const id of r.ids()) await r.stop(id, 3000); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.FAKE_CLAUDE_ARGS; });

  const started = r.start({ cwd: dir, prompt: 'add a toggle' });
  assert.equal(started.ok, true);
  const id = started.sessionId!;
  assert.ok(r.running(id) && r.knows(id));
  assert.equal(r.states().get(id), 'on');

  // Claude asks to run something: the town gets it, and our yes goes back
  await until(() => asks.length === 1);
  assert.equal(asks[0].tool, 'Bash');
  asks[0].answer({ behavior: 'allow' });
  await until(() => r.chat(id).some((l) => l.kind === 'done'));
  assert.deepEqual(r.chat(id).map((l) => l.kind), ['you', 'tool', 'them', 'done']);
  assert.equal(r.chat(id)[2].text, 'heard: add a toggle (allow)');
  assert.ok(changes > 0);

  // a follow-up with a picture, while it's running
  assert.equal(r.send(id, 'smaller please', [{ mediaType: 'image/png', data: 'iVBOR' }]).ok, true);
  await until(() => asks.length === 2);
  asks[1].answer({ behavior: 'deny', message: 'not that' });
  await until(() => r.chat(id).filter((l) => l.kind === 'done').length === 2);
  assert.equal(r.chat(id).find((l) => l.kind === 'you' && l.images === 1)?.text, 'smaller please');
  assert.match(r.chat(id).at(-1)!.text, /heard: smaller please \+1 image \(deny\)/);

  // clock out: the conversation stays, and the next message brings them back on the same conversation
  assert.equal(await r.stop(id), true);
  assert.equal(r.states().get(id), 'off');
  const back = r.send(id, 'one more thing');
  assert.equal(back.ok, true);
  await until(() => asks.length === 3);
  const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(runs[0].includes('--session-id') && runs[0].includes(id));
  assert.ok(runs[1].includes('--resume') && runs[1].includes(id));
  asks[2].answer({ behavior: 'allow' });
  await until(() => r.chat(id).filter((l) => l.kind === 'done').length === 3);

  // take over in a terminal: Swarmville lets go
  assert.equal(await r.stop(id), true);
  r.release(id);
  assert.equal(r.knows(id), false);
  assert.equal(r.states().has(id), false);
});
