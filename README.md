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

**If the deployed site looks wrong but your Mac looks right, it is almost
certainly serving an older build.** The bottom of the You tab prints which
drawing code the browser actually loaded, and says so in red if it is out of
date. Reload the page first; if it still says so, the deployment has not caught
up -- push again, or redeploy from the Vercel dashboard.

If you skip step 2 the site still loads and the store is still browsable --
reads just come back empty -- and the first attempt to make an account explains
exactly what is missing rather than failing silently.

Racing is really a same-house feature for now. It works over the internet, but
every poll on Vercel costs a round trip to Blob storage, and two racers writing
at the same instant can overwrite each other -- see the limitation below. On
your own Mac it is exactly as quick as it should be.

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

## When the deployment looks wrong

The two things that have actually gone wrong, both of which look like bugs in
the app and are not:

**Friends are asked to sign in to Vercel.** Deployment Protection covers the
whole site, so only you can open it -- which makes a public leaderboard
pointless. Settings -> Deployment Protection -> Vercel Authentication ->
Disabled. Check it in a private window, where you are not signed in to Vercel.

**The site looks like an older version of itself.** The scripts have no version
in their names, so a browser that fetched one before will happily keep it.
`vercel.json` now asks for them to be revalidated every time, but a copy cached
before that went out will still be there: reload the page once with the cache
bypassed (Shift-Reload, or Cmd-Shift-R).

To tell the two apart without guessing, open the **You** tab and look at the
bottom: it prints the build the browser actually loaded, and says OUT OF DATE
in red if it is an old one. That line answers "is this a stale script or a real
bug" in one look, which is otherwise a slow thing to work out.

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
attempt. Whoever is fastest when the day closes takes 50 cubies and a win on
their profile. The day is settled once, after it ends -- leading at the moment
you happen to enter is not winning, which is what it used to count.

**Racing.** Create a race and share the four-character code. Everyone sees the
same scramble in the lobby, scrambles their own cube, and presses ready; three
seconds later every timer starts at once and you watch the other lanes fill as
you solve.

The synchronised start is the whole trick. The server hands every racer the
same start instant, and each browser runs its own clock from it, so a slow
request cannot give anybody a head start and an opponent's timer stays smooth
without asking the server for every tick. Polling carries only what actually
changes -- who joined, who is ready, who finished. A finish is refused before
the countdown ends, and a time longer than the race has been running is
refused too, which catches a drifting clock as readily as someone trying it on.

**A cube you can see, and turn.** The timer draws the scramble as a cube in
three dimensions, so you can check you scrambled it right. Drag any cube to
look at it from another angle; double-click to put it back.

In Learn, every algorithm opens on **the case it solves**, not on a solved cube:
an algorithm is an answer, and showing the answer first tells you nothing about
the question. The case is simply the algorithm undone, so playing it through
solves the cube. It runs one layer swinging round at a time -- watching which
way a layer goes is the whole point, and a picture that jumps between two
positions tells you nothing.

A handful of algorithms begin with a whole-cube rotation, and their case comes
up with a different colour on top. That is not a bug to tidy away: it is the
only orientation those algorithms actually solve, which is checked. And every symbol in the
notation has its own cube, frozen part-way through its own move with the rest
faded back, so you can see at a glance which slab of the cube it takes with it.
Tap one to watch it through.

Every event gets its own cube -- 2x2, 3x3 and 4x4 all draw at the same size on
the page, with the pieces correspondingly big or small.

`public/cube.js` holds all of this. The cube is built as twenty-six little
cubies rather than fifty-four loose stickers, which is what makes it read as a
solid object: a cubie hides what is behind it, and when a layer swings out you
see the dark inside of the cube. Each cubie is six squares -- coloured where it
meets the outside world, plastic everywhere else -- painted furthest-away
first. Sorting whole cubies is what works; sorting loose squares is what goes
wrong once a layer is halfway round.

The engine works on any size. A turn is a set of layer depths through one
piece of machinery -- depth 0 is the face, a wide turn is depths 0 and 1, a
whole-cube rotation is every depth at once -- so 2x2 and 4x4 fall out of the
same code as 3x3 rather than needing their own.

A move can be drawn half-finished because a sticker is a position in space
rather than a cell in a grid: the cubies in that layer are simply spun. The
drawing is checked against the move engine rather than by eye -- a move drawn
at full swing has to put every sticker exactly where the engine says it goes,
across every angle.

**Rewards.** Solving earns cubies — one per solve, 25 for a new best single,
15 for a new best average, 10 for entering the daily battle. Cubies buy
cosmetics in four categories:

- **Themes** — the colours of the whole app.
- **Cubes** — what the cube in the app is made of. The default is stickered:
  black plastic with a coloured square stuck on each face. The speedcube is
  stickerless, so the piece itself is coloured right to its edge, with brighter
  plastic and only the moulded chamfer between one piece and the next.
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
cost) and a rule in the cosmetics section at the bottom of `public/styles.css`
-- except a cube, which is a `STYLES` entry in `public/cube.js`, since it
changes how a face is drawn rather than what colour it is.
The server only ever stores which id you are wearing — what it looks like is
entirely the stylesheet's business.

## Keeping the board honest

Solves that are too fast to be real are refused outright, but a time that
squeaks past the floor still lands on the leaderboard. Name yourself an admin
and you can take those off it:

    CUBE_ADMIN=yourname python3 server.py

or set `CUBE_ADMIN` in the Vercel dashboard for the live site. Several names
can be given, separated by commas. Nobody is an admin unless named there, and
the admin panel on the Compete tab is invisible to everyone else.

It lists the fastest solves recorded, quickest first -- which is exactly where
an implausible one sits -- and marks anything suspiciously close to the floor.
Removing a solve recalculates that person's records from what is left, so the
leaderboard corrects itself.

The same panel can close the day early and draw a fresh scramble, for when a
daily battle is spoiled and waiting until midnight is no use.

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
    public/cube.js      the cube itself: state, moves, and the flat drawing
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
