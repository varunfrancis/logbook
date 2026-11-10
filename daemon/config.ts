import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './legacy.ts';

export const HOME = os.homedir();
export const PORT = Number(env('PORT') || 7777);
export const DEFAULT_DATA_DIR = path.join(HOME, '.swarmville');
/** Where installs from before the rename to Swarmville kept their data (now a link to the new folder). */
export const LEGACY_DATA_DIR = path.join(HOME, '.logbook');
export const DATA_DIR = env('DATA_DIR') || DEFAULT_DATA_DIR;
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const DB_PATH = path.join(DATA_DIR, 'swarmville.db');
/** Swarmville's own small-model runs (naming, intros) happen in <data dir>/namer; any Swarmville data dir, not only this one. */
export const isOwnRun = (cwd: string | null | undefined) => !!cwd && (cwd.startsWith(DATA_DIR) || cwd.startsWith(LEGACY_DATA_DIR + path.sep) || (path.basename(cwd) === 'namer' && ['swarmville.db', 'logbook.db'].some((f) => fs.existsSync(path.join(path.dirname(cwd), f)))));
const TEMP_ROOTS = [...new Set([os.tmpdir(), (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'])]
  .map((p) => p.replace(/\/+$/, ''));
/** Inside the system's temp folder (where scripts make throwaway folders with mkdtemp). */
export const isTempDir = (p: string | null | undefined) => !!p && TEMP_ROOTS.some((r) => p.startsWith(r + path.sep));
/**
 * A program built on the Agent SDK (or a script calling `claude -p`) that runs each request in a fresh temp folder:
 * every request would otherwise become its own building. Not work on a project, so never shown.
 */
export const isThrowawayRun = (cwd: string | null | undefined, entrypoint: string | null | undefined) =>
  !!entrypoint && entrypoint.startsWith('sdk-') && isTempDir(cwd);
/** Every small-model request Swarmville makes starts with this line, so its own runs are never shown as projects, wherever they ran. */
export const OWN_MARK = '(Swarmville background task: naming and summaries.)';
/** The mark, plus how older versions' requests began (including before the rename from Logbook). */
export const OWN_PROMPT = /^(\((Swarmville|Logbook) background task|You name software projects for non-technical people|Describe this software project in ONE plain-English sentence|You lay out a little town where each software project is a building|Each character below is an AI coding agent)/;
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

