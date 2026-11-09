import type { StateView } from '../../../daemon/types.ts';
import { scorecard } from '../crew/scorecard.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { clock, plainAction, priced, useCostView, STAMP_NOTE, STATUS, useVoice } from '../copy.ts';
import { ago, compact, didSummary, duration, firstLine, madeLinks, tildify } from '../format.ts';
import { ClockOut, GoTo, PrChip, Stamp } from '../components.tsx';
import { post, useAgent, useNow } from '../useSwarmville.ts';
import { useState } from 'react';
import type { SessionView } from '../../../daemon/types.ts';
import { WorkWith } from '../welcome/WorkWith.tsx';
import { AgentChat } from './Chat.tsx';

const MOMENT: Record<string, { sym: string; cls: string; title: string }> = {
  m_prompt: { sym: '→', cls: 'mo-you', title: 'You asked' },
  m_ask: { sym: '…', cls: 'mo-ask', title: 'Raised a hand' },
  m_test_ok: { sym: '✓', cls: 'mo-ok', title: 'Checked its work' },
  m_test_fail: { sym: '!', cls: 'mo-bad', title: 'Hit a snag' },
  m_commit: { sym: 'S', cls: 'mo-save', title: 'Saved progress' },
  m_pr: { sym: 'R', cls: 'mo-ok', title: 'Sent it for review' },
  needs: { sym: '✋', cls: 'mo-ask', title: 'Waited for your OK' },
};
const VERDICT = { true: ['✓', 'v-true', 'True.'], false: ['✕', 'v-false', 'Not quite.'], partly: ['~', 'v-partly', 'Partly.'], unknown: ['?', 'v-unknown', 'Can’t tell.'] } as const;

function cleanAsk(t: string | null | undefined) {
  const x = (t ?? '').replace(/^\/\S+\s*/, '').replace(/'?(\/var\/folders|\/Users|\/private)\/[^'\n]*?\.(png|jpe?g|gif|webp|pdf)'?/gi, '').replace(/\s+/g, ' ').trim();
  return x.length < 12 || /^[0-9a-f]{6,}$/i.test(x) ? '' : firstLine(x, 180); // skip empty or id-like prompts
}

export function AgentPanel({ id, state, onClose, openProject, openAgent, openAsk }: { id: string; state: StateView; onClose: () => void; openProject: (id: string) => void; openAgent?: (sessionId: string) => void; openAsk?: (sessionId: string) => void }) {
  const voice = useVoice();
  const cost = useCostView();
  const now = useNow(15000);
  const d = useAgent(id, state.generatedAt);
  const s = d?.session ?? state.sessions.find((x) => x.id === id);
  if (!s) return <aside className="panel"><button className="ghost close" onClick={onClose} aria-label="Close">×</button><p className="muted">Loading…</p></aside>;
  const a = s.agent;
  const project = d?.project ?? state.projects.find((p) => p.id === s.projectId);
  const moments = (d?.moments ?? []).filter((m) => MOMENT[m.kind]).slice(-14);
  const card = d ? scorecard(d.profile, cost === 'api') : null;
  const live = s.status !== 'ended';
  const latest = cleanAsk(s.lastPrompt) || cleanAsk(s.firstPrompt) || s.title;
  // what they did on the last ask, once they've stopped to report (mid-turn text is just narration)
  const did = s.status === 'running' || s.status === 'needs_input' ? '' : didSummary(s.outcome);
  const links = did ? madeLinks(s.outcome) : [];
  const resumeJob = async (sid: string) => { await post(`/api/resume/${encodeURIComponent(sid)}`); };

  return (
    <aside className="panel agent" aria-label={`${a.title} profile`}>
      <header className="agent-head">
        <AgentAvatar agent={a} mood={moodFor(s)} size={72} />
        <div className="agent-id">
          <h2>{a.title}</h2>
          <div className="agent-meta">
            <span className={`pill s-${s.away ? 'away' : s.status}`}>{s.away ? 'Away' : STATUS[voice][s.status]}</span>
            <span>{a.role === 'resident' ? 'Resident' : a.role === 'helper' ? 'Helper' : a.role === 'routine' ? 'Scheduled job' : 'Own workbench'}{d?.career.since ? ` · since ${new Date(d.career.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}{d ? ` · ${d.profile.shifts} shift${d.profile.shifts === 1 ? '' : 's'}` : ''}</span>
          </div>
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close profile">×</button>
      </header>

      {s.runner ? <AgentChat key={s.id} s={s} openAsk={openAsk} /> : null}
      {s.status === 'needs_input' && !s.runner ? (
        <div className="callout bad hand">
          <span><b>{a.name} raised a hand.</b> {s.ask?.questions?.[0]?.question ?? s.ask?.title ?? s.needsMessage}</span>
          {openAsk ? <button className="btn approve" onClick={() => openAsk(s.id)}>{s.ask ? 'Answer' : 'See what they need'}</button> : null}
        </div>
      ) : null}
      {s.stuck ? <div className="callout bad"><b>Stuck.</b> Hit the same problem {s.stuck.count} times{voice === 'technical' ? `: ${s.stuck.problem}` : '.'}</div> : null}

      <section className={`profile-block job-block${live ? '' : ' done'}`} aria-label="The job">
        <h3>{live ? 'Working on now' : `Last job · ${ago(s.endedAt, now)}`}</h3>
        <div className="job-row"><span className="job-k">You asked</span><p className="one-liner latest" title={latest}>{latest}</p></div>
        {did ? (
          <div className="job-row did"><span className="job-k">Did</span><p className="one-liner" title={did}>{did}</p></div>
        ) : null}
        {did && links.length ? (
          <div className="made-links">{links.map((l) => <a key={l.url} className="made-link" href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.label} ↗</a>)}</div>
        ) : null}
        {did && s.outcome && s.outcome.trim().length > did.length + 40 ? (
          <details className="full-reply"><summary>Read {a.name}’s full reply</summary><p className="outcome-full">{s.outcome}</p></details>
        ) : null}
        {live && !did ? <p className="right-now" title={plainAction(s.action, voice) ?? ''}>{s.status === 'running' ? <>Right now: {plainAction(s.action, voice) ?? 'thinking'}</> : s.status === 'needs_input' ? 'Waiting for you' : 'Done for now, ready for more'}</p>
          : !live && s.stamp ? <p className="right-now"><Stamp stamp={s.stamp} /> {STAMP_NOTE[s.stamp]}</p> : null}
        {!live && s.kind !== 'bg' && !s.scheduled && !s.runner ? <Reply key={s.id} s={s} name={a.name} /> : null}
        <div className="row actions"><GoTo s={s} />{live ? <ClockOut key={s.id} s={s} /> : null}{s.prUrl ? <PrChip url={s.prUrl} state={s.prState} /> : null}</div>
      </section>

      {card ? (
        <section className="scorecard" aria-label="How they’re doing">
          <div className={`verdict-line g-${card.verdict.grade}`}>{card.verdict.text}</div>
          <div className="scores">
            {card.scores.map((sc) => (
              <div key={sc.label} className={`score g-${sc.grade}`} title={sc.help}>
                <span className="score-label">{sc.label}</span>
                <b className="score-value">{sc.value}</b>
                <span className="score-note">{sc.note}</span>
              </div>
            ))}
          </div>
        </section>
      ) : <div className="scores loading-scores" />}

      <section className="profile-block">
        <h3>Works on</h3>
        <button className="link strong" onClick={() => project && openProject(project.id)}>{project?.name ?? 'a project'}</button>
        <p className="one-liner">{project?.summary ?? 'No description yet.'}</p>
      </section>

      <WorkWith key={s.id} state={state} s={s} openAgent={openAgent} />
      {d && d.profile.recent.length > 1 ? (
        <section className="profile-block">
          <h3>Recent jobs</h3>
          <ul className="recent-jobs">
            {d.profile.recent.map((r) => (
              <li key={r.id}>
                <button className={`rj${r.id === s.id ? ' current' : ''}`} onClick={() => openAgent?.(r.id)} disabled={r.id === s.id} title={r.id === s.id ? 'You’re looking at this job' : 'Open this job: what was asked, how it went, and resume it'}>
                  {r.live ? <span className="stamp st-live">On it</span> : r.stamp ? <Stamp stamp={r.stamp} /> : <span className="stamp st-pending">Checking…</span>}
                  <span className="rj-title" title={r.title}>{cleanAsk(r.ask) || r.title}</span>
                  <span className="sub">{r.id === s.id ? 'viewing' : r.live ? 'now' : ago(r.at, now)}</span>
                </button>
                {!r.live ? <button className="ghost small rj-resume" onClick={() => resumeJob(r.id)} title="Reopen this conversation in a terminal">Resume</button> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d ? (
        <dl className="mini-stats" aria-label="Last 30 days">
          <div><dd>{(d.profile.workMs / 3600_000).toFixed(1)}</dd><dt>hours</dt></div>
          <div><dd>{d.profile.checksOk + d.profile.checksFail ? `${Math.round((d.profile.checksOk / (d.profile.checksOk + d.profile.checksFail)) * 100)}%` : '—'}</dd><dt>checks pass</dt></div>
          <div><dd>{d.profile.saves}</dd><dt>saves</dt></div>
          <div><dd className={d.profile.scrapped ? 'hot' : ''}>{d.profile.scrapped}</dd><dt>scrapped</dt></div>
        </dl>
      ) : null}

      <details className="shift-detail">
        <summary>This shift in detail</summary>
        <section>
          <h3>What you asked for</h3>
          <p className="brief">“{s.firstPrompt ?? s.title}”</p>
        </section>
        {moments.length ? (
          <section>
            <h3>How it went</h3>
            <ol className="moments">
              {moments.map((m, i) => (
                <li key={i}><span className="t">{clock(m.ts)}</span><span className={`ms ${MOMENT[m.kind].cls}`}>{MOMENT[m.kind].sym}</span>
                  <div><b>{MOMENT[m.kind].title}</b><div className="sub">{m.kind === 'm_pr' ? 'Review request opened.' : m.text}</div></div></li>
              ))}
            </ol>
          </section>
        ) : null}
        {d?.claims.length ? (
          <section>
            <h3>What {a.name} said vs. what actually happened</h3>
            <ul className="claims">
              {d.claims.map((c, i) => { const [sym, cls, lead] = VERDICT[c.verdict]; return (
                <li key={i}><span className={`verdict ${cls}`}>{sym}</span><span>“{c.claim}”</span><span className="sub">{lead} {c.evidence}</span></li>
              ); })}
            </ul>
          </section>
        ) : null}
        <p className="sub">{s.status === 'ended' ? `Clocked out ${ago(s.endedAt, now)} after ${duration(s.startedAt, s.endedAt)}.` : `On shift for ${duration(s.startedAt, now)}.`} {priced(cost, s.costUsd)}{cost === 'api' ? (s.costEstimated ? ' at API prices (est.)' : ' at API prices') : ''} · {voice === 'plain' ? `${s.bricks.toLocaleString()} bricks` : `${compact(s.tokens)} tokens`}</p>
        {voice === 'technical' ? <p className="path">{tildify(s.cwd)} · {s.branch ?? '—'} · {s.model ?? ''} · session {s.id}</p> : null}
      </details>
    </aside>
  );
}

/** Bring a clocked-out agent back with its next instruction (claude --resume with your message as the prompt). */
function Reply({ s, name }: { s: SessionView; name: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setMsg(null);
    const r = await post(`/api/reply/${encodeURIComponent(s.id)}`, { text });
    setBusy(false);
    setMsg({ ok: !!r.ok, text: r.message ?? (r.ok ? 'Sent.' : 'Couldn’t send it.') });
    if (r.ok) setText('');
  };
  return (
    <div className="reply-box">
      <label className="reply-k" htmlFor={`reply-${s.id}`}>Pick up where {name} left off</label>
      <textarea id={`reply-${s.id}`} className="ask-input" rows={2} value={text} disabled={busy} placeholder="What should they do next?"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <div className="reply-row">
        <button className="btn approve" onClick={send} disabled={busy || !text.trim()}>Resume with this message</button>
        <span className="reply-note">⏎ to send · ⇧⏎ new line</span>
      </div>
      {msg ? <p className={msg.ok ? 'reply-sent' : 'reply-hint'} role="status">{msg.text}</p> : null}
    </div>
  );
}
