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

const VERSION       = '1.0.0';
const APP_NAME      = 'iCal Proxy';
const CONFIG_FILE   = path.join(__dirname, 'ical-proxy.config.json');
const LOG_FILE      = path.join(__dirname, 'ical-proxy.log');
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT = 30_000; // ms

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
    };
    // Persist any overrides
    if (args.port || args.interval) saveConfig(cfg);
    return cfg;
  }

  throw new Error(
    'No iCal URL specified and no saved config found.\n' +
    'Provide --url <url>, or run with --install --url <url> first.'
  );
}

// ─── iCal Fetcher ─────────────────────────────────────────────────────────────

/** In-memory cache holding the last successfully fetched data. */
const cache = {
  body:         null,   // string — the raw iCal text
  etag:         null,   // ETag from last response (for conditional GETs)
  lastModified: null,   // Last-Modified header value
  fetchedAt:    null,   // Date of last successful fetch
};

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
 * @param {string}   sourceUrl
 * @param {Function} done(err, updated:boolean)
 */
function refreshIcal(sourceUrl, done) {
  const conditionals = {};
  if (cache.etag)         conditionals['If-None-Match']     = cache.etag;
  if (cache.lastModified) conditionals['If-Modified-Since'] = cache.lastModified;

  fetchUrl(sourceUrl, conditionals, MAX_REDIRECTS, (err, res) => {
    if (err) {
      logger.error(`Fetch failed: ${err.message}`);
      return done(err);
    }

    if (res.status === 'not-modified') {
      logger.info(`iCal unchanged (304) — cache: ${(cache.body || '').length.toLocaleString()} bytes`);
      return done(null, false);
    }

    // Sanity-check: warn if it doesn't look like iCal
    if (!res.body.includes('BEGIN:VCALENDAR')) {
      logger.warn('Response does not appear to be a valid iCal file (no BEGIN:VCALENDAR)');
    }

    cache.body         = res.body;
    cache.etag         = res.etag;
    cache.lastModified = res.lastModified;
    cache.fetchedAt    = new Date();

    logger.info(`iCal refreshed — ${cache.body.length.toLocaleString()} bytes`
      + (res.etag ? ` ETag:${res.etag}` : ''));
    done(null, true);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function startServer(cfg) {
  const intervalMs = cfg.interval * 60_000;

  logger.info('─'.repeat(58));
  logger.info(`${APP_NAME} v${VERSION}`);
  logger.info(`  Source URL : ${cfg.url}`);
  logger.info(`  Local port : ${cfg.port}`);
  logger.info(`  Interval   : ${cfg.interval} minute(s)`);
  logger.info(`  Log file   : ${LOG_FILE}`);
  logger.info('─'.repeat(58));

  // ── Initial fetch ──────────────────────────────────────────
  refreshIcal(cfg.url, (err) => {
    if (err) logger.warn('Initial fetch failed — will retry at next scheduled interval');
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:          cache.body ? 'ok' : 'pending',
        message:         cache.body
                           ? 'Calendar cached and ready'
                           : 'Waiting for first fetch',
        sourceUrl:       cfg.url,
        port:            cfg.port,
        intervalMinutes: cfg.interval,
        cacheBytes:      cache.body ? cache.body.length : 0,
        fetchedAt:       cache.fetchedAt?.toISOString() ?? null,
        nextFetchAt:     next,
        hostname:        os.hostname(),
        uptime:          `${Math.floor(process.uptime())}s`,
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
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          return res.end(`Refresh failed: ${err.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Refreshed OK — ${cache.body ? cache.body.length : 0} bytes cached`);
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
    }
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
