/**
 * Centralized URL resolution for the Ephemeral Chat client.
 *
 * Single source of truth — every module that needs the backend URL imports
 * from here instead of re-implementing env-check logic.
 *
 * Resolution order:
 *   1. VITE_API_URL env var (explicit override)
 *   2. Otherwise → '' (same-origin)
 *
 * In dev, same-origin means requests go out as relative `/api/...` paths to the
 * Vite dev server, which vite.config.js proxies to the API on :3002. Using a
 * relative base (rather than a hardcoded host/port) is what lets the app work
 * both at http://localhost:5173 and over the LAN (e.g. http://172.18.48.1:5173)
 * — the proxy runs server-side, so the browser's origin doesn't matter.
 */

let _cached = null;

/**
 * Resolve the backend base URL.
 * @returns {string} Base URL (empty string means same-origin)
 */
export function resolveBaseUrl() {
  if (_cached !== null) return _cached;

  if (import.meta.env.VITE_API_URL) {
    _cached = import.meta.env.VITE_API_URL.replace(/\/$/, '');
  } else {
    // Same-origin for both production and dev. In dev the Vite proxy forwards
    // /api to the backend on :3002 (see vite.config.js).
    _cached = '';
  }

  return _cached;
}

/** Pre-resolved constant for the common case. */
export const API_BASE = resolveBaseUrl();
