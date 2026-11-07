import { useEffect, useState } from 'react';
import type { AgentDetail, DayView, ProjectDetail, StateView, TeamView } from '../../daemon/types.ts';

export type Conn = 'connecting' | 'live' | 'offline';

/** Subscribes to the daemon's SSE stream; reconnects if it drops. */
export function useSwarmville() {
  const [state, setState] = useState<StateView | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  useEffect(() => {
    let es: EventSource | null = null;
    const load = () => fetch('/api/state').then((r) => r.json()).then((s) => { setState(s); setConn('live'); }).catch(() => setConn('offline'));
    const connect = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('state', (e) => { setState(JSON.parse((e as MessageEvent).data)); setConn('live'); });
      es.onerror = () => setConn('offline');
      es.onopen = () => setConn('live');
    };
    connect();
    const poll = setInterval(() => { if (es?.readyState === EventSource.CLOSED) { es.close(); connect(); load(); } }, 5000);
    return () => { es?.close(); clearInterval(poll); };
  }, []);
  return { state, conn };
}

function useFetch<T>(url: string | null, version?: number) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) { setData(null); return; }
    let cancelled = false;
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!cancelled) setData(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [url, version]);
  return data;
}

const tick = (v: number | undefined) => (v ? v - (v % 10000) : undefined);
export const useProject = (id: string | null, version?: number) => {
  const d = useFetch<ProjectDetail>(id ? `/api/project/${encodeURIComponent(id)}` : null, tick(version));
  return d && d.project.id === id ? d : null;
};
export const useAgent = (sessionId: string | null, version?: number) => {
  const d = useFetch<AgentDetail>(sessionId ? `/api/agent/${encodeURIComponent(sessionId)}` : null, tick(version));
  return d && d.session.id === sessionId ? d : null;
};
export const useDay = (date: string, version?: number) => useFetch<DayView>(`/api/day?date=${date}`, tick(version));
export const useTeam = (days: number) => useFetch<TeamView>(`/api/team?days=${days}`);

export async function post(url: string, body: unknown = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export const isoDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
