import { scrambleFor, EVENTS, EVENT_LIST, minimumFor } from './scramble.js';
import { LEVELS, NOTATION } from './learn.js';
import { afterSequence, cubeSvg, solved, applyMove, tokensOf, inverseOf,
         clone, EVENT_SIZE } from './cube.js';

/* ------------------------------------------------------------------ state */

const DNF = -1, OK = 0, PLUS2 = 2;
const READY_MS = 350;            // how long to hold before the timer arms
const STORE = 'cube.session.v1';
const AUTH = 'cube.auth.v1';

const state = {
  event: localStorage.getItem('cube.event') || '333',
  scramble: '',
  session: JSON.parse(localStorage.getItem(STORE) || '[]'),
  token: localStorage.getItem(AUTH) || '',
  user: null,
  shop: {},
  inspection: localStorage.getItem('cube.inspection') === '1',
  demo: false,
  level: 'beginner',
};

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function saveSession() {
  localStorage.setItem(STORE, JSON.stringify(state.session.slice(-500)));
}

/* ------------------------------------------------------------- formatting */

function fmt(ms, pen = OK) {
  if (pen === DNF) return 'DNF';
  if (ms == null) return '—';
  const total = ms + (pen === PLUS2 ? 2000 : 0);
  const mins = Math.floor(total / 60000);
  const secs = (total % 60000) / 1000;
  const body = mins
    ? `${mins}:${secs.toFixed(3).padStart(6, '0')}`
    : secs.toFixed(3);
  return pen === PLUS2 ? body + '+' : body;
}

function splitTime(ms) {
  const s = fmt(ms);
  const dot = s.lastIndexOf('.');
  return dot < 0 ? [s, ''] : [s.slice(0, dot), s.slice(dot)];
}

/* ------------------------------------------------------------------ stats */

const effective = (s) => (s.pen === DNF ? null : s.ms + (s.pen === PLUS2 ? 2000 : 0));

function averageOf(solves, n) {
  if (solves.length < n) return null;
  const window = solves.slice(-n).map(effective);
  const dnfs = window.filter((t) => t === null).length;
  if (dnfs > 1) return null;
  const filled = window.filter((t) => t !== null).sort((a, b) => a - b);
  const kept = dnfs === 1 ? filled.slice(1) : filled.slice(1, -1);
  return Math.round(kept.reduce((a, b) => a + b, 0) / (n - 2));
}

function meanOf(solves) {
  const times = solves.map(effective).filter((t) => t !== null);
  if (!times.length) return null;
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
}

function bestSingle(solves) {
  const times = solves.map(effective).filter((t) => t !== null);
  return times.length ? Math.min(...times) : null;
}

const forEvent = () => state.session.filter((s) => s.event === state.event);

/* -------------------------------------------------------------------- api */

async function api(action, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch('/api/' + action, { ...options, headers });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const post = (action, body) => api(action, { method: 'POST', body: JSON.stringify(body) });

let toastTimer;
function toast(message, bad = false, action = null) {
  const node = $('toast');
  node.textContent = '';
  node.appendChild(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.onclick = () => { node.hidden = true; clearTimeout(toastTimer); action.run(); };
    node.appendChild(button);
  }
  node.classList.toggle('bad', bad);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, action ? 7000 : 2600);
}

/* ------------------------------------------------------------------ timer */

let phase = 'idle';          // idle | inspect | hold | ready | run
let wasInspecting = false;
let holdTimer = null;
let startedAt = 0;
let inspectStart = 0;
let raf = 0;
let lastSolve = null;

function setTime(text, fracFrom) {
  if (fracFrom === undefined) { $('time').textContent = text; return; }
  const [whole, frac] = splitTime(fracFrom);
  $('time').innerHTML = `${esc(whole)}<span class="frac">${esc(frac)}</span>`;
}

function setPhase(next) {
  phase = next;
  const pad = $('pad');
  pad.classList.toggle('is-holding', next === 'hold');
  pad.classList.toggle('is-ready', next === 'ready');
  pad.classList.toggle('is-running', next === 'run');
  document.body.classList.toggle('timing', next === 'run');
}

function hint(text) { $('hint').innerHTML = text; }

const IDLE_HINT = 'Hold <kbd>space</kbd> — or press and hold here';

function tick() {
  if (phase === 'run') {
    setTime(null, performance.now() - startedAt);
    if (racing()) paintRaceStrip();
    raf = requestAnimationFrame(tick);
  } else if (phase === 'inspect' || phase === 'hold' || phase === 'ready') {
    if (wasInspecting) {
      const left = 15 - (performance.now() - inspectStart) / 1000;
      if (left > 0) setTime(Math.ceil(left).toString());
      else if (left > -2) setTime('+2');
      else setTime('DNF');
    }
    raf = requestAnimationFrame(tick);
  }
}

function pressDown() {
  if (phase === 'run') { stopSolve(); return; }
  if (phase === 'hold' || phase === 'ready') return;

  if (phase === 'idle' && state.inspection) {
    wasInspecting = true;
    inspectStart = performance.now();
    setPhase('inspect');
    hint('Inspecting — hold to get ready');
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    return;
  }

  $('after').hidden = true;
  setPhase('hold');
  if (!wasInspecting) setTime('0.000');
  hint('Keep holding…');
  holdTimer = setTimeout(() => {
    if (phase === 'hold') { setPhase('ready'); hint('Release to start'); }
  }, READY_MS);
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function pressUp() {
  clearTimeout(holdTimer);
  if (phase === 'ready') { startSolve(); return; }
  if (phase === 'hold') {
    setPhase(wasInspecting ? 'inspect' : 'idle');
    hint(wasInspecting ? 'Inspecting — hold to get ready' : IDLE_HINT);
  }
}

/* Whatever you have equipped from the store, played once, when a solve lands.
   `host` lets the store preview one on its own card instead of the timer. */
function playFinish(style = wearing('finish'), host = $('pad')) {
  ['finish-pulse', 'finish-flash', 'finish-shake', 'finish-glow']
    .forEach((c) => host.classList.remove(c));
  if (style === 'none') return;
  if (style === 'confetti') { throwConfetti(); return; }

  const applied = 'finish-' + style;
  void host.offsetWidth;             // restart the animation if it is replayed
  host.classList.add(applied);
  // A timeout rather than animationend: a hidden element never fires the
  // event, and the class would then stick around forever.
  setTimeout(() => host.classList.remove(applied), 1000);
}

function throwConfetti() {
  const colours = ['#ff5f6d', '#ffc371', '#47e08b', '#4facfe', '#b06bff', '#ffe066'];
  for (let i = 0; i < 26; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const angle = (Math.PI * (0.15 + Math.random() * 0.7));
    const distance = 140 + Math.random() * 220;
    piece.style.background = colours[i % colours.length];
    piece.style.setProperty('--dx', `${Math.cos(angle) * distance * (Math.random() < .5 ? -1 : 1)}px`);
    piece.style.setProperty('--dy', `${Math.sin(angle) * distance + 120}px`);
    piece.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
    piece.style.setProperty('--spin', `${1.1 + Math.random() * 0.8}s`);
    piece.style.left = `${45 + Math.random() * 10}%`;
    document.body.appendChild(piece);
    piece.addEventListener('animationend', () => piece.remove(), { once: true });
  }
}

function abortSolve() {
  if (phase === 'idle') return;
  clearTimeout(holdTimer);
  cancelAnimationFrame(raf);
  wasInspecting = false;
  setPhase('idle');
  setTime('0.000');
  hint(IDLE_HINT);
  $('after').hidden = true;
  toast('Cancelled — nothing recorded.');
}

function startSolve() {
  setPhase('run');
  hint('');
  startedAt = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function inspectionPenalty() {
  if (!wasInspecting) return OK;
  const used = (startedAt - inspectStart) / 1000;
  if (used > 17) return DNF;
  if (used > 15) return PLUS2;
  return OK;
}

function stopSolve() {
  const ms = Math.round(performance.now() - startedAt);
  const pen = inspectionPenalty();
  setPhase('idle');
  cancelAnimationFrame(raf);
  wasInspecting = false;
  hint(IDLE_HINT);

  const floor = minimumFor(state.event);
  if (ms < floor) {          // faster than anyone alive: a misclick, not a solve
    setTime('0.000');
    $('after').hidden = true;
    toast(`Not counted — ${EVENTS[state.event]} solves under `
      + `${(floor / 1000).toFixed(2)}s don't count.`);
    return;
  }
  setTime(null, ms);

  lastSolve = {
    id: crypto.randomUUID ? crypto.randomUUID().slice(0, 16) : Math.random().toString(16).slice(2, 18),
    ms, pen,
    event: state.event,
    scramble: state.scramble,
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  state.session.push(lastSolve);
  saveSession();
  $('after').hidden = false;
  renderTimer();
  playFinish();
  nextScramble();
  uploadSolve(lastSolve);
  maybeSubmitDaily(lastSolve);
  submitRaceFinish(lastSolve);
}

async function uploadSolve(solve) {
  if (!state.token) return;
  try {
    const data = await post('solve', solve);
    state.user = data.user;
    applyCosmetics();
    renderYou();
    if (data.records && data.records.length) {
      const names = { single: 'single', ao5: 'ao5', ao12: 'ao12' };
      toast(`Personal record: ${data.records.map((r) => names[r]).join(', ')}! +${data.earned} cubies`);
    }
  } catch (err) {
    // Stays in localStorage; it will go up on the next sync.
  }
}

async function removeSolve(id) {
  const index = state.session.findIndex((s) => s.id === id);
  if (index < 0) return;
  const [solve] = state.session.splice(index, 1);
  if (lastSolve && lastSolve.id === id) {
    lastSolve = null;
    $('after').hidden = true;
    if (phase === 'idle') setTime('0.000');   // stop showing a solve that is gone
  }
  saveSession();
  renderTimer();
  toast(`Removed ${fmt(solve.ms, solve.pen)}.`, false,
    { label: 'Undo', run: () => restoreSolve(solve, index) });

  if (!state.token) return;
  try {
    const data = await post('unsolve', { id });
    state.user = data.user;
    renderYou();
  } catch (err) {
    // Never reached the server, so there is nothing there to take back.
  }
}

async function restoreSolve(solve, index) {
  if (state.session.some((s) => s.id === solve.id)) return;
  state.session.splice(index, 0, solve);
  saveSession();
  renderTimer();
  if (phase === 'idle') {
    lastSolve = solve;
    if (solve.pen === DNF) setTime('DNF');
    else setTime(null, solve.ms);
    $('after').hidden = false;
  }
  toast(`Put ${fmt(solve.ms, solve.pen)} back.`);
  if (!state.token) return;
  try {
    const data = await post('sync', { solves: [solve] });
    state.user = data.user;
    renderYou();
  } catch (err) {
    toast('Restored here, but the server did not get it. Try Sync this device.', true);
  }
}

function applyPenalty(kind) {
  if (!lastSolve) return;
  if (kind === 'del') {
    setTime('0.000');
    removeSolve(lastSolve.id);
    return;
  }
  lastSolve.pen = kind;
  if (kind === DNF) setTime('DNF');
  else setTime(null, lastSolve.ms);
  saveSession();
  renderTimer();
  if (state.token) uploadPenalty(lastSolve);
}

async function uploadPenalty(solve) {
  // The server keeps its own copy, so re-send it under the same id.
  try {
    await post('unsolve', { id: solve.id });
    const data = await post('sync', { solves: [solve] });
    state.user = data.user;
    renderYou();
  } catch (err) {
    // Local record still stands; a manual sync will reconcile it.
  }
}

/* --------------------------------------------------------------- scramble */

function nextScramble() {
  state.scramble = scrambleFor(state.event);
  $('scramble').textContent = state.scramble;
  drawScramble();
}

/* Show what you are actually about to solve, on a cube of the right size. */
function drawScramble() {
  const holder = $('scramble-cube');
  const n = EVENT_SIZE[state.event];
  if (!n) { holder.innerHTML = ''; return; }
  paintCube(holder, afterSequence(state.scramble, null, n));
}

/* Every cube on the page can be dragged around to see the back of it. The
   angle is kept on the element, so a redraw kelps whatever you turned it to. */
/* Looking slightly down on the cube, so you see U, F and R -- the view every
   algorithm is written for. Tilted the other way you get the bottom, which is
   the wrong way round for anything that talks about "the top layer". */
const DEFAULT_VIEW = { yaw: -0.62, pitch: 0.5 };

function viewOf(host) {
  if (!host.__view) host.__view = { ...DEFAULT_VIEW };
  return host.__view;
}

function paintCube(host, cubeState, extra = {}) {
  if (cubeState) host.__state = cubeState;
  const view = viewOf(host);
  // Shop cards force their own style so they can show what they are selling.
  const style = extra.style || wearing('cube_style');
  host.innerHTML = cubeSvg(host.__state, { ...view, ...extra, style });
  if (!host.__draggable) makeDraggable(host);
}

function makeDraggable(host) {
  host.__draggable = true;
  host.classList.add('is-draggable');
  let from = null;

  host.addEventListener('pointerdown', (e) => {
    from = { x: e.clientX, y: e.clientY, ...viewOf(host) };
    host.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  host.addEventListener('pointermove', (e) => {
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    const view = viewOf(host);
    view.yaw = from.yaw + (e.clientX - from.x) * 0.011;
    // Stop short of straight up or down, where the cube would flip over.
    view.pitch = Math.max(-1.45, Math.min(1.45, from.pitch + (e.clientY - from.y) * 0.011));
    paintCube(host, null, host.__extra || {});
  });
  const release = (e) => {
    if (from && e && e.pointerId !== undefined && host.hasPointerCapture(e.pointerId)) {
      host.releasePointerCapture(e.pointerId);
    }
    from = null;
  };
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);
  host.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    host.__view = { ...DEFAULT_VIEW };
    paintCube(host, null, host.__extra || {});
  });
}

/* ------------------------------------------------------------ render: timer */

function renderTimer() {
  const solves = forEvent();
  const best = bestSingle(solves);
  const stats = [
    ['solves', solves.length.toString()],
    ['best', fmt(best)],
    ['ao5', fmt(averageOf(solves, 5))],
    ['ao12', fmt(averageOf(solves, 12))],
    ['mean', fmt(meanOf(solves))],
  ];
  $('stats').innerHTML = stats
    .map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
    .join('');

  $('solves').innerHTML = solves.slice().reverse().map((s, i) => {
    const cls = s.pen === DNF ? 'dnf' : s.pen === PLUS2 ? 'plus2'
      : (effective(s) === best && best !== null ? 'best' : '');
    return `<li class="${cls}" data-id="${esc(s.id)}" role="button" tabindex="0"
      title="Click to remove this solve&#10;${esc(s.scramble)}">${solves.length - i}. ${esc(fmt(s.ms, s.pen))}</li>`;
  }).join('') || '<li class="muted" style="border:0;background:none">No solves yet.</li>';
}

/* ------------------------------------------------------------ render: learn */

function renderLearn() {
  $('level-picker').innerHTML = LEVELS.map((l) =>
    `<button class="mini ${l.id === state.level ? 'is-on' : ''}" data-level="${l.id}">${esc(l.title)}</button>`
  ).join('');

  const level = LEVELS.find((l) => l.id === state.level) || LEVELS[0];
  $('lesson').innerHTML = `
    <div class="panel">
      <h2>${esc(level.title)}</h2>
      <p>${esc(level.blurb)}</p>
      <p class="muted"><strong>Aiming for:</strong> ${esc(level.goal)}</p>
    </div>
    ${level.steps.map((step) => `
      <div class="step">
        <h3>${esc(step.title)}</h3>
        <p>${esc(step.body)}</p>
        ${step.algs.map((a) => `
          <div class="alg" data-moves="${esc(a.moves)}" role="button" tabindex="0"
               title="Click to watch this run on a cube">
            <span class="alg-name">${esc(a.name)}</span>
            <span class="alg-moves">${esc(a.moves)}</span>
            ${a.note ? `<span class="alg-note">${esc(a.note)}</span>` : ''}
          </div>`).join('')}
        ${step.tip ? `<div class="tip">${esc(step.tip)}</div>` : ''}
      </div>`).join('')}
  `;

  paintNotation();
}

/* The notation reference: each symbol next to a cube frozen part-way through
   the move, which says more than any sentence about which layer goes where. */
function paintNotation() {
  const grid = $('notation');
  grid.innerHTML = NOTATION.map((entry, i) => `
    <div class="note-card ${entry.plain ? 'is-face' : ''}">
      <div class="cube-holder note-cube" data-note="${i}"></div>
      <div class="note-text">
        <strong>${esc(entry.symbol)}</strong>
        <span class="note-name">${esc(entry.name)}</span>
        <span class="note-what">${esc(entry.what)}</span>
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-note]').forEach((host) => {
    const entry = NOTATION[+host.dataset.note];
    host.__extra = { turn: { token: entry.demo, progress: 0.34 }, dim: true };
    paintCube(host, solved(), host.__extra);
    host.addEventListener('click', () => playNotation(host, entry.demo));
  });
}

function playNotation(host, token) {
  if (host.__running) return;
  host.__running = true;
  const started = performance.now();
  const span = 700;
  const frame = () => {
    const t = Math.min(1, (performance.now() - started) / span);
    // out and back, so the cube ends where it started and can be replayed
    const swing = t < 0.7 ? t / 0.7 : 1 - (t - 0.7) / 0.3;
    host.__extra = { turn: { token, progress: swing }, dim: true };
    paintCube(host, null, host.__extra);
    if (t < 1) { requestAnimationFrame(frame); return; }
    host.__extra = { turn: { token, progress: 0.34 }, dim: true };
    paintCube(host, null, host.__extra);
    host.__running = false;
  };
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------- racing */
/* Both sides get the same start time from the server and run their own clock
   from it. Polling only carries what changes -- who joined, who is ready, who
   finished -- so an opponent's timer stays smooth even on a slow connection. */

const race = { view: null, poll: null, starter: null, offset: 0,
               submitted: false, armed: false };

/* Server time minus this device's time. Everything shared is in server time. */
function raceStartLocal() {
  if (!race.view || !race.view.start_at) return null;
  return race.view.start_at * 1000 - race.offset;
}

function adoptRace(view) {
  race.offset = view.now * 1000 - Date.now();
  race.view = view;
  renderRace();
  paintRaceStrip();

  if (view.start_at && !race.armed) {
    race.armed = true;
    race.submitted = false;
    state.event = view.event || '333';
    $('event').value = state.event;
    state.scramble = view.scramble;
    $('scramble').textContent = view.scramble;
    drawScramble();
    show('timer');
    runCountdown();
  }
  startRacePolling();
}

async function raceDo(body) {
  try {
    const view = await post('race', body);
    if (view.left) { leaveRaceLocally(); return; }
    adoptRace(view);
  } catch (err) {
    toast(err.message, true);
    if (/no race|finished or never/i.test(err.message)) leaveRaceLocally();
  }
}

function leaveRaceLocally() {
  stopRacePolling();
  clearTimeout(race.starter);
  race.view = null; race.armed = false; race.submitted = false;
  $('race-strip').hidden = true;
  renderRace();
}

function startRacePolling() {
  if (race.poll || !race.view) return;
  race.poll = setInterval(async () => {
    if (!race.view) { stopRacePolling(); return; }
    try {
      const view = await api('race?code=' + encodeURIComponent(race.view.code));
      race.offset = view.now * 1000 - Date.now();
      race.view = view;
      renderRace();
      paintRaceStrip();
      if (view.start_at && !race.armed) adoptRace(view);
      if (view.players.every((p) => p.done)) stopRacePolling();
    } catch (err) {
      leaveRaceLocally();
    }
  }, 900);
}

function stopRacePolling() {
  if (race.poll) { clearInterval(race.poll); race.poll = null; }
}

/* The three seconds between everyone being ready and the timers starting.
   The start is scheduled on a timer rather than driven by the animation
   frames, because a browser pauses those in a background tab -- a racer who
   tabbed away would otherwise never be started at all. The frames only draw
   the digits; and because the clock is measured from the shared start time,
   a late trigger still yields the right elapsed time, it just arrives with
   the timer already part-way along. */
function runCountdown() {
  $('race-strip').hidden = false;
  clearTimeout(race.starter);
  race.starter = setTimeout(beginRaceSolve, Math.max(0, raceStartLocal() - Date.now()));

  const drawDigits = () => {
    if (!racing() || phase === 'run') return;
    const left = (raceStartLocal() - Date.now()) / 1000;
    if (left <= 0) { beginRaceSolve(); return; }
    setTime(Math.ceil(left).toString());
    hint('Get ready…');
    requestAnimationFrame(drawDigits);
  };
  drawDigits();
}

/* Everyone's clock starts from the same shared instant, so a slow request
   cannot hand anybody a head start. */
function beginRaceSolve() {
  clearTimeout(race.starter);
  if (phase === 'run' || !racing() || race.submitted) return;
  wasInspecting = false;
  setPhase('run');
  hint('');
  startedAt = performance.now() - (Date.now() - raceStartLocal());
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

const racing = () => !!(race.view && race.view.start_at);

function paintRaceStrip() {
  const strip = $('race-strip');
  if (!racing()) { strip.hidden = true; return; }
  strip.hidden = false;

  const started = raceStartLocal();
  const running = Math.max(0, Date.now() - started);
  const slowest = Math.max(running, ...race.view.players.map((p) => p.ms || 0), 1);

  strip.innerHTML = `
    <div class="race-head"><span>Race ${esc(race.view.code)}</span>
      <span>${race.view.players.filter((p) => p.done).length} of
        ${race.view.players.length} finished</span></div>
    ${race.view.players.map((p) => {
      const shown = p.done ? p.ms : running;
      const width = Math.min(100, (shown / slowest) * 100);
      return `<div class="race-lane ${p.done ? 'is-done' : ''} ${p.name === race.view.you ? 'is-you' : ''}">
        <span class="who-name">${nameHtml(p.name, p.name_style)}</span>
        <span class="lane-time">${esc(fmt(shown, p.pen))}</span>
        <span class="race-bar"><i style="width:${width}%"></i></span>
      </div>`;
    }).join('')}`;
}

function renderRace() {
  const box = $('race');
  if (!state.token) {
    box.innerHTML = '<p class="muted">Sign in to race.</p>';
    return;
  }
  if (!race.view) {
    box.innerHTML = `
      <div class="join-row">
        <button class="mini" id="race-create">Create a race</button>
        <span class="muted">or</span>
        <input type="text" id="race-code" maxlength="4" placeholder="CODE"
               autocapitalize="characters" autocomplete="off">
        <button class="mini" id="race-join">Join</button>
      </div>`;
    $('race-create').onclick = () => raceDo({ do: 'create' });
    $('race-join').onclick = () => {
      const code = $('race-code').value.trim().toUpperCase();
      if (code.length !== 4) { toast('A race code is four characters.', true); return; }
      raceDo({ do: 'join', code });
    };
    return;
  }

  const view = race.view;
  const me = view.players.find((p) => p.name === view.you);
  const everyoneDone = view.players.every((p) => p.done);
  const waiting = view.players.length < 2;

  box.innerHTML = `
    <p class="muted">Share this code:</p>
    <div class="race-code">${esc(view.code)}</div>
    <div class="daily-scramble">${esc(view.scramble)}</div>
    <ul class="race-players">${view.players.map((p) => `
      <li><span>${nameHtml(p.name, p.name_style)}</span>
        <span class="status ${p.ready ? 'ready' : ''}">${
          p.done ? esc(fmt(p.ms, p.pen)) : p.ready ? 'ready' : 'scrambling…'}</span></li>`).join('')}
    </ul>
    ${everyoneDone ? `<p class="muted">Race over — ${esc(view.players[0].name)} won.</p>` : ''}
    <div class="join-row">
      ${!view.start_at && !waiting && me && !me.ready
        ? '<button class="mini" id="race-ready">My cube is scrambled</button>' : ''}
      ${waiting ? '<span class="muted">Waiting for someone to join…</span>' : ''}
      <button class="mini danger" id="race-leave">${everyoneDone ? 'Done' : 'Leave'}</button>
    </div>`;

  const ready = $('race-ready');
  if (ready) ready.onclick = () => raceDo({ do: 'ready', code: view.code });
  $('race-leave').onclick = () => raceDo({ do: 'leave', code: view.code });
}

async function submitRaceFinish(solve) {
  if (!racing() || race.submitted) return;
  race.submitted = true;
  try {
    const view = await post('race', { do: 'finish', code: race.view.code,
                                      ms: solve.ms, pen: solve.pen });
    race.offset = view.now * 1000 - Date.now();
    race.view = view;
    renderRace();
    paintRaceStrip();
    const place = view.players.findIndex((p) => p.name === view.you) + 1;
    const finished = view.players.filter((p) => p.done).length;
    toast(finished === view.players.length
      ? (place === 1 ? 'You won the race!' : `Race over — you came ${place}.`)
      : `Done in ${fmt(solve.ms, solve.pen)} — waiting on the others.`);
  } catch (err) {
    race.submitted = false;
    toast(err.message, true);
  }
}

/* ------------------------------------------------------- algorithm player */

let player = null;   // { moves, index, state, timer, host }

function stopPlayer() {
  if (player && player.timer) clearInterval(player.timer);
  if (player) {
    player.host.remove();
    player.alg.classList.remove('is-open');
  }
  player = null;
}

function openPlayer(algEl) {
  const sequence = algEl.dataset.moves;
  if (player && player.alg === algEl) { stopPlayer(); return; }
  stopPlayer();

  const host = document.createElement('div');
  host.className = 'alg-player';
  algEl.classList.add('is-open');
  algEl.after(host);

  /* Open on the case rather than a solved cube: an algorithm is an answer,
     and showing the answer first tells you nothing about the question. The
     case is simply the algorithm undone, so playing it through solves it. */
  player = { alg: algEl, host, moves: tokensOf(sequence), index: 0,
             case: afterSequence(inverseOf(sequence)),
             timer: null, turning: false, built: false };
  player.state = clone(player.case);
  paintPlayer();

  host.addEventListener('click', (e) => {
    const what = e.target.dataset && e.target.dataset.player;
    if (!what) return;
    e.stopPropagation();
    if (what === 'step') { pausePlayer(); stepPlayer(); }
    if (what === 'reset') { pausePlayer(); resetPlayer(); }
    if (what === 'play') togglePlay();
  });
}

function resetPlayer() {
  player.index = 0;
  player.turning = false;
  player.state = clone(player.case);
  paintPlayer();
}

/* Turn the layer through its quarter (or half) turn, then commit it. Watching
   the layer move is the whole point -- a cube that jumps between two positions
   tells you nothing about which way it went. */
const TURN_MS = 320;

function stepPlayer() {
  if (!player || player.turning) return false;
  if (player.index >= player.moves.length) { resetPlayer(); return false; }

  const token = player.moves[player.index];
  player.turning = true;
  const started = performance.now();
  const frame = () => {
    if (!player || !player.turning) return;
    const progress = Math.min(1, (performance.now() - started) / TURN_MS);
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    paintPlayer({ token, progress: eased });
    if (progress < 1) { requestAnimationFrame(frame); return; }
    applyMove(player.state, token);
    player.index += 1;
    player.turning = false;
    paintPlayer();
  };
  requestAnimationFrame(frame);
  return true;
}

function pausePlayer() {
  if (player && player.timer) { clearInterval(player.timer); player.timer = null; paintPlayer(); }
}

function togglePlay() {
  if (!player) return;
  if (player.timer) { pausePlayer(); return; }
  if (player.index >= player.moves.length) resetPlayer();
  player.timer = setInterval(() => {
    if (!player) return;
    if (player.index >= player.moves.length && !player.turning) { pausePlayer(); return; }
    stepPlayer();
  }, TURN_MS + 130);
  paintPlayer();
}

function paintPlayer(turn) {
  if (!player) return;
  // Only the cube changes between frames, so the rest is built once.
  if (!player.built) {
    player.host.innerHTML = `<div class="cube-holder player-cube"></div>
      <div class="stage"></div>
      <div class="track"></div>
      <div class="controls">
        <button class="mini" data-player="play"></button>
        <button class="mini" data-player="step">Step</button>
        <button class="mini" data-player="reset">Reset</button>
      </div>`;
    player.cube = player.host.querySelector('.player-cube');
    player.built = true;
  }
  paintCube(player.cube, player.state, turn ? { turn } : {});

  if (turn) return;                    // mid-turn, the labels have not changed
  const solvedNow = player.index >= player.moves.length;
  player.host.querySelector('.stage').textContent =
    solvedNow ? 'solved' : player.index === 0 ? 'the case' : 'part way through';
  player.host.querySelector('.track').innerHTML = player.moves.map((move, i) => {
    const cls = i === player.index ? 'now' : i < player.index ? 'done' : '';
    return `<span class="${cls}">${esc(move)}</span>`;
  }).join('');
  const atEnd = player.index >= player.moves.length;
  player.host.querySelector('[data-player="play"]').textContent =
    player.timer ? 'Pause' : atEnd ? 'Replay' : 'Play';
}

/* ---------------------------------------------------------- render: compete */

async function renderLeaderboard() {
  const event = $('lb-event').value;
  const metric = $('lb-metric').value;
  $('leaderboard').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await api(`leaderboard?event=${encodeURIComponent(event)}&metric=${encodeURIComponent(metric)}`);
    if (!data.rows.length) {
      $('leaderboard').innerHTML = '<p class="muted">Nobody has posted a time for this yet. Be first.</p>';
      return;
    }
    $('leaderboard').innerHTML = `
      <table><thead><tr><th class="rank">#</th><th>Cuber</th><th>${esc(metric)}</th><th>Solves</th></tr></thead>
      <tbody>${data.rows.map((row, i) => `
        <tr class="${state.user && row.name === state.user.name ? 'me' : ''}">
          <td class="rank">${i + 1}</td>
          <td><button class="linky" data-profile="${esc(row.name)}">${nameHtml(row.name, row.name_style)}</button></td>
          <td class="num">${esc(fmt(row.ms))}</td>
          <td class="num">${row.solve_count}</td>
        </tr>`).join('')}</tbody></table>`;
  } catch (err) {
    $('leaderboard').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function renderDaily() {
  $('daily').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await api('daily');
    const standings = data.standings.length ? `
      <table><thead><tr><th class="rank">#</th><th>Cuber</th><th>Time</th></tr></thead>
      <tbody>${data.standings.map((row, i) => `
        <tr class="${state.user && row.name === state.user.name ? 'me' : ''}">
          <td class="rank">${i + 1}</td>
          <td><button class="linky" data-profile="${esc(row.name)}">${nameHtml(row.name, row.name_style)}</button></td>
          <td class="num">${esc(fmt(row.ms, row.pen))}</td>
        </tr>`).join('')}</tbody></table>`
      : '<p class="muted">No entries yet today.</p>';

    const action = !state.token
      ? '<p class="muted">Sign in to race.</p>'
      : data.entered
        ? '<p class="muted">You have raced today. Next scramble at midnight UTC.</p>'
        : `<button class="mini" id="daily-go">Use this scramble on the timer</button>
           <p class="muted">Your next solve on the timer gets submitted.</p>`;

    $('daily').innerHTML = `
      <div class="daily-scramble">${esc(data.scramble)}</div>
      ${action}
      <h3 style="margin-top:1rem;font-size:.9rem">Today (${esc(data.date)})</h3>
      ${standings}`;

    const go = $('daily-go');
    if (go) go.onclick = () => {
      state.event = '333';
      $('event').value = '333';
      state.scramble = data.scramble;
      $('scramble').textContent = data.scramble;
      dailyPending = true;
      show('timer');
      toast('Daily scramble loaded. Your next solve counts.');
    };
  } catch (err) {
    $('daily').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

let dailyPending = false;

async function maybeSubmitDaily(solve) {
  if (!dailyPending || !state.token) return;
  dailyPending = false;
  try {
    const data = await post('daily', solve);
    state.user = data.user;
    const place = data.standings.findIndex((r) => r.name === state.user.name) + 1;
    toast(`Daily battle submitted — currently ${place} of ${data.standings.length}.`);
    renderYou();
  } catch (err) {
    toast(err.message, true);
  }
}

async function showProfile(name) {
  const panel = $('profile-panel');
  panel.hidden = false;
  $('profile-name').innerHTML = nameHtml(name, null);
  $('profile').innerHTML = '<p class="muted">Loading…</p>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const data = await api('profile?name=' + encodeURIComponent(name));
    $('profile-name').innerHTML = nameHtml(data.user.name, (data.user.wearing || {}).name_style);
    const prs = Object.entries(data.user.prs);
    const table = prs.length ? `
      <table><thead><tr><th>Event</th><th>Single</th><th>ao5</th><th>ao12</th></tr></thead>
      <tbody>${prs.map(([event, pr]) => `
        <tr><td>${esc(data.events[event] || event)}</td>
        <td class="num">${esc(fmt(pr.single))}</td>
        <td class="num">${esc(fmt(pr.ao5))}</td>
        <td class="num">${esc(fmt(pr.ao12))}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No records yet.</p>';

    $('profile').innerHTML = `
      <p class="muted">${esc(plural(data.user.solve_count, 'solve'))} · ${data.user.cubies} cubies ·
        ${esc(plural(data.user.daily_wins, 'daily win'))} · joined ${esc((data.user.created || '').slice(0, 10))}</p>
      <h3 style="font-size:.9rem">Personal records</h3>
      ${table}
      <h3 style="font-size:.9rem;margin-top:1rem">Recent solves</h3>
      <ol class="solves">${data.recent.map((s) =>
        `<li class="${s.pen === DNF ? 'dnf' : s.pen === PLUS2 ? 'plus2' : ''}">${esc(fmt(s.ms, s.pen))}</li>`
      ).join('') || '<li class="muted" style="border:0;background:none">None.</li>'}</ol>`;
  } catch (err) {
    $('profile').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

/* -------------------------------------------------------------- render: you */

function renderYou() {
  $('who').innerHTML = state.user
    ? `${nameHtml(state.user.name, wearing('name_style'))} · ${state.demo ? '∞' : state.user.cubies}`
    : 'Sign in';
  $('demo-flag').hidden = !state.demo;

  if (!state.user) {
    $('account').innerHTML = `
      <h2>Sign in or make an account</h2>
      <p class="muted">Solves are saved on this device either way. An account
        adds records, the leaderboard, the daily battle and rewards.</p>
      <label class="field"><span>Name</span>
        <input type="text" id="in-name" autocomplete="username" maxlength="20"></label>
      <label class="field"><span>Password (8+ characters)</span>
        <input type="password" id="in-pass" autocomplete="current-password"></label>
      <div class="row">
        <button class="mini" id="do-login">Sign in</button>
        <button class="mini" id="do-register">Create account</button>
      </div>`;
    $('do-login').onclick = () => auth('login');
    $('do-register').onclick = () => auth('register');
  } else {
    const u = state.user;
    const prs = Object.entries(u.prs);
    $('account').innerHTML = `
      <h2>${nameHtml(u.name, wearing('name_style'))}</h2>
      <p class="muted">${state.demo ? 'unlimited cubies (demo)' : u.cubies + ' cubies'} · ${esc(plural(u.solve_count, 'solve'))} synced ·
        ${esc(plural(u.daily_wins, 'daily win'))}</p>
      ${prs.length ? `<table><thead><tr><th>Event</th><th>Single</th><th>ao5</th><th>ao12</th></tr></thead>
        <tbody>${prs.map(([event, pr]) => `
          <tr><td>${esc(EVENTS[event] || event)}</td>
          <td class="num">${esc(fmt(pr.single))}</td>
          <td class="num">${esc(fmt(pr.ao5))}</td>
          <td class="num">${esc(fmt(pr.ao12))}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No records yet — go do some solves.</p>'}
      <div class="row" style="margin-top:.75rem">
        <button class="mini" id="do-sync">Sync this device</button>
        <button class="mini danger" id="do-logout">Sign out</button>
      </div>`;
    $('do-sync').onclick = syncSession;
    $('do-logout').onclick = () => {
      state.token = ''; state.user = null;
      localStorage.removeItem(AUTH);
      applyCosmetics(); renderYou();
      toast('Signed out. Your solves are still on this device.');
    };
  }
  renderShop();
}

const DEFAULT_WEARING = { theme: 'midnight', font: 'mono', name_style: 'plain', finish: 'none' };

const wearing = (key) => (state.user && state.user.wearing && state.user.wearing[key])
  || DEFAULT_WEARING[key];

/* A cuber's name, styled the way they bought it. Used everywhere a name is
   shown, so other people see your style too -- that is the point of it. */
function nameHtml(name, style) {
  const cls = style && style !== 'plain' ? ` class="name-${esc(style)}"` : '';
  return `<span${cls}>${esc(name)}</span>`;
}

function renderShop() {
  if (!Object.keys(state.shop).length) {
    $('shop').innerHTML = '<p class="muted">Loading the store…</p>';
    return;
  }
  const owned = (state.user && state.user.owned) || {};

  $('shop').innerHTML = Object.entries(state.shop).map(([category, group]) => {
    const have = owned[category] || [DEFAULT_WEARING[category]];
    const current = wearing(category);

    const cards = Object.entries(group.items).map(([id, item]) => {
      const mine = have.includes(id);
      const on = id === current;
      return `<div class="card ${on ? 'is-on' : ''}">
        <strong>${esc(item.name)}</strong>
        ${previewFor(category, id)}
        <button class="mini" data-category="${esc(category)}" data-item="${esc(id)}"
          ${on ? 'disabled' : ''}>
          ${on ? 'In use' : mine ? 'Use' : state.demo ? 'Free' : `${item.cost} cubies`}</button>
      </div>`;
    }).join('');

    return `<div class="shop-group">
      <h3>${esc(group.label)}</h3>
      <p>${esc(group.note)}</p>
      <div class="shop">${cards}</div>
    </div>`;
  }).join('');

  paintSwatches();
}

/* Each card shows the thing itself rather than describing it. */
function previewFor(category, id) {
  if (category === 'theme') return `<div class="swatches" data-swatch="${esc(id)}"></div>`;
  if (category === 'font') return `<div class="preview" data-font-preview="${esc(id)}">12.345</div>`;
  if (category === 'name_style') {
    const name = state.user ? state.user.name : 'your name';
    return `<div class="preview">${nameHtml(name, id)}</div>`;
  }
  if (category === 'finish') return `<div class="preview fx" data-finish-demo="${esc(id)}">tap to see</div>`;
  if (category === 'cube_style') return `<div class="cube-holder shop-cube" data-cube-style="${esc(id)}"></div>`;
  return '';
}

function paintSwatches() {
  // Read each theme's variables off a detached probe, so the swatches cannot
  // drift out of step with the stylesheet.
  document.querySelectorAll('[data-swatch]').forEach((box) => {
    const probe = document.createElement('div');
    probe.dataset.theme = box.dataset.swatch;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const css = getComputedStyle(probe);
    box.innerHTML = ['--bg', '--accent', '--good', '--ink']
      .map((v) => `<i style="background:${css.getPropertyValue(v).trim() || '#888'}"></i>`).join('');
    probe.remove();
  });
  // Font cards render their own sample in the font they are selling: the card
  // sets --timer-font for its own subtree, whatever the page is wearing.
  document.querySelectorAll('[data-font-preview]').forEach((box) => {
    box.parentElement.dataset.font = box.dataset.fontPreview;
  });
  // Cube cards show a real cube built the way that card is selling it.
  document.querySelectorAll('[data-cube-style]').forEach((box) => {
    box.__extra = { style: box.dataset.cubeStyle };
    paintCube(box, afterSequence("R U R' U' F' U F"), box.__extra);
  });
}

function applyCosmetics() {
  const root = document.documentElement;
  root.dataset.theme = wearing('theme');
  root.dataset.font = wearing('font');
}

/* ----------------------------------------------------------- which build? */
/* Hashes the drawing code the browser actually loaded, rather than the code
   the server meant to send. A stale copy left in a cache or on a CDN is the
   one thing that looks exactly like a bug in the app, and this tells the two
   apart at a glance. */
async function buildStamp() {
  try {
    const text = await (await fetch(new URL('./cube.js', import.meta.url))).text();
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    // The rebuilt drawing is the one that stopped the cube looking flat.
    const modern = text.includes('cubiesOf') && text.includes('planMove');
    return { hash: h.toString(16).padStart(8, '0').slice(0, 6), bytes: text.length, modern };
  } catch (_) {
    return null;
  }
}

async function showBuild() {
  const slot = $('build');
  if (!slot) return;
  const stamp = await buildStamp();
  if (!stamp) { slot.textContent = ''; return; }
  slot.textContent = `build ${stamp.hash} · ${stamp.bytes} bytes`
    + (stamp.modern ? '' : ' · OUT OF DATE — reload, or redeploy');
  slot.classList.toggle('stale', !stamp.modern);
}

/* --------------------------------------------------------------- accounts */

async function auth(action) {
  const username = $('in-name').value.trim();
  const password = $('in-pass').value;
  if (!username || !password) { toast('Fill in both fields.', true); return; }
  try {
    const data = await post(action, { username, password });
    state.token = data.token;
    state.user = data.user;
    state.shop = data.shop || {};
    state.demo = !!data.demo;
    localStorage.setItem(AUTH, data.token);
    applyCosmetics();
    renderYou();
    toast(action === 'register' ? `Welcome, ${data.user.name}.` : `Signed in as ${data.user.name}.`);
    syncSession();
  } catch (err) {
    toast(err.message, true);
  }
}

async function syncSession() {
  if (!state.token) return;
  try {
    const data = await post('sync', { solves: state.session.slice(-500) });
    state.user = data.user;
    renderYou();
    const parts = [];
    if (data.added) parts.push(`Synced ${plural(data.added, 'solve')}.`);
    if (data.skipped) parts.push(`Left out ${plural(data.skipped, 'impossible time')}.`);
    toast(parts.join(' ') || 'Everything already synced.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadShop() {
  if (Object.keys(state.shop).length) return;
  try {
    const data = await api('shop');
    state.shop = data.shop || {};
    state.demo = !!data.demo;
    renderShop();
    renderYou();
  } catch (err) {
    // The store just stays out of the way if it cannot be reached.
  }
}

async function restoreSession() {
  if (!state.token) { loadShop(); renderYou(); return; }
  try {
    const data = await api('me');
    state.user = data.user;
    state.shop = data.shop || {};
    state.demo = !!data.demo;
  } catch (err) {
    state.token = '';
    localStorage.removeItem(AUTH);
  }
  loadShop();
  applyCosmetics();
  renderYou();
}

/* ------------------------------------------------------------------ views */

function show(view) {
  if (view !== 'learn') stopPlayer();
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-on', v.id === 'view-' + view));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.view === view));
  if (view === 'compete') { renderDaily(); renderLeaderboard(); renderRace(); }
  if (view === 'learn') renderLearn();
  if (view === 'you') { renderYou(); showBuild(); }
}

/* ------------------------------------------------------------------- wire */

function fillEvents() {
  const options = EVENT_LIST
    .map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  $('event').innerHTML = options;
  $('lb-event').innerHTML = options;
  $('event').value = state.event;
  $('lb-event').value = state.event;
}

function init() {
  fillEvents();
  applyCosmetics();
  nextScramble();
  renderTimer();
  renderLearn();
  restoreSession();
  $('inspection').checked = state.inspection;
  renderRace();
  showBuild();
  setTime('0.000');
  hint(IDLE_HINT);

  $('tabs').onclick = (e) => { if (e.target.dataset.view) show(e.target.dataset.view); };
  $('who').onclick = () => show('you');

  $('event').onchange = (e) => {
    state.event = e.target.value;
    localStorage.setItem('cube.event', state.event);
    nextScramble();
    renderTimer();
  };
  $('new-scramble').onclick = nextScramble;
  $('inspection').onchange = (e) => {
    state.inspection = e.target.checked;
    localStorage.setItem('cube.inspection', state.inspection ? '1' : '0');
  };

  $('after').onclick = (e) => {
    const pen = e.target.dataset.pen;
    if (pen === undefined) return;
    applyPenalty(pen === 'del' ? 'del' : parseInt(pen, 10));
  };

  $('solves').addEventListener('click', (e) => {
    const item = e.target.closest('li[data-id]');
    if (item) removeSolve(item.dataset.id);
  });
  $('solves').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('li[data-id]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    removeSolve(item.dataset.id);
  });

  $('clear-session').onclick = () => {
    if (!forEvent().length) return;
    if (!confirm('Clear the solves shown for this event? Synced records are kept.')) return;
    state.session = state.session.filter((s) => s.event !== state.event);
    saveSession();
    renderTimer();
  };

  // timer input
  const pad = $('pad');
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); pad.focus(); pressDown(); });
  pad.addEventListener('pointerup', (e) => { e.preventDefault(); pressUp(); });
  pad.addEventListener('pointercancel', pressUp);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    if (e.code === 'Escape') { e.preventDefault(); abortSolve(); return; }
    if (phase === 'run') { e.preventDefault(); stopSolve(); return; }
    if (e.code === 'Space') { e.preventDefault(); pressDown(); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    e.preventDefault();
    pressUp();
  });

  // learn
  $('lesson').addEventListener('click', (e) => {
    const alg = e.target.closest('.alg');
    if (alg) openPlayer(alg);
  });
  $('lesson').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const alg = e.target.closest('.alg');
    if (!alg) return;
    e.preventDefault();
    openPlayer(alg);
  });

  $('level-picker').onclick = (e) => {
    if (!e.target.dataset.level) return;
    state.level = e.target.dataset.level;
    stopPlayer();
    renderLearn();
  };

  // compete
  $('lb-event').onchange = renderLeaderboard;
  $('lb-metric').onchange = renderLeaderboard;
  document.addEventListener('click', (e) => {
    const name = e.target.dataset && e.target.dataset.profile;
    if (name) showProfile(name);
  });

  // shop
  $('shop').addEventListener('click', async (e) => {
    // Preview a finish animation without owning it -- window shopping.
    const demo = e.target.closest('[data-finish-demo]');
    if (demo) { playFinish(demo.dataset.finishDemo, demo.closest('.card')); return; }

    const button = e.target.closest('[data-item]');
    if (!button) return;
    const { category, item } = button.dataset;

    if (!state.user) {
      toast('Sign in to earn cubies and unlock these.', true);
      return;
    }
    const owned = (state.user.owned[category] || []).includes(item);
    try {
      const data = await post(owned ? 'equip' : 'buy', { category, item });
      state.user = data.user;
      applyCosmetics();
      renderYou();
      renderTimer();
      if (category === 'cube_style') drawScramble();
      if (category === 'finish') playFinish(item, button.closest('.card'));
      toast(owned ? 'Equipped.' : `Unlocked ${state.shop[category].items[item].name}!`);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

init();
