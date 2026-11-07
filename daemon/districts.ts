import fs from 'node:fs';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import { kvGet, kvSet } from './db.ts';
import { askClaude, fallbackName } from './naming.ts';

/* Neighborhoods: similar projects live next to each other; unrelated ones sit a street or two apart. */

export type District = { name: string; ids: string[] };
type Saved = { groups: District[]; ids: string[]; at: number; source: 'ai' | 'auto' };

const KEY = 'districts';
const RETRY_MS = 30 * 60_000;

/** Projects that get a building (not "for sale" lots): cloned locally or worked on here. */
export function townProjects(db: Db): Row[] {
  return db.prepare(`SELECT p.* FROM projects p WHERE p.root IS NOT NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = p.id)
    ORDER BY COALESCE(p.lot, 1e9), p.id`).all() as Row[];
}

function nameOf(p: Row) { return p.display_name || fallbackName(p.gh_full?.split('/')[1] ?? p.name); }

/** Without Claude: group by GitHub owner, local-only projects together. */
export function fallbackDistricts(projects: Row[]): District[] {
  const by = new Map<string, string[]>();
  for (const p of projects) {
    const k = p.gh_full ? fallbackName(p.gh_full.split('/')[0]) : 'Local';
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(p.id);
  }
  return [...by].map(([name, ids]) => ({ name, ids }));
}

/** Saved groups, cleaned against the current project list. New projects not yet grouped come back as `ungrouped`. */
export function currentDistricts(db: Db, projects = townProjects(db)): { groups: District[]; ungrouped: string[] } {
  const saved = kvGet<Saved | null>(db, KEY, null);
  if (!saved) return { groups: fallbackDistricts(projects), ungrouped: [] };
  const have = new Set(projects.map((p) => p.id));
  const groups = saved.groups.map((g) => ({ name: g.name, ids: g.ids.filter((id) => have.has(id)) })).filter((g) => g.ids.length);
  const placed = new Set(groups.flatMap((g) => g.ids));
  return { groups, ungrouped: projects.map((p) => p.id).filter((id) => !placed.has(id)) };
}

function about(p: Row): string {
  const bits = [p.gh_description];
  if (!bits[0] && p.root) {
    try { const j = JSON.parse(fs.readFileSync(path.join(p.root, 'package.json'), 'utf8')); bits.push(j.description); } catch {}
    for (const f of ['README.md', 'readme.md']) {
      try {
        const line = fs.readFileSync(path.join(p.root, f), 'utf8').split('\n').map((l) => l.replace(/[#>*_`]/g, '').trim()).filter((l) => l.length > 20 && !/^!\[|^</.test(l))[0];
        if (line) { bits.push(line); break; }
      } catch {}
    }
  }
  return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 160);
}

/** Parses the model's JSON reply into groups of indexes. Every project ends up in exactly one group. */
export function parseGrouping(raw: string, n: number): { name: string; items: number[] }[] | null {
  const a = raw.indexOf('['), b = raw.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  let data: any;
  try { data = JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
  if (!Array.isArray(data)) return null;
  const seen = new Set<number>();
  const out: { name: string; items: number[] }[] = [];
  for (const g of data) {
    const name = String(g?.name ?? '').replace(/["'`*]/g, '').trim().slice(0, 28);
    const items: number[] = [];
    for (const i of (Array.isArray(g?.items) ? g.items : []).map(Number)) if (Number.isInteger(i) && i >= 1 && i <= n && !seen.has(i)) { seen.add(i); items.push(i); }
    if (name && items.length) out.push({ name, items });
  }
  if (!out.length) return null;
  const missing = Array.from({ length: n }, (_, i) => i + 1).filter((i) => !seen.has(i));
  if (missing.length) out.push({ name: 'Odds & Ends', items: missing });
  return out;
}

let running = false;
/** Asks the small Claude model to sort projects into neighborhoods. Runs when the set of projects changes. */
export async function groupDistricts(db: Db): Promise<boolean> {
  if (running) return false;
  const projects = townProjects(db);
  if (projects.length < 2) return false;
  const saved = kvGet<Saved | null>(db, KEY, null);
  const ids = projects.map((p) => p.id).sort();
  if (saved && JSON.stringify(saved.ids) === JSON.stringify(ids)) return false;
  // Wait for plain names first, so the model sees "Bond Trading", not "broking-platform".
  if (projects.some((p) => !p.display_name && !p.naming_tried_at)) return false;
  const tried = kvGet<number>(db, 'districts_tried_at', 0);
  if (Date.now() - tried < RETRY_MS) return false;
  running = true;
  kvSet(db, 'districts_tried_at', Date.now());
  try {
    const list = projects.map((p, i) => `${i + 1}. ${nameOf(p)} (${p.gh_full?.split('/')[1] ?? path.basename(p.root ?? p.name)})${about(p) ? ` — ${about(p)}` : ''}`);
    const current = saved?.source === 'ai' ? saved.groups.map((g) => `${g.name}: ${g.ids.map((id) => projects.findIndex((p) => p.id === id) + 1).filter((i) => i > 0).join(', ')}`).join('\n') : '';
    const prompt = [
      'You lay out a little town where each software project is a building. Group the projects into neighborhoods so similar projects sit together.',
      `Make ${Math.min(6, Math.max(2, Math.round(projects.length / 4)))} neighborhoods or close to that. Group by what the project is about for people (money, hiring, learning, personal tools...), not by technology.`,
      'Give each neighborhood a 1-3 word plain-English name in Title Case, like "Money & Investing" or "Learning".',
      'Inside each neighborhood, order the items so the most similar projects are next to each other.',
      current ? `Current neighborhoods (keep them unless they are clearly wrong; place new projects where they fit):\n${current}` : '',
      'Reply with ONLY JSON: [{"name": "...", "items": [1, 4]}, ...]. Use every number exactly once.',
      '',
      'Projects:',
      ...list,
    ].join('\n');
    const raw = await askClaude(prompt);
    const parsed = raw ? parseGrouping(raw, projects.length) : null;
    if (!parsed) {
      if (raw) console.error('[logbook] districts: unusable reply:', raw.slice(0, 160));
      return false;
    }
    const groups = parsed.map((g) => ({ name: g.name, ids: g.items.map((i) => projects[i - 1].id) }));
    kvSet(db, KEY, { groups, ids, at: Date.now(), source: 'ai' } satisfies Saved);
    console.log('[logbook] districts:', groups.map((g) => `${g.name}(${g.ids.length})`).join(' '));
    return true;
  } finally {
    running = false;
  }
}

// ---------- layout ----------
export type Placed = { cells: Map<string, [number, number]>; districts: { name: string; x0: number; z0: number; x1: number; z1: number }[] };

function blockShape(n: number) { const w = Math.ceil(Math.sqrt(n)); return { w, h: Math.ceil(n / w) }; }

function spiralCells(max: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  let x = 0, y = 0, dx = 1, dy = 0, len = 1, step = 0, turned = 0;
  while (out.length < max) {
    x += dx; y += dy; out.push([x, y]); step++;
    if (step === len) { step = 0; [dx, dy] = [-dy, dx]; if (++turned % 2 === 0) len++; }
  }
  return out;
}
const SPIRAL = spiralCells(3000);

/**
 * Packs each neighborhood as a compact block and places blocks around the center with one empty
 * street of park between them, keeping the town as square and tight as it can. Biggest first.
 */
export function layoutTown(groups: District[], extras: District[] = [], gap = 1): Placed {
  const blocks = [...groups].sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name)).concat(extras.filter((g) => g.ids.length));
  const rects: { x0: number; z0: number; x1: number; z1: number }[] = [];
  const cells = new Map<string, [number, number]>();
  const districts: Placed['districts'] = [];
  let bb = { x0: 0, z0: 0, x1: -1, z1: -1 };
  for (const g of blocks) {
    const { w, h } = blockShape(g.ids.length);
    let best: { x: number; z: number; score: number } | null = null;
    for (const [cx, cz] of SPIRAL) {
      const x = cx - Math.floor((w - 1) / 2), z = cz - Math.floor((h - 1) / 2);
      if (rects.some((r) => x <= r.x1 + gap && x + w - 1 >= r.x0 - gap && z <= r.z1 + gap && z + h - 1 >= r.z0 - gap)) continue;
      const n = rects.length ? { x0: Math.min(bb.x0, x), z0: Math.min(bb.z0, z), x1: Math.max(bb.x1, x + w - 1), z1: Math.max(bb.z1, z + h - 1) } : { x0: x, z0: z, x1: x + w - 1, z1: z + h - 1 };
      const W = n.x1 - n.x0 + 1, H = n.z1 - n.z0 + 1;
      const score = W * H + 0.6 * (W - H) ** 2 + 0.01 * (cx * cx + cz * cz);
      if (!best || score < best.score) best = { x, z, score };
      if (!rects.length) break;
    }
    const { x, z } = best!;
    const r = { x0: x, z0: z, x1: x + w - 1, z1: z + h - 1 };
    rects.push(r);
    bb = rects.length === 1 ? { ...r } : { x0: Math.min(bb.x0, r.x0), z0: Math.min(bb.z0, r.z0), x1: Math.max(bb.x1, r.x1), z1: Math.max(bb.z1, r.z1) };
    // Snake through rows so consecutive (most similar) projects always touch.
    g.ids.forEach((id, i) => { const row = Math.floor(i / w), col = row % 2 ? w - 1 - (i % w) : i % w; cells.set(id, [x + col, z + row]); });
    districts.push({ name: g.name, ...r });
  }
  return { cells, districts };
}
