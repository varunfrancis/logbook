import type { StateView, TeamView } from '../../../daemon/types.ts';
import { AgentAvatar, FOREMAN } from '../crew/Avatar.tsx';
import { money } from '../copy.ts';

/*
 * Share cards. They only ever see plain names (or "Project A, B…" when names are hidden):
 * repo names, branches, files and prompts never reach these components.
 */
export type Privacy = { names: boolean };
export const alias = (i: number) => `Project ${String.fromCharCode(65 + (i % 26))}`;
export const REPO_URL = 'github.com/varunfrancis/swarmville';

/** What you pay Anthropic each month. "api" means pay-as-you-go, so there's no flat price to compare against. */
export type Plan = 'pro' | 'max5' | 'max20' | 'api';
export const PLANS: { key: Plan; label: string; usd: number | null }[] = [
  { key: 'pro', label: 'Pro $20', usd: 20 },
  { key: 'max5', label: 'Max $100', usd: 100 },
  { key: 'max20', label: 'Max $200', usd: 200 },
  { key: 'api', label: 'API (pay as you go)', usd: null },
];
const PLAN_NAME: Record<Plan, string> = { pro: 'Claude Pro', max5: 'Claude Max', max20: 'Claude Max', api: 'API' };

function useAlias(state: StateView, privacy: Privacy) {
  const order = [...state.projects].sort((a, b) => b.tokens - a.tokens).map((p) => p.id);
  return (projectId: string | null, name: string | null) => (privacy.names ? name ?? '' : alias(Math.max(0, order.indexOf(projectId ?? ''))));
}

const hours = (ms: number) => { const h = ms / 3600_000; return h >= 10 ? Math.round(h).toLocaleString() : h >= 1 ? h.toFixed(1) : h > 0 ? '<1' : '0'; };
const range = (t: TeamView) => `${new Date(t.from).toLocaleDateString('en', { day: 'numeric', month: 'short' })} – ${new Date(t.to).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Brand() {
  return <div className="brand"><AgentAvatar agent={{ ...FOREMAN, title: 'Pip' }} mood="hello" size={44} /><div><b>swarmville</b><span>{REPO_URL}</span></div></div>;
}

/** The headline people screenshot: you at the top of an org chart, your AI crew underneath. */
export function TeamCard({ state, team, privacy }: { state: StateView; team: TeamView; privacy: Privacy }) {
  const name = useAlias(state, privacy);
  const n = team.members.length;
  const shown = team.members.slice(0, n > 12 ? 11 : 12);
  const rest = team.members.slice(shown.length);
  const owner = state.town.owner || 'Me';
  return (
    <div className="card team">
      <div className="team-kicker">{state.town.name} · Org chart · last {team.days} days</div>
      <h1>1 human.<br /><em>{plural(n, 'AI employee')}.</em></h1>
      <div className="founder">
        <div className="initial">{owner.slice(0, 1).toUpperCase()}</div>
        <div><b>{owner}</b><span>Founder · the only human</span></div>
      </div>
      <div className={`org${shown.length <= 4 ? ' one-row' : ''}`}>
        {n ? shown.map((m) => (
          <div className="emp" key={m.agent.key}>
            <AgentAvatar agent={m.agent} mood={m.delivered ? 'shipped' : 'working'} size={92} />
            <b>{m.agent.name}</b>
            <span>{m.agent.jobTitle}{m.project || !privacy.names ? ` · ${name(m.projectId, m.project)}` : ''}</span>
            <i>{m.delivered ? `${m.delivered} shipped` : `${hours(m.workMs)}h on the job`}</i>
          </div>
        )) : <div className="emp empty"><b>Hiring…</b><span>Your crew shows up here after their first shift.</span></div>}
        {rest.length ? (
          <div className="emp more">
            <div className="stack">{rest.slice(0, 3).map((m) => <AgentAvatar key={m.agent.key} agent={m.agent} size={52} />)}</div>
            <b>+{rest.length} more</b>
            <span>{plural(rest.reduce((s, m) => s + m.delivered, 0), 'thing')} shipped</span>
          </div>
        ) : null}
      </div>
      <div className="team-stats">
        <div><b>{team.totals.delivered.toLocaleString()}</b>things shipped</div>
        <div><b>{hours(team.totals.workMs)}</b>hours of work</div>
        <div><b>{team.totals.peak}</b>working at once</div>
        <div><b>{team.totals.projects}</b>{team.totals.projects === 1 ? 'project' : 'projects'}</div>
      </div>
      <footer><span>{range(team)}</span><Brand /></footer>
    </div>
  );
}

/** A payslip for the crew: what their work would cost at API rates, against what the plan actually cost. */
export function PayrollCard({ state, team, plan }: { state: StateView; team: TeamView; plan: Plan }) {
  const rows = team.members.slice().sort((a, b) => b.costUsd - a.costUsd);
  const top = rows.slice(0, 10), rest = rows.slice(10);
  const gross = team.totals.costUsd;
  const paid = PLANS.find((p) => p.key === plan)?.usd ?? null;
  const paidForPeriod = paid == null ? null : paid * (team.days / 30);
  const multiple = paidForPeriod ? gross / paidForPeriod : null;
  const hrs = team.totals.workMs / 3600_000;
  const owner = state.town.owner || 'Me';
  return (
    <div className="card payroll">
      <div className="slip">
        <div className="slip-head">
          <div><b>Payroll</b><span>{state.town.name} · {range(team)}</span></div>
          <div className="slip-who"><span>Employer</span><b>{owner}</b><span>{plural(rows.length, 'AI employee')}</span></div>
        </div>
        <div className="slip-row slip-th"><span>Employee</span><span>Hours</span><span>Shipped</span><span>Pay</span></div>
        {top.map((m) => (
          <div className="slip-row" key={m.agent.key}>
            <span className="who"><AgentAvatar agent={m.agent} size={46} /><span><b>{m.agent.name}</b><small>{m.agent.jobTitle}</small></span></span>
            <span>{hours(m.workMs)}</span><span>{m.delivered}</span><span>{money(m.costUsd)}</span>
          </div>
        ))}
        {rest.length ? <div className="slip-row"><span className="who"><span><b>Everyone else</b><small>{plural(rest.length, 'more employee')}</small></span></span><span>{hours(rest.reduce((s, m) => s + m.workMs, 0))}</span><span>{rest.reduce((s, m) => s + m.delivered, 0)}</span><span>{money(rest.reduce((s, m) => s + m.costUsd, 0))}</span></div> : null}
        {!rows.length ? <div className="slip-row"><span className="who"><span><b>No shifts yet</b><small>Payroll fills in as your crew works.</small></span></span><span /><span /><span /></div> : null}
        <div className="slip-foot">
          {multiple != null && multiple >= 1.5 ? (
            <div className="stamp"><b>{multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}×</b><span>more work than<br />I paid for</span></div>
          ) : multiple == null && team.totals.delivered ? (
            <div className="stamp"><b>{money(gross / team.totals.delivered)}</b><span>per thing<br />shipped</span></div>
          ) : <span />}
          <div className="slip-total">
            <div><span>Gross payroll<small>their work at API prices</small></span><b>{money(gross)}</b></div>
            {paidForPeriod != null
              ? <div className="paid"><span>What I actually paid<small>{PLAN_NAME[plan]} plan</small></span><b>{money(paidForPeriod)}</b></div>
              : <div className="paid"><span>Hourly rate<small>for the whole team</small></span><b>{hrs >= 0.25 ? `${money(gross / hrs)}/h` : '—'}</b></div>}
          </div>
        </div>
      </div>
      <footer><span>{plural(team.totals.delivered, 'thing')} shipped · {hrs >= 1 ? Math.round(hrs).toLocaleString() : hours(team.totals.workMs)} hours of work</span><Brand /></footer>
    </div>
  );
}
