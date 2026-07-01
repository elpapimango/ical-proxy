#!/usr/bin/env node
'use strict';

/**
 * ical-proxy.js
 *
 * Downloads a remote iCal feed and re-serves it locally over HTTP.
 * Outlook (or any calendar client) can subscribe to the local URL instead
 * of the remote one, with automatic background refreshes.
 *
 * Usage:
 *   node ical-proxy.js --url <url> [--port 8080] [--interval 30]
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

const VERSION       = '1.2.0';
const APP_NAME      = 'iCal Proxy';
const CONFIG_FILE   = path.join(__dirname, 'ical-proxy.config.json');
const LOG_FILE      = path.join(__dirname, 'ical-proxy.log');
const CACHE_FILE    = path.join(__dirname, 'ical-proxy.cache.ics'); // persisted across restarts
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

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--url':       out.url       = argv[++i]; break;
      case '--port':      out.port      = Number(argv[++i]); break;
      case '--interval':  out.interval  = Number(argv[++i]); break;
      case '--install':   out.install   = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--no-notify': out.notify    = false; break;
      case '--notify':    out.notify    = true; break;
      case '--help':
      case '-h':          out.help      = true; break;
    }
  }
  return out;
}

// ─── Config ───────────────────────────────────────────────────────────────────

function buildConfig(args) {
  return {
    url:      args.url,
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
  if (!cfg.url) throw new Error('Config is missing the required "url" field.');
  return cfg;
}

/**
 * Resolve runtime config with this priority:
 *   1. --url present on CLI  → use CLI args (also save for future service runs)
 *   2. No --url but config.json exists  → load from file, allow port/interval overrides
 *   3. Neither  → throw (caller will print help and exit)
 */
function resolveConfig(args) {
  if (args.url) {
    const cfg = buildConfig(args);
    saveConfig(cfg);          // Persist so Windows service can read it on restart
    return cfg;
  }

  if (fs.existsSync(CONFIG_FILE)) {
    const saved = loadConfig();
    const cfg = {
      url:      saved.url,
      port:     Number(args.port)     || saved.port     || 8080,
      interval: Number(args.interval) || saved.interval || 30,
      // CLI flag wins if present; otherwise fall back to saved value (default true)
      notify:   args.notify !== undefined ? args.notify
                  : (saved.notify !== undefined ? saved.notify : true),
    };
    // Persist any overrides
    if (args.port || args.interval || args.notify !== undefined) saveConfig(cfg);
    return cfg;
  }

  throw new Error(
    'No iCal URL specified and no saved config found.\n' +
    'Provide --url <url>, or run with --install --url <url> first.'
  );
}

// ─── Disk Cache ───────────────────────────────────────────────────────────────

/**
 * Write the iCal body to disk so it survives process restarts and is still
 * available when the external network is unreachable (e.g. VPN disconnected).
 */
function saveDiskCache(body) {
  try {
    fs.writeFileSync(CACHE_FILE, body, 'utf8');
  } catch (e) {
    logger.warn(`Disk cache write failed: ${e.message}`);
  }
}

/**
 * Load a previously saved iCal body from disk.
 * Returns the content string, or null if nothing valid is on disk.
 */
function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const body = fs.readFileSync(CACHE_FILE, 'utf8');
    // Quick sanity check before trusting the file
    if (body.includes('BEGIN:VCALENDAR')) return body;
    logger.warn('Disk cache exists but does not look like a valid iCal — ignoring');
  } catch (e) {
    logger.warn(`Disk cache read failed: ${e.message}`);
  }
  return null;
}

// ─── iCal Fetcher ─────────────────────────────────────────────────────────────

/** In-memory cache holding the last successfully fetched data. */
const cache = {
  body:         null,   // string — the raw iCal text
  etag:         null,   // ETag from last response (for conditional GETs)
  lastModified: null,   // Last-Modified header value
  fetchedAt:    null,   // Date of last successful fetch
  fromDisk:     false,  // true if cache was warm-loaded from disk (not from network)
};

/**
 * Tracks the most recent fetch error so /status can surface it.
 * Reset to null on every successful fetch.
 */
let lastFetchError = null;

/**
 * True while the remote feed is unreachable (connectivity errors).
 * Used to fire a single "network recovered" toast when it comes back,
 * rather than toasting on every failed poll.
 */
let networkDown = false;

/**
 * Guards against overlapping refreshIcal() runs. The scheduled interval and
 * a manual POST /refresh can otherwise both be in flight at once; whichever
 * network response lands last wins and can stomp a newer result with a
 * stale one (both in the in-memory cache and on disk via saveDiskCache).
 * While a refresh is in progress, additional callers are queued and all
 * get the result of the single in-flight run instead of starting their own.
 */
let refreshInProgress = false;
let queuedRefreshCallbacks = [];

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
 * Refresh the in-memory cache from the remote iCal URL.
 * Uses conditional GET (ETag / If-Modified-Since) to save bandwidth.
 *
 * Connectivity errors (VPN down, DNS failure, socket timeout, etc.) are logged
 * at INFO level and do NOT evict the existing cache — Outlook keeps getting the
 * last known-good data until the network comes back.
 *
 * On success the body is also written to disk (CACHE_FILE) so it survives
 * service restarts without needing a network round-trip.
 *
 * @param {string}   sourceUrl
 * @param {Function} done(err, updated:boolean)
 */
function refreshIcal(sourceUrl, done) {
  // Coalesce with an in-flight run instead of starting a second overlapping
  // fetch — see refreshInProgress comment above.
  if (refreshInProgress) {
    queuedRefreshCallbacks.push(done);
    return;
  }
  refreshInProgress = true;

  const finish = (err, updated) => {
    refreshInProgress = false;
    const queued = queuedRefreshCallbacks;
    queuedRefreshCallbacks = [];
    done(err, updated);
    queued.forEach(cb => cb(err, updated));
  };

  const conditionals = {};
  if (cache.etag)         conditionals['If-None-Match']     = cache.etag;
  if (cache.lastModified) conditionals['If-Modified-Since'] = cache.lastModified;

  fetchUrl(sourceUrl, conditionals, MAX_REDIRECTS, (err, res) => {
    if (err) {
      const isConnectivity = CONNECTIVITY_ERRORS.has(err.code) ||
                             err.message === 'Fetch timed out';

      if (isConnectivity) {
        // Expected when VPN is disconnected or machine is off-network.
        // Keep it quiet — the cached file is still being served fine.
        // No toast: VPN dropping is routine and would spam the user.
        const reason  = err.code || 'timeout';
        const serving = cache.body
          ? `serving cached ${cache.body.length.toLocaleString()} bytes`
          : 'no cache yet — Outlook will get 503 until network returns';
        logger.info(`Network unavailable (${reason}) — ${serving}`);
        networkDown = true;   // remember, so we can toast on recovery
      } else {
        // Unexpected error: bad URL, auth failure, TLS error, etc.
        // These are worth a toast — the user probably needs to act.
        logger.error(`Fetch failed: ${err.message}`);
        notify('Fetch error', err.message);
      }

      lastFetchError = {
        message: err.message,
        code:    err.code   || null,
        at:      new Date().toISOString(),
      };
      return finish(err);
    }

    // ── Not Modified ──────────────────────────────────────────
    if (res.status === 'not-modified') {
      lastFetchError = null;
      if (networkDown) {
        networkDown = false;
        notify('Back online', 'Connection restored — calendar is up to date.');
      }
      logger.info(`iCal unchanged (304) — cache: ${(cache.body || '').length.toLocaleString()} bytes`);
      return finish(null, false);
    }

    // ── Sanity check ──────────────────────────────────────────
    if (!res.body.includes('BEGIN:VCALENDAR')) {
      logger.warn('Response does not appear to be a valid iCal file (no BEGIN:VCALENDAR)');
    }

    // ── Detect what actually changed ──────────────────────────
    // A 200 doesn't guarantee the content changed — some servers don't send
    // ETags and just return the full body every time. Compare against the
    // previous body so we only toast on a genuine content change.
    const hadCache      = cache.body !== null;
    const contentChanged = cache.body !== res.body;
    const recovered     = networkDown;   // were we offline before this success?

    // ── Update memory cache ───────────────────────────────────
    cache.body         = res.body;
    cache.etag         = res.etag;
    cache.lastModified = res.lastModified;
    cache.fetchedAt    = new Date();
    cache.fromDisk     = false;
    lastFetchError     = null;
    networkDown        = false;

    // ── Persist to disk ───────────────────────────────────────
    // Written synchronously so it's always in a consistent state.
    // File is read on startup before the first network request succeeds.
    saveDiskCache(cache.body);

    logger.info(`iCal refreshed — ${cache.body.length.toLocaleString()} bytes`
      + (res.etag ? ` ETag:${res.etag}` : ''));

    // ── Notifications ─────────────────────────────────────────
    // Recovery takes priority: if we were offline, a single "back online"
    // toast is the meaningful event — don't also fire an "updated" toast.
    if (recovered) {
      notify('Back online', `Connection restored — calendar cached (${cache.body.length.toLocaleString()} bytes).`);
    } else if (contentChanged && hadCache) {
      // Only toast "updated" when we already had data and it changed —
      // avoids a toast on the very first fetch at startup.
      notify('Calendar updated', `New data received (${cache.body.length.toLocaleString()} bytes).`);
    }

    finish(null, true);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function startServer(cfg) {
  const intervalMs = cfg.interval * 60_000;

  // Honour the notify setting from config/CLI, then load the module.
  notifyEnabled = cfg.notify !== false;
  initNotifier();

  logger.info('─'.repeat(58));
  logger.info(`${APP_NAME} v${VERSION}`);
  logger.info(`  Source URL : ${cfg.url}`);
  logger.info(`  Local port : ${cfg.port}`);
  logger.info(`  Interval   : ${cfg.interval} minute(s)`);
  logger.info(`  Toasts     : ${notifyEnabled ? (notifier ? 'enabled' : 'enabled (module missing)') : 'disabled'}`);
  logger.info(`  Log file   : ${LOG_FILE}`);
  logger.info(`  Disk cache : ${CACHE_FILE}`);
  logger.info('─'.repeat(58));

  // ── Warm up from disk cache ────────────────────────────────
  // Load the last persisted iCal immediately so Outlook gets a response
  // even before the first network request completes (or if it fails).
  const diskBody = loadDiskCache();
  if (diskBody) {
    cache.body     = diskBody;
    cache.fromDisk = true;
    logger.info(`Loaded ${diskBody.length.toLocaleString()} bytes from disk cache — ready to serve`);
  } else {
    logger.info('No disk cache found — will serve after first successful fetch');
  }

  // ── Initial network fetch ──────────────────────────────────
  refreshIcal(cfg.url, (err) => {
    if (err && !cache.body) {
      logger.warn('Initial fetch failed and no disk cache — Outlook will get 503 until network recovers');
    }
  });

  // ── Scheduled refresh ──────────────────────────────────────
  const timer = setInterval(() => refreshIcal(cfg.url, () => {}), intervalMs);
  timer.unref(); // Don't prevent clean process exit

  // ── Request handler ───────────────────────────────────────
  const server = http.createServer((req, res) => {
    logger.info(`${req.method} ${req.url}`);

    // ── /status or /health ────────────────────────────────────
    if (req.url === '/status' || req.url === '/health') {
      const next = cache.fetchedAt
        ? new Date(+cache.fetchedAt + intervalMs).toISOString()
        : null;
      const diskExists = fs.existsSync(CACHE_FILE);
      let   diskBytes  = 0;
      if (diskExists) {
        try { diskBytes = fs.statSync(CACHE_FILE).size; } catch (_) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:           cache.body ? 'ok' : 'pending',
        message:          cache.body
                            ? (cache.fromDisk
                                ? 'Serving disk cache — network fetch pending'
                                : 'Calendar cached and ready')
                            : 'Waiting for first fetch',
        sourceUrl:        cfg.url,
        port:             cfg.port,
        intervalMinutes:  cfg.interval,
        // In-memory cache
        cacheBytes:       cache.body ? cache.body.length : 0,
        cacheFromDisk:    cache.fromDisk,
        fetchedAt:        cache.fetchedAt?.toISOString() ?? null,
        nextFetchAt:      next,
        // Disk cache
        diskCacheFile:    CACHE_FILE,
        diskCacheExists:  diskExists,
        diskCacheBytes:   diskBytes,
        // Last error (null when last fetch was successful)
        lastFetchError:   lastFetchError,
        networkDown:      networkDown,
        // Notifications
        notifications:    notifyEnabled ? (notifier ? 'enabled' : 'unavailable') : 'disabled',
        // Process info
        hostname:         os.hostname(),
        uptime:           `${Math.floor(process.uptime())}s`,
      }, null, 2));
      return;
    }

    // ── POST /refresh — force immediate re-fetch ───────────────
    if (req.url === '/refresh') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' });
        res.end('Send a POST to /refresh to trigger an immediate re-fetch.');
        return;
      }
      logger.info('Manual refresh triggered via /refresh endpoint');
      refreshIcal(cfg.url, (err) => {
        if (err) {
          const isConnectivity = CONNECTIVITY_ERRORS.has(err.code) ||
                                 err.message === 'Fetch timed out';
          if (isConnectivity && cache.body) {
            // Network is down but we have cached data — not a failure from
            // the caller's perspective, just inform them what's happening.
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end(
              `Network unavailable (${err.code || 'timeout'}) — ` +
              `serving cached data (${cache.body.length.toLocaleString()} bytes)`
            );
          }
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          return res.end(`Refresh failed: ${err.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Refreshed OK — ${cache.body ? cache.body.length.toLocaleString() : 0} bytes cached`);
      });
      return;
    }

    // ── iCal feed — serve on any other path ───────────────────
    // (Outlook will call whatever URL the user subscribed to)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    if (!cache.body) {
      res.writeHead(503, {
        'Content-Type': 'text/plain',
        'Retry-After':  '10',
      });
      res.end('Calendar not yet loaded. Please retry in a few seconds.');
      return;
    }

    const bodyBuf = Buffer.from(cache.body, 'utf8');
    res.writeHead(200, {
      'Content-Type':        'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="calendar.ics"',
      'Content-Length':      bodyBuf.length,
      'Cache-Control':       'no-cache, no-store, must-revalidate',
      'Last-Modified':       cache.fetchedAt?.toUTCString() ?? new Date().toUTCString(),
      'Access-Control-Allow-Origin': '*',
    });

    if (req.method === 'GET') res.end(bodyBuf);
    else res.end(); // HEAD — headers only
  });

  server.listen(cfg.port, '127.0.0.1', () => {
    logger.info('✓ Server ready');
    logger.info(`  iCal feed → http://localhost:${cfg.port}/calendar.ics`);
    logger.info(`  Status    → http://localhost:${cfg.port}/status`);
    logger.info(`  Refresh   → POST http://localhost:${cfg.port}/refresh`);
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
    description: 'Downloads a remote iCal feed and serves it locally for Outlook.',
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
    logger.info(`Add this URL to Outlook → http://localhost:${cfg.port}/calendar.ics`);
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
║  Serves a remote .ics feed locally so Outlook can sync it   ║
╚══════════════════════════════════════════════════════════════╝

USAGE
  node ical-proxy.js [OPTIONS]

OPTIONS
  --url <url>          Remote iCal / .ics feed URL      [required*]
  --port <n>           Local HTTP port                  [default: 8080]
  --interval <mins>    Refresh interval in minutes      [default: 30]
  --notify             Enable Windows toast notifications   [default]
  --no-notify          Disable Windows toast notifications
  --install            Install as a Windows background service
  --uninstall          Remove the Windows service
  --help, -h           Show this help

EXAMPLES
  # Run interactively (Ctrl-C to stop)
  node ical-proxy.js --url https://example.com/feed.ics

  # Custom port, refresh every 15 minutes
  node ical-proxy.js --url https://example.com/feed.ics --port 9090 --interval 15

  # Install as auto-starting Windows service (must run as Administrator)
  node ical-proxy.js --install --url https://example.com/feed.ics --port 8080 --interval 30

  # Remove the service
  node ical-proxy.js --uninstall

ENDPOINTS (once running)
  GET  http://localhost:8080/calendar.ics   ← paste this into Outlook
  GET  http://localhost:8080/status          JSON health & cache info
  POST http://localhost:8080/refresh         Force an immediate re-fetch

OUTLOOK SETUP
  File → Account Settings → Internet Calendars → New
  Enter: http://localhost:8080/calendar.ics

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

// ─── Entry Point ──────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();

  if (args.help) { printHelp(); process.exit(0); }

  // ── Service management ─────────────────────────────────────
  if (args.uninstall) { uninstallService(); return; }

  if (args.install) {
    if (!args.url) {
      console.error('\nError: --url is required when using --install\n');
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

  startServer(cfg);
}

main();
