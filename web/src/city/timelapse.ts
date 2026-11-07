import type { DayView, ProjectView, SessionView, StateView } from '../../../daemon/types.ts';
import type { CityScene } from './scene.ts';

const KINDS: SessionView['actionKind'][] = ['edit', 'edit', 'run', 'read', 'edit', 'web'];

/** The town as it looked at time t, rebuilt from the day's shift segments. */
export function frameState(base: StateView, day: DayView, t: number): StateView {
  const live: SessionView[] = [];
  const touched = new Set<string>();
  let shipped = 0;
  for (const l of day.lanes) {
    const s = l.session;
    const seg = l.segments.find((g) => g.start <= t && t < g.end);
    if (l.segments.some((g) => g.start <= t) && s.projectId) touched.add(s.projectId);
    if (s.stamp === 'shipped' && (s.endedAt ?? Infinity) <= t) shipped++;
    if (!seg) continue;
    const status: SessionView['status'] = seg.kind === 'work' ? 'running' : seg.kind === 'wait' ? 'needs_input' : 'idle';
    const kind = KINDS[Math.floor(t / 600_000 + s.id.charCodeAt(2)) % KINDS.length];
    live.push({ ...s, status, away: false, actionKind: status === 'running' ? kind : null, needsMessage: status === 'needs_input' ? 'Waiting for your OK' : null, ask: null, stuck: null, collision: null, helperActive: false, chatter: null });
  }
  const crew = new Map<string, SessionView[]>();
  for (const s of live) { const list = crew.get(s.projectId!) ?? []; list.push(s); crew.set(s.projectId!, list); }
  const projects: ProjectView[] = base.projects.map((p) => {
    const c = crew.get(p.id) ?? [];
    let state = p.state;
    if (c.some((s) => s.status === 'needs_input')) state = 'needs';
    else if (c.length) state = 'site';
    else if (state === 'site' || state === 'needs' || touched.has(p.id)) state = 'construction';
    return { ...p, state, liveSessions: c.length, justMerged: false, stuck: false, checksFailing: false, justShipped: false };
  });
  return { ...base, projects, sessions: live, totals: { ...base.totals, shippedToday: shipped, running: live.length } };
}

export type Replay = { from: number; to: number; t: number };

export function dayRange(day: DayView): [number, number] {
  const segs = day.lanes.flatMap((l) => l.segments);
  if (!segs.length) return [day.start + 9 * 3600_000, day.start + 18 * 3600_000];
  const from = Math.min(...segs.map((g) => g.start)), to = Math.min(Date.now(), Math.max(...segs.map((g) => g.end)));
  return [from - 15 * 60_000, to + 15 * 60_000];
}

/**
 * Plays the day through the scene and records the canvas (plus a clock overlay) to a video.
 * MP4 where the browser supports recording it, otherwise WebM.
 */
export function recordTimelapse(scene: CityScene, base: StateView, day: DayView, opts: { seconds?: number; onFrame?: (r: Replay) => void; signal?: AbortSignal } = {}): Promise<{ blob: Blob; ext: string }> {
  const seconds = opts.seconds ?? 20;
  const [from, to] = dayRange(day);
  const W = 1280, H = 720;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const ctx = out.getContext('2d')!;
  const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const rec = new MediaRecorder(out.captureStream(30), { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const fontStack = '"Fredoka", "Nunito", system-ui, sans-serif';
  return new Promise((resolve, reject) => {
    rec.onstop = () => resolve({ blob: new Blob(chunks, { type: mimeType || 'video/webm' }), ext: mimeType.includes('mp4') ? 'mp4' : 'webm' });
    rec.onerror = (e) => reject(e);
    rec.start(250);
    const t0 = performance.now();
    let lastState = 0;
    const step = () => {
      if (opts.signal?.aborted) { rec.stop(); return; }
      const p = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      const t = from + p * (to - from);
      if (performance.now() - lastState > 120) { scene.setState(frameState(base, day, t), true); lastState = performance.now(); opts.onFrame?.({ from, to, t }); }
      // cover-crop the 3D canvas into 16:9
      const src = scene.canvas, sw = src.width, sh = src.height;
      const s = Math.max(W / sw, H / sh), dw = sw * s, dh = sh * s;
      ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
      const live = frameState(base, day, t);
      const working = live.sessions.length, shipped = live.totals.shippedToday;
      ctx.fillStyle = 'rgba(20,27,37,.82)';
      ctx.beginPath(); ctx.roundRect(28, 24, 300, 104, 16); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `500 52px ui-monospace, "JetBrains Mono", Menlo, monospace`;
      ctx.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 46, 84);
      ctx.font = `700 15px "Nunito", system-ui, sans-serif`; ctx.fillStyle = '#aab4c2';
      ctx.fillText(`${base.town.name} · ${new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}`, 46, 112);
      const pills = [`${working} crew on site`, `${shipped} shipped so far`];
      ctx.font = `800 17px "Nunito", system-ui, sans-serif`;
      pills.forEach((txt, i) => {
        const w = ctx.measureText(txt).width + 28;
        ctx.fillStyle = 'rgba(20,27,37,.82)'; ctx.beginPath(); ctx.roundRect(W - 28 - w, 24 + i * 46, w, 38, 12); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(txt, W - 14 - w, 49 + i * 46);
      });
      ctx.font = `600 24px ${fontStack}`; ctx.fillStyle = '#ffffff'; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 8;
      ctx.fillText('swarmville', W - 24 - ctx.measureText('swarmville').width, H - 26); ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(0, H - 5, W, 5); ctx.fillStyle = '#17c3c3'; ctx.fillRect(0, H - 5, W * p, 5);
      if (p < 1) requestAnimationFrame(step); else setTimeout(() => rec.stop(), 300);
    };
    requestAnimationFrame(step);
  });
}
