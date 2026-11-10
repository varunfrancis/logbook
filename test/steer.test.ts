import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../daemon/db.ts';
import { addSteer, steerContext, steerPending, steersFor } from '../daemon/steer.ts';

const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmville-steer-'));
  return { dir, db: openDb(path.join(dir, 'db.sqlite')) };
};

test('a message from the town reaches a terminal agent once, at their next step', () => {
  const { dir, db } = fresh();
  const now = Date.now();
  assert.equal(addSteer(db, 'sess-1', '   '), null);
  addSteer(db, 'sess-1', 'Use the blue button, not the red one.', now);
  const live = new Map([['sess-1', {} as any]]);
  assert.equal(steerPending(db, live, now), true);
  // a hook for some other step or agent hands nothing over
  assert.equal(steerContext(db, { hook_event_name: 'PreToolUse', session_id: 'sess-1' }, 'Varun', now), null);
  assert.equal(steerContext(db, { hook_event_name: 'PostToolUse', session_id: 'sess-2' }, 'Varun', now), null);
  const text = steerContext(db, { hook_event_name: 'PostToolUse', session_id: 'sess-1' }, 'Varun', now + 1000) ?? '';
  assert.match(text, /from Varun, the person you work for/);
  assert.match(text, /> Use the blue button, not the red one\./);
  // delivered: not handed over twice, and the drawer shows it reached them
  assert.equal(steerContext(db, { hook_event_name: 'PostToolUse', session_id: 'sess-1' }, 'Varun', now + 2000), null);
  assert.equal(steerPending(db, live, now + 2000), false);
  assert.deepEqual(steersFor(db, 'sess-1', now + 2000).map((m) => m.delivered), [true]);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('a message that never reached the agent goes stale instead of arriving hours late', () => {
  const { dir, db } = fresh();
  const then = Date.now() - 7 * 3600_000;
  addSteer(db, 'sess-1', 'Stop before you deploy.', then);
  assert.equal(steerPending(db, new Map([['sess-1', {} as any]])), false);
  assert.equal(steerContext(db, { hook_event_name: 'PostToolUse', session_id: 'sess-1' }, 'Varun'), null);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('the hook only asks the daemon after a step when a message is waiting', () => {
  const { dir } = fresh();
  const hook = path.join(dir, 'hook.sh');
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'hook', 'swarmville-hook.sh'), hook);
  const run = () => execFileSync('sh', [hook], { input: '{"hook_event_name":"PostToolUse","session_id":"x"}', env: { ...process.env, SWARMVILLE_PORT: '1' } }).toString();
  // nothing waiting: fire-and-forget, prints nothing; with the marker it asks (and the dead port answers nothing)
  assert.equal(run(), '');
  fs.writeFileSync(path.join(dir, 'steer.pending'), '1');
  assert.equal(run(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
