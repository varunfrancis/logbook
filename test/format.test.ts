import { test } from 'node:test';
import assert from 'node:assert/strict';
import { didSummary, linkLabel, madeLinks } from '../web/src/format.ts';

const LINEAR = `I created [ST-7785](https://linear.app/stablemoney/issue/ST-7785/support-assistant-know), "Support Assistant: know and send quoted replies". I searched Linear first.

- **Where it sits:** Technology team, in Triage.

result: Created Linear ticket ST-7785 for quoted WhatsApp replies (Technology / Support Assistant, Triage).`;

test('didSummary: prefers the result line', () => {
  assert.equal(didSummary(LINEAR), 'Created Linear ticket ST-7785 for quoted WhatsApp replies (Technology / Support Assistant, Triage).');
});

test('didSummary: otherwise the opening paragraph, markdown and bare links stripped', () => {
  assert.equal(
    didSummary('I sent **Nitin** a DM about [PR #441](https://github.com/a/b/pull/441).\n\nMessage: https://x.slack.com/archives/D1/p2'),
    'I sent Nitin a DM about PR #441.',
  );
  assert.equal(didSummary('# Done\n\nIt works.'), 'Done');
  assert.equal(didSummary(null), '');
});

test('didSummary: long replies end on a sentence', () => {
  const long = 'The report will now update every day at 11:00 AM. ' + 'Each run starts within a minute of the hour and writes to the doc. '.repeat(6);
  const out = didSummary(long, 120);
  assert.ok(out.length <= 120);
  assert.ok(out.endsWith('.'));
});

test('linkLabel names common destinations', () => {
  assert.equal(linkLabel('https://linear.app/stablemoney/issue/st-7785/x'), 'ST-7785');
  assert.equal(linkLabel('https://github.com/stable-money/support-assistant/pull/441'), 'PR #441');
  assert.equal(linkLabel('https://stablemoneyworkspace.slack.com/archives/D0/p1'), 'Slack message');
  assert.equal(linkLabel('https://claude.ai/artifact/X6X56'), 'Page');
  assert.equal(linkLabel('https://docs.google.com/spreadsheets/d/1'), 'Sheet');
  assert.equal(linkLabel('https://example.com/a'), 'example.com');
});

test('madeLinks: labelled, de-duplicated, trailing punctuation dropped', () => {
  assert.deepEqual(madeLinks(`${LINEAR}\nSee https://linear.app/stablemoney/issue/ST-7785/again. And https://claude.ai/artifact/abc.`), [
    { url: 'https://linear.app/stablemoney/issue/ST-7785/support-assistant-know', label: 'ST-7785' },
    { url: 'https://claude.ai/artifact/abc', label: 'Page' },
  ]);
  assert.deepEqual(madeLinks('no links'), []);
});

test('madeLinks: a bold link keeps its markdown marks out of the address', () => {
  assert.deepEqual(madeLinks('Live at **https://quantpath.live**.').map((l) => l.url), ['https://quantpath.live']);
});
