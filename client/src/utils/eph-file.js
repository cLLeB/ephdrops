/**
 * Client-side .eph file parser and handler
 * 
 * Handles:
 * - Parsing .eph files (JSON with HMAC signature)
 * - Triggering .eph file downloads for sharing
 * - Reading .eph files dropped/opened by the user
 * - Native share integration (Android Nearby Share, Bluetooth, etc.)
 */

import { validateEphAPI } from './drops';
import { downloadFileOnDevice } from './downloadHelper';

// ─── Constants ──────────────────────────────────────────────

export const EPH_MIME_TYPE = 'application/x-ephemeral-drop';
export const EPH_EXTENSION = '.eph';

// ─── Parse .eph File ────────────────────────────────────────

/**
 * Parse a raw .eph file (string or File object) into a packet object
 * @param {string|File|Blob} input - Raw .eph file content or File object
 * @returns {Promise<Object>} Parsed .eph packet
 */
export async function parseEphFile(input) {
  let text;

  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Blob || input instanceof File) {
    text = await input.text();
  } else {
    throw new Error('Invalid .eph file input');
  }

  try {
    const packet = JSON.parse(text);

    // Basic client-side validation (full validation happens server-side)
    if (!packet.v || !packet.type || !packet.dropId || !packet.sig) {
      throw new Error('Invalid .eph file structure');
    }

    if (packet.type !== 'ephemeral-drop') {
      throw new Error('Not an Ephemeral Drop file');
    }

    return packet;
  } catch (e) {
    if (e.message.includes('JSON')) {
      throw new Error('Invalid .eph file: corrupted or not a valid drop file');
    }
    throw e;
  }
}

/**
 * Validate an .eph packet against the server
 * Server verifies the HMAC signature and checks if drop still exists
 * @param {Object} ephPacket - Parsed .eph packet object
 * @returns {Promise<Object>} { dropId, hint, drop (metadata) }
 */
export async function validateEphFile(ephPacket) {
  return validateEphAPI(ephPacket);
}

// ─── Download / Share .eph File ─────────────────────────────

/**
 * Trigger a browser download of the .eph file
 * @param {Object} ephPacket - The .eph packet object (from server response)
 * @param {string} [filename] - Optional custom filename
 */
export async function downloadEphFile(ephPacket, filename) {
  const content = JSON.stringify(ephPacket, null, 2);
  const blob = new Blob([content], { type: EPH_MIME_TYPE });
  const suggestedName = filename || generateEphFilename(ephPacket);

  await downloadFileOnDevice(blob, suggestedName, EPH_MIME_TYPE);
}

/**
 * Share the .eph file using the Web Share API (Android Nearby Share, etc.)
 * Falls back to download if Web Share Files is not supported
 * @param {Object} ephPacket - The .eph packet object
 * @param {string} [title] - Share title
 * @returns {Promise<boolean>} True if shared successfully via native share
 */
export async function shareEphFile(ephPacket, title) {
  const content = JSON.stringify(ephPacket, null, 2);
  const filename = generateEphFilename(ephPacket);
  const blob = new Blob([content], { type: EPH_MIME_TYPE });
  const file = new File([blob], filename, { type: EPH_MIME_TYPE });

  // Try Web Share API with files support (Chrome Android, etc.)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: title || 'Ephemeral Drop',
        text: ephPacket.hint ? `Ephemeral Drop: ${ephPacket.hint}` : 'You received an Ephemeral Drop',
        files: [file],
      });
      return true;
    } catch (e) {
      // User cancelled or share failed — fall through to download
      if (e.name === 'AbortError') {
        return false; // User cancelled, don't fallback
      }
      console.warn('Web Share failed, falling back to download:', e);
    }
  }

  // Fallback: trigger download
  downloadEphFile(ephPacket, filename);
  return false;
}

/**
 * Create a shareable .eph Blob and File for use in Capacitor share
 * @param {Object} ephPacket
 * @returns {{ blob: Blob, file: File, filename: string }}
 */
export function createEphFileForShare(ephPacket) {
  const content = JSON.stringify(ephPacket, null, 2);
  const filename = generateEphFilename(ephPacket);
  const blob = new Blob([content], { type: EPH_MIME_TYPE });
  const file = new File([blob], filename, { type: EPH_MIME_TYPE });
  return { blob, file, filename, content };
}

// ─── Read .eph from File Input / Drag & Drop ────────────────

/**
 * Handle file input change event — check for .eph files
 * @param {Event} event - Input change event
 * @returns {Promise<Object|null>} Parsed .eph packet or null if not an .eph file
 */
export async function handleEphFileInput(event) {
  const file = event.target?.files?.[0];
  if (!file) return null;

  if (!file.name.endsWith(EPH_EXTENSION) && file.type !== EPH_MIME_TYPE) {
    return null; // Not an .eph file
  }

  return parseEphFile(file);
}

/**
 * Handle drag-and-drop event — check for .eph files
 * @param {DragEvent} event
 * @returns {Promise<Object|null>} Parsed .eph packet or null
 */
export async function handleEphFileDrop(event) {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return null;

  for (const file of files) {
    if (file.name.endsWith(EPH_EXTENSION) || file.type === EPH_MIME_TYPE) {
      return parseEphFile(file);
    }
  }

  return null;
}

// ─── URL Construction ───────────────────────────────────────

/**
 * Build the claim URL for a drop (deep link)
 * @param {string} dropId
 * @param {string} [server] - Server URL override
 * @returns {string} Full URL like https://chat.kyere.me/drop/abc123
 */
export function buildDropUrl(dropId, server) {
  const base = server || window.location.origin;
  return `${base}/drop/${dropId}`;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Generate a suggested filename for .eph download
 * @param {Object} ephPacket
 * @returns {string}
 */
function generateEphFilename(ephPacket) {
  if (ephPacket.hint) {
    const safe = ephPacket.hint
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 30);
    if (safe) return `drop-${safe}${EPH_EXTENSION}`;
  }
  return `drop-${ephPacket.dropId.substring(0, 8)}${EPH_EXTENSION}`;
}

/**
 * Check if the current browser supports Web Share API with file sharing
 * @returns {boolean}
 */
export function supportsNativeFileShare() {
  if (!navigator.canShare) return false;
  try {
    const testFile = new File(['test'], 'test.eph', { type: EPH_MIME_TYPE });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

/**
 * Format TTL for display
 * @param {number} expiresAt - Unix timestamp ms
 * @returns {string} Human-readable time remaining
 */
export function formatTimeRemaining(expiresAt) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'Expired';

  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((remaining % (60 * 1000)) / 1000);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
