/**
 * Secure Fetch — Wraps all HTTP requests with OHTTP + Privacy Pass
 *
 * Every `fetch()` call in the app should be replaced with `secureFetch()`
 * to get:
 *   1. **OHTTP** (RFC 9458): Request goes through an oblivious relay so the
 *      target server never sees the client's IP address.
 *   2. **Privacy Pass** (RFC 9578): Anonymous authentication tokens replace
 *      session cookies, preventing the server from linking requests across
 *      sessions.
 *
 * If OHTTP or Privacy Pass are unavailable (server not configured, tokens
 * exhausted), the wrapper gracefully degrades to a plain fetch but logs
 * a warning.
 *
 * @module utils/secure-fetch
 */

import { ohttpFetch, isOHTTPReady } from '../crypto/ohttp.js';
import { getAuthToken, isPrivacyPassReady, refreshTokensIfNeeded } from '../crypto/privacy-pass.js';
import { API_BASE } from './resolve-url.js';

// ─── Response Unpadding ────────────────────────────────────
// The server's padResponseMiddleware wraps JSON in a binary envelope:
//   [0x00 flag] [4-byte big-endian length] [original JSON] [random padding]
// and sets X-Padded: 1 + Content-Type: application/octet-stream.
// This helper transparently strips the envelope so .json() works.

const FLAG_REAL = 0x00;
const HEADER_SIZE = 5; // 1 flag + 4 length

/**
 * Strip server-side padding from a Response object.
 * If the response has `X-Padded: 1`, reads the binary body, extracts the
 * original JSON, and returns a new Response with the correct Content-Type.
 * Non-padded responses pass through unchanged.
 *
 * @param {Response} response
 * @returns {Promise<Response>} Unpadded response
 */
async function unpadResponse(response) {
  if (response.headers.get('X-Padded') !== '1') {
    return response; // Not padded — pass through
  }

  const buf = new Uint8Array(await response.arrayBuffer());

  if (buf.length < HEADER_SIZE || buf[0] !== FLAG_REAL) {
    // Malformed or unexpected — return raw text so caller can inspect
    return new Response(buf, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Read original length (big-endian uint32)
  const originalLength =
    (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];

  if (originalLength + HEADER_SIZE > buf.length) {
    // Length field is nonsense — return raw
    return new Response(buf, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const originalBytes = buf.slice(HEADER_SIZE, HEADER_SIZE + originalLength);

  // Build a clean response with the original JSON body
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Content-Type', 'application/json');
  newHeaders.delete('X-Padded');

  return new Response(originalBytes, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Secure fetch wrapper.
 *
 * @param {string} url - Request URL
 * @param {RequestInit} [options={}] - Standard fetch options
 * @returns {Promise<Response>}
 */
export async function secureFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});

  // ─── Privacy Pass: attach anonymous auth token ──────────
  if (isPrivacyPassReady()) {
    const tokenHeader = getAuthToken();
    if (tokenHeader?.Authorization) {
      headers.set('Authorization', tokenHeader.Authorization);
    }
  }

  // Refresh tokens in the background if running low
  refreshTokensIfNeeded(API_BASE).catch(() => {});

  const mergedOptions = { ...options, headers };

  // ─── OHTTP: route through oblivious relay ───────────────
  if (isOHTTPReady()) {
    try {
      const raw = await ohttpFetch(method, url, mergedOptions);
      return unpadResponse(raw);
    } catch (e) {
      console.warn('⚠️ OHTTP fetch failed, falling back to direct:', e.message);
    }
  }

  // ─── Direct fetch (degraded mode) ───────────────────────
  const raw = await fetch(url, { method, ...mergedOptions });
  return unpadResponse(raw);
}

/**
 * Secure JSON fetch — convenience wrapper.
 *
 * @param {string} url
 * @param {Object} [body] - JSON body (auto-stringified)
 * @param {RequestInit} [options={}]
 * @returns {Promise<any>} Parsed JSON response
 */
export async function secureFetchJSON(url, body, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');

  const fetchOptions = {
    ...options,
    headers,
  };

  if (body !== undefined && body !== null) {
    fetchOptions.body = JSON.stringify(body);
    fetchOptions.method = fetchOptions.method || 'POST';
  }

  const response = await secureFetch(url, fetchOptions);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

export { unpadResponse };
export default secureFetch;
