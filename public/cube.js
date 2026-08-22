// A cube of any size, as state plus a move engine, plus a drawing of it.
//
// Stickers are held as six faces of N x N, each index read left-to-right and
// top-to-bottom while looking straight at that face. For a 3x3:
//
//     0 1 2
//     3 4 5
//     6 7 8
//
// A turn does two things: it cycles four strips around the sides, and -- when
// it is the outermost layer -- spins that face's own stickers. Everything
// else (wide turns, slices, whole-cube rotations) is just a different set of
// layer depths through the same machinery, which is why 2x2 and 4x4 come out
// of it for free.

export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

const OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L', F: 'B', B: 'F' };

const COLOURS = {
  U: '#f7f7f7',   // white
  D: '#f5d020',   // yellow
  F: '#22a04c',   // green
  B: '#1f5fd0',   // blue
  R: '#d4342b',   // red
  L: '#ec8118',   // orange
};

/* Stickerless plastic is a little louder than vinyl. */
const SPEED_COLOURS = {
  U: '#fdfdfd', D: '#ffd60a', F: '#0fbe4c',
  B: '#1466ea', R: '#f6362a', L: '#ff8a12',
};

/** How big a cube each event is solved on. */
export const EVENT_SIZE = { '222': 2, '333': 3, '444': 4, '333oh': 3 };

export function solved(n = 3) {
  const state = {};
  FACES.forEach((face) => { state[face] = Array(n * n).fill(face); });
  return state;
}

/** The size of a cube, read back off the state itself. */
export const sizeOf = (state) => Math.round(Math.sqrt(state.U.length));

export const clone = (state) => {
  const copy = {};
  FACES.forEach((face) => { copy[face] = state[face].slice(); });
  return copy;
};

/* -- which stickers a turn moves ------------------------------------------
   A strip is one row or column of a neighbouring face. Contents travel from
   one strip to the next, and from the last back to the first. `depth` counts
   inwards from the face being turned, so depth 0 is the face itself, depth 1
   the layer behind it, and so on.                                          */

const spot = (face, n, r, c) => face + (r * n + c);

function rowOf(face, n, r, backwards) {
  const out = [];
  for (let c = 0; c < n; c++) out.push(spot(face, n, r, c));
  return backwards ? out.reverse() : out;
}

function colOf(face, n, c, backwards) {
  const out = [];
  for (let r = 0; r < n; r++) out.push(spot(face, n, r, c));
  return backwards ? out.reverse() : out;
}

function stripsFor(face, n, depth) {
  const far = n - 1 - depth;
  switch (face) {
    case 'U': return [rowOf('F', n, depth), rowOf('L', n, depth),
                      rowOf('B', n, depth), rowOf('R', n, depth)];
    case 'D': return [rowOf('F', n, far), rowOf('R', n, far),
                      rowOf('B', n, far), rowOf('L', n, far)];
    case 'R': return [colOf('F', n, far), colOf('U', n, far),
                      colOf('B', n, depth, true), colOf('D', n, far)];
    case 'L': return [colOf('U', n, depth), colOf('F', n, depth),
                      colOf('D', n, depth), colOf('B', n, far, true)];
    case 'F': return [rowOf('U', n, far), colOf('R', n, depth),
                      rowOf('D', n, depth, true), colOf('L', n, far, true)];
    case 'B': return [rowOf('U', n, depth, true), colOf('L', n, depth),
                      rowOf('D', n, far), colOf('R', n, far, true)];
    default: return null;
  }
}

const at = (state, where) => state[where[0]][+where.slice(1)];
const put = (state, where, value) => { state[where[0]][+where.slice(1)] = value; };

function spinFace(state, n, face, clockwise) {
  const was = state[face].slice();
  const now = new Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      now[r * n + c] = clockwise
        ? was[(n - 1 - c) * n + r]
        : was[c * n + (n - 1 - r)];
    }
  }
  state[face] = now;
}

function quarterTurn(state, n, face, depth) {
  const strips = stripsFor(face, n, depth);
  if (!strips) return;
  const carried = strips[strips.length - 1].map((where) => at(state, where));
  for (let i = strips.length - 1; i > 0; i--) {
    strips[i].forEach((where, j) => put(state, where, at(state, strips[i - 1][j])));
  }
  strips[0].forEach((where, j) => put(state, where, carried[j]));

  // The outermost layer carries its own face round with it. Turning the layer
  // at the far side is the opposite face turned the other way, which is what
  // makes a whole-cube rotation fall out of "every depth at once".
  if (depth === 0) spinFace(state, n, face, true);
  if (depth === n - 1) spinFace(state, n, OPPOSITE[face], false);
}

/* -- reading a move -------------------------------------------------------- */

const WIDE = { r: 'R', l: 'L', u: 'U', d: 'D', f: 'F', b: 'B' };
const SLICE = { M: 'L', E: 'D', S: 'F' };   // each follows the face it names
const WHOLE = { x: 'R', y: 'U', z: 'F' };

/**
 * Work out what a token actually turns on a cube of this size.
 * Returns { face, depths, quarters } or null if it means nothing here.
 */
export function planMove(token, n = 3) {
  const parsed = /^([A-Za-z])(w?)('|2)?$/.exec(token || '');
  if (!parsed) return null;
  const letter = parsed[1];
  const wide = parsed[2] === 'w';
  const quarters = parsed[3] === '2' ? 2 : parsed[3] === "'" ? -1 : 1;

  let face = null;
  let depths = null;

  if (WHOLE[letter]) {
    face = WHOLE[letter];
    depths = Array.from({ length: n }, (_, i) => i);
  } else if (SLICE[letter]) {
    if (n < 3) return null;                       // a 2x2 has no middle
    face = SLICE[letter];
    depths = [Math.floor(n / 2)];                 // dead centre on odd cubes
    if (n % 2 === 0) depths = [n / 2 - 1, n / 2]; // both inner layers on even
  } else if (WIDE[letter]) {
    face = WIDE[letter];
    depths = [0, 1].filter((d) => d < n);
  } else if (OPPOSITE[letter]) {
    face = letter;
    depths = wide ? [0, 1].filter((d) => d < n) : [0];
  } else {
    return null;
  }
  return { face, depths, quarters };
}

/** Apply one move token. Anything meaningless on this cube is ignored. */
export function applyMove(state, token) {
  const n = sizeOf(state);
  const plan = planMove(token, n);
  if (!plan) return state;
  const times = ((plan.quarters % 4) + 4) % 4;
  for (let i = 0; i < times; i++) {
    plan.depths.forEach((depth) => quarterTurn(state, n, plan.face, depth));
  }
  return state;
}

export const tokensOf = (sequence) => (sequence || '').trim().split(/\s+/).filter(Boolean);

/** A fresh cube with the whole sequence applied. */
export function afterSequence(sequence, from, n = 3) {
  const state = from ? clone(from) : solved(n);
  tokensOf(sequence).forEach((token) => applyMove(state, token));
  return state;
}

/** The same moves undone, in reverse -- which turns an algorithm into its case. */
export const invertToken = (token) =>
  token.endsWith('2') ? token : token.endsWith("'") ? token.slice(0, -1) : token + "'";

export const inverseOf = (sequence) =>
  tokensOf(sequence).reverse().map(invertToken).join(' ');

/* == drawing it =============================================================

   The cube is built as solid cubies rather than loose stickers. That matters
   twice over: a cubie hides what is behind it, so nothing shows through from
   the far side, and when a layer swings out you see the dark inside of the
   cube, which is what makes it read as an object rather than a pattern.

   Cubies are one unit across whatever the size of the cube, and the whole
   thing is scaled to a constant width at the end, so a 2x2 and a 4x4 arrive
   the same size on the page with the pieces looking correspondingly big and
   small.                                                                    */

const STYLES = {
  stickered: { cubie: 0.47, plastic: '#131316', tile: false },
  speedcube: { cubie: 0.452, plastic: '#0f0f12', tile: true },
};

/* For each face: which way it points, and the directions its columns and
   rows run in when you look straight at it. */
const FRAME = {
  U: { normal: [0, 1, 0], col: [1, 0, 0], row: [0, 0, 1] },
  D: { normal: [0, -1, 0], col: [1, 0, 0], row: [0, 0, -1] },
  F: { normal: [0, 0, 1], col: [1, 0, 0], row: [0, -1, 0] },
  B: { normal: [0, 0, -1], col: [-1, 0, 0], row: [0, -1, 0] },
  R: { normal: [1, 0, 0], col: [0, 0, -1], row: [0, -1, 0] },
  L: { normal: [-1, 0, 0], col: [0, 0, 1], row: [0, -1, 0] },
};

/* Which way each face's turn goes, as an axis and a direction. A slice or a
   wide turn borrows the axis of the face it is named after, which is why the
   animation never has to know about them separately. */
const AXIS_OF = { R: 'x', L: 'x', U: 'y', D: 'y', F: 'z', B: 'z' };
const SENSE_OF = { R: -1, L: 1, U: -1, D: 1, F: -1, B: 1 };

const spinX = (p, a) => { const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
const spinY = (p, a) => { const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
const spinZ = (p, a) => { const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; };
const SPIN = { x: spinX, y: spinY, z: spinZ };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const CAMERA = 8.4;            // eye close enough for the near face to loom
const LENS = 21;
const LAMP = [0.3, 0.56, 0.77];   // fixed to the camera, so turning it shades

function shade(hex, normal) {
  const lit = Math.max(0, dot(normal, LAMP));
  const k = 0.5 + 0.5 * lit;
  const n = parseInt(hex.slice(1), 16);
  const mix = (v) => Math.round(Math.min(255, v * k));
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

/** Knock an already-shaded rgb() down, for the chamfer round a moulded face. */
const darken = (rgb, k) => rgb.replace(/\d+/g, (n) => Math.round(+n * k));

/** Every cubie position on an n-cube except the ones sealed inside. */
function cubiesOf(n) {
  const edge = (n - 1) / 2;
  const out = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      for (let c = 0; c < n; c++) {
        const p = [a - edge, b - edge, c - edge];
        const onSkin = Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])) === edge;
        if (onSkin) out.push(p);
      }
    }
  }
  return out;
}

/**
 * Draw the cube.
 *   yaw, pitch  which way it is turned towards you, in radians
 *   turn        { token, progress } to catch a move mid-swing
 *   dim         fade back everything the turn does not carry
 *   style       'stickered' or 'speedcube'
 */
export function cubeSvg(state, options = {}) {
  const n = sizeOf(state);
  const edge = (n - 1) / 2;
  const style = STYLES[options.style] ? options.style : 'stickered';
  const kit = STYLES[style];
  const palette = kit.tile ? SPEED_COLOURS : COLOURS;
  const CUBIE = kit.cubie;
  const PLASTIC = kit.plastic;
  const yaw = options.yaw === undefined ? -0.62 : options.yaw;
  const pitch = options.pitch === undefined ? 0.5 : options.pitch;

  // Everything is drawn at unit-cubie scale, then shrunk to a constant width,
  // so every size of cube lands the same size on the page.
  const zoom = 3 / n;

  const plan = options.turn ? planMove(options.turn.token, n) : null;
  const axis = plan ? AXIS_OF[plan.face] : null;
  const sweep = plan
    ? SENSE_OF[plan.face] * plan.quarters * (Math.PI / 2) * (options.turn.progress || 0)
    : 0;
  const carried = (home) => {
    if (!plan) return false;
    const depth = Math.round(edge - dot(home, FRAME[plan.face].normal));
    return plan.depths.includes(depth);
  };

  const toView = (p, moving) => {
    const q = moving && sweep ? SPIN[axis](p, sweep) : p;
    return spinX(spinY(q, yaw), pitch);
  };
  const project = (p) => {
    const scale = LENS / (CAMERA - p[2] * zoom);
    return [p[0] * zoom * scale, -p[1] * zoom * scale];
  };

  const panels = [];
  for (const home of cubiesOf(n)) {
    const moving = carried(home);
    const seat = toView(home, moving);

    for (const face of FACES) {
      const { normal, col, row } = FRAME[face];
      // Not rounded: on an even cube the edge is a half-integer (0.5 on a 2x2,
      // 1.5 on a 4x4), and rounding would throw the half away.
      const outside = Math.abs(dot(home, normal) - edge) < 1e-6;

      // Every transform here is a rotation about the origin, so a direction
      // can go through the same one as a point.
      const dir = toView(normal, moving);
      if (dir[2] <= 0.001) continue;                  // pointing away from us

      const middle = [
        home[0] + normal[0] * CUBIE,
        home[1] + normal[1] * CUBIE,
        home[2] + normal[2] * CUBIE,
      ];
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => toView([
        middle[0] + col[0] * a * CUBIE + row[0] * b * CUBIE,
        middle[1] + col[1] * a * CUBIE + row[1] * b * CUBIE,
        middle[2] + col[2] * a * CUBIE + row[2] * b * CUBIE,
      ], moving)).map(project);

      let fill = PLASTIC;
      if (outside) {
        const c = Math.round(dot(home, col) + edge);
        const r = Math.round(dot(home, row) + edge);
        fill = shade(palette[state[face][r * n + c]], dir);
      }
      panels.push({ seat: seat[2], corners, fill, outside,
                    faded: plan && options.dim && !moving });
    }
  }

  panels.sort((a, b) => a.seat - b.seat);            // far cubies painted first

  const drawn = panels.map((panel) => {
    const outline = panel.corners
      .map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    if (!panel.outside) return `<polygon points="${outline}" fill="${PLASTIC}"/>`;

    const fade = panel.faded ? ' opacity="0.38"' : '';
    const mid = panel.corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    const pull = (k) => panel.corners
      .map((p) => [mid[0] + (p[0] - mid[0]) * k, mid[1] + (p[1] - mid[1]) * k])
      .map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');

    if (kit.tile) {
      // Stickerless: the piece itself is coloured, right through. What reads as
      // a border on a real one is the moulded edge catching less light, so the
      // face is laid down twice -- a darker chamfer at full size, and the face
      // proper inset within it with the corners taken off.
      const k = 0.86;
      const side = (Math.hypot(panel.corners[1][0] - panel.corners[0][0],
                               panel.corners[1][1] - panel.corners[0][1])
                  + Math.hypot(panel.corners[2][0] - panel.corners[1][0],
                               panel.corners[2][1] - panel.corners[1][1])) / 2;
      return `<polygon points="${outline}" fill="${darken(panel.fill, 0.58)}"${fade}/>`
        + `<polygon points="${pull(k)}" fill="${panel.fill}"`
        + ` stroke="${panel.fill}" stroke-width="${(side * (1 - k)).toFixed(3)}"`
        + ` stroke-linejoin="round"${fade}/>`;
    }

    // Stickered: plastic behind, sticker inset within it, and the gap between
    // them is what draws the dark grid from one sticker to the next.
    return `<polygon points="${outline}" fill="${PLASTIC}"/>`
      + `<polygon points="${pull(0.82)}" fill="${panel.fill}"`
      + ` stroke="${panel.fill}" stroke-width="0.09" stroke-linejoin="round"${fade}/>`;
  }).join('');

  return `<svg class="cube3d" viewBox="-10.5 -10.5 21 21" xmlns="http://www.w3.org/2000/svg"`
    + ` role="img" aria-label="A cube you can turn by dragging">${drawn}</svg>`;
}
