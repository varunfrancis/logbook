import fs from 'node:fs';
import path from 'node:path';

/** SWARMVILLE_<name>, or the LOGBOOK_<name> that installs from before the rename still set. */
export const env = (name: string): string | undefined => process.env[`SWARMVILLE_${name}`] || process.env[`LOGBOOK_${name}`] || undefined;

/**
 * Swarmville was called Logbook and lived in ~/.logbook. Moves that folder to its new home once and leaves a link at the
 * old path, so anything still pointing there (Claude Code hooks, an older login item, the old `logbook` command) keeps working.
 * Also renames the town's history from logbook.db to swarmville.db. Safe to call every start; does nothing once done.
 */
export function adoptLegacyData(dataDir: string, legacyDir: string | null) {
  if (legacyDir) {
    try {
      if (fs.existsSync(dataDir) && !fs.readdirSync(dataDir).length) fs.rmdirSync(dataDir); // created empty before the move
      if (fs.existsSync(dataDir)) throw 0;
      if (fs.lstatSync(legacyDir).isDirectory()) {
        fs.mkdirSync(path.dirname(dataDir), { recursive: true });
        fs.renameSync(legacyDir, dataDir);
        fs.symlinkSync(dataDir, legacyDir);
      }
    } catch {}
  }
  const db = path.join(dataDir, 'swarmville.db'), old = path.join(dataDir, 'logbook.db');
  if (!fs.existsSync(db) && fs.existsSync(old)) {
    for (const ext of ['', '-wal', '-shm']) { try { fs.renameSync(old + ext, db + ext); } catch {} }
  }
}
