import { execFileSync } from 'node:child_process';
import type { Db, Row } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import type { ChecksState, GithubMeta } from './types.ts';

const API = 'https://api.github.com';

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    return String(e?.stdout ?? '') + String(e?.stderr ?? '');
  }
}

/** Logins the gh CLI is signed into (all accounts, not just the active one). */
export function listAccounts(): string[] {
  const out = sh('gh', ['auth', 'status', '--hostname', 'github.com']);
  return [...new Set([...out.matchAll(/account\s+(\S+)/g)].map((m) => m[1]))];
}

const tokens = new Map<string, string>();
function tokenFor(login: string): string | null {
  if (!tokens.has(login)) {
    const t = sh('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login]).trim();
    if (/^(gh[opsu]_|github_pat_)/.test(t)) tokens.set(login, t);
  }
  return tokens.get(login) ?? null;
}

async function gh(token: string, url: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any; next: string | null }> {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'swarmville-local', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), next };
}

/** Pulls every repo each signed-in account can see and merges them into projects (keyed gh:owner/name). */
export async function syncGithub(db: Db): Promise<GithubMeta> {
  const meta: GithubMeta = { syncedAt: Date.now(), accounts: [] };
  const upsert = db.prepare(`
    INSERT INTO projects(id, name, gh_full, gh_url, gh_private, gh_pushed_at, gh_account, gh_description, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET gh_full = excluded.gh_full, gh_url = excluded.gh_url, gh_private = excluded.gh_private,
      gh_pushed_at = excluded.gh_pushed_at, gh_account = COALESCE(projects.gh_account, excluded.gh_account), gh_description = excluded.gh_description`);
  for (const login of listAccounts()) {
    const token = tokenFor(login);
    if (!token) { meta.accounts.push({ login, repos: 0, ok: false, error: 'No token from gh CLI' }); continue; }
    try {
      let url: string | null = '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed';
      let count = 0;
      while (url) {
        const r = await gh(token, url);
        if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`GitHub returned ${r.status}`);
        for (const repo of r.body) {
          const full = String(repo.full_name);
          upsert.run(`gh:${full.toLowerCase()}`, repo.name, full, repo.html_url, repo.private ? 1 : 0,
            repo.pushed_at ? Date.parse(repo.pushed_at) : null, login, repo.description ?? null, Date.now());
          count++;
        }
        url = r.next;
      }
      meta.accounts.push({ login, repos: count, ok: true });
    } catch (e: any) {
      meta.accounts.push({ login, repos: 0, ok: false, error: e?.message ?? String(e) });
    }
  }
  if (meta.accounts.some((a) => a.ok)) {
    meta.note = 'Organization repos only appear if your gh token is authorized for that org (SSO).';
  }
  kvSet(db, 'github', meta);
  return meta;
}

export function githubMeta(db: Db): GithubMeta {
  return kvGet<GithubMeta>(db, 'github', { syncedAt: null, accounts: [] });
}

const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'HEAD', 'trunk']);

/** Folds GitHub's two kinds of checks (check runs and commit statuses) into one word. */
export function foldChecks(runs: { status?: string; conclusion?: string | null }[], statuses: { state?: string }[]): ChecksState {
  const bad = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error']);
  if (runs.some((r) => r.status === 'completed' && bad.has(String(r.conclusion))) || statuses.some((s) => bad.has(String(s.state)))) return 'failing';
  if (runs.some((r) => r.status !== 'completed') || statuses.some((s) => s.state === 'pending')) return 'pending';
  return runs.length || statuses.length ? 'passing' : 'none';
}

async function checksFor(token: string, full: string, sha: string): Promise<ChecksState | null> {
  const [runs, status] = await Promise.all([
    gh(token, `/repos/${full}/commits/${sha}/check-runs?per_page=100`),
    gh(token, `/repos/${full}/commits/${sha}/status`),
  ]);
  if (runs.status !== 200 && status.status !== 200) return null;
  return foldChecks(runs.body?.check_runs ?? [], status.body?.statuses ?? []);
}

/** Looks up the PR for each recently active session's branch (or the PR URL it printed). `hot` sessions (being shipped) are checked every 30 seconds. */
export async function checkPullRequests(db: Db, liveIds: Set<string>, hot: Set<string> = new Set()) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT s.id, s.branch, s.pr_url, s.pr_checked_at, p.gh_full, p.gh_account
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE p.gh_full IS NOT NULL AND (
      (s.last_event_at > ? AND (s.branch IS NOT NULL OR s.pr_url IS NOT NULL))
      OR (s.pr_url IS NOT NULL AND COALESCE(s.pr_state, 'open') = 'open' AND s.last_event_at > ?))
    ORDER BY s.last_event_at DESC LIMIT 80`).all(now - 3 * 24 * 3600_000, now - 45 * 24 * 3600_000) as Row[];
  const logins = listAccountsCached();
  let budget = 25;
  for (const s of rows) {
    if (budget <= 0) break;
    const ttl = hot.has(s.id) ? 25_000 : liveIds.has(s.id) ? 3 * 60_000 : 30 * 60_000;
    if (s.pr_checked_at && now - s.pr_checked_at < ttl) continue;
    if (!s.pr_url && DEFAULT_BRANCHES.has(s.branch)) continue;
    const order = [s.gh_account, ...logins].filter(Boolean) as string[];
    let found: any = null;
    for (const login of new Set(order)) {
      const token = tokenFor(login);
      if (!token) continue;
      budget--;
      try {
        const num = s.pr_url?.match(/\/pull\/(\d+)/)?.[1];
        const [owner] = String(s.gh_full).split('/');
        const r = num
          ? await gh(token, `/repos/${s.gh_full}/pulls/${num}`)
          : await gh(token, `/repos/${s.gh_full}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${s.branch}`)}`);
        if (r.status === 200) {
          found = Array.isArray(r.body) ? r.body[0] ?? false : r.body;
          if (found && found.state === 'open' && !found.merged_at && found.head?.sha) { budget -= 2; found.checks = await checksFor(token, s.gh_full, found.head.sha).catch(() => null); }
          break;
        }
      } catch {}
    }
    const newState = found ? (found.merged_at ? 'merged' : found.state) : null;
    if (found) db.prepare('UPDATE sessions SET pr_checks = ? WHERE id = ?').run(newState === 'open' ? found.checks ?? null : null, s.id);
    db.prepare(`UPDATE sessions SET pr_checked_at = ?, pr_url = COALESCE(?, pr_url),
        pr_merged_at = CASE WHEN ? = 'merged' AND COALESCE(pr_state, '') != 'merged' THEN ? ELSE pr_merged_at END,
        pr_state = COALESCE(?, pr_state) WHERE id = ?`).run(now, found ? found.html_url : null, newState, found?.merged_at ? Date.parse(found.merged_at) : now, newState, s.id);
  }
}

export type MergeResult = { ok: boolean; message: string };

/**
 * "Put it live": merges a review you approved in Swarmville, with your own gh login. Only when its checks pass
 * (or the project has none). Squash first, like the GitHub button's usual default; the repo may only allow another way.
 */
export async function mergePullRequest(db: Db, sessionId: string): Promise<MergeResult> {
  const s = db.prepare('SELECT s.id, s.pr_url, p.gh_full, p.gh_account FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(sessionId) as Row | undefined;
  const num = s?.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  if (!s || !num || !s.gh_full) return { ok: false, message: 'Couldn’t find a review for this job.' };
  const full = String(s.pr_url).match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? s.gh_full;
  for (const login of new Set([s.gh_account, ...listAccountsCached()].filter(Boolean) as string[])) {
    const token = tokenFor(login);
    if (!token) continue;
    const pr = await gh(token, `/repos/${full}/pulls/${num}`).catch(() => null);
    if (!pr || pr.status !== 200) continue;
    const b = pr.body;
    if (b.merged_at) { markMerged(db, s.id, Date.parse(b.merged_at)); return { ok: true, message: 'It was already live.' }; }
    if (b.state !== 'open') return { ok: false, message: 'This review was closed without going live.' };
    const checks = await checksFor(token, full, b.head.sha).catch(() => null);
    db.prepare('UPDATE sessions SET pr_checks = ? WHERE id = ?').run(checks, s.id);
    if (checks === 'failing') return { ok: false, message: 'Its checks are failing, so it can’t go live yet.' };
    if (checks === 'pending') return { ok: false, message: 'Its checks are still running. Try again when they pass.' };
    let last = '';
    for (const merge_method of ['squash', 'merge', 'rebase']) {
      const r = await gh(token, `/repos/${full}/pulls/${num}/merge`, 'PUT', { merge_method }).catch(() => null);
      if (r?.status === 200) {
        markMerged(db, s.id, Date.now());
        // Tidy the branch away, as GitHub's own "delete branch" does. Only for a branch in this repo; failures don't matter.
        if (b.head?.repo?.full_name === b.base?.repo?.full_name && b.head?.ref) gh(token, `/repos/${full}/git/refs/heads/${encodeURIComponent(b.head.ref)}`, 'DELETE').catch(() => {});
        return { ok: true, message: 'It’s live.' };
      }
      last = String(r?.body?.message ?? '');
      if (!(r?.status === 405 && /not allowed/i.test(last))) break; // only try another way when this repo forbids this one
    }
    if (/conflict|not mergeable/i.test(last)) return { ok: false, message: 'Someone else changed the same files since. Ask the agent to bring it up to date first.' };
    if (/review/i.test(last)) return { ok: false, message: 'GitHub wants an approving review from someone else before this can go live.' };
    return { ok: false, message: last ? `GitHub said: ${last}` : 'GitHub didn’t take the merge. Try again in a moment.' };
  }
  return { ok: false, message: 'None of your GitHub logins can see this review. Check `gh auth status`.' };
}

function markMerged(db: Db, sessionId: string, at: number) {
  db.prepare("UPDATE sessions SET pr_state = 'merged', pr_merged_at = ?, pr_checks = NULL, pr_checked_at = ?, stamp = CASE WHEN stamp IS NULL THEN NULL ELSE 'shipped' END WHERE id = ?").run(at, Date.now(), sessionId);
}

let accountsCache: { at: number; list: string[] } = { at: 0, list: [] };
function listAccountsCached() {
  if (Date.now() - accountsCache.at > 10 * 60_000) accountsCache = { at: Date.now(), list: listAccounts() };
  return accountsCache.list;
}
