// Scramble generation. Random-move scrambles with the usual redundancy rules:
// never turn the same face twice in a row, and never sandwich a face between
// two turns of its opposite (R L R is the same as R R L).

const OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L', F: 'B', B: 'F' };
const SUFFIX = ['', "'", '2'];

const EVENT_SPECS = {
  '333':   { faces: ['U', 'D', 'L', 'R', 'F', 'B'], wide: [], length: 20 },
  '333oh': { faces: ['U', 'D', 'L', 'R', 'F', 'B'], wide: [], length: 20 },
  '222':   { faces: ['U', 'R', 'F'], wide: [], length: 11 },
  '444':   { faces: ['U', 'D', 'L', 'R', 'F', 'B'], wide: ['Uw', 'Rw', 'Fw'], length: 44 },
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function scrambleFor(event) {
  const spec = EVENT_SPECS[event] || EVENT_SPECS['333'];
  const moves = [];
  let last = null;
  let before = null;

  while (moves.length < spec.length) {
    const useWide = spec.wide.length && Math.random() < 0.3;
    const token = useWide ? pick(spec.wide) : pick(spec.faces);
    const face = token[0];

    if (face === last) continue;
    if (face === before && OPPOSITE[last] === face) continue;

    moves.push(token + pick(SUFFIX));
    before = last;
    last = face;
  }
  return moves.join(' ');
}

// An array, not an object: JS reorders integer-like keys ('222' would sort
// ahead of '333'), which silently scrambles the order of every event menu.
export const EVENT_LIST = [
  ['333', '3x3'],
  ['222', '2x2'],
  ['444', '4x4'],
  ['333oh', '3x3 One-Handed'],
];

export const EVENTS = Object.fromEntries(EVENT_LIST);

/* A time this fast is a stopped-too-early misclick, not a solve. The records
   differ enormously between events, so a single flat floor is no good -- 5s
   would throw away most legitimate 2x2 solves. Keep in step with MIN_SOLVE in
   server.py, which enforces the same rule for anything that reaches it. */
export const MIN_SOLVE = {
  '333': 5000,      // deliberately strict; the world record is 3.13s
  '333oh': 5000,    // world record 5.66s
  '222': 400,       // world record 0.43s -- 2x2 really is this fast
  '444': 10000,     // world record 15.71s
};

export const minimumFor = (event) => MIN_SOLVE[event] ?? 5000;
