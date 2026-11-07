import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeTool } from '../daemon/describe.ts';
import { cleanPrompt, parseLines } from '../daemon/transcripts.ts';
import { parseGithubRemote, rootFromPath } from '../daemon/git.ts';
import { spiral } from '../daemon/projects.ts';
import { floorsFor, projectState, sessionStatus } from '../daemon/status.ts';
import { openDb } from '../daemon/db.ts';
import { handleHook } from '../daemon/hooks.ts';
import { buildState } from '../daemon/state.ts';

const line = (o: object) => JSON.stringify(o);

test('describeTool turns tool calls into short sentences and animation kinds', () => {
  assert.deepEqual(describeTool('Edit', { file_path: '/a/b/Tooltip.tsx' }), { text: 'Editing Tooltip.tsx', kind: 'edit' });
  assert.equal(describeTool('Bash', { command: 'git commit -m "x"' }).text, 'Committing changes');
  assert.equal(describeTool('Bash', { command: 'npm test', description: 'Run tests' }).text, 'Run tests');
  assert.equal(describeTool('Grep', { pattern: 'foo' }).kind, 'read');
  assert.equal(describeTool('mcp__claude_ai_Linear__get_issue', {}).text, 'Using Linear · get issue');
});

test('cleanPrompt keeps typed prompts and slash commands, drops system noise', () => {
  assert.equal(cleanPrompt('fix the [Image #1] bug'), 'fix the bug');
  assert.equal(cleanPrompt('<command-name>/plan</command-name><command-args>build a city</command-args>'), '/plan build a city');
  assert.equal(cleanPrompt('<local-command-stdout>ok</local-command-stdout>'), null);
  assert.equal(cleanPrompt('[Request interrupted by user]'), null);
});

test('parseLines dedupes streamed assistant messages and tracks the latest action', () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
  const lines = [
    line({ type: 'user', sessionId: 's1', cwd: '/w/app', gitBranch: 'feat/x', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'add a city view' } }),
    line({ type: 'assistant', timestamp: '2026-11-01T10:00:05Z', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [{ type: 'thinking' }] } }),
    line({ type: 'assistant', timestamp: '2026-11-01T10:00:06Z', message: { id: 'm1', usage, content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/app/City.tsx' } }] } }),
    line({ type: 'assistant', timestamp: '2026-11-01T10:00:09Z', message: { id: 'm2', usage, content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'gh pr create --fill' } }] } }),
    line({ type: 'user', timestamp: '2026-11-01T10:00:12Z', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'https://github.com/acme/app/pull/42' }] } }),
    line({ type: 'ai-title', aiTitle: 'city view', sessionId: 's1' }),
    'not json',
  ];
  const d = parseLines(lines);
  assert.equal(d.tokIn, 20); // m1 counted once, m2 once
  assert.equal(d.tokOut, 10);
  assert.equal(d.prompts, 1);
  assert.equal(d.firstPrompt, 'add a city view');
  assert.equal(d.aiTitle, 'city view');
  assert.equal(d.prUrl, 'https://github.com/acme/app/pull/42');
  assert.equal(d.action?.text, 'Opening a pull request');
  assert.equal(d.branch, 'feat/x');
  assert.deepEqual(d.files.map((f) => f.p), ['/w/app/City.tsx']);
  assert.equal(d.edits, 1);
  // continuing from the last message id must not double count
  const more = parseLines([line({ type: 'assistant', timestamp: '2026-11-01T10:00:20Z', message: { id: 'm2', usage, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: shipped it.' }] } })], d.state);
  assert.equal(more.tokIn, 0);
  assert.equal(more.turnEnded, true);
  assert.equal(more.outcome, 'Done: shipped it.');
  assert.deepEqual(more.segments.map((g) => g.kind), ['work']); // prompt at 10:00:00 until the turn ended
});

test('parser counts the same error three times, test runs and waits for answers', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString();
  const err = (id: string, s: number) => [
    line({ type: 'assistant', timestamp: at(s), message: { id: 'a' + id, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } }),
    line({ type: 'user', timestamp: at(s + 1), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Error: cannot read thread_ts of undefined at line 12' }] } }),
  ];
  const d = parseLines([
    line({ type: 'user', timestamp: at(0), message: { content: 'fix the slack alert' } }),
    ...err('x1', 2), ...err('x2', 5), ...err('x3', 8),
    line({ type: 'assistant', timestamp: at(10), message: { id: 'q', content: [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: { questions: [{ question: 'Use the new channel?' }] } }] } }),
    line({ type: 'user', timestamp: at(40), message: { content: [{ type: 'tool_result', tool_use_id: 'ask1', content: 'yes' }] } }),
  ]);
  assert.equal(d.errors.length, 3);
  assert.equal(new Set(d.errors.map((e) => e.sig)).size, 1);
  assert.equal(d.testsFail, 3);
  assert.equal(d.asks, 1);
  assert.deepEqual(d.segments.find((g) => g.kind === 'wait'), { start: Date.parse(at(10)), end: Date.parse(at(40)), kind: 'wait' });
});

test('git helpers parse remotes and collapse worktrees into their repo', () => {
  assert.equal(parseGithubRemote('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(parseGithubRemote('https://github.com/acme/app'), 'acme/app');
  assert.equal(parseGithubRemote('https://gitlab.com/acme/app'), null);
  assert.deepEqual(rootFromPath('/Users/v/Work/CAT/.claude/worktrees/seo-foundation'), { root: '/Users/v/Work/CAT', worktree: 'seo-foundation' });
  assert.deepEqual(rootFromPath('/Users/v/Work/CAT'), { root: '/Users/v/Work/CAT', worktree: null });
});

test('spiral gives unique, stable lots around the center', () => {
  const cells = Array.from({ length: 49 }, (_, i) => spiral(i).join(','));
  assert.equal(new Set(cells).size, 49);
  assert.deepEqual(spiral(0), [0, 0]);
  assert.deepEqual(spiral(1), [1, 0]);
});

test('status rules', () => {
  const now = 1_000_000;
  const live = { pid: 1, sessionId: 'a', cwd: '/', kind: 'interactive', status: 'busy', name: null, updatedAt: null, startedAt: null };
  assert.equal(sessionStatus({}, undefined, now), 'ended');
  assert.equal(sessionStatus({}, live, now), 'running');
  assert.equal(sessionStatus({}, { ...live, status: 'idle' }, now), 'idle');
  assert.equal(sessionStatus({ hook_state: 'needs_input', hook_state_at: now - 1000 }, { ...live, status: 'idle' }, now), 'needs_input');
  assert.equal(sessionStatus({ hook_state: 'running', hook_state_at: now - 2000 }, undefined, now), 'running'); // registry lag grace
  assert.equal(floorsFor(1e5), 3);
  assert.equal(floorsFor(1e7), 7);
  assert.equal(projectState({ root: '/x', sessionsTotal: 3, lastActivity: now }, [{ status: 'ended' }, { status: 'needs_input' }], now), 'needs');
  assert.equal(projectState({ root: null, sessionsTotal: 0, lastActivity: null }, [], now), 'lot');
  const day = 24 * 3600_000, T = 100 * day;
  assert.equal(projectState({ root: '/x', sessionsTotal: 1, lastActivity: T }, [{ status: 'running' }], T), 'site');
  assert.equal(projectState({ root: '/x', sessionsTotal: 1, lastActivity: T - 2 * day }, [{ status: 'ended' }], T), 'construction');
  assert.equal(projectState({ root: '/x', sessionsTotal: 1, lastActivity: T - 10 * day }, [], T), 'recent');
  assert.equal(projectState({ root: '/x', sessionsTotal: 1, lastActivity: T - 40 * day }, [], T), 'done');
});

test('hooks drive a session from start to needs-you to closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const base = { session_id: 'sess-1', cwd: dir, transcript_path: path.join(dir, 't.jsonl') };
  const t0 = Date.now();
  handleHook(db, { ...base, hook_event_name: 'SessionStart', source: 'startup' }, t0);
  handleHook(db, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'ship the city' }, t0 + 10);
  handleHook(db, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/scene.ts' } }, t0 + 20);
  let s = buildState(db, new Map(), t0 + 30).sessions[0];
  assert.equal(s.status, 'running');
  assert.equal(s.action, 'Editing scene.ts');
  assert.equal(s.title, 'ship the city');
  handleHook(db, { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }, t0 + 40);
  s = buildState(db, new Map(), t0 + 50).sessions[0];
  assert.equal(s.status, 'needs_input');
  assert.match(s.needsMessage ?? '', /permission/);
  handleHook(db, { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, t0 + 60);
  const st = buildState(db, new Map(), t0 + 70);
  assert.equal(st.sessions[0].status, 'ended');
  assert.equal(st.projects[0].state, 'construction');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one resident per project on main, helpers for parallel windows, own characters for worktrees', async () => {
  const { refreshAgents, agentOf } = await import('../daemon/state.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const now = Date.now();
  const ins = db.prepare('INSERT INTO sessions(id, project_id, branch, worktree, started_at, last_event_at) VALUES(?, ?, ?, ?, ?, ?)');
  ins.run('old', 'gh:a/cat', 'main', null, now - 9e6, now - 8e6); // closed earlier on main
  ins.run('m1', 'gh:a/cat', 'main', null, now - 5000, now);     // live on main, first
  ins.run('m2', 'gh:a/cat', 'main', null, now - 1000, now);     // live on main, second
  ins.run('wt', 'gh:a/cat', 'seo', 'seo', now - 3000, now);     // live in a worktree
  const live = new Map(['m1', 'm2', 'wt'].map((id) => [id, { pid: 1, sessionId: id, cwd: '/x', kind: 'interactive', status: 'busy', name: null, updatedAt: null, startedAt: null }]));
  refreshAgents(db, 0, live);
  const row = (id: string) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
  const [old, m1, m2, wt] = ['old', 'm1', 'm2', 'wt'].map((id) => agentOf(row(id)));
  assert.equal(old.key, m1.key);           // same resident across sessions
  assert.equal(m1.role, 'resident');
  assert.equal(m2.role, 'helper');
  assert.equal(m2.name, `${m1.name} Jr.`);
  assert.equal(m2.color, m1.color);
  assert.equal(wt.role, 'workbench');
  assert.notEqual(wt.key, m1.key);
  // m2 stays a helper in history after it closes
  refreshAgents(db, 0, new Map());
  assert.equal(agentOf(row('m2')).role, 'helper');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a character keeps one job: the one they do most', async () => {
  const { refreshAgents, agentOf } = await import('../daemon/state.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const ins = db.prepare('INSERT INTO sessions(id, project_id, branch, started_at, last_event_at, first_prompt) VALUES(?, ?, ?, ?, ?, ?)');
  ins.run('a', 'gh:a/bot', 'main', 1, 2, 'fix the broken login');
  ins.run('b', 'gh:a/bot', 'main', 3, 4, 'fix crash on threads');
  ins.run('c', 'gh:a/bot', 'main', 5, 6, 'add a pricing page');
  refreshAgents(db, 0, new Map());
  const jobs = ['a', 'b', 'c'].map((id) => agentOf(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any).job);
  assert.deepEqual(jobs, ['plumber', 'plumber', 'plumber']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
