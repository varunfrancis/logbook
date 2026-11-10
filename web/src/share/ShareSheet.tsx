import { useRef, useState } from 'react';
import { toBlob, toPng } from 'html-to-image';
import type { StateView } from '../../../daemon/types.ts';
import { PayrollCard, PLANS, REPO_URL, TeamCard, type Plan, type Privacy } from './Cards.tsx';
import { isoDate, useTeam } from '../useSwarmville.ts';
import { money } from '../copy.ts';

export type ShareKind = 'team' | 'payroll';
const TABS: { key: ShareKind; label: string }[] = [
  { key: 'team', label: 'My team' },
  { key: 'payroll', label: 'Payroll' },
];
// 4:5 portrait: X, LinkedIn and Instagram all show it uncropped in the feed.
const W = 1200, H = 1500;
const DAYS = 30;
const PLAN_KEY = 'swarmville.sharePlan';

/*
 * html-to-image can't read the cross-origin Google Fonts stylesheet, so exports fell back to system fonts.
 * Fetch it ourselves and inline the Latin font files once, then hand that CSS to every export.
 */
let fontCss: Promise<string> | null = null;
function embedFonts(): Promise<string> {
  const href = document.querySelector<HTMLLinkElement>('link[href*="fonts.googleapis.com/css"]')?.href;
  if (!href) return Promise.resolve('');
  fontCss ??= (async () => {
    const css = await (await fetch(href)).text();
    const blocks = css.split(/(?=\/\* )/).filter((b) => b.startsWith('/* latin */'));
    const inline = await Promise.all(blocks.map(async (b) => {
      const url = b.match(/url\((https:[^)]+)\)/)?.[1];
      if (!url) return b;
      const blob = await (await fetch(url)).blob();
      const data = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob); });
      return b.replace(url, data);
    }));
    return inline.join('\n');
  })().catch(() => { fontCss = null; return ''; });
  return fontCss;
}

function savedPlan(): Plan {
  try { const v = localStorage.getItem(PLAN_KEY); if (PLANS.some((p) => p.key === v)) return v as Plan; } catch {}
  return 'max20';
}

export function ShareSheet({ state, onClose, initial = 'team' }: { state: StateView; onClose: () => void; initial?: ShareKind }) {
  const [kind, setKind] = useState<ShareKind>(initial);
  const [privacy, setPrivacy] = useState<Privacy>({ names: true });
  const [plan, setPlanState] = useState<Plan>(savedPlan);
  const setPlan = (p: Plan) => { setPlanState(p); try { localStorage.setItem(PLAN_KEY, p); } catch {} };
  const [msg, setMsg] = useState<string | null>(null);
  const team = useTeam(DAYS);
  const ref = useRef<HTMLDivElement>(null);
  const scale = Math.min(1, 560 / W, 520 / H);

  const render = async () => {
    if (!ref.current) throw new Error('Nothing to save');
    return toPng(ref.current, { pixelRatio: 2, cacheBust: true, fontEmbedCSS: await embedFonts() });
  };
  const save = async () => {
    try {
      const url = await render();
      const a = document.createElement('a'); a.href = url; a.download = `swarmville-${kind}-${isoDate()}.png`; a.click();
      setMsg('Saved to your Downloads.');
      return true;
    } catch (e: any) { setMsg(`Couldn't make the image: ${e?.message ?? e}`); return false; }
  };
  const copy = async () => {
    try {
      const blob = ref.current ? await toBlob(ref.current, { pixelRatio: 2, fontEmbedCSS: await embedFonts() }) : null;
      if (!blob) throw new Error('empty image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMsg('Copied. Paste it into your post.');
    } catch { setMsg('Your browser blocked copying images. Use Save image instead.'); }
  };

  const n = team?.members.length ?? 0;
  const paid = PLANS.find((p) => p.key === plan)?.usd ?? null;
  const multiple = team && paid ? team.totals.costUsd / paid : null;
  const text = kind === 'team'
    ? `1 human. ${n} AI employee${n === 1 ? '' : 's'}.\n\nThis is my whole team. Last ${DAYS} days: ${team?.totals.delivered ?? 0} things shipped.`
    : multiple && multiple >= 1.5
      ? `Ran payroll for my AI team: ${money(team!.totals.costUsd)} of work this month. I paid ${money(paid!)}.\n\n${multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}× 📈`
      : `Ran payroll for my AI team: ${n} employees, ${money(team?.totals.costUsd ?? 0)} this month.`;
  const post = async () => {
    if (!(await save())) return;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(`${text}\n\nGet your own town: ${REPO_URL}`)}`, '_blank');
    setMsg('Image saved. Attach it to the post that just opened.');
  };

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={onClose}>
      <div className="modal share" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h2 id="share-title">Show off your crew</h2><button className="ghost close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="tabs-row" role="tablist">
          {TABS.map((t) => <button key={t.key} role="tab" aria-selected={kind === t.key} className={kind === t.key ? 'on' : ''} onClick={() => { setKind(t.key); setMsg(null); }}>{t.label}</button>)}
        </div>
        <div className="preview" style={{ height: H * scale + 2 }}>
          <div style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'top left', marginLeft: `max(0px, calc((100% - ${W * scale}px) / 2))` }}>
            <div ref={ref} style={{ width: W, height: H }}>
              {!team ? <div className="card loading-card">Getting it ready…</div>
                : kind === 'team' ? <TeamCard state={state} team={team} privacy={privacy} />
                : <PayrollCard state={state} team={team} plan={plan} />}
            </div>
          </div>
        </div>
        {kind === 'payroll' ? (
          <fieldset className="privacy">
            <legend>Your plan</legend>
            <div className="tabs-row">{PLANS.map((p) => <button key={p.key} aria-pressed={plan === p.key} className={plan === p.key ? 'on' : ''} onClick={() => setPlan(p.key)}>{p.label}</button>)}</div>
            <p className="muted">Pay is what each agent's tokens would cost at Anthropic's API prices.</p>
          </fieldset>
        ) : (
          <fieldset className="privacy">
            <legend>Privacy</legend>
            <label><input type="checkbox" checked={privacy.names} onChange={(e) => setPrivacy({ names: e.target.checked })} /> Show project names (e.g. "Support Bot"). Off shows Project A, B, C…. Your own name stays on the card.</label>
            <p className="muted">Repo names, branches, files and prompts are never included.</p>
          </fieldset>
        )}
        <div className="row end">
          {msg ? <span className="muted" role="status">{msg}</span> : null}
          <button className="ghost" onClick={save} disabled={!team}>Save image</button>
          <button className="ghost" onClick={copy} disabled={!team}>Copy image</button>
          <button className="btn dark" onClick={post} disabled={!team}>Post to X</button>
        </div>
      </div>
    </div>
  );
}
