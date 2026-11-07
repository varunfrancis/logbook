import { execFileSync } from 'node:child_process';
import type { Db, Row } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import type { GithubMeta } from './types.ts';

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

async function gh(token: string, url: string): Promise<{ status: number; body: any; next: string | null }> {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'logbook-local', 'X-GitHub-Api-Version': '2022-11-28' },
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

/** Looks up the PR for each recently active session's branch (or the PR URL it printed). */
export async function checkPullRequests(db: Db, liveIds: Set<string>) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT s.id, s.branch, s.pr_url, s.pr_checked_at, p.gh_full, p.gh_account
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE p.gh_full IS NOT NULL AND s.last_event_at > ? AND (s.branch IS NOT NULL OR s.pr_url IS NOT NULL)
    ORDER BY s.last_event_at DESC LIMIT 60`).all(now - 3 * 24 * 3600_000) as Row[];
  const logins = listAccountsCached();
  let budget = 15;
  for (const s of rows) {
    if (budget <= 0) break;
    const ttl = liveIds.has(s.id) ? 3 * 60_000 : 30 * 60_000;
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
        if (r.status === 200) { found = Array.isArray(r.body) ? r.body[0] ?? false : r.body; break; }
      } catch {}
    }
    db.prepare('UPDATE sessions SET pr_checked_at = ?, pr_url = COALESCE(?, pr_url), pr_state = COALESCE(?, pr_state) WHERE id = ?').run(
      now, found ? found.html_url : null, found ? (found.merged_at ? 'merged' : found.state) : null, s.id);
  }
}

let accountsCache: { at: number; list: string[] } = { at: 0, list: [] };
function listAccountsCached() {
  if (Date.now() - accountsCache.at > 10 * 60_000) accountsCache = { at: Date.now(), list: listAccounts() };
  return accountsCache.list;
}
