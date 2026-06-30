/**
 * Multipart upload for large R2 drops.
 *
 * Above MULTIPART_THRESHOLD the browser uploads the ciphertext to R2 in fixed
 * 50 MB parts instead of one giant PUT. Benefits:
 *   - resumable per-part (a failed part retries without restarting the whole file)
 *   - real progress (reported after each part)
 *   - bounded request size (no single multi-hundred-MB request)
 *
 * The control calls (create / sign / complete / abort) go to OUR API via
 * secureFetch; the part bytes go straight to R2 via presigned PUT URLs. R2 must
 * expose the ETag response header (CORS ExposeHeaders: ETag) so each part's ETag
 * can be read back and handed to complete.
 *
 * Note: this bounds the *upload* request size, not peak memory — the full
 * ciphertext already exists in memory from encryption (part slices are views,
 * not copies). Streaming encryption would be a separate change.
 */

import { secureFetch } from './secure-fetch';
import { API_BASE } from './resolve-url.js';

/** Switch to multipart above this payload size. */
export const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB

/** R2 requires every part except the last to be the same size, min 5 MB. */
const PART_SIZE = 50 * 1024 * 1024; // 50 MB

const PART_RETRIES = 3;

async function apiPost(path, body) {
  const res = await secureFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (status ${res.status})`);
  return data;
}

async function putPart(url, body) {
  let lastErr;
  for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: 'PUT', body });
      if (!res.ok) throw new Error(`part upload failed (status ${res.status})`);
      const etag = res.headers.get('ETag') || res.headers.get('etag');
      if (!etag) {
        throw new Error('Missing ETag on part response — add "ETag" to the R2 bucket CORS ExposeHeaders.');
      }
      return etag;
    } catch (err) {
      lastErr = err;
      if (attempt < PART_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastErr;
}

/**
 * Upload `encryptedBytes` to the drop's R2 object via multipart.
 *
 * @param {Object} args
 * @param {string} args.dropId
 * @param {string} args.creatorId
 * @param {Uint8Array} args.encryptedBytes
 * @param {(fraction: number) => void} [args.onProgress] - 0..1
 * @returns {Promise<void>}
 */
export async function uploadMultipart({ dropId, creatorId, encryptedBytes, onProgress }) {
  const total = encryptedBytes.length;
  const partCount = Math.ceil(total / PART_SIZE);
  const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);

  const { uploadId } = await apiPost(`/api/drops/${dropId}/multipart/create`, { creatorId });

  try {
    const { urls } = await apiPost(`/api/drops/${dropId}/multipart/sign`, {
      creatorId,
      uploadId,
      partNumbers,
    });
    const urlByPart = new Map(urls.map((u) => [u.partNumber, u.url]));

    const parts = [];
    let uploaded = 0;
    for (let i = 0; i < partCount; i++) {
      const partNumber = i + 1;
      const start = i * PART_SIZE;
      const end = Math.min(start + PART_SIZE, total);
      const chunk = encryptedBytes.subarray(start, end); // view — no copy
      const etag = await putPart(urlByPart.get(partNumber), chunk);
      parts.push({ partNumber, etag });
      uploaded += end - start;
      onProgress?.(uploaded / total);
    }

    await apiPost(`/api/drops/${dropId}/multipart/complete`, { creatorId, uploadId, parts });
  } catch (err) {
    // Best-effort cleanup so abandoned parts don't linger in the bucket.
    apiPost(`/api/drops/${dropId}/multipart/abort`, { creatorId, uploadId }).catch(() => {});
    throw err;
  }
}

/**
 * Streaming multipart upload: consumes an async iterable of ciphertext pieces
 * and flushes them as fixed PART_SIZE parts, so peak memory stays ~one part
 * regardless of total size. Used by the streaming create path where the
 * ciphertext is produced on the fly from File slices.
 *
 * @param {Object} args
 * @param {string} args.dropId
 * @param {string} args.creatorId
 * @param {number} args.total - exact framed ciphertext size (for progress + part count)
 * @param {AsyncIterable<Uint8Array>} args.source - ciphertext pieces in order
 * @param {(fraction: number) => void} [args.onProgress]
 * @returns {Promise<void>}
 */
export async function uploadStreamMultipart({ dropId, creatorId, total, source, onProgress }) {
  const partCount = Math.max(1, Math.ceil(total / PART_SIZE));
  const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);

  const { uploadId } = await apiPost(`/api/drops/${dropId}/multipart/create`, { creatorId });

  try {
    const { urls } = await apiPost(`/api/drops/${dropId}/multipart/sign`, {
      creatorId,
      uploadId,
      partNumbers,
    });
    const urlByPart = new Map(urls.map((u) => [u.partNumber, u.url]));

    const parts = [];
    let uploaded = 0;
    let buffer = new Uint8Array(PART_SIZE);
    let filled = 0;
    let partNumber = 0;

    const flush = async (size) => {
      partNumber += 1;
      const etag = await putPart(urlByPart.get(partNumber), buffer.subarray(0, size));
      parts.push({ partNumber, etag });
      uploaded += size;
      onProgress?.(uploaded / total);
    };

    for await (const piece of source) {
      let offset = 0;
      while (offset < piece.length) {
        const take = Math.min(PART_SIZE - filled, piece.length - offset);
        buffer.set(piece.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === PART_SIZE) {
          await flush(PART_SIZE);
          filled = 0;
          buffer = new Uint8Array(PART_SIZE);
        }
      }
    }
    if (filled > 0) await flush(filled);

    await apiPost(`/api/drops/${dropId}/multipart/complete`, { creatorId, uploadId, parts });
  } catch (err) {
    apiPost(`/api/drops/${dropId}/multipart/abort`, { creatorId, uploadId }).catch(() => {});
    throw err;
  }
}
