/*
 * Visual replies: an agent's reply, rearranged into blocks you can look at instead of read (an answer card, forks,
 * flow diagrams, tiles, checklists…). Pure rules over the parsed Markdown, no AI: every word shown comes from the reply,
 * and anything no rule recognises stays as formatted text. The chat draws these with real components (never HTML).
 */
import { parseMarkdown, plainText, type Block, type Inline } from './markdown.ts';
import { pickItems } from './turn.ts';

/** A titled item: a bold lead (or the words before a colon) and the rest of the item. */
export type Card = { title: Inline[]; note: Inline[]; more: Block[] };
export type FlowNode = { id: number; label: string; sub: string | null; notes: string[] };

export type VBlock =
  | { v: 'md'; b: Block }
  | { v: 'answer'; word: string | null; c: Inline[] }
  | { v: 'fork'; cases: Card[]; here: number | null }
  | { v: 'flow'; nodes: FlowNode[]; rows: number[][]; edges: [number, number][] }
  | { v: 'tiles'; head: Inline[][]; tiles: { title: Inline[]; sub: Inline[] | null; cells: Inline[][] }[] }
  | { v: 'compare'; options: { name: Inline[]; rows: { k: Inline[]; v: Inline[] }[] }[] }
  | { v: 'cards'; items: Card[] }
  | { v: 'checklist'; items: Card[] }
  | { v: 'steps'; start: number; items: Card[] }
  | { v: 'numbers'; items: { label: string; value: string; note: string }[] }
  | { v: 'change'; files: { path: string; note: Inline[]; more: Block[] }[] };

export type Visual = {
  /** The "Hi, I'm Iggy. You'll see me at …" line Swarmville asks agents to open with: shown small, never as the answer. */
  greeting: string | null;
  blocks: VBlock[];
  /** How many blocks were drawn as visuals (0: the reply reads best as plain text). */
  drawn: number;
};

// "Hi, I'm Tiki Jr. You'll see me at Agent Logbook in Francisco." (the SessionStart hook's own example, and close variants)
const GREETING = /^\s*(?:hi|hey|hello)\b[,!]?\s+(?:there[,!]?\s+)?i['’]m\s+[^\n]{1,40}?[.!]\s+(?:you['’]ll|you will)\s+(?:see|find|spot)\s+me\b[^\n]*?(?:[.!](?=\s|$)|$)\s*/i;

/** Splits the greeting off the start of a reply. */
export function splitGreeting(text: string): { greeting: string | null; rest: string } {
  const m = String(text ?? '').match(GREETING);
  if (!m) return { greeting: null, rest: text };
  return { greeting: m[0].trim(), rest: text.slice(m[0].length) };
}

const pt = (c: Inline[]) => plainText(c).replace(/\s+/g, ' ').trim();
const isText = (x: Inline | undefined): x is { t: 'text'; v: string } => x?.t === 'text';

/** Inline content split at a plain-text offset, only where the offset falls in top-level text. */
function splitAt(c: Inline[], at: number, skip = 0): [Inline[], Inline[]] | null {
  let pos = 0;
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    const len = plainText([x]).length;
    if (at < pos + len || (at === pos + len && i === c.length - 1)) {
      if (!isText(x)) return at === pos ? [c.slice(0, i), c.slice(i)] : null;
      const k = at - pos;
      const head = [...c.slice(0, i), ...(k ? [{ t: 'text' as const, v: x.v.slice(0, k) }] : [])];
      const tailV = x.v.slice(k + skip);
      const tail = [...(tailV ? [{ t: 'text' as const, v: tailV }] : []), ...c.slice(i + 1)];
      return [head, tail];
    }
    pos += len;
  }
  return null;
}

const trimLead = (c: Inline[]): Inline[] => {
  const out = [...c];
  while (isText(out[0]) && !out[0].v.replace(/^\s*[:–—.,-]?\s*/, '')) out.shift();
  if (isText(out[0])) out[0] = { t: 'text', v: out[0].v.replace(/^\s*[:–—.,-]?\s*/, '') };
  return out;
};
const trimEnd = (c: Inline[]): Inline[] => {
  const out = [...c];
  const last = out.at(-1);
  if (isText(last)) { const v = last.v.replace(/[\s:–—,-]+$/, ''); if (v) out[out.length - 1] = { t: 'text', v }; else out.pop(); }
  return out;
};

/** A list item as a card: bold lead → title, else the words before an early colon. `loose` also takes a first clause. */
function cardOf(item: Block[], loose = false): Card | null {
  const first = item[0];
  if (first?.t !== 'p') return null;
  const c = first.c;
  const leadAt = c.findIndex((x) => !(isText(x) && !x.v.trim()));
  const lead = c[leadAt];
  if (lead?.t === 'b' && pt(lead.c).length <= 90) {
    return { title: trimEnd(lead.c), note: trimLead(c.slice(leadAt + 1)), more: item.slice(1) };
  }
  const text = plainText(c);
  const colon = text.search(/:\s/);
  if (colon > 2 && colon <= 60) {
    const s = splitAt(c, colon, 1);
    if (s) return { title: trimEnd(s[0]), note: trimLead(s[1]), more: item.slice(1) };
  }
  if (!loose) return null;
  const clause = text.search(/,\s+(?:so|which|because|since|and)\s|\s[—–]\s|\.\s/);
  if (clause > 8 && clause <= 110) {
    const s = splitAt(c, clause);
    if (s) return { title: trimEnd(s[0]), note: trimLead(s[1]), more: item.slice(1) };
  }
  return { title: c, note: [], more: item.slice(1) };
}

const boldLed = (item: Block[]) => {
  const first = item[0];
  if (first?.t !== 'p') return false;
  const lead = first.c.find((x) => !(isText(x) && !x.v.trim()));
  return lead?.t === 'b';
};

// ── flows: an ASCII diagram in a code block ──────────────────────────────────────────────────────────────────────────
const ARROW = /\s*(?:-{1,3}>|─+\s*[▸▶>►]|─{2,}|=+>|[→⟶➜➔➝▶▸►])\s*/;
const DOWN = /^[\s│|┃↓▼v^┬┴┼╎:]*$/;
const CODEY = /[{};]|^\s*(?:import|export|const|let|var|function|def|class|return|if|for|SELECT|\$)\b/;

export function parseFlow(src: string): { nodes: FlowNode[]; rows: number[][]; edges: [number, number][] } | null {
  const lines = src.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  if (lines.length < 2 || lines.length > 40 || !lines.some((l) => ARROW.test(l))) return null;
  if (lines.some((l) => CODEY.test(l))) return null;
  const nodes: FlowNode[] = [];
  const rows: number[][] = [];
  const edges: [number, number][] = [];
  const add = (raw: string) => {
    const s = raw.trim().replace(/^[-•*]\s+/, '');
    const m = s.match(/^(.+?)\s*\(([^()]{1,60})\)$/);
    const node: FlowNode = { id: nodes.length, label: (m ? m[1] : s).trim(), sub: m ? m[2].trim() : null, notes: [] };
    nodes.push(node);
    return node.id;
  };
  let last: number | null = null;
  for (const line of lines) {
    if (DOWN.test(line)) continue;
    const bullet = line.match(/^\s*[-•*·]\s+(.+)$/);
    if (bullet && last != null && !ARROW.test(bullet[1])) {
      if (nodes[last].notes.length >= 6) return null;
      nodes[last].notes.push(bullet[1].trim());
      continue;
    }
    const parts = line.split(new RegExp(ARROW.source, 'g')).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    if (parts.some((p) => p.length > 70)) return null;
    const row = parts.map(add);
    if (last != null) edges.push([last, row[0]]);
    for (let i = 1; i < row.length; i++) edges.push([row[i - 1], row[i]]);
    rows.push(row);
    last = row.at(-1)!;
  }
  if (nodes.length < 3 || nodes.length > 16 || edges.length < 2) return null;
  if (nodes.some((n) => !n.label || n.label.length > 60)) return null;
  return { nodes, rows, edges };
}

// ── the rules ────────────────────────────────────────────────────────────────────────────────────────────────────────
const ANSWER_WORD = /^(yes|no|yep|nope|not yet|not quite|mostly|partly|done|fixed|shipped|works|it works)\b[.,!:;—–-]*\s*/i;
const CHECK_HEADING = /guardrail|checklist|must[- ]?have|requirement|rules?\b|before you|don['’]t forget|to-?do|safeguard|what to check|watch out|gotchas?|risks?\b|caveats?/i;
const COMPARE_HEAD = /^(?:|aspect|feature|criteria|criterion|dimension|what|factor|category|trait|property|attribute)s?$/i;
const NUM = /^\s*(.{1,40}?)\s*[:–—-]\s*([~≈<>]?\s?[$₹€£]?\d[\d,.]*\s?(?:%|ms|s|sec|secs|k|K|M|B|x|×|MB|GB|KB|kB|hours?|hrs?|mins?|minutes?|days?|weeks?|tokens|lines|files|tests|PRs|users)?)(?=$|[\s,;.(])\s*[,;.]?\s*(.*)$/;
const PATH = /^(?:[\w.@-]+\/)+[\w.@-]+$|^[\w.-]+\.(?:tsx?|jsx?|mjs|css|html|md|json|ya?ml|toml|py|go|rs|sh|sql|swift|kt)(?::\d+)?$/;

function tableBlock(b: Extract<Block, { t: 'table' }>): VBlock | null {
  const cols = b.head.length;
  if (cols < 2 || cols > 4 || b.rows.length < 2 || b.rows.length > 8) return null;
  if (b.rows.some((r) => r.length < cols && r.every((c) => !pt(c)))) return null;
  if (COMPARE_HEAD.test(pt(b.head[0])) && cols >= 3) {
    return { v: 'compare', options: b.head.slice(1).map((name, j) => ({ name, rows: b.rows.map((r) => ({ k: r[0] ?? [], v: r[j + 1] ?? [] })) })) };
  }
  if (b.rows.some((r) => pt(r[0] ?? []).length > 48 || !pt(r[0] ?? []))) return null;
  // mostly numbers (a results table) reads better as a table
  const numeric = b.rows.flatMap((r) => r.slice(1)).filter((c) => /^[\s$₹€£~≈<>+-]*\d[\d,.]*\s*\S{0,4}$/.test(pt(c))).length;
  if (numeric > b.rows.length * (cols - 1) / 2) return null;
  return {
    v: 'tiles', head: b.head.slice(1),
    tiles: b.rows.map((r) => {
      const cells = b.head.slice(1).map((_, j) => r[j + 1] ?? []);
      const lead = cells[0]?.find((x) => !(isText(x) && !x.v.trim()));
      return { title: r[0], sub: lead?.t === 'b' ? lead.c : null, cells };
    }),
  };
}

function listBlock(b: Extract<Block, { t: 'list' }>, ctx: { prev: Block | undefined; next: Block | undefined; heading: string; pickable: boolean }): VBlock | null {
  const n = b.items.length;
  // files changed: every item opens with a `path`
  if (!b.ordered && n >= 2 && b.items.every((it) => {
    const first = it[0];
    if (first?.t !== 'p') return false;
    const lead = first.c.find((x) => !(isText(x) && !x.v.trim()));
    return lead?.t === 'code' && PATH.test(lead.v.trim());
  })) {
    return {
      v: 'change', files: b.items.map((it) => {
        const c = (it[0] as Extract<Block, { t: 'p' }>).c;
        const at = c.findIndex((x) => x.t === 'code');
        return { path: (c[at] as { v: string }).v.trim(), note: trimLead(c.slice(at + 1)), more: it.slice(1) };
      }),
    };
  }
  // numbers: "Label: 42 ms" on every item
  if (n >= 2 && n <= 6 && b.items.every((it) => it.length === 1 && it[0].t === 'p' && NUM.test(pt(it[0].c)))) {
    return { v: 'numbers', items: b.items.map((it) => { const m = pt((it[0] as Extract<Block, { t: 'p' }>).c).match(NUM)!; return { label: m[1].replace(/\*+/g, '').trim(), value: m[2].trim(), note: m[3].trim() }; }) };
  }
  if (b.ordered) {
    if (ctx.pickable || n < 3 || n > 10) return null;
    const items = b.items.map((it) => cardOf(it, false) ?? { title: [], note: (it[0]?.t === 'p' ? it[0].c : []), more: it[0]?.t === 'p' ? it.slice(1) : it });
    return { v: 'steps', start: b.start, items };
  }
  // a fork: "whose money?" followed by two or three cases
  const ask = ctx.prev && (ctx.prev.t === 'h' || ctx.prev.t === 'p') ? pt(ctx.prev.c) : '';
  if (n >= 2 && n <= 3 && b.items.every(boldLed) && (/\?\s*$/.test(ask) || /\bdepends on\b/i.test(ask))) {
    const cases = b.items.map((it) => cardOf(it)!);
    const after = ctx.next?.t === 'p' ? pt(ctx.next.c) : '';
    const which = after.match(/\b(?:assum\w*|going with|focus\w* on|covers?)\b[^.]*\b(first|second|third|former|latter)\b/i)?.[1]?.toLowerCase();
    const here = which ? ({ first: 0, former: 0, second: 1, latter: n - 1, third: 2 } as Record<string, number>)[which] ?? null : null;
    return { v: 'fork', cases, here: here != null && here < n ? here : null };
  }
  if (n >= 2 && n <= 8 && CHECK_HEADING.test(ctx.heading)) {
    const items = b.items.map((it) => cardOf(it, true));
    if (items.every(Boolean)) return { v: 'checklist', items: items as Card[] };
  }
  if (n >= 3 && n <= 8 && b.items.every(boldLed)) return { v: 'cards', items: b.items.map((it) => cardOf(it)!) };
  return null;
}

/**
 * The reply as visual blocks. `long`: open with the answer card. `pickable`: the reply's numbered options are live
 * Pick cards in the chat, so leave them alone.
 */
export function visualize(text: string, opts: { long?: boolean; pickable?: boolean } = {}): Visual {
  const { greeting, rest } = splitGreeting(text);
  const src = parseMarkdown(rest);
  const out: VBlock[] = [];
  let heading = '';
  src.forEach((b, i) => {
    if (b.t === 'h') heading = pt(b.c);
    let v: VBlock | null = null;
    if (i === 0 && opts.long && b.t === 'p' && src.length > 1) {
      const lead = b.c[0];
      const m = isText(lead) ? lead.v.match(ANSWER_WORD) : null;
      if (m && isText(lead)) {
        const word = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        const restC: Inline[] = [...(lead.v.slice(m[0].length) ? [{ t: 'text' as const, v: lead.v.slice(m[0].length) }] : []), ...b.c.slice(1)];
        v = { v: 'answer', word, c: restC };
      } else v = { v: 'answer', word: null, c: b.c };
    } else if (b.t === 'code' && /^(?:|text|txt|plain|plaintext|ascii|diagram)$/i.test(b.lang)) {
      const f = parseFlow(b.v);
      if (f) v = { v: 'flow', ...f };
    } else if (b.t === 'table') v = tableBlock(b);
    else if (b.t === 'list') v = listBlock(b, { prev: src[i - 1], next: src[i + 1], heading, pickable: !!opts.pickable && !!pickItems(b) });
    out.push(v ?? { v: 'md', b });
  });
  const drawn = out.filter((x) => x.v !== 'md' && x.v !== 'answer').length;
  return { greeting, blocks: out, drawn };
}

/** Every word a visual shows (for tests: nothing from the reply goes missing). */
export function visualWords(vis: Visual): string {
  const blk = (b: Block): string => {
    switch (b.t) {
      case 'h': case 'p': return plainText(b.c);
      case 'list': return b.items.map((it) => it.map(blk).join(' ')).join(' ');
      case 'code': return b.v;
      case 'quote': return b.c.map(blk).join(' ');
      case 'hr': return '';
      case 'table': return [...b.head, ...b.rows.flat()].map(plainText).join(' ');
    }
  };
  const card = (c: Card) => [plainText(c.title), plainText(c.note), ...c.more.map(blk)].join(' ');
  const parts = vis.blocks.map((v): string => {
    switch (v.v) {
      case 'md': return blk(v.b);
      case 'answer': return `${v.word ?? ''} ${plainText(v.c)}`;
      case 'fork': case 'cards': case 'checklist': case 'steps': return (v.v === 'fork' ? v.cases : v.items).map(card).join(' ');
      case 'flow': return v.nodes.map((n) => [n.label, n.sub ?? '', ...n.notes].join(' ')).join(' ');
      case 'tiles': return [...v.head, ...v.tiles.flatMap((t) => [t.title, ...t.cells])].map(plainText).join(' ');
      case 'compare': return v.options.map((o) => [o.name, ...o.rows.flatMap((r) => [r.k, r.v])].map(plainText).join(' ')).join(' ');
      case 'numbers': return v.items.map((x) => `${x.label} ${x.value} ${x.note}`).join(' ');
      case 'change': return v.files.map((f) => `${f.path} ${plainText(f.note)} ${f.more.map(blk).join(' ')}`).join(' ');
    }
  });
  return [vis.greeting ?? '', ...parts].join(' ');
}
