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

/* == drawing it in three dimensions =======================================

   The cube sits at the origin, three units across, so every sticker centre
   lands on whole numbers from -1 to 1 and the faces sit at +/-1.5. Each
   sticker is a square in space; we spin the whole lot to face the camera,
   throw away the ones pointing away from it, and paint what is left back
   to front.

   Because a sticker is a real position rather than a cell in a grid, a turn
   can be drawn halfway through simply by spinning the stickers that belong
   to that layer -- which is what makes a move legible at a glance.        */

const HALF = 1.5;

/* For each face: where its middle is, which way it points, and the two
   directions its columns and rows run in. */
const FRAME = {
  U: { at: [0, HALF, 0], normal: [0, 1, 0], col: [1, 0, 0], row: [0, 0, 1] },
  D: { at: [0, -HALF, 0], normal: [0, -1, 0], col: [1, 0, 0], row: [0, 0, -1] },
  F: { at: [0, 0, HALF], normal: [0, 0, 1], col: [1, 0, 0], row: [0, -1, 0] },
  B: { at: [0, 0, -HALF], normal: [0, 0, -1], col: [-1, 0, 0], row: [0, -1, 0] },
  R: { at: [HALF, 0, 0], normal: [1, 0, 0], col: [0, 0, -1], row: [0, -1, 0] },
  L: { at: [-HALF, 0, 0], normal: [-1, 0, 0], col: [0, 0, 1], row: [0, -1, 0] },
};

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

function stickerQuad(face, index) {
  const { at, col, row } = FRAME[face];
  const c = (index % 3) - 1;
  const r = Math.floor(index / 3) - 1;
  const middle = add(add(at, col, c), row, r);
  return {
    middle,
    corners: [
      add(add(middle, col, -0.5), row, -0.5),
      add(add(middle, col, 0.5), row, -0.5),
      add(add(middle, col, 0.5), row, 0.5),
      add(add(middle, col, -0.5), row, 0.5),
    ],
  };
}

const spinX = (p, a) => { const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
const spinY = (p, a) => { const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
const spinZ = (p, a) => { const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; };

const SPIN = { x: spinX, y: spinY, z: spinZ };

/* Which stickers a move takes with it, around which axis, and which way.
   A layer is picked out by where a sticker is, not by any list of indices,
   so a wide turn is just a more generous test. */
export const TURNS = {
  U: { axis: 'y', sign: -1, holds: (p) => p[1] > 0.9 },
  D: { axis: 'y', sign: 1, holds: (p) => p[1] < -0.9 },
  R: { axis: 'x', sign: -1, holds: (p) => p[0] > 0.9 },
  L: { axis: 'x', sign: 1, holds: (p) => p[0] < -0.9 },
  F: { axis: 'z', sign: -1, holds: (p) => p[2] > 0.9 },
  B: { axis: 'z', sign: 1, holds: (p) => p[2] < -0.9 },
  M: { axis: 'x', sign: 1, holds: (p) => Math.abs(p[0]) < 0.9 },
  E: { axis: 'y', sign: 1, holds: (p) => Math.abs(p[1]) < 0.9 },
  S: { axis: 'z', sign: -1, holds: (p) => Math.abs(p[2]) < 0.9 },
  r: { axis: 'x', sign: -1, holds: (p) => p[0] > -0.9 },
  l: { axis: 'x', sign: 1, holds: (p) => p[0] < 0.9 },
  u: { axis: 'y', sign: -1, holds: (p) => p[1] > -0.9 },
  d: { axis: 'y', sign: 1, holds: (p) => p[1] < 0.9 },
  f: { axis: 'z', sign: -1, holds: (p) => p[2] > -0.9 },
  b: { axis: 'z', sign: 1, holds: (p) => p[2] < 0.9 },
  x: { axis: 'x', sign: -1, holds: () => true },
  y: { axis: 'y', sign: -1, holds: () => true },
  z: { axis: 'z', sign: -1, holds: () => true },
};

/** Split a token into the layer it turns and how far, e.g. R2 -> [R, 2]. */
export function readToken(token) {
  const parsed = /^([A-Za-z])(w?)('|2)?$/.exec(token || '');
  if (!parsed) return null;
  let base = parsed[1];
  if (parsed[2] === 'w') base = base.toLowerCase();
  if (!TURNS[base]) return null;
  const quarters = parsed[3] === '2' ? 2 : parsed[3] === "'" ? -1 : 1;
  return { base, quarters };
}

const CAMERA = 11;      // how far back the eye sits
const LENS = 30;        // and how much it magnifies

function project(p) {
  const scale = LENS / (CAMERA - p[2]);
  return [p[0] * scale, -p[1] * scale];
}

/* A light fixed to the camera, so turning the cube shades it the way a real
   one catches the light instead of every face reading flat. */
const LAMP = [0.32, 0.55, 0.77];

function shade(hex, normal) {
  const lit = Math.max(0, normal[0] * LAMP[0] + normal[1] * LAMP[1] + normal[2] * LAMP[2]);
  const k = 0.55 + 0.45 * lit;
  const n = parseInt(hex.slice(1), 16);
  const mix = (v) => Math.round(Math.min(255, v * k));
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

/**
 * Draw the cube.
 *   yaw, pitch  which way it is turned towards you, in radians
 *   turn        { base, quarters, progress } to catch a move mid-flight
 *   dim         fade the stickers the turn does not touch
 */
export function cubeSvg(state, options = {}) {
  const yaw = options.yaw === undefined ? -0.62 : options.yaw;
  const pitch = options.pitch === undefined ? -0.5 : options.pitch;
  const turn = options.turn || null;
  const spec = turn ? TURNS[turn.base] : null;
  const sweep = spec
    ? spec.sign * (turn.quarters || 1) * (Math.PI / 2) * (turn.progress || 0)
    : 0;

  const faces = [];
  for (const face of FACES) {
    for (let i = 0; i < 9; i++) {
      const { middle, corners } = stickerQuad(face, i);
      const moving = spec ? spec.holds(middle) : false;

      const place = (p) => {
        let q = moving ? SPIN[spec.axis](p, sweep) : p;
        return spinX(spinY(q, yaw), pitch);
      };
      const seen = corners.map(place);
      const centre = place(middle);
      let normal = FRAME[face].normal;
      if (moving) normal = SPIN[spec.axis](normal, sweep);
      normal = spinX(spinY(normal, yaw), pitch);

      if (normal[2] <= 0.02) continue;                 // pointing away from us
      faces.push({
        depth: centre[2],
        points: seen.map(project),
        fill: shade(COLOURS[state[face][i]], normal),
        faded: spec && options.dim && !moving,
      });
    }
  }

  faces.sort((a, b) => a.depth - b.depth);             // far ones first

  const body = [];
  const tops = [];
  for (const quad of faces) {
    const outline = quad.points.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    body.push(`<polygon points="${outline}" fill="#0d0d10"/>`);
    const middle = quad.points.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    const inner = quad.points
      .map((p) => [middle[0] + (p[0] - middle[0]) * 0.84, middle[1] + (p[1] - middle[1]) * 0.84])
      .map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    tops.push(`<polygon points="${inner}" fill="${quad.fill}"`
      + ` stroke="${quad.fill}" stroke-width="1.1" stroke-linejoin="round"`
      + (quad.faded ? ' opacity="0.4"' : '') + '/>');
  }

  // Painted in pairs so a nearer sticker's plastic never covers a further one.
  const layers = faces.map((_, i) => body[i] + tops[i]).join('');
  return `<svg class="cube3d" viewBox="-10 -10 20 20" xmlns="http://www.w3.org/2000/svg"`
    + ` role="img" aria-label="A cube you can turn by dragging">${layers}</svg>`;
}

/** Which events this drawing is honest about. */
export const CAN_DRAW = new Set(['333', '333oh']);
