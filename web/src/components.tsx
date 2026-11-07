import { useState } from 'react';
import type { SessionView } from '../../daemon/types.ts';
import { STAMP, STATUS, useVoice } from './copy.ts';
import { post } from './useLogbook.ts';

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot s-${status}`} aria-hidden="true" />;
}

export function StatusPill({ status }: { status: SessionView['status'] }) {
  const voice = useVoice();
  return <span className={`pill s-${status}`}>{STATUS[voice][status]}</span>;
}

export function Stamp({ stamp, big }: { stamp: NonNullable<SessionView['stamp']>; big?: boolean }) {
  const voice = useVoice();
  return <span className={`stamp st-${stamp}${big ? ' big' : ''}`}>{STAMP[voice][stamp]}</span>;
}

export function PrChip({ url, state }: { url: string | null; state: string | null }) {
  const voice = useVoice();
  if (!url) return null;
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  const label = voice === 'plain'
    ? (state === 'merged' ? 'Approved & live' : state === 'closed' ? 'Review closed' : 'In review')
    : `PR #${n} ${state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open'}`;
  return <a className={`prchip pr-${state ?? 'open'}`} href={url} target="_blank" rel="noreferrer">{label}</a>;
}

/** "Go to Pip": brings the agent's VS Code terminal forward; falls back to copying a resume command. */
export function GoTo({ s, primary }: { s: SessionView; primary?: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const live = s.status !== 'ended';
  const cmd = `${s.cwd ? `cd ${JSON.stringify(s.cwd)} && ` : ''}claude --resume ${s.id}`;
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (live) {
      const r = await post(`/api/jump/${encodeURIComponent(s.id)}`);
      setMsg(r.via === 'extension' ? null : r.message ?? null);
    } else {
      try { await navigator.clipboard.writeText(cmd); setMsg('Copied. Paste it in a terminal to bring them back.'); } catch { setMsg(cmd); }
    }
    setTimeout(() => setMsg(null), 4000);
  };
  return (
    <span className="goto">
      <button className={primary ? 'btn dark' : 'ghost small'} onClick={click} title={live ? 'Open their terminal in VS Code' : cmd}>
        {live ? <>Go to {s.agent.name}{primary ? <kbd>↵</kbd> : null}</> : `Bring ${s.agent.name} back`}
      </button>
      {msg ? <span className="goto-msg" role="status">{msg}</span> : null}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
