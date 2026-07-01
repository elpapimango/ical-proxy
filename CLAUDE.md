# CLAUDE.md — iCal Proxy

Context file for Claude Code. Read this before touching anything.

---

## What this is

A Node.js single-file application that runs as a Windows background service.
It downloads one or more remote iCal (`.ics`) feeds on a configurable interval
and re-serves each from localhost over HTTP so that Outlook can subscribe to
them.

Primary use-case: corporate environments where the remote calendar URL is only
reachable via VPN. The proxy caches each feed's last-known-good `.ics` to disk
so Outlook always has something to load even when the VPN is disconnected.

Single calendar (`--url`) is still the common case and stays maximally
backward compatible: Outlook can subscribe to *any* path on the proxy, exactly
like pre-1.3. Multiple calendars (`--url1`/`--url2`/...) each get their own
named route (`--calendarN`, default `calendarN.ics`) — see "Multi-calendar
architecture" below.

---

## File layout

```
ical-proxy.js              # The entire application — one file, no build step
package.json               # Runtime deps: node-windows + node-notifier
CLAUDE.md                  # This file
README.md                  # End-user documentation

# Generated at runtime — never committed
ical-proxy.config.json     # Saved config (calendars[], port, interval, notify)
ical-proxy.cache.ics       # Calendar 1's last successfully fetched iCal body
ical-proxy.cache2.ics      # Calendar 2's disk cache, etc. (one file per calendar 2+)
ical-proxy.log             # Append-only log, shared across all calendars
daemon/                    # Created by node-windows during --install
```

---

## Running locally

```bash
npm install
node ical-proxy.js --url https://example.com/calendar.ics
node ical-proxy.js --url https://example.com/calendar.ics --port 9090 --interval 15
node ical-proxy.js --url1 https://example.com/work.ics --calendar1 work.ics \
                    --url2 https://example.com/family.ics --calendar2 family.ics
node ical-proxy.js --help
```

## Windows service

```bat
# Must be run as Administrator
node ical-proxy.js --install --url https://example.com/calendar.ics --port 8080
node ical-proxy.js --uninstall
```

Service name in Windows SCM: **"iCal Proxy"**

---

## Architecture — single file, five sections

`ical-proxy.js` is intentionally a single file with no transpilation or bundler.
Sections in order:

### 1. Constants
`VERSION`, `APP_NAME`, `CONFIG_FILE`, `LOG_FILE`, `CACHE_FILE`, `MAX_REDIRECTS`,
`FETCH_TIMEOUT`, and the `CONNECTIVITY_ERRORS` Set.

### 2. Logging
`log(level, msg)` → writes to stdout and appends to `ical-proxy.log`.
Three levels via the `logger` object: `info`, `warn`, `error`.

### 3. Argument parser
Minimal hand-rolled parser, no dependencies. Flags: `--url` (alias for
`--url1`), `--url1`/`--url2`/... (regex-matched, one calendar's feed URL
each), `--calendar1`/`--calendar2`/... (regex-matched, that calendar's local
filename), `--port`, `--interval`, `--notify`/`--no-notify`, `--debug`,
`--install`, `--uninstall`, `--help`. `parseArgs` returns `{ urls: {1: url,
2: url, ...}, calendarNames: {1: name, ...}, ...flags }` — indices are kept
exactly as given (a lone `--url3` stays feed #3), never renumbered.

### 4. Config
Three layers in priority order:
1. CLI args (if any `--url`/`--urlN` is present)
2. Saved `ical-proxy.config.json` (fallback for service restarts)
3. Error + help text

`saveConfig` is called whenever a new config is resolved from CLI args so the
Windows service always boots with the correct settings without needing flags.
`cfg.calendars` is `[{ index, url, localName }, ...]`; `loadConfig` migrates
old flat single-calendar config files (`{ url, port, interval }`, no
`calendars` array) into this shape on read — see "Multi-calendar
architecture" below.

### 5. Disk cache
`saveDiskCache(filePath, body)` / `loadDiskCache(filePath)` — synchronous
read/write, parameterized per calendar (calendar 1 uses `CACHE_FILE`
= `ical-proxy.cache.ics` for backward compatibility; calendar N≥2 uses
`ical-proxy.cache<N>.ics`, computed in `createCalendarState`). Called after
every successful network fetch (save) and at the very top of `startServer`
for each calendar before its first network request (load).

### 6. iCal fetcher
`fetchUrl` — raw HTTP/S GET with redirect following (up to `MAX_REDIRECTS`) and
a 30-second socket timeout. No npm dependencies. Calendar-agnostic — takes a
URL and headers, nothing else.

`createCalendarState(index, url, localName)` — builds one calendar's runtime
state: `cache` (body/etag/lastModified/fetchedAt/fromDisk), `cacheFile`,
`lastFetchError`, `networkDown`, `refreshInProgress`/`queuedRefreshCallbacks`.
One instance per configured calendar; `startServer` builds the array once
from `cfg.calendars` and every calendar-scoped operation takes a `state`
object instead of touching module-level globals (see "Multi-calendar
architecture" below).

`refreshIcal(state, done)` — wraps `fetchUrl` with:
- Conditional GET headers (`If-None-Match`, `If-Modified-Since`), read/written on `state.cache`
- Connectivity error classification (see below)
- Disk persistence on success, via `state.cacheFile`
- `state.lastFetchError` tracking for `/status`
- `state.refreshInProgress` mutex — overlapping calls for the *same calendar*
  (scheduled interval vs. manual `/refresh`) are queued and resolved from the
  single in-flight run instead of starting a second fetch (see below).
  Different calendars refresh independently and concurrently — there is no
  cross-calendar lock.

### 7. HTTP server
`startServer(cfg)` binds to `127.0.0.1` only (never exposed externally).
Builds `calendars` (array of `createCalendarState` results) and
`calendarByPath` (`Map` from `/<localName>` to its state) once at startup.

Endpoints:
- `GET  /<calendarN.ics>` → serves that calendar's `cache.body` as `text/calendar`.
  If exactly one calendar is configured, unmatched paths fall back to serving
  it anyway (legacy "any path works" behavior) — see below. With 2+
  calendars, an unmatched path gets `404` listing the available ones.
- `GET  /status`     → JSON health/cache info, `calendars: [...]` array, one entry per feed
- `POST /refresh`    → re-fetches every calendar, responds with one line per calendar
- `GET  /health`     → alias for `/status`

### 8. Windows service helpers
`makeService()` / `installService(cfg)` / `uninstallService()` — thin wrappers
around `node-windows`. The service script path is always `__dirname/ical-proxy.js`
with no extra arguments; it boots from `ical-proxy.config.json`.

---

## Key design decisions

### Multi-calendar architecture: state is per-calendar, not module-level
Pre-1.3 had one set of module-level globals (`cache`, `lastFetchError`,
`networkDown`, `refreshInProgress`, `queuedRefreshCallbacks`) for the single
configured feed. Supporting N feeds meant these had to become per-calendar —
otherwise two calendars refreshing around the same time would stomp each
other's cache, error state, and disk writes. `createCalendarState` bundles
all of it into one object per calendar; `refreshIcal`, `saveDiskCache`,
`loadDiskCache` all take that object (or its `cacheFile`) as a parameter
instead of closing over globals. If you're adding a new piece of per-fetch
state, it goes on the `state` object in `createCalendarState`, not as a new
module-level `let`.

### Legacy single-calendar routing is preserved deliberately
Pre-1.3, Outlook could subscribe to **any path** on the proxy — the whole
server only ever had one calendar to serve. `--url` is now shorthand for
`--url1`, and when `calendars.length === 1` the request handler still falls
back to serving that one calendar on any unmatched path (see the `if
(!target && calendars.length === 1)` branch in `startServer`). This means
existing installs and existing Outlook subscription URLs keep working
untouched after upgrading — no re-subscribe needed. Only 2+ calendars require
hitting the exact `/<localName>` path; unmatched paths there 404 with the
list of valid ones instead of silently guessing which calendar was meant.

### Config/disk-cache migration keeps old installs working
`loadConfig` detects the pre-1.3 flat config shape (`{ url, port, interval,
notify }`, no `calendars` array) and synthesizes `calendars: [{ index: 1,
url, localName: 'calendar1.ics' }]` from it. `createCalendarState` reuses the
original `CACHE_FILE` (`ical-proxy.cache.ics`, unchanged name) for calendar
index 1 specifically so an existing on-disk cache is picked up as-is on
upgrade — no cold-cache gap while the network is down. Only calendars 2+ get
new `ical-proxy.cache<N>.ics` files.

### Connectivity errors are INFO, not ERROR
`CONNECTIVITY_ERRORS` is a `Set` of Node error codes (`ETIMEDOUT`, `ENOTFOUND`,
`ECONNREFUSED`, etc.) that indicate the network is unavailable rather than a real
bug. When a fetch fails with one of these codes the log line is `INFO` level with
a message like `"[calendar1.ics] Network unavailable (ENOTFOUND) — serving
cached 14,823 bytes"`. Real errors (bad URL, unexpected HTTP status, parse
failure) remain `ERROR`. Log lines are prefixed with `[<localName>]` so a
shared `ical-proxy.log` stays attributable across calendars.

### Disk cache for resilience across restarts
Each calendar's last successfully fetched iCal body is written to its own
disk cache file synchronously after each successful fetch (see "Disk cache"
above for the filename rule). On startup `startServer` loads each calendar's
file into `state.cache.body` *before* attempting any network request for it.
This means Outlook never gets a 503 just because the process restarted while
VPN was down.

### Single-file, no build step
Intentional. This is a Windows background utility, not a web app. Keeping
everything in `ical-proxy.js` means: no watch mode, no transpilation, no
dependency on build tooling, easy to audit, easy to deploy (copy one file).

### `cache.fromDisk` flag
Per calendar, set to `true` when that calendar's cache was populated from
disk rather than from a live network fetch. Surfaced per-calendar in
`/status`'s `calendars[].cacheFromDisk` so you can see at a glance whether
you're serving fresh data or a stale disk copy for each feed.

### Toast notifications are lazy, optional, and never fatal
`node-notifier` is loaded with a `try/catch` inside `initNotifier()`. If it's
missing or fails, `notify()` becomes a silent no-op — the proxy keeps running.
Notifications fire on: real (non-connectivity) fetch errors, genuine content
changes, network recovery, and fatal startup errors. **Connectivity errors
(VPN/timeout) never toast** — only their *recovery* does. This keeps the app
quiet during routine VPN drops. Recovery toast takes priority over "updated"
so you get exactly one toast when coming back online.

Two state variables drive this: `lastFetchError` (for `/status`) and
`networkDown` (a boolean latch so recovery only toasts once). Content change is
detected by comparing `cache.body !== res.body` before overwriting.

### `--debug` is a CLI-only diagnostic switch, never persisted
`args.debug` is attached to `cfg.debug` directly in `main()`, *after*
`resolveConfig()` returns — it deliberately never goes through `buildConfig`/
`saveConfig`, so it's never written to `ical-proxy.config.json`. Reason: if it
were persisted like `notify`, a Windows service installed with `--debug` would
toast on every single HTTP request forever (including routine Outlook polling)
with no way to see the toast (Session 0) or easily turn it off. `startServer`
reads it once into a local `debugMode` const and toasts on: server start,
`SIGINT`/`SIGTERM` shutdown, and every request in the `http.createServer`
callback. Still gated by `notify()`'s own `notifyEnabled`/`notifier` checks, so
`--no-notify` overrides `--debug`.

### Session 0 caveat
Toasts from a service running as LocalSystem won't reach the interactive desktop.
This is documented in the `notify()` header comment and the README. Not a code
issue — a Windows security boundary. Solution is to run the service as the user
account or run in the foreground.

### `refreshIcal` runs are serialized per calendar
`state.refreshInProgress` (bool) + `state.queuedRefreshCallbacks` (array),
set up in `createCalendarState`, prevent two `refreshIcal` calls for the
*same calendar* from being in flight at once. Without this, the scheduled
interval and a manual `POST /refresh` could race for that calendar:
whichever network response lands *last* wins, which can overwrite a newer
result with a stale one in both the in-memory cache and `saveDiskCache`'s
disk write. When a refresh is already running for a calendar, new callers
for that calendar are pushed onto its `queuedRefreshCallbacks` and all get
the in-flight run's result instead of starting their own — `saveDiskCache`
is therefore never called twice concurrently for the same file. Different
calendars have independent state objects, so they refresh fully in parallel
with no lock between them.

### Service boots without CLI args
When `node-windows` starts the service it passes no arguments. The main()
function checks for `CONFIG_FILE` existence when `process.argv.length <= 2` and
proceeds to `startServer` if found. Avoids the need for a separate service-runner
entry point.

---

## What NOT to change without understanding the impact

- `'127.0.0.1'` in `server.listen` — binding to loopback only is intentional security
- `timer.unref()` — required so the interval doesn't prevent clean process exit
- `saveDiskCache` is synchronous — if changed to async, add error handling for
  concurrent writes during rapid `/refresh` calls
- `state.refreshInProgress` / `state.queuedRefreshCallbacks` (per calendar) —
  serializes `refreshIcal` runs for that calendar so overlapping fetches
  can't stomp each other's result; don't remove without another way to
  prevent concurrent runs on the same calendar
- Calendar 1's disk cache filename must stay `ical-proxy.cache.ics`
  (`CACHE_FILE`) — it's the pre-1.3 filename and changing it breaks the
  upgrade path that lets an existing on-disk cache survive updating to
  multi-calendar support
- The `calendars.length === 1` catch-all fallback in the request handler —
  removing it breaks existing Outlook subscriptions on upgrade (see "Legacy
  single-calendar routing is preserved deliberately")
- `CONNECTIVITY_ERRORS` — check the Node.js docs before adding/removing codes;
  `ECONNRESET` in particular can be both a connectivity issue and a server bug

---

## Adding features — checklist

- [ ] New CLI flag → add to `parseArgs`, `buildConfig`, `resolveConfig`, help text, README
- [ ] New per-calendar CLI flag (like `--calendarN`) → parse with a regex branch in
      `parseArgs` (not the `switch`), thread through `buildConfig`'s `calendars` map
- [ ] New endpoint → add handler block in the `http.createServer` callback before the
      iCal routing; document in README. Decide: applies to all calendars (loop
      `calendars`) or global (like `/status`)?
- [ ] New per-calendar runtime state → add a field to `createCalendarState`, not a new
      module-level `let` (see "Multi-calendar architecture")
- [ ] New config field → add to `buildConfig`, `resolveConfig` merge, `saveConfig` will
      pick it up automatically since it serialises the whole object
- [ ] New error code to silence → add to `CONNECTIVITY_ERRORS` Set in Constants section
- [ ] New notification trigger → call `notify(title, message)`; keep connectivity
      errors silent, and remember `notify()` is a safe no-op if disabled/unavailable

---

## Dependencies

| Package | Why |
|---|---|
| `node-windows` | Install/uninstall/start/stop as a Windows SCM service |
| `node-notifier` | Native Windows toast notifications (bundles SnoreToast) — loaded lazily, optional |

Everything else (HTTP, HTTPS, fs, path, os, url) is Node built-in.
Minimum Node version: **14.0.0** (uses optional chaining `?.` and numeric separators `_`).
