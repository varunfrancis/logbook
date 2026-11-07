import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar, moodFor } from '../crew/Avatar.tsx';
import { bricks, clock, mins, money, plainAction, STAMP_NOTE, STATUS, useVoice } from '../copy.ts';
import { ago, compact, duration, tildify } from '../format.ts';
import { GoTo, PrChip, Stamp } from '../components.tsx';
import { useAgent, useNow } from '../useLogbook.ts';

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

export function AgentPanel({ id, state, onClose, openProject }: { id: string; state: StateView; onClose: () => void; openProject: (id: string) => void }) {
  const voice = useVoice();
  const now = useNow(15000);
  const d = useAgent(id, state.generatedAt);
  const s = d?.session ?? state.sessions.find((x) => x.id === id);
  if (!s) return <aside className="panel"><button className="ghost close" onClick={onClose} aria-label="Close">×</button><p className="muted">Loading…</p></aside>;
  const a = s.agent;
  const project = d?.project ?? state.projects.find((p) => p.id === s.projectId);
  const moments = (d?.moments ?? []).filter((m) => MOMENT[m.kind]).slice(-14);
  const started = s.startedAt ? clock(s.startedAt) : '';
  const ended = s.status === 'ended' && s.endedAt ? clock(s.endedAt) : 'now';

  return (
    <aside className="panel agent" aria-label={`${a.title} profile`}>
      <header className="agent-head">
        <AgentAvatar agent={a} mood={moodFor(s)} size={104} />
        <div className="agent-id">
          <h2>{a.title}</h2>
          <div className="sub">{STATUS[voice][s.status]} on <button className="link" onClick={() => project && openProject(project.id)}>{project?.name ?? 'a project'}</button> · {started}–{ended}</div>
          {d ? <div className="chips-sm">{a.role === 'resident' ? <span>Resident of {project?.name}</span> : a.role === 'helper' ? <span>Helping out on {project?.name}</span> : <span>Own workbench{voice === 'technical' && (s.worktree || s.branch) ? `: ${s.worktree ?? s.branch}` : ''}</span>}<span>{d.career.shifts} shift{d.career.shifts === 1 ? '' : 's'} · {d.career.shipped} shipped</span>{d.career.usualProject && a.role === 'workbench' ? <span>Usually on {d.career.usualProject}</span> : null}</div> : null}
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close profile">×</button>
      </header>
      <div className="row"><GoTo s={s} primary />{s.prUrl ? <PrChip url={s.prUrl} state={s.prState} /> : null}</div>

      {s.status === 'needs_input' ? <div className="callout bad"><b>{a.name} raised a hand.</b> {s.needsMessage}</div> : null}
      {s.stuck ? <div className="callout bad"><b>Stuck.</b> Hit the same problem {s.stuck.count} times{voice === 'technical' ? `: ${s.stuck.problem}` : '.'}</div> : null}
      {s.collision ? <div className="callout warn"><b>Bumping into {s.collision.with}.</b> Both are changing {s.collision.file}.</div> : null}
      {s.status === 'running' ? <div className="callout"><b>Right now:</b> {plainAction(s.action, voice)}</div> : null}
      {s.stamp ? <div className="stamp-row"><Stamp stamp={s.stamp} big /><span className="sub">{STAMP_NOTE[s.stamp]}</span></div> : null}

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

      {s.outcome && s.status === 'ended' ? (
        <section><h3>Its last words</h3><details><summary>{s.outcome.split('\n').find((l) => l.trim())?.slice(0, 160)}</summary><p className="outcome-full">{s.outcome}</p></details></section>
      ) : null}

      <section>
        <h3>The shift in numbers</h3>
        <dl className="stats">
          <div><dt>{voice === 'plain' ? 'Bricks laid' : 'Tokens'}</dt><dd>{voice === 'plain' ? s.bricks.toLocaleString() : compact(s.tokens)}</dd></div>
          <div><dt>Cost{s.costEstimated ? ' (est.)' : ''}</dt><dd>{money(s.costUsd)}</dd></div>
          <div><dt>Waited on you</dt><dd className={d?.waitedMs ? 'hot' : ''}>{d ? mins(d.waitedMs) : '…'}</dd></div>
          <div><dt>{voice === 'plain' ? 'Files changed' : 'Lines'}</dt><dd>{voice === 'plain' ? s.filesChanged : `+${s.linesAdded ?? 0} −${s.linesRemoved ?? 0}`}</dd></div>
        </dl>
        {voice === 'technical' ? <p className="path">{tildify(s.cwd)} · {s.branch ?? '—'} · {s.model ?? ''} · {compact(s.tokensBreakdown.cacheRead)} cache reads · session {s.id}</p> : null}
        <p className="sub">{s.status === 'ended' ? `Clocked out ${ago(s.endedAt, now)} after ${duration(s.startedAt, s.endedAt)}.` : `On shift for ${duration(s.startedAt, now)}.`} {voice === 'plain' ? `${bricks(s.bricks)} ≈ ${compact(s.tokens)} tokens.` : ''}</p>
      </section>
    </aside>
  );
}
