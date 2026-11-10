import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../daemon/db.ts';
import { parsePlainReply, plainNextOutcome } from '../daemon/plain.ts';
import { saidOf } from '../web/src/copy.ts';

test('plain summary: the reply is kept as is, refusals and essays are dropped', () => {
  assert.equal(parsePlainReply('Summary: "Clicking Go to now opens the window you already have. It’s live."'), 'Clicking Go to now opens the window you already have. It’s live.');
  assert.equal(parsePlainReply('"Go to" now uses the window you already have.'), '"Go to" now uses the window you already have.');
  assert.equal(parsePlainReply('Sorry, I can’t help with that.'), null);
  assert.equal(parsePlainReply('x'.repeat(400)), null);
  assert.equal(parsePlainReply(null), null);
});

test('plain voice shows the plain line when there is one; technical keeps the agent’s words', () => {
  const s = { outcome: 'Merged as PR #98, CI green.', plainOutcome: 'It’s live.' };
  assert.equal(saidOf(s, 'plain'), 'It’s live.');
  assert.equal(saidOf(s, 'technical'), 'Merged as PR #98, CI green.');
  assert.equal(saidOf({ outcome: 'Done.', plainOutcome: null }, 'plain'), 'Done.');
});

test('plain summary: only settled turns, and short or error messages never cost a run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmville-plain-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const now = Date.now();
  const ins = db.prepare('INSERT INTO sessions (id, project_id, cwd, outcome, current_action, last_event_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('busy', 'p', dir, 'Still working through the list of things to change here.', 'Editing x.ts', now - 60_000, now - 90_000); // mid-turn
  ins.run('fresh', 'p', dir, 'Just finished writing the whole thing up for you now.', null, now - 2_000, now - 90_000); // not settled yet
  ins.run('short', 'p', dir, 'Done.', null, now - 60_000, now - 90_000);
  assert.equal(await plainNextOutcome(db, now), false);
  const rows = db.prepare('SELECT id, plain_for, plain_outcome FROM sessions ORDER BY id').all() as { id: string; plain_for: string | null; plain_outcome: string | null }[];
  assert.deepEqual(rows.map((r) => [r.id, r.plain_for, r.plain_outcome]), [['busy', null, null], ['fresh', null, null], ['short', 'Done.', null]]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
