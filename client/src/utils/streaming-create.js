/**
 * Streaming create for large file drops.
 *
 * Instead of reading the whole file into memory, encrypting it into one buffer,
 * then uploading (peak ≈ 2× the file), this:
 *   1. computes drop metadata + the exact ciphertext size up front,
 *   2. creates the drop record (gets a dropId),
 *   3. encrypts the file in 4 MB slices and uploads 50 MB multipart parts as it
 *      goes, discarding each.
 *
 * Peak memory ≈ one part (~50 MB) regardless of file size, and every API used
 * (Blob.slice, fetch, multipart) works in mobile WebViews — so a phone can send
 * files far larger than its memory budget.
 */

import { secureFetch } from './secure-fetch.js';
import { API_BASE } from './resolve-url.js';
import { encryptDropMetadata } from './drops.js';
import { framedSize, encryptLargeStream } from '../crypto/large-file-crypto.js';
import { uploadStreamMultipart } from './multipart-upload.js';

/** Files at/above this size take the streaming path. */
export const STREAM_THRESHOLD = 100 * 1024 * 1024; // 100 MB

/**
 * @param {Object} args
 * @param {Blob} args.source - the File/Blob plaintext (read via .slice)
 * @param {string[]} args.usernames
 * @param {string|null} args.hint
 * @param {{ contentType: string, fileName: string|null, mimeType: string|null,
 *           fileSize: number|null, ttl: string, viewOnce: boolean }} args.metadata
 * @param {string} args.creatorId
 * @param {(fraction: number) => void} [args.onProgress]
 * @returns {Promise<Object>} the server's create response
 */
export async function createDropStreaming({ source, usernames, hint, metadata, creatorId, onProgress }) {
  const meta = await encryptDropMetadata(usernames, hint);
  const byteSize = framedSize(source.size);

  // Phase 1 — create the drop record (no ciphertext yet).
  const response = await secureFetch(`${API_BASE}/api/drops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      iv: meta.iv,
      salt: meta.salt,
      wrappedKeys: meta.wrappedKeys,
      recipientHashes: meta.recipientHashes,
      encryptedHint: meta.encryptedHint,
      contentType: metadata.contentType,
      fileName: metadata.fileName || null,
      mimeType: metadata.mimeType || null,
      fileSize: metadata.fileSize || null,
      ttl: metadata.ttl,
      viewOnce: metadata.viewOnce,
      creatorId,
      storage: 'r2',
      byteSize,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to create drop');
  }

  // Phase 2 — stream-encrypt from disk straight into multipart parts.
  await uploadStreamMultipart({
    dropId: data.dropId,
    creatorId,
    total: byteSize,
    source: encryptLargeStream(meta.masterKey, source),
    onProgress,
  });

  return data;
}
