import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../daemon/db.ts';
import { foldChecks } from '../daemon/github.ts';
import { clearShip, SHIP_MARK, shipBrief, shipPhase, shipsView, startShip } from '../daemon/ship.ts';
import { canGoLive, needsDecision, todayView, type TodaySession } from '../web/src/crew/today.ts';
import { shipTrack } from '../web/src/crew/shipTrack.ts';

const NOW = new Date(2026, 10, 9, 18, 0).getTime();
const H = 3600_000;
const s = (id: string, o: Partial<TodaySession> = {}): TodaySession => ({
  id, status: 'ended', stamp: null, prState: null, prUrl: null, prChecks: null, endedAt: NOW - H, lastEventAt: NOW - H,
  kind: null, scheduled: false, projectId: 'p1', ...o,
});

test('ship: saved-but-not-sent work needs a decision, and a job being shipped is listed once, under Shipping', () => {
  assert.equal(needsDecision(s('a', { stamp: 'saved' }), NOW), 'saved');
  const v = todayView([s('a', { stamp: 'saved' }), s('b', { stamp: 'unfinished' })], new Set(), NOW, new Set(['b']));
  assert.deepEqual(v.decide.map((x) => x.s.id), ['a']);
});

test('ship: Put it live only for an open review with green (or no) checks, once the agent is done', () => {
  const review = { stamp: 'review' as const, prUrl: 'https://github.com/o/r/pull/7', prState: 'open' };
  assert.equal(canGoLive(s('a', { ...review, prChecks: 'passing' })), true);
  assert.equal(canGoLive(s('b', { ...review, prChecks: 'none' })), true);
  assert.equal(canGoLive(s('c', { ...review, prChecks: 'pending' })), false);
  assert.equal(canGoLive(s('d', { ...review, prChecks: 'failing' })), false);
  assert.equal(canGoLive(s('e', { ...review, prChecks: null })), false); // not looked up yet
  assert.equal(canGoLive(s('f', { ...review, prChecks: 'passing', status: 'running' })), false);
  assert.equal(canGoLive(s('g', { ...review, prChecks: 'passing', prState: 'merged' })), false);
});

test('ship: the brief never merges, and stops at saved when the project is not on GitHub', () => {
  for (const b of [shipBrief('ship', true), shipBrief('ship', false), shipBrief('fix', true)]) {
    assert.ok(b.startsWith(SHIP_MARK));
    assert.match(b, /never merge|Do NOT merge/);
  }
  assert.match(shipBrief('ship', true), /gh pr create/);
  assert.doesNotMatch(shipBrief('ship', false), /gh pr create/);
});

test('ship: phases come from the review and its checks, not from what the agent says', () => {
  const base = { status: 'ended' as const, prUrl: null, prState: null, checks: null, sinceStart: 10 * 60_000 };
  assert.equal(shipPhase({ ...base, sinceStart: 5_000 }), 'working'); // terminal still opening
  assert.equal(shipPhase({ ...base, status: 'running' }), 'working');
  assert.equal(shipPhase(base), 'stopped');
  const pr = { ...base, prUrl: 'x/pull/1', prState: 'open' };
  assert.equal(shipPhase({ ...pr, status: 'running', checks: 'passing' }), 'review');
  assert.equal(shipPhase({ ...pr, checks: 'pending' }), 'checks');
  assert.equal(shipPhase({ ...pr, checks: 'failing' }), 'failing');
  assert.equal(shipPhase({ ...pr, status: 'running', checks: 'failing' }), 'checks'); // still fixing
  assert.equal(shipPhase({ ...pr, checks: 'passing' }), 'ready');
  assert.equal(shipPhase({ ...pr, checks: 'none' }), 'ready');
  assert.equal(shipPhase({ ...pr, checks: null }), 'checks');
  assert.equal(shipPhase({ ...pr, prState: 'merged' }), 'live');
});

test('ship: GitHub check runs and commit statuses fold into one word', () => {
  assert.equal(foldChecks([], []), 'none');
  assert.equal(foldChecks([{ status: 'completed', conclusion: 'success' }], []), 'passing');
  assert.equal(foldChecks([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }], []), 'pending');
  assert.equal(foldChecks([{ status: 'in_progress' }, { status: 'completed', conclusion: 'failure' }], []), 'failing');
  assert.equal(foldChecks([{ status: 'completed', conclusion: 'skipped' }], [{ state: 'success' }]), 'passing');
  assert.equal(foldChecks([], [{ state: 'pending' }]), 'pending');
  assert.equal(foldChecks([], [{ state: 'error' }]), 'failing');
});

test('ship: the track ticks off what really happened', () => {
  const states = (x: Parameters<typeof shipTrack>[0]) => shipTrack(x).map((t) => t.state).join(' ');
  assert.equal(states({ phase: 'working', commits: 0, prUrl: null, onGithub: true }), 'now todo todo todo todo');
  assert.equal(states({ phase: 'working', commits: 2, prUrl: null, onGithub: true }), 'ok ok now todo todo');
  assert.equal(states({ phase: 'checks', commits: 2, prUrl: 'x', onGithub: true }), 'ok ok ok now todo');
  assert.equal(states({ phase: 'failing', commits: 2, prUrl: 'x', onGithub: true }), 'ok ok ok bad todo');
  assert.equal(states({ phase: 'ready', commits: 2, prUrl: 'x', onGithub: true }), 'ok ok ok ok now');
  assert.equal(states({ phase: 'working', commits: 0, prUrl: null, onGithub: false }), 'now todo');
});

test('ship: follows the shift that took the brief, and its review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmville-test-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const T = NOW;
  db.prepare("INSERT INTO projects(id, name, root, gh_full) VALUES('p1', 'Site', ?, 'o/site')").run(dir);
  const add = db.prepare('INSERT INTO sessions(id, project_id, cwd, started_at, last_event_at, ended_at, first_prompt, last_prompt, commits, pr_url, pr_state, pr_checks) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  add.run('orig', 'p1', dir, T - 5 * H, T - 2 * H, T - 2 * H, 'add a pricing page', 'add a pricing page', 0, null, null, null);
  assert.equal(startShip(db, 'orig', 'ship', null, T), 'orig');
  // someone else's chat in the same folder doesn't belong to it; the resumed shift (new id, took the brief) does
  add.run('other', 'p1', dir, T + 60_000, T + 70_000, T + 70_000, 'what does this do?', 'what does this do?', 0, null, null, null);
  add.run('resumed', 'p1', dir, T + 30_000, T + 20 * 60_000, T + 20 * 60_000, 'add a pricing page', `${SHIP_MARK}: please take this job all the way to review.`, 2, 'https://github.com/o/site/pull/42', 'open', 'passing');
  const statusOf = () => 'ended' as const;
  let [v] = shipsView(db, statusOf, T + 21 * 60_000);
  assert.deepEqual([v.id, v.sessionId, v.phase, v.prSession, v.commits, v.onGithub], ['orig', 'resumed', 'ready', 'resumed', 2, true]);
  assert.deepEqual(v.ids.sort(), ['orig', 'resumed']);
  // shipping a shift of it again keeps the one row
  assert.equal(startShip(db, 'resumed', 'fix', null, T + 22 * 60_000), 'orig');
  db.prepare("UPDATE sessions SET pr_state = 'merged', pr_merged_at = ? WHERE id = 'resumed'").run(T + 25 * 60_000);
  [v] = shipsView(db, statusOf, T + 26 * 60_000);
  assert.equal(v.phase, 'live');
  assert.equal(shipsView(db, statusOf, T + 2 * H).length, 0); // drops off a while after it lands
  clearShip(db, 'resumed');
  assert.ok((db.prepare("SELECT cleared_at FROM ships WHERE session_id = 'orig'").get() as { cleared_at: number }).cleared_at > 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
