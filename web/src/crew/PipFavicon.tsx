import { useEffect, useRef } from 'react';
import { AgentAvatar, FOREMAN, type Mood } from './Avatar.tsx';

type Sess = { status: string; stuck?: unknown; stamp?: string | null; endedAt?: number | null };

/** How long a ship keeps Pip celebrating in the tab. */
const SHIPPED_FOR_MS = 5 * 60_000;

/** The face Pip makes in the browser tab: the most urgent thing happening in town. */
export function townMood(sessions: Sess[], now = Date.now()): Mood {
  if (sessions.some((s) => s.status === 'needs_input')) return 'needs';
  if (sessions.some((s) => s.stuck && s.status !== 'ended')) return 'stuck';
  if (sessions.some((s) => s.status === 'ended' && s.stamp === 'shipped' && (s.endedAt ?? 0) > now - SHIPPED_FOR_MS)) return 'shipped';
  if (sessions.some((s) => s.status === 'running')) return 'working';
  if (sessions.some((s) => s.status === 'idle')) return 'break';
  return 'hello';
}

/**
 * Keeps the favicon in step with the town: Pip, drawn by the same Avatar as the crew, making the town's face.
 * Renders a hidden small-size Avatar and copies it into the <link rel="icon">.
 */
export function PipFavicon({ mood }: { mood: Mood }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const svg = ref.current?.querySelector('svg');
    if (!svg) return;
    const icon = svg.cloneNode(true) as SVGSVGElement;
    icon.removeAttribute('style');
    icon.setAttribute('viewBox', '-6 -12 132 132'); // room for the hard hat and the raised-hand badge
    const href = 'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(icon));
    // One icon link only: a leftover second one (the old Logbook buildings) would win over Pip in the tab.
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const link = links.shift() ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    for (const extra of links) extra.remove();
    link.type = 'image/svg+xml';
    link.href = href;
  }, [mood]);
  return <div ref={ref} hidden aria-hidden="true"><AgentAvatar agent={FOREMAN} mood={mood} size={32} /></div>;
}
