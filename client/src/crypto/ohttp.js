/**
 * OHTTP stub for the standalone Ephemeral Drops app.
 *
 * The full Ephemeral Chat app routes requests through an Oblivious HTTP relay
 * (RFC 9458). This standalone build ships only the Drops API, which has no
 * relay infrastructure, so OHTTP is intentionally disabled here.
 *
 * `secureFetch` checks `isOHTTPReady()` before attempting a relayed request and
 * gracefully falls back to a direct `fetch()` when it returns false — so these
 * stubs preserve the exact public surface while keeping the network path plain.
 */

/** @returns {false} OHTTP is never ready in the standalone build. */
export function isOHTTPReady() {
  return false;
}

/**
 * Never invoked, because `secureFetch` only calls this when `isOHTTPReady()` is
 * true. Present to preserve the module's import surface.
 */
export async function ohttpFetch() {
  throw new Error('OHTTP is not available in the standalone Ephemeral Drops build');
}

/** No-op initializer to match the original module's surface. */
export function initOHTTP() {
  return false;
}
