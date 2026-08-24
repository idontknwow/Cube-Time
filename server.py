#!/usr/bin/env python3
"""
Cube Timer - a small, dependency-free speedcubing timer, tutor and leaderboard.

Run:  python3 server.py
      python3 server.py --port 8080

Everything lives in data/db.json. No pip installs, no build step.
"""

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import random
import re
import secrets
import socket
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public")
DATA_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "db.json")
SECRET_PATH = os.path.join(DATA_DIR, "secret.txt")

MAX_JSON = 512 * 1024          # 512 KB per API call
TOKEN_TTL = 60 * 60 * 24 * 30  # stay signed in for 30 days
SOLVE_CAP = 2000               # solves kept per user
DNF = -1                       # penalty codes
OK, PLUS2 = 0, 2

_lock = threading.RLock()

EVENTS = {
    "333": "3x3",
    "222": "2x2",
    "444": "4x4",
    "333oh": "3x3 One-Handed",
}

# A time this fast is a stopped-too-early misclick, not a solve. The records
# differ enormously between events, so a single flat floor is no good -- 5s
# would throw away most legitimate 2x2 solves. Keep in step with MIN_SOLVE in
# public/scramble.js, which gives the same answer before a solve is even saved.
MIN_SOLVE = {
    "333": 5000,      # deliberately strict; the world record is 3.13s
    "333oh": 5000,    # world record 5.66s
    "222": 400,       # world record 0.43s -- 2x2 really is this fast
    "444": 10000,     # world record 15.71s
}
FALLBACK_MIN = 5000

# Demo mode: everything in the store is free, so ideas can be tried on without
# grinding for cubies first. Off unless asked for, because switching it on for
# a public site makes every reward meaningless. Turn it on with
# `python3 server.py --demo`, or CUBE_DEMO=1 in the environment.
DEMO = os.environ.get("CUBE_DEMO") == "1"

RACE_TTL = 60 * 60          # a race is forgotten an hour after it was made
RACE_COUNTDOWN = 3.0        # seconds between everyone being ready and GO
RACE_MAX = 8
RACE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no O/0, no I/1


def minimum_for(event):
    return MIN_SOLVE.get(event, FALLBACK_MIN)

# Themes buyable with cubies. "midnight" is free and always owned.
# The store. Each category has one free default that everybody owns, so a new
# account is never staring at a wall of locked things. The server only knows
# ids, names and prices -- what a font or an animation actually looks like is
# entirely the stylesheet's business, so adding a cosmetic is two small edits.
SHOP = {
    "theme": {
        "label": "Themes",
        "note": "The colours of the whole app.",
        "items": {
            "midnight": {"name": "Midnight", "cost": 0},
            "sunrise":  {"name": "Sunrise", "cost": 150},
            "matrix":   {"name": "Matrix", "cost": 300},
            "paper":    {"name": "Paper", "cost": 300},
            "ultra":    {"name": "Ultraviolet", "cost": 600},
        },
    },
    "font": {
        "label": "Timer fonts",
        "note": "How the big number looks while you solve.",
        "items": {
            "mono":       {"name": "Monospace", "cost": 0},
            "typewriter": {"name": "Typewriter", "cost": 100},
            "geometric":  {"name": "Geometric", "cost": 150},
            "rounded":    {"name": "Rounded", "cost": 150},
            "serif":      {"name": "Bookish", "cost": 200},
            "heavy":      {"name": "Heavyweight", "cost": 250},
            "marker":     {"name": "Marker", "cost": 400},
        },
    },
    "name_style": {
        "label": "Name styles",
        "note": "How your name shows on the leaderboard, for everyone to see.",
        "items": {
            "plain":   {"name": "Plain", "cost": 0},
            "gold":    {"name": "Gold", "cost": 200},
            "shadow":  {"name": "Embossed", "cost": 250},
            "outline": {"name": "Outlined", "cost": 300},
            "neon":    {"name": "Neon", "cost": 350},
            "rainbow": {"name": "Rainbow", "cost": 500},
        },
    },
    "cube_style": {
        "label": "Cubes",
        "note": "What the cube in the app is made of.",
        "items": {
            "stickered": {"name": "Stickered", "cost": 0},
            "speedcube": {"name": "Speedcube", "cost": 450},
        },
    },
    "finish": {
        "label": "Finish animations",
        "note": "What happens the moment you stop the timer.",
        "items": {
            "none":     {"name": "Nothing", "cost": 0},
            "pulse":    {"name": "Pulse", "cost": 120},
            "flash":    {"name": "Flash", "cost": 150},
            "shake":    {"name": "Shake", "cost": 150},
            "glow":     {"name": "Glow", "cost": 250},
            "confetti": {"name": "Confetti", "cost": 500},
        },
    },
}

# The free default for each category, and therefore what every account starts
# with equipped and owned.
DEFAULT_COSMETICS = {
    category: next(item for item, spec in group["items"].items() if spec["cost"] == 0)
    for category, group in SHOP.items()
}


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def _atomic_write(path, text):
    tmp = path + ".tmp-" + secrets.token_hex(4)
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (IOError, ValueError):
        return default


def normalise_db(db):
    """Fill in every collection the app expects to find.

    Both transports run this -- the one here and the Vercel adapter, which
    loads from Blob storage instead of a file. Adding a collection to one and
    forgetting the other is how racing reached the live site raising
    KeyError: 'races' on the first click, so there is one copy of it now.
    """
    if not isinstance(db, dict):
        db = {}
    db.setdefault("users", {})
    db.setdefault("daily", {})
    db.setdefault("races", {})
    return db


DEFAULT_DB = normalise_db({})


def load_db():
    return normalise_db(read_json(DB_PATH, None))


def save_db(db):
    os.makedirs(DATA_DIR, exist_ok=True)
    _atomic_write(DB_PATH, json.dumps(db, indent=1, ensure_ascii=False))


def server_secret():
    """A stable key for signing tokens. Generated on first run."""
    env = os.environ.get("CUBE_SECRET")
    if env:
        return env.encode("utf-8")
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
        if value:
            return value.encode("utf-8")
    value = secrets.token_hex(32)
    _atomic_write(SECRET_PATH, value)
    try:
        os.chmod(SECRET_PATH, 0o600)
    except OSError:
        pass
    return value.encode("utf-8")


SECRET = None  # set in run()


# --------------------------------------------------------------------------
# accounts
# --------------------------------------------------------------------------

NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,20}$")


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    rounds = 120000
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), rounds
    ).hex()
    return {"salt": salt, "hash": digest, "rounds": rounds}


def verify_password(password, record):
    if not isinstance(record, dict):
        return False
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        record.get("salt", "").encode("utf-8"),
        int(record.get("rounds", 120000)),
    ).hex()
    return hmac.compare_digest(digest, record.get("hash", ""))


def make_token(username):
    payload = "%s:%d" % (username, int(time.time()))
    sig = hmac.new(SECRET, payload.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    return payload + ":" + sig


def token_user(token):
    """Return the username a token belongs to, or None."""
    if not token or token.count(":") != 2:
        return None
    username, issued, sig = token.split(":")
    payload = "%s:%s" % (username, issued)
    want = hmac.new(SECRET, payload.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, want):
        return None
    try:
        if time.time() - int(issued) > TOKEN_TTL:
            return None
    except ValueError:
        return None
    return username


def new_user(username, password):
    user = {
        "name": username,
        "pw": hash_password(password),
        "created": now_iso(),
        "cubies": 0,
        "wearing": dict(DEFAULT_COSMETICS),
        "owned": {c: [i] for c, i in DEFAULT_COSMETICS.items()},
        "prs": {},        # event -> {single, ao5, ao12}
        "solves": [],     # newest last
        "daily_wins": 0,
    }
    return user


def migrate_user(user):
    """Bring an account made before the store had categories up to date."""
    owned = user.get("owned")
    if isinstance(owned, list):          # used to be a flat list of theme ids
        user["owned"] = {"theme": sorted(set(owned) | {DEFAULT_COSMETICS["theme"]})}
    if not isinstance(user.get("owned"), dict):
        user["owned"] = {}
    if "wearing" not in user:
        user["wearing"] = {}
    if "theme" in user:                  # used to be a bare top-level field
        user["wearing"].setdefault("theme", user.pop("theme"))

    for category, default in DEFAULT_COSMETICS.items():
        have = user["owned"].setdefault(category, [])
        if default not in have:
            have.insert(0, default)
        chosen = user["wearing"].get(category)
        if chosen not in SHOP[category]["items"] or chosen not in have:
            user["wearing"][category] = default

    # Records banked before the minimums existed have to go too, or an
    # impossible time keeps its place on the leaderboard forever.
    solves = user.get("solves", [])
    keep = [s for s in solves if s.get("ms", 0) >= minimum_for(s.get("event", "333"))]
    if len(keep) != len(solves):
        user["solves"] = keep
        for event in EVENTS:
            recompute_prs(user, event)
    return user


def public_user(user, full=False):
    migrate_user(user)
    out = {
        "name": user["name"],
        "created": user.get("created", ""),
        "cubies": user.get("cubies", 0),
        "wearing": user.get("wearing", {}),
        "prs": user.get("prs", {}),
        "solve_count": len(user.get("solves", [])),
        "daily_wins": user.get("daily_wins", 0),
    }
    if full:
        out["owned"] = user.get("owned", {})
    return out


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today_key():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# scrambles (server-side, for the shared daily battle)
# --------------------------------------------------------------------------

FACES_333 = ["U", "D", "L", "R", "F", "B"]
OPPOSITE = {"U": "D", "D": "U", "L": "R", "R": "L", "F": "B", "B": "F"}
SUFFIX = ["", "'", "2"]


def scramble_333(rng, length=20):
    moves, last, before = [], None, None
    while len(moves) < length:
        face = rng.choice(FACES_333)
        if face == last:
            continue
        if face == before and OPPOSITE.get(last) == face:
            continue
        moves.append(face + rng.choice(SUFFIX))
        before, last = last, face
    return " ".join(moves)


def daily_scramble(date_key):
    """Same scramble for everyone, every day, derived from the date."""
    seed = int(hashlib.sha256(("cube-timer/" + date_key).encode()).hexdigest()[:12], 16)
    return scramble_333(random.Random(seed))


# --------------------------------------------------------------------------
# stats
# --------------------------------------------------------------------------

def effective_ms(solve):
    """A solve's counting time, or None for a DNF."""
    pen = solve.get("pen", OK)
    if pen == DNF:
        return None
    return solve["ms"] + (2000 if pen == PLUS2 else 0)


def average_of(solves, n):
    """WCA average: drop best and worst, mean the rest. None if not possible."""
    if len(solves) < n:
        return None
    window = solves[-n:]
    times = [effective_ms(s) for s in window]
    dnfs = times.count(None)
    if dnfs > 1:
        return None
    filled = [t for t in times if t is not None]
    if dnfs == 1:
        # the DNF is the discarded worst; drop only the best
        filled.sort()
        return round(sum(filled[1:]) / (n - 2))
    filled.sort()
    return round(sum(filled[1:-1]) / (n - 2))


def best_single(solves):
    times = [effective_ms(s) for s in solves]
    times = [t for t in times if t is not None]
    return min(times) if times else None


def recompute_prs(user, event):
    """Rebuild PRs for one event from that event's solve history.

    Built fresh rather than updated in place: when a solve is removed the
    records have to be allowed to get worse again, or a deleted misclick
    would leave its impossible time standing on the leaderboard forever.
    """
    solves = [s for s in user.get("solves", []) if s.get("event", "333") == event]
    prs = {}
    single = best_single(solves)
    if single is not None:
        prs["single"] = single
    for n in (5, 12):
        best = None
        for i in range(n, len(solves) + 1):
            avg = average_of(solves[:i], n)
            if avg is not None and (best is None or avg < best):
                best = avg
        if best is not None:
            prs["ao%d" % n] = best
    everything = user.setdefault("prs", {})
    if prs:
        everything[event] = prs
    else:
        everything.pop(event, None)
    return prs


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "CubeTimer/1.0"
    protocol_version = "HTTP/1.1"

    head_only = False

    def log_message(self, fmt, *args):
        pass  # quiet by default

    # ---- plumbing ----------------------------------------------------

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not self.head_only:
            self.wfile.write(body)

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Bad Content-Length.")
        if length > MAX_JSON:
            raise ApiError(413, "That request was too large.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "Could not read that request.")
        if not isinstance(data, dict):
            raise ApiError(400, "Expected a JSON object.")
        return data

    def current_user(self, db):
        header = self.headers.get("Authorization") or ""
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        name = token_user(token)
        if not name:
            return None
        return db["users"].get(name.lower())

    def require_user(self, db):
        user = self.current_user(db)
        if not user:
            raise ApiError(401, "Please sign in again.")
        return user

    def serve_file(self, path):
        if not os.path.isfile(path):
            self.send_error(404, "Not found")
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(path, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not self.head_only:
            self.wfile.write(body)

    # ---- routing -----------------------------------------------------

    def do_GET(self):
        self.head_only = False
        self.dispatch("GET")

    def do_POST(self):
        self.head_only = False
        self.dispatch("POST")

    def do_HEAD(self):
        self.head_only = True
        self.dispatch("GET")

    def dispatch(self, method):
        url = urlparse(self.path)
        route = url.path
        try:
            if route.startswith("/api/"):
                with _lock:
                    db = load_db()
                    result = self.handle_api(method, route[5:], parse_qs(url.query), db)
                self.send_json(result)
                return
            self.handle_static(route)
        except ApiError as err:
            self.send_json({"error": err.message}, err.status)
        except BrokenPipeError:
            pass
        except Exception as err:  # never drop the connection on a bug
            # Name the type: a bare KeyError prints only the key, and
            # "Server error: 'races'" tells nobody anything.
            self.send_json({"error": "Server error: %s: %s"
                            % (type(err).__name__, err)}, 500)

    def handle_static(self, route):
        if route in ("/", ""):
            route = "/index.html"
        target = os.path.normpath(os.path.join(PUBLIC_DIR, route.lstrip("/")))
        if not target.startswith(PUBLIC_DIR):
            self.send_error(403, "Forbidden")
            return
        if not os.path.isfile(target):
            # Fall back to the app shell only for page-like paths; a missing
            # script or stylesheet should say so rather than return HTML.
            if os.path.splitext(target)[1]:
                self.send_error(404, "Not found")
                return
            target = os.path.join(PUBLIC_DIR, "index.html")
        self.serve_file(target)

    # ---- api ---------------------------------------------------------

    def handle_api(self, method, action, query, db):
        if method == "GET":
            if action == "leaderboard":
                return self.api_leaderboard(query, db)
            if action == "profile":
                return self.api_profile(query, db)
            if action == "daily":
                return self.api_daily_get(db)
            if action == "me":
                user = self.require_user(db)
                return {"user": public_user(user, full=True), "shop": SHOP, "demo": DEMO}
            if action == "shop":
                return {"shop": SHOP, "demo": DEMO}
            if action == "race":
                return self.api_race_get(query, db)
            raise ApiError(404, "Unknown endpoint.")

        body = self.read_json_body()
        if action == "register":
            return self.api_register(body, db)
        if action == "login":
            return self.api_login(body, db)
        if action == "solve":
            return self.api_solve(body, db)
        if action == "unsolve":
            return self.api_unsolve(body, db)
        if action == "sync":
            return self.api_sync(body, db)
        if action == "daily":
            return self.api_daily_post(body, db)
        if action == "forget":
            return self.api_forget(body, db)
        if action == "race":
            return self.api_race(body, db)
        if action == "buy":
            return self.api_buy(body, db)
        if action == "equip":
            return self.api_equip(body, db)
        raise ApiError(404, "Unknown endpoint.")

    def api_register(self, body, db):
        name = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not NAME_RE.match(name):
            raise ApiError(400, "Names are 3-20 letters, numbers, dot, dash or underscore.")
        if len(password) < 8:
            raise ApiError(400, "Use a password of at least 8 characters.")
        if name.lower() in db["users"]:
            raise ApiError(409, "That name is taken.")
        user = new_user(name, password)
        db["users"][name.lower()] = user
        save_db(db)
        return {"token": make_token(name), "user": public_user(user, full=True),
                "shop": SHOP, "demo": DEMO}

    def api_login(self, body, db):
        name = (body.get("username") or "").strip()
        password = body.get("password") or ""
        user = db["users"].get(name.lower())
        if not user or not verify_password(password, user.get("pw")):
            raise ApiError(401, "Wrong name or password.")
        return {"token": make_token(user["name"]), "user": public_user(user, full=True),
                "shop": SHOP, "demo": DEMO}

    def api_solve(self, body, db):
        user = self.require_user(db)
        solve = self.clean_solve(body)
        event = solve["event"]
        before = dict(user.get("prs", {}).get(event, {}))
        user.setdefault("solves", []).append(solve)
        del user["solves"][:-SOLVE_CAP]
        after = recompute_prs(user, event)

        earned, beaten = 1, []
        for key in ("single", "ao5", "ao12"):
            if key in after and (key not in before or after[key] < before[key]):
                beaten.append(key)
                earned += 25 if key == "single" else 15
        user["cubies"] = user.get("cubies", 0) + earned
        save_db(db)
        return {
            "user": public_user(user, full=True),
            "earned": earned,
            "records": beaten,
        }

    def api_unsolve(self, body, db):
        """Take a solve back off the record - a misclick, a bumped timer."""
        user = self.require_user(db)
        solve_id = (body.get("id") or "")[:32]
        solves = user.get("solves", [])
        removed = next((s for s in solves if s.get("id") == solve_id), None)
        if removed is None:
            raise ApiError(404, "No such solve.")
        user["solves"] = [s for s in solves if s.get("id") != solve_id]
        recompute_prs(user, removed.get("event", "333"))
        # hand back the cubie the solve earned, so delete/undo nets out at zero
        user["cubies"] = max(0, user.get("cubies", 0) - 1)
        save_db(db)
        return {"user": public_user(user, full=True), "removed": removed}

    def api_sync(self, body, db):
        """Upload a batch of solves recorded while signed out."""
        user = self.require_user(db)
        raw = body.get("solves")
        if not isinstance(raw, list):
            raise ApiError(400, "Expected a list of solves.")
        if len(raw) > 500:
            raise ApiError(400, "Sync at most 500 solves at a time.")
        known = set(s.get("id") for s in user.get("solves", []))
        added, events = 0, set()
        skipped = 0
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                solve = self.clean_solve(item)
            except ApiError:
                skipped += 1      # one impossible time must not block the rest
                continue
            if solve["id"] in known:
                continue
            known.add(solve["id"])
            user.setdefault("solves", []).append(solve)
            events.add(solve["event"])
            added += 1
        user["solves"].sort(key=lambda s: s.get("at", ""))
        del user["solves"][:-SOLVE_CAP]
        for event in events:
            recompute_prs(user, event)
        user["cubies"] = user.get("cubies", 0) + added
        save_db(db)
        return {"user": public_user(user, full=True), "added": added,
                "skipped": skipped}

    def clean_solve(self, body):
        try:
            ms = int(body.get("ms"))
        except (TypeError, ValueError):
            raise ApiError(400, "A solve needs a time in milliseconds.")
        event = body.get("event") or "333"
        if event not in EVENTS:
            raise ApiError(400, "Unknown event.")
        floor = minimum_for(event)
        if ms < floor:
            raise ApiError(400, "%s solves under %.2f seconds do not count - "
                                "that is a misclick, not a solve."
                                % (EVENTS[event], floor / 1000.0))
        if ms > 60 * 60 * 1000:
            raise ApiError(400, "That time is out of range.")
        pen = body.get("pen", OK)
        if pen not in (OK, PLUS2, DNF):
            pen = OK
        scramble = (body.get("scramble") or "")[:200]
        return {
            "id": (body.get("id") or secrets.token_hex(8))[:32],
            "ms": ms,
            "pen": pen,
            "event": event,
            "scramble": scramble,
            "at": (body.get("at") or now_iso())[:32],
        }

    def api_leaderboard(self, query, db):
        event = (query.get("event") or ["333"])[0]
        metric = (query.get("metric") or ["single"])[0]
        if event not in EVENTS:
            raise ApiError(400, "Unknown event.")
        if metric not in ("single", "ao5", "ao12"):
            raise ApiError(400, "Unknown metric.")
        rows = []
        for user in db["users"].values():
            migrate_user(user)
            value = user.get("prs", {}).get(event, {}).get(metric)
            if value is None:
                continue
            rows.append({
                "name": user["name"],
                "ms": value,
                "name_style": user.get("wearing", {}).get("name_style", "plain"),
                "solve_count": len(user.get("solves", [])),
            })
        rows.sort(key=lambda r: r["ms"])
        return {"event": event, "metric": metric, "rows": rows[:100], "events": EVENTS}

    def api_profile(self, query, db):
        name = (query.get("name") or [""])[0].strip().lower()
        user = db["users"].get(name)
        if not user:
            raise ApiError(404, "No cuber by that name.")
        recent = [
            {"ms": s["ms"], "pen": s.get("pen", OK), "event": s.get("event", "333"),
             "scramble": s.get("scramble", ""), "at": s.get("at", "")}
            for s in user.get("solves", [])[-12:]
        ]
        recent.reverse()
        return {"user": public_user(user), "recent": recent, "events": EVENTS}

    # ---- daily battle -------------------------------------------------

    def daily_today(self, db):
        key = today_key()
        daily = db["daily"].get(key)
        if not daily:
            daily = {"date": key, "scramble": daily_scramble(key), "entries": {}}
            db["daily"][key] = daily
            for old in sorted(db["daily"])[:-14]:   # keep two weeks
                db["daily"].pop(old, None)
        return daily

    def daily_view(self, daily, me=None, db=None):
        rows = []
        users = (db or {}).get("users", {})
        for name, entry in daily["entries"].items():
            wearing = users.get(name, {}).get("wearing", {})
            rows.append({"name": entry.get("name", name), "ms": entry["ms"],
                         "pen": entry.get("pen", OK),
                         "name_style": wearing.get("name_style", "plain")})
        rows.sort(key=lambda r: (r["pen"] == DNF, r["ms"] + (2000 if r["pen"] == PLUS2 else 0)))
        return {
            "date": daily["date"],
            "scramble": daily["scramble"],
            "standings": rows,
            "entered": bool(me and me["name"].lower() in daily["entries"]),
        }

    def api_daily_get(self, db):
        daily = self.daily_today(db)
        me = self.current_user(db)
        save_db(db)
        return self.daily_view(daily, me, db)

    def api_daily_post(self, body, db):
        user = self.require_user(db)
        daily = self.daily_today(db)
        key = user["name"].lower()
        if key in daily["entries"]:
            raise ApiError(409, "You have already raced today. Come back tomorrow.")
        solve = self.clean_solve(body)
        daily["entries"][key] = {"name": user["name"], "ms": solve["ms"],
                                 "pen": solve["pen"], "at": solve["at"]}
        user["cubies"] = user.get("cubies", 0) + 10
        view = self.daily_view(daily, user, db)
        if view["standings"] and view["standings"][0]["name"] == user["name"]:
            user["daily_wins"] = user.get("daily_wins", 0) + 1
        save_db(db)
        view["user"] = public_user(user, full=True)
        return view

    # ---- racing --------------------------------------------------------
    # Both sides are handed the same start time and run their own clock from
    # it, so an opponent's timer stays smooth without polling for every tick.
    # Polling only carries the things that actually change: who joined, who is
    # ready, and who finished.

    def races(self, db):
        cutoff = time.time() - RACE_TTL
        for code in [c for c, r in db["races"].items() if r.get("created", 0) < cutoff]:
            db["races"].pop(code, None)
        return db["races"]

    def race_view(self, race, me=None):
        players = []
        for entry in race["players"].values():
            players.append({
                "name": entry["name"],
                "ready": bool(entry.get("ready")),
                "ms": entry.get("ms"),
                "pen": entry.get("pen", OK),
                "done": entry.get("ms") is not None,
                "name_style": entry.get("name_style", "plain"),
            })
        players.sort(key=lambda p: (not p["done"], p["ms"] if p["done"] else 0, p["name"]))
        return {
            "code": race["code"],
            "scramble": race["scramble"],
            "event": race.get("event", "333"),
            "host": race.get("host", ""),
            "start_at": race.get("start_at"),
            "now": time.time(),
            "players": players,
            "you": me["name"] if me else None,
        }

    def api_forget(self, body, db):
        """Delete your own account, and only ever your own.

        Signing in is not enough on its own -- the name has to be typed back,
        so a stray request cannot take an account with it.
        """
        user = self.require_user(db)
        key = user["name"].lower()
        if (body.get("confirm") or "").strip().lower() != key:
            raise ApiError(400, "Confirm with the account's own name to delete it.")

        db["users"].pop(key, None)
        # and out of everything still pointing at them
        for day in db.get("daily", {}).values():
            day.get("entries", {}).pop(key, None)
        for code, race in list(db.get("races", {}).items()):
            race.get("players", {}).pop(key, None)
            if not race.get("players"):
                db["races"].pop(code, None)
        save_db(db)
        return {"deleted": user["name"]}

    def api_race_get(self, query, db):
        code = (query.get("code") or [""])[0].strip().upper()
        race = self.races(db).get(code)
        if not race:
            raise ApiError(404, "That race has finished or never existed.")
        save_db(db)
        return self.race_view(race, self.current_user(db))

    def api_race(self, body, db):
        user = self.require_user(db)
        migrate_user(user)
        doing = body.get("do")
        races = self.races(db)
        key = user["name"].lower()

        if doing == "create":
            for code, race in list(races.items()):     # only one race at a time
                if key in race["players"]:
                    race["players"].pop(key, None)
                    if not race["players"]:
                        races.pop(code, None)
            code = self.fresh_code(races)
            races[code] = {
                "code": code,
                "scramble": scramble_333(random.Random()),
                "event": "333",
                "host": user["name"],
                "created": time.time(),
                "start_at": None,
                "players": {key: self.race_player(user)},
            }
            save_db(db)
            return self.race_view(races[code], user)

        code = (body.get("code") or "").strip().upper()
        race = races.get(code)
        if not race:
            raise ApiError(404, "No race with that code.")

        if doing == "join":
            if key not in race["players"]:
                if race.get("start_at"):
                    raise ApiError(409, "That race has already started.")
                if len(race["players"]) >= RACE_MAX:
                    raise ApiError(409, "That race is full.")
                race["players"][key] = self.race_player(user)
        elif doing == "ready":
            if key not in race["players"]:
                raise ApiError(403, "Join the race first.")
            race["players"][key]["ready"] = True
            everyone = list(race["players"].values())
            if len(everyone) >= 2 and all(p.get("ready") for p in everyone) \
                    and not race.get("start_at"):
                race["start_at"] = time.time() + RACE_COUNTDOWN
        elif doing == "finish":
            entry = race["players"].get(key)
            if entry is None:
                raise ApiError(403, "You are not in that race.")
            started = race.get("start_at")
            if not started or time.time() < started:
                raise ApiError(409, "The race has not started yet.")
            if entry.get("ms") is not None:
                raise ApiError(409, "You have already finished.")
            solve = self.clean_solve(dict(body, event=race.get("event", "333")))
            # A time longer than the race has been running cannot be real. It
            # catches a clock that has drifted as readily as someone trying it on.
            elapsed = (time.time() - started) * 1000 + 1500
            if solve["ms"] > elapsed:
                raise ApiError(400, "That is longer than the race has been running.")
            entry["ms"] = solve["ms"]
            entry["pen"] = solve["pen"]
            entry["done_at"] = time.time()
        elif doing == "leave":
            race["players"].pop(key, None)
            if not race["players"]:
                races.pop(code, None)
                save_db(db)
                return {"left": True}
        else:
            raise ApiError(400, "Unknown race action.")

        save_db(db)
        return self.race_view(race, user)

    def race_player(self, user):
        return {
            "name": user["name"],
            "ready": False,
            "ms": None,
            "pen": OK,
            "name_style": user.get("wearing", {}).get("name_style", "plain"),
        }

    def fresh_code(self, races):
        for _ in range(40):
            code = "".join(secrets.choice(RACE_ALPHABET) for _ in range(4))
            if code not in races:
                return code
        raise ApiError(503, "Could not find a free race code. Try again.")

    # ---- shop ---------------------------------------------------------

    def find_item(self, body):
        category = body.get("category")
        item = body.get("item")
        if category not in SHOP or item not in SHOP[category]["items"]:
            raise ApiError(400, "No such item.")
        return category, item

    def api_buy(self, body, db):
        user = self.require_user(db)
        migrate_user(user)
        category, item = self.find_item(body)
        owned = user["owned"].setdefault(category, [])
        if item in owned:
            raise ApiError(409, "You already own that.")
        cost = 0 if DEMO else SHOP[category]["items"][item]["cost"]
        if user.get("cubies", 0) < cost:
            raise ApiError(402, "Not enough cubies yet.")
        user["cubies"] -= cost
        owned.append(item)
        user["wearing"][category] = item      # wear it straight away
        save_db(db)
        return {"user": public_user(user, full=True)}

    def api_equip(self, body, db):
        user = self.require_user(db)
        migrate_user(user)
        category, item = self.find_item(body)
        if item not in user["owned"].get(category, []):
            raise ApiError(403, "You do not own that yet.")
        user["wearing"][category] = item
        save_db(db)
        return {"user": public_user(user, full=True)}


# --------------------------------------------------------------------------
# run
# --------------------------------------------------------------------------

def lan_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def run(port, host, demo=False):
    global SECRET, DEMO
    DEMO = DEMO or demo
    SECRET = server_secret()
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(DB_PATH):
        save_db(load_db())
    httpd = ThreadingHTTPServer((host, port), Handler)
    print("\n  Cube Timer is running.\n")
    if DEMO:
        print("    DEMO MODE - everything in the store is free.")
        print("    Do not run a public site this way.\n")
    print("    on this Mac:   http://localhost:%d" % port)
    print("    on your phone: http://%s:%d   (same Wi-Fi)" % (lan_ip(), port))
    print("\n  Press Control-C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cube Timer server")
    # PORT lets a launcher pick the port; --port still wins if given.
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 8000))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--demo", action="store_true",
                        help="make everything in the store free, for trying ideas out")
    args = parser.parse_args()
    run(args.port, args.host, args.demo)
