import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inline, parseMarkdown, plainText } from '../web/src/markdown.ts';

test('headings, bold and inline code from a real agent reply', () => {
  const b = parseMarkdown("I read `CLAUDE.md` on main.\n\n## When the bot hands off today\n\n**1. The customer asks for a person**\n- They ask for a person.");
  assert.equal(b[0].t, 'p');
  assert.deepEqual((b[0] as any).c, [{ t: 'text', v: 'I read ' }, { t: 'code', v: 'CLAUDE.md' }, { t: 'text', v: ' on main.' }]);
  assert.deepEqual(b[1], { t: 'h', level: 2, c: [{ t: 'text', v: 'When the bot hands off today' }] });
  assert.equal((b[2] as any).c[0].t, 'b');
  assert.equal(b[3].t, 'list');
});

test('numbered list keeps its start and nests bullets', () => {
  const b = parseMarkdown('3. Three\n   - inner a\n   - inner b\n4. Four');
  assert.equal(b.length, 1);
  const l = b[0] as any;
  assert.equal(l.ordered, true);
  assert.equal(l.start, 3);
  assert.equal(l.items.length, 2);
  assert.equal(l.items[0][1].t, 'list');
  assert.equal(l.items[0][1].items.length, 2);
});

test('blank lines between items keep one list', () => {
  const l = parseMarkdown('- a\n\n- b\n\n- c')[0] as any;
  assert.equal(l.items.length, 3);
});

test('code fences keep their text untouched', () => {
  const b = parseMarkdown('```ts\nconst a = **1**;\n```\nafter');
  assert.deepEqual(b[0], { t: 'code', lang: 'ts', v: 'const a = **1**;' });
  assert.equal(b[1].t, 'p');
});

test('tables with alignment', () => {
  const t = parseMarkdown('| Approach | Effort |\n|:--|--:|\n| Ask first | **low** |\n| Refund lookup | high |')[0] as any;
  assert.equal(t.t, 'table');
  assert.deepEqual(t.align, ['left', 'right']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][1][0].t, 'b');
});

test('links: only http(s) and mailto become links', () => {
  assert.deepEqual(inline('[PR](https://github.com/a/b/pull/1)'), [{ t: 'a', href: 'https://github.com/a/b/pull/1', c: [{ t: 'text', v: 'PR' }] }]);
  assert.ok(!JSON.stringify(inline('[x](javascript:alert(1))')).includes('"t":"a"'));
  const bare = inline('see https://example.com/a. done');
  assert.equal(bare[1].t, 'a');
  assert.equal((bare[1] as any).href, 'https://example.com/a');
});

test('snake_case words stay plain, *italic* and _italic_ work', () => {
  assert.deepEqual(inline('pipeline/handoff_rules.py'), [{ t: 'text', v: 'pipeline/handoff_rules.py' }]);
  assert.equal(inline('an *important* point')[1].t, 'i');
  assert.equal(inline('an _important_ point')[1].t, 'i');
});

test('quotes, rules and line breaks', () => {
  const b = parseMarkdown('> quoted\n> more\n\n---\n\nline one\nline two');
  assert.equal(b[0].t, 'quote');
  assert.equal(b[1].t, 'hr');
  assert.deepEqual((b[2] as any).c.map((x: any) => x.t), ['text', 'br', 'text']);
  assert.equal(plainText((b[2] as any).c), 'line one line two');
});
