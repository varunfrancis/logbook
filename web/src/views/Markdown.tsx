import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseMarkdown, plainText, type Block, type Inline } from '../markdown.ts';
import { pickItems } from '../turn.ts';

type Opts = { onPick?: (n: number, label: string) => void; picked?: number | null };

/**
 * An agent's reply, formatted: headings, lists, code and links as real elements (built from data, never raw HTML).
 * `long`: a long reply opens with its first paragraph as "In short", and gets a jump list when it has several sections.
 * `onPick`: numbered lists of options (each item starts in bold) become cards with a Pick button.
 */
export function Markdown({ text, className, long, onPick, picked }: { text: string; className?: string; long?: boolean } & Opts) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const root = useRef<HTMLDivElement>(null);
  const isLong = !!long && text.length >= 600;
  const lead = isLong && blocks[0]?.t === 'p' && blocks.length > 1 ? blocks[0] : null;
  const heads = blocks.map((b, i) => (b.t === 'h' ? { i, text: plainText(b.c) } : null)).filter((x): x is { i: number; text: string } => !!x);
  const jump = isLong && text.length >= 1500 && heads.length >= 3 ? heads : [];
  const go = (i: number) => root.current?.querySelector(`[data-block="${i}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return (
    <div ref={root} className={`md${className ? ` ${className}` : ''}`}>
      {jump.length ? <nav className="md-jump" aria-label="Jump to a section">{jump.map((h) => <button key={h.i} type="button" onClick={() => go(h.i)}>{h.text}</button>)}</nav> : null}
      {blocks.map((b, i) => (
        b === lead
          ? <div key={i} className="md-lead"><b>In short</b><p><Inlines c={(b as Extract<Block, { t: 'p' }>).c} /></p></div>
          : <BlockView key={i} b={b} idx={i} top opts={{ onPick, picked }} />
      ))}
    </div>
  );
}

export function BlockView({ b, idx, top, opts = {} }: { b: Block; idx?: number; top?: boolean; opts?: Opts }): ReactNode {
  switch (b.t) {
    case 'h': {
      const H = (`h${Math.min(6, b.level + 2)}`) as 'h3'; // h1 → h3: replies sit inside a drawer that already has headings
      return <H className={`md-h md-h${b.level}`} data-block={idx}><Inlines c={b.c} /></H>;
    }
    case 'p': return <p><Inlines c={b.c} /></p>;
    case 'list': {
      const picks = top && opts.onPick ? pickItems(b) : null;
      if (picks) return <PickList b={b} labels={picks} onPick={opts.onPick!} picked={opts.picked ?? null} />;
      return <ListView b={b} />;
    }
    case 'code': return <pre className="md-code"><code>{b.v}</code></pre>;
    case 'quote': return <blockquote>{b.c.map((x, i) => <BlockView key={i} b={x} />)}</blockquote>;
    case 'hr': return <hr />;
    case 'table': return (
      <div className="md-table"><table>
        <thead><tr>{b.head.map((c, i) => <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}><Inlines c={c} /></th>)}</tr></thead>
        <tbody>{b.rows.map((r, i) => <tr key={i}>{b.head.map((_, j) => <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}><Inlines c={r[j] ?? []} /></td>)}</tr>)}</tbody>
      </table></div>
    );
  }
}

const itemBody = (it: Block[]) => (it.length === 1 && it[0].t === 'p' ? <Inlines c={it[0].c} /> : it.map((x, j) => <BlockView key={j} b={x} />));

/** Long lists show their first few items and fold the rest. */
function ListView({ b }: { b: Extract<Block, { t: 'list' }> }) {
  const [open, setOpen] = useState(false);
  const fold = b.items.length > 5 && !open;
  const items = (fold ? b.items.slice(0, 4) : b.items).map((it, i) => <li key={i}>{itemBody(it)}</li>);
  const list = b.ordered ? <ol start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul>{items}</ul>;
  if (b.items.length <= 5) return list;
  return <div className="md-fold">{list}<button type="button" className="md-more" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show ${b.items.length - 4} more`}</button></div>;
}

/** Options you can pick: the bold title, the rest of the item as a note, and a Pick button. */
function PickList({ b, labels, onPick, picked }: { b: Extract<Block, { t: 'list' }>; labels: string[]; onPick: (n: number, label: string) => void; picked: number | null }) {
  return (
    <ol className="md-picks" start={b.start === 1 ? undefined : b.start}>
      {b.items.map((it, i) => {
        const n = b.start + i;
        const first = it[0] as Extract<Block, { t: 'p' }>;
        const boldAt = first.c.findIndex((x) => x.t === 'b');
        const rest = first.c.slice(boldAt + 1);
        // drop the separator after the title ("**Title**: note", "**Title** — note")
        if (rest[0]?.t === 'text') rest[0] = { t: 'text', v: rest[0].v.replace(/^\s*[:–—.-]?\s*/, '') };
        return (
          <li key={i} className={`md-pick${picked === n ? ' picked' : ''}`}>
            <span className="md-pick-n" aria-hidden>{n}</span>
            <div className="md-pick-body">
              <b>{labels[i]}</b>
              {rest.length && plainText(rest).trim() ? <span className="md-pick-note"><Inlines c={rest} /></span> : null}
              {it.slice(1).map((x, j) => <BlockView key={j} b={x} />)}
            </div>
            <button type="button" className="md-pick-btn" onClick={() => onPick(n, labels[i])} aria-label={`Pick option ${n}: ${labels[i]}`}>{picked === n ? 'Picked' : 'Pick'}</button>
          </li>
        );
      })}
    </ol>
  );
}

export function Inlines({ c }: { c: Inline[] }) {
  return <>{c.map((x, i) => {
    switch (x.t) {
      case 'text': return <Fragment key={i}>{x.v}</Fragment>;
      case 'b': return <strong key={i}><Inlines c={x.c} /></strong>;
      case 'i': return <em key={i}><Inlines c={x.c} /></em>;
      case 's': return <s key={i}><Inlines c={x.c} /></s>;
      case 'code': return <code key={i}>{x.v}</code>;
      case 'a': return <a key={i} href={x.href} target="_blank" rel="noreferrer">{<Inlines c={x.c} />}</a>;
      case 'br': return <br key={i} />;
    }
  })}</>;
}
