import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueNames } from '../daemon/state.ts';
import { isApiError } from '../daemon/transcripts.ts';
import { scorecard } from '../web/src/crew/scorecard.ts';
import { plainAction } from '../web/src/copy.ts';
import { jobLabel, onBreak } from '../web/src/city/liveJobs.ts';
import type { AgentProfile } from '../daemon/types.ts';

test('two buildings never share a name: the busier keeps it, the other gets its folder or a number', () => {
  const ps = uniqueNames([
    { name: 'Scratch Pad', repo: '', sessionsTotal: 10 },
    { name: 'Scratch Pad', repo: 'user', sessionsTotal: 2 },
    { name: 'Project Namer', repo: 'sa-claude-code-o8ffc5r1', sessionsTotal: 30 },
    { name: 'Project Namer', repo: 'sa-claude-code-swg3rm9o', sessionsTotal: 36 },
    { name: 'Solo', repo: 'solo', sessionsTotal: 1 },
  ]);
  assert.deepEqual(ps.map((p) => p.name), ['Scratch Pad', 'Scratch Pad (user)', 'Project Namer 2', 'Project Namer', 'Solo']);
});

test('Claude Code’s own API error lines are not a summary of the work', () => {
  assert.equal(isApiError('API Error: Connection lost mid-response. The response above may be incomplete.'), true);
  assert.equal(isApiError('Fixed the API error handling in the login flow.'), false);
  assert.equal(isApiError(null), false);
});

const profile = (o: Partial<AgentProfile>): AgentProfile => ({ days: 7, shifts: 5, finished: 4, delivered: 4, shipped: 4, scrapped: 0, saves: 3, workMs: 3 * 3600_000,
  interruptions: 30, waitedMs: 0, costUsd: 0, checksOk: 0, checksFail: 0, recent: [], ...o });

test('a mixed verdict says what is strong and what is not, instead of contradicting the numbers', () => {
  assert.equal(scorecard(profile({})).verdict.text, 'Delivers well, but stops to ask you often.');
  assert.equal(scorecard(profile({ interruptions: 0 })).verdict.text, 'Doing well.');
});

test('plain voice hides raw command lines but keeps plain descriptions', () => {
  assert.equal(plainAction('Running mdls -name kMDItemDurationSeconds ~/Mov', 'plain'), 'running a command on your computer');
  assert.equal(plainAction('Build the web app', 'plain'), 'build the web app');
  assert.equal(plainAction('Running mdls -name x', 'technical'), 'Running mdls -name x');
});

test('on a break means idle and not away, the same everywhere it is counted', () => {
  assert.equal(onBreak({ status: 'idle', away: false }), true);
  assert.equal(onBreak({ status: 'idle', away: true }), false);
  assert.equal(onBreak({ status: 'running', away: false }), false);
});

test('machine names like support-assistant-f3 never show as a job', () => {
  assert.equal(jobLabel({ focus: null, title: 'support-assistant-f3' }), 'Getting started');
  assert.equal(jobLabel({ focus: null, title: 'Estimate PR merge timeline' }), 'Estimate PR merge timeline');
});
