import type { Db, Row } from './db.ts';
import { kvSet, logEvent } from './db.ts';
import { describeTool } from './describe.ts';
import { ensureProjectForCwd, touchProject } from './projects.ts';
import { cleanPrompt } from './transcripts.ts';
import { isOwnRun } from './config.ts';

/** The raised-hand line for a permission prompt, in the same words the terminal would use. */
export function permissionMessage(tool: string, input: any): string {
  if (tool === 'AskUserQuestion') return 'Has a question for you';
  if (tool === 'ExitPlanMode') return 'Has a plan ready for your OK';
  return `Claude needs your permission to use ${tool.startsWith('mcp__') ? describeTool(tool, input).text.replace(/^Using /, '') : tool}`;
}

const PR_RE = /https:\/\/github\.com\/[^/\s"]+\/[^/\s"]+\/pull\/\d+/;

/**
 * Claude Code tells the terminal that launched a background job about that job: "<job> needs your input: …", "<job> finished".
 * That's the job's state, not this session's (the job's own session already shows it), and answering the job never reaches
 * this session, so treating it as this session's raised hand would leave the hand up for good.
 */
export function isJobNotice(type: unknown, message: unknown): boolean {
  if (type === 'permission_prompt' || type === 'idle_prompt') return false;
  const msg = String(message ?? '').trim();
  return !/^Claude\b/.test(msg) && /^\S.*? (needs your input\b|finished\b)/.test(msg);
}

/** Applies one Claude Code hook payload. Never throws for bad input. */
export function handleHook(db: Db, p: any, now = Date.now()) {
  const sid = p?.session_id;
  const event = p?.hook_event_name;
  if (typeof sid !== 'string' || typeof event !== 'string') return;

  if (isOwnRun(typeof p.cwd === 'string' ? p.cwd : null)) return; // Logbook's own helper runs
  db.prepare('INSERT OR IGNORE INTO sessions(id, transcript, cwd, started_at) VALUES(?, ?, ?, ?)').run(sid, p.transcript_path ?? null, p.cwd ?? null, now);
  const s = db.prepare('SELECT project_id, hook_state, hook_state_at, needs_message FROM sessions WHERE id = ?').get(sid) as Row;
  // A raised hand ends when anything else happens: record how long the agent waited for you.
  if (s.hook_state === 'needs_input' && s.hook_state_at && event !== 'Notification' && event !== 'SubagentStop' && now > s.hook_state_at) {
    db.prepare('INSERT INTO segments(session_id, start, end, kind) VALUES(?, ?, ?, ?)').run(sid, s.hook_state_at, now, 'wait');
  }
  let projectId: string | null = s.project_id;
  if (!projectId && p.cwd) {
    const r = ensureProjectForCwd(db, p.cwd);
    projectId = r.projectId;
    db.prepare('UPDATE sessions SET project_id = ?, worktree = ?, cwd = ? WHERE id = ?').run(projectId, r.worktree, p.cwd, sid);
  }

  const set = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => fields[k]) as any[]), sid);
  };

  switch (event) {
    case 'SessionStart':
      set({ hook_state: 'idle', hook_state_at: now, ended_at: null, end_reason: null });
      logEvent(db, sid, now, 'start', p.source ? `Session ${p.source}` : 'Session started');
      break;
    case 'UserPromptSubmit': {
      const prompt = cleanPrompt(String(p.prompt ?? ''));
      set({ hook_state: 'running', hook_state_at: now, needs_message: null, current_action: 'Thinking', action_kind: 'think' });
      if (prompt) {
        db.prepare('UPDATE sessions SET last_prompt = ?, first_prompt = COALESCE(first_prompt, ?) WHERE id = ?').run(prompt, prompt, sid);
        logEvent(db, sid, now, 'prompt', prompt);
      }
      break;
    }
    case 'PreToolUse': {
      const a = describeTool(String(p.tool_name ?? ''), p.tool_input);
      set({ hook_state: 'running', hook_state_at: now, needs_message: null, current_action: a.text, action_kind: a.kind });
      logEvent(db, sid, now, 'tool', a.text);
      break;
    }
    case 'PostToolUse': {
      set({ hook_state: 'running', hook_state_at: now, needs_message: null });
      const cmd = p.tool_name === 'Bash' ? String(p.tool_input?.command ?? '') : '';
      if (/\bgh\s+pr\s+create\b/.test(cmd)) {
        const m = JSON.stringify(p.tool_response ?? '').match(PR_RE);
        if (m) { set({ pr_url: m[0], pr_checked_at: null }); logEvent(db, sid, now, 'pr', `Opened ${m[0]}`); }
      }
      if (/\bgit\s+commit\b/.test(cmd)) logEvent(db, sid, now, 'commit', 'Committed changes');
      break;
    }
    case 'PermissionRequest': {
      // Fires the moment Claude asks (the Notification for it only comes ~6s later, and not at all if you answer first).
      if (s.hook_state === 'needs_input') break;
      const msg = permissionMessage(String(p.tool_name ?? ''), p.tool_input);
      set({ hook_state: 'needs_input', hook_state_at: now, needs_message: msg });
      logEvent(db, sid, now, 'needs', msg);
      break;
    }
    case 'Notification': {
      const msg = String(p.message ?? '');
      if (isJobNotice(p.notification_type, msg)) {
        // a hand raised by an earlier job notice (before Logbook knew better) comes down; a real one stays up
        if (s.hook_state === 'needs_input' && isJobNotice(null, s.needs_message)) set({ hook_state: 'idle', hook_state_at: now, needs_message: null });
        logEvent(db, sid, now, 'job', msg);
        break;
      }
      const needs = p.notification_type === 'permission_prompt' || /permission|approve|needs your/i.test(msg);
      if (needs && s.hook_state === 'needs_input') break; // still the same raised hand
      set(needs ? { hook_state: 'needs_input', hook_state_at: now, needs_message: msg } : { hook_state: 'idle', hook_state_at: now });
      logEvent(db, sid, now, needs ? 'needs' : 'idle', msg || 'Waiting for you');
      break;
    }
    case 'Stop':
      set({ hook_state: 'idle', hook_state_at: now, current_action: null, action_kind: null, needs_message: null });
      logEvent(db, sid, now, 'stop', 'Finished a turn');
      break;
    case 'SubagentStop':
      set({ subagent_at: now });
      break;
    case 'SessionEnd':
      set({ hook_state: 'ended', hook_state_at: now, ended_at: now, end_reason: p.reason ?? 'exit', current_action: null, action_kind: null, needs_message: null });
      logEvent(db, sid, now, 'end', `Session closed (${p.reason ?? 'exit'})`);
      break;
  }
  db.prepare('UPDATE sessions SET last_event_at = MAX(COALESCE(last_event_at, 0), ?) WHERE id = ?').run(now, sid);
  if (projectId) touchProject(db, projectId, now);
  kvSet(db, 'hooks.lastEventAt', now);
}
