import type { SessionView, StateView } from '../../../daemon/types.ts';
import { scorecard } from '../crew/scorecard.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { clock, priced, useCostView, STAMP_NOTE, STATUS, useVoice, type Voice } from '../copy.ts';
import { ago, compact, duration, madeLinks, tildify } from '../format.ts';
import { ClockOut, GoTo, PrChip, Stamp } from '../components.tsx';
import { post, useAgent, useNow } from '../useSwarmville.ts';
import { useEffect, useState } from 'react';
import { WorkWith } from '../welcome/WorkWith.tsx';
import { AgentChat, HIGH_FIVE } from './Chat.tsx';

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
  return x.length < 12 || /^[0-9a-f]{6,}$/i.test(x) ? '' : x.length > 180 ? x.slice(0, 179) + '…' : x; // skip empty or id-like prompts
}

/** One honest line about where they are and whether a message reaches them. */
export function statusLine(s: Pick<SessionView, 'status' | 'away' | 'runner' | 'endedAt' | 'kind' | 'scheduled'>, voice: Voice, now: number): { cls: string; text: string } {
  if (s.away) return { cls: 'away', text: 'Away' };
  const terminal = !s.runner && s.status !== 'ended' ? ' · in your terminal' : '';
  if (s.status === 'needs_input') return { cls: 'needs_input', text: `Waiting for you${terminal}` };
  if (s.status === 'running') return { cls: 'running', text: `${STATUS[voice].running}${terminal}` };
  if (s.status === 'idle') return { cls: 'idle', text: s.runner ? 'Ready for your next message' : `${STATUS[voice].idle}${terminal}` };
  const quiet = s.kind === 'bg' || s.scheduled;
  const since = !s.endedAt ? '' : now - s.endedAt < 18 * 3600_000 ? ` since ${clock(s.endedAt)}` : `, clocked out ${ago(s.endedAt, now)}`;
  return { cls: 'ended', text: `Asleep${since}${quiet ? '' : ' · a message wakes them'}` };
}

export function AgentPanel({ id, state, onClose, openProject, openAgent, openAsk, onExpand, startTab = 'chat' }: { id: string; state: StateView; onClose: () => void; openProject: (id: string) => void; openAgent?: (sessionId: string) => void; openAsk?: (sessionId: string) => void;
  /** Open this agent in the full-screen Chats view. */ onExpand?: (sessionId: string) => void; startTab?: 'chat' | 'profile' }) {
  const voice = useVoice();
  const now = useNow(15000);
  const d = useAgent(id, state.generatedAt);
  const [tab, setTab] = useState<'chat' | 'profile'>(startTab); // opens on the chat, unless you asked for the profile
  const [hop, setHop] = useState(0);
  useEffect(() => {
    const f = (e: Event) => { if ((e as CustomEvent).detail?.sessionId === id) setHop(Date.now()); };
    window.addEventListener(HIGH_FIVE, f);
    return () => window.removeEventListener(HIGH_FIVE, f);
  }, [id]);
  const s = d?.session ?? state.sessions.find((x) => x.id === id);
  const dim = <div className="panel-dim" onClick={onClose} aria-hidden />;
  if (!s) return <>{dim}<aside className="panel agent"><button className="ghost close" onClick={onClose} aria-label="Close">×</button><p className="muted">Loading…</p></aside></>;
  const a = s.agent;
  const project = d?.project ?? state.projects.find((p) => p.id === s.projectId);
  const st = statusLine(s, voice, now);

  return (
    <>
      {dim}
      <aside className="panel agent" aria-label={`${a.title}`}>
        <header className="agent-head">
          <span className={`agent-face${hop ? ' hop' : ''}`} key={hop}>
            <AgentAvatar agent={a} mood={hop && Date.now() - hop < 2000 ? 'shipped' : moodFor(s)} size={46} live={s.status !== 'ended'} />
            {hop ? <span className="hi5-pop" aria-hidden>✋</span> : null}
          </span>
          <div className="agent-id">
            <h2>{a.title}</h2>
            <div className="agent-status">
              <span className={`dot s-${st.cls}`} />
              <span>{st.text}</span>
              {project ? <>
                <span aria-hidden>·</span>
                <button className="link" onClick={() => openProject(project.id)} title="Open the project">{project.name}</button>
              </> : null}
            </div>
          </div>
          {onExpand ? <button className="ghost close expand" onClick={() => onExpand(s.id)} aria-label="Open in Chats" title="Open in Chats, full screen, with everyone else on the left">⤢</button> : null}
          <button className="ghost close" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
        </header>

        <nav className="agent-tabs" role="tablist" aria-label="Agent">
          <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            Chat{tab !== 'chat' && s.status === 'needs_input' ? <span className="tab-dot" aria-label="needs you" /> : null}
          </button>
          <button role="tab" aria-selected={tab === 'profile'} className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}>Profile</button>
        </nav>

        {tab === 'chat'
          ? <AgentChat key={s.id} s={s} openAsk={openAsk} />
          : <Profile s={s} d={d} state={state} openProject={openProject} openAgent={openAgent} />}
      </aside>
    </>
  );
}

/** Everything about the agent that isn't the conversation: how they're doing, what they work on, their recent jobs. */
function Profile({ s, d, state, openProject, openAgent }: { s: SessionView; d: ReturnType<typeof useAgent>; state: StateView; openProject: (id: string) => void; openAgent?: (sessionId: string) => void }) {
  const voice = useVoice();
  const cost = useCostView();
  const now = useNow(15000);
  const a = s.agent;
  const project = d?.project ?? state.projects.find((p) => p.id === s.projectId);
  const moments = (d?.moments ?? []).filter((m) => MOMENT[m.kind]).slice(-14);
  const card = d ? scorecard(d.profile, cost === 'api') : null;
  const live = s.status !== 'ended';
  const links = s.status === 'running' || s.status === 'needs_input' ? [] : madeLinks(s.outcome);
  const resumeJob = async (sid: string) => { await post(`/api/resume/${encodeURIComponent(sid)}`); };

  return (
    <div className="agent-body">
      {s.stuck ? <div className="callout bad"><b>Stuck.</b> Hit the same problem {s.stuck.count} times{voice === 'technical' ? `: ${s.stuck.problem}` : '.'}</div> : null}

      <section className={`profile-block job-block${live ? '' : ' done'}`} aria-label="This job">
        <h3>{live ? 'This job' : `Last job · ${ago(s.endedAt, now)}`}</h3>
        {!live && s.stamp ? <p className="right-now"><Stamp stamp={s.stamp} /> {STAMP_NOTE[s.stamp]}</p> : null}
        {links.length ? <div className="made-links">{links.map((l) => <a key={l.url} className="made-link" href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.label} ↗</a>)}</div> : null}
        <div className="row actions"><GoTo s={s} />{live ? <ClockOut key={s.id} s={s} /> : null}{s.prUrl ? <PrChip url={s.prUrl} state={s.prState} /> : null}</div>
      </section>

      {card ? (
        <section className="scorecard" aria-label="How they’re doing">
          <div className={`verdict-line g-${card.verdict.grade}`}>{card.verdict.text}</div>
          {d?.highFives ? <p className="hi5-count"><span aria-hidden>✋</span> {d.highFives === 1 ? 'One high-five' : `${d.highFives} high-fives`} from you</p> : null}
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
    </div>
  );
}
