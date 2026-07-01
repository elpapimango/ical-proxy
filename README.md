# iCal Proxy Server

Downloads a remote iCal / `.ics` feed and re-serves it from **localhost** over HTTP.  
Outlook (or any calendar client) subscribes to the local URL — the proxy handles fetching, caching, and polling the remote source in the background.

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
| `--url <url>` | *(required\*)* | Remote iCal / `.ics` URL to proxy |
| `--port <n>` | `8080` | Local HTTP port to listen on |
| `--interval <mins>` | `30` | How often to re-fetch the remote feed |
| `--notify` | *(on)* | Enable Windows toast notifications |
| `--no-notify` | — | Disable Windows toast notifications |
| `--install` | — | Install as a Windows background service |
| `--uninstall` | — | Remove the Windows service |
| `--help` | — | Print help and exit |

\* `--url` is not required if the service was previously installed (config is saved automatically).

---

## Examples

```bash
# Foreground — basic
node ical-proxy.js --url https://example.com/calendar.ics

# Foreground — custom port, refresh every 15 minutes
node ical-proxy.js --url https://example.com/calendar.ics --port 9090 --interval 15

# URL with embedded credentials
node ical-proxy.js --url https://user:password@example.com/private.ics

# Install as Windows service (auto-starts on boot)
# Run this command prompt as Administrator
node ical-proxy.js --install --url https://example.com/calendar.ics --port 8080 --interval 30

# Remove the Windows service
# Run this command prompt as Administrator
node ical-proxy.js --uninstall
```

---

## HTTP Endpoints

Once running, four endpoints are available:

### `GET /calendar.ics` (or any path)
The proxied iCal feed. Any path works — Outlook will use whichever URL you gave it.

```
http://localhost:8080/calendar.ics
```

### `GET /status`
JSON health check showing cache state, last fetch time, and next scheduled fetch.

```bash
curl http://localhost:8080/status
```

```json
{
  "status": "ok",
  "message": "Calendar cached and ready",
  "sourceUrl": "https://example.com/calendar.ics",
  "port": 8080,
  "intervalMinutes": 30,
  "cacheBytes": 14823,
  "cacheFromDisk": false,
  "fetchedAt": "2025-06-01T10:00:00.000Z",
  "nextFetchAt": "2025-06-01T10:30:00.000Z",
  "diskCacheFile": "C:\\path\\to\\ical-proxy\\ical-proxy.cache.ics",
  "diskCacheExists": true,
  "diskCacheBytes": 14823,
  "lastFetchError": null,
  "networkDown": false,
  "notifications": "enabled",
  "hostname": "MY-PC",
  "uptime": "1234s"
}
```

### `GET /health`
Alias for `/status` — same response, different path (for health-check tooling that expects `/health`).

```bash
curl http://localhost:8080/health
```

### `POST /refresh`
Trigger an immediate re-fetch (useful after you know the remote calendar changed).

```bash
curl -X POST http://localhost:8080/refresh
```

---

## Outlook Setup

1. Open Outlook
2. **File → Account Settings → Account Settings**
3. Click the **Internet Calendars** tab
4. Click **New…**
5. Enter: `http://localhost:8080/calendar.ics`
6. Click **Add**
7. Give it a name and click **OK**

Outlook will now sync from the local proxy instead of hitting the remote URL directly.

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

To change the URL, port, or interval after installing:

```bat
node ical-proxy.js --uninstall
node ical-proxy.js --install --url https://new-url.com/calendar.ics --port 8080 --interval 15
```

---

## Config File

When `--install` is run (or when `--url` is provided on the CLI), settings are saved to:

```
ical-proxy.config.json
```

This file is read on startup when no CLI args are present (i.e., when launched by the Windows service manager). You can edit it manually — just restart the service afterwards.

```json
{
  "url": "https://example.com/calendar.ics",
  "port": 8080,
  "interval": 30,
  "notify": true
}
```

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
├── ical-proxy.config.json  # Auto-generated on first run with --url or --install
├── ical-proxy.cache.ics    # Auto-generated — last known-good calendar (served offline)
└── ical-proxy.log          # Auto-generated — rolling log of all activity
```
