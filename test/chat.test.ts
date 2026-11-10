import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatFromTranscript, mergeChat, transcriptChat, transcriptFile } from '../daemon/chat.ts';

test('finds a transcript that moved to another project folder, and reads it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-chat-'));
  try {
    fs.mkdirSync(path.join(dir, '-new-place'));
    const f = path.join(dir, '-new-place', 'abc-123.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', timestamp: '2026-11-10T11:00:00Z', message: { content: 'hello there' } }) + '\n');
    assert.equal(transcriptFile(path.join(dir, '-old-place', 'abc-123.jsonl'), 'abc-123', dir), f);
    assert.equal(transcriptFile(null, 'missing', dir), null);
    assert.deepEqual(transcriptChat(f).map((l) => l.text), ['hello there']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const L = (o: object) => JSON.stringify(o);
const ts = (s: number) => new Date(Date.UTC(2026, 10, 10, 11, 0, s)).toISOString();

test('a terminal transcript becomes the same chat lines as a runner log', () => {
  const lines = [
    L({ type: 'session-owner' }),
    L({ type: 'user', timestamp: ts(0), message: { role: 'user', content: 'Brainstorm the hand-offs.\nDon’t change files. [Image #1]' } }),
    L({ type: 'user', isMeta: true, timestamp: ts(1), message: { role: 'user', content: 'Caveat: meta' } }),
    L({ type: 'user', timestamp: ts(1), message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }),
    L({ type: 'assistant', timestamp: ts(2), message: { id: 'm1', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/pipeline/rca.py' } }] } }),
    L({ type: 'user', timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', content: 'file text' }] } }),
    L({ type: 'assistant', timestamp: ts(4), message: { id: 'm2', content: [{ type: 'text', text: '## When it hands off' }] } }),
    L({ type: 'assistant', timestamp: ts(4), message: { id: 'm2', content: [{ type: 'text', text: '1. **Asks for a person**' }] } }),
    L({ type: 'assistant', isSidechain: true, timestamp: ts(5), message: { id: 'm3', content: [{ type: 'text', text: 'subagent chatter' }] } }),
    L({ type: 'user', timestamp: ts(6), message: { role: 'user', content: [{ type: 'text', text: 'Go with 2' }, { type: 'image', source: {} }] } }),
    'not json',
  ];
  const chat = chatFromTranscript(lines);
  assert.deepEqual(chat.map((l) => l.kind), ['you', 'tool', 'them', 'you']);
  assert.equal(chat[0].text, 'Brainstorm the hand-offs.\nDon’t change files.');
  assert.deepEqual([chat[1].text, chat[1].tool], ['Reading rca.py', 'read']);
  assert.equal(chat[2].text, '## When it hands off\n\n1. **Asks for a person**');
  assert.equal(chat[2].id, undefined);
  assert.deepEqual([chat[3].text, chat[3].images], ['Go with 2', 1]);
});

test('slash commands show as typed', () => {
  const chat = chatFromTranscript([L({ type: 'user', timestamp: ts(0), message: { content: '<command-name>/review</command-name><command-args>PR 4</command-args>' } })]);
  assert.equal(chat[0].text, '/review PR 4');
});

test('runner lines take over from the transcript where they start', () => {
  const t = [{ at: 1, kind: 'you' as const, text: 'old' }, { at: 5, kind: 'them' as const, text: 'dup' }];
  const r = [{ at: 5, kind: 'them' as const, text: 'dup' }, { at: 6, kind: 'you' as const, text: 'new' }];
  assert.deepEqual(mergeChat(t, r).map((l) => l.text), ['old', 'dup', 'new']);
  assert.deepEqual(mergeChat(t, []).map((l) => l.text), ['old', 'dup']);
});
