import type { Db, Row } from './db.ts';
import { projectIdFor, projectNameFor, resolveRepo } from './git.ts';

/** Ensures a project row exists for a session cwd and returns its id plus the worktree name. */
export function ensureProjectForCwd(db: Db, cwd: string): { projectId: string; worktree: string | null } {
  const info = resolveRepo(cwd);
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
  return { projectId: id, worktree: info.worktree };
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
