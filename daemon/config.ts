import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const PORT = Number(process.env.LOGBOOK_PORT || 7777);
export const DATA_DIR = process.env.LOGBOOK_DATA_DIR || path.join(HOME, '.logbook');
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const DB_PATH = path.join(DATA_DIR, 'logbook.db');
/** Logbook's own small-model runs (naming, intros) happen in <data dir>/namer; any Logbook data dir, not only this one. */
export const isOwnRun = (cwd: string | null | undefined) => !!cwd && (cwd.startsWith(DATA_DIR) || (path.basename(cwd) === 'namer' && fs.existsSync(path.join(path.dirname(cwd), 'logbook.db'))));
/** Every small-model request Logbook makes starts with this line, so its own runs are never shown as projects, wherever they ran. */
export const OWN_MARK = '(Logbook background task: naming and summaries.)';
/** The mark, plus how older versions' requests began. */
export const OWN_PROMPT = /^(\(Logbook background task|You name software projects for non-technical people|Describe this software project in ONE plain-English sentence|You lay out a little town where each software project is a building|Each character below is an AI coding agent)/;
export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
export const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

/** A session with no registry entry is still treated as live for this long after its last hook event (registry write lag). */
export const LIVE_GRACE_MS = 15_000;
/** Worked on within this window (and nobody on site now) = "under construction". */
export const CONSTRUCTION_MS = 7 * 24 * 3600_000;
/** Quiet for longer than this = "complete"; between the two = "just completed". */
export const QUIET_AFTER_MS = 30 * 24 * 3600_000;
/** An idle agent stops counting as "crew on site" after this long without activity. */
export const AWAY_AFTER_MS = 2 * 3600_000;
/** A background job sitting idle without having asked for anything is done in all but name: it naps after this. */
export const BG_AWAY_AFTER_MS = 30 * 60_000;
/** Sessions shown in the dashboard's "Done" group. */
export const RECENT_MS = 24 * 3600_000;

fs.mkdirSync(DATA_DIR, { recursive: true });
