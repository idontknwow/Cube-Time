# Cube Timer

A speedcubing timer, tutorial and leaderboard that runs on your own Mac.
No Node, no npm, no build step — system Python and vanilla JavaScript only.

## Running it

Double-click `start.command`, or:

    python3 server.py

Then open <http://localhost:8000>. The startup message also prints a
`http://192.168.x.x:8000` address — open that on your phone while it is on the
same Wi-Fi and you get the same app, sized for a phone.

To use a different port:

    python3 server.py --port 8123

## Putting it on the internet (Vercel)

Vercel never runs `server.py` -- there is no long-lived process there, and the
filesystem is read-only. `api/index.py` is the adapter: it reuses every bit of
logic out of `server.py` and swaps only the two functions that touch disk, so
the database lives in Vercel Blob storage instead. There is one source of
truth for the rules, and two ways to serve them.

Deploying:

1. Import the repository in Vercel. `vercel.json` already points the output
   directory at `public/` and routes `/api/*` to the function, so there is
   nothing to configure.
2. **Attach a Blob store**, or nothing can be saved. In the dashboard open
   Storage, create a Blob store, connect it to the project. That sets
   `BLOB_READ_WRITE_TOKEN` for you.
3. Set `CUBE_SECRET` to anything long and random. It signs sign-in tokens.
   Without it everyone is signed out whenever Vercel starts a fresh instance.
4. Redeploy so the new environment variables are picked up.

If you skip step 2 the site still loads and the store is still browsable --
reads just come back empty -- and the first attempt to make an account explains
exactly what is missing rather than failing silently.

**A real limitation.** Serverless instances do not share memory, so the lock
that `server.py` uses on your Mac does not exist on Vercel. The whole database
is one JSON document, read and written whole. If two people finish a solve at
the very same moment, one of those writes can quietly overwrite the other. That
is fine for you and a few friends; it is not fine for a busy public leaderboard.
Outgrowing it means moving to a real database with per-row writes (Vercel
Postgres, or any hosted SQLite), which is a change to storage only -- the rules
in `server.py` would not have to move.

Running it on your own Mac has none of this problem, because there really is
one process with one lock.

## What is in it

**Timer.** Hold space (or press and hold the pad on a phone), release to start,
press anything to stop. Times are measured with `performance.now()` and shown
to the millisecond. Optional 15-second WCA inspection applies +2 and DNF
automatically. Scrambles are generated per event (3x3, 2x2, 4x4, one-handed).
After each solve you can mark it +2, DNF, or delete it.

Misclicks are easy to undo. Press <kbd>Esc</kbd> while the timer is running and
the solve is cancelled without being recorded at all. Any solve already in the
session list can be removed by clicking it, and a toast offers Undo for a few
seconds afterwards. Removing or DNF-ing a solve is pushed to the server too, so
an accidental 0.35-second "record" does not sit on the public leaderboard --
records are rebuilt from what is left, and are allowed to get worse again.
Times too fast to be real are refused outright, because a misclick that lands
on the leaderboard is worse than a lost solve. The floor is per event, since a
single one would be useless -- 5 seconds is a stricter bar than the 3x3 world
record of 3.13s, but ordinary 2x2 solves are faster than that:

| Event | Not counted below | World record |
| --- | --- | --- |
| 3x3 | 5.00s | 3.13s |
| 3x3 one-handed | 5.00s | 5.66s |
| 2x2 | 0.40s | 0.43s |
| 4x4 | 10.00s | 15.71s |

The browser refuses these before saving anything and the server refuses them
again, so a hand-written request cannot get one through either. Records banked
before the floors existed are dropped the next time the account is read, and
the personal best is recalculated from what is left. If you change the numbers,
change them in both `MIN_SOLVE` tables -- `server.py` and `public/scramble.js`.

Session statistics use the WCA rules: ao5 and ao12 drop the best and worst
solve and mean the rest, and a single DNF counts as the discarded worst.

**Learn.** Three levels. Beginner is the full seven-step layer-by-layer method.
Intermediate is the CFOP skeleton — F2L, 2-look OLL, 2-look PLL. Advanced has
all 21 PLL algorithms, a starting set of full OLL, and practice methodology.
All the content lives in `public/learn.js` as plain data, so it is easy to edit.

**Compete.** A public leaderboard by event and by metric, personal records on
every profile, and a daily battle where everyone gets the same scramble and one
attempt.

**Rewards.** Solving earns cubies — one per solve, 25 for a new best single,
15 for a new best average, 10 for entering the daily battle. Cubies buy
cosmetics in four categories:

- **Themes** — the colours of the whole app.
- **Timer fonts** — the face the big number is set in. System fonts only, so
  nothing is downloaded and it all still works offline.
- **Name styles** — gold, embossed, outlined, neon, rainbow. These travel with
  you: the leaderboard and everyone else's profile view render your name in
  the style you are wearing.
- **Finish animations** — pulse, flash, shake, glow or confetti the moment you
  stop the timer. Tap any card in the store to watch one before buying.

Each category has one free default, so a new account is never looking at a wall
of locked things. Signed-out visitors can browse the whole store.

Adding a cosmetic is two edits: an entry in `SHOP` in `server.py` (id, name,
cost) and a rule in the cosmetics section at the bottom of `public/styles.css`.
The server only ever stores which id you are wearing — what it looks like is
entirely the stylesheet's business.

## Demo mode

Trying out ideas is miserable if you have to grind for cubies first, so:

    python3 server.py --demo

Everything in the store is free, the header shows a `DEMO` badge and your
cubie count reads as unlimited. Nothing else changes -- solves, records and
the leaderboard behave exactly as they normally would, so what you see is what
the real thing will do.

It is off unless you ask for it, and it prints a warning at startup, because a
public site running this way makes every reward in it meaningless. Do not set
`CUBE_DEMO=1` on your Vercel deployment.

## Accounts

Solves are always saved in the browser on the device you used, signed in or
not. An account adds records, the leaderboard, the daily battle and rewards.
Passwords are stored as PBKDF2-SHA256 hashes with a per-user salt. Sign-in
tokens are HMAC-signed and last 30 days.

## Where things live

    server.py           the whole backend: storage, accounts, API
    api/index.py        the same backend on Vercel, storing to Blob
    vercel.json         output directory and /api routing for Vercel
    public/index.html   markup
    public/app.js       timer, statistics, views
    public/scramble.js  scramble generation
    public/learn.js     every lesson, as data
    public/styles.css   layout and the themes
    data/db.json        users, solves, cosmetics  (not in git)
    data/secret.txt     token signing key   (not in git)

Back it up by copying `data/`.

## On timer accuracy

The timer measures with `performance.now()` and displays milliseconds. Browsers
deliberately coarsen that clock — typically to somewhere between 5µs and 1ms —
to prevent timing attacks, so sub-millisecond accuracy is not available to any
web page, this one included. It also would not mean anything: the real error in
a hand-operated timer is the human at both ends, which is tens of milliseconds.
Millisecond display is what serious timers use, and is well past the point where
the hardware stops being the limiting factor.

## Things not built yet

- Live head-to-head racing. The daily battle is asynchronous — same scramble,
  same day, no realtime connection. Real-time versus needs WebSockets and a
  matchmaking queue.
- A cube-state solver, so scrambles cannot be verified or drawn as a diagram.
- Session management (multiple named sessions, import/export).
- Sound packs — an inspection countdown beep and a finish chime would slot into
  the store as a fifth category with no new assets, using the Web Audio API.
- Earned badges (a "sub-20" title next to your name) as opposed to bought ones.
- Withdrawing a daily-battle entry. You get one attempt a day, and removing the
  solve from your session does not take that entry back -- otherwise the daily
  could be retried until it went well.
