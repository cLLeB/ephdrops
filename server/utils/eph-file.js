/**
 * .eph File Utilities — Secure Auth Packet for Ephemeral Drops
 * 
 * An .eph file is a tiny (~200-500 byte) signed JSON packet that acts as a
 * secure pointer to a drop. It contains NO content — only:
 * - Drop ID
 * - Server URL  
 * - Timestamp
 * - HMAC-SHA256 signature (prevents forgery)
 * - Optional hint (e.g. "From Alice")
 * 
 * .eph files can be shared via:
 * - Android Nearby Share / Quick Share
 * - Bluetooth file transfer
 * - AirDrop (iOS/Mac, future)
 * - Email attachment
 * - Any file-sharing mechanism
 * 
 * MIME type: application/x-ephemeral-drop
 * Extension: .eph
 */

const crypto = require('crypto');
const { logger } = require('../utils');

// ─── Constants ────────────────────────────────────────────

const EPH_VERSION = 1;
const EPH_TYPE = 'ephemeral-drop';
const EPH_MIME_TYPE = 'application/x-ephemeral-drop';
const EPH_EXTENSION = '.eph';

// Maximum age for an .eph packet to be considered valid (48 hours)
// This is generous — the drop itself has its own TTL
const EPH_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Get the HMAC secret for .eph file signatures
 * Uses dedicated env var, falls back to CAP_SECRET
 */
function getEphSecret() {
  const secret = process.env.EPH_SECRET || process.env.CAP_SECRET;
  if (!secret) {
    throw new Error('[FATAL] EPH_SECRET or CAP_SECRET environment variable is required for .eph file HMAC signing.');
  }
  return secret;
}

/**
 * Get the server URL for .eph files
 */
function getServerUrl() {
  return process.env.APP_URL || 'https://chat.kyere.me';
}

// ─── Generate ─────────────────────────────────────────────

/**
 * Generate a signed .eph packet object
 * @param {string} dropId - The drop ID
 * @param {string|null} hint - Optional hint (e.g. "From Alice")
 * @returns {Object} .eph packet object
 */
function generateEphPacket(dropId, hint = null) {
  const ts = Date.now();
  const sig = generateSignature(dropId, ts);

  return {
    v: EPH_VERSION,
    type: EPH_TYPE,
    dropId,
    server: getServerUrl(),
    hint: hint || null,
    ts,
    sig,
  };
}

/**
 * Generate the .eph file content as a JSON string (for download)
 * @param {string} dropId - The drop ID
 * @param {string|null} hint - Optional hint
 * @returns {string} JSON string ready to be saved as .eph file
 */
function generateEphFileContent(dropId, hint = null) {
  const packet = generateEphPacket(dropId, hint);
  return JSON.stringify(packet, null, 2);
}

/**
 * Generate the .eph file as a Buffer (for direct download response)
 * @param {string} dropId - The drop ID
 * @param {string|null} hint - Optional hint
 * @returns {Buffer} Buffer of the .eph file content
 */
function generateEphFileBuffer(dropId, hint = null) {
  return Buffer.from(generateEphFileContent(dropId, hint), 'utf-8');
}

// ─── Validate ─────────────────────────────────────────────

/**
 * Parse and validate an .eph packet
 * @param {string|Object} input - Raw JSON string or parsed object
 * @returns {Object} { valid: true, dropId, hint } or { valid: false, error: string }
 */
function validateEphPacket(input) {
  try {
    let packet;

    if (typeof input === 'string') {
      try {
        packet = JSON.parse(input);
      } catch (e) {
        return { valid: false, error: 'Invalid .eph file: not valid JSON' };
      }
    } else if (typeof input === 'object' && input !== null) {
      packet = input;
    } else {
      return { valid: false, error: 'Invalid .eph file format' };
    }

    // Check version
    if (packet.v !== EPH_VERSION) {
      return { valid: false, error: `Unsupported .eph version: ${packet.v}` };
    }

    // Check type
    if (packet.type !== EPH_TYPE) {
      return { valid: false, error: `Invalid .eph type: ${packet.type}` };
    }

    // Check required fields
    if (!packet.dropId || typeof packet.dropId !== 'string') {
      return { valid: false, error: 'Missing or invalid drop ID' };
    }

    if (!packet.ts || typeof packet.ts !== 'number') {
      return { valid: false, error: 'Missing or invalid timestamp' };
    }

    if (!packet.sig || typeof packet.sig !== 'string') {
      return { valid: false, error: 'Missing or invalid signature' };
    }

    // Check age (prevent replay with very old packets)
    const age = Date.now() - packet.ts;
    if (age > EPH_MAX_AGE_MS) {
      return { valid: false, error: 'This .eph file has expired. Please request a new one.' };
    }

    if (age < -60000) {
      // More than 1 minute in the future — clock skew protection
      return { valid: false, error: 'Invalid .eph file timestamp' };
    }

    // Verify HMAC signature
    if (!verifySignature(packet.dropId, packet.ts, packet.sig)) {
      return { valid: false, error: 'Invalid signature — this .eph file may have been tampered with' };
    }

    return {
      valid: true,
      dropId: packet.dropId,
      encryptedHint: packet.encryptedHint || null,
      server: packet.server || null,
      ts: packet.ts,
    };
  } catch (e) {
    logger.error('Error validating .eph packet:', e.message);
    return { valid: false, error: 'Failed to validate .eph file' };
  }
}

// ─── Cryptographic Helpers ────────────────────────────────

/**
 * Generate HMAC-SHA256 signature
 */
function generateSignature(dropId, timestamp) {
  const data = `${dropId}:${timestamp}`;
  return crypto.createHmac('sha256', getEphSecret())
    .update(data)
    .digest('hex');
}

/**
 * Verify HMAC-SHA256 signature using timing-safe comparison
 */
function verifySignature(dropId, timestamp, signature) {
  try {
    const expected = generateSignature(dropId, timestamp);
    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');

    if (expectedBuf.length !== signatureBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch (e) {
    return false;
  }
}

// ─── Suggested filename ───────────────────────────────────

/**
 * Generate a suggested filename for the .eph download
 * @param {string} dropId - Drop ID
 * @param {string|null} hint - Optional hint
 * @returns {string} Filename like "drop-abc123.eph" or "drop-from-alice.eph"
 */
function suggestFilename(dropId, hint = null) {
  if (hint) {
    // Sanitize hint for filename
    const safeHint = hint
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 30);
    if (safeHint) {
      return `drop-${safeHint}${EPH_EXTENSION}`;
    }
  }
  return `drop-${dropId.substring(0, 8)}${EPH_EXTENSION}`;
}

module.exports = {
  EPH_VERSION,
  EPH_TYPE,
  EPH_MIME_TYPE,
  EPH_EXTENSION,
  generateEphPacket,
  generateEphFileContent,
  generateEphFileBuffer,
  validateEphPacket,
  generateSignature,
  verifySignature,
  suggestFilename,
  getServerUrl,
};
