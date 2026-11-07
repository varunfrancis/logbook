#!/usr/bin/env -S node --no-warnings
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const HOME = os.homedir();
const DATA = path.join(HOME, '.logbook');
const HOOK_DST = path.join(DATA, 'hook.sh');
const SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'settings.json');
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'dev.logbook.daemon.plist');
const LABEL = 'dev.logbook.daemon';
const PORT = Number(process.env.LOGBOOK_PORT || 7777);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const isOurs = (h: any) => typeof h?.command === 'string' && h.command.includes('.logbook/hook.sh');

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
    groups.push({ ...(TOOL_EVENTS.has(ev) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_DST, timeout: 5 }] });
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
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
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

function uninstallDaemon() {
  if (process.platform !== 'darwin' || !fs.existsSync(PLIST)) return;
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { stdio: 'ignore' }); } catch {}
  fs.rmSync(PLIST);
  console.log('Daemon login item removed.');
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
    console.log(`Daemon running on http://localhost:${PORT}`);
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
    build(); installHooks(); installDaemon();
    console.log(`\nOpen http://localhost:${PORT}  (new Claude sessions report in real time; existing ones are picked up from their transcripts)`);
    break;
  case 'uninstall':
    uninstallHooks(); uninstallDaemon();
    console.log(`Your data in ${DATA} was left in place. Delete it to remove everything.`);
    break;
  case 'hooks': installHooks(); break;
  case 'start':
    build();
    spawn(process.execPath, ['--no-warnings', path.join(REPO, 'daemon', 'server.ts')], { stdio: 'inherit' });
    break;
  case 'open': execFileSync('open', [`http://localhost:${PORT}`]); break;
  case 'status': await status(); break;
  default:
    console.log(`logbook: a logbook and city view of your Claude Code agents

  logbook install     build UI, add Claude Code hooks, run the daemon at login (macOS)
  logbook start       run the daemon in the foreground
  logbook open        open http://localhost:${PORT}
  logbook status      list live agents in the terminal
  logbook uninstall   remove hooks and the login item (keeps ~/.logbook)`);
}
