import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type RepoInfo = {
  root: string;
  remote: string | null;
  ghFull: string | null; // "owner/name"
  worktree: string | null; // name of the worktree dir when cwd is a linked worktree
  inGit: boolean; // false for a plain folder: then the folder Claude started in is all we know
};

const WORKTREE_MARKERS = ['/.claude/worktrees/', '/.worktrees/', '/worktrees/'];

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Parses GitHub "owner/name" out of any common remote URL form. */
export function parseGithubRemote(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Fallback when a path no longer exists (deleted worktree): strip the worktree suffix. */
export function rootFromPath(cwd: string): { root: string; worktree: string | null } {
  for (const marker of WORKTREE_MARKERS) {
    const i = cwd.indexOf(marker);
    if (i > 0) {
      const rest = cwd.slice(i + marker.length).split('/')[0];
      return { root: cwd.slice(0, i), worktree: rest || null };
    }
  }
  return { root: cwd, worktree: null };
}

const cache = new Map<string, RepoInfo>();

export function resolveRepo(cwd: string): RepoInfo {
  const hit = cache.get(cwd);
  if (hit) return hit;
  let info: RepoInfo;
  const fallback = rootFromPath(cwd);
  if (fs.existsSync(cwd)) {
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common) {
      const root = path.basename(common) === '.git' ? path.dirname(common) : common.replace(/\.git$/, '');
      const top = git(cwd, ['rev-parse', '--show-toplevel']);
      const worktree = top && path.resolve(top) !== path.resolve(root) ? path.basename(top) : fallback.worktree;
      const remote = git(root, ['remote', 'get-url', 'origin']);
      info = { root, remote, ghFull: parseGithubRemote(remote), worktree, inGit: true };
    } else {
      info = { root: fallback.root, remote: null, ghFull: null, worktree: fallback.worktree, inGit: false };
    }
  } else {
    const remote = fs.existsSync(fallback.root) ? git(fallback.root, ['remote', 'get-url', 'origin']) : null;
    info = { root: fallback.root, remote, ghFull: parseGithubRemote(remote), worktree: fallback.worktree, inGit: remote !== null || fs.existsSync(path.join(fallback.root, '.git')) };
  }
  cache.set(cwd, info);
  return info;
}

export function projectIdFor(info: Pick<RepoInfo, 'ghFull' | 'root'>): string {
  return info.ghFull ? `gh:${info.ghFull.toLowerCase()}` : `local:${info.root}`;
}

export function projectNameFor(info: Pick<RepoInfo, 'ghFull' | 'root'>): string {
  if (info.root === '/' || info.root === os.homedir()) return 'Scratch';
  return path.basename(info.root) || info.ghFull?.split('/')[1] || info.root;
}
