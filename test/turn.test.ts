import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../daemon/markdown.ts';
import { askedYou, pickItems, yourTurn } from '../daemon/turn.ts';

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

test('a turn that ends by asking you something raises a hand, with the question in plain words', () => {
  // a "needs input:" line is a sure sign, even with no question mark, and wins over the report above it
  assert.equal(askedYou('The café branch builds and its tests pass.\n\nneeds input: Should I merge the café branch into `main` and rebuild so it shows up on `localhost:7777`?'),
    'Should I merge the café branch into main and rebuild so it shows up on localhost:7777?');
  assert.equal(askedYou('Three mockups are in the artifact.\n\nneeds input: A, B or C? If A, keep the pinned strip at the top, or only put a red dot on the project?'),
    'A, B or C? If A, keep the pinned strip at the top, or only put a red dot on the project?');
  assert.equal(askedYou('**needs input:** paste a fresh `CONTROLHUB_SESSION` cookie so I can pull today’s run.'), 'Paste a fresh CONTROLHUB_SESSION cookie so I can pull today’s run.');
  assert.equal(askedYou('Most of it is set up.\n\nneeds input:\nPaste your cookie from a logged-in Control Hub tab. I won’t save it.'), 'Paste your cookie from a logged-in Control Hub tab. I won’t save it.');
  assert.equal(askedYou('needs input: three things:\n1. X API keys from console.x.com\n2. $5 of credit'), 'Three things: X API keys from console.x.com $5 of credit');
  // questions that need your decision
  assert.equal(askedYou('P3 is done: the provider layer, tests and the fixtures.\n\nShall I commit P3, or wait until the bake-off results are in?'), 'Shall I commit P3, or wait until the bake-off results are in?');
  assert.equal(askedYou('Before I wire up Go to Pip, which terminal do you mainly use (iTerm2, Terminal.app, tmux, or VS Code/Cursor)?'),
    'Before I wire up Go to Pip, which terminal do you mainly use (iTerm2, Terminal.app, tmux, or VS Code/Cursor)?');
  // offers at the end of a report count too: they're waiting on your answer
  assert.equal(askedYou('You’ve used $7.61 of your $20 credit, so you’re fine this cycle.\n\nWant me to remove the og-video and landing-standing deployments?'), 'Want me to remove the og-video and landing-standing deployments?');
  assert.equal(askedYou('result: the brief is sent to Nitin.\n\nWant me to send him a short follow-up with those two points?'), 'Want me to send him a short follow-up with those two points?');
  // saying they're waiting on you, or questions above "Once you've answered these"
  assert.equal(askedYou('The code is pushed on `worktree-guided-tour`.\n\nNothing is merged or deployed yet, and I’m waiting for your approval before I do either.'),
    'Nothing is merged or deployed yet, and I’m waiting for your approval before I do either.');
  assert.equal(askedYou('A few things first:\n\n1. **Which database?** Postgres or SQLite.\n2. **Claude Code only, or other agents from day one?** I’d start with Claude Code.\n\nOnce you’ve answered these, I can scaffold v0 here.'),
    'Claude Code only, or other agents from day one?');
});

test('a plain report is a coffee break, not a raised hand', () => {
  assert.equal(askedYou('Fixed the typo and pushed. Tests pass.'), null);
  // ends on a result line, even with a question above it or a "?" inside it
  assert.equal(askedYou('Do you want me to restart it from main?\n\nresult: Music and town pop-ups are merged into main and built.'), null);
  assert.equal(askedYou('result: Town view now has keyboard shortcuts (+/− zoom, F fit, ? help) and a "Focus on active" button; merged as PR #28.'), null);
  assert.equal(askedYou('failed: the build broke on a missing env var, so nothing shipped.'), null);
  // a question mid-report, then more report
  assert.equal(askedYou('Why did it fail? Because of a typo. Fixed and pushed.'), null);
  // generic sign-offs
  assert.equal(askedYou('All three PRs are merged and live on 7777. Anything else?'), null);
  assert.equal(askedYou('Done: the doc has the 39 open initiatives.\n\nIs there anything else you need?'), null);
  assert.equal(askedYou('That’s the full breakdown. Any questions?'), null);
  assert.equal(askedYou(''), null);
  assert.equal(askedYou(null), null);
});
