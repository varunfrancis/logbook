import type { StateView } from '../../../daemon/types.ts';
import { AgentAvatar } from '../crew/Avatar.tsx';
import { money, PLAN_NOTE, useCostView } from '../copy.ts';

/** Today's cost, split by project and then by the agents who worked on it. On the plan, it's simply $0. */
export function CostPanel({ state, onClose, openProject, openAgent }: { state: StateView; onClose: () => void; openProject: (id: string) => void; openAgent: (id: string) => void }) {
  const view = useCostView();
  const rows = state.costBreakdown ?? [];
  const total = state.totals.costToday;
  if (view === 'plan') return (
    <aside className="panel cost-panel" aria-label="Today's cost">
      <header className="panel-head">
        <div><h2>Today's cost: $0</h2></div>
        <button className="ghost close" onClick={onClose} aria-label="Close cost breakdown">×</button>
      </header>
      <p className="muted">{PLAN_NOTE}</p>
    </aside>
  );
  const est = (e: boolean) => (e ? <span className="muted" title="Includes shifts still running, whose cost is estimated from tokens"> est.</span> : null);
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '');

  return (
    <aside className="panel cost-panel" aria-label="Today's cost by project and agent">
      <header className="panel-head">
        <div>
          <h2>Today's cost: {money(total)}</h2>
          <div className="panel-sub">At API prices, by project, then by agent. Biggest first.</div>
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close cost breakdown">×</button>
      </header>
      {!rows.length ? <p className="muted">Nothing spent yet today.</p> : (
        <ul className="cost-list">
          {rows.map((p) => (
            <li key={p.projectId}>
              <button className="cost-row cost-project" onClick={() => openProject(p.projectId)} title={`Open ${p.name}`}>
                <b>{p.name}</b><span className="muted num">{pct(p.usd)}</span><span className="num">{money(p.usd)}{est(p.estimated)}</span>
              </button>
              <ul>
                {p.agents.map((a) => (
                  <li key={a.agent.key}>
                    <button className="cost-row cost-agent" onClick={() => openAgent(a.sessionId)} title={`Open ${a.agent.title}`}>
                      <AgentAvatar agent={a.agent} size={22} />
                      <span className="cost-name">{a.agent.title}{a.shifts > 1 ? <span className="muted"> · {a.shifts} shifts</span> : null}</span>
                      <span className="num">{money(a.usd)}{est(a.estimated)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
