import { useState } from 'react';
import type { SessionView } from '../../daemon/types.ts';
import { STATUS_LABEL } from './format.ts';

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot s-${status}`} aria-hidden="true" />;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function PrChip({ url, state }: { url: string | null; state: string | null }) {
  if (!url) return null;
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return (
    <a className={`prchip pr-${state ?? 'open'}`} href={url} target="_blank" rel="noreferrer">
      PR #{n} {state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open'}
    </a>
  );
}

export function CopyResume({ s }: { s: SessionView }) {
  const [done, setDone] = useState(false);
  const cmd = `${s.cwd ? `cd ${JSON.stringify(s.cwd)} && ` : ''}claude --resume ${s.id}`;
  return (
    <button
      className="ghost small"
      title={cmd}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(cmd).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }).catch(() => {});
      }}
    >
      {done ? 'Copied' : 'Copy resume'}
    </button>
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
