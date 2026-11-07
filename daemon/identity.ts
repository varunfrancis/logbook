import type { Row } from './db.ts';

/*
 * Every agent gets a stable character. The key is its workbench (worktree, or a non-default branch),
 * so a new session picking up the same work is the same character, with a career. Plain sessions on
 * main fall back to the session id.
 */

export const SHAPES = ['bean', 'pebble', 'pear', 'capsule', 'cube', 'triangle', 'cloud', 'acorn', 'drop', 'bun'] as const;
export const COLORS = ['#2fb36b', '#3f8efc', '#ff8a3d', '#9b6bff', '#f472b6', '#14b8a6', '#f5b301', '#ef5350', '#7c8cff', '#c08457', '#84cc16', '#7b8aa0'] as const;
export const ACCESSORIES = ['bow', 'glasses', 'headphones', 'beanie', 'scarf', 'freckles'] as const;
export const JOBS = ['builder', 'plumber', 'painter', 'librarian', 'inspector', 'scout'] as const;
export type Job = (typeof JOBS)[number];

export const JOB_TITLE: Record<Job, string> = {
  builder: 'Builder', plumber: 'Plumber', painter: 'Painter', librarian: 'Librarian', inspector: 'Inspector', scout: 'Scout',
};
export const JOB_MEANING: Record<Job, string> = {
  builder: 'building something new', plumber: 'fixing something', painter: 'working on how it looks',
  librarian: 'writing docs', inspector: 'checking things work', scout: 'researching',
};

const NAMES = [
  'Pip', 'Juno', 'Bolt', 'Rio', 'Nova', 'Moss', 'Kit', 'Fern', 'Wren', 'Clay', 'Ember', 'Ash', 'Ivy', 'Dot', 'Bram', 'Echo',
  'Lux', 'Sol', 'Fig', 'Oki', 'Tad', 'Bea', 'Zuri', 'Milo', 'Pell', 'Rue', 'Sage', 'Tilly', 'Wim', 'Yuki', 'Ada', 'Bix',
  'Coco', 'Dax', 'Elo', 'Finn', 'Gus', 'Hazel', 'Iggy', 'Jojo', 'Kai', 'Lumi', 'Mabel', 'Nell', 'Otto', 'Pia', 'Quill', 'Remy',
  'Suki', 'Toby', 'Uma', 'Vito', 'Wally', 'Xia', 'Yara', 'Ziggy', 'Arlo', 'Birdie', 'Cosmo', 'Dune', 'Effie', 'Flint', 'Gemma', 'Hugo',
  'Indie', 'Jett', 'Kiki', 'Lolo', 'Momo', 'Noor', 'Ozzy', 'Peg', 'Rafa', 'Tink', 'Vera', 'Waldo', 'Zed', 'Bun', 'Nib', 'Olive',
  'Pax', 'Rory', 'Skye', 'Teo', 'Una', 'Viggo', 'Willa', 'Yoyo', 'Zola', 'Benny', 'Cleo', 'Dash', 'Edie', 'Fizz', 'Goose', 'Hank',
  'Iris', 'June', 'Koko', 'Lark', 'Mint', 'Nico', 'Oona', 'Pogo', 'Quinn', 'Rocco', 'Sunny', 'Tofu', 'Ulla', 'Vinny', 'Wiggs', 'Yogi',
  'Ziggy', 'Bubba', 'Chip', 'Dolly', 'Elmo', 'Frankie', 'Gigi', 'Honey', 'Ike', 'Jazz', 'Kip', 'Loki', 'Maple', 'Nugget', 'Opal', 'Pickle',
  'Rusty', 'Sprout', 'Tiki', 'Waffle', 'Bean', 'Cricket', 'Doodle', 'Emmy', 'Fable', 'Gizmo', 'Hopper', 'Inky', 'Jelly', 'Kiwi', 'Lulu', 'Mochi',
];

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export type Identity = { key: string; name: string; shape: string; color: string; accessory: string; job?: Job | null };

/**
 * Who a session is:
 *  - work in a worktree or on a feature branch: that workbench's own character (comes back when the work is picked up again)
 *  - work on main: the project's resident, one character for all of it
 * A second window on main while the resident is busy becomes a helper (see refreshAgents).
 */
export function agentKey(s: Row): string {
  if (isHeadless(s) && s.project_id) return routineKey(s.project_id, s.first_prompt ?? s.id);
  const wb = s.worktree || (s.branch && !/^(main|master|develop|dev|trunk|HEAD)$/.test(s.branch) ? s.branch : null);
  if (wb) return `${s.project_id ?? ''}#${wb}`;
  return s.project_id ? residentKey(s.project_id) : s.id;
}
/** A headless `claude -p` run (cron, launchd, a script): nobody is typing to it. */
export const isHeadless = (s: Row) => s.entrypoint === 'sdk-cli';
/**
 * The same scheduled job is the same prompt every time, give or take dates, counts and ids.
 * Runs that share a project and a prompt fingerprint are one recurring character.
 */
export function promptFingerprint(prompt: string): string {
  return prompt.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '') // uuids
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
export const routineKey = (projectId: string, prompt: string) => `${projectId}#routine:${hash(promptFingerprint(prompt)).toString(36)}`;
export const isRoutineKey = (key: string) => key.includes('#routine:');
export const residentKey = (projectId: string) => `${projectId}#resident`;
export const helperKey = (projectId: string, sessionId: string) => `${residentKey(projectId)}~${sessionId}`;
export const isHelperKey = (key: string) => key.includes('#resident~');
export const isResidentKey = (key: string) => key.endsWith('#resident');

const registry = new Map<string, Identity>();

/** Loads saved identities and gives every new agent key a name nobody recent is using. */
export function allocateIdentities(db: { prepare: (sql: string) => any }, keys: string[]) {
  if (!registry.size) for (const r of db.prepare('SELECT key, name, shape, color, accessory, job FROM agents').all() as Identity[]) registry.set(r.key, r);
  const fresh = keys.filter((k) => !registry.has(k) && !isHelperKey(k));
  if (!fresh.length) return;
  const recent = new Set((db.prepare('SELECT name FROM agents WHERE created_at > ?').all(Date.now() - 45 * 24 * 3600_000) as { name: string }[]).map((r) => r.name));
  recent.add('Pip'); // the foreman's name: no new agent gets it
  const ins = db.prepare('INSERT OR IGNORE INTO agents(key, name, shape, color, accessory, created_at) VALUES(?, ?, ?, ?, ?, ?)');
  for (const key of fresh) {
    const base = hashIdentity(key);
    const h = hash(key);
    let name = base.name;
    for (let i = 0; i < NAMES.length && recent.has(name); i++) name = NAMES[(h + i) % NAMES.length];
    const id = { ...base, name };
    recent.add(name);
    registry.set(key, id);
    ins.run(key, id.name, id.shape, id.color, id.accessory, Date.now());
  }
}

/**
 * A character's job is what they do most often across their whole career, so it stays put.
 * Ties go to the job they had first.
 */
export function settleJobs(db: { prepare: (sql: string) => any }) {
  const rows = db.prepare(`SELECT agent_key AS k, job, COUNT(*) AS n, MIN(started_at) AS first FROM sessions
    WHERE agent_key IS NOT NULL AND job IS NOT NULL AND agent_key NOT LIKE '%#resident~%' GROUP BY agent_key, job`).all() as { k: string; job: Job; n: number; first: number }[];
  const best = new Map<string, { job: Job; n: number; first: number }>();
  for (const r of rows) {
    const b = best.get(r.k);
    if (!b || r.n > b.n || (r.n === b.n && (r.first ?? 0) < (b.first ?? 0))) best.set(r.k, r);
  }
  const upd = db.prepare('UPDATE agents SET job = ? WHERE key = ? AND COALESCE(job, \'\') != ?');
  for (const [k, b] of best) {
    const id = registry.get(k);
    if (id && id.job !== b.job) { id.job = b.job; upd.run(b.job, k, b.job); }
  }
}

export function identityFor(key: string): Identity {
  if (isHelperKey(key)) {
    // a helper wears the resident's shape and colors, with their name and "Jr."
    const base = identityFor(key.slice(0, key.indexOf('~')));
    return { ...base, key, name: `${base.name} Jr.`, accessory: 'none' };
  }
  return registry.get(key) ?? hashIdentity(key);
}

function hashIdentity(key: string): Identity {
  const h = hash(key);
  return {
    key,
    name: NAMES[h % NAMES.length],
    shape: SHAPES[(h >>> 7) % SHAPES.length],
    color: COLORS[(h >>> 11) % COLORS.length],
    accessory: ACCESSORIES[(h >>> 17) % ACCESSORIES.length],
  };
}

const FIX_RE = /\b(fix|bug|broken|error|crash|issue|failing|fails|doesn'?t work|not working|debug|wrong|regression|can'?t see)\b/i;
const LOOK_RE = /\b(design|ui|ux|css|style|layout|color|colour|font|spacing|visual|animation|icon|theme|responsive|pixel)\b/i;
const DOCS_RE = /\b(docs?|readme|document|write[- ]?up|blog|copy|changelog|spec|plan)\b/i;
const TEST_RE = /\b(tests?|coverage|qa|verify|audit|review)\b/i;
const RESEARCH_RE = /\b(research|investigate|explore|find out|look into|compare|analy[sz]e|how (do|does|can)|what is|why)\b/i;

/** What kind of work a session is doing, from its brief and what it touched. */
export function jobFor(s: Row): Job {
  const brief = `${s.ai_title ?? ''} ${s.first_prompt ?? ''}`;
  const files: string[] = s.files ? (JSON.parse(s.files) as { p: string }[]).map((f) => f.p) : [];
  const share = (re: RegExp) => (files.length ? files.filter((f) => re.test(f)).length / files.length : 0);
  if (share(/(\.test\.|\.spec\.|__tests__|\/tests?\/)/) > 0.5) return 'inspector';
  if (share(/\.(md|mdx|txt|rst)$/i) > 0.6) return 'librarian';
  if (FIX_RE.test(brief)) return 'plumber';
  if (LOOK_RE.test(brief) || share(/\.(css|scss|sass|less)$/i) > 0.4) return 'painter';
  if (DOCS_RE.test(brief) && share(/\.(md|mdx)$/i) >= 0.3) return 'librarian';
  if (TEST_RE.test(brief)) return 'inspector';
  if ((s.edits ?? 0) === 0 && ((s.reads ?? 0) + (s.webs ?? 0) > 3 || RESEARCH_RE.test(brief))) return 'scout';
  return 'builder';
}
