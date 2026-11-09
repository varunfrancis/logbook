import { useEffect, useRef, useState } from 'react';
import type { ChatLine, ChatView, SessionView } from '../../../daemon/types.ts';
import { clock, plainAction, useVoice } from '../copy.ts';
import { post } from '../useSwarmville.ts';

/*
 * Talking to an agent Swarmville runs itself: the conversation, what they're doing right now, and a box for your next
 * message (with pictures: paste, drop or attach). No terminal involved; "Take over in terminal" moves them to one.
 */

type Img = { mediaType: string; data: string; url: string; name: string };
const MAX_SIDE = 1800;

/** A picture for Claude: big ones are scaled down (and turned into JPEG) so they fit what Claude accepts. */
export async function toImage(file: File): Promise<Img | null> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return null;
  const url = URL.createObjectURL(file);
  const bmp = await createImageBitmap(file).catch(() => null);
  const small = bmp && Math.max(bmp.width, bmp.height) <= MAX_SIDE && file.size < 3_500_000;
  if (!bmp || small) {
    const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(file); });
    return { mediaType: file.type, data, url, name: file.name || 'image' };
  }
  const k = MAX_SIDE / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * Math.min(1, k)); c.height = Math.round(bmp.height * Math.min(1, k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return { mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1], url, name: file.name || 'image' };
}

/** Runs of tool calls fold into one "did N things" line, so the conversation stays readable. */
type Item = { kind: 'line'; line: ChatLine } | { kind: 'steps'; steps: ChatLine[] };
export function groupLines(lines: ChatLine[]): Item[] {
  const out: Item[] = [];
  for (const l of lines) {
    if (l.kind === 'done' && !l.error) continue; // the end of a turn shows as the agent going quiet, not as a line
    const last = out.at(-1);
    if (l.kind === 'tool') { if (last?.kind === 'steps') last.steps.push(l); else out.push({ kind: 'steps', steps: [l] }); continue; }
    out.push({ kind: 'line', line: l });
  }
  return out;
}

export function AgentChat({ s, openAsk }: { s: SessionView; openAsk?: (sessionId: string) => void }) {
  const voice = useVoice();
  const name = s.agent.name;
  const [view, setView] = useState<ChatView | null>(null);
  const [text, setText] = useState('');
  const [imgs, setImgs] = useState<Img[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const working = s.status === 'running' || s.status === 'needs_input';

  const load = () => fetch(`/api/agent/${encodeURIComponent(s.id)}/chat`).then((r) => r.json()).then((v: ChatView) => setView(v)).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, working ? 1500 : 5000);
    return () => clearInterval(t);
  }, [s.id, working]);

  // keep the newest message in view, unless you've scrolled up to read
  const count = view?.lines.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [count]);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [view !== null]);

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].slice(0, 6 - imgs.length);
    const got = (await Promise.all(list.map(toImage))).filter((x): x is Img => !!x);
    if (got.length < list.length) setNote({ ok: false, text: 'Only pictures can go along (PNG, JPEG, GIF or WebP).' });
    if (got.length) setImgs((cur) => [...cur, ...got].slice(0, 6));
  };

  const send = async () => {
    if (busy || (!text.trim() && !imgs.length)) return;
    setBusy(true); setNote(null);
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/send`, { text, images: imgs.map(({ mediaType, data }) => ({ mediaType, data })) });
    setBusy(false);
    if (r.ok) { setText(''); imgs.forEach((i) => URL.revokeObjectURL(i.url)); setImgs([]); load(); }
    else setNote({ ok: false, text: r.message ?? 'Couldn’t send it.' });
  };
  const act = async (path: string) => {
    setNote(null);
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/${path}`);
    if (path === 'takeover') setNote({ ok: !!r.ok, text: r.message ?? (r.ok ? 'Opening it in a terminal.' : 'Couldn’t move them.') });
    load();
  };

  const items = groupLines(view?.lines ?? []);
  const off = (view?.runner ?? s.runner) === 'off';

  return (
    <section className="chat" aria-label={`Chat with ${name}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
      <div className="chat-log" ref={scroller} aria-live="polite">
        {!view ? <p className="chat-quiet">Loading the conversation…</p> : !items.length ? <p className="chat-quiet">Nothing said yet.</p> : items.map((it, i) => it.kind === 'steps' ? (
          <Steps key={i} steps={it.steps} />
        ) : it.line.kind === 'you' ? (
          <div key={i} className="msg you" title={clock(it.line.at)}>{it.line.text}{it.line.images ? <span className="msg-img">{it.line.images === 1 ? '+ a picture' : `+ ${it.line.images} pictures`}</span> : null}</div>
        ) : it.line.kind === 'them' ? (
          <div key={i} className="msg them" title={clock(it.line.at)}>{it.line.text}</div>
        ) : (
          <p key={i} className={`chat-note${it.line.error ? ' bad' : ''}`}>{it.line.text || 'That turn ended with an error.'}</p>
        ))}
        {s.status === 'needs_input' ? (
          <div className="callout bad hand chat-hand">
            <span><b>{name} needs you:</b> {s.ask?.questions?.[0]?.question ?? s.ask?.title ?? s.needsMessage ?? 'waiting for your answer'}</span>
            {openAsk ? <button className="btn approve small" onClick={() => openAsk(s.id)}>Answer</button> : null}
          </div>
        ) : s.status === 'running' ? (
          <p className="chat-now"><span className="dot s-running" />{plainAction(s.action, voice) ?? 'Thinking'}</p>
        ) : off ? (
          <p className="chat-quiet">{name} has clocked out. Send a message and they’ll pick it up again.</p>
        ) : null}
      </div>

      <div className={`chat-compose${drag ? ' drag' : ''}`}>
        {imgs.length ? (
          <div className="chat-imgs">
            {imgs.map((im, i) => (
              <span key={im.url} className="chat-img">
                <img src={im.url} alt={im.name} />
                <button type="button" className="chat-img-x" aria-label={`Remove ${im.name}`} onClick={() => { URL.revokeObjectURL(im.url); setImgs((c) => c.filter((_, j) => j !== i)); }}>×</button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="chat-row">
          <button type="button" className="ghost small chat-attach" onClick={() => fileInput.current?.click()} aria-label="Attach a picture" title="Attach a picture (or paste one)">＋</button>
          <input ref={fileInput} id={`chat-file-${s.id}`} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <label className="sr" htmlFor={`chat-${s.id}`}>Message {name}</label>
          <textarea id={`chat-${s.id}`} className="ask-input chat-input" rows={1} value={text} disabled={busy}
            placeholder={working ? `Tell ${name} something (they’ll read it after this step)…` : `Tell ${name} what to do next…`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); addFiles(files); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button type="button" className="btn dark small" onClick={send} disabled={busy || (!text.trim() && !imgs.length)}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
        <div className="chat-foot">
          <span>{off ? 'Clocked out' : 'Running here in Swarmville'} · ⏎ send · ⇧⏎ new line</span>
          <span className="chat-acts">
            {s.status === 'running' ? <button type="button" className="link" onClick={() => act('interrupt')} title={`Stop what ${name} is doing right now (they stay on, ready for your next message)`}>Stop this step</button> : null}
            <button type="button" className="link" onClick={() => act('takeover')} title="Open this same conversation in VS Code or Terminal and carry on there">Take over in terminal</button>
          </span>
        </div>
        {note ? <p className={note.ok ? 'reply-sent' : 'reply-hint'} role="status">{note.text}</p> : null}
      </div>
    </section>
  );
}

function Steps({ steps }: { steps: ChatLine[] }) {
  const last = steps.slice(-2);
  if (steps.length <= 2) return <div className="chat-steps">{last.map((l, i) => <span key={i}>{l.text}</span>)}</div>;
  return (
    <details className="chat-steps">
      <summary>{last.map((l, i) => <span key={i}>{l.text}</span>)}<span className="more">+{steps.length - 2} earlier step{steps.length === 3 ? '' : 's'}</span></summary>
      {steps.slice(0, -2).map((l, i) => <span key={i}>{l.text}</span>)}
    </details>
  );
}
