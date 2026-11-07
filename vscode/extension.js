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
  if (ev !== 'jump' || !data) return;
  let j;
  try { j = JSON.parse(data); } catch { return; }
  for (const t of vscode.window.terminals) {
    const pid = await t.processId;
    if (pid && (pid === j.shellPid || pid === j.pid)) {
      t.show(false);
      raiseWindow();
      return;
    }
  }
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
