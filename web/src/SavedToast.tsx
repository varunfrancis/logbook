import { useEffect, useState } from 'react';

const SHOW_MS = 2500;
const LEAVE_MS = 250;

/** A short confirmation that slides down from the top of the screen, then slides back up. */
export function SavedToast({ message, onDone }: { message: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setLeaving(true), SHOW_MS);
    const b = setTimeout(onDone, SHOW_MS + LEAVE_MS);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  return (
    <div className={`saved-toast${leaving ? ' leaving' : ''}`} role="status" aria-live="polite">
      <span className="saved-toast-check" aria-hidden="true">✓</span>{message}
    </div>
  );
}
