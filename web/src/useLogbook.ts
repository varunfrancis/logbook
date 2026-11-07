import { useEffect, useState } from 'react';
import type { ProjectDetail, StateView } from '../../daemon/types.ts';

export type Conn = 'connecting' | 'live' | 'offline';

/** Subscribes to the daemon's SSE stream; falls back to polling if the stream drops. */
export function useLogbook() {
  const [state, setState] = useState<StateView | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const load = () => fetch('/api/state').then((r) => r.json()).then((s) => { setState(s); setConn('live'); }).catch(() => setConn('offline'));
    const connect = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('state', (e) => { setState(JSON.parse((e as MessageEvent).data)); setConn('live'); });
      es.onerror = () => { setConn('offline'); };
      es.onopen = () => setConn('live');
    };
    connect();
    poll = setInterval(() => { if (es?.readyState === EventSource.CLOSED) { es.close(); connect(); load(); } }, 5000);
    return () => { es?.close(); if (poll) clearInterval(poll); };
  }, []);
  return { state, conn };
}

/** Loads full history for one project; refreshes when the global state changes. */
export function useProject(id: string | null, version: number | undefined) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  useEffect(() => {
    if (!id) { setDetail(null); return; }
    let cancelled = false;
    fetch(`/api/project/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!cancelled) setDetail(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [id, version]);
  return detail && detail.project.id === id ? detail : null;
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
