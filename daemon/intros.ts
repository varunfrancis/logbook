import { execFileSync } from 'node:child_process';
import type { Db, Row } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import type { LiveEntry } from './live.ts';
import { agentOf, profileFor, projectNames } from './state.ts';
import { askClaude } from './naming.ts';
import { agentKey, allocateIdentities, helperKey, isHelperKey, isResidentKey } from './identity.ts';
import type { Agent, AgentProfile, Job } from './types.ts';

/*
 * Agents introducing themselves on the welcome tour.
 * A fill-in-the-blanks line is always ready instantly; the small model writes a livelier one in the
 * background (one call for the whole roll call, cached per agent per day) and replaces it when it's ready.
 */

export type Intro = {
  key: string;
  sessionId: string;
  projectId: string | null;
  projectName: string | null;
  agent: Agent;
  live: boolean;
  template: string;
  line: string | null; // the small model's version, when it's ready
};

export type IntroFacts = { name: string; job: Job; project: string | null; summary: string | null; task: string | null; live: boolean; profile: Pick<AgentProfile, 'shifts' | 'finished' | 'delivered' | 'shipped' | 'interruptions'> };

const JOB_LINE: Record<Job, string> = {
  builder: 'I build new things',
  plumber: 'I fix things that break',
  painter: 'I work on how things look',
  librarian: 'I write things down so nobody has to remember them',
  inspector: 'I check that things actually work',
  scout: 'I look into things before anyone builds',
};

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const noDot = (s: string) => s.trim().replace(/[.!]+$/, '');

/** The instant, always-true version. */
export function templateIntro(f: IntroFacts): string {
  const parts = [`Hi, I'm ${f.name}. ${JOB_LINE[f.job]}.`];
  if (f.project) parts.push(`${f.live ? "Right now I'm on" : "Lately I've been on"} ${f.project}${f.summary ? `, ${lowerFirst(noDot(f.summary))}` : ''}.`);
  const p = f.profile;
  if (p.finished >= 3) parts.push(`${p.delivered} of my last ${p.finished} jobs ${p.shipped === p.delivered ? 'shipped' : 'shipped or went for review'}.`);
  else if (p.shifts <= 1) parts.push(f.live ? "This is my first shift, so say hi." : 'That was my first shift here.');
  else if (p.interruptions === 0) parts.push("I haven't had to stop and ask you anything yet.");
  return parts.join(' ');
}

const today = () => new Date().toLocaleDateString('en-CA');

/** The agents worth meeting first: the ones on site now, then whoever worked most recently. One per character. */
export function introCandidates(db: Db, live: Map<string, LiveEntry>, n = 3): Row[] {
  const rows = db.prepare(`SELECT * FROM sessions WHERE agent_key IS NOT NULL AND project_id IS NOT NULL
    ORDER BY COALESCE(last_event_at, started_at) DESC LIMIT 400`).all() as Row[];
  rows.sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)));
  const seen = new Set<string>(), sites = new Set<string>(), out: Row[] = [];
  // Different projects first, so the roll call shows the breadth of the town; then fill from anyone.
  for (const pass of [true, false]) for (const r of rows) {
    if (out.length >= n) return out;
    if (isHelperKey(r.agent_key) || seen.has(r.agent_key) || (pass && sites.has(r.project_id))) continue;
    seen.add(r.agent_key); sites.add(r.project_id); out.push(r);
  }
  return out;
}

function factsFor(db: Db, r: Row, live: Map<string, LiveEntry>, owner: string): { facts: IntroFacts; agent: Agent; project: Row | undefined } {
  const agent = agentOf(r);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.project_id) as Row | undefined;
  const profile = profileFor(db, agent.key, live, owner);
  const task = String(r.ai_title || r.first_prompt || '').replace(/^\/\S+\s*/, '').replace(/\s+/g, ' ').slice(0, 100) || null;
  return {
    agent, project,
    facts: { name: agent.name, job: agent.job, project: project ? projectNames(project).name : null, summary: project?.summary ?? project?.gh_description ?? null, task, live: live.has(r.id), profile },
  };
}

export function intros(db: Db, live: Map<string, LiveEntry>, owner: string, n = 3): Intro[] {
  return introCandidates(db, live, n).map((r) => {
    const { facts, agent, project } = factsFor(db, r, live, owner);
    const cached = kvGet<{ day: string; line: string } | null>(db, `intro.${agent.key}`, null);
    return {
      key: agent.key, sessionId: r.id, projectId: r.project_id ?? null, projectName: facts.project, agent, live: facts.live,
      template: templateIntro(facts), line: cached?.day === today() ? cached.line : null,
    };
  });
}

/** A model line is only used if it sounds like the character introducing themself, briefly. */
export function cleanIntro(raw: unknown, name: string): string | null {
  if (typeof raw !== 'string') return null;
  const line = raw.replace(/\s+/g, ' ').replace(/^["'`]|["'`]$/g, '').trim();
  if (!line.includes(name) || line.length < 20 || line.length > 260) return null;
  if ((line.match(/[.!?](\s|$)/g) ?? []).length > 3) return null;
  return line;
}

let writing = false;
/** Writes today's lines for the roll call in one small-model call. Returns how many it wrote. */
export async function writeIntros(db: Db, live: Map<string, LiveEntry>, owner: string, n = 3): Promise<number> {
  if (writing || process.env.LOGBOOK_NO_NAMING) return 0;
  const todo = introCandidates(db, live, n).map((r) => ({ r, ...factsFor(db, r, live, owner) }))
    .filter((x) => kvGet<{ day: string } | null>(db, `intro.${x.agent.key}`, null)?.day !== today());
  if (!todo.length) return 0;
  writing = true;
  try {
    const facts = todo.map((x, i) => ({
      n: i + 1, name: x.facts.name, job: x.agent.jobTitle, project: x.facts.project, projectIs: x.facts.summary, recentTask: x.facts.task,
      workingRightNow: x.facts.live, last30Days: { jobs: x.facts.profile.shifts, finished: x.facts.profile.finished, delivered: x.facts.profile.delivered, timesStoppedToAskTheUser: x.facts.profile.interruptions },
    }));
    const prompt = [
      'Each character below is an AI coding agent (one Claude Code session) shown as a little character in a cozy town that maps the user\'s software projects.',
      'Write a short spoken self-introduction for each one, as if meeting the user for the first time.',
      'Rules: first person, warm and plain, like a friendly new coworker. Two sentences, at most 38 words. Start with "Hi, I\'m <name>."',
      'Say what they work on in words a non-technical person understands: no file names, code, or jargon. Use one fact from their record only if it is interesting.',
      'No emoji. At most one exclamation mark.',
      'Reply with ONLY a JSON array like [{"n":1,"line":"..."}].',
      '',
      JSON.stringify(facts, null, 1),
    ].join('\n');
    const raw = await askClaude(prompt);
    let arr: { n: number; line: string }[] = [];
    try { arr = JSON.parse((raw ?? '').slice((raw ?? '').indexOf('['), (raw ?? '').lastIndexOf(']') + 1)); } catch {}
    let wrote = 0;
    for (const x of todo) {
      const i = todo.indexOf(x) + 1;
      const line = cleanIntro(arr.find((a) => a && a.n === i)?.line, x.facts.name);
      // Cache a failure too (as the template), so we don't ask again all day.
      kvSet(db, `intro.${x.agent.key}`, { day: today(), line: line ?? templateIntro(x.facts) });
      if (line) wrote++;
    }
    return wrote;
  } finally {
    writing = false;
  }
}

// ---------- saying hi in the terminal (opt-in) ----------

const COLOR_NAME: Record<string, string> = {
  '#2fb36b': 'green', '#3f8efc': 'blue', '#ff8a3d': 'orange', '#9b6bff': 'purple', '#f472b6': 'pink', '#14b8a6': 'teal',
  '#f5b301': 'yellow', '#ef5350': 'red', '#7c8cff': 'periwinkle', '#c08457': 'brown', '#84cc16': 'lime', '#7b8aa0': 'grey',
};
const WEARING: Record<string, string> = { bow: ' with a bow tie', glasses: ' with glasses', headphones: ' with headphones', beanie: ' in a beanie', scarf: ' with a scarf', freckles: ' with freckles' };

/**
 * When "Agents say hi in the terminal" is on, a starting session is told who it is in Logbook,
 * so the terminal and the town agree on names. Returns the SessionStart hook output, or null.
 */
export function terminalIntro(db: Db, p: any, live: Map<string, LiveEntry>, townName: string): object | null {
  if (p?.hook_event_name !== 'SessionStart' || p.source === 'compact' || typeof p.session_id !== 'string') return null;
  if (!kvGet<boolean>(db, 'settings.terminalIntros', false)) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(p.session_id) as Row | undefined;
  if (!s?.project_id) return null;
  if (!s.branch && s.cwd) {
    try { s.branch = execFileSync('git', ['-C', s.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 400, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch {}
    if (s.branch) db.prepare('UPDATE sessions SET branch = COALESCE(branch, ?) WHERE id = ?').run(s.branch, s.id);
  }
  let key = s.agent_key || agentKey(s);
  if (!s.agent_key && isResidentKey(key)) {
    // Someone else already holds the project's resident: this window is their helper, as refreshAgents would decide.
    const others = db.prepare('SELECT id FROM sessions WHERE agent_key = ? AND id != ?').all(key, s.id) as Row[];
    if (others.some((o) => live.has(o.id))) key = helperKey(s.project_id, s.id);
  }
  allocateIdentities(db, [key]);
  db.prepare('UPDATE sessions SET agent_key = COALESCE(agent_key, ?) WHERE id = ?').run(key, s.id);
  const a = agentOf({ ...s, agent_key: key });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(s.project_id) as Row | undefined;
  const site = project ? projectNames(project).name : 'their project';
  const desc = `${COLOR_NAME[a.color] ?? ''} ${a.shape}-shaped character${WEARING[a.accessory] ?? ''}`.replace(/\s+/g, ' ').trim();
  const look = `${/^[aeiou]/i.test(desc) ? 'an' : 'a'} ${desc}`;
  const hi = `Hi, I'm ${a.name}${a.name.endsWith('.') ? '' : '.'}`;
  const text = [
    `Logbook note: the user follows this session in Logbook, a local dashboard that shows each Claude Code session as a little character in their town, ${townName}.`,
    `There you are ${a.name}, ${look}, working at the ${site} building.`,
    `At the very start of your first reply, introduce yourself in one short friendly line, for example: "${hi} You'll see me at ${site} in ${townName}." Then carry on with the task as normal.`,
    'Do not mention Logbook again unless the user asks.',
  ].join(' ');
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}
