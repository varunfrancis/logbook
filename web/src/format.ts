export function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}

export function duration(from: number | null | undefined, to: number | null | undefined = Date.now()): string {
  if (!from || !to) return '';
  const m = Math.max(0, Math.round((to - from) / 60000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Time since `from`, down to the second: "31s", "31m", "1h 12m", "2d 3h". */
export function elapsed(from: number | null | undefined, now = Date.now()): string {
  if (!from) return '';
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** First meaningful line of an agent's final message, with markdown stripped. */
export function firstLine(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !/^(```|---|\|)/.test(l)) ?? '';
  const clean = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_#>]+/g, '').replace(/^[-\d.\s]+/, '').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/** When a sleeping scheduled job is next expected, in a couple of words. */
export function nextRunText(at: number | null, now = Date.now()): string | null {
  if (!at) return null;
  const ms = at - now;
  if (ms < 10 * 60_000) return 'any minute';
  if (ms < 90 * 60_000) return `in ${Math.round(ms / 60_000)} min`;
  if (ms < 36 * 3600_000) return `in ${Math.round(ms / 3600_000)} h`;
  return `in ${Math.round(ms / 86_400_000)} days`;
}

/** A typical gap between scheduled runs, roughly: "every ~2 days". */
export function every(ms: number | null | undefined): string {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  if (m < 90) return `every ~${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return h === 24 ? 'about daily' : `every ~${h} h`;
  const d = Math.round(h / 24);
  return d === 7 ? 'about weekly' : `every ~${d} days`;
}

export const tildify = (p: string | null | undefined) => (p ?? '').replace(/^\/Users\/[^/]+/, '~');

export const STATUS_LABEL: Record<string, string> = {
  running: 'Working', needs_input: 'Needs you', idle: 'Idle', ended: 'Closed',
};
export const PROJECT_LABEL: Record<string, string> = {
  site: 'Crew on site', needs: 'Raised a hand', construction: 'Under construction', recent: 'Just completed', done: 'Complete', lot: 'For sale',
};

const plain = (s: string) => s
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[`*_>]+/g, '')
  .replace(/^\s*#+\s*/, '').replace(/^\s*([-•]|\d+\.)\s+/, '').replace(/\s+/g, ' ').replace(/\s+([.,:;])/g, '$1').trim();

/**
 * What an agent did, in a sentence or two, from its final reply: the `result:` line when it wrote one,
 * otherwise its opening paragraph. Empty when the reply has nothing readable.
 */
export function didSummary(text: string | null | undefined, max = 240): string {
  if (!text) return '';
  const result = text.match(/^\s*\**result:?\**:?\s*(.+)$/im);
  let out = result ? plain(result[1]) : '';
  if (!out) {
    const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(```|---|\|)/.test(p)) ?? '';
    out = plain(para.split('\n').filter((l) => !/^\s*\|/.test(l)).join(' '));
  }
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.slice(0, max - 1).trimEnd() + '…';
}

export type MadeLink = { url: string; label: string };

/** A short name for a link an agent left behind: "ST-7785", "PR #441", "Slack message". */
export function linkLabel(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const h = u.hostname.replace(/^www\./, ''), p = u.pathname;
  let m: RegExpMatchArray | null;
  if (h === 'linear.app' && (m = p.match(/\/issue\/([A-Z][A-Z0-9]*-\d+)/i))) return m[1].toUpperCase();
  if (h === 'github.com' && (m = p.match(/\/(pull|issues)\/(\d+)/))) return `${m[1] === 'pull' ? 'PR' : 'Issue'} #${m[2]}`;
  if (h === 'github.com' && (m = p.match(/\/commit\/([0-9a-f]{7})/))) return `Commit ${m[1]}`;
  if (h.endsWith('slack.com')) return 'Slack message';
  if (h === 'claude.ai' && /\/artifact\//.test(p)) return 'Page';
  if (h === 'docs.google.com') return /\/spreadsheets\//.test(p) ? 'Sheet' : /\/presentation\//.test(p) ? 'Slides' : 'Doc';
  if (h.endsWith('notion.so') || h.endsWith('notion.site')) return 'Notion page';
  if (h.endsWith('vercel.app')) return h;
  if (h === 'localhost' || h === '127.0.0.1') return `${h}:${u.port || '80'}`;
  return h;
}

/** The links in an agent's final reply (tickets, reviews, messages, docs), labelled, newest mention order kept, no repeats. */
export function madeLinks(text: string | null | undefined, max = 4): MadeLink[] {
  if (!text) return [];
  const out: MadeLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const label = linkLabel(url);
    if (seen.has(url) || seen.has(label)) continue;
    seen.add(url); seen.add(label);
    out.push({ url, label });
    if (out.length >= max) break;
  }
  return out;
}
