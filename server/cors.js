/**
 * Minimal CORS for the Drops API — required by the native apps.
 *
 * The web client is same-origin (served by this server) and needs no CORS. The
 * native shells load from app origins and call this API cross-origin:
 *   - Tauri desktop:     tauri://localhost  /  http://tauri.localhost
 *   - Capacitor Android: https://localhost
 *
 * Auth travels in the `Authorization` header (Privacy Pass), never in cookies,
 * and requests are sent without credentials — so allowing any origin is safe
 * (there is no ambient session to hijack).
 *
 * IMPORTANT: the API may wrap JSON in a padded binary envelope flagged by the
 * `X-Padded` response header, which the client strips in secure-fetch.js. A
 * cross-origin caller cannot read that header unless it is explicitly exposed,
 * so it MUST appear in Access-Control-Expose-Headers or responses break.
 */
function corsMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Expose-Headers', 'X-Padded, Content-Disposition');
  res.header('Access-Control-Max-Age', '86400');

  // Short-circuit CORS preflight requests.
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}

module.exports = { corsMiddleware };
