/**
 * Drop API Routes for Ephemeral Chat
 * 
 * REST endpoints for creating, claiming, and managing Ephemeral Drops.
 * All content is encrypted client-side — server only stores ciphertext.
 */

const express = require('express');
const { logger } = require('./utils');
const r2 = require('./r2');
const { MAX_PAYLOAD_SIZE, MAX_PAYLOAD_SIZE_R2 } = require('./drops');
const {
  generateEphFileBuffer,
  validateEphPacket,
  EPH_MIME_TYPE,
  suggestFilename,
} = require('./utils/eph-file');

/**
 * Create the drops router
 * @param {import('./drops').DropManager} dropManager - The drop manager instance
 * @param {Object} [options] - Options
 * @param {Function} [options.rateLimiter] - Optional rate limiter middleware
 * @returns {express.Router}
 */
function createDropRoutes(dropManager, options = {}) {
  const router = express.Router();

  // ─── Rate Limiting ──────────────────────────────────────

  // Simple in-memory rate limiter for drop creation
  const createLimits = new Map(); // ip -> { count, resetTime }
  const claimLimits = new Map();  // ip -> { count, resetTime }

  // Hard cap on in-memory rate limit entries to prevent unbounded growth under
  // high-volume attacks using rotating IP addresses or proxy pools.
  const MAX_RATE_LIMIT_ENTRIES = 50000;

  function rateLimit(store, maxRequests, windowMs) {
    return (req, res, next) => {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      const now = Date.now();

      // Refuse to track more IPs than the cap allows — fail open (let request proceed)
      // rather than crash, but log so operators are aware of the pressure.
      if (!store.has(ip) && store.size >= MAX_RATE_LIMIT_ENTRIES) {
        logger.warn('[drops-rate-limit] Rate limit store at capacity, skipping tracking for IP');
        return next();
      }

      const entry = store.get(ip) || { count: 0, resetTime: now + windowMs };

      if (now > entry.resetTime) {
        entry.count = 0;
        entry.resetTime = now + windowMs;
      }

      entry.count++;
      store.set(ip, entry);

      if (entry.count > maxRequests) {
        return res.status(429).json({
          error: 'Too many requests. Please try again later.',
          retryAfter: Math.ceil((entry.resetTime - now) / 1000),
        });
      }

      next();
    };
  }

  // Rate limits: 10 creates per 10 minutes, 30 claims per 10 minutes
  const createRateLimit = rateLimit(createLimits, 10, 10 * 60 * 1000);
  const claimRateLimit = rateLimit(claimLimits, 30, 10 * 60 * 1000);

  // Periodic cleanup of rate limit maps
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of createLimits.entries()) {
      if (now > entry.resetTime) createLimits.delete(ip);
    }
    for (const [ip, entry] of claimLimits.entries()) {
      if (now > entry.resetTime) claimLimits.delete(ip);
    }
  }, 5 * 60 * 1000);

  // ─── POST /api/drops — Create a new drop ─────────────────

  router.post('/', createRateLimit, async (req, res) => {
    try {
      const {
        encryptedPayload,
        iv,
        salt,
        contentType,
        wrappedKeys,
        recipientHashes,
        creatorId,
        ttl,
        viewOnce,
        fileName,
        mimeType,
        fileSize,
        encryptedHint,
        storage,
        byteSize,
      } = req.body;

      // In R2 mode the browser uploads the ciphertext directly to the bucket, so
      // encryptedPayload is absent and a declared byteSize stands in for it.
      const useR2 = storage === 'r2' && r2.isR2Enabled();

      const hasPayload = useR2 ? typeof byteSize === 'number' : !!encryptedPayload;
      if (!hasPayload || !iv || !salt || !contentType || !wrappedKeys || !recipientHashes || !creatorId) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (creatorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID format' });
      }

      // Validate encryptedHint structure if present
      if (encryptedHint !== null && encryptedHint !== undefined) {
        if (typeof encryptedHint !== 'object' || !encryptedHint.iv || !encryptedHint.ciphertext) {
          return res.status(400).json({ error: 'Invalid encryptedHint format' });
        }
      }

      const result = await dropManager.createDrop({
        encryptedPayload,
        iv,
        salt,
        contentType,
        wrappedKeys,
        recipientHashes,
        creatorId,
        ttl,
        viewOnce,
        fileName,
        mimeType,
        fileSize,
        encryptedHint: encryptedHint || null,
        storage: useR2 ? 'r2' : 'memory',
        byteSize,
      });

      res.status(201).json({
        success: true,
        dropId: result.dropId,
        verbalCode: result.verbalCode,
        expiresAt: result.expiresAt,
        ephPacket: result.ephPacket,
        storage: result.storage,
        // Present only for R2 drops — the browser PUTs the ciphertext here next.
        uploadUrl: result.uploadUrl || null,
      });
    } catch (error) {
      logger.error('Error creating drop:', error.message);
      const status = error.message.includes('capacity') || error.message.includes('maximum') ? 429 : 400;
      res.status(status).json({ error: error.message });
    }
  });

  // ─── Multipart upload for large R2 drops ────────────────────
  // The client switches to these when the encrypted payload exceeds its
  // multipart threshold. All four verify creatorId via getUploadTarget so only
  // the drop's creator can drive its upload. (Three-segment paths, so they never
  // collide with the static or /:dropId routes below.)

  router.post('/:dropId/multipart/create', claimRateLimit, async (req, res) => {
    try {
      if (!r2.isR2Enabled()) return res.status(400).json({ error: 'R2 storage is not enabled' });
      const objectKey = dropManager.getUploadTarget(req.params.dropId, req.body.creatorId);
      const { uploadId } = await r2.createMultipartUpload(objectKey);
      res.json({ uploadId });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/:dropId/multipart/sign', claimRateLimit, async (req, res) => {
    try {
      if (!r2.isR2Enabled()) return res.status(400).json({ error: 'R2 storage is not enabled' });
      const { creatorId, uploadId, partNumbers } = req.body;
      if (!uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
        return res.status(400).json({ error: 'uploadId and partNumbers[] are required' });
      }
      if (partNumbers.length > 10000) {
        return res.status(400).json({ error: 'Too many parts requested' });
      }
      const objectKey = dropManager.getUploadTarget(req.params.dropId, creatorId);
      const urls = await r2.presignUploadParts(objectKey, uploadId, partNumbers);
      res.json({ urls });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/:dropId/multipart/complete', claimRateLimit, async (req, res) => {
    try {
      if (!r2.isR2Enabled()) return res.status(400).json({ error: 'R2 storage is not enabled' });
      const { creatorId, uploadId, parts } = req.body;
      if (!uploadId || !Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: 'uploadId and parts[] are required' });
      }
      const objectKey = dropManager.getUploadTarget(req.params.dropId, creatorId);
      await r2.completeMultipartUpload(objectKey, uploadId, parts);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/:dropId/multipart/abort', claimRateLimit, async (req, res) => {
    try {
      const objectKey = dropManager.getUploadTarget(req.params.dropId, req.body.creatorId);
      await r2.abortMultipartUpload(objectKey, req.body.uploadId);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // ─── POST /api/drops/resolve-verbal — Resolve verbal code ──
  // NOTE: Static routes MUST come before parameterized /:dropId routes

  router.post('/resolve-verbal', claimRateLimit, async (req, res) => {
    try {
      const { verbalCode } = req.body;

      if (!verbalCode || typeof verbalCode !== 'string') {
        return res.status(400).json({ error: 'Verbal code is required' });
      }

      // Validate format: 4 words
      const words = verbalCode.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
      if (words.length !== 4) {
        return res.status(400).json({ error: 'Verbal code must be exactly 4 words' });
      }

      const dropId = dropManager.resolveVerbalCode(words.join(' '));
      if (!dropId) {
        return res.status(404).json({ error: 'Invalid or expired verbal code' });
      }

      const info = dropManager.getDropInfo(dropId);

      res.json({
        success: true,
        dropId,
        drop: info,
      });
    } catch (error) {
      logger.error('Error resolving verbal code:', error.message);
      res.status(500).json({ error: 'Failed to resolve verbal code' });
    }
  });

  // ─── POST /api/drops/validate-eph — Validate .eph packet ──

  router.post('/validate-eph', claimRateLimit, async (req, res) => {
    try {
      const { ephPacket } = req.body;

      if (!ephPacket) {
        return res.status(400).json({ error: '.eph packet data is required' });
      }

      const validation = validateEphPacket(ephPacket);

      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      // Get drop info
      const info = dropManager.getDropInfo(validation.dropId);
      if (!info) {
        return res.status(404).json({ error: 'Drop not found or has expired' });
      }

      res.json({
        success: true,
        dropId: validation.dropId,
        hint: validation.hint,
        drop: info,
      });
    } catch (error) {
      logger.error('Error validating .eph packet:', error.message);
      res.status(500).json({ error: 'Failed to validate .eph file' });
    }
  });

  // ─── GET /api/drops/mine/:creatorId — List my drops ───────
  // NOTE: Must come before /:dropId to avoid "mine" being captured as dropId
  //
  // The creatorId is a 128-bit UUID stored only in the user's sessionStorage —
  // it is effectively a per-session secret and is sufficient protection here.
  // Encrypted content is never returned by this endpoint (metadata only), and
  // the HMAC token layer was causing spurious auth failures under proxies/mobile.

  router.get('/mine/:creatorId', claimRateLimit, async (req, res) => {
    try {
      const { creatorId } = req.params;

      if (!creatorId || typeof creatorId !== 'string') {
        return res.status(400).json({ error: 'Creator ID is required' });
      }

      const drops = dropManager.getDropsByCreator(creatorId);

      res.json({
        success: true,
        drops,
        count: drops.length,
      });
    } catch (error) {
      logger.error('Error listing creator drops:', error.message);
      res.status(500).json({ error: 'Failed to list drops' });
    }
  });

  // ─── GET /api/drops/system/stats — Get drop system stats ──
  // NOTE: Must come before /:dropId to avoid "system" being captured as dropId

  router.get('/system/stats', claimRateLimit, (req, res) => {
    try {
      const stats = dropManager.getStats();
      res.json({ success: true, stats });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // ─── GET /api/drops/config — Client storage configuration ──
  // NOTE: Must come before /:dropId. Lets the browser decide whether to upload
  // ciphertext directly to R2 (presigned) or inline it in the create request.

  router.get('/config', (req, res) => {
    const r2Enabled = r2.isR2Enabled();
    res.json({
      success: true,
      storage: r2Enabled ? 'r2' : 'memory',
      maxPayloadSize: r2Enabled ? MAX_PAYLOAD_SIZE_R2 : MAX_PAYLOAD_SIZE,
    });
  });

  // ─── GET /api/drops/:dropId — Get drop info (metadata only) ──
  // NOTE: Parameterized routes come after all static routes

  router.get('/:dropId', async (req, res) => {
    try {
      const { dropId } = req.params;

      if (!dropId || typeof dropId !== 'string') {
        return res.status(400).json({ error: 'Invalid drop ID' });
      }

      const info = dropManager.getDropInfo(dropId);
      if (!info) {
        return res.status(404).json({ error: 'Drop not found or has expired' });
      }

      res.json({
        success: true,
        drop: info,
      });
    } catch (error) {
      logger.error('Error getting drop info:', error.message);
      res.status(500).json({ error: 'Failed to retrieve drop information' });
    }
  });

  // ─── GET /api/drops/:dropId/eph — Download .eph file ──────

  router.get('/:dropId/eph', async (req, res) => {
    try {
      const { dropId } = req.params;

      const info = dropManager.getDropInfo(dropId);
      if (!info) {
        return res.status(404).json({ error: 'Drop not found or has expired' });
      }

      const buffer = generateEphFileBuffer(dropId, info.encryptedHint);
      const rawFilename = suggestFilename(dropId, null); // hint is encrypted — don't use in filename
      // Strip any characters that could break the Content-Disposition header value
      // (quotes, backslashes, control chars, path separators)
      const safeFilename = rawFilename.replace(/[^\w.\-]/g, '_').substring(0, 100);

      res.setHeader('Content-Type', EPH_MIME_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.send(buffer);
    } catch (error) {
      logger.error('Error generating .eph file:', error.message);
      res.status(500).json({ error: 'Failed to generate .eph file' });
    }
  });

  // ─── POST /api/drops/:dropId/claim — Claim a drop ────────

  router.post('/:dropId/claim', claimRateLimit, async (req, res) => {
    try {
      const { dropId } = req.params;
      const { usernameHash } = req.body;

      if (!dropId || typeof dropId !== 'string') {
        return res.status(400).json({ error: 'Invalid drop ID' });
      }

      if (!usernameHash || typeof usernameHash !== 'string') {
        return res.status(400).json({ error: 'Username hash is required' });
      }

      // Validate hash format (should be 64-char hex — SHA-256)
      if (!/^[a-f0-9]{64}$/.test(usernameHash)) {
        return res.status(400).json({ error: 'Invalid username hash format' });
      }

      const result = await dropManager.claimDrop(dropId, usernameHash);

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error('Error claiming drop:', error.message);

      if (error.message.includes('not found') || error.message.includes('expired')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message.includes('denied') || error.message.includes('not authorized')) {
        return res.status(403).json({ error: error.message });
      }
      if (error.message.includes('already viewed')) {
        return res.status(410).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to claim drop' });
    }
  });

  // ─── POST /api/drops/:dropId/complete — Confirm receipt ───
  // The recipient's browser calls this once it has downloaded + decrypted the
  // content. For R2 view-once drops it triggers immediate destruction of the
  // bucket object (no waiting for the TTL).

  router.post('/:dropId/complete', claimRateLimit, async (req, res) => {
    try {
      const { dropId } = req.params;
      const { usernameHash } = req.body;

      if (!dropId || typeof dropId !== 'string') {
        return res.status(400).json({ error: 'Invalid drop ID' });
      }
      if (!usernameHash || !/^[a-f0-9]{64}$/.test(usernameHash)) {
        return res.status(400).json({ error: 'Invalid username hash format' });
      }

      const result = dropManager.completeDrop(dropId, usernameHash);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Error completing drop:', error.message);
      if (error.message.includes('denied') || error.message.includes('not authorized')) {
        return res.status(403).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to complete drop' });
    }
  });

  // ─── DELETE /api/drops/:dropId — Delete a drop ────────────

  router.delete('/:dropId', async (req, res) => {
    try {
      const { dropId } = req.params;
      const { creatorId } = req.body;

      if (!dropId || !creatorId) {
        return res.status(400).json({ error: 'Drop ID and creator ID are required' });
      }

      if (creatorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID format' });
      }

      dropManager.deleteDrop(dropId, creatorId);

      res.json({
        success: true,
        message: 'Drop deleted successfully',
      });
    } catch (error) {
      logger.error('Error deleting drop:', error.message);

      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message.includes('Only the creator')) {
        return res.status(403).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to delete drop' });
    }
  });

  return router;
}

module.exports = { createDropRoutes };
