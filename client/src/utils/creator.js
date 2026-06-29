/**
 * Creator ID management for persistent rooms.
 *
 * Uses sessionStorage instead of localStorage to limit the tracking
 * surface — the ID is unique per browser session (tab lifetime) and
 * is automatically cleared when the tab is closed. This aligns with
 * the "zero-persistence" privacy model.
 */

import { API_BASE } from './resolve-url.js';
import { secureFetch } from './secure-fetch.js';

const CREATOR_ID_KEY = 'eph-creator-id';
const CREATOR_TOKEN_KEY = 'eph-creator-token';

/**
 * Get or create creator ID from sessionStorage.
 * Falls back to localStorage for migration, but new IDs are always
 * stored in sessionStorage.
 * @returns {string} Creator ID (UUID)
 */
export const getCreatorId = () => {
    let creatorId = sessionStorage.getItem(CREATOR_ID_KEY);

    if (!creatorId) {
        // Migrate any existing localStorage ID for continuity within this session
        const legacyId = localStorage.getItem(CREATOR_ID_KEY);
        if (legacyId) {
            creatorId = legacyId;
            sessionStorage.setItem(CREATOR_ID_KEY, creatorId);
            localStorage.removeItem(CREATOR_ID_KEY); // clean up persistent store
        } else {
            creatorId = crypto.randomUUID();
            sessionStorage.setItem(CREATOR_ID_KEY, creatorId);
        }
    }

    return creatorId;
};

/**
 * Clear creator ID
 */
export const clearCreatorId = () => {
    sessionStorage.removeItem(CREATOR_ID_KEY);
    localStorage.removeItem(CREATOR_ID_KEY); // also clear any legacy entry
};

/**
 * Check if creator ID exists
 * @returns {boolean}
 */
export const hasCreatorId = () => {
    return sessionStorage.getItem(CREATOR_ID_KEY) !== null;
};

/**
 * Get or fetch creator token for authenticated room management.
 * Cached in sessionStorage per session.
 * @returns {Promise<string>} HMAC token for X-Creator-Token header
 */
export const getCreatorToken = async () => {
    const cached = sessionStorage.getItem(CREATOR_TOKEN_KEY);
    if (cached) return cached;

    const creatorId = getCreatorId();
    // secureFetch routes through OHTTP when available and transparently strips
    // the server's response padding, so no manual unpadResponse is needed.
    const res = await secureFetch(`${API_BASE}/api/creator-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId }),
    });
    if (!res.ok) throw new Error('Failed to get creator token');
    const { token } = await res.json();
    sessionStorage.setItem(CREATOR_TOKEN_KEY, token);
    return token;
};
