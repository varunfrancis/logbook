import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../daemon/db.ts';
import { usdOf } from '../daemon/pricing.ts';
import { buildState } from '../daemon/state.ts';
import { ingestFile } from '../daemon/transcripts.ts';

test('API prices: by model and token type', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read; cache writes 1.25x (5 min) or 2x (1 hour) the input price; fast mode doubles it
  assert.equal(usdOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 }), 24.2);
  assert.equal(usdOf('claude-opus-5-5', { cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } }), 13);
  assert.equal(usdOf('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
  assert.equal(usdOf('claude-sonnet-5-5', { output_tokens: 1e6 }), 10);
  assert.equal(usdOf('claude-haiku-4-5-20251001', { input_tokens: 1e6 }), 1);
});

test('cost: each reply counts once, and "today" means replies sent today', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarmville-test-')));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const now = new Date(2026, 10, 7, 18, 0).getTime(), yesterday = now - 24 * 3600_000;
  const reply = (id: string, at: number) => JSON.stringify({ type: 'assistant', cwd: dir, timestamp: new Date(at).toISOString(), message: { id, model: 'claude-opus-5-5', content: [], usage: { output_tokens: 1e5 } } }); // $2 each
  const write = (name: string, lines: string[]) => { const f = path.join(dir, `${name}.jsonl`); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
  // A session from yesterday that did a little more today, then was resumed: the new transcript repeats both earlier replies.
  ingestFile(db, write('aaaaaaaa-0000-0000-0000-000000000001', [reply('m1', yesterday), reply('m2', now - 3600_000)]));
  ingestFile(db, write('aaaaaaaa-0000-0000-0000-000000000002', [reply('m1', yesterday), reply('m2', now - 3600_000), reply('m3', now - 600_000)]));
  const st = buildState(db, new Map(), now);
  const cents = (n: number) => Math.round(n * 100) / 100;
  assert.equal(cents(st.totals.costToday), 4); // m2 + m3: not yesterday's m1, and nothing twice
  assert.equal(cents(st.projects.reduce((n, p) => n + p.costUsd, 0)), 6); // all three replies, once each
  assert.deepEqual(st.costBreakdown.map((p) => cents(p.usd)), [4]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
