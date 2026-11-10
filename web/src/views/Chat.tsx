import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActionKind, ChatLine, ChatReach, ChatView, SessionView } from '../../../daemon/types.ts';
import { clock, plainAction, useVoice } from '../copy.ts';
import { post } from '../useSwarmville.ts';
import { AgentAvatar } from '../crew/Avatar.tsx';
import { GoTo } from '../components.tsx';
import { Markdown } from './Markdown.tsx';
import { yourTurn } from '../turn.ts';
import { markSeen } from '../chats.ts';

/** What you were typing to each agent, kept while you move between chats (or from the drawer to Chats). */
const drafts = new Map<string, string>();

/** Tells the drawer header and the town to cheer along when you high-five an agent. */
export const HIGH_FIVE = 'swarmville:highfive';

/*
 * Talking to an agent: the conversation, what they're doing right now, and a box for your next message (with pictures:
 * paste, drop or attach). Agents Swarmville runs take the message at once; ones that clocked out come back here with it;
 * ones working in your terminal get it at their next step (steer.ts); resting ones are talked to there ("Go to").
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

/** Runs of tool calls fold into one "looked at 3 files · ran a command" chip, so the conversation stays readable. */
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

const KIND_WORDS: Record<ActionKind | 'other', [string, string]> = {
  read: ['looked at a file', 'looked at {n} files'],
  edit: ['changed a file', 'changed {n} files'],
  run: ['ran a command', 'ran {n} commands'],
  web: ['checked the web', 'checked the web {n} times'],
  delegate: ['sent a helper', 'sent {n} helpers'],
  think: ['made a plan', 'planned {n} times'],
  other: ['did a step', 'did {n} steps'],
};
const KIND_ICON: Record<ActionKind | 'other', string> = { read: '⌕', edit: '✎', run: '›_', web: '◍', delegate: '⇉', think: '✦', other: '·' };

/** "Looked at 3 files · ran a command" */
export function stepsSummary(steps: ChatLine[]): string {
  const counts = new Map<ActionKind | 'other', number>();
  for (const s of steps) { const k = s.tool ?? 'other'; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const text = [...counts].map(([k, n]) => (n === 1 ? KIND_WORDS[k][0] : KIND_WORDS[k][1].replace('{n}', String(n)))).join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Your own long messages fold to a few lines, so your brief doesn't fill the chat every time. */
const isLong = (t: string) => t.length > 320 || t.split('\n').length > 5;

export function AgentChat({ s, openAsk }: { s: SessionView; openAsk?: (sessionId: string) => void }) {
  const voice = useVoice();
  const name = s.agent.name;
  const [view, setView] = useState<ChatView | null>(null);
  const [text, setTextRaw] = useState(() => drafts.get(s.id) ?? '');
  const setText = (v: string) => { setTextRaw(v); if (v) drafts.set(s.id, v); else drafts.delete(s.id); };
  const [imgs, setImgs] = useState<Img[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string; at: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picked, setPicked] = useState<{ at: number; n: number } | null>(null);
  const [fived, setFived] = useState<Set<number>>(() => new Set()); // replies you've high-fived (by time)
  const [hop, setHop] = useState(0);
  const [skipTurn, setSkipTurn] = useState<number | null>(null); // "Something else": the card steps aside for that reply
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const working = s.status === 'running' || s.status === 'needs_input';

  const load = () => fetch(`/api/agent/${encodeURIComponent(s.id)}/chat`).then((r) => r.json()).then((v: ChatView) => setView(v)).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, working ? 1500 : 5000);
    return () => clearInterval(t);
  }, [s.id, working]);

  // notes fade on their own instead of sitting under the box forever
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast?.at]);
  const say = (ok: boolean, msg: string) => setToast({ ok, text: msg, at: Date.now() });

  // Having the chat open counts as reading it (the Chats list stops showing their reply as new).
  useEffect(() => { if (view) markSeen(s.id); }, [s.id, view?.lines.length, s.lastEventAt, s.status]);

  const items = groupLines(view?.lines ?? []);
  const count = view?.lines.length ?? 0;

  // A new reply opens at its first line (not its last); short ones just keep the newest message in view.
  // Unless you've scrolled up to read: then nothing moves.
  const seen = useRef(-1);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !view) return;
    const first = seen.current < 0;
    if (count === seen.current) return;
    seen.current = count;
    if (!first && !atBottom.current) return;
    const newest = el.querySelector<HTMLElement>('[data-newest-them]');
    // the newest reply is the last thing said (only the live line or a raised hand after it) and taller than the view
    const isTail = newest && !newest.nextElementSibling?.matches('.msg-row, .msg, .chat-steps');
    if (newest && isTail && newest.offsetHeight > el.clientHeight * 0.6) { el.scrollTop = newest.offsetTop - 12; atBottom.current = false; }
    else el.scrollTop = el.scrollHeight;
  }, [count, view !== null]);
  const onScroll = () => { const el = scroller.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160; };

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].slice(0, 6 - imgs.length);
    const got = (await Promise.all(list.map(toImage))).filter((x): x is Img => !!x);
    if (got.length < list.length) say(false, 'Only pictures can go along (PNG, JPEG, GIF or WebP).');
    if (got.length) setImgs((cur) => [...cur, ...got].slice(0, 6));
  };

  const send = async () => {
    if (busy || (!text.trim() && !imgs.length)) return;
    setBusy(true);
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/send`, { text, images: imgs.map(({ mediaType, data }) => ({ mediaType, data })) });
    setBusy(false);
    if (r.ok) { setText(''); imgs.forEach((i) => URL.revokeObjectURL(i.url)); setImgs([]); atBottom.current = true; load(); }
    else say(false, r.message ?? 'Couldn’t send it.');
  };
  /** Puts words in the box for you to check and send (Pick, Your turn answers). */
  const fill = (words: string) => {
    setText(words);
    requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(words.length, words.length); } });
  };
  const highFive = async (at: number) => {
    if (fived.has(at)) return;
    setFived((cur) => new Set(cur).add(at));
    setHop(Date.now());
    window.dispatchEvent(new CustomEvent(HIGH_FIVE, { detail: { sessionId: s.id } }));
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/highfive`);
    if (r.ok) say(true, `High-five sent. ${name} has ${r.count === 1 ? 'their first' : `${r.count}`} high-five${r.count === 1 ? '' : 's'} from you.`);
  };
  const act = async (path: string) => {
    setMenu(false);
    const r = await post(path);
    if (r.message || !r.ok) say(!!r.ok, r.message ?? 'That didn’t work.');
    load();
  };

  const reach: ChatReach = view?.reach ?? (s.runner ? 'here' : s.status !== 'ended' ? 'terminal' : 'resume');
  const canType = reach === 'here' || reach === 'resume';
  const asleep = s.status === 'ended' || (view?.runner ?? s.runner) === 'off';
  const newestThem = items.findLastIndex((it) => it.kind === 'line' && it.line.kind === 'them');
  const newest = newestThem >= 0 ? (items[newestThem] as { kind: 'line'; line: ChatLine }).line : null;
  const settled = s.status !== 'running' && s.status !== 'needs_input'; // they've stopped and reported
  const lastIsReply = newestThem >= 0 && newestThem === items.length - 1;
  const turn = canType && settled && lastIsReply && newest && skipTurn !== newest.at ? yourTurn(newest.text) : null;
  const placeholder = s.status === 'running' ? `Tell ${name} something. They’ll read it after this step.`
    : s.status === 'needs_input' ? `Answer ${name}…`
    : asleep ? `Wake ${name} with a message…` : `Tell ${name} what to do next…`;

  return (
    <section className="chat" aria-label={`Chat with ${name}`}
      onDragOver={(e) => { if (canType && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (canType && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
      <div className="chat-log" ref={scroller} onScroll={onScroll} aria-live="polite">
        {!view ? <p className="chat-quiet">Loading the conversation…</p> : !items.length ? <p className="chat-quiet">Nothing said yet.</p> : items.map((it, i) => {
          if (it.kind === 'steps') return <Steps key={i} steps={it.steps} />;
          const l = it.line;
          if (l.kind === 'you') return <YouMsg key={i} line={l} />;
          if (l.kind === 'them') {
            const prev = items[i - 1];
            const withFace = !(prev?.kind === 'line' && prev.line.kind === 'them');
            const isNewest = i === newestThem;
            const pickable = isNewest && canType && settled;
            return (
              <div key={i} className={`msg-row them${withFace ? '' : ' cont'}`} data-newest-them={isNewest ? '' : undefined}>
                <span className={`msg-face${isNewest && hop ? ' hop' : ''}`} key={isNewest ? hop : undefined}>{withFace || isNewest ? <AgentAvatar agent={s.agent} mood="hello" size={30} /> : null}</span>
                <div className="msg-col">
                  <div className="msg them" title={clock(l.at)}>
                    <Markdown text={l.text} long onPick={pickable ? (n, label) => { setPicked({ at: l.at, n }); fill(`Go with option ${n}: ${label}.`); } : undefined} picked={picked?.at === l.at ? picked.n : null} />
                  </div>
                  {isNewest && settled ? (
                    <div className="msg-reacts">
                      <button type="button" className={`hi5${fived.has(l.at) ? ' done' : ''}`} onClick={() => highFive(l.at)} disabled={fived.has(l.at)} title={`A cheer for ${name}. It isn’t sent to them and doesn’t wake them.`}>
                        <span aria-hidden>✋</span> {fived.has(l.at) ? 'High-fived!' : 'High-five'}
                      </button>
                      <span className="when">{clock(l.at)}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          }
          return <p key={i} className={`chat-note${l.error ? ' bad' : ''}`}>{l.text || 'That turn ended with an error.'}</p>;
        })}
        {s.status === 'needs_input' ? (
          <div className="callout bad hand chat-hand">
            <span><b>{name} needs you:</b> {s.ask?.questions?.[0]?.question ?? s.ask?.title ?? s.needsMessage ?? 'waiting for your answer'}</span>
            {openAsk ? <button className="btn approve small" onClick={() => openAsk(s.id)}>Answer</button> : null}
          </div>
        ) : s.status === 'running' ? (
          <div className="chat-now">
            <AgentAvatar agent={s.agent} mood="hello" size={30} live talking />
            <span className="chat-now-said">{plainAction(s.action, voice) ?? 'Thinking'}<span className="bricks" aria-hidden><i /><i /><i /></span></span>
          </div>
        ) : null}
      </div>

      {toast ? <p className={`chat-toast${toast.ok ? '' : ' bad'}`} role="status" key={toast.at}>{toast.text}</p> : null}

      {turn && newest ? (
        <div className="your-turn" role="region" aria-label="Your turn">
          <p><b>Your turn</b>{turn.more ? `${name} asked ${turn.more + 1} things. The last one: ` : `${name} asked: `}{turn.question}</p>
          <div className="your-turn-answers">
            {turn.answers.map((a) => <button key={a.label} type="button" className="turn-chip" onClick={() => fill(a.say)}>{a.label}</button>)}
            <button type="button" className="turn-chip ghost" onClick={() => { setSkipTurn(newest.at); fill(''); }}>{turn.answers.length ? 'Something else…' : 'Answer in my own words'}</button>
          </div>
        </div>
      ) : null}

      {canType ? (
        <div className={`chat-compose${drag ? ' drag' : ''}`}>
          <div className="chat-box" onClick={(e) => { if (e.target === e.currentTarget) input.current?.focus(); }}>
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
            <label className="sr" htmlFor={`chat-${s.id}`}>Message {name}</label>
            <textarea ref={input} id={`chat-${s.id}`} className="chat-input" rows={2} value={text} disabled={busy} placeholder={placeholder}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => { const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); addFiles(files); } }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
            <div className="chat-row">
              <button type="button" className="chat-attach" onClick={() => fileInput.current?.click()} aria-label="Attach a picture" title="Attach a picture (or paste one)">＋</button>
              <input ref={fileInput} id={`chat-file-${s.id}`} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
              <span className="grow" />
              {s.status === 'running' && reach === 'here' ? <button type="button" className="chat-stop" onClick={() => act(`/api/agent/${encodeURIComponent(s.id)}/interrupt`)} title={`Stop what ${name} is doing right now (they stay on, ready for your next message)`}>■ Stop</button> : null}
              <button type="button" className="btn chat-send" onClick={send} disabled={busy || (!text.trim() && !imgs.length)}>{busy ? 'Sending…' : 'Send'}</button>
            </div>
          </div>
          <div className="chat-foot">
            <span>⏎ send · ⇧⏎ new line · Esc closes</span>
            <span className="chat-more">
              <button type="button" className="link" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯ More</button>
              {menu ? (
                <span className="chat-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                  {reach === 'here'
                    ? <button type="button" role="menuitem" onClick={() => act(`/api/agent/${encodeURIComponent(s.id)}/takeover`)} title="Open this same conversation in VS Code or Terminal and carry on there">Take over in terminal</button>
                    : <button type="button" role="menuitem" onClick={() => act(`/api/resume/${encodeURIComponent(s.id)}`)} title="Reopen this conversation in VS Code or Terminal instead">Open in terminal instead</button>}
                </span>
              ) : null}
            </span>
          </div>
        </div>
      ) : reach === 'terminal' ? (
        <SteerBox s={s} name={name} steers={view?.steers ?? []} onSent={load} />
      ) : (
        <div className="chat-elsewhere"><span>Scheduled jobs run on their own, so there’s nothing to reply to.</span></div>
      )}
    </section>
  );
}

/**
 * An agent open in your terminal: while they work, a message typed here reaches them at their next step (Swarmville never types
 * into your terminal). Resting agents only hear you in the terminal itself, so then it points you there.
 */
function SteerBox({ s, name, steers, onSent }: { s: SessionView; name: string; steers: NonNullable<ChatView['steers']>; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const working = s.status === 'running';
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    const r = await post(`/api/agent/${encodeURIComponent(s.id)}/steer`, { text });
    setBusy(false);
    setMsg({ ok: !!r.ok, text: r.message ?? (r.ok ? 'Sent.' : 'It didn’t send.') });
    if (r.ok) { setText(''); onSent(); }
  };
  return (
    <div className="steer">
      {steers.length ? (
        <ul className="steer-sent" aria-label={`What you sent ${name}`}>
          {steers.slice(-3).map((m) => (
            <li key={m.at}><span className="steer-text">{m.text}</span><span className={`steer-state${m.delivered ? ' ok' : ''}`}>{m.delivered ? 'Reached them' : 'Waiting for their next step'}</span></li>
          ))}
        </ul>
      ) : null}
      {working ? (
        <div className="chat-box">
          <label className="sr" htmlFor={`steer-${s.id}`}>Tell {name} something</label>
          <textarea id={`steer-${s.id}`} className="chat-input" rows={2} value={text} disabled={busy} placeholder={`Tell ${name} something while they work…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <div className="chat-row">
            <span className="steer-hint">{name} is working in your terminal. They get this at their next step.</span>
            <span className="grow" />
            <GoTo s={s} />
            <button type="button" className="btn chat-send" onClick={send} disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      ) : (
        <div className="chat-elsewhere"><span><b>{name}</b> is resting in your terminal. Messages reach them there, so use Go to to pick it back up.</span><GoTo s={s} primary /></div>
      )}
      {msg ? <p className={`steer-msg${msg.ok ? '' : ' bad'}`} role="status">{msg.text}</p> : null}
    </div>
  );
}

function YouMsg({ line }: { line: ChatLine }) {
  const long = isLong(line.text);
  const [open, setOpen] = useState(false);
  return (
    <div className={`msg you${long && !open ? ' folded' : ''}`} title={clock(line.at)}>
      <span className="msg-text">{line.text}</span>
      {line.images ? <span className="msg-img">{line.images === 1 ? '+ a picture' : `+ ${line.images} pictures`}</span> : null}
      {long ? <button type="button" className="msg-more" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button> : null}
    </div>
  );
}

function Steps({ steps }: { steps: ChatLine[] }) {
  const kind = steps.at(-1)?.tool ?? 'other';
  return (
    <details className="chat-steps">
      <summary><span className="steps-icon" aria-hidden>{KIND_ICON[kind]}</span>{stepsSummary(steps)}<span className="steps-caret" aria-hidden>▸</span></summary>
      <ol>{steps.map((l, i) => <li key={i}>{l.text}</li>)}</ol>
    </details>
  );
}
