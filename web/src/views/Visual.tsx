import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Card, FlowNode, VBlock } from '../../../daemon/visual.ts';
import { plainText, type Inline } from '../../../daemon/markdown.ts';
import { BlockView, Inlines } from './Markdown.tsx';

/** One block of a visual reply. Every word comes from the reply; only the arrangement is new. */
export function VisualBlock({ b }: { b: VBlock }): ReactNode {
  switch (b.v) {
    case 'md': return <BlockView b={b.b} />;
    case 'answer': return <Answer word={b.word} c={b.c} />;
    case 'fork': return <Fork cases={b.cases} here={b.here} />;
    case 'flow': return <Flow nodes={b.nodes} rows={b.rows} edges={b.edges} />;
    case 'tiles': return <Tiles b={b} />;
    case 'compare': return <Compare b={b} />;
    case 'cards': return <div className="vz-cards">{b.items.map((c, i) => <div key={i} className="vz-card"><CardBody c={c} /></div>)}</div>;
    case 'checklist': return <Checklist items={b.items} />;
    case 'steps': return <Steps start={b.start} items={b.items} />;
    case 'numbers': return (
      <div className="vz-nums">{b.items.map((x, i) => (
        <div key={i} className="vz-num"><b>{x.value}</b><span>{x.label}</span>{x.note ? <small>{x.note}</small> : null}</div>
      ))}</div>
    );
    case 'change': return (
      <ul className="vz-change">{b.files.map((f, i) => (
        <li key={i}>
          <FileIcon />
          <div className="vz-change-body"><code>{f.path}</code>{plainText(f.note).trim() ? <span><Inlines c={f.note} /></span> : null}{f.more.map((x, j) => <BlockView key={j} b={x} />)}</div>
        </li>
      ))}</ul>
    );
  }
}

function CardBody({ c }: { c: Card }) {
  const hasNote = !!plainText(c.note).trim();
  return (
    <>
      {c.title.length ? <b className="vz-card-title"><Inlines c={c.title} /></b> : null}
      {hasNote ? <span className="vz-card-note"><Inlines c={c.note} /></span> : null}
      {c.more.map((x, j) => <BlockView key={j} b={x} />)}
    </>
  );
}

function Answer({ word, c }: { word: string | null; c: Inline[] }) {
  const tone = word && /^(no|nope|not)/i.test(word) ? 'no' : word && /^(yes|yep|done|fixed|shipped|works|it works)/i.test(word) ? 'yes' : 'meh';
  return (
    <div className="vz-answer">
      {word ? <span className={`vz-answer-word ${tone}`}>{word}</span> : <span className="vz-answer-label">In short</span>}
      {plainText(c).trim() ? <p><Inlines c={c} /></p> : null}
    </div>
  );
}

function Fork({ cases, here }: { cases: Card[]; here: number | null }) {
  return (
    <div className="vz-fork">{cases.map((c, i) => (
      <div key={i} className={`vz-case${here === i ? ' here' : ''}${here != null && here !== i ? ' other' : ''}`}>
        <span className="vz-case-n" aria-hidden>{String.fromCharCode(65 + i)}</span>
        <CardBody c={c} />
        {here === i ? <span className="vz-case-here">The rest of this reply is about this case</span> : null}
      </div>
    ))}</div>
  );
}

function Tiles({ b }: { b: Extract<VBlock, { v: 'tiles' }> }) {
  const [open, setOpen] = useState(0);
  const t = b.tiles[open];
  return (
    <div className="vz-tiles-wrap">
      <div className="vz-tiles" role="tablist">
        {b.tiles.map((x, i) => (
          <button key={i} type="button" role="tab" aria-selected={open === i} className="vz-tile" onClick={() => setOpen(i)}>
            <b><Inlines c={x.title} /></b>
            {x.sub ? <span><Inlines c={x.sub} /></span> : x.cells[0] && plainText(x.cells[0]).trim() ? <span>{plainText(x.cells[0])}</span> : null}
          </button>
        ))}
      </div>
      {t ? (
        <div className="vz-tile-detail" role="tabpanel">
          {t.cells.map((c, j) => plainText(c).trim() ? (
            <div key={j} className="vz-tile-cell">
              {b.head.length > 1 && plainText(b.head[j] ?? []).trim() ? <span className="vz-label"><Inlines c={b.head[j]} /></span> : null}
              <p><Inlines c={c} /></p>
            </div>
          ) : null)}
        </div>
      ) : null}
    </div>
  );
}

function Compare({ b }: { b: Extract<VBlock, { v: 'compare' }> }) {
  return (
    <div className="vz-compare">{b.options.map((o, i) => (
      <div key={i} className="vz-option">
        <b className="vz-option-name"><Inlines c={o.name} /></b>
        <dl>{o.rows.map((r, j) => (
          <Fragment key={j}><dt><Inlines c={r.k} /></dt><dd><Inlines c={r.v} /></dd></Fragment>
        ))}</dl>
      </div>
    ))}</div>
  );
}

function Checklist({ items }: { items: Card[] }) {
  const [ref, seen] = useInView<HTMLUListElement>();
  return (
    <ul ref={ref} className={`vz-check${seen ? ' seen' : ''}`}>{items.map((c, i) => (
      <li key={i} style={{ ['--i' as string]: i }}>
        <span className="vz-tick" aria-hidden><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg></span>
        <div className="vz-check-body"><CardBody c={c} /></div>
      </li>
    ))}</ul>
  );
}

function Steps({ start, items }: { start: number; items: Card[] }) {
  return (
    <ol className="vz-steps">{items.map((c, i) => (
      <li key={i}>
        <span className="vz-step-n" aria-hidden>{start + i}</span>
        <div className="vz-step-body"><CardBody c={c} /></div>
      </li>
    ))}</ol>
  );
}

// ── flow: boxes sized by their words, a dot that travels only along the arrows, a box that lights up on arrival ──
function Flow({ nodes, rows, edges }: { nodes: FlowNode[]; rows: number[][]; edges: [number, number][] }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const reduce = useReducedMotion();
  // the tour: travel an edge, then light the box it reaches
  const tour = useMemo(() => [{ node: edges[0][0] } as { edge?: number; node?: number }, ...edges.flatMap((e, i) => [{ edge: i }, { node: e[1] }])], [edges]);
  const [step, setStep] = useState(0);
  const playing = seen && !reduce;
  useEffect(() => {
    if (!playing) return;
    const s = tour[step % tour.length];
    const t = setTimeout(() => setStep((x) => (x + 1) % (tour.length + 2)), s?.edge != null ? 850 : step >= tour.length ? 700 : 650);
    return () => clearTimeout(t);
  }, [playing, step, tour]);
  const cur = playing ? tour[step] : undefined;
  const edgeKey = (a: number, b: number) => edges.findIndex((e) => e[0] === a && e[1] === b);
  return (
    <div ref={ref} className="vz-flow" role="img" aria-label={`Diagram: ${edges.map(([a, b]) => `${nodes[a].label} to ${nodes[b].label}`).join(', ')}`}>
      {rows.map((row, ri) => {
        const down = ri > 0 ? edgeKey(rows[ri - 1].at(-1)!, row[0]) : -1;
        return (
          <Fragment key={ri}>
            {ri > 0 ? <span className={`vz-down${cur?.edge === down ? ' go' : ''}`} key={`d${ri}-${cur?.edge === down ? step : ''}`}><i /></span> : null}
            <div className="vz-row">
              {row.map((id, k) => {
                const e = k > 0 ? edgeKey(row[k - 1], id) : -1;
                const n = nodes[id];
                return (
                  <Fragment key={id}>
                    {k > 0 ? <span className={`vz-arrow${cur?.edge === e ? ' go' : ''}`} key={`a${id}-${cur?.edge === e ? step : ''}`}><i /></span> : null}
                    <div className={`vz-node${cur?.node === id ? ' lit' : ''}${n.notes.length ? ' big' : ''}`}>
                      <b>{n.label}</b>
                      {n.sub ? <small>{n.sub}</small> : null}
                      {n.notes.length ? <ul>{n.notes.map((x, j) => <li key={j}>{x}</li>)}</ul> : null}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function FileIcon() {
  return <svg className="vz-file" viewBox="0 0 16 16" aria-hidden><path d="M4 1.5h5l3.5 3.5v9.5h-8.5z M9 1.5v3.5h3.5" /></svg>;
}

/** True once the element has been on screen (animations wait for you to scroll to them). */
function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver((es) => setSeen(es.some((e) => e.isIntersecting)), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen];
}

function useReducedMotion() {
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const m = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return r;
}
