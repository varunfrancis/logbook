import fs from 'node:fs';
import os from 'node:os';
import type { Db, Row } from './db.ts';
import { projectIdFor, projectNameFor, resolveRepo } from './git.ts';

/** The filesystem root and the home folder are the scratch pad: they never take in the folders below them. */
const catchAll = (root: string) => root === '/' || root === os.homedir();

/** The nearest project folder (outside git) that contains `root`, so a plain folder's sub-folders stay one building. */
function enclosingProject(db: Db, root: string): string | null {
  let best: Row | null = null;
  for (const r of db.prepare("SELECT id, root FROM projects WHERE id LIKE 'local:%' AND root IS NOT NULL").all() as Row[]) {
    if (!catchAll(r.root) && root.startsWith(r.root + '/') && (!best || r.root.length > best.root.length)) best = r;
  }
  return best?.id ?? null;
}

/** Ensures a project row exists for a session cwd and returns its id plus the worktree name. */
export function ensureProjectForCwd(db: Db, cwd: string): { projectId: string; worktree: string | null } {
  const info = resolveRepo(cwd);
  if (!info.inGit && !catchAll(info.root)) {
    const parent = enclosingProject(db, info.root);
    if (parent) return { projectId: parent, worktree: info.worktree };
  }
  const id = projectIdFor(info);
  const existing = db.prepare('SELECT id, root FROM projects WHERE id = ?').get(id) as Row | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO projects(id, name, root, remote, gh_full, gh_url, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)'
    ).run(id, projectNameFor(info), info.root, info.remote, info.ghFull, info.ghFull ? `https://github.com/${info.ghFull}` : null, Date.now());
  } else if (!existing.root) {
    // Repo first seen on GitHub, now found locally.
    db.prepare('UPDATE projects SET root = ?, remote = ?, name = ? WHERE id = ?').run(info.root, info.remote, projectNameFor(info), id);
  }
  // The folder got a GitHub remote after we'd already met it: its old building becomes this one.
  if (info.ghFull) mergeProject(db, `local:${info.root}`, id);
  return { projectId: id, worktree: info.worktree };
}

/**
 * Folds one project into another: sessions, notes and crew identities move over and `fromId` is removed.
 * The building that was there first keeps its name, summary and lot, unless the person named the other one.
 */
export function mergeProject(db: Db, fromId: string, intoId: string) {
  if (fromId === intoId) return;
  const get = db.prepare('SELECT p.*, (SELECT MIN(started_at) FROM sessions s WHERE s.project_id = p.id) AS first FROM projects p WHERE p.id = ?');
  const from = get.get(fromId) as Row | undefined;
  const into = get.get(intoId) as Row | undefined;
  if (!from || !into) return;
  const older = (from.first ?? Infinity) < (into.first ?? Infinity) ? from : into;
  const keep = into.display_source === 'user' ? into : from.display_source === 'user' ? from : older;
  const lot = older.lot ?? into.lot ?? from.lot ?? null;
  const pre = `${fromId}#`, to = `${intoId}#`;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ?').run(intoId, fromId);
    db.prepare('UPDATE sessions SET agent_key = ? || substr(agent_key, ?) WHERE substr(agent_key, 1, ?) = ?').run(to, pre.length + 1, pre.length, pre);
    // Crew already living in the target keeps its look; anyone new moves in with theirs.
    db.prepare('UPDATE OR IGNORE agents SET key = ? || substr(key, ?) WHERE substr(key, 1, ?) = ?').run(to, pre.length + 1, pre.length, pre);
    db.prepare('DELETE FROM agents WHERE substr(key, 1, ?) = ?').run(pre.length, pre);
    db.prepare('UPDATE notes SET project_id = ? WHERE project_id = ?').run(intoId, fromId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(fromId);
    const born = from.created_at ?? Date.now();
    db.prepare(`UPDATE projects SET display_name = ?, display_source = ?, summary = COALESCE(?, summary), lot = ?, root = COALESCE(root, ?),
      created_at = MIN(COALESCE(created_at, ?), ?), last_activity = MAX(COALESCE(last_activity, 0), ?) WHERE id = ?`)
      .run(keep.display_name ?? null, keep.display_source ?? null, keep.summary ?? null, lot, from.root ?? null, born, born, from.last_activity ?? 0, intoId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Startup pass: joins buildings that turned out to be the same project (a remote added later, or a sub-folder met first). */
export function consolidateProjects(db: Db) {
  const rows = db.prepare("SELECT id, root FROM projects WHERE id LIKE 'local:%' AND root IS NOT NULL ORDER BY length(root)").all() as Row[];
  for (const r of rows) {
    if (catchAll(r.root) || !fs.existsSync(r.root)) continue;
    const info = resolveRepo(r.root);
    if (info.ghFull) ensureProjectForCwd(db, r.root);
    else if (!info.inGit) {
      const parent = enclosingProject(db, r.root);
      if (parent) mergeProject(db, r.id, parent);
    }
  }
}

export function touchProject(db: Db, projectId: string, ts: number) {
  db.prepare('UPDATE projects SET last_activity = MAX(COALESCE(last_activity, 0), ?) WHERE id = ?').run(ts, projectId);
}

/** Square spiral from the center: index -> grid cell. Stable, so lots never move. */
export function spiral(n: number): [number, number] {
  if (n === 0) return [0, 0];
  let x = 0, y = 0, dx = 1, dy = 0, len = 1, step = 0, turned = 0;
  for (let i = 0; i < n; i++) {
    x += dx; y += dy; step++;
    if (step === len) {
      step = 0;
      [dx, dy] = [-dy, dx];
      if (++turned % 2 === 0) len++;
    }
  }
  return [x, y];
}

/** Gives every project without a lot the next free lot. Busy, local projects get inner lots first. */
export function assignLots(db: Db) {
  const pending = db.prepare(
    'SELECT id FROM projects WHERE lot IS NULL ORDER BY (root IS NULL), COALESCE(last_activity, gh_pushed_at, 0) DESC'
  ).all() as Row[];
  if (!pending.length) return;
  let next = ((db.prepare('SELECT MAX(lot) AS m FROM projects').get() as Row).m ?? -1) + 1;
  const upd = db.prepare('UPDATE projects SET lot = ? WHERE id = ?');
  for (const p of pending) upd.run(next++, p.id);
}
