# CLAUDE.md — iCal Proxy

Context file for Claude Code. Read this before touching anything.

---

## What this is

A Node.js single-file application that runs as a Windows background service.
It downloads a remote iCal (`.ics`) feed on a configurable interval and re-serves
it from localhost over HTTP so that Outlook can subscribe to it.

Primary use-case: corporate environments where the remote calendar URL is only
reachable via VPN. The proxy caches the last-known-good `.ics` to disk so
Outlook always has something to load even when the VPN is disconnected.

---

## File layout

```
ical-proxy.js              # The entire application — one file, no build step
package.json               # Runtime deps: node-windows + node-notifier
CLAUDE.md                  # This file
README.md                  # End-user documentation

# Generated at runtime — never committed
ical-proxy.config.json     # Saved config (url, port, interval)
ical-proxy.cache.ics       # Last successfully fetched iCal body
ical-proxy.log             # Append-only log
daemon/                    # Created by node-windows during --install
```

---

## Running locally

```bash
npm install
node ical-proxy.js --url https://example.com/calendar.ics
node ical-proxy.js --url https://example.com/calendar.ics --port 9090 --interval 15
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
Minimal hand-rolled parser, no dependencies. Flags: `--url`, `--port`,
`--interval`, `--install`, `--uninstall`, `--help`.

### 4. Config
Three layers in priority order:
1. CLI args (if `--url` is present)
2. Saved `ical-proxy.config.json` (fallback for service restarts)
3. Error + help text

`saveConfig` is called whenever a new config is resolved from CLI args so the
Windows service always boots with the correct settings without needing flags.

### 5. Disk cache
`saveDiskCache(body)` / `loadDiskCache()` — synchronous read/write to
`ical-proxy.cache.ics`. Called after every successful network fetch (save) and
at the very top of `startServer` before the first network request (load).

### 6. iCal fetcher
`fetchUrl` — raw HTTP/S GET with redirect following (up to `MAX_REDIRECTS`) and
a 30-second socket timeout. No npm dependencies.

`refreshIcal` — wraps `fetchUrl` with:
- Conditional GET headers (`If-None-Match`, `If-Modified-Since`)
- Connectivity error classification (see below)
- Disk persistence on success
- `lastFetchError` tracking for `/status`

### 7. HTTP server
`startServer(cfg)` binds to `127.0.0.1` only (never exposed externally).

Endpoints:
- `GET  /*`          → serves `cache.body` as `text/calendar`
- `GET  /status`     → JSON health/cache info
- `POST /refresh`    → triggers immediate re-fetch
- `GET  /health`     → alias for `/status`

### 8. Windows service helpers
`makeService()` / `installService(cfg)` / `uninstallService()` — thin wrappers
around `node-windows`. The service script path is always `__dirname/ical-proxy.js`
with no extra arguments; it boots from `ical-proxy.config.json`.

---

## Key design decisions

### Connectivity errors are INFO, not ERROR
`CONNECTIVITY_ERRORS` is a `Set` of Node error codes (`ETIMEDOUT`, `ENOTFOUND`,
`ECONNREFUSED`, etc.) that indicate the network is unavailable rather than a real
bug. When a fetch fails with one of these codes the log line is `INFO` level with
a message like `"Network unavailable (ENOTFOUND) — serving cached 14,823 bytes"`.
Real errors (bad URL, unexpected HTTP status, parse failure) remain `ERROR`.

### Disk cache for resilience across restarts
The last successfully fetched iCal body is written to `ical-proxy.cache.ics`
synchronously after each successful fetch. On startup `startServer` loads this
file into `cache.body` *before* attempting any network request. This means
Outlook never gets a 503 just because the process restarted while VPN was down.

### Single-file, no build step
Intentional. This is a Windows background utility, not a web app. Keeping
everything in `ical-proxy.js` means: no watch mode, no transpilation, no
dependency on build tooling, easy to audit, easy to deploy (copy one file).

### `cache.fromDisk` flag
Set to `true` when the cache was populated from disk rather than from a live
network fetch. Surfaced in `/status` so you can see at a glance whether you're
serving fresh data or a stale disk copy.

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

### Session 0 caveat
Toasts from a service running as LocalSystem won't reach the interactive desktop.
This is documented in the `notify()` header comment and the README. Not a code
issue — a Windows security boundary. Solution is to run the service as the user
account or run in the foreground.

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
- `CONNECTIVITY_ERRORS` — check the Node.js docs before adding/removing codes;
  `ECONNRESET` in particular can be both a connectivity issue and a server bug

---

## Adding features — checklist

- [ ] New CLI flag → add to `parseArgs`, `buildConfig`, `resolveConfig`, help text, README
- [ ] New endpoint → add handler block in the `http.createServer` callback before the
      iCal catch-all; document in README
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
