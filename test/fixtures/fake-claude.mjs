// A stand-in for `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`.
// For each message: asks to run a command, waits for the answer, then says what it heard and how the ask went.
// Writes its arguments to $FAKE_CLAUDE_ARGS so tests can see how it was started.
import fs from 'node:fs';
if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;
const waiting = new Map();
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (m.type === 'user') {
      const c = m.message.content;
      const text = typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const images = typeof c === 'string' ? 0 : c.filter((b) => b.type === 'image').length;
      const id = `req-${++n}`;
      out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi', description: 'Say hi' } }] } });
      waiting.set(id, { text, images });
      out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' }, permission_suggestions: [] } });
    } else if (m.type === 'control_response') {
      const w = waiting.get(m.response.request_id);
      waiting.delete(m.response.request_id);
      const said = `heard: ${w.text}${w.images ? ` +${w.images} image` : ''} (${m.response.response.behavior})`;
      out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: said }] } });
      out({ type: 'result', result: said, is_error: false });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
