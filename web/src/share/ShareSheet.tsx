import { useRef, useState } from 'react';
import { toBlob, toPng } from 'html-to-image';
import type { StateView } from '../../../daemon/types.ts';
import { GraveyardCard, ReceiptCard, WrappedCards, type Privacy } from './Cards.tsx';
import { isoDate, useDay, useWrapped } from '../useLogbook.ts';

export type ShareKind = 'receipt' | 'graveyard' | 'wrapped';
const TABS: { key: ShareKind; label: string }[] = [
  { key: 'receipt', label: 'Receipt' },
  { key: 'graveyard', label: 'Graveyard' },
  { key: 'wrapped', label: 'Wrapped' },
];
const SIZE: Record<ShareKind, [number, number]> = { graveyard: [1200, 675], receipt: [520, 1180], wrapped: [1330, 940] };

export function ShareSheet({ state, onClose, initial = 'receipt', extra }: { state: StateView; onClose: () => void; initial?: ShareKind; extra?: React.ReactNode }) {
  const [kind, setKind] = useState<ShareKind>(initial);
  const [privacy, setPrivacy] = useState<Privacy>({ names: true, costs: true });
  const [msg, setMsg] = useState<string | null>(null);
  const day = useDay(isoDate(), state.generatedAt);
  const month = isoDate().slice(0, 7);
  const w = useWrapped(kind === 'wrapped' ? month : null);
  const ref = useRef<HTMLDivElement>(null);
  const [W, H] = SIZE[kind];
  const scale = Math.min(1, 560 / W, 460 / H);

  const render = () => (ref.current ? toPng(ref.current, { pixelRatio: 2, cacheBust: true }) : Promise.reject(new Error('Nothing to save')));
  const save = async () => {
    try {
      const url = await render();
      const a = document.createElement('a'); a.href = url; a.download = `swarmville-${kind}-${isoDate()}.png`; a.click();
      setMsg('Saved to your Downloads.');
    } catch (e: any) { setMsg(`Couldn't make the image: ${e?.message ?? e}`); }
  };
  const copy = async () => {
    try {
      const blob = ref.current ? await toBlob(ref.current, { pixelRatio: 2 }) : null;
      if (!blob) throw new Error('empty image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMsg('Copied. Paste it into your post.');
    } catch { setMsg('Your browser blocked copying images. Use Save image instead.'); }
  };
  const text = kind === 'receipt' ? `Today's receipt from ${state.town.name}, where my AI agents build things.`
    : kind === 'graveyard' ? `My agent graveyard. They tried their best.`
    : `My ${state.town.name} Wrapped.`;
  const post = async () => { await save(); window.open(`https://x.com/intent/post?text=${encodeURIComponent(text + ' (made with Swarmville)')}`, '_blank'); setMsg('Image saved. Attach it to the post that just opened.'); };

  const ready = kind === 'wrapped' ? !!w : !!day;
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={onClose}>
      <div className="modal share" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h2 id="share-title">Share your day</h2><button className="ghost close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="tabs-row" role="tablist">
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={kind === t.key} className={kind === t.key ? 'on' : ''} onClick={() => { setKind(t.key); setMsg(null); }}>{t.label}</button>)}
          {extra}
        </div>
        <div className="preview" style={{ height: H * scale + 2 }}>
          <div style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'top left', marginLeft: `max(0px, calc((100% - ${W * scale}px) / 2))` }}>
            <div ref={ref} style={{ width: W, height: H }}>
              {!ready ? <div className="card loading-card">Getting it ready…</div>
                : kind === 'receipt' ? <ReceiptCard state={state} day={day!} privacy={privacy} />
                : kind === 'graveyard' ? <GraveyardCard state={state} graves={state.graveyard} privacy={privacy} />
                : <WrappedCards state={state} w={w!} />}
            </div>
          </div>
        </div>
        <fieldset className="privacy">
          <legend>Privacy</legend>
          <label><input type="checkbox" checked={privacy.names} onChange={(e) => setPrivacy({ ...privacy, names: e.target.checked })} /> Show project names (e.g. "Support Bot"). Off shows Project A, B, C…</label>
          <label><input type="checkbox" checked={privacy.costs} onChange={(e) => setPrivacy({ ...privacy, costs: e.target.checked })} /> Show costs</label>
          <p className="muted">Repo names, branches, files and prompts are never included.</p>
        </fieldset>
        <div className="row end">
          {msg ? <span className="muted" role="status">{msg}</span> : null}
          <button className="ghost" onClick={save} disabled={!ready}>Save image</button>
          <button className="ghost" onClick={copy} disabled={!ready}>Copy image</button>
          <button className="btn dark" onClick={post} disabled={!ready}>Post to X</button>
        </div>
      </div>
    </div>
  );
}
