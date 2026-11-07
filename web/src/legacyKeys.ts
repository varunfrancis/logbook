/**
 * Swarmville was called Logbook, and this browser may still have its settings saved as `logbook.*` (theme, sound,
 * hidden buildings…). Copies them to `swarmville.*` once, before anything reads them. Imported first in main.tsx.
 */
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('logbook.')) continue;
    const next = `swarmville.${k.slice('logbook.'.length)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(k)!);
    localStorage.removeItem(k);
  }
} catch { /* private window or storage blocked: nothing to carry over */ }

export {};
