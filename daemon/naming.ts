import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import { DATA_DIR } from './config.ts';

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
  if (!claudeBin) console.error('[logbook] naming: could not find the claude CLI; using folder names');
  return claudeBin;
}

/** Asks the small Claude model, through the user's own Claude Code login, for a 1–3 word plain name. */
export function askClaude(prompt: string): Promise<string | null> {
  const bin = findClaude();
  if (!bin) return Promise.resolve(null);
  const cwd = path.join(DATA_DIR, 'namer');
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve) => {
    execFile(bin, ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'text', prompt], {
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
