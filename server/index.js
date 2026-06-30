/**
 * Standalone Ephemeral Drops server.
 *
 * Serves only the Drops API (/api/drops) plus the built client. There is no
 * chat, no WebSocket layer, and no OHTTP/Privacy-Pass relay — just the
 * encrypted drop create/claim/view flow, exactly as it behaves in the source
 * Ephemeral Chat project.
 *
 * The server only ever stores ciphertext and hashed usernames; it never sees
 * plaintext content or plaintext usernames.
 */

const path = require('path');
// Load .env from the project root (one level up from /server) regardless of the
// process working directory — `npm start` runs with cwd=server/, so a bare
// dotenv.config() would miss the repo-root .env next to .env.example. On hosted
// platforms (Render/Hugging Face) env vars come from the platform and no .env
// file exists, which dotenv handles silently.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const { logger } = require('./utils');
const { DropManager } = require('./drops');
const { createDropRoutes } = require('./drops-routes');
const { corsMiddleware } = require('./cors');

const app = express();
const PORT = process.env.PORT || 3002;

// ─── Fail fast on missing HMAC secret ───────────────────────
// drops.js / utils/eph-file.js require EPH_SECRET (or CAP_SECRET) to sign the
// .eph packets. Surface a clear error at startup rather than on first request.
if (!process.env.EPH_SECRET && !process.env.CAP_SECRET) {
  logger.error('[FATAL] EPH_SECRET (or CAP_SECRET) environment variable is required.');
  logger.error('        Set one before starting, e.g. EPH_SECRET=$(openssl rand -hex 32)');
  process.exit(1);
}

// Trust the first proxy hop so req.ip is the real client IP behind a reverse proxy.
app.set('trust proxy', 1);

// Cross-origin access for the native apps (web client is same-origin). Mounted
// before the API routes so it also answers CORS preflight (OPTIONS) requests.
app.use('/api', corsMiddleware);

// ─── Drop Manager + API routes ──────────────────────────────
const dropManager = new DropManager();
logger.info('📦 Ephemeral Drops system initialized');

// Announce the active payload storage backend so it's obvious in the logs
// whether R2 picked up its env vars (a stale process / missing var silently
// falls back to in-memory, which caps uploads at 25MB).
const r2 = require('./r2');
if (r2.isR2Enabled()) {
  logger.info(`☁️  Payload storage: Cloudflare R2 (bucket "${process.env.R2_BUCKET}") — large uploads enabled`);
} else {
  logger.info('💾 Payload storage: in-memory (25MB cap). Set R2_* env vars to enable large uploads.');
}

// Elevated JSON limit for the drops API — base64-encoded encrypted payloads
// can be large. Must be registered before the routes are mounted.
app.use('/api/drops', express.json({ limit: '50mb' }));
app.use('/api/drops', createDropRoutes(dropManager));
logger.info('📦 Drop API routes mounted at /api/drops');

// ─── Health checks ──────────────────────────────────────────
// /api/health — richer payload with drop stats (for dashboards/debugging).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, stats: dropManager.getStats() });
});

// /health — tiny, cheap endpoint for external uptime pings (e.g. UptimeRobot)
// that keep a free Render instance from idling. No body work, no stats, no
// caching by intermediaries.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).type('text/plain').send('OK');
});

// ─── Android App Links verification ─────────────────────────
// Lets the Android app open https://<this-host>/drop/* links directly instead
// of the browser. Must be served as JSON at this exact path. Declared before
// the static/SPA handlers because express.static ignores dotfile paths and the
// SPA fallback would otherwise return index.html here.
//
// The fingerprint below is the app's upload/signing key. NOTE: once the app is
// published with Google Play App Signing, Play re-signs with its own key — add
// that key's SHA-256 (Play Console → App integrity → App signing) to the array.
const ASSETLINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'space.hf.beternow.ephdrops',
      sha256_cert_fingerprints: [
        'E1:DE:29:60:38:2F:82:99:11:55:85:BB:2C:BB:6D:A8:C2:7B:BD:AC:E4:8E:00:2F:91:F6:94:FF:F0:D5:B9:12',
      ],
    },
  },
];
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(ASSETLINKS);
});

// ─── Static client + SPA fallback ───────────────────────────
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

// Privacy policy at a clean /privacy URL (the file ships in the client build at
// dist/privacy/index.html). Declared before the SPA fallback so it isn't
// swallowed and rewritten to the app's index.html.
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(clientDist, 'privacy', 'index.html'), (err) => {
    if (err) res.status(404).send('Privacy policy not found.');
  });
});

// Send index.html for any non-API route so client-side routes
// (/drop/:id, /my-drops) survive a hard refresh.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) {
      res
        .status(404)
        .send('Client build not found. Run "npm run build" in ../client first.');
    }
  });
});

const server = app.listen(PORT, () => {
  logger.info(`🚀 Ephemeral Drops server running on port ${PORT}`);
});

// ─── Graceful shutdown ──────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down`);
  dropManager.shutdown();
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
