#!/usr/bin/env node
'use strict';

/**
 * ical-proxy.js
 *
 * Downloads one or more remote iCal feeds and re-serves them locally over HTTP.
 * Outlook (or any calendar client) can subscribe to the local URL(s) instead
 * of the remote ones, with automatic background refreshes.
 *
 * Usage:
 *   node ical-proxy.js --url <url> [--port 8080] [--interval 30]
 *   node ical-proxy.js --url1 <url> --url2 <url> [--calendar1 name.ics] [--calendar2 name.ics]
 *   node ical-proxy.js --install  --url <url> [--port 8080] [--interval 30]
 *   node ical-proxy.js --uninstall
 *   node ical-proxy.js --help
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { URL } = require('url');

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION       = '1.3.0';
const APP_NAME      = 'iCal Proxy';
const CONFIG_FILE   = path.join(__dirname, 'ical-proxy.config.json');
const LOG_FILE      = path.join(__dirname, 'ical-proxy.log');
const CACHE_FILE    = path.join(__dirname, 'ical-proxy.cache.ics'); // legacy/calendar-1 disk cache path, persisted across restarts
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT = 30_000; // ms

/**
 * Node error codes that indicate a network / connectivity problem rather than
 * a real application error.  These include VPN being disconnected, the remote
 * host being unreachable, or a socket timeout — all expected in a corporate
 * environment.  We treat them as INFO rather than ERROR so the log stays clean.
 */
const CONNECTIVITY_ERRORS = new Set([
  'ETIMEDOUT',       // TCP connect / socket timeout
  'ECONNREFUSED',    // Nothing listening on the remote port
  'ECONNRESET',      // Remote closed the connection mid-stream
  'ECONNABORTED',    // Local stack aborted the connection
  'ENOTFOUND',       // DNS resolution failed (VPN splits DNS)
  'EHOSTUNREACH',    // No route to host
  'ENETUNREACH',     // Network unreachable (interface down)
  'EADDRNOTAVAIL',   // Local address not available
  'EAI_AGAIN',       // Temporary DNS failure
]);

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {
    // Never crash on log failure
  }
}

const logger = {
  info:  m => log('INFO',  m),
  warn:  m => log('WARN',  m),
  error: m => log('ERROR', m),
};

// ─── Windows Toast Notifications ──────────────────────────────────────────────

/**
 * node-notifier is loaded lazily and optionally. If it isn't installed, or if
 * notifications are disabled, notify() becomes a no-op — the app never crashes
 * because of a missing/failed toast.
 *
 * IMPORTANT — Session 0 isolation:
 *   When ical-proxy runs as a Windows *service* under the default LocalSystem
 *   account, it lives in Session 0 and its toasts will NOT appear on the
 *   interactive desktop. To see toasts from the service, either:
 *     (a) run it in the foreground (node ical-proxy.js --url ...), or
 *     (b) configure the service to log on as your user account
 *         (services.msc → iCal Proxy → Properties → Log On → This account).
 */
let notifier = null;          // lazy-loaded node-notifier instance
let notifyEnabled = true;     // toggled by --no-notify / config

function initNotifier() {
  if (!notifyEnabled) return;
  try {
    notifier = require('node-notifier');
  } catch (_) {
    notifier = null;
    logger.warn('node-notifier not installed — toast notifications disabled (run: npm install)');
  }
}

/**
 * Show a Windows toast. Silently degrades to nothing if notifications are
 * disabled or the module is unavailable. Never throws.
 * @param {string} title
 * @param {string} message
 */
function notify(title, message) {
  if (!notifyEnabled || !notifier) return;
  try {
    notifier.notify({
      title:    `${APP_NAME}: ${title}`,
      message:  message,
      appID:    APP_NAME,      // avoids the generic "SnoreToast" attribution on Win10/11
      timeout:  8,             // seconds the toast stays on screen
      sound:    false,         // don't be noisy for routine updates
      wait:     false,
    }, (err) => {
      // Callback errors are non-fatal — just note them in the log
      if (err) logger.warn(`Toast failed: ${err.message}`);
    });
  } catch (e) {
    logger.warn(`Toast error: ${e.message}`);
  }
}

// ─── Argument Parser ──────────────────────────────────────────────────────────

/**
 * `--url` is shorthand for `--url1` (single-calendar mode). `--url2`,
 * `--url3`, ... add more feeds; `--calendarN` sets that feed's local
 * filename (default `calendarN.ics`). Indices are kept exactly as given
 * (e.g. a lone `--url3` stays feed #3) rather than being renumbered.
 */
function parseArgs(argv = process.argv.slice(2)) {
  const out = { urls: {}, calendarNames: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const urlMatch      = arg.match(/^--url(\d+)$/);
    const calendarMatch = arg.match(/^--calendar(\d+)$/);

    if (arg === '--url')  { out.urls[1] = argv[++i]; continue; }
    if (urlMatch)         { out.urls[Number(urlMatch[1])] = argv[++i]; continue; }
    if (calendarMatch)    { out.calendarNames[Number(calendarMatch[1])] = argv[++i]; continue; }

    switch (arg) {
      case '--port':      out.port      = Number(argv[++i]); break;
      case '--interval':  out.interval  = Number(argv[++i]); break;
      case '--install':   out.install   = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--no-notify': out.notify    = false; break;
      case '--notify':    out.notify    = true; break;
      case '--debug':     out.debug     = true; break;
      case '--help':
      case '-h':           out.help      = true; break;
    }
  }
  return out;
}

// ─── Config ───────────────────────────────────────────────────────────────────

function buildConfig(args) {
  const indices = Object.keys(args.urls || {}).map(Number).sort((a, b) => a - b);
  const calendars = indices.map(idx => ({
    index:     idx,
    url:       args.urls[idx],
    localName: args.calendarNames[idx] || `calendar${idx}.ics`,
  }));
  return {
    calendars,
    port:     Number(args.port)     || 8080,
    interval: Number(args.interval) || 30,
    notify:   args.notify !== false,   // default true; --no-notify sets false
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  logger.info(`Config saved → ${CONFIG_FILE}`);
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  const cfg = JSON.parse(raw);

  // Migrate pre-1.3 config files (flat single-calendar shape: { url, ... })
  // into the multi-calendar shape so existing installs keep working as-is.
  if (!cfg.calendars && cfg.url) {
    cfg.calendars = [{ index: 1, url: cfg.url, localName: 'calendar1.ics' }];
    delete cfg.url;
  }

  if (!Array.isArray(cfg.calendars) || cfg.calendars.length === 0) {
    throw new Error('Config is missing at least one calendar ("calendars" array with a "url").');
  }
  return cfg;
}

/**
 * Resolve runtime config with this priority:
 *   1. --url / --urlN present on CLI  → use CLI args (also save for future service runs)
 *   2. No URLs on CLI but config.json exists  → load from file, allow port/interval/notify overrides
 *   3. Neither  → throw (caller will print help and exit)
 */
function resolveConfig(args) {
  const hasUrls = args.urls && Object.keys(args.urls).length > 0;

  if (hasUrls) {
    const cfg = buildConfig(args);
    saveConfig(cfg);          // Persist so Windows service can read it on restart
    return cfg;
  }

  if (fs.existsSync(CONFIG_FILE)) {
    const saved = loadConfig();
    const cfg = {
      calendars: saved.calendars,
      port:      Number(args.port)     || saved.port     || 8080,
      interval:  Number(args.interval) || saved.interval || 30,
      // CLI flag wins if present; otherwise fall back to saved value (default true)
      notify:    args.notify !== undefined ? args.notify
                   : (saved.notify !== undefined ? saved.notify : true),
    };
    // Persist any overrides
    if (args.port || args.interval || args.notify !== undefined) saveConfig(cfg);
    return cfg;
  }

  throw new Error(
    'No iCal URL specified and no saved config found.\n' +
    'Provide --url <url> (or --url1, --url2, ...), or run with --install --url <url> first.'
  );
}

// ─── Disk Cache ───────────────────────────────────────────────────────────────

/**
 * Write an iCal body to disk so it survives process restarts and is still
 * available when the external network is unreachable (e.g. VPN disconnected).
 * Each calendar has its own file (see createCalendarState's `cacheFile`).
 */
function saveDiskCache(filePath, body) {
  try {
    fs.writeFileSync(filePath, body, 'utf8');
  } catch (e) {
    logger.warn(`Disk cache write failed (${filePath}): ${e.message}`);
  }
}

/**
 * Load a previously saved iCal body from disk.
 * Returns the content string, or null if nothing valid is on disk.
 */
function loadDiskCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const body = fs.readFileSync(filePath, 'utf8');
    // Quick sanity check before trusting the file
    if (body.includes('BEGIN:VCALENDAR')) return body;
    logger.warn(`Disk cache exists but does not look like a valid iCal — ignoring (${filePath})`);
  } catch (e) {
    logger.warn(`Disk cache read failed (${filePath}): ${e.message}`);
  }
  return null;
}

// ─── iCal Fetcher ─────────────────────────────────────────────────────────────

/**
 * Build the per-calendar runtime state: in-memory cache, disk cache path, and
 * the refresh-serialization fields refreshIcal() needs. One of these exists
 * per configured calendar so N feeds can be polled independently without
 * racing each other's cache/disk writes.
 *
 * Calendar 1 keeps the original `ical-proxy.cache.ics` disk cache filename
 * for backward compatibility with pre-multi-calendar installs; calendars
 * 2+ get `ical-proxy.cache<N>.ics`.
 */
function createCalendarState(index, url, localName) {
  return {
    index,
    url,
    localName,
    cacheFile: index === 1
      ? CACHE_FILE
      : path.join(__dirname, `ical-proxy.cache${index}.ics`),
    cache: {
      body:         null,   // string — the raw iCal text
      etag:         null,   // ETag from last response (for conditional GETs)
      lastModified: null,   // Last-Modified header value
      fetchedAt:    null,   // Date of last successful fetch
      fromDisk:     false,  // true if cache was warm-loaded from disk (not from network)
    },
    // Tracks the most recent fetch error so /status can surface it.
    // Reset to null on every successful fetch.
    lastFetchError: null,
    // True while this feed is unreachable (connectivity errors). Used to
    // fire a single "network recovered" toast when it comes back, rather
    // than toasting on every failed poll.
    networkDown: false,
    // Guards against overlapping refreshIcal() runs for this calendar. The
    // scheduled interval and a manual POST /refresh can otherwise both be
    // in flight at once; whichever network response lands last wins and can
    // stomp a newer result with a stale one (in-memory and on disk). While a
    // refresh is in progress, additional callers are queued and all get the
    // result of the single in-flight run instead of starting their own.
    refreshInProgress:      false,
    queuedRefreshCallbacks: [],
  };
}

/**
 * Perform a single HTTP/S GET, following redirects.
 * @param {string}   targetUrl
 * @param {object}   extraHeaders  — conditional GET headers, etc.
 * @param {number}   redirectsLeft
 * @param {Function} cb(err, result)
 *   result = { status: 'ok'|'not-modified', body?, etag?, lastModified? }
 */
function fetchUrl(targetUrl, extraHeaders, redirectsLeft, cb) {
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch (e) { return cb(new Error(`Invalid URL: ${targetUrl}`)); }

  const transport = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    headers: {
      'User-Agent': `${APP_NAME}/${VERSION} (Outlook-compat)`,
      'Accept':     'text/calendar, application/ics, */*',
      ...extraHeaders,
    },
    // Support credentials embedded in the URL (user:pass@host)
    ...(parsed.username ? { auth: `${parsed.username}:${parsed.password}` } : {}),
  };

  const req = transport.get(options, (res) => {
    // ── Redirect handling ────────────────────────────────────
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      if (redirectsLeft <= 0) return cb(new Error('Too many redirects'));
      res.resume(); // Drain so socket is reused
      const next = res.headers.location.startsWith('http')
        ? res.headers.location
        : new URL(res.headers.location, targetUrl).href;
      logger.info(`Redirect ${res.statusCode} → ${next}`);
      return fetchUrl(next, extraHeaders, redirectsLeft - 1, cb);
    }

    // ── Not modified ─────────────────────────────────────────
    if (res.statusCode === 304) {
      res.resume();
      return cb(null, { status: 'not-modified' });
    }

    // ── Other non-200 ────────────────────────────────────────
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
    }

    // ── Collect body ─────────────────────────────────────────
    const chunks = [];
    res.on('data',  chunk => chunks.push(chunk));
    res.on('end',   () => cb(null, {
      status:       'ok',
      body:         Buffer.concat(chunks).toString('utf8'),
      etag:         res.headers['etag']          || null,
      lastModified: res.headers['last-modified'] || null,
    }));
    res.on('error', cb);
  });

  req.setTimeout(FETCH_TIMEOUT, () => req.destroy(new Error('Fetch timed out')));
  req.on('error', cb);
}

/**
 * Refresh a single calendar's in-memory cache from its remote URL. Uses
 * conditional GET (ETag / If-Modified-Since) to save bandwidth.
 *
 * Connectivity errors (VPN down, DNS failure, socket timeout, etc.) are logged
 * at INFO level and do NOT evict the existing cache — Outlook keeps getting the
 * last known-good data until the network comes back.
 *
 * On success the body is also written to disk (state.cacheFile) so it
 * survives service restarts without needing a network round-trip.
 *
 * @param {object}   state  — a createCalendarState() instance
 * @param {Function} done(err, updated:boolean)
 */
function refreshIcal(state, done) {
  // Coalesce with an in-flight run instead of starting a second overlapping
  // fetch — see createCalendarState's refreshInProgress comment.
  if (state.refreshInProgress) {
    state.queuedRefreshCallbacks.push(done);
    return;
  }
  state.refreshInProgress = true;

  const finish = (err, updated) => {
    state.refreshInProgress = false;
    const queued = state.queuedRefreshCallbacks;
    state.queuedRefreshCallbacks = [];
    done(err, updated);
    queued.forEach(cb => cb(err, updated));
  };

  const conditionals = {};
  if (state.cache.etag)         conditionals['If-None-Match']     = state.cache.etag;
  if (state.cache.lastModified) conditionals['If-Modified-Since'] = state.cache.lastModified;

  fetchUrl(state.url, conditionals, MAX_REDIRECTS, (err, res) => {
    if (err) {
      const isConnectivity = CONNECTIVITY_ERRORS.has(err.code) ||
                             err.message === 'Fetch timed out';

      if (isConnectivity) {
        // Expected when VPN is disconnected or machine is off-network.
        // Keep it quiet — the cached file is still being served fine.
        // No toast: VPN dropping is routine and would spam the user.
        const reason  = err.code || 'timeout';
        const serving = state.cache.body
          ? `serving cached ${state.cache.body.length.toLocaleString()} bytes`
          : 'no cache yet — Outlook will get 503 until network returns';
        logger.info(`[${state.localName}] Network unavailable (${reason}) — ${serving}`);
        state.networkDown = true;   // remember, so we can toast on recovery
      } else {
        // Unexpected error: bad URL, auth failure, TLS error, etc.
        // These are worth a toast — the user probably needs to act.
        logger.error(`[${state.localName}] Fetch failed: ${err.message}`);
        notify('Fetch error', `${state.localName}: ${err.message}`);
      }

      state.lastFetchError = {
        message: err.message,
        code:    err.code   || null,
        at:      new Date().toISOString(),
      };
      return finish(err);
    }

    // ── Not Modified ──────────────────────────────────────────
    if (res.status === 'not-modified') {
      state.lastFetchError = null;
      if (state.networkDown) {
        state.networkDown = false;
        notify('Back online', `${state.localName}: connection restored — calendar is up to date.`);
      }
      logger.info(`[${state.localName}] iCal unchanged (304) — cache: ${(state.cache.body || '').length.toLocaleString()} bytes`);
      return finish(null, false);
    }

    // ── Sanity check ──────────────────────────────────────────
    if (!res.body.includes('BEGIN:VCALENDAR')) {
      logger.warn(`[${state.localName}] Response does not appear to be a valid iCal file (no BEGIN:VCALENDAR)`);
    }

    // ── Detect what actually changed ──────────────────────────
    // A 200 doesn't guarantee the content changed — some servers don't send
    // ETags and just return the full body every time. Compare against the
    // previous body so we only toast on a genuine content change.
    const hadCache      = state.cache.body !== null;
    const contentChanged = state.cache.body !== res.body;
    const recovered     = state.networkDown;   // were we offline before this success?

    // ── Update memory cache ───────────────────────────────────
    state.cache.body         = res.body;
    state.cache.etag         = res.etag;
    state.cache.lastModified = res.lastModified;
    state.cache.fetchedAt    = new Date();
    state.cache.fromDisk     = false;
    state.lastFetchError     = null;
    state.networkDown        = false;

    // ── Persist to disk ───────────────────────────────────────
    // Written synchronously so it's always in a consistent state.
    // File is read on startup before the first network request succeeds.
    saveDiskCache(state.cacheFile, state.cache.body);

    logger.info(`[${state.localName}] iCal refreshed — ${state.cache.body.length.toLocaleString()} bytes`
      + (res.etag ? ` ETag:${res.etag}` : ''));

    // ── Notifications ─────────────────────────────────────────
    // Recovery takes priority: if we were offline, a single "back online"
    // toast is the meaningful event — don't also fire an "updated" toast.
    if (recovered) {
      notify('Back online', `${state.localName}: connection restored — calendar cached (${state.cache.body.length.toLocaleString()} bytes).`);
    } else if (contentChanged && hadCache) {
      // Only toast "updated" when we already had data and it changed —
      // avoids a toast on the very first fetch at startup.
      notify('Calendar updated', `${state.localName}: new data received (${state.cache.body.length.toLocaleString()} bytes).`);
    }

    finish(null, true);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function startServer(cfg) {
  const intervalMs = cfg.interval * 60_000;
  const debugMode  = cfg.debug === true;

  // Honour the notify setting from config/CLI, then load the module.
  notifyEnabled = cfg.notify !== false;
  initNotifier();

  const calendars = cfg.calendars.map(c => createCalendarState(c.index, c.url, c.localName));
  // Path lookup for named routing, e.g. "/calendar2.ics" -> that calendar's state.
  const calendarByPath = new Map(calendars.map(s => [`/${s.localName}`, s]));

  logger.info('─'.repeat(58));
  logger.info(`${APP_NAME} v${VERSION}`);
  calendars.forEach(s => {
    logger.info(`  Calendar ${s.index}  : ${s.url}`);
    logger.info(`    → served at /${s.localName}`);
  });
  logger.info(`  Local port : ${cfg.port}`);
  logger.info(`  Interval   : ${cfg.interval} minute(s)`);
  logger.info(`  Toasts     : ${notifyEnabled ? (notifier ? 'enabled' : 'enabled (module missing)') : 'disabled'}`);
  logger.info(`  Debug mode : ${debugMode ? 'on — toasting startup/shutdown/HTTP activity' : 'off'}`);
  logger.info(`  Log file   : ${LOG_FILE}`);
  logger.info('─'.repeat(58));

  // ── Warm up from disk cache ────────────────────────────────
  // Load each calendar's last persisted iCal immediately so Outlook gets a
  // response even before the first network request completes (or if it fails).
  calendars.forEach(s => {
    const diskBody = loadDiskCache(s.cacheFile);
    if (diskBody) {
      s.cache.body     = diskBody;
      s.cache.fromDisk = true;
      logger.info(`[${s.localName}] Loaded ${diskBody.length.toLocaleString()} bytes from disk cache — ready to serve`);
    } else {
      logger.info(`[${s.localName}] No disk cache found — will serve after first successful fetch`);
    }
  });

  // ── Initial network fetch ──────────────────────────────────
  calendars.forEach(s => {
    refreshIcal(s, (err) => {
      if (err && !s.cache.body) {
        logger.warn(`[${s.localName}] Initial fetch failed and no disk cache — Outlook will get 503 until network recovers`);
      }
    });
  });

  // ── Scheduled refresh ──────────────────────────────────────
  const timer = setInterval(() => {
    calendars.forEach(s => refreshIcal(s, () => {}));
  }, intervalMs);
  timer.unref(); // Don't prevent clean process exit

  // ── Request handler ───────────────────────────────────────
  const server = http.createServer((req, res) => {
    logger.info(`${req.method} ${req.url}`);
    if (debugMode) notify('Debug: HTTP', `${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    const urlPath = req.url.split('?')[0];

    // ── /status or /health ────────────────────────────────────
    if (urlPath === '/status' || urlPath === '/health') {
      const calendarStatuses = calendars.map(s => {
        const next = s.cache.fetchedAt
          ? new Date(+s.cache.fetchedAt + intervalMs).toISOString()
          : null;
        const diskExists = fs.existsSync(s.cacheFile);
        let   diskBytes  = 0;
        if (diskExists) {
          try { diskBytes = fs.statSync(s.cacheFile).size; } catch (_) {}
        }
        return {
          path:             `/${s.localName}`,
          sourceUrl:        s.url,
          status:           s.cache.body ? 'ok' : 'pending',
          message:          s.cache.body
                              ? (s.cache.fromDisk
                                  ? 'Serving disk cache — network fetch pending'
                                  : 'Calendar cached and ready')
                              : 'Waiting for first fetch',
          cacheBytes:       s.cache.body ? s.cache.body.length : 0,
          cacheFromDisk:    s.cache.fromDisk,
          fetchedAt:        s.cache.fetchedAt?.toISOString() ?? null,
          nextFetchAt:      next,
          diskCacheFile:    s.cacheFile,
          diskCacheExists:  diskExists,
          diskCacheBytes:   diskBytes,
          lastFetchError:   s.lastFetchError,
          networkDown:      s.networkDown,
        };
      });

      const readyCount = calendars.filter(s => s.cache.body).length;
      const overallStatus = readyCount === calendars.length ? 'ok'
        : readyCount > 0 ? 'partial' : 'pending';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:           overallStatus,
        message:          `${readyCount}/${calendars.length} calendar(s) cached and ready`,
        port:             cfg.port,
        intervalMinutes:  cfg.interval,
        calendars:        calendarStatuses,
        // Notifications
        notifications:    notifyEnabled ? (notifier ? 'enabled' : 'unavailable') : 'disabled',
        // Process info
        hostname:         os.hostname(),
        uptime:           `${Math.floor(process.uptime())}s`,
      }, null, 2));
      return;
    }

    // ── POST /refresh — force immediate re-fetch of every calendar ─────
    if (urlPath === '/refresh') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' });
        res.end('Send a POST to /refresh to trigger an immediate re-fetch.');
        return;
      }
      logger.info('Manual refresh triggered via /refresh endpoint');

      let remaining = calendars.length;
      const lines = [];
      calendars.forEach(s => {
        refreshIcal(s, (err) => {
          if (err) {
            const isConnectivity = CONNECTIVITY_ERRORS.has(err.code) ||
                                   err.message === 'Fetch timed out';
            if (isConnectivity && s.cache.body) {
              // Network is down but we have cached data — not a failure from
              // the caller's perspective, just inform them what's happening.
              lines.push(`/${s.localName}: network unavailable (${err.code || 'timeout'}) — serving cached data (${s.cache.body.length.toLocaleString()} bytes)`);
            } else {
              lines.push(`/${s.localName}: refresh failed — ${err.message}`);
            }
          } else {
            lines.push(`/${s.localName}: refreshed OK — ${s.cache.body ? s.cache.body.length.toLocaleString() : 0} bytes cached`);
          }

          if (--remaining === 0) {
            const anyCache = calendars.some(s2 => s2.cache.body);
            res.writeHead(anyCache ? 200 : 502, { 'Content-Type': 'text/plain' });
            res.end(lines.join('\n'));
          }
        });
      });
      return;
    }

    // ── iCal feed(s) ───────────────────────────────────────────
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let target = calendarByPath.get(urlPath);
    if (!target && calendars.length === 1) {
      // Legacy single-calendar behavior: Outlook can be pointed at ANY path
      // and still get the one configured feed — preserves pre-1.3 subscriptions.
      target = calendars[0];
    }

    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found. Available calendars: ${calendars.map(s => '/' + s.localName).join(', ')}`);
      return;
    }

    if (!target.cache.body) {
      res.writeHead(503, {
        'Content-Type': 'text/plain',
        'Retry-After':  '10',
      });
      res.end('Calendar not yet loaded. Please retry in a few seconds.');
      return;
    }

    const bodyBuf = Buffer.from(target.cache.body, 'utf8');
    res.writeHead(200, {
      'Content-Type':        'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${target.localName}"`,
      'Content-Length':      bodyBuf.length,
      'Cache-Control':       'no-cache, no-store, must-revalidate',
      'Last-Modified':       target.cache.fetchedAt?.toUTCString() ?? new Date().toUTCString(),
      'Access-Control-Allow-Origin': '*',
    });

    if (req.method === 'GET') res.end(bodyBuf);
    else res.end(); // HEAD — headers only
  });

  server.listen(cfg.port, '127.0.0.1', () => {
    logger.info('✓ Server ready');
    calendars.forEach(s => logger.info(`  iCal feed → http://localhost:${cfg.port}/${s.localName}`));
    logger.info(`  Status    → http://localhost:${cfg.port}/status`);
    logger.info(`  Refresh   → POST http://localhost:${cfg.port}/refresh`);
    if (debugMode) notify('Debug: started', `Listening on http://localhost:${cfg.port} (${calendars.length} calendar${calendars.length === 1 ? '' : 's'})`);
  });

  server.on('error', (err) => {
    logger.error(`Server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${cfg.port} is already in use. Choose a different port with --port`);
      notify('Startup failed', `Port ${cfg.port} is already in use.`);
    } else {
      notify('Server error', err.message);
    }
    // The server never bound, so there's nothing for server.close() to stop —
    // just cancel the polling timer that was already started above so the
    // process doesn't linger before exiting.
    clearInterval(timer);
    logger.info('Shutting down — server failed to start.');
    process.exit(1);
  });

  // ── Graceful shutdown ────────────────────────────────────────
  function shutdown(sig) {
    logger.info(`${sig} received — shutting down gracefully`);
    if (debugMode) notify('Debug: shutdown', `${sig} received — shutting down`);
    clearInterval(timer);
    server.close(() => { logger.info('Server closed. Goodbye.'); process.exit(0); });
    // Force-exit if still running after 5 s
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ─── Windows Service Helpers ──────────────────────────────────────────────────

function makeService() {
  let Service;
  try {
    ({ Service } = require('node-windows'));
  } catch (e) {
    logger.error('node-windows not found — run:  npm install');
    process.exit(1);
  }
  return new Service({
    name:        APP_NAME,
    description: 'Downloads remote iCal feed(s) and serves them locally for Outlook.',
    script:      path.resolve(__dirname, 'ical-proxy.js'),
    // No extra args: on start the service reads from ical-proxy.config.json
  });
}

function installService(cfg) {
  saveConfig(cfg); // Must exist before service is started
  const svc = makeService();

  svc.on('install', () => {
    logger.info('Windows service installed — starting now...');
    svc.start();
  });
  svc.on('start', () => {
    logger.info('Service is running!');
    cfg.calendars.forEach(c => {
      logger.info(`Add this URL to Outlook → http://localhost:${cfg.port}/${c.localName}`);
    });
    logger.info('To check status run:  node ical-proxy.js --status');
  });
  svc.on('alreadyinstalled', () => {
    logger.warn('Service is already installed.');
    logger.warn('Run --uninstall first, then --install again to update settings.');
  });
  svc.on('error', err => logger.error(`Service error: ${JSON.stringify(err)}`));

  logger.info('Installing Windows service (this requires Administrator)...');
  svc.install();
}

function uninstallService() {
  const svc = makeService();
  svc.on('uninstall', () => logger.info('Service removed successfully.'));
  svc.on('error', err  => logger.error(`Service error: ${JSON.stringify(err)}`));
  logger.info('Removing Windows service (this requires Administrator)...');
  svc.uninstall();
}

// ─── Help Text ────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║            iCal Proxy Server  v${VERSION}                        ║
║  Serves remote .ics feed(s) locally so Outlook can sync them ║
╚══════════════════════════════════════════════════════════════╝

USAGE
  node ical-proxy.js [OPTIONS]

OPTIONS
  --url <url>          Remote iCal / .ics feed URL      [required*]
                        Shorthand for --url1 (single-calendar mode)
  --url1 <url>          First calendar's feed URL
  --url2 <url>          Second calendar's feed URL, etc. (--url3, --url4, ...)
  --calendar1 <name>    Local filename for calendar 1    [default: calendar1.ics]
  --calendar2 <name>    Local filename for calendar 2, etc.
  --port <n>            Local HTTP port                  [default: 8080]
  --interval <mins>     Refresh interval in minutes      [default: 30]
  --notify              Enable Windows toast notifications   [default]
  --no-notify           Disable Windows toast notifications
  --debug               Toast on startup, shutdown, and every HTTP
                         request handled by the local server (foreground
                         runs only — never saved to the service config)
  --install             Install as a Windows background service
  --uninstall            Remove the Windows service
  --help, -h            Show this help

EXAMPLES
  # Run interactively (Ctrl-C to stop) — single calendar, any path works
  node ical-proxy.js --url https://example.com/feed.ics

  # Custom port, refresh every 15 minutes
  node ical-proxy.js --url https://example.com/feed.ics --port 9090 --interval 15

  # Watch startup/shutdown/HTTP activity as toasts while debugging
  node ical-proxy.js --url https://example.com/feed.ics --debug

  # Multiple calendars, each served at its own filename
  node ical-proxy.js --url1 https://example.com/work.ics --calendar1 work.ics \\
                      --url2 https://example.com/family.ics --calendar2 family.ics

  # Multiple calendars, default filenames (calendar1.ics, calendar2.ics)
  node ical-proxy.js --url1 https://example.com/work.ics --url2 https://example.com/family.ics

  # Install as auto-starting Windows service (must run as Administrator)
  node ical-proxy.js --install --url https://example.com/feed.ics --port 8080 --interval 30

  # Remove the service
  node ical-proxy.js --uninstall

ENDPOINTS (once running)
  GET  http://localhost:8080/calendar1.ics   ← paste this into Outlook
                                                (single-calendar mode: any path works)
  GET  http://localhost:8080/status           JSON health & cache info, all calendars
  POST http://localhost:8080/refresh          Force an immediate re-fetch of all calendars

OUTLOOK SETUP
  File → Account Settings → Internet Calendars → New
  Enter: http://localhost:8080/calendar1.ics  (or whichever local filename you set)

NOTIFICATIONS
  Windows toasts fire on: real fetch errors, calendar updates, and when
  the connection recovers. VPN drops / timeouts are silent by design.
  Note: toasts from a service running as LocalSystem won't show on the
  desktop (Session 0). Run in foreground, or set the service to log on
  as your user account, to see them.

LOG FILE
  ${LOG_FILE}

* --url is not required if a config file already exists from a previous run.
`);
}

// ─── Entry Point ────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();

  if (args.help) { printHelp(); process.exit(0); }

  // ── Service management ─────────────────────────────────────
  if (args.uninstall) { uninstallService(); return; }

  if (args.install) {
    if (!args.urls || Object.keys(args.urls).length === 0) {
      console.error('\nError: at least one --url (or --url1, --url2, ...) is required when using --install\n');
      process.exit(1);
    }
    installService(buildConfig(args));
    return;
  }

  // ── Start the proxy server ─────────────────────────────────
  // When launched with no args (e.g. by the Windows service manager),
  // we read the config that was saved during --install.
  if (process.argv.length <= 2 && !fs.existsSync(CONFIG_FILE)) {
    printHelp();
    process.exit(0);
  }

  let cfg;
  try {
    cfg = resolveConfig(args);
  } catch (e) {
    console.error(`\nError: ${e.message}\n`);
    printHelp();
    process.exit(1);
  }

  // --debug is a CLI-only diagnostic switch — deliberately never persisted
  // to ical-proxy.config.json, so an installed service never inherits it
  // and starts toasting on every request.
  cfg.debug = args.debug === true;

  startServer(cfg);
}

main();
