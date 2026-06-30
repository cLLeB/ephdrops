/**
 * Client-side encryption utilities for Ephemeral Drops
 * 
 * Encryption model:
 * 1. Generate a random AES-256-GCM master key
 * 2. Encrypt the content with the master key
 * 3. For each recipient username, derive a wrapping key from:
 *    SHA-256(username_lowercase + dropSalt)
 * 4. Wrap (encrypt) the master key with each recipient's wrapping key
 * 5. Store wrapped keys alongside the ciphertext on the server
 * 
 * Decryption model:
 * 1. Recipient enters their username
 * 2. Derive wrapping key: SHA-256(username_lowercase + dropSalt)
 * 3. Unwrap (decrypt) the master key using the wrapping key
 * 4. Decrypt the content with the master key
 * 
 * Security properties:
 * - Server NEVER sees plaintext content
 * - Server NEVER sees plaintext usernames (only SHA-256 hashes)
 * - Each recipient gets independent access
 * - Master key is random — not derived from any username
 * - AES-256-GCM provides authenticated encryption (tamper detection)
 */

import { secureFetch } from './secure-fetch.js';
import { API_BASE } from './resolve-url.js';
import { encryptLargeContent, decryptLargeContent } from '../crypto/large-file-crypto.js';
import { uploadMultipart, MULTIPART_THRESHOLD } from './multipart-upload.js';

// Marker stored in the drop's `iv` metadata field. The chunked payload format
// is fully self-describing (it carries its own per-chunk nonces), so this field
// is no longer used for decryption — but the server still requires a non-empty
// string, and it documents which payload format a drop uses.
const PAYLOAD_FORMAT_MARKER = 'chunked-v1';

// ─── Secure context guard ───────────────────────────────────

/**
 * Web Crypto's SubtleCrypto is only exposed in a "secure context": HTTPS, or
 * localhost/127.0.0.1 over HTTP. Loading the app over plain HTTP on a LAN IP
 * (e.g. http://172.18.x.x:5173) leaves `crypto.subtle` undefined, which would
 * otherwise surface as a cryptic "reading 'generateKey' of undefined". Throw a
 * clear, actionable message instead.
 *
 * @throws {Error} when SubtleCrypto is unavailable
 */
export function assertSecureCrypto() {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'Encryption is unavailable because this page is not a secure context. ' +
      'Open it over HTTPS, or via http://localhost (not a LAN IP like 172.x / 192.x).'
    );
  }
}

// ─── Hash Utilities ─────────────────────────────────────────

/**
 * SHA-256 hash a string, return hex
 * @param {string} input
 * @returns {Promise<string>} 64-char hex string
 */
export async function sha256(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hash a username for server-side matching
 * The username is lowercased and trimmed before hashing
 * @param {string} username
 * @param {string} salt - The drop's salt
 * @returns {Promise<string>} 64-char hex SHA-256 hash
 */
export async function hashUsername(username, salt) {
  const normalized = username.trim().toLowerCase();
  return sha256(normalized + ':' + salt);
}

// ─── Key Generation ─────────────────────────────────────────

/**
 * Generate a random salt for the drop
 * @returns {string} Base64-encoded 16-byte salt
 */
export function generateDropSalt() {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return uint8ToBase64(salt);
}

/**
 * Generate a random AES-256-GCM master key
 * @returns {Promise<CryptoKey>} The master key
 */
export async function generateMasterKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable (we need to export it for wrapping)
    ['encrypt', 'decrypt']
  );
}

/**
 * Derive a wrapping key from a username + salt
 * Used to wrap/unwrap the master key for each recipient
 * @param {string} username - Plaintext username
 * @param {string} salt - Drop salt (base64)
 * @returns {Promise<CryptoKey>} AES-GCM key derived from username
 */
export async function deriveWrappingKey(username, salt) {
  const normalized = username.trim().toLowerCase();
  const keyMaterial = normalized + ':wrap:' + salt;
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(keyMaterial));
  return crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ─── Encryption ─────────────────────────────────────────────

/**
 * Encrypt content with the master key.
 *
 * Returns the ciphertext as raw bytes (NOT base64). Base64-encoding large blobs
 * is expensive and, past ~350MB, exceeds the JS engine's max string length —
 * so callers base64-encode only when they actually need a string (the small IV,
 * the hint, or the in-memory create path). The big R2 upload uses the bytes
 * directly.
 *
 * @param {ArrayBuffer|Uint8Array|string} content - Content to encrypt
 * @param {CryptoKey} masterKey - AES-256-GCM key
 * @returns {Promise<{ ciphertextBytes: Uint8Array, iv: string }>} Raw ciphertext bytes + base64 IV
 */
export async function encryptContent(content, masterKey) {
  let data;
  if (typeof content === 'string') {
    data = new TextEncoder().encode(content);
  } else if (content instanceof ArrayBuffer) {
    data = new Uint8Array(content);
  } else {
    data = content;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    data
  );

  return {
    ciphertextBytes: new Uint8Array(encrypted),
    iv: uint8ToBase64(iv),
  };
}

/**
 * Decrypt content with the master key
 * @param {string} ciphertextBase64 - Base64-encoded ciphertext
 * @param {string} ivBase64 - Base64-encoded IV
 * @param {CryptoKey} masterKey - AES-256-GCM key
 * @returns {Promise<ArrayBuffer>} Decrypted content
 */
export async function decryptContent(ciphertextBase64, ivBase64, masterKey) {
  const ciphertext = base64ToUint8(ciphertextBase64);
  return decryptContentBytes(ciphertext, ivBase64, masterKey);
}

/**
 * Decrypt raw ciphertext bytes with the master key.
 * Used by the R2 path, where the ciphertext arrives as binary (not base64).
 * @param {ArrayBuffer|Uint8Array} ciphertextBytes - Raw ciphertext
 * @param {string} ivBase64 - Base64-encoded IV
 * @param {CryptoKey} masterKey - AES-256-GCM key
 * @returns {Promise<ArrayBuffer>} Decrypted content
 */
export async function decryptContentBytes(ciphertextBytes, ivBase64, masterKey) {
  const iv = base64ToUint8(ivBase64);

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    ciphertextBytes
  );
}

// ─── Key Wrapping ───────────────────────────────────────────

/**
 * Wrap (encrypt) the master key for a specific recipient
 * @param {CryptoKey} masterKey - The master key to wrap
 * @param {CryptoKey} wrappingKey - The recipient's derived wrapping key
 * @returns {Promise<string>} Base64-encoded wrapped key (iv + wrappedKey)
 */
export async function wrapMasterKey(masterKey, wrappingKey) {
  // Export the master key as raw bytes first
  const rawKey = await crypto.subtle.exportKey('raw', masterKey);

  // Encrypt the raw key bytes with the wrapping key
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    rawKey
  );

  // Combine IV + wrapped key bytes for storage
  const combined = new Uint8Array(iv.length + wrapped.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(wrapped), iv.length);

  return uint8ToBase64(combined);
}

/**
 * Unwrap (decrypt) the master key using a recipient's wrapping key
 * @param {string} wrappedKeyBase64 - Base64-encoded wrapped key (iv + wrappedKey)
 * @param {CryptoKey} wrappingKey - The recipient's derived wrapping key
 * @returns {Promise<CryptoKey>} The recovered master key
 */
export async function unwrapMasterKey(wrappedKeyBase64, wrappingKey) {
  const combined = base64ToUint8(wrappedKeyBase64);

  // Split IV (12 bytes) and wrapped key
  const iv = combined.slice(0, 12);
  const wrappedBytes = combined.slice(12);

  // Decrypt to get raw key bytes
  const rawKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    wrappedBytes
  );

  // Import as AES-GCM key
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

// ─── High-Level API ─────────────────────────────────────────

/**
 * Encrypt a drop for multiple recipients
 * This is the main function used by the CreateDrop UI
 *
 * @param {string|ArrayBuffer|Uint8Array} content - The content to encrypt
 * @param {string[]} usernames - Array of recipient usernames (plaintext)
 * @param {string|null} [hint] - Optional creator hint (encrypted with masterKey)
 * @returns {Promise<Object>} Everything needed to send to the server:
 *   { encryptedBytes, iv, salt, wrappedKeys, recipientHashes, encryptedHint }
 *   `encryptedBytes` is a raw Uint8Array — createDropAPI base64-encodes it for
 *   the in-memory path or uploads it directly for the R2 path.
 */
export async function encryptDrop(content, usernames, hint = null) {
  // metadata (keys/salt/hint) + the full ciphertext buffer. Used by the
  // buffered path; the streaming path uses encryptDropMetadata + encryptLargeStream.
  const meta = await encryptDropMetadata(usernames, hint);
  const encryptedBytes = await encryptLargeContent(meta.masterKey, content);
  return {
    encryptedBytes,
    iv: meta.iv,
    salt: meta.salt,
    wrappedKeys: meta.wrappedKeys,
    recipientHashes: meta.recipientHashes,
    encryptedHint: meta.encryptedHint,
  };
}

/**
 * Produce everything for a drop EXCEPT the encrypted content: a fresh master
 * key, salt, per-recipient wrapped keys + hashes, and the encrypted hint. The
 * streaming create path calls this first, then encrypts the file in slices with
 * the returned masterKey — so the plaintext is never fully in memory.
 *
 * @param {string[]} usernames
 * @param {string|null} hint
 * @returns {Promise<{ masterKey: CryptoKey, iv: string, salt: string,
 *   wrappedKeys: Object, recipientHashes: string[], encryptedHint: Object|null }>}
 */
export async function encryptDropMetadata(usernames, hint = null) {
  assertSecureCrypto();

  const salt = generateDropSalt();
  const masterKey = await generateMasterKey();

  let encryptedHint = null;
  if (hint && typeof hint === 'string' && hint.trim().length > 0) {
    const { ciphertextBytes: hintBytes, iv: hintIv } = await encryptContent(hint.trim(), masterKey);
    encryptedHint = { iv: hintIv, ciphertext: uint8ToBase64(hintBytes) };
  }

  const wrappedKeys = {};
  const recipientHashes = [];
  for (const username of usernames) {
    const hash = await hashUsername(username, salt);
    const wrappingKey = await deriveWrappingKey(username, salt);
    wrappedKeys[hash] = await wrapMasterKey(masterKey, wrappingKey);
    recipientHashes.push(hash);
  }

  return { masterKey, iv: PAYLOAD_FORMAT_MARKER, salt, wrappedKeys, recipientHashes, encryptedHint };
}

/**
 * Decrypt the hint field of a drop using the unwrapped master key.
 *
 * @param {{ iv: string, ciphertext: string }} encryptedHint - From server drop info
 * @param {CryptoKey} masterKey - Unwrapped master key for this drop
 * @returns {Promise<string>} Plaintext hint
 */
export async function decryptHint(encryptedHint, masterKey) {
  const plaintext = await decryptContent(encryptedHint.ciphertext, encryptedHint.iv, masterKey);
  return new TextDecoder().decode(plaintext);
}

/**
 * Decrypt a claimed drop
 * This is the main function used by the DropViewer UI
 * 
 * @param {string} encryptedPayload - Base64-encoded ciphertext
 * @param {string} iv - Base64-encoded IV
 * @param {string} salt - Base64-encoded salt
 * @param {string} wrappedKey - Base64-encoded wrapped master key for this recipient
 * @param {string} username - The recipient's plaintext username
 * @returns {Promise<ArrayBuffer>} Decrypted content
 */
export async function decryptDrop(encryptedPayload, iv, salt, wrappedKey, username) {
  assertSecureCrypto();

  // 1. Derive wrapping key from username
  const wrappingKey = await deriveWrappingKey(username, salt);

  // 2. Unwrap the master key
  const masterKey = await unwrapMasterKey(wrappedKey, wrappingKey);

  // 3. Decrypt the chunked payload (base64 → bytes → chunked AEAD).
  //    `iv` is a vestigial marker now — the blob carries its own nonces.
  const framed = base64ToUint8(encryptedPayload);
  return decryptLargeContent(masterKey, framed);
}

/**
 * Decrypt a claimed drop whose ciphertext was downloaded as raw bytes (R2 path).
 *
 * @param {ArrayBuffer|Uint8Array} ciphertextBytes - Raw ciphertext from R2
 * @param {string} iv - Base64-encoded IV
 * @param {string} salt - Base64-encoded salt
 * @param {string} wrappedKey - Base64-encoded wrapped master key for this recipient
 * @param {string} username - The recipient's plaintext username
 * @returns {Promise<ArrayBuffer>} Decrypted content
 */
export async function decryptDropFromBytes(ciphertextBytes, iv, salt, wrappedKey, username) {
  assertSecureCrypto();
  const wrappingKey = await deriveWrappingKey(username, salt);
  const masterKey = await unwrapMasterKey(wrappedKey, wrappingKey);
  // `iv` is a vestigial marker — the chunked blob carries its own nonces.
  return decryptLargeContent(masterKey, ciphertextBytes);
}

// ─── File/Content Helpers ───────────────────────────────────

/**
 * Convert a File object to ArrayBuffer
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
export function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Convert ArrayBuffer to a data URL for display
 * @param {ArrayBuffer} buffer
 * @param {string} mimeType
 * @returns {string} Data URL
 */
export function arrayBufferToDataUrl(buffer, mimeType) {
  const base64 = uint8ToBase64(new Uint8Array(buffer));
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Convert ArrayBuffer to text string (UTF-8)
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function arrayBufferToText(buffer) {
  return new TextDecoder().decode(buffer);
}

/**
 * Convert ArrayBuffer to a Blob and create a download URL
 * @param {ArrayBuffer} buffer
 * @param {string} mimeType
 * @returns {string} Object URL (must be revoked after use)
 */
export function arrayBufferToObjectUrl(buffer, mimeType) {
  const blob = new Blob([buffer], { type: mimeType });
  return URL.createObjectURL(blob);
}

// ─── API Helpers ────────────────────────────────────────────

// Cached server storage configuration (memory vs R2). Fetched once per session.
let _dropConfigPromise = null;

/**
 * Fetch (and cache) the server's drop storage configuration.
 * Falls back to in-memory defaults if the endpoint is unavailable.
 * @returns {Promise<{ storage: 'memory'|'r2', maxPayloadSize: number }>}
 */
export async function getDropConfig() {
  if (!_dropConfigPromise) {
    _dropConfigPromise = (async () => {
      try {
        const response = await secureFetch(`${API_BASE}/api/drops/config`);
        if (response.ok) {
          const data = await response.json();
          return {
            storage: data.storage === 'r2' ? 'r2' : 'memory',
            maxPayloadSize: data.maxPayloadSize || 25 * 1024 * 1024,
          };
        }
      } catch {
        // Network/parse failure — fall back to safe in-memory defaults below.
      }
      return { storage: 'memory', maxPayloadSize: 25 * 1024 * 1024 };
    })();
  }
  return _dropConfigPromise;
}

/**
 * Create a drop via the API.
 *
 * When the server is backed by R2, the (potentially large) ciphertext is
 * uploaded directly to the bucket via a one-time presigned URL — it never
 * passes through our server. Otherwise the ciphertext is inlined in the
 * create request and stored in server memory.
 *
 * @param {Object} dropData - All encrypted drop data + metadata. `encryptedBytes`
 *   is the raw ciphertext Uint8Array from encryptDrop.
 * @returns {Promise<Object>} { dropId, verbalCode, expiresAt, ephPacket }
 */
export async function createDropAPI(dropData, onProgress) {
  const config = await getDropConfig();

  if (config.storage === 'r2') {
    return createDropViaR2(dropData, onProgress);
  }

  // In-memory path: the ciphertext rides inside the JSON body, so base64-encode
  // the raw bytes here. Only reached for small payloads (server caps memory mode).
  const { encryptedBytes, ...metadata } = dropData;
  const response = await secureFetch(`${API_BASE}/api/drops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...metadata,
      encryptedPayload: uint8ToBase64(encryptedBytes),
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to create drop');
  }
  return data;
}

/**
 * Two-phase create for R2-backed servers:
 *   1. POST metadata (no ciphertext) → receive a presigned upload URL.
 *   2. PUT the raw ciphertext bytes straight to R2.
 *
 * The ciphertext never gets base64-encoded on this path, so there is no JS
 * max-string-length ceiling — large files are limited only by browser memory.
 *
 * @param {Object} dropData - Includes the raw `encryptedBytes` Uint8Array plus metadata
 * @returns {Promise<Object>} The server's create response
 */
async function createDropViaR2(dropData, onProgress) {
  const { encryptedBytes, ...metadata } = dropData;

  // Phase 1 — create the metadata record and obtain the presigned PUT URL.
  const response = await secureFetch(`${API_BASE}/api/drops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...metadata,
      storage: 'r2',
      byteSize: encryptedBytes.length,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to create drop');
  }

  // Phase 2 — upload the ciphertext directly to R2.
  // Large payloads use a resumable multipart upload with progress; smaller ones
  // use a single presigned PUT. Both are cross-origin to Cloudflare and must not
  // carry our app headers (so plain fetch, no Content-Type).
  if (encryptedBytes.length > MULTIPART_THRESHOLD) {
    await uploadMultipart({
      dropId: data.dropId,
      creatorId: metadata.creatorId,
      encryptedBytes,
      onProgress,
    });
  } else {
    if (!data.uploadUrl) {
      throw new Error('Server did not provide an upload URL for this drop.');
    }
    onProgress?.(0);
    const uploadResponse = await fetch(data.uploadUrl, {
      method: 'PUT',
      body: encryptedBytes,
    });
    if (!uploadResponse.ok) {
      throw new Error(
        `Failed to upload encrypted file (status ${uploadResponse.status}). Please try again.`
      );
    }
    onProgress?.(1);
  }

  return data;
}

/**
 * Get drop info (metadata only)
 * @param {string} dropId
 * @returns {Promise<Object>} Drop metadata
 */
export async function getDropInfoAPI(dropId) {
  const response = await secureFetch(`${API_BASE}/api/drops/${dropId}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Drop not found');
  }
  return data;
}

/**
 * Claim a drop — sends username hash, gets encrypted content
 * @param {string} dropId
 * @param {string} usernameHash - SHA-256 hash of (username + salt)
 * @returns {Promise<Object>} Encrypted content + wrapped key
 */
export async function claimDropAPI(dropId, usernameHash) {
  const response = await secureFetch(`${API_BASE}/api/drops/${dropId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernameHash }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to claim drop');
  }
  return data;
}

/**
 * Confirm a drop has been received (downloaded + decrypted) by this recipient.
 * For R2 view-once drops this triggers immediate destruction of the bucket
 * object. Best-effort — failures are non-fatal (the TTL still cleans up).
 *
 * @param {string} dropId
 * @param {string} usernameHash - SHA-256 hash of (username + salt)
 * @returns {Promise<void>}
 */
export async function completeDropAPI(dropId, usernameHash) {
  try {
    await secureFetch(`${API_BASE}/api/drops/${dropId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernameHash }),
    });
  } catch {
    // Non-fatal: the drop's TTL (and the R2 lifecycle rule) will still clean up.
  }
}

/**
 * Resolve a verbal code to a drop
 * @param {string} verbalCode - 4-word verbal code
 * @returns {Promise<Object>} { dropId, drop }
 */
export async function resolveVerbalCodeAPI(verbalCode) {
  const response = await secureFetch(`${API_BASE}/api/drops/resolve-verbal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verbalCode }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Invalid verbal code');
  }
  return data;
}

/**
 * Validate an .eph packet
 * @param {Object} ephPacket - Parsed .eph file content
 * @returns {Promise<Object>} { dropId, hint, drop }
 */
export async function validateEphAPI(ephPacket) {
  const response = await secureFetch(`${API_BASE}/api/drops/validate-eph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ephPacket }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Invalid .eph file');
  }
  return data;
}

/**
 * Get my drops (by creator ID)
 * @param {string} creatorId
 * @returns {Promise<Object[]>} Array of drop metadata
 */
export async function getMyDropsAPI(creatorId) {
  const response = await secureFetch(`${API_BASE}/api/drops/mine/${creatorId}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to get drops');
  }
  return data;
}

/**
 * Delete a drop
 * @param {string} dropId
 * @param {string} creatorId
 * @returns {Promise<void>}
 */
export async function deleteDropAPI(dropId, creatorId) {
  const response = await secureFetch(`${API_BASE}/api/drops/${dropId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creatorId }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to delete drop');
  }
}

/**
 * Download .eph file for a drop
 * @param {string} dropId
 * @returns {Promise<Blob>} The .eph file as a Blob
 */
export async function downloadEphFileAPI(dropId) {
  const response = await secureFetch(`${API_BASE}/api/drops/${dropId}/eph`);
  if (!response.ok) {
    throw new Error('Failed to download .eph file');
  }
  return response.blob();
}

// ─── Base64 Helpers ─────────────────────────────────────────

/**
 * Convert Uint8Array to Base64 string
 */
export function uint8ToBase64(uint8Array) {
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to Uint8Array
 */
export function base64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
