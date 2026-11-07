import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Db, Row } from './db.ts';

/*
 * When an agent clocks out, stamp what really happened, from git rather than from what it said:
 *   shipped   - its PR merged, or its commits are on the default branch upstream
 *   review    - a PR is open
 *   saved     - it committed, but nothing is pushed / no PR
 *   unfinished- it changed files that are still uncommitted
 *   scrapped  - it changed files but nothing was kept
 *   chat      - it never changed anything (questions, research)
 */
export type Stamp = 'shipped' | 'review' | 'saved' | 'unfinished' | 'scrapped' | 'chat';

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export function stampFor(s: Row): Stamp {
  if (s.pr_state === 'merged') return 'shipped';
  if (s.pr_url && s.pr_state !== 'closed') return 'review';
  const touched = (s.edits ?? 0) > 0 || (s.lines_added ?? 0) > 0;
  const cwd: string | null = s.cwd && fs.existsSync(s.cwd) ? s.cwd : null;
  if (cwd && touched) {
    const files: string[] = s.files ? (JSON.parse(s.files) as { p: string }[]).map((f) => f.p) : [];
    const dirty = git(cwd, ['status', '--porcelain']);
    if (dirty && files.some((f) => dirty.includes(f.replace(cwd + '/', '')))) return 'unfinished';
  }
  // Changes committed later (by you, or another session) still count as kept.
  let keptLater = false;
  if (cwd && touched && !(s.commits > 0) && s.started_at) {
    const files: string[] = s.files ? (JSON.parse(s.files) as { p: string }[]).map((f) => f.p).slice(-6) : [];
    keptLater = files.some((f) => !!git(cwd, ['log', '-1', '--format=%ct', `--since=${Math.floor(s.started_at / 1000)}`, '--', f]));
  }
  if ((s.commits ?? 0) > 0 || keptLater) {
    if (cwd) {
      const upstream = git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']);
      const ahead = upstream ? Number(git(cwd, ['rev-list', '--count', '@{u}..HEAD']) ?? 1) : 1;
      if (upstream && ahead === 0 && /\/(main|master|trunk)$/.test(upstream)) return 'shipped';
    }
    return 'saved';
  }
  if (touched) return cwd ? 'scrapped' : 'saved';
  return 'chat';
}

/** Stamps recently closed sessions; restamps when their PR state moves. */
export function stampClosed(db: Db, liveIds: Set<string>, limit = 25) {
  const rows = db.prepare(`SELECT * FROM sessions WHERE project_id IS NOT NULL AND last_event_at > ?
      AND (stamp IS NULL OR stamp_at < ? OR (stamp IN ('review','saved') AND stamp_at < ?))
    ORDER BY last_event_at DESC LIMIT ?`).all(Date.now() - 14 * 24 * 3600_000, Date.now() - 24 * 3600_000, Date.now() - 10 * 60_000, limit * 2) as Row[];
  let n = 0;
  for (const s of rows) {
    if (liveIds.has(s.id)) continue;
    if (n++ >= limit) break;
    db.prepare('UPDATE sessions SET stamp = ?, stamp_at = ? WHERE id = ?').run(stampFor(s), Date.now(), s.id);
  }
}

export function sizeFor(added: number | null, removed: number | null): 'tweak' | 'fix' | 'feature' | 'overhaul' | null {
  const n = (added ?? 0) + (removed ?? 0);
  if (!n) return null;
  return n < 25 ? 'tweak' : n < 160 ? 'fix' : n < 700 ? 'feature' : 'overhaul';
}
