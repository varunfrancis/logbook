import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeTool } from '../daemon/describe.ts';
import { cleanPrompt, parseLines } from '../daemon/transcripts.ts';
import { parseGithubRemote, rootFromPath } from '../daemon/git.ts';
import { spiral } from '../daemon/projects.ts';
import { floorsFor, projectState, scopeOf, sessionStatus, buildingSize } from '../daemon/status.ts';
import { openDb } from '../daemon/db.ts';
import { handleHook } from '../daemon/hooks.ts';
import { buildState } from '../daemon/state.ts';
import { isClaude, stopProcess } from '../daemon/stop.ts';

test('clock out only signals a real Claude process: TERM after a grace period, KILL only if it hangs on', () => {
  assert.equal(isClaude('claude bg-spare'), true);
  assert.equal(isClaude('/Users/u/.local/share/claude/versions/2.1.319'), true);
  assert.equal(isClaude('/opt/homebrew/bin/claude --resume abc'), true);
  assert.equal(isClaude('node daemon/server.ts'), false);
  assert.equal(isClaude(null), false);

  const entry = { pid: 42, sessionId: 's', cwd: '/w', kind: 'interactive', status: 'idle', name: null, updatedAt: null, startedAt: null };
  const run = (cmd: string | null, stillAlive: boolean) => {
    const sent: string[] = [];
    const queue: (() => void)[] = [];
    const r = stopProcess(entry, { command: () => cmd, alive: () => stillAlive, signal: (_p, s) => { sent.push(s); }, later: (fn) => { queue.push(fn); } });
    while (queue.length) queue.shift()!();
    return { r, sent };
  };
  assert.deepEqual(run('claude', true).sent, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(run('claude', false).sent, []); // closing the terminal already ended it
  const recycled = run('/usr/bin/vim', true);
  assert.equal(recycled.r.ok, false);
  assert.deepEqual(recycled.sent, []);
  assert.equal(stopProcess(undefined, {} as any).ok, false);
});

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
  assert.equal(scopeOf({ lines: 1000, commits: 2, tokens: 2e6 }), 2300);
  assert.equal(buildingSize(1000, 1000), 1);
  assert.equal(buildingSize(125, 1000), 0.5); // 1/8 the scope → half each dimension → 1/8 the volume
  assert.equal(buildingSize(0, 1000), 0);
  assert.equal(floorsFor(1), 10);
  assert.equal(floorsFor(0.5), 5);
  assert.equal(floorsFor(0), 1);
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

test("today's cost breaks down by project, then by agent, and adds up to the total", async () => {
  const { refreshAgents, buildState } = await import('../daemon/state.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const now = Date.now();
  db.prepare("INSERT INTO projects(id, name) VALUES('gh:a/cat', 'Cat'), ('gh:a/dog', 'Dog')").run();
  const ins = db.prepare('INSERT INTO sessions(id, project_id, branch, worktree, started_at, last_event_at, cost_usd) VALUES(?, ?, ?, ?, ?, ?, ?)');
  ins.run('c1', 'gh:a/cat', 'main', null, now - 9000, now - 8000, 2);   // resident, first shift
  ins.run('c2', 'gh:a/cat', 'main', null, now - 7000, now - 6000, 3);   // same resident, second shift
  ins.run('c3', 'gh:a/cat', 'seo', 'seo', now - 5000, now - 4000, 10); // worktree character
  ins.run('d1', 'gh:a/dog', 'main', null, now - 5000, now - 4000, 1);
  ins.run('y', 'gh:a/dog', 'main', null, now - 9e8, now - 8e8, 99);     // long ago: not today
  refreshAgents(db, 0, new Map());
  const s = buildState(db, new Map(), now);
  const b = s.costBreakdown;
  assert.deepEqual(b.map((p) => [p.projectId, p.usd]), [['gh:a/cat', 15], ['gh:a/dog', 1]]);
  assert.deepEqual(b[0].agents.map((a) => [a.usd, a.shifts]), [[10, 1], [5, 2]]);
  assert.equal(b[0].agents[1].sessionId, 'c2'); // opens their latest shift
  assert.equal(b.reduce((n, p) => n + p.usd, 0), s.totals.costToday);
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

test('neighborhoods: similar projects touch, unrelated ones have a park street between them', async () => {
  const { layoutTown, parseGrouping } = await import('../daemon/districts.ts');
  const groups = [{ name: 'Money', ids: ['a', 'b', 'c', 'd', 'e'] }, { name: 'Learning', ids: ['f', 'g'] }, { name: 'Tools', ids: ['h'] }];
  const { cells, districts } = layoutTown(groups);
  const at = (id: string) => cells.get(id)!;
  // consecutive items in a group are adjacent (snake fill)
  for (const g of groups) for (let i = 1; i < g.ids.length; i++) {
    const [x1, z1] = at(g.ids[i - 1]), [x2, z2] = at(g.ids[i]);
    assert.equal(Math.abs(x1 - x2) + Math.abs(z1 - z2), 1, `${g.ids[i - 1]}→${g.ids[i]}`);
  }
  // no two cells collide; cells in different groups are never adjacent
  const all = [...cells.values()].map((c) => c.join());
  assert.equal(new Set(all).size, all.length);
  const groupOf = new Map(groups.flatMap((g) => g.ids.map((id) => [id, g.name])));
  for (const [a, ca] of cells) for (const [b, cb] of cells) {
    if (groupOf.get(a) === groupOf.get(b)) continue;
    assert.ok(Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1])) >= 2, `${a} and ${b} too close`);
  }
  assert.equal(districts.length, 3);
  // grouping reply: every project lands once, unknowns go to Odds & Ends
  const parsed = parseGrouping('Sure!\n[{"name":"Money","items":[1,2,2]},{"name":"Fun","items":[4]}]', 4)!;
  assert.deepEqual(parsed, [{ name: 'Money', items: [1, 2] }, { name: 'Fun', items: [4] }, { name: 'Odds & Ends', items: [3] }]);
});

test('town labels say what an agent is doing in 2-3 words', async () => {
  const { shortDoing } = await import('../web/src/copy.ts');
  const run = (action: string) => shortDoing({ status: 'running', action });
  assert.equal(run('Editing scene.ts'), 'changing scene');
  assert.equal(run('Reading web/src/App.tsx'), 'reading App');
  assert.equal(run('Running npm run build'), 'building app');
  assert.equal(run('screenshot filters and labels'), 'screenshot filters');
  assert.equal(shortDoing({ status: 'idle', away: true, action: null }), 'napping');
  assert.equal(shortDoing({ status: 'needs_input', action: 'x' }), 'needs you');
});

test('agent scorecard: deliver, work on their own, value for money', async () => {
  const { scorecard } = await import('../web/src/crew/scorecard.ts');
  const base = { days: 30, shifts: 6, finished: 5, delivered: 4, shipped: 3, scrapped: 1, saves: 9, workMs: 5 * 3600_000, interruptions: 2, waitedMs: 600_000, costUsd: 12, checksOk: 8, checksFail: 1, recent: [] };
  const good = scorecard(base);
  assert.deepEqual(good.scores.map((s) => s.grade), ['good', 'good', 'good']);
  assert.equal(good.verdict.grade, 'good');
  const bad = scorecard({ ...base, delivered: 0, shipped: 0, scrapped: 4, interruptions: 40, costUsd: 90 });
  assert.equal(bad.scores[0].grade, 'bad'); assert.equal(bad.scores[1].grade, 'bad'); assert.equal(bad.verdict.grade, 'bad');
  const fresh = scorecard({ ...base, shifts: 1, finished: 0, delivered: 0, workMs: 5 * 60_000, interruptions: 0 });
  assert.equal(fresh.verdict.grade, 'none');
});

test('batch naming reads "n: Name" lines by position and drops unusable ones', async () => {
  const { parseNumbered } = await import('../daemon/naming.ts');
  assert.deepEqual(parseNumbered('1: Support Bot\n2. Sales Training\nsome chatter\n3) "Money Diary"\n9: Extra', 4), ['Support Bot', 'Sales Training', 'Money Diary', null]);
  assert.deepEqual(parseNumbered(null, 2), [null, null]);
  assert.deepEqual(parseNumbered('1: This name is far too long to be a building name at all', 1), [null]);
});

test('intros: an instant template from real facts; model lines must sound like the character', async () => {
  const { templateIntro, cleanIntro } = await import('../daemon/intros.ts');
  const t = templateIntro({ name: 'Juno', job: 'plumber', project: 'Sales Training', summary: 'Practice quizzes for new sales reps.', task: null, live: true,
    profile: { shifts: 9, finished: 9, delivered: 7, shipped: 7, interruptions: 2 } });
  assert.equal(t, "Hi, I'm Juno. I fix things that break. Right now I'm on Sales Training, practice quizzes for new sales reps. 7 of my last 9 jobs shipped.");
  const first = templateIntro({ name: 'Bea', job: 'scout', project: null, summary: null, task: null, live: true, profile: { shifts: 1, finished: 0, delivered: 0, shipped: 0, interruptions: 0 } });
  assert.match(first, /^Hi, I'm Bea\. I look into things before anyone builds\. This is my first shift/);
  assert.equal(cleanIntro('"Hi, I\'m Juno. I fix what breaks."', 'Juno'), "Hi, I'm Juno. I fix what breaks.");
  assert.equal(cleanIntro('Hello there, I fix things.', 'Juno'), null); // doesn't say who they are
  assert.equal(cleanIntro(`Hi, I'm Juno. ${'very '.repeat(80)}long`, 'Juno'), null);
});

test('terminal intros: off by default; when on, a starting session is told who it is in the town', async () => {
  const { terminalIntro } = await import('../daemon/intros.ts');
  const { kvSet } = await import('../daemon/db.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const p = { session_id: 'intro-1', cwd: dir, hook_event_name: 'SessionStart', source: 'startup' };
  handleHook(db, p);
  assert.equal(terminalIntro(db, p, new Map(), 'Maple Harbor'), null);
  kvSet(db, 'settings.terminalIntros', true);
  const out = terminalIntro(db, p, new Map(), 'Maple Harbor') as any;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /introduce yourself/);
  assert.match(out.hookSpecificOutput.additionalContext, /Maple Harbor/);
  // the name Claude is given is the one the town shows
  const s = buildState(db, new Map()).sessions.find((x) => x.id === 'intro-1')!;
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`you are ${s.agent.name},`));
  assert.equal(terminalIntro(db, { ...p, hook_event_name: 'Stop' }, new Map(), 'Maple Harbor'), null);
  assert.equal(terminalIntro(db, { ...p, source: 'compact' }, new Map(), 'Maple Harbor'), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('welcome state starts fresh and setup counts come from what was read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  handleHook(db, { session_id: 'w1', cwd: dir, hook_event_name: 'SessionStart' });
  const st = buildState(db, new Map(), Date.now(), false, { phase: 'reading', read: 3, total: 10, projects: 0, shifts: 0, crew: 0 });
  assert.deepEqual(st.settings.welcome, { step: null, done: false, doneAt: null, skipped: null, tips: [] });
  assert.equal(st.settings.terminalIntros, false);
  assert.equal(st.setup.phase, 'reading');
  assert.equal(st.setup.read, 3);
  assert.equal(st.setup.shifts, 1);
  assert.equal(st.setup.projects, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scheduled jobs: every headless run of the same job is one character, apart from interactive work', async () => {
  const { refreshAgents, agentOf } = await import('../daemon/state.ts');
  const { promptFingerprint } = await import('../daemon/identity.ts');
  assert.equal(promptFingerprint('Post the 3.0.75 release note for 4 Nov'), promptFingerprint('Post the 3.0.76 release note for 11 Nov'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const ins = db.prepare('INSERT INTO sessions(id, project_id, branch, started_at, last_event_at, first_prompt, entrypoint) VALUES(?, ?, ?, ?, ?, ?, ?)');
  ins.run('r1', 'gh:a/bot', 'main', 1, 2, 'Check the nightly export for 2026-11-01 and fix it', 'sdk-cli');
  ins.run('r2', 'gh:a/bot', 'main', 3, 4, 'Check the nightly export for 2026-11-02 and fix it', 'sdk-cli');
  ins.run('r3', 'gh:a/bot', 'main', 5, 6, 'Summarize open PRs', 'sdk-cli');
  ins.run('i1', 'gh:a/bot', 'main', 7, 8, 'add a pricing page', 'cli');
  refreshAgents(db, 0, new Map());
  const a = (id: string) => agentOf(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any);
  assert.equal(a('r1').key, a('r2').key);
  assert.notEqual(a('r1').key, a('r3').key);
  assert.equal(a('r1').role, 'routine');
  assert.equal(a('i1').role, 'resident');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scheduled jobs: retries collapse into one wake-up, a regular gap predicts the next run', async () => {
  const { wakeStarts, cadence, nextRun } = await import('../daemon/routines.ts');
  const H = 3600_000;
  const wakes = wakeStarts([0, 60_000, 120_000, 24 * H, 48 * H, 72 * H + 5 * 60_000]);
  assert.equal(wakes.length, 4);
  const c = cadence(wakes);
  assert.ok(c.regular);
  assert.ok(Math.abs(c.intervalMs! - 24 * H) < H);
  assert.ok(Math.abs(nextRun(wakes.at(-1)!, c, 80 * H)! - 96 * H) < H);
  // a job triggered by failures, at random: no guess
  assert.equal(cadence([0, 2 * H, 50 * H, 51 * H, 200 * H]).regular, false);
  assert.equal(nextRun(0, { intervalMs: null, regular: false }, 1), null);
});

test('scheduled jobs: asleep between runs, awake while one is going', async () => {
  const { refreshAgents } = await import('../daemon/state.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const now = Date.now(), H = 3600_000;
  db.prepare("INSERT INTO projects(id, name, root, lot) VALUES('local:/w/bot', 'bot', '/w/bot', 0)").run();
  const ins = db.prepare('INSERT INTO sessions(id, project_id, started_at, last_event_at, first_prompt, entrypoint, outcome) VALUES(?, ?, ?, ?, ?, ?, ?)');
  for (let i = 3; i >= 1; i--) ins.run(`r${i}`, 'local:/w/bot', now - i * 24 * H, now - i * 24 * H + 60_000, 'Run the nightly export', 'sdk-cli', 'Export done.');
  refreshAgents(db, 0, new Map());
  let st = buildState(db, new Map(), now);
  assert.equal(st.routines.length, 1);
  const r = st.routines[0];
  assert.equal(r.state, 'asleep');
  assert.equal(r.runs, 3);
  assert.equal(r.lastSessionId, 'r1');
  assert.equal(r.lastOutcome, 'Export done.');
  assert.ok(r.nextAt && Math.abs(r.nextAt - (now - 24 * H + 24 * H)) < H);
  // a new run, mid-turn, with no hooks or live registry entry: it woke up
  db.prepare('INSERT INTO sessions(id, project_id, started_at, last_event_at, first_prompt, entrypoint, current_action) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run('r0', 'local:/w/bot', now - 30_000, now - 5_000, 'Run the nightly export', 'sdk-cli', 'Reading export.csv');
  refreshAgents(db, 0, new Map());
  st = buildState(db, new Map(), now);
  assert.equal(st.routines[0].state, 'awake');
  assert.equal(st.routines[0].liveSessionId, 'r0');
  assert.equal(st.sessions.find((s) => s.id === 'r0')?.status, 'running');
  assert.equal(st.sessions.find((s) => s.id === 'r0')?.scheduled, true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
