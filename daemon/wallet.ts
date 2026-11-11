import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db, Row } from './db.ts';
import type { StateView, WalletPayment, WalletView } from './types.ts';

/**
 * swarmville-wallet: an optional, separate app that gives your agents a budget and a `pay` tool. When it runs on this
 * Mac, Swarmville shows its budgets and payments, and a payment waiting for your OK raises the hand of the agent that
 * asked. The wallet keeps all its own rules; Swarmville only reads its summary and passes on your approve / decline.
 *
 * It's found through the files it writes: <wallet home>/server.json (where it listens) and owner.key (sent with every
 * request). No wallet, nothing changes.
 */

const HOME = process.env.SWARMVILLE_WALLET_HOME || path.join(os.homedir(), '.swarmville-wallet');

type Raw = {
  rail: string;
  agents: { id: string; balance: number; spentToday: number; dailyCap: number; perTxnCap: number; autoApproveUnder: number; frozen: boolean }[];
  pending: RawPayment[];
  recent: RawPayment[];
};
type RawPayment = Omit<WalletPayment, 'sessionId' | 'agent' | 'at'> & { createdAt: string };

let latest: Raw | null = null;
let latestJson = '';

function conn(): { base: string; key: string } | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(HOME, 'server.json'), 'utf8'));
    const key = fs.readFileSync(path.join(HOME, 'owner.key'), 'utf8').trim();
    const port = Number(info?.port);
    if (!key || !Number.isInteger(port)) return null;
    return { base: `http://127.0.0.1:${port}`, key };
  } catch { return null; }
}

/** Reads the wallet's summary. True when what Swarmville shows changed (it appeared, went away, or moved). */
export async function pollWallet(): Promise<boolean> {
  const c = conn();
  let next: Raw | null = null;
  if (c) {
    try {
      const r = await fetch(`${c.base}/api/summary`, { headers: { authorization: `Bearer ${c.key}` }, signal: AbortSignal.timeout(2000) });
      if (r.ok) next = await r.json() as Raw;
    } catch {}
  }
  const json = next ? JSON.stringify(next) : '';
  if (json === latestJson) return false;
  latest = next; latestJson = json;
  return true;
}

/** Your approve / decline / freeze, passed to the wallet, which checks it like any other request. */
export async function walletAction(kind: 'approve' | 'decline' | 'freeze' | 'unfreeze', id: string): Promise<{ ok: boolean; status?: string; message?: string }> {
  const c = conn();
  if (!c) return { ok: false, message: 'The wallet isn’t running.' };
  if (!/^[\w-]{1,64}$/.test(id)) return { ok: false, message: 'Unknown payment.' };
  const url = kind === 'approve' ? `/api/payments/${id}/approve` : kind === 'decline' ? `/api/payments/${id}/reject`
    : `/api/agents/${id}/${kind}`;
  try {
    const r = await fetch(c.base + url, {
      method: 'POST', headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(kind === 'decline' ? { reason: 'Declined in Swarmville' } : {}), signal: AbortSignal.timeout(30_000),
    });
    const out = await r.json().catch(() => ({})) as any;
    return r.ok ? { ok: true, status: out.status } : { ok: false, message: out.message ?? 'The wallet said no.' };
  } catch {
    return { ok: false, message: 'Couldn’t reach the wallet.' };
  }
}

const PAY_TOOL = /^mcp__.+__pay$/;

/**
 * An agent just called the wallet's `pay` tool: remember which session the payment came from, so its hand can go up
 * when it needs you. Returns the payment id it saw, if any.
 */
export function notePayment(db: Db, p: any, now = Date.now()): string | null {
  if (p?.hook_event_name !== 'PostToolUse' || !PAY_TOOL.test(String(p.tool_name ?? '')) || typeof p.session_id !== 'string') return null;
  const m = JSON.stringify(p.tool_response ?? '').match(/payment_id[\\"\s:]+(pay_[\w-]{6,64})/);
  if (!m) return null;
  db.prepare('INSERT OR IGNORE INTO wallet_payments(payment_id, session_id, at) VALUES(?, ?, ?)').run(m[1], p.session_id, now);
  return m[1];
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const payLine = (pay: { amount: number; payeeName: string }) => `Wants to pay ${inr(pay.amount)} to ${pay.payeeName}`;

/**
 * Adds the wallet to the town: `state.wallet`, and a raised hand on every agent with a payment waiting for you
 * (the oldest one first, like the terminal). Agents that already clocked out don't get a hand; their payments wait
 * in the Wallet panel instead.
 */
export function applyWallet(db: Db, state: StateView, raw: Raw | null = latest): void {
  if (!raw) { state.wallet = null; return; }
  const ids = [...raw.pending, ...raw.recent].map((p) => p.id);
  const owners = new Map<string, string>();
  if (ids.length) {
    const rows = db.prepare(`SELECT payment_id, session_id FROM wallet_payments WHERE payment_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[];
    for (const r of rows) owners.set(r.payment_id, r.session_id);
  }
  const sessions = new Map(state.sessions.map((s) => [s.id, s]));
  const view = (p: RawPayment): WalletPayment => {
    const { createdAt, ...rest } = p;
    const sid = owners.get(p.id) ?? null;
    return { ...rest, at: Date.parse(createdAt) || 0, sessionId: sid, agent: sid ? sessions.get(sid)?.agent ?? null : null };
  };
  const pending = raw.pending.map(view);
  const wallet: WalletView = {
    rail: raw.rail,
    agents: raw.agents,
    pending,
    recent: raw.recent.map(view),
    balance: raw.agents.reduce((n, a) => n + a.balance, 0),
    spentToday: raw.agents.reduce((n, a) => n + a.spentToday, 0),
  };
  state.wallet = wallet;

  for (const pay of pending) {
    const s = pay.sessionId ? sessions.get(pay.sessionId) : undefined;
    if (!s || s.status === 'ended' || s.payment) continue;
    s.payment = pay;
    if (s.status !== 'needs_input') {
      s.status = 'needs_input';
      s.needsMessage = payLine(pay);
      s.handKind = null;
      state.totals.needs++;
      if (s.projectId) {
        const proj = state.projects.find((x) => x.id === s.projectId);
        if (proj && (proj.state === 'site' || proj.state === 'construction')) proj.state = 'needs';
      }
    }
  }
}
