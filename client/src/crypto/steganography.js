/**
 * LSB Steganography via Canvas API
 *
 * Two independent hidden slots per image:
 *   Primary slot  — R + G channel LSBs (2 bits/pixel, ~2× old capacity)
 *   Decoy slot    — B channel LSB       (1 bit/pixel, optional plausible deniability)
 *
 * Each slot is independently AES-GCM encrypted with its own salt + IV.
 * Giving the decoy passphrase reveals only the innocent message; the primary
 * slot is undetectable without its separate passphrase.
 *
 * Backward-compat: legacy images embedded with the old blue-channel 'STEG'
 * format are still extracted correctly.
 *
 * Secret can be plain text or any binary file.
 * Capacity (approx, before encryption overhead):
 *   primary = floor(w × h × 2 / 8) bytes
 *   decoy   = floor(w × h     / 8) bytes
 */

import { decode as decodePng, encode as encodePng, hasPngSignature } from 'fast-png';

const MAGIC_PRIMARY = new Uint8Array([0x53, 0x54, 0x47, 0x32]); // 'STG2'
const MAGIC_DECOY   = new Uint8Array([0x44, 0x43, 0x4F, 0x59]); // 'DCOY'
const MAGIC_LEGACY  = new Uint8Array([0x53, 0x54, 0x45, 0x47]); // 'STEG' (read-only compat)

const CHANNELS_RG = [0, 1]; // R, G
const CHANNELS_B  = [2];    // B

const SALT_LEN = 16;
const IV_LEN   = 12;
const GCM_TAG  = 16;
const HDR_LEN  = 8; // 4 magic + 4 length

// ── Key derivation ────────────────────────────────────────────────────────────

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ── Lossless image I/O ─────────────────────────────────────────────────────────
//
// LSB steganography requires bit-exact pixels to survive a round-trip. A 2D
// canvas does NOT provide that: it stores pixels with *premultiplied alpha*, so
// `putImageData` → `toBlob('image/png')` (and the `drawImage` → `getImageData`
// readback) silently mangle the RGB low bits of any pixel whose alpha ≠ 255 —
// destroying both the carrier (transparent areas turn to garbage) and the hidden
// payload. The production `stegno` core sidesteps this by decoding/encoding PNG
// with a real lossless codec on raw RGBA8; we do the same here via `fast-png`.
//
// Canvas is used only to rasterize *non-PNG* carriers (JPEG/WebP/…) to RGBA —
// a one-way decode where premultiplication is harmless because the result is
// re-encoded losslessly as PNG before any LSB is written.

/** Read a Blob into a Uint8Array of its raw bytes. */
async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Normalize a fast-png decode result to 8-bit RGBA, stride-4. */
function pngToRgba(png) {
  const { width, height, channels, depth } = png;
  let src = png.data;
  if (depth === 16) {
    const down = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) down[i] = src[i] >> 8;
    src = down;
  }
  const px = width * height;
  const data = new Uint8Array(px * 4);
  switch (channels) {
    case 4:
      data.set(src.subarray(0, px * 4));
      break;
    case 3:
      for (let i = 0; i < px; i++) {
        data[i * 4]     = src[i * 3];
        data[i * 4 + 1] = src[i * 3 + 1];
        data[i * 4 + 2] = src[i * 3 + 2];
        data[i * 4 + 3] = 255;
      }
      break;
    case 2: // gray + alpha
      for (let i = 0; i < px; i++) {
        const g = src[i * 2];
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g;
        data[i * 4 + 3] = src[i * 2 + 1];
      }
      break;
    case 1: // gray
      for (let i = 0; i < px; i++) {
        const g = src[i];
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g;
        data[i * 4 + 3] = 255;
      }
      break;
    default:
      throw new Error(`Unsupported PNG channel count: ${channels}`);
  }
  return { width, height, data };
}

/** Read the RGBA8 pixels out of a canvas of the given dimensions. */
function rgbaFromCanvas(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const imgData = ctx.getImageData(0, 0, width, height);
  return { width, height, data: new Uint8Array(imgData.data) };
}

/** Fallback rasterizer using an <img> element (no EXIF-orientation guarantee). */
function imageElementDecodeToRgba(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const out = rgbaFromCanvas(img, img.naturalWidth, img.naturalHeight);
        URL.revokeObjectURL(url);
        resolve(out);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/**
 * Rasterize any image Blob (JPEG/WebP/…) to RGBA8. One-way decode.
 *
 * Uses `createImageBitmap` and sizes the canvas to the *bitmap's own* width/
 * height. This is critical: phone photos carry EXIF orientation, and the
 * browser draws the auto-rotated image — if the canvas were sized to the raw
 * `naturalWidth`/`naturalHeight` instead, the pixel row stride would no longer
 * match the encoder width and the carrier would come out sheared (diagonal
 * streaks) even though the hidden LSB payload still survives.
 */
async function canvasDecodeToRgba(blob) {
  if (typeof createImageBitmap === 'function') {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      return imageElementDecodeToRgba(blob);
    }
    try {
      return rgbaFromCanvas(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close?.();
    }
  }
  return imageElementDecodeToRgba(blob);
}

/**
 * Decode a carrier Blob to bit-exact RGBA8 pixels.
 * PNG → fast-png (lossless, preserves every RGB low bit incl. transparent areas).
 * Anything else → canvas rasterization (the result is re-encoded as PNG before
 * any LSB write, so this decode being premultiplied is harmless).
 */
async function decodeToRgba(blob) {
  const bytes = await blobBytes(blob);
  if (hasPngSignature(bytes)) {
    try {
      const png = decodePng(bytes);
      if (!png.palette) return pngToRgba(png); // indexed PNGs fall through to canvas
    } catch { /* fall through to canvas */ }
  }
  return canvasDecodeToRgba(blob);
}

/** Encode RGBA8 pixels to a lossless PNG Blob (no premultiplication). */
function rgbaToPngBlob({ width, height, data }) {
  const png = encodePng({ width, height, data, channels: 4, depth: 8 });
  return new Blob([png], { type: 'image/png' });
}

// ── Multi-channel LSB write/read ──────────────────────────────────────────────

function writeBitsToChannels(pixels, magic, byteArray, channelOffsets) {
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, byteArray.length, false);
  const packet = new Uint8Array([...magic, ...lenBuf, ...byteArray]);

  const bpp = channelOffsets.length;
  if (packet.length * 8 > (pixels.data.length / 4) * bpp) {
    throw new Error('Image too small to carry this payload');
  }

  let bitPos = 0;
  for (let i = 0; i < packet.length; i++) {
    const byte = packet[i];
    for (let bit = 7; bit >= 0; bit--) {
      const val      = (byte >> bit) & 1;
      const pixelNum = Math.floor(bitPos / bpp);
      const chanIdx  = bitPos % bpp;
      const idx      = pixelNum * 4 + channelOffsets[chanIdx];
      pixels.data[idx] = (pixels.data[idx] & 0xfe) | val;
      bitPos++;
    }
  }
}

function readBitsFromChannels(pixels, magic, channelOffsets) {
  const bpp         = channelOffsets.length;
  const totalPixels = pixels.data.length / 4;
  if (totalPixels * bpp < HDR_LEN * 8) return null;

  const readByte = (byteIdx) => {
    let byte = 0;
    for (let bit = 7; bit >= 0; bit--) {
      const bitPos   = byteIdx * 8 + (7 - bit);
      const pixelNum = Math.floor(bitPos / bpp);
      const chanIdx  = bitPos % bpp;
      const idx      = pixelNum * 4 + channelOffsets[chanIdx];
      byte |= (pixels.data[idx] & 1) << bit;
    }
    return byte;
  };

  for (let i = 0; i < magic.length; i++) {
    if (readByte(i) !== magic[i]) return null;
  }

  const lenView = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < 4; i++) lenView.setUint8(i, readByte(magic.length + i));
  const len = lenView.getUint32(0, false);

  const maxPayload = Math.floor((totalPixels * bpp) / 8) - HDR_LEN;
  if (len > maxPayload || len === 0) return null;

  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = readByte(HDR_LEN + i);
  return payload;
}

// ── Payload encrypt/decrypt ───────────────────────────────────────────────────

async function encryptSecret(secret, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv   = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key  = await deriveKey(passphrase, salt);

  let plaintext;
  if (typeof secret === 'string') {
    const textBytes = new TextEncoder().encode(secret);
    plaintext = new Uint8Array(1 + textBytes.length);
    plaintext[0] = 0x00; // type: text
    plaintext.set(textBytes, 1);
  } else {
    // File object
    const fileBytes = new Uint8Array(await secret.arrayBuffer());
    const nameBytes = new TextEncoder().encode(secret.name);
    const nameLenBuf = new Uint8Array(2);
    new DataView(nameLenBuf.buffer).setUint16(0, nameBytes.length, false);
    plaintext = new Uint8Array(1 + 2 + nameBytes.length + fileBytes.length);
    plaintext[0] = 0x01; // type: file
    plaintext.set(nameLenBuf, 1);
    plaintext.set(nameBytes, 3);
    plaintext.set(fileBytes, 3 + nameBytes.length);
  }

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  );
  const payload = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.length);
  payload.set(salt, 0);
  payload.set(iv, SALT_LEN);
  payload.set(ciphertext, SALT_LEN + IV_LEN);
  return payload;
}

async function decryptPayload(raw, passphrase) {
  try {
    if (raw.length < SALT_LEN + IV_LEN + 1) return null;
    const salt       = raw.slice(0, SALT_LEN);
    const iv         = raw.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const ciphertext = raw.slice(SALT_LEN + IV_LEN);
    const key        = await deriveKey(passphrase, salt);
    const plain      = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    );

    const type = plain[0];
    if (type === 0x00) {
      return { type: 'text', text: new TextDecoder().decode(plain.slice(1)) };
    }
    if (type === 0x01) {
      const nameLen  = new DataView(plain.buffer, 1, 2).getUint16(0, false);
      const name     = new TextDecoder().decode(plain.slice(3, 3 + nameLen));
      const fileData = plain.slice(3 + nameLen);
      return { type: 'file', name, blob: new Blob([fileData], { type: guessMime(name) }) };
    }
    return null;
  } catch {
    return null;
  }
}

function guessMime(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain', json: 'application/json',
    mp3: 'audio/mpeg', mp4: 'video/mp4', zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the approximate byte capacity of an image for each slot.
 * Subtract your plaintext overhead (~GCM tag 16B + type byte 1B) from primary/decoy.
 */
export async function getCapacity(blob) {
  const { width, height } = await decodeToRgba(blob);
  const px       = width * height;
  const overhead = HDR_LEN + SALT_LEN + IV_LEN + GCM_TAG + 1; // +1 type byte
  return {
    primary: Math.max(0, Math.floor(px * 2 / 8) - overhead),
    decoy:   Math.max(0, Math.floor(px     / 8) - overhead),
  };
}

/**
 * Embed a secret into the carrier image.
 *
 * @param {Blob}           carrierBlob
 * @param {string|File}    secret       Plain text string or a File object
 * @param {string}         passphrase   Passphrase for the real message
 * @param {object}            [options]
 * @param {string|File}       [options.decoySecret]     Optional decoy — plain text OR a File
 * @param {string}            [options.decoyText]       Back-compat alias for a text-only decoy
 * @param {string}            [options.decoyPassphrase] Passphrase for the decoy
 * @returns {Promise<Blob>} PNG blob with hidden data
 */
export async function embed(carrierBlob, secret, passphrase, options = {}) {
  const image = await decodeToRgba(carrierBlob);

  const primaryPayload = await encryptSecret(secret, passphrase);
  writeBitsToChannels(image, MAGIC_PRIMARY, primaryPayload, CHANNELS_RG);

  // Decoy accepts a text string OR a File (same payload format as the primary
  // slot). `decoyText` is kept as an alias so existing callers keep working.
  const decoySecret = options.decoySecret ?? options.decoyText;
  if (decoySecret && options.decoyPassphrase) {
    const decoyPayload = await encryptSecret(decoySecret, options.decoyPassphrase);
    // Fail clearly when the decoy is bigger than the 1-bit-per-pixel B slot.
    const decoyCapacity = Math.floor((image.data.length / 4) / 8) - HDR_LEN;
    if (decoyPayload.length > decoyCapacity) {
      throw new Error(
        `Decoy is too large for this carrier's decoy slot ` +
        `(needs ${decoyPayload.length} bytes, slot holds ~${Math.max(0, decoyCapacity)}). ` +
        `Use a smaller decoy file or a larger carrier image.`
      );
    }
    writeBitsToChannels(image, MAGIC_DECOY, decoyPayload, CHANNELS_B);
  }

  return rgbaToPngBlob(image);
}

/**
 * Extract a hidden message from an image.
 * Tries primary slot (R+G), then decoy slot (B), then legacy blue-channel slot.
 *
 * @param {Blob}   carrierBlob
 * @param {string} passphrase
 * @returns {Promise<{type:'text',text:string}|{type:'file',name:string,blob:Blob}|null>}
 */
export async function extract(carrierBlob, passphrase) {
  const image = await decodeToRgba(carrierBlob);

  const slots = [
    [MAGIC_PRIMARY, CHANNELS_RG],
    [MAGIC_DECOY,   CHANNELS_B],
    [MAGIC_LEGACY,  CHANNELS_B],
  ];

  for (const [magic, channels] of slots) {
    const raw = readBitsFromChannels(image, magic, channels);
    if (raw) {
      const result = await decryptPayload(raw, passphrase);
      if (result !== null) return result;
    }
  }
  return null;
}
