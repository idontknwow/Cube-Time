"""
The Cube Timer's API when it is running on Vercel.

Vercel does not run server.py -- there is no long-lived process, and the
filesystem is read-only. So this module reuses every bit of the real logic out
of server.py and swaps only the two functions that touch disk, keeping the
database in Vercel Blob storage instead. One source of truth, two transports.

Environment variables (set these in the Vercel dashboard):

  BLOB_READ_WRITE_TOKEN  added automatically when you attach a Blob store.
                         Without it nothing can be saved and the site says so.
  CUBE_SECRET            optional; anything long and random. Signs sign-in
                         tokens. Set it, or everyone is signed out whenever
                         Vercel starts a fresh instance.
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from urllib.parse import urlparse, parse_qs

# server.py lives one directory up, and defines everything worth reusing.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

BLOB_API = "https://blob.vercel-storage.com"
DB_PREFIX = "cubetimer/"


def find_blob_token():
    """Vercel names this BLOB_READ_WRITE_TOKEN for the first store connected to
    a project, and something else for any store after that. Take the plain name
    if it is there, otherwise recognise a Blob token by its own prefix."""
    token = os.environ.get("BLOB_READ_WRITE_TOKEN", "")
    if token:
        return token
    for name, value in os.environ.items():
        if name.endswith("_READ_WRITE_TOKEN") and value.startswith("vercel_blob_rw_"):
            return value
    for value in os.environ.values():
        if value.startswith("vercel_blob_rw_"):
            return value
    return ""


TOKEN = find_blob_token()
API_VERSIONS = [os.environ.get("BLOB_API_VERSION", "7"), "6", "4"]


class BlobError(Exception):
    pass


def storage_advice(exc):
    """Turn a raw storage error into something worth reading."""
    raw = str(exc)
    if not TOKEN:
        return ("No Blob store is connected, so nothing can be saved. In the "
                "Vercel dashboard open Storage, create a Blob store, connect "
                "it to this project, then redeploy.")
    if "403" in raw or "401" in raw:
        return ("Storage rejected the token. Reconnect the Blob store to this "
                "project in the Vercel dashboard and redeploy.")
    if "404" in raw:
        return "The Blob store could not be found. Reconnect it and redeploy."
    return "Storage refused it: %s" % raw


# -- talking to Blob storage -----------------------------------------------

def _send(req, timeout=30):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read()
        return json.loads(body.decode("utf-8")) if body else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise BlobError("%s %s" % (exc.code, detail))
    except Exception as exc:                       # network, timeout, bad JSON
        raise BlobError(str(exc))


def _auth(req, version):
    req.add_header("authorization", "Bearer " + TOKEN)
    req.add_header("x-api-version", version)
    return req


def blob_put(pathname, data, content_type, max_age=60):
    last = None
    for version in API_VERSIONS:
        req = urllib.request.Request(
            BLOB_API + "/" + urllib.parse.quote(pathname), data=data, method="PUT")
        _auth(req, version)
        req.add_header("x-content-type", content_type)
        req.add_header("content-type", content_type)
        req.add_header("x-add-random-suffix", "0")
        req.add_header("x-allow-overwrite", "1")
        req.add_header("x-cache-control-max-age", str(max_age))
        try:
            return _send(req, timeout=60)
        except BlobError as exc:
            last = str(exc)
            if "version" in last.lower():
                continue                           # try an older API version
            raise
    raise BlobError(last or "save refused")


def blob_list(prefix):
    req = urllib.request.Request(
        BLOB_API + "?limit=1000&prefix=" + urllib.parse.quote(prefix))
    _auth(req, API_VERSIONS[0])
    return _send(req).get("blobs", [])


def blob_delete(urls):
    if not urls:
        return
    req = urllib.request.Request(
        BLOB_API + "/delete", data=json.dumps({"urls": urls}).encode(), method="POST")
    _auth(req, API_VERSIONS[0])
    req.add_header("content-type", "application/json")
    _send(req)


def http_get(url):
    req = urllib.request.Request(url, headers={"user-agent": "cube-timer"})
    with urllib.request.urlopen(req, timeout=20) as res:
        return res.read().decode("utf-8")


# -- the database ----------------------------------------------------------
# Every save writes a brand new blob and every read takes the newest one, so
# nobody is ever served a stale copy out of the CDN.

def load_db():
    empty = {"users": {}, "daily": {}}
    if not TOKEN:
        return empty
    try:
        blobs = [b for b in blob_list(DB_PREFIX)
                 if b.get("pathname", "").endswith(".json")]
        if not blobs:
            return empty
        newest = max(blobs, key=lambda b: b.get("pathname", ""))
        db = json.loads(http_get(newest["url"]))
    except (BlobError, ValueError, OSError):
        return empty
    if not isinstance(db, dict):
        return empty
    db.setdefault("users", {})
    db.setdefault("daily", {})
    return db


def save_db(db):
    if not TOKEN:
        raise server.ApiError(503, storage_advice(BlobError("no token")))
    name = "%s%013d-%s.json" % (DB_PREFIX, int(time.time() * 1000), uuid.uuid4().hex[:6])
    try:
        blob_put(name, json.dumps(db).encode("utf-8"), "application/json")
    except BlobError as exc:
        raise server.ApiError(503, storage_advice(exc))
    try:                                    # keep the last few, drop the rest
        old = sorted(blob_list(DB_PREFIX), key=lambda b: b.get("pathname", ""))[:-3]
        blob_delete([b["url"] for b in old])
    except BlobError:
        pass


# Swap the two functions that touch disk. Everything else in server.py -- the
# accounts, the statistics, the store, the daily battle -- is used unchanged.
server.load_db = load_db
server.save_db = save_db

# server.run() is what normally sets this, and it never runs here.
_secret = os.environ.get("CUBE_SECRET") or (
    hashlib.sha256(("cube-timer/" + TOKEN).encode()).hexdigest() if TOKEN else "")
if not _secret:
    _secret = uuid.uuid4().hex          # last resort: valid, but only until
    _secret += uuid.uuid4().hex         # this instance is recycled
server.SECRET = _secret.encode("utf-8")


class handler(server.Handler):
    """Vercel hands each request to this. Static files never reach it -- they
    are served straight from public/ -- so only the API lives here."""

    protocol_version = "HTTP/1.0"

    def handle_static(self, route):
        self.send_json({"error": "Not found."}, 404)

    def dispatch(self, method):
        # vercel.json rewrites /api/<action> to /api/index?action=<action>
        url = urlparse(self.path)
        query = parse_qs(url.query)
        action = (query.get("action") or [""])[0]
        try:
            db = load_db()
            result = self.handle_api(method, action, query, db)
            self.send_json(result)
        except server.ApiError as err:
            self.send_json({"error": err.message}, err.status)
        except BrokenPipeError:
            pass
        except Exception as err:
            self.send_json({"error": "Server error: %s" % err}, 500)
