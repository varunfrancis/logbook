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

/** First meaningful line of an agent's final message, with markdown stripped. */
export function firstLine(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !/^(```|---|\|)/.test(l)) ?? '';
  const clean = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_#>]+/g, '').replace(/^[-\d.\s]+/, '').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

export const tildify = (p: string | null | undefined) => (p ?? '').replace(/^\/Users\/[^/]+/, '~');

export const STATUS_LABEL: Record<string, string> = {
  running: 'Working', needs_input: 'Needs you', idle: 'Idle', ended: 'Closed',
};
export const PROJECT_LABEL: Record<string, string> = {
  build: 'Building', needs: 'Needs you', done: 'Complete', quiet: 'Quiet', lot: 'GitHub only',
};
