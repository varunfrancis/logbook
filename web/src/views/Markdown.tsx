import { Fragment, useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../markdown.ts';

/** An agent's reply, formatted: headings, lists, code and links as real elements (built from data, never raw HTML). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md${className ? ` ${className}` : ''}`}>{blocks.map((b, i) => <BlockView key={i} b={b} />)}</div>;
}

export function BlockView({ b }: { b: Block }): ReactNode {
  switch (b.t) {
    case 'h': {
      const H = (`h${Math.min(6, b.level + 2)}`) as 'h3'; // h1 → h3: replies sit inside a drawer that already has headings
      return <H className={`md-h md-h${b.level}`}><Inlines c={b.c} /></H>;
    }
    case 'p': return <p><Inlines c={b.c} /></p>;
    case 'list': {
      const items = b.items.map((it, i) => <li key={i}>{it.length === 1 && it[0].t === 'p' ? <Inlines c={it[0].c} /> : it.map((x, j) => <BlockView key={j} b={x} />)}</li>);
      return b.ordered ? <ol start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul>{items}</ul>;
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
