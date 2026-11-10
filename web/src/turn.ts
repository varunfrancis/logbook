import { parseMarkdown, plainText, type Block, type Inline } from './markdown.ts';

/*
 * "Your turn": when an agent's reply ends by asking you something, say what they asked and offer answers you can tap.
 * Answers come from the question itself ("…: fewer hand-offs, happier customers, or least work?"), from a numbered
 * list of options in the reply ("1. **Ask once before handing off** …"), or yes/no for "Should I…?" questions.
 */

export type Answer = { label: string; say: string };
export type Turn = { question: string; answers: Answer[]; more: number }; // more: other questions just above it

const YES_NO = /^(should|shall|do you want|want me|can i|could i|would you like|is it ok|is that ok|ok to|okay to|happy for me|ready for me|good to go|are you happy|sound good|does that work)\b/i;

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const trimLabel = (s: string) => s.replace(/[\s:–—.-]+$/, '').trim();

function blockText(b: Block): string {
  switch (b.t) {
    case 'p': case 'h': return plainText(b.c);
    case 'list': return b.items.map((it) => it.map(blockText).join(' ')).join(' ');
    case 'quote': return b.c.map(blockText).join(' ');
    default: return '';
  }
}

/** The options of a numbered list whose items each start with a bold title: "1. **Ask first**: cheap…" → "Ask first". */
export function pickItems(b: Block): string[] | null {
  if (b.t !== 'list' || !b.ordered || b.items.length < 2 || b.items.length > 7) return null;
  const labels: string[] = [];
  for (const it of b.items) {
    const first = it[0];
    if (first?.t !== 'p') return null;
    const lead = first.c.find((x: Inline) => !(x.t === 'text' && !x.v.trim()));
    if (!lead || lead.t !== 'b') return null;
    const label = trimLabel(plainText(lead.c).replace(/^\d+[.)]\s*/, ''));
    if (!label || label.endsWith('?')) return null; // a list of questions for you isn't a list of options
    labels.push(label);
  }
  return labels;
}

/** What the agent asked at the end of their reply, and answers to offer; null if they didn't ask anything. */
export function yourTurn(reply: string): Turn | null {
  const blocks = parseMarkdown(reply);
  const tail = blocks.filter((b) => b.t !== 'code' && b.t !== 'table' && b.t !== 'hr').slice(-2);
  const text = tail.map(blockText).join(' ').replace(/\s+/g, ' ').trim();
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];
  // a question you're meant to answer comes last (or just before a "let me know"), not mid-report
  const question = sentences.map((s) => s.trim()).slice(-2).filter((s) => s.endsWith('?')).at(-1);
  if (!question || question.length < 8) return null;

  let answers: Answer[] = [];
  // choices listed in the question, after a colon or dash
  const at = Math.max(question.lastIndexOf(':'), question.lastIndexOf(' — '), question.lastIndexOf(' – '));
  if (at > 0) {
    const parts = question.slice(at + 1, -1).split(/,\s*(?:or\s+)?|\s+or\s+/).map((p) => trimLabel(p.replace(/^\s*(?:—|–)\s*/, ''))).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 5 && parts.every((p) => p.length <= 48)) answers = parts.map((p) => ({ label: cap(p), say: cap(p) }));
  }
  // a numbered list of options in the reply
  if (!answers.length) {
    const list = [...blocks].reverse().map(pickItems).find(Boolean);
    if (list) answers = list.slice(0, 5).map((l, i) => ({ label: `${i + 1}. ${short(l, 34)}`, say: `Go with option ${i + 1}: ${l}.` }));
  }
  if (!answers.length && YES_NO.test(question)) answers = [{ label: 'Yes, go ahead', say: 'Yes, go ahead.' }, { label: 'Not yet', say: 'Not yet. Hold off for now.' }];
  // "1. **Which flow?** … 2. **Pull the numbers now?**": count the other questions in the closing list
  const lastList = [...blocks].reverse().find((b) => b.t !== 'code' && b.t !== 'hr');
  const asked = lastList?.t === 'list' ? lastList.items.filter((it) => /\?/.test(it.map(blockText).join(' '))).length : 0;
  return { question: short(question, 220), answers, more: Math.max(0, asked - 1) };
}
