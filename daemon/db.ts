import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.ts';

export type Row = Record<string, any>;

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT,
      remote TEXT,
      gh_full TEXT,
      gh_url TEXT,
      gh_private INTEGER,
      gh_pushed_at INTEGER,
      gh_account TEXT,
      gh_description TEXT,
      lot INTEGER,
      created_at INTEGER,
      last_activity INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY,
      project_id TEXT,
      cwd TEXT,
      branch TEXT,
      worktree TEXT,
      transcript TEXT,
      ai_title TEXT,
      first_prompt TEXT,
      last_prompt TEXT,
      prompts INTEGER DEFAULT 0,
      outcome TEXT,
      current_action TEXT,
      action_kind TEXT,
      started_at INTEGER,
      last_event_at INTEGER,
      ended_at INTEGER,
      end_reason TEXT,
      hook_state TEXT,
      hook_state_at INTEGER,
      needs_message TEXT,
      tok_in INTEGER DEFAULT 0,
      tok_out INTEGER DEFAULT 0,
      tok_cache_read INTEGER DEFAULT 0,
      tok_cache_write INTEGER DEFAULT 0,
      tok_sub INTEGER DEFAULT 0,
      model TEXT,
      cost_usd REAL,
      lines_added INTEGER,
      lines_removed INTEGER,
      commits INTEGER DEFAULT 0,
      tools INTEGER DEFAULT 0,
      pr_url TEXT,
      pr_state TEXT,
      pr_checked_at INTEGER,
      subagent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_event_at);
    CREATE TABLE IF NOT EXISTS offsets(path TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_msg TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, kind TEXT, text TEXT);
    CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
    -- One row per API reply, keyed by message id: a resumed session copies earlier replies into its new transcript, and they must count once.
    CREATE TABLE IF NOT EXISTS usage(msg_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, usd REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, ts);
    CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
    CREATE TABLE IF NOT EXISTS agents(key TEXT PRIMARY KEY, name TEXT, shape TEXT, color TEXT, accessory TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS segments(session_id TEXT, start INTEGER, end INTEGER, kind TEXT);
    CREATE INDEX IF NOT EXISTS segments_session ON segments(session_id);
    CREATE INDEX IF NOT EXISTS segments_start ON segments(start);
    CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER);
    CREATE TABLE IF NOT EXISTS note_reach(note_id INTEGER NOT NULL, session_id TEXT NOT NULL, at INTEGER, PRIMARY KEY(note_id, session_id));
  `);
  migrate(db);
  return db;
}

export type Db = ReturnType<typeof openDb>;

const SCHEMA = 3; // 3: per-reply usage rows priced at API rates (sessions.api_usd)
const ADD: Record<string, Record<string, string>> = {
  sessions: {
    agent_key: 'TEXT', job: 'TEXT', err_sig: 'TEXT', err_count: 'INTEGER DEFAULT 0', err_at: 'INTEGER',
    test_at: 'INTEGER', test_ok: 'INTEGER', tests_ok: 'INTEGER DEFAULT 0', tests_fail: 'INTEGER DEFAULT 0',
    files: 'TEXT', edits: 'INTEGER DEFAULT 0', asks: 'INTEGER DEFAULT 0', reads: 'INTEGER DEFAULT 0', webs: 'INTEGER DEFAULT 0',
    stamp: 'TEXT', stamp_at: 'INTEGER', pr_merged_at: 'INTEGER', entrypoint: 'TEXT',
    focus: 'TEXT', focus_for: 'TEXT', job_verdict: 'TEXT', api_usd: 'REAL DEFAULT 0',
  },
  projects: { display_name: 'TEXT', display_source: 'TEXT', naming_tried_at: 'INTEGER', summary: 'TEXT', summary_tried_at: 'INTEGER' },
  offsets: { state: 'TEXT' },
  agents: { job: 'TEXT' },
};

/** Adds new columns, and on a schema bump re-derives everything from transcripts (keeps hook data). */
function migrate(db: DatabaseSync) {
  for (const [table, cols] of Object.entries(ADD)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => r.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS events_unique ON events(session_id, ts, kind, text)');
  // Hands raised by a background job's notice to the terminal that launched it ("<job> needs your input: …") were never the
  // terminal's own and nothing would ever lower them (hooks.ts now ignores those notices): bring them down.
  db.exec("UPDATE sessions SET hook_state = 'idle', needs_message = NULL WHERE hook_state = 'needs_input' AND needs_message LIKE '% needs your input%' AND needs_message NOT LIKE 'Claude %'");
  const v = (db.prepare("SELECT v FROM kv WHERE k = 'schema'").get() as Row | undefined)?.v;
  if (Number(v ?? 1) < SCHEMA) {
    db.exec(`
      DELETE FROM offsets;
      DELETE FROM usage;
      DELETE FROM segments;
      DELETE FROM events WHERE kind LIKE 'm_%';
      UPDATE sessions SET tok_in = 0, tok_out = 0, tok_cache_read = 0, tok_cache_write = 0, tok_sub = 0, prompts = 0, commits = 0, tools = 0,
        edits = 0, asks = 0, reads = 0, webs = 0, api_usd = 0, tests_ok = 0, tests_fail = 0, err_count = 0, err_sig = NULL, files = NULL, first_prompt = NULL;
    `);
    db.prepare("INSERT INTO kv(k, v) VALUES('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(SCHEMA));
  }
}

export function kvGet<T>(db: Db, k: string, fallback: T): T {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as Row | undefined;
  return r ? JSON.parse(r.v) : fallback;
}
export function kvSet(db: Db, k: string, v: unknown) {
  db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
}

export function logEvent(db: Db, sessionId: string, ts: number, kind: string, text: string) {
  db.prepare('INSERT OR IGNORE INTO events(session_id, ts, kind, text) VALUES(?, ?, ?, ?)').run(sessionId, ts, kind, text.slice(0, 400));
}
