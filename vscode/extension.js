// Logbook Jump: listens to the local Logbook daemon and, when asked, shows the terminal running that agent.
const vscode = require('vscode');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.LOGBOOK_PORT || 7777);
let req = null;
let timer = null;
let stopped = false;

function connect() {
  if (stopped) return;
  req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/stream?client=vscode', headers: { accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); handle(block); }
    });
    checkPending();
    res.on('end', retry);
    res.on('error', retry);
  });
  req.on('error', retry);
}

function retry() {
  clearTimeout(timer);
  if (!stopped) timer = setTimeout(connect, 5000);
}

async function handle(block) {
  const ev = (/^event: (.*)$/m.exec(block) || [])[1];
  const data = (/^data: (.*)$/m.exec(block) || [])[1];
  if (!data) return;
  let j;
  try { j = JSON.parse(data); } catch { return; }
  if (ev === 'resume') return maybeResume(j);
  if (ev !== 'jump') return;
  for (const t of vscode.window.terminals) {
    const pid = await t.processId;
    if (pid && (pid === j.shellPid || pid === j.pid)) {
      t.show(false);
      raiseWindow();
      return;
    }
  }
}

/** Is this window's workspace the project (or contains the folder) the job ran in? */
function ownsFolder(dir) {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  return folders.some((f) => dir === f || dir.startsWith(f + path.sep));
}

/** A past job to reopen: the window that owns its folder claims it (first one wins) and runs claude --resume in a new terminal. */
function maybeResume(j) {
  if (!j || !(ownsFolder(j.cwd) || ownsFolder(j.root))) return;
  const r = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/resume/claim/' + encodeURIComponent(j.sessionId) }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c));
    res.on('end', () => {
      let c; try { c = JSON.parse(body); } catch { return; }
      if (!c.ok) return;
      const t = vscode.window.createTerminal({ name: c.name || 'Claude (resumed)', cwd: c.cwd });
      t.show(false);
      t.sendText(c.command, true);
    });
  });
  r.on('error', () => {});
  r.end();
}

/** A window opened just to resume a job missed the event while loading; pick it up now. */
function checkPending() {
  http.get({ host: '127.0.0.1', port: PORT, path: '/api/resume/pending' }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c));
    res.on('end', () => { let list; try { list = JSON.parse(body); } catch { return; } for (const p of list || []) maybeResume({ sessionId: p.id, cwd: p.cwd, root: p.root }); });
  }).on('error', () => {});
}

/** Brings this VS Code window to the front by re-opening its own folder or workspace. */
function raiseWindow() {
  const target = (vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.fsPath) ||
    (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].uri.fsPath);
  if (!target) return;
  const bin = path.join(vscode.env.appRoot, 'bin', process.platform === 'win32' ? 'code.cmd' : 'code');
  execFile(bin, ['-r', target], () => {});
}

exports.activate = () => connect();
exports.deactivate = () => { stopped = true; clearTimeout(timer); if (req) req.destroy(); };
