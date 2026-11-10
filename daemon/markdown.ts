/*
 * The Markdown agents write, parsed into plain data the chat turns into React elements (never raw HTML, so a reply can't
 * inject anything). Covers what Claude actually uses: headings, paragraphs, bold/italic, inline code, code blocks, links,
 * bullet and numbered lists (nested), quotes, rules and tables.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 's'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: ('left' | 'center' | 'right' | null)[] };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isTableStart = (lines: string[], i: number) => lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]);
const startsBlock = (lines: string[], i: number) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || ITEM.test(l) || QUOTE.test(l) || isTableStart(lines, i);
};
const indentOf = (s: string) => s.match(/^\s*/)![0].replace(/\t/g, '    ').length;

export function parseMarkdown(text: string): Block[] {
  return blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    const h = line.match(HEADING);
    if (h) { out.push({ t: 'h', level: h[1].length, c: inline(h[2]) }); i++; continue; }
    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }

    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]).map(inline));
      out.push({ t: 'table', head: head.map(inline), rows, align });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)![1]);
      out.push({ t: 'quote', c: blocks(body) });
      continue;
    }

    const item = line.match(ITEM);
    if (item) {
      const base = indentOf(item[1]);
      const ordered = /\d/.test(item[2]);
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(ITEM);
        if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
        const body = [m[3]];
        const inner = indentOf(m[1]) + m[2].length + 1;
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // a blank line ends the item unless the next line is indented under it
            const next = lines[i + 1];
            if (next !== undefined && next.trim() && indentOf(next) > base) { body.push(''); i++; continue; }
            break;
          }
          if (indentOf(l) > base) { body.push(l.slice(Math.min(inner, indentOf(l)))); i++; continue; }
          if (startsBlock(lines, i)) break;
          body.push(l.trim()); i++; // a lazy continuation of the item's text
        }
        items.push(blocks(body));
        // blank lines between items of the same list keep it one list
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const n = lines[j]?.match(ITEM);
        if (j > i && n && indentOf(n[1]) === base && /\d/.test(n[2]) === ordered) i = j;
      }
      out.push({ t: 'list', ordered, start: ordered ? parseInt(item[2], 10) || 1 : 1, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++].trim());
    out.push({ t: 'p', c: inline(para.join('\n')) });
  }
  return out;
}

// earliest of: `code`, **bold**, __bold__, ~~strike~~, *italic*, _italic_, [text](url), a bare link, a line break
const TOKEN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)|(?<![\w])_(?=\S)([\s\S]*?\S)_(?![\w])|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`*_\]])|(\n)/;

const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href) ? href : null);

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  const push = (v: string) => { if (!v) return; const last = out.at(-1); if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v }); };
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) { push(rest); break; }
    push(rest.slice(0, m.index));
    if (m[1]) out.push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') });
    else if (m[3] !== undefined) out.push({ t: 'b', c: inline(m[3]) });
    else if (m[4] !== undefined) out.push({ t: 'b', c: inline(m[4]) });
    else if (m[5] !== undefined) out.push({ t: 's', c: inline(m[5]) });
    else if (m[6] !== undefined) out.push({ t: 'i', c: inline(m[6]) });
    else if (m[7] !== undefined) out.push({ t: 'i', c: inline(m[7]) });
    else if (m[8] !== undefined) { const href = safeHref(m[9]); if (href) out.push({ t: 'a', href, c: inline(m[8]) }); else push(m[8]); }
    else if (m[10] !== undefined) out.push({ t: 'a', href: m[10], c: [{ t: 'text', v: m[10] }] });
    else if (m[11]) out.push({ t: 'br' });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** The plain words of some inline content (for summaries and titles). */
export function plainText(c: Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : x.t === 'br' ? ' ' : 'c' in x ? plainText(x.c) : '')).join('');
}
