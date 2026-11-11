import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlow, splitGreeting, visualize, visualWords, type VBlock } from '../daemon/visual.ts';
import { parseMarkdown, plainText } from '../daemon/markdown.ts';

// The reply from the owner's screenshot (an agent answering "can my agents have a wallet?").
const WALLET = `Hi, I'm Iggy. You'll see me at Portfolio Website in Francisco.

Yes. Whether it's a weekend project or a regulated product depends on whose money is in the wallet.

## The key question: whose money?

- **Only your own money, paying for your own agents' work:** easy. It's an internal budget layer over a payment account you already control. No license needed.
- **Other people top it up and their agents spend it:** in India that's a stored-value wallet, which counts as a PPI (prepaid payment instrument) under RBI rules and needs a license. You'd partner with a licensed PPI issuer or card issuer instead of holding the money yourself.

The rest of this assumes the first case.

## How it fits together

\`\`\`
You top up ──▸ Funding account (real money)
                 │
           Wallet service (your code)
           - ledger: balance per agent
           - policies: per-txn cap, daily cap, allowed payees
           - approval: auto under ₹X, ping you on Slack above
                 │
          "pay" tool (MCP server / function)
                 │
Agents ──▸ request payment ──▸ policy check ──▸ execute on a payment rail
\`\`\`

The agent never holds credentials. It can only call \`pay(amount, payee, reason)\`, and your service decides whether the payment goes through.

## Payment rails (where the money actually moves)

| What the agents pay for | Rail |
|---|---|
| Vendors and people in India (bank/UPI) | **RazorpayX Payouts**: you top up a balance and pay out by API. This is already "top up and pay automatically". |
| SaaS, APIs, online checkouts | **Virtual cards with hard limits**, one per agent (Stripe Issuing outside India, or an Indian corporate card provider with virtual cards) |
| Other agents or pay-per-call APIs | Agent-native rails such as Coinbase's x402 and agent wallets (stablecoin-based, so check the compliance side) |
| Merchants with agentic checkout | Visa, Mastercard and Stripe all have agent-payment programs. UPI has also been piloting agentic payments. These are still early, so check what's actually live before building on one. |

## Guardrails worth having from day one

- Hard caps that the rail enforces (card or account limits) as well as caps in your code, so a bug can't drain the funding account.
- An idempotency key on every payment, so a retry loop doesn't pay twice.
- An append-only ledger that records the agent, prompt context and reason for each spend.
- A kill switch per agent.`;

const kinds = (bs: VBlock[]) => bs.map((b) => (b.v === 'md' ? `md:${b.b.t}` : b.v));
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}₹$%]+/gu) ?? []);

test('the wallet reply becomes answer, fork, flow, tiles and checklist', () => {
  const v = visualize(WALLET, { long: true });
  assert.equal(v.greeting, "Hi, I'm Iggy. You'll see me at Portfolio Website in Francisco.");
  assert.deepEqual(kinds(v.blocks), ['answer', 'md:h', 'fork', 'md:p', 'md:h', 'flow', 'md:p', 'md:h', 'tiles', 'md:h', 'checklist']);
  const a = v.blocks[0] as Extract<VBlock, { v: 'answer' }>;
  assert.equal(a.word, 'Yes');
  assert.match(plainText(a.c), /^Whether it's a weekend project/);
  const fork = v.blocks[2] as Extract<VBlock, { v: 'fork' }>;
  assert.equal(fork.here, 0);
  assert.equal(plainText(fork.cases[1].title), 'Other people top it up and their agents spend it');
  const tiles = v.blocks[8] as Extract<VBlock, { v: 'tiles' }>;
  assert.equal(tiles.tiles.length, 4);
  assert.equal(plainText(tiles.tiles[0].sub!), 'RazorpayX Payouts');
  const check = v.blocks[10] as Extract<VBlock, { v: 'checklist' }>;
  assert.equal(plainText(check.items[1].title), 'An idempotency key on every payment');
  assert.equal(plainText(check.items[3].title), 'A kill switch per agent.');
  assert.equal(v.drawn, 4);
});

test('no word of the reply goes missing', () => {
  const v = visualize(WALLET, { long: true });
  const shown = words(visualWords(v));
  const missing = [...words(WALLET)].filter((w) => !shown.has(w));
  assert.deepEqual(missing, []);
});

test('the ASCII diagram becomes a flow, notes attached to their box', () => {
  const code = parseMarkdown(WALLET).find((b) => b.t === 'code') as { v: string };
  const f = parseFlow(code.v)!;
  assert.deepEqual(f.nodes.map((n) => n.label), ['You top up', 'Funding account', 'Wallet service', '"pay" tool', 'Agents', 'request payment', 'policy check', 'execute on a payment rail']);
  assert.equal(f.nodes[1].sub, 'real money');
  assert.equal(f.nodes[2].notes.length, 3);
  assert.deepEqual(f.rows, [[0, 1], [2], [3], [4, 5, 6, 7]]);
  assert.equal(f.edges.length, 7);
});

test('real code with arrows stays code', () => {
  assert.equal(parseFlow('const f = (a) => a + 1;\nfoo -> bar\nbaz -> qux'), null);
  const v = visualize('```ts\nconst a = b -> c;\n```');
  assert.deepEqual(kinds(v.blocks), ['md:code']);
});

test('greeting: only the hook-style intro line is split off', () => {
  assert.deepEqual(splitGreeting("Hi, I'm Tiki Jr. You'll see me at Agent Logbook in Francisco.\n\nThe fix is in."), { greeting: "Hi, I'm Tiki Jr. You'll see me at Agent Logbook in Francisco.", rest: 'The fix is in.' });
  assert.equal(splitGreeting("Hi, I'm Pip. You'll see me at Shop in Town. The bug was in the parser.").rest, 'The bug was in the parser.');
  assert.equal(splitGreeting('Hi, I looked at the logs.').greeting, null);
  // the answer card is never the greeting
  const v = visualize(`Hi, I'm Pip. You'll see me at Shop in Town.\n\n${'The parser drops blank lines. '.repeat(25)}\n\nMore.`, { long: true });
  assert.match(plainText((v.blocks[0] as any).c), /^The parser drops/);
});

test('numbered options stay pickable; other numbered lists become steps', () => {
  const opts = 'Pick one:\n\n1. **Fast**: ship today\n2. **Safe**: ship Friday';
  assert.deepEqual(kinds(visualize(opts, { pickable: true }).blocks), ['md:p', 'md:list']);
  const steps = visualize('1. Install it\n2. Run the tests\n3. Open a PR');
  assert.deepEqual(kinds(steps.blocks), ['steps']);
});

test('bold-led bullets become cards; short lists stay lists', () => {
  assert.deepEqual(kinds(visualize('- **Speed**: fast\n- **Cost**: cheap\n- **Risk**: low').blocks), ['cards']);
  assert.deepEqual(kinds(visualize('- one\n- two\n- three').blocks), ['md:list']);
});

test('files changed and numbers', () => {
  const v = visualize('- `daemon/visual.ts`: the rules\n- `web/src/views/Markdown.tsx`: the toggle');
  assert.deepEqual(kinds(v.blocks), ['change']);
  assert.equal((v.blocks[0] as any).files[1].path, 'web/src/views/Markdown.tsx');
  const n = visualize('- Tests: 214 passing\n- Bundle: 412 KB, down from 480');
  assert.deepEqual(kinds(n.blocks), ['numbers']);
  assert.deepEqual((n.blocks[0] as any).items[1], { label: 'Bundle', value: '412 KB', note: 'down from 480' });
});

test('a comparison table becomes compare; a results table stays a table', () => {
  const cmp = visualize('| | Postgres | SQLite |\n|---|---|---|\n| Setup | a server | a file |\n| Scale | big | small |');
  assert.deepEqual(kinds(cmp.blocks), ['compare']);
  assert.equal(plainText((cmp.blocks[0] as any).options[1].name), 'SQLite');
  const nums = visualize('| Run | ms |\n|---|---|\n| a | 12 |\n| b | 15 |');
  assert.deepEqual(kinds(nums.blocks), ['md:table']);
});

test('short plain replies draw nothing', () => {
  const v = visualize('Done. The tests pass.');
  assert.equal(v.drawn, 0);
  assert.deepEqual(kinds(v.blocks), ['md:p']);
});
