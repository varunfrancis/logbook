import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobLabel, jobWord, liveJobs } from '../web/src/city/liveJobs.ts';

const base = { status: 'running', stuck: null, actionKind: 'think', helperActive: false, filesChanged: 0 } as const;

test('live feed: one word for where a job is at', () => {
  assert.equal(jobWord({ ...base, status: 'needs_input' }), 'Needs you');
  assert.equal(jobWord({ ...base, stuck: { count: 3, problem: 'x' } }), 'Stuck');
  assert.equal(jobWord({ ...base, actionKind: 'run' }), 'Testing');
  assert.equal(jobWord({ ...base, actionKind: 'edit' }), 'Building');
  assert.equal(jobWord({ ...base, actionKind: 'read' }), 'Planning');
  assert.equal(jobWord({ ...base, actionKind: 'web' }), 'Planning');
  // once files have changed, a quick read doesn't flip back to Planning
  assert.equal(jobWord({ ...base, actionKind: 'read', filesChanged: 2 }), 'Building');
  assert.equal(jobWord({ ...base, helperActive: true }), 'Building');
});

test('live feed: only working or waiting jobs, hands up first, finished ones gone at once', () => {
  const s = (id: string, o: Record<string, unknown>) => ({ ...base, id, projectId: 'p1', focus: `Job ${id}`, title: 'x', startedAt: 0, agent: { name: id }, ...o }) as any;
  const state = {
    projects: [{ id: 'p1', name: 'Logbook' }, { id: 'p2', name: 'Other' }] as any,
    sessions: [
      s('a', { startedAt: 1 }),
      s('b', { status: 'idle' }),
      s('c', { status: 'ended' }),
      s('d', { status: 'needs_input', startedAt: 5 }),
      s('e', { startedAt: 2, projectId: 'p2', focus: null, title: '7c365f53' }),
      s('f', { startedAt: 3, stuck: { count: 2, problem: 'y' } }),
    ],
  };
  const jobs = liveJobs(state);
  assert.deepEqual(jobs.map((j) => j.id), ['d', 'f', 'a', 'e']);
  assert.equal(jobs[0].project, 'Logbook');
  assert.equal(jobs[3].job, 'Getting started'); // no machine-made names like a session hash
  assert.deepEqual(liveJobs(state, new Set(['p2'])).map((j) => j.id), ['e']);
});

test('job label (Town feed and Crew cards): live focus first, then a human session title', () => {
  assert.equal(jobLabel({ focus: 'Fix login redirect', title: 'Build the landing page' }), 'Fix login redirect');
  assert.equal(jobLabel({ focus: null, title: 'Build the landing page' }), 'Build the landing page');
  assert.equal(jobLabel({ focus: null, title: 'a1b2c3d4' }), 'Getting started');
});
