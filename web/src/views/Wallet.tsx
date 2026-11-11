import { useEffect, useRef, useState } from 'react';
import type { SessionView, StateView, WalletPayment, WalletView } from '../../../daemon/types.ts';
import { AgentAvatar } from '../crew/Avatar.tsx';
import { inr, ago } from '../format.ts';
import { post, useNow } from '../useSwarmville.ts';

/*
 * swarmville-wallet in the town. The wallet is a separate app that holds your agents' budgets and its own rules;
 * Swarmville shows what it reports and passes on your approve / decline / freeze.
 */

const STATUS: Record<WalletPayment['status'], string> = {
  pending_approval: 'Waiting for you', approved: 'Sending', processing: 'Sending', paid: 'Paid', failed: 'Failed', rejected: 'Declined',
};

/** "Pip · research-bot", or just the wallet's name for an agent Swarmville didn't see ask. */
const who = (p: WalletPayment) => (p.agent ? `${p.agent.name} · ${p.agentId}` : p.agentId);

function useDecide(p: WalletPayment, onDone?: (msg: string) => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (action: 'approve' | 'decline') => {
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await post(`/api/wallet/${action}/${encodeURIComponent(p.id)}`);
    setBusy(false);
    if (!r.ok) { setErr(r.message ?? 'The wallet didn’t take that.'); return; }
    const m = action === 'decline' ? `Declined. ${inr(p.amount)} is back in ${p.agentId}’s budget.`
      : r.status === 'paid' ? `Paid ${inr(p.amount)} to ${p.payeeName}.`
      : r.status === 'failed' ? `The payment failed. ${inr(p.amount)} is back in ${p.agentId}’s budget.`
      : `Approved. Sending ${inr(p.amount)} to ${p.payeeName}.`;
    setMsg(m); onDone?.(m);
  };
  return { busy, msg, err, decide };
}

function TestMode({ wallet }: { wallet: WalletView | null | undefined }) {
  return wallet?.rail === 'mock' ? <span className="wallet-test" title="The wallet's mock rail: payments are recorded, no real money moves">Test mode</span> : null;
}

/** A raised hand that's a payment: what they want to pay, who to, why, and how much budget it leaves. */
export function PaymentAsk({ s, wallet, focus = true, onDone }: { s: SessionView; wallet?: WalletView | null; focus?: boolean; onDone?: (msg: string) => void }) {
  const p = s.payment!;
  const { busy, msg, err, decide } = useDecide(p, onDone);
  const approve = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focus) approve.current?.focus(); }, []);
  const budget = wallet?.agents.find((a) => a.id === p.agentId);
  if (msg && !onDone) return <p className="ask-done" role="status">{msg}</p>;
  return (
    <>
      <div className="ask-body">
        <p className="ask-title">Wants to pay <b className="wallet-amt">{inr(p.amount)}</b> to <b>{p.payeeName}</b> <TestMode wallet={wallet} /></p>
        <p className="ask-detail wallet-reason">“{p.reason}”</p>
        {budget ? (
          <p className="wallet-note">
            From <b>{p.agentId}</b>’s budget: {inr(budget.balance)} left · {inr(budget.spentToday)} of {inr(budget.dailyCap)} used today.
          </p>
        ) : null}
      </div>
      <div className="ask-actions">
        <button ref={approve} className="btn approve" onClick={() => decide('approve')} disabled={busy}>Approve payment</button>
        <button className="ghost deny" onClick={() => decide('decline')} disabled={busy}>Decline</button>
      </div>
      {err ? <p className="ask-err" role="alert">{err}</p> : null}
    </>
  );
}

function PendingRow({ p, openAgent }: { p: WalletPayment; openAgent: (id: string) => void }) {
  const { busy, msg, err, decide } = useDecide(p);
  return (
    <li className="wallet-due">
      <div className="wallet-due-head">
        {p.agent ? <button className="wallet-face" onClick={() => openAgent(p.sessionId!)} title={`Open ${p.agent.title}`}><AgentAvatar agent={p.agent} mood="needs" size={30} /></button>
          : <span className="wallet-coin" aria-hidden="true">₹</span>}
        <div className="wallet-due-text">
          <span><b>{who(p)}</b> wants to pay <b className="wallet-amt">{inr(p.amount)}</b> to <b>{p.payeeName}</b></span>
          <span className="muted">{p.reason}</span>
        </div>
      </div>
      {msg ? <p className="wallet-msg" role="status">{msg}</p> : (
        <div className="wallet-due-actions">
          <button className="btn approve small" onClick={() => decide('approve')} disabled={busy}>Approve</button>
          <button className="ghost small deny" onClick={() => decide('decline')} disabled={busy}>Decline</button>
          {err ? <span className="ask-err" role="alert">{err}</span> : null}
        </div>
      )}
    </li>
  );
}

function Budget({ a }: { a: WalletView['agents'][number] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const used = a.dailyCap > 0 ? Math.min(1, a.spentToday / a.dailyCap) : 0;
  const toggle = async () => {
    setBusy(true); setErr(null);
    const r = await post(`/api/wallet/${a.frozen ? 'unfreeze' : 'freeze'}/${encodeURIComponent(a.id)}`);
    setBusy(false);
    if (!r.ok) setErr(r.message ?? 'The wallet didn’t take that.');
  };
  return (
    <li className={`wallet-budget${a.frozen ? ' frozen' : ''}`}>
      <div className="wallet-budget-head">
        <b className="wallet-name">{a.id}</b>
        {a.frozen ? <span className="wallet-frozen">Frozen</span> : null}
        <span className="num wallet-left">{inr(a.balance)} left</span>
      </div>
      <div className="wallet-meter" role="meter" aria-valuemin={0} aria-valuemax={a.dailyCap} aria-valuenow={a.spentToday} aria-label={`${a.id}: spent today`}>
        <i style={{ width: `${used * 100}%` }} className={used >= 0.9 ? 'hot' : ''} />
      </div>
      <div className="wallet-budget-foot">
        <span className="muted">{inr(a.spentToday)} of {inr(a.dailyCap)} today · up to {inr(a.perTxnCap)} a payment · asks you from {inr(a.autoApproveUnder)}</span>
        <button className={`ghost small${a.frozen ? '' : ' risky'}`} onClick={toggle} disabled={busy}
          title={a.frozen ? 'Let this agent pay again' : 'Stop this agent paying anyone until you unfreeze it'}>{a.frozen ? 'Unfreeze' : 'Freeze'}</button>
      </div>
      {err ? <p className="ask-err" role="alert">{err}</p> : null}
    </li>
  );
}

/** Every budget, what's waiting for you, and the latest payments. Opened from the top bar. */
export function WalletPanel({ state, onClose, openAgent }: { state: StateView; onClose: () => void; openAgent: (id: string) => void }) {
  const now = useNow(30000);
  const w = state.wallet;
  if (!w) return (
    <aside className="panel wallet-panel" aria-label="Wallet">
      <header className="panel-head"><div><h2>Wallet</h2></div><button className="ghost close" onClick={onClose} aria-label="Close wallet">×</button></header>
      <p className="muted">The wallet isn’t running on this Mac right now.</p>
    </aside>
  );
  const done = w.recent.filter((p) => p.status !== 'pending_approval');
  return (
    <aside className="panel wallet-panel" aria-label="Wallet">
      <header className="panel-head">
        <div>
          <h2>Wallet: {inr(w.balance)} left</h2>
          <div className="panel-sub">
            {w.agents.length} {w.agents.length === 1 ? 'agent' : 'agents'} · {inr(w.spentToday)} spent today <TestMode wallet={w} />
          </div>
        </div>
        <button className="ghost close" onClick={onClose} aria-label="Close wallet">×</button>
      </header>

      {w.pending.length ? (
        <section>
          <h3>Waiting for you</h3>
          <ul className="wallet-list">{w.pending.map((p) => <PendingRow key={p.id} p={p} openAgent={openAgent} />)}</ul>
        </section>
      ) : null}

      <section>
        <h3>Budgets</h3>
        {w.agents.length ? <ul className="wallet-list">{w.agents.map((a) => <Budget key={a.id} a={a} />)}</ul>
          : <p className="muted">No agents yet. Add one with <code>npm run wallet -- agent add</code>.</p>}
      </section>

      <section>
        <h3>Recent payments</h3>
        {done.length ? (
          <ul className="wallet-history">
            {done.map((p) => (
              <li key={p.id}>
                {p.agent ? <button className="wallet-face" onClick={() => openAgent(p.sessionId!)} title={`Open ${p.agent.title}`}><AgentAvatar agent={p.agent} size={22} /></button>
                  : <span className="wallet-coin sm" aria-hidden="true">₹</span>}
                <span className="wallet-what">
                  <b>{p.payeeName}</b>
                  <span className="muted">{p.reason}</span>
                  <span className="wallet-meta">{who(p)} · {ago(p.at, now)}{p.error && p.status === 'failed' ? ` · ${p.error}` : ''}</span>
                </span>
                <span className="wallet-right">
                  <span className="num">{inr(p.amount)}</span>
                  <span className={`wallet-st st-${p.status}`}>{STATUS[p.status]}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No payments yet.</p>}
      </section>

      <p className="wallet-foot">Budgets and rules live in swarmville-wallet. Swarmville shows them and passes on your answers.</p>
    </aside>
  );
}
