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
  `);
  return db;
}

export type Db = ReturnType<typeof openDb>;

export function kvGet<T>(db: Db, k: string, fallback: T): T {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as Row | undefined;
  return r ? JSON.parse(r.v) : fallback;
}
export function kvSet(db: Db, k: string, v: unknown) {
  db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
}

export function logEvent(db: Db, sessionId: string, ts: number, kind: string, text: string) {
  db.prepare('INSERT INTO events(session_id, ts, kind, text) VALUES(?, ?, ?, ?)').run(sessionId, ts, kind, text.slice(0, 400));
}
