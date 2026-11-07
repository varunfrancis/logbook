/*
 * Ways to start work with an agent. Thinking-first moves come first on purpose:
 * brainstorm and plan before anything gets built.
 */
export type MoveId = 'brainstorm' | 'plan' | 'fix' | 'research' | 'explain' | 'review' | 'build' | 'polish' | 'docs';
export type Move = { id: MoveId; label: string; hint: string; placeholder: string; plan: boolean; prompt: (what: string, project: string) => string };

export const MOVES: Record<MoveId, Move> = {
  brainstorm: {
    id: 'brainstorm', label: 'Brainstorm with me', hint: 'Ideas first, no code', plan: false, placeholder: 'e.g. ways to help customers find old answers',
    prompt: (w, p) => `Let's brainstorm before building anything on ${p}: ${w}. Give me 3 to 5 different approaches with the trade-offs in plain words, ask me what matters most, and don't change any files yet.`,
  },
  plan: {
    id: 'plan', label: 'Plan with me', hint: 'Agree on the steps first', plan: true, placeholder: 'e.g. let customers search old tickets',
    prompt: (w, p) => `Help me plan this for ${p}: ${w}. Read the relevant code, propose clear steps, list what could go wrong, and wait for my OK before changing anything.`,
  },
  fix: {
    id: 'fix', label: 'Fix something', hint: 'Describe what’s wrong', plan: false, placeholder: 'e.g. the sign-in page spins forever',
    prompt: (w, p) => `Something's wrong in ${p}: ${w}. Find the cause first and explain it to me in plain words, then fix it and check that it works.`,
  },
  research: {
    id: 'research', label: 'Research this', hint: 'Read, compare, report', plan: false, placeholder: 'e.g. how other apps handle refunds',
    prompt: (w, p) => `Research this for ${p}: ${w}. Summarize what you find and what it means for us in under 250 words. Don't change any files.`,
  },
  explain: {
    id: 'explain', label: 'Explain it to me', hint: 'A tour of the code', plan: false, placeholder: 'e.g. how a message turns into a reply',
    prompt: (w, p) => `Walk me through ${w ? w : 'how this project works'} in ${p}, in plain language, step by step. Don't change any files.`,
  },
  review: {
    id: 'review', label: 'Review my work', hint: 'Find what could break', plan: false, placeholder: 'e.g. the changes from today',
    prompt: (w, p) => `Review ${w || 'the latest changes'} in ${p}. List anything that could break or confuse people, most important first. Don't change files unless I ask.`,
  },
  build: {
    id: 'build', label: 'Build it', hint: 'Go ahead and make it', plan: false, placeholder: 'e.g. a dark mode switch',
    prompt: (w, p) => `Build this in ${p}: ${w}. Keep it simple, check that it works, and tell me what you changed in plain words.`,
  },
  polish: {
    id: 'polish', label: 'Polish how it looks', hint: 'Tidy a screen', plan: false, placeholder: 'e.g. the settings page feels cramped',
    prompt: (w, p) => `Improve how this looks in ${p}: ${w}. Check it on a phone-sized screen too, and describe what you changed.`,
  },
  docs: {
    id: 'docs', label: 'Write it down', hint: 'A guide or README', plan: false, placeholder: 'e.g. how to set this up on a new laptop',
    prompt: (w, p) => `Write clear, short docs for ${p}: ${w}. Plain language, for someone new.`,
  },
};

/** The first three steer toward thinking before building; each job leads with what it's good at. */
export const MOVES_FOR_JOB: Record<string, MoveId[]> = {
  builder: ['plan', 'brainstorm', 'build'],
  plumber: ['fix', 'plan', 'review'],
  painter: ['brainstorm', 'plan', 'polish'],
  librarian: ['explain', 'docs', 'plan'],
  inspector: ['review', 'plan', 'fix'],
  scout: ['brainstorm', 'research', 'plan'],
};
export const WELCOME_MOVES: MoveId[] = ['brainstorm', 'plan', 'fix'];
