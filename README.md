# iCal Proxy Server

Downloads one or more remote iCal / `.ics` feeds and re-serves them from **localhost** over HTTP.  
Outlook (or any calendar client) subscribes to the local URL(s) — the proxy handles fetching, caching, and polling each remote source in the background.

---

## Why?

Some iCal feed URLs (Google, Office 365, Nextcloud, etc.) require authentication headers, have rate limits, or aren't reachable from Outlook's own refresh mechanism. This proxy:

- Caches the last known-good calendar data (survives remote outages)
- Uses conditional GET (`ETag` / `If-Modified-Since`) to save bandwidth
- Runs silently in the background as a Windows service
- Gives you a `/status` endpoint to see what's going on

---

## Requirements

- **Node.js** ≥ 14  (https://nodejs.org)
- **npm install** (once, in the project folder)
- **Administrator rights** — only for `--install` / `--uninstall`

---

## Quick Start

```bash
# 1. Install dependencies (one time)
npm install

# 2. Run in the foreground to test it
node ical-proxy.js --url https://example.com/calendar.ics

# 3. Open Outlook and subscribe to:
#    http://localhost:8080/calendar.ics
```

Press `Ctrl-C` to stop the foreground server.

---

## Command-Line Options

| Option | Default | Description |
|---|---|---|
| `--url <url>` | *(required\*)* | Remote iCal / `.ics` URL to proxy. Shorthand for `--url1` (single-calendar mode) |
| `--url1 <url>` | — | First calendar's remote feed URL |
| `--url2 <url>`, `--url3 <url>`, ... | — | Additional calendars — one flag per feed |
| `--calendar1 <name>` | `calendar1.ics` | Local filename calendar 1 is served at |
| `--calendar2 <name>`, ... | `calendar2.ics`, ... | Local filename for calendar 2, etc. |
| `--port <n>` | `8080` | Local HTTP port to listen on |
| `--interval <mins>` | `30` | How often to re-fetch every remote feed |
| `--notify` | *(on)* | Enable Windows toast notifications |
| `--no-notify` | — | Disable Windows toast notifications |
| `--debug` | *(off)* | Toast on startup, shutdown, and every HTTP request the local server handles |
| `--install` | — | Install as a Windows background service |
| `--uninstall` | — | Remove the Windows service |
| `--help` | — | Print help and exit |

\* `--url` is not required if the service was previously installed (config is saved automatically).

With a single calendar (`--url` or one `--urlN`), Outlook can subscribe to
**any path** on the proxy — the `--calendarN` filename is cosmetic. With two
or more calendars, each is only served at its own filename; unmatched paths
get a `404` listing the available ones.

---

## Examples

```bash
# Foreground — basic
node ical-proxy.js --url https://example.com/calendar.ics

# Foreground — custom port, refresh every 15 minutes
node ical-proxy.js --url https://example.com/calendar.ics --port 9090 --interval 15

# Debug mode — toast on startup, shutdown, and every HTTP request handled
node ical-proxy.js --url https://example.com/calendar.ics --debug

# URL with embedded credentials
node ical-proxy.js --url https://user:password@example.com/private.ics

# Two calendars, custom local filenames
node ical-proxy.js --url1 https://example.com/work.ics    --calendar1 work.ics \
                    --url2 https://example.com/family.ics --calendar2 family.ics

# Two calendars, default local filenames (calendar1.ics, calendar2.ics)
node ical-proxy.js --url1 https://example.com/work.ics --url2 https://example.com/family.ics

# Install as Windows service (auto-starts on boot)
# Run this command prompt as Administrator
node ical-proxy.js --install --url https://example.com/calendar.ics --port 8080 --interval 30

# Install as a service with multiple calendars
node ical-proxy.js --install --url1 https://example.com/work.ics --calendar1 work.ics \
                              --url2 https://example.com/family.ics --calendar2 family.ics \
                              --port 8080 --interval 30

# Remove the Windows service
# Run this command prompt as Administrator
node ical-proxy.js --uninstall
```

---

## HTTP Endpoints

Once running, four endpoints are available:

### `GET /<calendarN.ics>` (or any path, single-calendar mode)
The proxied iCal feed(s). With one calendar configured, any path works —
Outlook will use whichever URL you gave it. With two or more, each is only
served at its own local filename (`--calendarN`, default `calendarN.ics`);
any other path returns `404` listing the available ones.

```
http://localhost:8080/calendar1.ics
http://localhost:8080/calendar2.ics
```

### `GET /status`
JSON health check covering every configured calendar — cache state, last
fetch time, and next scheduled fetch for each.

```bash
curl http://localhost:8080/status
```

```json
{
  "status": "ok",
  "message": "2/2 calendar(s) cached and ready",
  "port": 8080,
  "intervalMinutes": 30,
  "calendars": [
    {
      "path": "/calendar1.ics",
      "sourceUrl": "https://example.com/work.ics",
      "status": "ok",
      "message": "Calendar cached and ready",
      "cacheBytes": 14823,
      "cacheFromDisk": false,
      "fetchedAt": "2025-06-01T10:00:00.000Z",
      "nextFetchAt": "2025-06-01T10:30:00.000Z",
      "diskCacheFile": "C:\\path\\to\\ical-proxy\\ical-proxy.cache.ics",
      "diskCacheExists": true,
      "diskCacheBytes": 14823,
      "lastFetchError": null,
      "networkDown": false
    },
    {
      "path": "/calendar2.ics",
      "sourceUrl": "https://example.com/family.ics",
      "status": "ok",
      "message": "Calendar cached and ready",
      "cacheBytes": 9001,
      "cacheFromDisk": false,
      "fetchedAt": "2025-06-01T10:00:00.500Z",
      "nextFetchAt": "2025-06-01T10:30:00.500Z",
      "diskCacheFile": "C:\\path\\to\\ical-proxy\\ical-proxy.cache2.ics",
      "diskCacheExists": true,
      "diskCacheBytes": 9001,
      "lastFetchError": null,
      "networkDown": false
    }
  ],
  "notifications": "enabled",
  "hostname": "MY-PC",
  "uptime": "1234s"
}
```

Top-level `status` is `"ok"` when every calendar has a cache, `"partial"`
when some do and some don't, `"pending"` when none do yet.

### `GET /health`
Alias for `/status` — same response, different path (for health-check tooling that expects `/health`).

```bash
curl http://localhost:8080/health
```

### `POST /refresh`
Trigger an immediate re-fetch of **every** configured calendar (useful after
you know a remote calendar changed). Responds with one line per calendar.

```bash
curl -X POST http://localhost:8080/refresh
```

```
/calendar1.ics: refreshed OK — 14,823 bytes cached
/calendar2.ics: refreshed OK — 9,001 bytes cached
```

---

## Outlook Setup

1. Open Outlook
2. **File → Account Settings → Account Settings**
3. Click the **Internet Calendars** tab
4. Click **New…**
5. Enter: `http://localhost:8080/calendar1.ics` (or whichever local filename you configured)
6. Click **Add**
7. Give it a name and click **OK**
8. Repeat for each additional calendar (`calendar2.ics`, etc.)

Outlook will now sync from the local proxy instead of hitting the remote URL(s) directly.

---

## Windows Notifications

The proxy shows native Windows toast notifications for the events that matter:

| Event | Toast | Notes |
|---|---|---|
| Real fetch error | **"Fetch error"** | Bad URL, auth failure, HTTP 4xx/5xx, TLS error |
| Calendar changed | **"Calendar updated"** | Only when content actually differs from the cached copy |
| Connection recovered | **"Back online"** | Fires once when the network comes back after being down |
| Startup failure | **"Startup failed"** | e.g. port already in use |

**VPN drops and timeouts are silent by design.** In a corporate environment the
VPN disconnecting is routine — toasting on every failed poll would be spam. Those
are logged at `INFO` level only; you'll only get a toast when the connection
*recovers*.

Disable all toasts with `--no-notify`:

```bash
node ical-proxy.js --url https://example.com/calendar.ics --no-notify
```

### Debug mode

`--debug` adds three more toast triggers, off by default and noisy on purpose:

| Event | Toast |
|---|---|
| Server start | **"Debug: started"** |
| Server shutdown (`SIGINT`/`SIGTERM`) | **"Debug: shutdown"** |
| Every HTTP request the local server handles | **"Debug: HTTP"** |

```bash
node ical-proxy.js --url https://example.com/calendar.ics --debug
```

It's a foreground diagnostic switch only — `--debug` is never written to
`ical-proxy.config.json`, so an installed Windows service never inherits it
and starts toasting on every Outlook poll. `--no-notify` still wins over
`--debug` (no notifier loaded, no toasts at all).

### Toasts and the Windows service (Session 0)

When the proxy runs as a Windows **service** under the default `LocalSystem`
account, it lives in *Session 0* and its toasts **will not appear** on your
desktop. This is a Windows security boundary, not a bug. Two ways to see toasts
from the service:

1. **Run in the foreground** (`node ical-proxy.js --url ...`) — toasts work normally.
2. **Run the service as your user account**: `services.msc` -> **iCal Proxy** ->
   *Properties* -> *Log On* tab -> **This account** -> enter your Windows
   credentials -> restart the service.

---

## Windows Service (Background)

Installing as a Windows service means the proxy:
- Starts automatically when Windows boots
- Runs even when no user is logged in
- Survives user logouts and restarts

### Install

Open **Command Prompt as Administrator** and run:

```bat
cd C:\path\to\ical-proxy
npm install
node ical-proxy.js --install --url https://example.com/calendar.ics --port 8080 --interval 30
```

The service name is **"iCal Proxy"** and can be managed via:
- **Services** app (`services.msc`)
- **Task Manager → Services** tab
- `sc start "iCal Proxy"` / `sc stop "iCal Proxy"`

### Uninstall

Open **Command Prompt as Administrator** and run:

```bat
node ical-proxy.js --uninstall
```

### Update settings

To change the URL(s), port, or interval after installing:

```bat
node ical-proxy.js --uninstall
node ical-proxy.js --install --url https://new-url.com/calendar.ics --port 8080 --interval 15
```

For multiple calendars, pass all `--urlN`/`--calendarN` flags again on the
`--install` line — it always replaces the full saved calendar list, it
doesn't merge with what was there before.

---

## Config File

When `--install` is run (or when `--url` is provided on the CLI), settings are saved to:

```
ical-proxy.config.json
```

This file is read on startup when no CLI args are present (i.e., when launched by the Windows service manager). You can edit it manually — just restart the service afterwards.

```json
{
  "calendars": [
    { "index": 1, "url": "https://example.com/work.ics", "localName": "calendar1.ics" },
    { "index": 2, "url": "https://example.com/family.ics", "localName": "calendar2.ics" }
  ],
  "port": 8080,
  "interval": 30,
  "notify": true
}
```

Config files saved by pre-1.3 versions (flat `{ "url": ..., "port": ..., ... }`,
one calendar only) are read and upgraded to this shape automatically — no
manual migration needed.

---

## Log File

All activity is written to:

```
ical-proxy.log
```

(In the same folder as `ical-proxy.js`.)

Tail it while running:

```powershell
Get-Content ical-proxy.log -Wait -Tail 50
```

---

## Troubleshooting

**Port already in use**
```
Error: Port 8080 is already in use
```
Use `--port 9090` (or any free port) and update your Outlook subscription URL to match.

---

**Service won't start**
Check the log file at `ical-proxy.log`. Also check the Windows Event Viewer under *Windows Logs → Application* for entries from `iCal Proxy`.

---

**Calendar shows old data**
Hit the force-refresh endpoint:
```bash
curl -X POST http://localhost:8080/refresh
```
Or check `/status` to see when the next automatic refresh is scheduled.

---

**Remote URL requires special auth**
If the source URL needs OAuth or Bearer tokens rather than basic auth, fetch the raw iCal URL with your auth tool and point `--url` at a pre-authenticated URL (many services offer token-in-URL options).

---

## Files

```
ical-proxy/
├── ical-proxy.js           # Main application (single file)
├── package.json            # Deps: node-windows (service) + node-notifier (toasts)
├── README.md
├── CLAUDE.md               # Context file for Claude Code
├── ical-proxy.config.json  # Auto-generated on first run with --url/--urlN or --install
├── ical-proxy.cache.ics    # Auto-generated — calendar 1's last known-good body (served offline)
├── ical-proxy.cache2.ics   # Auto-generated — calendar 2's disk cache, etc. (one file per calendar 2+)
└── ical-proxy.log          # Auto-generated — rolling log of all activity
```
