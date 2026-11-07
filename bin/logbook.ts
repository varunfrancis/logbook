#!/usr/bin/env -S node --no-warnings
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const HOME = os.homedir();
const DATA = process.env.LOGBOOK_DATA_DIR || path.join(HOME, '.logbook');
const VERSION: string = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const INSTALL_URL = 'https://raw.githubusercontent.com/varunfrancis/logbook/main/install.sh';
const FLAGS = new Set(process.argv.slice(3));
const HOOK_DST = path.join(DATA, 'hook.sh');
const SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'settings.json');
// A second install with its own data folder (e.g. a test install) gets its own login item and never touches the main one.
const CUSTOM = !!process.env.LOGBOOK_DATA_DIR && path.resolve(process.env.LOGBOOK_DATA_DIR) !== path.join(HOME, '.logbook');
const LABEL = CUSTOM ? `dev.logbook.daemon.${Buffer.from(path.resolve(DATA)).toString('base64url').slice(-10)}` : 'dev.logbook.daemon';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const PORT = Number(process.env.LOGBOOK_PORT || 7777);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const isOurs = (h: any) => typeof h?.command === 'string' && (CUSTOM ? h.command.includes(HOOK_DST) : h.command.includes('.logbook/hook.sh'));
// A non-default port or data folder (test installs) travels with the hook command and the login item.
const ENV: Record<string, string> = { ...(process.env.LOGBOOK_PORT ? { LOGBOOK_PORT: String(PORT) } : {}), ...(process.env.LOGBOOK_DATA_DIR ? { LOGBOOK_DATA_DIR: DATA } : {}) };

function readSettings(): any {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e: any) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Could not parse ${SETTINGS}: ${e.message}. Fix it first; Logbook will not overwrite it.`);
  }
}
function writeSettings(s: any) {
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.logbook-backup-${Date.now()}`);
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}

function installHooks() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'hook', 'logbook-hook.sh'), HOOK_DST);
  fs.chmodSync(HOOK_DST, 0o755);
  const s = readSettings();
  s.hooks ??= {};
  let added = 0;
  for (const ev of EVENTS) {
    const groups: any[] = (s.hooks[ev] ??= []);
    if (groups.some((g) => (g.hooks ?? []).some(isOurs))) continue;
    const command = (ENV.LOGBOOK_PORT ? `LOGBOOK_PORT=${ENV.LOGBOOK_PORT} ` : '') + HOOK_DST;
    groups.push({ ...(TOOL_EVENTS.has(ev) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
    added++;
  }
  if (added) writeSettings(s);
  console.log(added ? `Added Logbook hooks for ${added} events to ${SETTINGS} (backup saved next to it).` : 'Hooks already installed.');
}

function uninstallHooks() {
  const s = readSettings();
  if (!s.hooks) return console.log('No hooks to remove.');
  let removed = 0;
  for (const ev of Object.keys(s.hooks)) {
    const before = JSON.stringify(s.hooks[ev]);
    s.hooks[ev] = (s.hooks[ev] as any[]).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (JSON.stringify(s.hooks[ev]) !== before) removed++;
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  if (removed) writeSettings(s);
  console.log(removed ? `Removed Logbook hooks from ${removed} events.` : 'No Logbook hooks found.');
}

function installDaemon() {
  if (process.platform !== 'darwin') return console.log('Skipping launchd (macOS only). Run `logbook start` yourself.');
  const node = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>--no-warnings</string><string>${path.join(REPO, 'daemon', 'server.ts')}</string></array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path.dirname(node)}:${path.join(HOME, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>${Object.entries(ENV).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(DATA, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(DATA, 'daemon.log')}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist);
  const uid = process.getuid!();
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch {}
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
  console.log(`Daemon installed as a login item (${LABEL}). Logs: ${path.join(DATA, 'daemon.log')}`);
}

/** Runs the daemon in the background without a login item (test installs, or `--no-login-item`). */
function startDetached() {
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(path.join(DATA, 'daemon.log'), 'a');
  spawn(process.execPath, ['--no-warnings', path.join(REPO, 'daemon', 'server.ts')], { cwd: REPO, detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...ENV } }).unref();
  console.log(`Logbook is running in the background (not at login). Logs: ${path.join(DATA, 'daemon.log')}`);
}

/** Stops a Logbook running in the background without a login item (only if it answers as Logbook). */
async function stopDetached() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) }); const { pid } = await r.json(); if (pid) { process.kill(pid); console.log('Stopped Logbook.'); } } catch {}
}

function uninstallDaemon() {
  if (process.platform !== 'darwin' || !fs.existsSync(PLIST)) return;
  // Only remove a login item that runs this copy of Logbook.
  if (!fs.readFileSync(PLIST, 'utf8').includes(path.join(REPO, 'daemon', 'server.ts'))) return console.log(`Left the login item alone: it runs a different copy of Logbook (${PLIST}).`);
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { stdio: 'ignore' }); } catch {}
  fs.rmSync(PLIST);
  console.log('Daemon login item removed.');
}

const VSCODE_CLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

/** Packages the tiny VS Code helper as a .vsix and installs it with VS Code's own CLI. */
function installVscode() {
  const cli = fs.existsSync(VSCODE_CLI) ? VSCODE_CLI : null;
  if (!cli) return console.log('VS Code not found in /Applications. Skipping the VS Code helper.');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'vscode', 'package.json'), 'utf8'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'logbook-vsix-'));
  fs.mkdirSync(path.join(stage, 'extension'));
  for (const f of ['package.json', 'extension.js']) fs.copyFileSync(path.join(REPO, 'vscode', f), path.join(stage, 'extension', f));
  fs.writeFileSync(path.join(stage, '[Content_Types].xml'), '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>');
  fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/>
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description.replace(/"/g, '&quot;')}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>`);
  fs.mkdirSync(DATA, { recursive: true });
  const vsix = path.join(DATA, `${pkg.name}-${pkg.version}.vsix`);
  fs.rmSync(vsix, { force: true });
  execFileSync('zip', ['-qr', vsix, '.'], { cwd: stage });
  execFileSync(cli, ['--install-extension', vsix, '--force'], { stdio: 'inherit' });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('VS Code helper installed. New VS Code windows pick it up on their own; windows already open start using it after VS Code restarts.');
}

/** Waits for the daemon to answer (it starts answering before it has read your history), then opens the browser. */
async function openWhenReady() {
  if (process.platform !== 'darwin') return console.log(`Open http://localhost:${PORT} in your browser.`);
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(500) }); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  try { execFileSync('open', [`http://localhost:${PORT}`]); } catch { console.log(`Open http://localhost:${PORT} in your browser.`); }
}

function build() {
  if (!fs.existsSync(path.join(REPO, 'web', 'dist', 'index.html'))) {
    console.log('Building the web UI…');
    execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
  }
}

async function status() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(2000) });
    const s = await r.json();
    console.log(`Logbook ${VERSION} running on http://localhost:${PORT}`);
    console.log(`${s.totals.needs} need you · ${s.totals.running} working · ${s.totals.idle} idle · ${s.totals.doneToday} closed today`);
    for (const x of s.sessions.filter((x: any) => x.status !== 'ended')) {
      const p = s.projects.find((p: any) => p.id === x.projectId);
      console.log(`  ${x.status.padEnd(11)} ${(p?.name ?? '?').padEnd(22)} ${x.title}${x.action ? `  (${x.action})` : ''}`);
    }
  } catch {
    console.log(`Daemon is not running on port ${PORT}. Start it with \`logbook start\` or \`logbook install\`.`);
    process.exitCode = 1;
  }
}

const cmd = process.argv[2] ?? 'help';
switch (cmd) {
  case 'install':
    build(); installHooks(); FLAGS.has('--no-login-item') ? startDetached() : installDaemon();
    if (!FLAGS.has('--no-vscode') && !CUSTOM) { try { installVscode(); } catch (e: any) { console.log(`VS Code helper not installed: ${e.message}`); } }
    if (FLAGS.has('--no-open')) console.log(`\nAll set. Your town is at http://localhost:${PORT}`);
    else { console.log(`\nAll set. Opening your town at http://localhost:${PORT} …`); await openWhenReady(); }
    break;
  case 'update': {
    // A developer copy (a git checkout) updates with git; an installed copy re-runs the installer, which keeps your data.
    if (fs.existsSync(path.join(REPO, '.git'))) { console.log(`This is a developer copy at ${REPO}. Update it with git pull, npm run build, then restart.`); break; }
    execFileSync('/bin/bash', ['-c', `curl -fsSL ${INSTALL_URL} | bash`], { stdio: 'inherit', env: { ...process.env, LOGBOOK_NO_OPEN: '1' } });
    break;
  }
  case 'version': console.log(VERSION); break;
  case 'uninstall':
    uninstallHooks(); uninstallDaemon(); await stopDetached();
    // The VS Code helper is shared by every copy, so a separate (custom data folder) install leaves it alone.
    if (!CUSTOM && fs.existsSync(VSCODE_CLI)) { try { execFileSync(VSCODE_CLI, ['--uninstall-extension', 'logbook.logbook-jump'], { stdio: 'ignore' }); console.log('VS Code helper removed.'); } catch {} }
    if (FLAGS.has('--everything')) {
      for (const d of ['app', 'app.new', 'runtime', 'bin']) fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
      console.log(`Removed the Logbook app from ${DATA}. Your town's history (${path.join(DATA, 'logbook.db')}) is still there; delete ${DATA} to remove it too.`);
    } else console.log(`Your data in ${DATA} was left in place. Delete it to remove everything.`);
    break;
  case 'hooks': installHooks(); break;
  case 'vscode': installVscode(); break;
  case 'start':
    build();
    spawn(process.execPath, ['--no-warnings', path.join(REPO, 'daemon', 'server.ts')], { stdio: 'inherit' });
    break;
  case 'open': execFileSync('open', [`http://localhost:${PORT}`]); break;
  case 'status': await status(); break;
  default:
    console.log(`logbook: a logbook and city view of your Claude Code agents

  logbook install     add Claude Code hooks, run Logbook at login, open your town (macOS)
                      --no-login-item  run in the background now, not at login
  logbook update      get the latest version (keeps your town)
  logbook start       run the daemon in the foreground
  logbook open        open http://localhost:${PORT}
  logbook status      list live agents in the terminal
  logbook vscode      install the VS Code helper so "Go to" opens the right terminal
  logbook uninstall   remove hooks and the login item (keeps ~/.logbook)
                      --everything     also remove the app and its private Node
  logbook version     print the version`);
}
