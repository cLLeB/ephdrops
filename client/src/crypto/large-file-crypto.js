/**
 * Chunked authenticated encryption for drop payloads (text → large files).
 *
 * Why chunked instead of a single AES-GCM call:
 *  - No base64 / max-string-length ceiling (we never stringify the ciphertext).
 *  - Each chunk is encrypted and authenticated independently, so encrypting a
 *    multi-hundred-MB file happens in bounded steps instead of one giant op.
 *  - The chunk index and a final-chunk flag are authenticated (as AES-GCM
 *    "additional data"), which detects reordering, duplication, truncation, or
 *    appended chunks — not just bit-flips. A corrupted blob fails loudly on
 *    decrypt; it can never silently decode to wrong-but-plausible bytes.
 *
 * This is the same construction family as age's STREAM and Tink's streaming
 * AEAD: AES-256-GCM per chunk, nonce = baseNonce(8) || chunkIndex(4).
 *
 * Wire format (one self-describing blob):
 *   [ magic "EDS1"        4 bytes ]
 *   [ chunkSize (uint32 BE) 4 bytes ]   plaintext bytes per full chunk
 *   [ baseNonce            8 bytes ]    random per drop
 *   then, repeated until the plaintext is consumed:
 *   [ AES-GCM(chunk_i)  plaintextLen_i + 16-byte tag ]
 *
 * Per-chunk:
 *   nonce = baseNonce || uint32BE(i)
 *   aad   = uint32BE(i) || uint8(isFinal ? 1 : 0)
 * Every chunk except the last carries exactly `chunkSize` plaintext bytes; the
 * last carries the remainder (0..chunkSize) and is flagged final.
 */

const MAGIC = [0x45, 0x44, 0x53, 0x31]; // "EDS1"
const HEADER_BYTES = 16;                // 4 magic + 4 chunkSize + 8 baseNonce
const TAG_BYTES = 16;                   // AES-GCM authentication tag
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB plaintext per chunk

function u32be(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function makeNonce(baseNonce, index) {
  const nonce = new Uint8Array(12);
  nonce.set(baseNonce, 0);        // 8 bytes
  nonce.set(u32be(index), 8);     // 4-byte big-endian counter
  return nonce;
}

function makeAad(index, isFinal) {
  const aad = new Uint8Array(5);
  aad.set(u32be(index), 0);
  aad[4] = isFinal ? 1 : 0;
  return aad;
}

/**
 * Normalize accepted content into a Uint8Array view (no copy where possible).
 * @param {string|ArrayBuffer|ArrayBufferView} content
 * @returns {Uint8Array}
 */
function toBytes(content) {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new Error('Unsupported content type for encryption');
}

/**
 * Encrypt content into a self-describing chunked AEAD blob.
 *
 * @param {CryptoKey} masterKey - AES-256-GCM key
 * @param {string|ArrayBuffer|ArrayBufferView} content - Plaintext
 * @param {number} [chunkSize=DEFAULT_CHUNK_SIZE] - Plaintext bytes per chunk
 * @returns {Promise<Uint8Array>} The framed ciphertext blob
 */
export async function encryptLargeContent(masterKey, content, chunkSize = DEFAULT_CHUNK_SIZE) {
  const data = toBytes(content);
  const total = data.length;
  const baseNonce = crypto.getRandomValues(new Uint8Array(8));

  // Pre-allocate the exact output size so we never double memory via concat.
  const numChunks = total === 0 ? 1 : Math.ceil(total / chunkSize);
  const out = new Uint8Array(HEADER_BYTES + total + numChunks * TAG_BYTES);

  // Header
  out.set(MAGIC, 0);
  out.set(u32be(chunkSize), 4);
  out.set(baseNonce, 8);

  let readOffset = 0;
  let writeOffset = HEADER_BYTES;
  for (let index = 0; index < numChunks; index++) {
    const end = Math.min(readOffset + chunkSize, total);
    const plainChunk = data.subarray(readOffset, end);
    const isFinal = index === numChunks - 1;

    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: makeNonce(baseNonce, index), additionalData: makeAad(index, isFinal) },
      masterKey,
      plainChunk
    );

    out.set(new Uint8Array(ct), writeOffset);
    writeOffset += ct.byteLength;
    readOffset = end;
  }

  return out;
}

/**
 * Compute the exact framed ciphertext size for a given plaintext length without
 * encrypting anything. Lets the streaming path declare byteSize to the server
 * up front (for size validation) before a byte is read.
 *
 * @param {number} plaintextSize
 * @param {number} [chunkSize=DEFAULT_CHUNK_SIZE]
 * @returns {number}
 */
export function framedSize(plaintextSize, chunkSize = DEFAULT_CHUNK_SIZE) {
  const numChunks = plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / chunkSize);
  return HEADER_BYTES + plaintextSize + numChunks * TAG_BYTES;
}

/**
 * Streaming encryptor: yields the framed ciphertext in pieces (header, then one
 * piece per chunk) while reading the plaintext from a Blob/File in slices. Peak
 * memory is ~one chunk, not the whole file — this is what lets a phone encrypt
 * a multi-hundred-MB file without crashing.
 *
 * Byte-for-byte identical output to encryptLargeContent for the same key+nonce,
 * so decryptLargeContent decrypts it unchanged. (The base nonce is random per
 * call, exactly as in the buffered version.)
 *
 * @param {CryptoKey} masterKey
 * @param {Blob} blob - File or Blob plaintext source (read via .slice)
 * @param {number} [chunkSize=DEFAULT_CHUNK_SIZE]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* encryptLargeStream(masterKey, blob, chunkSize = DEFAULT_CHUNK_SIZE) {
  const total = blob.size;
  const baseNonce = crypto.getRandomValues(new Uint8Array(8));

  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header.set(u32be(chunkSize), 4);
  header.set(baseNonce, 8);
  yield header;

  const numChunks = total === 0 ? 1 : Math.ceil(total / chunkSize);
  for (let index = 0; index < numChunks; index++) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, total);
    // Read just this window from disk — the whole file is never in memory.
    const plainChunk = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    const isFinal = index === numChunks - 1;

    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: makeNonce(baseNonce, index), additionalData: makeAad(index, isFinal) },
      masterKey,
      plainChunk
    );
    yield new Uint8Array(ct);
  }
}

/**
 * Decrypt a chunked AEAD blob produced by encryptLargeContent.
 * Throws if the blob is malformed, truncated, reordered, or tampered with.
 *
 * @param {CryptoKey} masterKey - AES-256-GCM key
 * @param {ArrayBuffer|Uint8Array} framed - The ciphertext blob
 * @returns {Promise<ArrayBuffer>} The recovered plaintext
 */
export async function decryptLargeContent(masterKey, framed) {
  const bytes = framed instanceof Uint8Array ? framed : new Uint8Array(framed);

  if (bytes.length < HEADER_BYTES) {
    throw new Error('Ciphertext too short — file is corrupted or incomplete');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new Error('Unrecognized ciphertext format');
    }
  }

  const chunkSize = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  if (chunkSize === 0) throw new Error('Invalid ciphertext header');
  const baseNonce = bytes.subarray(8, 16);

  const fullCipher = chunkSize + TAG_BYTES;
  const total = bytes.length;
  const bodyLen = total - HEADER_BYTES;
  const numChunks = bodyLen === 0 ? 0 : Math.ceil(bodyLen / fullCipher);

  const out = new Uint8Array(bodyLen - numChunks * TAG_BYTES);

  let readOffset = HEADER_BYTES;
  let writeOffset = 0;
  for (let index = 0; index < numChunks; index++) {
    const remaining = total - readOffset;
    const cipherLen = Math.min(fullCipher, remaining);
    if (cipherLen < TAG_BYTES) {
      throw new Error('Corrupted ciphertext — truncated chunk');
    }
    const isFinal = index === numChunks - 1;
    const cipherChunk = bytes.subarray(readOffset, readOffset + cipherLen);

    let pt;
    try {
      pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: makeNonce(baseNonce, index), additionalData: makeAad(index, isFinal) },
        masterKey,
        cipherChunk
      );
    } catch {
      // GCM tag mismatch — wrong key, or the blob was altered/truncated/reordered.
      throw new Error('Decryption failed — the file is corrupted or the key is incorrect');
    }

    out.set(new Uint8Array(pt), writeOffset);
    writeOffset += pt.byteLength;
    readOffset += cipherLen;
  }

  return out.buffer;
}

export const __test__ = { DEFAULT_CHUNK_SIZE, HEADER_BYTES, TAG_BYTES };
