/** Enter sends, Shift+Enter makes a new line, and nothing fires while an input method is still composing. */
export function sendsOnEnter(e: { key: string; shiftKey: boolean; isComposing?: boolean }) {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}
