// A 3x3 cube, as state plus a move engine, plus a flat drawing of it.
//
// Stickers are held as six faces of nine, each index read left-to-right and
// top-to-bottom while looking straight at that face:
//
//     0 1 2
//     3 4 5
//     6 7 8
//
// A turn does two things: it spins that face's own nine stickers, and it
// cycles four strips of three around the sides. Everything else -- wide
// turns, slices, whole-cube rotations -- is built out of those.

export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

const COLOURS = {
  U: '#f7f7f7',   // white
  D: '#f5d020',   // yellow
  F: '#22a04c',   // green
  B: '#1f5fd0',   // blue
  R: '#d4342b',   // red
  L: '#ec8118',   // orange
};

export function solved() {
  const state = {};
  FACES.forEach((face) => { state[face] = Array(9).fill(face); });
  return state;
}

export const clone = (state) => {
  const copy = {};
  FACES.forEach((face) => { copy[face] = state[face].slice(); });
  return copy;
};

/* Each entry: the face whose own stickers spin, and the four side strips.
   Contents travel from one strip to the next, and from the last back to the
   first. Slices (M, E, S) spin no face of their own. */
const MOVES = {
  U: { spin: 'U', cycle: [['F0', 'F1', 'F2'], ['L0', 'L1', 'L2'], ['B0', 'B1', 'B2'], ['R0', 'R1', 'R2']] },
  D: { spin: 'D', cycle: [['F6', 'F7', 'F8'], ['R6', 'R7', 'R8'], ['B6', 'B7', 'B8'], ['L6', 'L7', 'L8']] },
  R: { spin: 'R', cycle: [['F2', 'F5', 'F8'], ['U2', 'U5', 'U8'], ['B6', 'B3', 'B0'], ['D2', 'D5', 'D8']] },
  L: { spin: 'L', cycle: [['U0', 'U3', 'U6'], ['F0', 'F3', 'F6'], ['D0', 'D3', 'D6'], ['B8', 'B5', 'B2']] },
  F: { spin: 'F', cycle: [['U6', 'U7', 'U8'], ['R0', 'R3', 'R6'], ['D2', 'D1', 'D0'], ['L8', 'L5', 'L2']] },
  B: { spin: 'B', cycle: [['U2', 'U1', 'U0'], ['L0', 'L3', 'L6'], ['D6', 'D7', 'D8'], ['R8', 'R5', 'R2']] },
  M: { spin: null, cycle: [['U1', 'U4', 'U7'], ['F1', 'F4', 'F7'], ['D1', 'D4', 'D7'], ['B7', 'B4', 'B1']] },
  E: { spin: null, cycle: [['F3', 'F4', 'F5'], ['R3', 'R4', 'R5'], ['B3', 'B4', 'B5'], ['L3', 'L4', 'L5']] },
  S: { spin: null, cycle: [['U3', 'U4', 'U5'], ['R1', 'R4', 'R7'], ['D5', 'D4', 'D3'], ['L7', 'L4', 'L1']] },
};

/* Wide turns and rotations, as the basic turns they are made of. The pieces
   of each are on separate layers and so never interfere, which is why a
   prime can just invert every component and ignore their order. */
const DERIVED = {
  r: [['R', 1], ['M', 3]],
  l: [['L', 1], ['M', 1]],
  u: [['U', 1], ['E', 3]],
  d: [['D', 1], ['E', 1]],
  f: [['F', 1], ['S', 1]],
  b: [['B', 1], ['S', 3]],
  x: [['R', 1], ['M', 3], ['L', 3]],
  y: [['U', 1], ['E', 3], ['D', 3]],
  z: [['F', 1], ['S', 1], ['B', 3]],
};

const at = (state, spot) => state[spot[0]][+spot.slice(1)];
const put = (state, spot, value) => { state[spot[0]][+spot.slice(1)] = value; };

function spinFace(state, face) {
  const old = state[face].slice();
  const order = [6, 3, 0, 7, 4, 1, 8, 5, 2];   // clockwise
  state[face] = order.map((i) => old[i]);
}

function turnOnce(state, name) {
  const move = MOVES[name];
  if (!move) return;
  if (move.spin) spinFace(state, move.spin);

  const strips = move.cycle;
  const carried = strips[strips.length - 1].map((spot) => at(state, spot));
  for (let i = strips.length - 1; i > 0; i--) {
    strips[i].forEach((spot, j) => put(state, spot, at(state, strips[i - 1][j])));
  }
  strips[0].forEach((spot, j) => put(state, spot, carried[j]));
}

/** Apply one move token, like R, U', Rw2, M, x. Unknown tokens are ignored. */
export function applyMove(state, token) {
  const parsed = /^([A-Za-z])(w?)('|2|')?$/.exec(token);
  if (!parsed) return state;
  let base = parsed[1];
  const wide = parsed[2] === 'w';
  const suffix = parsed[3] || '';
  const times = suffix === '2' ? 2 : suffix === "'" ? 3 : 1;

  if (wide) base = base.toLowerCase();
  const parts = DERIVED[base] || [[base, 1]];
  parts.forEach(([name, count]) => {
    const total = (count * times) % 4;
    for (let i = 0; i < total; i++) turnOnce(state, name);
  });
  return state;
}

export const tokensOf = (sequence) => (sequence || '').trim().split(/\s+/).filter(Boolean);

/** A fresh cube with the whole sequence applied. */
export function afterSequence(sequence, from) {
  const state = from ? clone(from) : solved();
  tokensOf(sequence).forEach((token) => applyMove(state, token));
  return state;
}

/* -- drawing --------------------------------------------------------------
   The usual unfolded net, so every face is visible at once:

           U
       L   F   R   B
           D                                                              */

const LAYOUT = { U: [3, 0], L: [0, 3], F: [3, 3], R: [6, 3], B: [9, 3], D: [3, 6] };

export function netSvg(state, cell = 13) {
  const inset = cell * 0.09;
  const width = 12 * cell;
  const height = 9 * cell;
  let squares = '';

  for (const face of Object.keys(LAYOUT)) {
    const [col, row] = LAYOUT[face];
    for (let i = 0; i < 9; i++) {
      const x = (col + (i % 3)) * cell + inset;
      const y = (row + Math.floor(i / 3)) * cell + inset;
      const side = cell - inset * 2;
      squares += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" `
        + `width="${side.toFixed(2)}" height="${side.toFixed(2)}" `
        + `rx="${(cell * 0.14).toFixed(2)}" fill="${COLOURS[state[face][i]]}"/>`;
    }
  }
  return `<svg class="cube-net" viewBox="0 0 ${width} ${height}" `
    + `xmlns="http://www.w3.org/2000/svg" role="img" `
    + `aria-label="The cube, unfolded">`
    + `<g stroke="rgba(0,0,0,.45)" stroke-width="${(cell * 0.05).toFixed(2)}">`
    + squares + `</g></svg>`;
}

/** Which events this drawing is honest about. */
export const CAN_DRAW = new Set(['333', '333oh']);
