/**
 * Drop Management for Ephemeral Chat — "Ephemeral Drops"
 * 
 * A Drop is a lightweight, encrypted, temporary payload that:
 * - Can hold text, images, audio, or files
 * - Is encrypted client-side (AES-256-GCM)
 * - Access is gated by recipient usernames (which derive decryption keys)
 * - Self-destructs after viewing (view-once) or TTL expiry
 * - Does NOT require a room — works independently
 * 
 * Server stores only encrypted blobs and hashed usernames.
 * Server NEVER sees plaintext content or plaintext usernames.
 */

const crypto = require('crypto');
const { logger } = require('./utils');
const { WORDLIST } = require('./wordlist');
const r2 = require('./r2');

// ─── Constants ───────────────────────────────────────────

const MAX_DROPS_PER_CREATOR = 10;
const MAX_SERVER_DROPS = 5000;
const MAX_RECIPIENTS_PER_DROP = 20;
// In-memory storage caps the payload tightly (it sits in server RAM, and the
// whole blob travels in the JSON request body). Large files must use R2.
const MAX_PAYLOAD_SIZE = 25 * 1024 * 1024; // 25MB
// R2-backed storage never touches server RAM — the browser uploads the
// ciphertext straight to the bucket — so the cap is just a sanity ceiling.
// With streaming create + multipart upload the sender's memory is no longer the
// limit (it stays ~constant regardless of size), so the cap can be generous.
// The real ceiling is now the receiver opening it (desktop ~1–2GB; phones less).
// Override with MAX_PAYLOAD_SIZE_R2_MB if needed.
const MAX_PAYLOAD_SIZE_R2 =
  (parseInt(process.env.MAX_PAYLOAD_SIZE_R2_MB, 10) || 2048) * 1024 * 1024; // default 2GB
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DROP_ID_LENGTH = 16;

// TTL presets
const DROP_TTL_OPTIONS = {
  '5min': 5 * 60 * 1000,
  '15min': 15 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  '1hour': 60 * 60 * 1000,
  '6hour': 6 * 60 * 60 * 1000,
  '24hour': 24 * 60 * 60 * 1000,
};

class DropManager {
  constructor() {
    /**
     * Main storage: dropId -> Drop object
     * Drop object shape:
     * {
     *   id: string,
     *   encryptedPayload: string,           // Base64-encoded AES-256-GCM ciphertext
     *   iv: string,                          // Base64-encoded IV
     *   salt: string,                        // Random salt for key derivation
     *   contentType: 'text'|'image'|'audio'|'file',
     *   wrappedKeys: { [hashedUsername]: string }, // Per-recipient wrapped AES keys
     *   recipientHashes: string[],           // SHA-256 hashes of allowed usernames
     *   creatorId: string,                   // Creator's device/session ID (hashed)
     *   createdAt: number,                   // Unix timestamp ms
     *   expiresAt: number,                   // Unix timestamp ms
     *   viewOnce: boolean,                   // Delete after first view per recipient
     *   maxViews: number,                    // -1 = unlimited until TTL, 1 = view-once
     *   viewedBy: Set<string>,               // Set of hashed usernames who viewed
     *   claimedCount: number,                // Total successful claims
     *   verbalCode: string,                  // 4-word verbal code for the drop
     *   fileName: string|null,               // Original file name (for file drops)
     *   mimeType: string|null,               // MIME type
     *   fileSize: number|null,               // Size in bytes
     *   encryptedHint: {iv, ciphertext}|null, // AES-256-GCM encrypted hint (M4: server never sees plaintext)
     * }
     */
    this.drops = new Map();

    /**
     * Creator tracking: creatorId -> Set of dropIds
     */
    this.creatorDrops = new Map();

    /**
     * Verbal code index: verbalCode -> dropId (for quick lookup)
     */
    this.verbalCodeIndex = new Map();

    /**
     * Expiry timers: dropId -> timeoutId
     */
    this.expiryTimers = new Map();

    // Periodic cleanup every 2 minutes
    this.cleanupInterval = setInterval(() => this._cleanupExpired(), 2 * 60 * 1000);

    logger.info('📦 DropManager initialized');
  }

  // ─── Drop ID Generation ──────────────────────────────────

  /**
   * Generate a cryptographically secure drop ID
   * Format: 16 hex chars (64 bits entropy)
   */
  _generateDropId() {
    return crypto.randomBytes(DROP_ID_LENGTH / 2).toString('hex');
  }

  /**
   * Generate a 4-word verbal code using the shared wordlist
   * Same system as room verbal codes for consistency
   */
  _generateVerbalCode() {
    let code;
    let attempts = 0;
    do {
      const words = [];
      for (let i = 0; i < 4; i++) {
        const idx = crypto.randomInt(WORDLIST.length);
        words.push(WORDLIST[idx]);
      }
      code = words.join(' ');
      attempts++;
    } while (this.verbalCodeIndex.has(code) && attempts < 100);

    if (attempts >= 100) {
      throw new Error('Failed to generate unique verbal code');
    }
    return code;
  }

  // ─── HMAC for .eph files ─────────────────────────────────

  /**
   * Get the HMAC secret used for .eph file signatures
   */
  _getEphSecret() {
    const secret = process.env.EPH_SECRET || process.env.CAP_SECRET;
    if (!secret) {
      throw new Error('[FATAL] EPH_SECRET or CAP_SECRET environment variable is required for drop HMAC signing.');
    }
    return secret;
  }

  /**
   * Generate HMAC signature for .eph file contents
   */
  generateEphSignature(dropId, timestamp) {
    const data = `${dropId}:${timestamp}`;
    return crypto.createHmac('sha256', this._getEphSecret())
      .update(data)
      .digest('hex');
  }

  /**
   * Verify HMAC signature from .eph file
   */
  verifyEphSignature(dropId, timestamp, signature) {
    const expected = this.generateEphSignature(dropId, timestamp);
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  }

  // ─── Create ──────────────────────────────────────────────

  /**
   * Create a new drop
   * @param {Object} params
   * @param {string} params.encryptedPayload - Base64-encoded encrypted content
   * @param {string} params.iv - Base64-encoded initialization vector
   * @param {string} params.salt - Random salt used for key derivation
   * @param {string} params.contentType - 'text'|'image'|'audio'|'file'
   * @param {Object} params.wrappedKeys - { hashedUsername: wrappedKeyBase64, ... }
   * @param {string[]} params.recipientHashes - SHA-256 hashes of usernames
   * @param {string} params.creatorId - Creator's device ID
   * @param {string} [params.ttl='1hour'] - TTL preset key
   * @param {boolean} [params.viewOnce=true] - Self-destruct after viewing
   * @param {string|null} [params.fileName] - Original file name
   * @param {string|null} [params.mimeType] - MIME type
   * @param {number|null} [params.fileSize] - File size in bytes
   * @param {{iv: string, ciphertext: string}|null} [params.encryptedHint] - AES-256-GCM encrypted hint blob
   * @param {'memory'|'r2'} [params.storage='memory'] - Where the ciphertext lives
   * @param {number} [params.byteSize] - Ciphertext byte length (R2 mode, for size validation)
   * @returns {Object} { dropId, verbalCode, expiresAt, ephPacket, storage, objectKey, uploadUrl }
   */
  async createDrop(params) {
    const {
      encryptedPayload,
      iv,
      salt,
      contentType,
      wrappedKeys,
      recipientHashes,
      creatorId,
      ttl = '1hour',
      viewOnce = true,
      fileName = null,
      mimeType = null,
      fileSize = null,
      encryptedHint = null,
      storage = 'memory',
      byteSize = null,
    } = params;

    // R2 mode is only valid when R2 is actually configured.
    const useR2 = storage === 'r2' && r2.isR2Enabled();

    // ── Validation ──────────────────────────────────────────

    if (useR2) {
      // In R2 mode the ciphertext is uploaded directly by the browser, so the
      // server never receives encryptedPayload — it validates the declared size.
      const declaredSize = Number(byteSize);
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        throw new Error('A valid byteSize is required for R2-backed drops');
      }
      if (declaredSize > MAX_PAYLOAD_SIZE_R2) {
        throw new Error(`Payload too large. Maximum is ${MAX_PAYLOAD_SIZE_R2 / (1024 * 1024)}MB`);
      }
    } else {
      if (!encryptedPayload || typeof encryptedPayload !== 'string') {
        throw new Error('Encrypted payload is required');
      }

      // Estimate raw size from Base64
      const estimatedSize = Math.ceil(encryptedPayload.length * 0.75);
      if (estimatedSize > MAX_PAYLOAD_SIZE) {
        throw new Error(`Payload too large. Maximum is ${MAX_PAYLOAD_SIZE / (1024 * 1024)}MB`);
      }
    }

    if (!iv || typeof iv !== 'string') {
      throw new Error('IV is required');
    }

    if (!salt || typeof salt !== 'string') {
      throw new Error('Salt is required');
    }

    const validTypes = ['text', 'image', 'audio', 'file'];
    if (!validTypes.includes(contentType)) {
      throw new Error(`Invalid content type: ${contentType}. Must be one of: ${validTypes.join(', ')}`);
    }

    if (!wrappedKeys || typeof wrappedKeys !== 'object' || Object.keys(wrappedKeys).length === 0) {
      throw new Error('At least one wrapped key is required');
    }

    if (!Array.isArray(recipientHashes) || recipientHashes.length === 0) {
      throw new Error('At least one recipient is required');
    }

    if (recipientHashes.length > MAX_RECIPIENTS_PER_DROP) {
      throw new Error(`Maximum ${MAX_RECIPIENTS_PER_DROP} recipients per drop`);
    }

    if (!creatorId || typeof creatorId !== 'string') {
      throw new Error('Creator ID is required');
    }

    // Validate TTL
    const ttlMs = DROP_TTL_OPTIONS[ttl];
    if (!ttlMs) {
      throw new Error(`Invalid TTL: ${ttl}. Must be one of: ${Object.keys(DROP_TTL_OPTIONS).join(', ')}`);
    }

    // ── Creator limits ──────────────────────────────────────

    const creatorDropCount = this.creatorDrops.get(creatorId)?.size || 0;
    if (creatorDropCount >= MAX_DROPS_PER_CREATOR) {
      throw new Error(`You have reached the maximum of ${MAX_DROPS_PER_CREATOR} active drops. Please wait for existing drops to expire or delete them.`);
    }

    // Server-wide limit
    if (this.drops.size >= MAX_SERVER_DROPS) {
      throw new Error('Server capacity reached. Please try again later.');
    }

    // ── Create the drop ─────────────────────────────────────

    const dropId = this._generateDropId();
    const verbalCode = this._generateVerbalCode();
    const now = Date.now();
    const expiresAt = now + ttlMs;

    // For R2-backed drops, the ciphertext lives in the bucket under objectKey
    // and the browser uploads it directly via the presigned URL below.
    const objectKey = useR2 ? r2.generateObjectKey(dropId) : null;

    const drop = {
      id: dropId,
      storage: useR2 ? 'r2' : 'memory',
      objectKey,
      encryptedPayload: useR2 ? null : encryptedPayload,
      iv,
      salt,
      contentType,
      wrappedKeys,
      recipientHashes,
      creatorId,
      createdAt: now,
      expiresAt,
      viewOnce,
      maxViews: viewOnce ? 1 : -1,
      viewedBy: new Set(),
      completedBy: new Set(),
      claimedCount: 0,
      verbalCode,
      fileName,
      mimeType,
      fileSize,
      encryptedHint,
    };

    // Store
    this.drops.set(dropId, drop);

    // Track by creator
    if (!this.creatorDrops.has(creatorId)) {
      this.creatorDrops.set(creatorId, new Set());
    }
    this.creatorDrops.get(creatorId).add(dropId);

    // Index verbal code
    this.verbalCodeIndex.set(verbalCode, dropId);

    // Set expiry timer
    const timerId = setTimeout(() => this._expireDrop(dropId), ttlMs);
    this.expiryTimers.set(dropId, timerId);

    logger.info(`📦 Drop created: ${dropId} (${contentType}) storage=${drop.storage} TTL=${ttl} recipients=${recipientHashes.length} viewOnce=${viewOnce}`);

    // For R2 drops, mint a one-time presigned upload URL so the browser can PUT
    // the ciphertext straight to the bucket — it never passes through this server.
    let uploadUrl = null;
    if (useR2) {
      const presigned = await r2.presignUpload(objectKey);
      uploadUrl = presigned.uploadUrl;
    }

    // Generate .eph packet
    const ephTimestamp = now;
    const ephSignature = this.generateEphSignature(dropId, ephTimestamp);

    const ephPacket = {
      v: 1,
      type: 'ephemeral-drop',
      dropId,
      server: process.env.APP_URL || 'https://chat.kyere.me',
      encryptedHint: encryptedHint || null, // opaque blob — server never sees plaintext
      ts: ephTimestamp,
      sig: ephSignature,
    };

    return {
      dropId,
      verbalCode,
      expiresAt,
      ephPacket,
      storage: drop.storage,
      objectKey,
      uploadUrl,
    };
  }

  // ─── Multipart upload target resolution ──────────────────

  /**
   * Resolve the R2 object key for a multipart upload, verifying the caller is
   * the drop's creator. Used by the multipart endpoints so a third party who
   * happens to know a dropId cannot drive its upload.
   * @param {string} dropId
   * @param {string} creatorId
   * @returns {string} objectKey
   * @throws if the drop is missing, not R2-backed, or the creator mismatches
   */
  getUploadTarget(dropId, creatorId) {
    const drop = this.drops.get(dropId);
    if (!drop) throw new Error('Drop not found');
    if (drop.storage !== 'r2' || !drop.objectKey) throw new Error('Drop is not R2-backed');
    if (drop.creatorId !== creatorId) throw new Error('Not authorized for this drop');
    return drop.objectKey;
  }

  // ─── Get Drop Metadata (before claiming) ─────────────────

  /**
   * Get drop metadata without the encrypted content
   * Used to show info before claiming
   * @param {string} dropId - Drop ID
   * @returns {Object|null} Drop metadata or null if not found/expired
   */
  getDropInfo(dropId) {
    const drop = this.drops.get(dropId);
    if (!drop) return null;

    // Check if expired
    if (Date.now() > drop.expiresAt) {
      this._expireDrop(dropId);
      return null;
    }

    return {
      id: drop.id,
      contentType: drop.contentType,
      createdAt: drop.createdAt,
      expiresAt: drop.expiresAt,
      viewOnce: drop.viewOnce,
      recipientCount: drop.recipientHashes.length,
      claimedCount: drop.claimedCount,
      fileName: drop.fileName,
      mimeType: drop.mimeType,
      fileSize: drop.fileSize,
      encryptedHint: drop.encryptedHint,
      salt: drop.salt,
      verbalCode: drop.verbalCode,
    };
  }

  // ─── Claim a Drop ────────────────────────────────────────

  /**
   * Claim a drop — validate username hash and return encrypted content
   * @param {string} dropId - Drop ID
   * @param {string} usernameHash - SHA-256 hash of the claiming username
   * @returns {Object} { encryptedPayload, iv, wrappedKey, contentType, fileName, mimeType, fileSize }
   */
  async claimDrop(dropId, usernameHash) {
    const drop = this.drops.get(dropId);

    if (!drop) {
      throw new Error('Drop not found or has expired');
    }

    // Check expiry
    if (Date.now() > drop.expiresAt) {
      this._expireDrop(dropId);
      throw new Error('Drop has expired');
    }

    // Check if this username is an allowed recipient
    if (!drop.recipientHashes.includes(usernameHash)) {
      throw new Error('Access denied. Your username is not authorized for this drop.');
    }

    // Check if already viewed (for view-once)
    if (drop.viewOnce && drop.viewedBy.has(usernameHash)) {
      throw new Error('You have already viewed this drop. It is no longer available to you.');
    }

    // Get the wrapped key for this recipient
    const wrappedKey = drop.wrappedKeys[usernameHash];
    if (!wrappedKey) {
      throw new Error('No decryption key available for your username.');
    }

    // Mark as viewed
    drop.viewedBy.add(usernameHash);
    drop.claimedCount++;

    logger.info(`📦 Drop claimed: ${dropId} by hash ${usernameHash.substring(0, 8)}... (claim #${drop.claimedCount})`);

    // For R2 drops, mint a short-lived presigned download URL so the browser can
    // pull the ciphertext directly from the bucket. Capture it BEFORE any
    // auto-delete below, since deletion clears the object key reference.
    let downloadUrl = null;
    if (drop.storage === 'r2' && drop.objectKey) {
      const presigned = await r2.presignDownload(drop.objectKey);
      downloadUrl = presigned.downloadUrl;
    }

    // View-once cleanup.
    //
    // For in-memory drops the ciphertext is returned inline in this very
    // response, so once all recipients have claimed we can delete immediately —
    // there is no separate download to race.
    //
    // For R2 drops the browser still has to fetch the ciphertext from the bucket
    // using the presigned URL above, AFTER this call returns. Deleting now would
    // kill that download. So we do NOT delete here; instead the client calls
    // completeDrop() once it has downloaded and decrypted, which removes the
    // object immediately and safely. The TTL timer remains the fallback if the
    // client never confirms.
    if (
      drop.storage !== 'r2' &&
      drop.viewOnce &&
      drop.viewedBy.size >= drop.recipientHashes.length
    ) {
      logger.info(`📦 Drop ${dropId}: all recipients have viewed, auto-deleting`);
      this._deleteDrop(dropId);
    }

    return {
      storage: drop.storage,
      encryptedPayload: drop.storage === 'r2' ? null : drop.encryptedPayload,
      downloadUrl,
      iv: drop.iv,
      salt: drop.salt,
      wrappedKey,
      contentType: drop.contentType,
      fileName: drop.fileName,
      mimeType: drop.mimeType,
      fileSize: drop.fileSize,
      expiresAt: drop.expiresAt,
      viewOnce: drop.viewOnce,
    };
  }

  // ─── Confirm Download Complete (R2 view-once immediate destroy) ──

  /**
   * Called by the recipient's browser once it has finished downloading and
   * decrypting an R2-backed drop. For view-once drops this lets the server
   * delete the bucket object the instant the content is safely received,
   * instead of waiting for the TTL. Safe to call more than once.
   *
   * @param {string} dropId
   * @param {string} usernameHash - SHA-256 hash of the claiming username
   * @returns {{ deleted: boolean }}
   */
  completeDrop(dropId, usernameHash) {
    const drop = this.drops.get(dropId);
    // Already gone (expired, or destroyed by a prior completion) — nothing to do.
    if (!drop) return { deleted: true };

    // Only an authorized recipient may signal completion / trigger destruction.
    if (!drop.recipientHashes.includes(usernameHash)) {
      throw new Error('Access denied. Your username is not authorized for this drop.');
    }

    drop.completedBy.add(usernameHash);

    // Once every recipient has confirmed receipt of a view-once drop, destroy
    // it immediately — the download(s) are provably finished, so there is no
    // race with the presigned URL.
    if (drop.viewOnce && drop.completedBy.size >= drop.recipientHashes.length) {
      logger.info(`📦 Drop ${dropId}: all recipients confirmed receipt, destroying now`);
      this._deleteDrop(dropId);
      return { deleted: true };
    }

    return { deleted: false };
  }

  // ─── Lookup by Verbal Code ────────────────────────────────

  /**
   * Resolve a verbal code to a drop ID
   * @param {string} verbalCode - 4-word verbal code
   * @returns {string|null} Drop ID or null
   */
  resolveVerbalCode(verbalCode) {
    const normalized = verbalCode.trim().toLowerCase();
    const dropId = this.verbalCodeIndex.get(normalized);
    if (!dropId) return null;

    // Verify drop still exists
    const drop = this.drops.get(dropId);
    if (!drop || Date.now() > drop.expiresAt) {
      this.verbalCodeIndex.delete(normalized);
      return null;
    }

    return dropId;
  }

  // ─── Lookup by .eph Packet ────────────────────────────────

  /**
   * Validate an .eph packet and return the drop ID if valid
   * @param {Object} ephPacket - Parsed .eph file contents
   * @returns {string} Drop ID
   */
  validateEphPacket(ephPacket) {
    if (!ephPacket || ephPacket.v !== 1 || ephPacket.type !== 'ephemeral-drop') {
      throw new Error('Invalid .eph file format');
    }

    const { dropId, ts, sig } = ephPacket;

    if (!dropId || !ts || !sig) {
      throw new Error('Incomplete .eph file');
    }

    // Verify HMAC signature
    try {
      if (!this.verifyEphSignature(dropId, ts, sig)) {
        throw new Error('Invalid .eph file signature — file may be tampered');
      }
    } catch (e) {
      throw new Error('Invalid .eph file signature — file may be tampered');
    }

    // Check if drop exists
    const drop = this.drops.get(dropId);
    if (!drop) {
      throw new Error('Drop not found or has expired');
    }

    if (Date.now() > drop.expiresAt) {
      this._expireDrop(dropId);
      throw new Error('Drop has expired');
    }

    return dropId;
  }

  // ─── Creator Operations ──────────────────────────────────

  /**
   * Get all drops created by a specific creator
   * @param {string} creatorId - Creator's device ID
   * @returns {Object[]} Array of drop metadata
   */
  getDropsByCreator(creatorId) {
    const dropIds = this.creatorDrops.get(creatorId);
    if (!dropIds || dropIds.size === 0) return [];

    const result = [];
    for (const dropId of dropIds) {
      const info = this.getDropInfo(dropId);
      if (info) {
        result.push(info);
      }
    }

    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Delete a drop (creator only)
   * @param {string} dropId - Drop ID
   * @param {string} creatorId - Must match the creator
   */
  deleteDrop(dropId, creatorId) {
    const drop = this.drops.get(dropId);
    if (!drop) {
      throw new Error('Drop not found');
    }

    if (drop.creatorId !== creatorId) {
      throw new Error('Only the creator can delete this drop');
    }

    this._deleteDrop(dropId);
    logger.info(`📦 Drop deleted by creator: ${dropId}`);
  }

  // ─── Internal Cleanup ────────────────────────────────────

  /**
   * Delete a drop and clean up all references
   * @param {string} dropId
   * @param {Object} [options]
   * @param {number} [options.objectGraceMs=0] - For R2 drops, delay the bucket
   *   object deletion by this many ms (lets an in-flight presigned download
   *   finish). Metadata is always removed immediately.
   */
  _deleteDrop(dropId, options = {}) {
    const drop = this.drops.get(dropId);
    if (!drop) return;

    const { objectGraceMs = 0 } = options;

    // For R2-backed drops, remove the ciphertext object from the bucket too.
    // Fire-and-forget: r2.deleteObject never throws.
    if (drop.storage === 'r2' && drop.objectKey) {
      const { objectKey } = drop;
      if (objectGraceMs > 0) {
        const timer = setTimeout(() => r2.deleteObject(objectKey), objectGraceMs);
        if (typeof timer.unref === 'function') timer.unref();
      } else {
        r2.deleteObject(objectKey);
      }
    }

    // Remove from verbal code index
    if (drop.verbalCode) {
      this.verbalCodeIndex.delete(drop.verbalCode);
    }

    // Remove from creator tracking
    const creatorDrops = this.creatorDrops.get(drop.creatorId);
    if (creatorDrops) {
      creatorDrops.delete(dropId);
      if (creatorDrops.size === 0) {
        this.creatorDrops.delete(drop.creatorId);
      }
    }

    // Clear expiry timer
    const timerId = this.expiryTimers.get(dropId);
    if (timerId) {
      clearTimeout(timerId);
      this.expiryTimers.delete(dropId);
    }

    // Remove the drop itself
    this.drops.delete(dropId);
  }

  /**
   * Expire a drop (TTL reached)
   */
  _expireDrop(dropId) {
    const drop = this.drops.get(dropId);
    if (drop) {
      logger.info(`📦 Drop expired: ${dropId} (created ${new Date(drop.createdAt).toISOString()})`);
    }
    this._deleteDrop(dropId);
  }

  /**
   * Periodic cleanup of expired drops
   */
  _cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [dropId, drop] of this.drops.entries()) {
      if (now > drop.expiresAt) {
        this._deleteDrop(dropId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`🧹 Cleaned up ${cleaned} expired drop(s). Active: ${this.drops.size}`);
    }
  }

  // ─── Stats ────────────────────────────────────────────────

  getStats() {
    return {
      totalDrops: this.drops.size,
      totalCreators: this.creatorDrops.size,
      totalVerbalCodes: this.verbalCodeIndex.size,
    };
  }

  /**
   * Shutdown — clear all intervals
   */
  shutdown() {
    clearInterval(this.cleanupInterval);
    for (const timerId of this.expiryTimers.values()) {
      clearTimeout(timerId);
    }
    this.expiryTimers.clear();
    logger.info('📦 DropManager shut down');
  }
}

module.exports = {
  DropManager,
  DROP_TTL_OPTIONS,
  MAX_DROPS_PER_CREATOR,
  MAX_RECIPIENTS_PER_DROP,
  MAX_PAYLOAD_SIZE,
  MAX_PAYLOAD_SIZE_R2,
};
