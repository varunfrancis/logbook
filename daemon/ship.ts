import type { Db, Row } from './db.ts';
import type { ChecksState, ShipPhase, ShipView } from './types.ts';

/*
 * "Ship it": the agent behind a finished job comes back (in VS Code or Terminal, like Resume) with a brief to take the
 * work all the way to review: finish, check, save on its own branch, send for review, get the checks green.
 * It never merges. Going live is your call, made in Swarmville with "Put it live" (github.ts mergePullRequest).
 *
 * Progress is read from what really happened (commits, the review, its checks), not from what the agent says.
 * Resuming can continue under a new session id, so a ship follows every shift in the same folder that took the brief.
 */

/** Starts every brief, so the shifts that took it can be found again. */
export const SHIP_MARK = 'Ship it (from Swarmville)';
/** A ship that has gone nowhere for this long drops off the list. */
const KEEP_MS = 7 * 24 * 3600_000;
/** After it goes live, the row stays a little while so you see it land. */
const LIVE_SHOWN_MS = 30 * 60_000;

export function shipBrief(mode: 'ship' | 'fix', onGithub: boolean): string {
  if (mode === 'fix') {
    return `${SHIP_MARK}: the automated checks on your review are failing. Find out why, fix it, push the fix to the same review, `
      + `and wait for the checks again (gh pr checks --watch). Try up to 3 times. Do NOT merge: the owner puts it live from Swarmville. `
      + `End with one plain sentence on where it stands.`;
  }
  const send = onGithub
    ? `4. Push the branch and open a pull request for review (gh pr create --fill), unless one is already open for it, in which case push to that one. `
      + `5. Wait for its checks (gh pr checks --watch). If they fail, fix and push again, up to 3 tries. `
      + `6. Do NOT merge, and don't push to the main branch: the owner reviews it and puts it live from Swarmville. `
    : `4. This project isn't on GitHub, so stop once it's committed. `;
  return `${SHIP_MARK}: please take this job all the way to review. `
    + `1. Finish whatever is still left from our conversation. If you're unsure what's left, finish the smallest version that works. `
    + `If this project has its own instructions for finishing work (CLAUDE.md, CLAUDE.local.md), follow them, except never merge. `
    + `2. Run the project's own checks (tests, typecheck, build: whichever exist) and fix what fails. `
    + `3. Commit the work on its own branch (if you're on main or master, make a new branch first). `
    + send
    + `End with one plain sentence on where it stands.`;
}

export function startShip(db: Db, sessionId: string, mode: 'ship' | 'fix', cwd: string | null = null, now = Date.now()) {
  const s = db.prepare('SELECT id, project_id, cwd FROM sessions WHERE id = ?').get(sessionId) as Row | undefined;
  if (!s) return null;
  // Shipping a shift that is itself part of a ship keeps the original row (so Today lists it once).
  const owner = shipOwning(db, sessionId);
  const id = owner ?? sessionId;
  // `at` stays the first press (shifts from then on belong to it); `last_at` is the latest, for the "just started" grace period.
  // A ship you'd let go or that had landed starts over.
  db.prepare(`INSERT INTO ships(session_id, project_id, cwd, at, last_at, mode) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET cwd = COALESCE(ships.cwd, excluded.cwd),
      at = CASE WHEN ships.cleared_at IS NOT NULL OR ships.merged_at IS NOT NULL THEN excluded.at ELSE ships.at END,
      last_at = excluded.last_at, mode = excluded.mode, cleared_at = NULL, merged_at = NULL`)
    .run(id, s.project_id, cwd ?? s.cwd, now, now, mode);
  return id;
}

export function clearShip(db: Db, id: string, now = Date.now()) {
  db.prepare('UPDATE ships SET cleared_at = ? WHERE session_id = ?').run(now, shipOwning(db, id) ?? id);
}

/** The ship a shift belongs to, if any. */
function shipOwning(db: Db, sessionId: string): string | null {
  for (const sh of db.prepare('SELECT * FROM ships WHERE cleared_at IS NULL').all() as Row[]) {
    if (shiftsOf(db, sh).some((r) => r.id === sessionId)) return sh.session_id;
  }
  return null;
}

/** The shifts doing a ship's work, newest activity first: the job itself, and any later shift in its folder that took the brief. */
function shiftsOf(db: Db, sh: Row): Row[] {
  const rows = db.prepare(`SELECT * FROM sessions WHERE id = ? OR (cwd = ? AND COALESCE(started_at, last_event_at) >= ?)
    ORDER BY COALESCE(last_event_at, 0) DESC`).all(sh.session_id, sh.cwd ?? '', sh.at - 10_000) as Row[];
  const orig = rows.find((r) => r.id === sh.session_id);
  const workbench = orig?.agent_key && String(orig.agent_key).includes('#') ? orig.agent_key : null;
  return rows.filter((r) => r.id === sh.session_id
    || String(r.first_prompt ?? '').includes(SHIP_MARK) || String(r.last_prompt ?? '').includes(SHIP_MARK)
    || (!!workbench && r.agent_key === workbench));
}

export type PhaseInput = {
  status: 'running' | 'needs_input' | 'idle' | 'ended';
  prUrl: string | null; prState: string | null; checks: ChecksState | null;
  sinceStart: number; // ms since you pressed Ship it
  /** The job merged a review itself (e.g. "merge the open PRs") and saved nothing after: its work is already live. */
  mergedItself?: boolean;
};

/**
 * Where it stands. "ready" (Put it live) needs: an open review, checks passing or none at all, and the agent done with it,
 * so it can't change under you while you decide.
 */
export function shipPhase(p: PhaseInput): ShipPhase {
  const busy = p.status === 'running' || p.status === 'needs_input';
  if (p.prState === 'merged') return 'live';
  if (p.prUrl && p.prState !== 'closed') {
    if (p.checks === 'failing') return busy ? 'checks' : 'failing';
    if (p.checks === 'pending') return 'checks';
    if (busy) return 'review';
    return p.checks === 'passing' || p.checks === 'none' ? 'ready' : 'checks'; // not looked up yet
  }
  // The terminal takes a moment to open and Claude a moment to start: don't call it stopped before it began.
  if (busy || p.sinceStart < 90_000) return 'working';
  return p.mergedItself ? 'live' : 'stopped';
}

export function shipsView(db: Db, statusOf: (r: Row) => PhaseInput['status'], now = Date.now()): ShipView[] {
  const out: ShipView[] = [];
  const onGithub = (projectId: string | null) => !!projectId && !!(db.prepare('SELECT gh_full FROM projects WHERE id = ?').get(projectId) as Row | undefined)?.gh_full;
  for (const sh of db.prepare('SELECT * FROM ships WHERE cleared_at IS NULL AND COALESCE(last_at, at) > ? ORDER BY COALESCE(last_at, at) DESC').all(now - KEEP_MS) as Row[]) {
    const shifts = shiftsOf(db, sh);
    if (!shifts.length) continue;
    // The review lives on whichever shift opened it; the newest shift is the one at work.
    const cur = shifts[0];
    const withPr = shifts.find((r) => r.pr_url && r.pr_state !== 'closed') ?? shifts.find((r) => r.pr_url) ?? null;
    const mergedAt = Math.max(0, ...shifts.map((r) => r.merged_pr_at ?? 0));
    const commitAt = Math.max(0, ...shifts.map((r) => r.commit_at ?? 0));
    const phase = shipPhase({
      status: statusOf(cur), prUrl: withPr?.pr_url ?? null, prState: withPr?.pr_state ?? null, checks: withPr?.pr_checks ?? null,
      sinceStart: now - (sh.last_at ?? sh.at), mergedItself: mergedAt > 0 && commitAt <= mergedAt,
    });
    if (phase === 'live') {
      // its own review's merge time; a job that merged others' reviews shows as landing when we first see it
      const at = sh.merged_at ?? withPr?.pr_merged_at ?? now;
      if (!sh.merged_at) db.prepare('UPDATE ships SET merged_at = ? WHERE session_id = ?').run(at, sh.session_id);
      if (now - at > LIVE_SHOWN_MS) continue;
    }
    out.push({
      id: sh.session_id, sessionId: cur.id, ids: shifts.map((r) => r.id), projectId: sh.project_id, at: sh.at,
      mode: sh.mode === 'fix' ? 'fix' : 'ship', phase,
      commits: shifts.reduce((n, r) => n + (r.commits || 0), 0),
      prUrl: withPr?.pr_url ?? null, prSession: withPr?.id ?? null, onGithub: onGithub(sh.project_id),
    });
  }
  return out;
}

/** Sessions being shipped, for checking their reviews more often. */
export function hotShipIds(ships: ShipView[]): Set<string> {
  return new Set(ships.filter((s) => s.phase !== 'live').flatMap((s) => s.ids));
}
