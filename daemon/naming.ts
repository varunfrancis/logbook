import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import { DATA_DIR, OWN_MARK } from './config.ts';

/* Plain-English project names ("Support Bot", "Sales Training") and the town's name. */

export function fallbackName(repo: string): string {
  return repo.replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()).trim().slice(0, 32) || repo;
}

function readSnippet(root: string | null): string {
  if (!root) return '';
  for (const f of ['README.md', 'readme.md', 'README', 'README.mdx']) {
    try { return fs.readFileSync(path.join(root, f), 'utf8').replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').slice(0, 1800); } catch {}
  }
  return '';
}
function pkgDescription(root: string | null): string {
  if (!root) return '';
  try { const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); return [p.name, p.description].filter(Boolean).join(': '); } catch { return ''; }
}

let claudeBin: string | null | undefined;
function findClaude(): string | null {
  if (claudeBin !== undefined) return claudeBin;
  const candidates = [path.join(process.env.HOME ?? '', '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  claudeBin = candidates.find((c) => fs.existsSync(c)) ?? null;
  if (!claudeBin) { try { claudeBin = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim() || null; } catch { claudeBin = null; } }
  if (!claudeBin) claudeBin = desktopClaude();
  if (!claudeBin) console.error('[logbook] naming: could not find the claude CLI; using folder names');
  return claudeBin;
}

/**
 * People who only use the Claude desktop app have no `claude` command, but the app keeps its own copy of Claude Code,
 * which answers with the same login. Its location isn't documented, so this is a best-effort fallback: newest version wins.
 */
function desktopClaude(): string | null {
  const root = path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
    for (const v of versions) for (const id of fs.readdirSync(path.join(root, v))) {
      const bin = path.join(root, v, id, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}
  return null;
}

/** Asks the small Claude model, through the user's own Claude Code login, for a 1–3 word plain name. */
export function askClaude(prompt: string): Promise<string | null> {
  const bin = findClaude();
  if (!bin) return Promise.resolve(null);
  const cwd = path.join(DATA_DIR, 'namer');
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve) => {
    execFile(bin, ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'text', `${OWN_MARK}\n${prompt}`], {
      cwd, timeout: 90_000, env: { ...process.env, LOGBOOK_DISABLE: '1' }, maxBuffer: 1 << 20,
    }, (err, stdout, stderr) => {
      if (err) console.error('[logbook] naming: claude failed:', String(err.message).slice(0, 200), String(stderr).slice(0, 300));
      resolve(err ? null : String(stdout).trim());
    });
  });
}

export function cleanName(raw: string | null): string | null {
  if (!raw) return null;
  const line = raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const name = line.replace(/^(name|answer)\s*:\s*/i, '').replace(/["'`*.]/g, '').trim();
  if (!name || name.length > 32 || name.split(/\s+/).length > 4) return null;
  return name;
}

let running = false;
/** Names one project per call that still needs a name. Local projects first. */
export async function nameNextProject(db: Db): Promise<boolean> {
  if (running) return false;
  const p = db.prepare(`SELECT * FROM projects WHERE display_name IS NULL AND root IS NOT NULL AND (naming_tried_at IS NULL OR naming_tried_at < ?)
    ORDER BY (root IS NULL), COALESCE(last_activity, gh_pushed_at, 0) DESC LIMIT 1`).get(Date.now() - 24 * 3600_000) as Row | undefined;
  if (!p) return false;
  running = true;
  try {
    const repo = p.gh_full?.split('/')[1] ?? p.name;
    const prompt = [
      'You name software projects for non-technical people.',
      'Reply with ONLY a 1-3 word plain-English name for what this project does, in Title Case. No quotes or punctuation.',
      'Prefer what it does for people over technology. Examples: Support Bot, Sales Training, Expense Tracker, Meeting Notes, Exam Prep App.',
      `Repo name: ${repo}`,
      p.gh_description ? `GitHub description: ${p.gh_description}` : '',
      pkgDescription(p.root) ? `package.json: ${pkgDescription(p.root)}` : '',
      readSnippet(p.root) ? `README excerpt:\n${readSnippet(p.root)}` : '',
    ].filter(Boolean).join('\n');
    const raw = await askClaude(prompt);
    const name = cleanName(raw);
    if (raw != null && !name) console.error('[logbook] naming: unusable reply:', raw.slice(0, 120));
    db.prepare('UPDATE projects SET naming_tried_at = ?, display_name = COALESCE(?, display_name), display_source = CASE WHEN ? IS NOT NULL THEN ? ELSE display_source END WHERE id = ? AND (display_source IS NULL OR display_source != ?)')
      .run(Date.now(), name, name, 'ai', p.id, 'user');
    return !!name;
  } finally {
    running = false;
  }
}

/**
 * Names many projects in one small-model call, so a first run shows "Support Bot" right away
 * instead of folder names trickling in one every 20 seconds.
 */
export async function nameProjectsBatch(db: Db, limit = 40): Promise<number> {
  if (running) return 0;
  const rows = db.prepare(`SELECT * FROM projects WHERE display_name IS NULL AND root IS NOT NULL AND (naming_tried_at IS NULL OR naming_tried_at < ?)
    ORDER BY COALESCE(last_activity, gh_pushed_at, 0) DESC LIMIT ?`).all(Date.now() - 24 * 3600_000, limit) as Row[];
  if (rows.length < 2) return 0;
  running = true;
  try {
    const list = rows.map((p, i) => {
      const repo = p.gh_full?.split('/')[1] ?? p.name;
      const about = [p.gh_description, pkgDescription(p.root), readSnippet(p.root).replace(/\s+/g, ' ').slice(0, 280)].filter(Boolean).join(' | ');
      return `${i + 1}. ${repo}${about ? ` | ${about}` : ''}`;
    }).join('\n');
    const prompt = [
      'You name software projects for non-technical people.',
      'For each numbered project below, give a 1-3 word plain-English name for what it does, in Title Case, no quotes or punctuation.',
      'Prefer what it does for people over technology. Examples: Support Bot, Sales Training, Expense Tracker, Meeting Notes, Exam Prep App.',
      'Give different projects different names. Reply with ONLY one line per project, in the form "<number>: <Name>".',
      '',
      list,
    ].join('\n');
    const names = parseNumbered(await askClaude(prompt), rows.length);
    const now = Date.now();
    const upd = db.prepare('UPDATE projects SET naming_tried_at = ?, display_name = COALESCE(?, display_name), display_source = CASE WHEN ? IS NOT NULL THEN ? ELSE display_source END WHERE id = ? AND (display_source IS NULL OR display_source != ?)');
    let n = 0;
    rows.forEach((p, i) => { const name = names[i] ?? null; if (name) n++; upd.run(now, name, name, 'ai', p.id, 'user'); });
    return n;
  } finally {
    running = false;
  }
}

/** "1: Support Bot" lines → names by position; anything unusable is null. */
export function parseNumbered(raw: string | null, count: number): (string | null)[] {
  const out: (string | null)[] = Array(count).fill(null);
  for (const l of (raw ?? '').split('\n')) {
    const m = l.trim().match(/^(\d+)\s*[:.)-]\s*(.+)$/);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i >= 0 && i < count && !out[i]) out[i] = cleanName(m[2]);
  }
  return out;
}

/** One plain sentence on what a project does, for agent profiles and project cards. One project per call. */
export async function summarizeNextProject(db: Db): Promise<boolean> {
  if (running) return false;
  const p = db.prepare(`SELECT * FROM projects WHERE summary IS NULL AND root IS NOT NULL AND display_name IS NOT NULL AND (summary_tried_at IS NULL OR summary_tried_at < ?)
    ORDER BY COALESCE(last_activity, 0) DESC LIMIT 1`).get(Date.now() - 24 * 3600_000) as Row | undefined;
  if (!p) return false;
  running = true;
  try {
    const recent = (db.prepare('SELECT ai_title, first_prompt FROM sessions WHERE project_id = ? ORDER BY last_event_at DESC LIMIT 6').all(p.id) as Row[])
      .map((r) => `- ${(r.ai_title || '').slice(0, 60)} ${(r.first_prompt || '').replace(/\s+/g, ' ').slice(0, 140)}`).join('\n');
    const prompt = [
      'Describe this software project in ONE plain-English sentence of at most 14 words, for a non-technical reader.',
      'Say what it does for people. No marketing words, no tech stack, no quotes. Reply with only the sentence.',
      `Project name: ${p.display_name}`,
      p.gh_description ? `GitHub description: ${p.gh_description}` : '',
      pkgDescription(p.root) ? `package.json: ${pkgDescription(p.root)}` : '',
      readSnippet(p.root) ? `README excerpt:\n${readSnippet(p.root).slice(0, 1200)}` : '',
      recent ? `Recent work requests:\n${recent}` : '',
    ].filter(Boolean).join('\n');
    const raw = await askClaude(prompt);
    const line = raw?.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.replace(/^["'`]|["'`]$/g, '') ?? null;
    const ok = line && line.length <= 140 && line.split(/\s+/).length <= 22 ? line : null;
    db.prepare('UPDATE projects SET summary_tried_at = ?, summary = COALESCE(?, summary) WHERE id = ?').run(Date.now(), ok, p.id);
    return !!ok;
  } finally {
    running = false;
  }
}

export function renameProject(db: Db, id: string, name: string | null) {
  const n = name?.trim().slice(0, 40) || null;
  db.prepare('UPDATE projects SET display_name = ?, display_source = ? WHERE id = ?').run(n, n ? 'user' : null, id);
}

// ---------- town ----------
export type Town = { name: string; chosen: boolean; suggestions: string[]; owner: string };

function ownerFirstName(): string {
  try { const n = execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000 }).trim(); if (n) return n.split(/\s+/)[0]; } catch {}
  return process.env.USER ? process.env.USER.replace(/^\w/, (c) => c.toUpperCase()) : 'My';
}

export function town(db: Db): Town {
  const saved = kvGet<{ name: string; chosen: boolean } | null>(db, 'town', null);
  const owner = ownerFirstName();
  const suggestions = [`${owner}ville`, 'Port Merge', 'Commit Hill', `${owner}'s Harbor`];
  return { name: saved?.name ?? suggestions[0], chosen: !!saved?.chosen, suggestions, owner };
}

export function setTown(db: Db, name: string) {
  kvSet(db, 'town', { name: name.trim().slice(0, 40) || town(db).suggestions[0], chosen: true });
}
