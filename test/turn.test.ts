import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../web/src/markdown.ts';
import { pickItems, yourTurn } from '../web/src/turn.ts';

test('choices listed in the question become answers', () => {
  const t = yourTurn('I found 5 ways.\n\nWhat matters most to you: fewer hand-offs, happier customers, or least work?');
  assert.equal(t?.question, 'What matters most to you: fewer hand-offs, happier customers, or least work?');
  assert.deepEqual(t?.answers.map((a) => a.label), ['Fewer hand-offs', 'Happier customers', 'Least work']);
});

test('a numbered list of bold options becomes pickable answers', () => {
  const reply = '## Five ways\n\n1. **Ask once before handing off**: cheap.\n2. **Look up refund status first** — biggest win.\n3. **Tighter rule.** Low effort.\n\nWhich one should I plan?';
  const t = yourTurn(reply);
  assert.equal(t?.question, 'Which one should I plan?');
  assert.deepEqual(t?.answers.map((a) => a.say), ['Go with option 1: Ask once before handing off.', 'Go with option 2: Look up refund status first.', 'Go with option 3: Tighter rule.']);
  assert.equal(t?.answers[1].label, '2. Look up refund status first');
});

test('yes/no questions get yes and not yet', () => {
  assert.deepEqual(yourTurn('Tests pass. Want me to open a PR?')?.answers.map((a) => a.label), ['Yes, go ahead', 'Not yet']);
});

test('no question at the end means no turn', () => {
  assert.equal(yourTurn('Why did it fail? Because of a typo. Fixed and pushed.'), null);
  assert.equal(yourTurn('Done.\n\n```js\nif (a?.b) x()\n```'), null);
});

test('a question with nothing to offer still shows, with no answers', () => {
  const t = yourTurn('Here is the plan.\n\nHow far back should I look in the logs?');
  assert.equal(t?.question, 'How far back should I look in the logs?');
  assert.deepEqual(t?.answers, []);
});

test('a closing list of questions: the last one is the turn, the others are counted, none become options', () => {
  const reply = 'A few things first:\n\n1. **What matters most?** Fewer hand-offs or time per hand-off.\n2. **Whole bot, or only the outreach flow?** They differ.\n3. **Should I pull the numbers for A now?** I’d need a cookie, or I could use Metabase instead.';
  const t = yourTurn(reply);
  assert.equal(t?.question, 'Should I pull the numbers for A now?');
  assert.equal(t?.more, 2);
  assert.deepEqual(t?.answers.map((a) => a.label), ['Yes, go ahead', 'Not yet']);
  assert.equal(pickItems(parseMarkdown(reply)[1]), null);
});

test('pickItems needs every item to start with bold', () => {
  assert.deepEqual(pickItems(parseMarkdown('1. **A**: x\n2. **B**')[0]), ['A', 'B']);
  assert.equal(pickItems(parseMarkdown('1. **A**: x\n2. plain')[0]), null);
  assert.equal(pickItems(parseMarkdown('- **A**\n- **B**')[0]), null);
});
