import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../daemon/db.ts';
import { applyWallet, notePayment, payLine } from '../daemon/wallet.ts';
import { inr } from '../web/src/format.ts';
import type { SessionView, StateView } from '../daemon/types.ts';

const agent = { key: 'k', name: 'Pip', title: 'Pip the Plumber', job: 'plumber', jobTitle: 'Plumber', shape: 'pebble', color: '#0aa', accessory: '', role: 'resident' } as const;
const session = (id: string, o: Partial<SessionView> = {}) => ({ id, projectId: 'p1', agent, status: 'running', needsMessage: null, handKind: null, ask: null, ...o }) as unknown as SessionView;
const stateWith = (sessions: SessionView[]) => ({ sessions, projects: [{ id: 'p1', state: 'site' }], totals: { needs: 0 } }) as unknown as StateView;

// What Claude Code sends after an MCP tool call: the tool's text content, with the wallet's JSON inside it.
const payHook = (sid: string, payId: string, tool = 'mcp__wallet__pay') => ({
  hook_event_name: 'PostToolUse', session_id: sid, tool_name: tool,
  tool_response: [{ type: 'text', text: JSON.stringify({ payment_id: payId, status: 'pending_approval', amount: '₹450.00' }, null, 2) }],
});

const pending = (id: string, o: object = {}) => ({
  id, agentId: 'research-bot', payeeId: 'serp-api', payeeName: 'SerpData Labs', amount: 45_000, reason: 'November bulk query pack',
  status: 'pending_approval', error: null, originCwd: null, createdAt: '2026-11-10T15:00:00.000Z', updatedAt: '2026-11-10T15:00:00.000Z', ...o,
});
const raw = (p: any[]) => ({
  rail: 'mock',
  agents: [{ id: 'research-bot', balance: 90_100, spentToday: 59_900, dailyCap: 100_000, perTxnCap: 50_000, autoApproveUnder: 20_000, frozen: false }],
  pending: p, recent: p,
}) as any;

test('wallet: a pay call is tied to the session that made it, whatever the MCP server is called', () => {
  const db = openDb(':memory:');
  assert.equal(notePayment(db, payHook('s1', 'pay_C595tC1wG5ym')), 'pay_C595tC1wG5ym');
  assert.equal(notePayment(db, payHook('s2', 'pay_KpXJkd4U8zxz', 'mcp__swarmville-wallet__pay')), 'pay_KpXJkd4U8zxz');
  assert.equal(notePayment(db, payHook('s1', 'pay_C595tC1wG5ym', 'mcp__wallet__payment_status')), null);
  assert.equal(notePayment(db, { ...payHook('s1', 'x'), tool_response: 'Error: Over per-payment cap' }), null);
  assert.equal(notePayment(db, { ...payHook('s1', 'pay_C595tC1wG5ym'), hook_event_name: 'PreToolUse' }), null);
});

test('wallet: a payment waiting for you raises the asking agent’s hand', () => {
  const db = openDb(':memory:');
  notePayment(db, payHook('s1', 'pay_aaaaaaaa'));
  const st = stateWith([session('s1'), session('s2')]);
  applyWallet(db, st, raw([pending('pay_aaaaaaaa'), pending('pay_bbbbbbbb')]));
  const [s1, s2] = st.sessions;
  assert.equal(s1.status, 'needs_input');
  assert.equal(s1.needsMessage, 'Wants to pay ₹450 to SerpData Labs');
  assert.equal(s1.payment?.id, 'pay_aaaaaaaa');
  assert.equal(s2.status, 'running'); // the other payment came from outside the town: it waits in the Wallet panel
  assert.equal(st.totals.needs, 1);
  assert.equal(st.projects[0].state, 'needs');
  assert.equal(st.wallet?.pending[0].agent?.name, 'Pip');
  assert.equal(st.wallet?.pending[1].sessionId, null);
  assert.equal(st.wallet?.balance, 90_100);
});

test('wallet: a clocked-out agent gets no hand; no wallet, no change', () => {
  const db = openDb(':memory:');
  notePayment(db, payHook('s1', 'pay_aaaaaaaa'));
  const st = stateWith([session('s1', { status: 'ended' })]);
  applyWallet(db, st, raw([pending('pay_aaaaaaaa')]));
  assert.equal(st.sessions[0].status, 'ended');
  assert.equal(st.sessions[0].payment, undefined);
  const none = stateWith([session('s1')]);
  applyWallet(db, none, null);
  assert.equal(none.wallet, null);
  assert.equal(none.sessions[0].status, 'running');
});

test('wallet: rupees', () => {
  assert.equal(inr(45_000), '₹450');
  assert.equal(inr(14_950), '₹149.50');
  assert.equal(inr(15_000_000), '₹1,50,000');
  assert.equal(payLine({ amount: 9, payeeName: 'X' }), 'Wants to pay ₹0.09 to X');
});
