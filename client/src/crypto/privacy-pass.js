/**
 * Privacy Pass stub for the standalone Ephemeral Drops app.
 *
 * The full Ephemeral Chat app authenticates with anonymous Privacy Pass tokens
 * (RFC 9578) issued by its server. This standalone build ships only the Drops
 * API and has no token issuer, so Privacy Pass is intentionally disabled.
 *
 * `secureFetch` checks `isPrivacyPassReady()` before attaching an auth token and
 * gracefully proceeds without one when it returns false — so these stubs
 * preserve the exact public surface while keeping requests unauthenticated.
 */

/** @returns {false} Privacy Pass is never ready in the standalone build. */
export function isPrivacyPassReady() {
  return false;
}

/** @returns {null} No anonymous token is available. */
export function getAuthToken() {
  return null;
}

/** @returns {number} Always zero — no tokens are stored. */
export function getTokenCount() {
  return 0;
}

/** No-op background refresh to match the original module's surface. */
export async function refreshTokensIfNeeded() {
  return;
}

/** No-op initializer to match the original module's surface. */
export async function initPrivacyPass() {
  return false;
}
