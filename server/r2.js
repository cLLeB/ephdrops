/**
 * Cloudflare R2 storage adapter for Ephemeral Drops.
 *
 * R2 holds only the large encrypted blob (ciphertext). The server never sends
 * that blob through its own RAM — instead it hands the browser a short-lived
 * presigned URL and the browser uploads/downloads directly to/from R2.
 *
 * The server still stores all small metadata (wrapped keys, recipient hashes,
 * verbal code, TTL, the R2 object key) in the DropManager, exactly as before.
 *
 * If the R2 environment variables are not set, isR2Enabled() returns false and
 * the app transparently falls back to storing ciphertext in memory — so local
 * development works with zero configuration.
 *
 * Required env vars (all four):
 *   R2_ACCOUNT_ID         Cloudflare account ID (R2 dashboard)
 *   R2_ACCESS_KEY_ID      R2 API token access key id
 *   R2_SECRET_ACCESS_KEY  R2 API token secret
 *   R2_BUCKET             Bucket name
 *
 * Optional:
 *   R2_PUT_EXPIRY_SECONDS  Presigned upload URL lifetime (default 600)
 *   R2_GET_EXPIRY_SECONDS  Presigned download URL lifetime (default 300)
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { logger } = require('./utils');

// ─── Configuration ──────────────────────────────────────────

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET;

const PUT_EXPIRY_SECONDS = parseInt(process.env.R2_PUT_EXPIRY_SECONDS, 10) || 600;
const GET_EXPIRY_SECONDS = parseInt(process.env.R2_GET_EXPIRY_SECONDS, 10) || 300;

const R2_ENABLED = Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET);

// Lazily-constructed singleton client.
let _client = null;

/**
 * @returns {boolean} true when all required R2 env vars are present.
 */
function isR2Enabled() {
  return R2_ENABLED;
}

/**
 * How long a presigned download URL is valid, in seconds. Exposed so callers
 * (e.g. the view-once deletion grace period) can keep in-flight downloads alive.
 * @returns {number}
 */
function getDownloadExpirySeconds() {
  return GET_EXPIRY_SECONDS;
}

/**
 * Build (once) and return the S3 client pointed at the R2 endpoint.
 *
 * IMPORTANT: requestChecksumCalculation/responseChecksumValidation are forced to
 * 'WHEN_REQUIRED'. Recent AWS SDK versions default to 'WHEN_SUPPORTED', which
 * adds x-amz-sdk-checksum-algorithm / x-amz-checksum-* headers into the signed
 * request. Browsers performing a plain presigned PUT cannot reproduce those
 * headers, so the signature check on R2 fails. Disabling them keeps the signed
 * URL to just the canonical query params a browser fetch() can satisfy.
 *
 * @returns {S3Client}
 */
function getClient() {
  if (!R2_ENABLED) {
    throw new Error('R2 is not configured — getClient() must not be called.');
  }
  if (_client) return _client;

  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return _client;
}

/**
 * Deterministically derive the R2 object key for a drop.
 * @param {string} dropId
 * @returns {string}
 */
function generateObjectKey(dropId) {
  return `drops/${dropId}`;
}

/**
 * Create a short-lived presigned PUT URL the browser uses to upload ciphertext.
 *
 * No ContentType / ContentLength is baked into the signature, so the browser
 * can PUT the bytes with minimal headers (the body is opaque ciphertext anyway).
 *
 * @param {string} objectKey
 * @returns {Promise<{ uploadUrl: string, expiresIn: number }>}
 */
async function presignUpload(objectKey) {
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: objectKey });
  const uploadUrl = await getSignedUrl(getClient(), command, {
    expiresIn: PUT_EXPIRY_SECONDS,
  });
  return { uploadUrl, expiresIn: PUT_EXPIRY_SECONDS };
}

/**
 * Create a short-lived presigned GET URL the browser uses to download ciphertext.
 * @param {string} objectKey
 * @returns {Promise<{ downloadUrl: string, expiresIn: number }>}
 */
async function presignDownload(objectKey) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: objectKey });
  const downloadUrl = await getSignedUrl(getClient(), command, {
    expiresIn: GET_EXPIRY_SECONDS,
  });
  return { downloadUrl, expiresIn: GET_EXPIRY_SECONDS };
}

/**
 * Delete an object from R2. Never throws — a failed delete is logged but must
 * not break the drop-deletion flow (the object will also age out via lifecycle
 * rules / re-cleanup). Safe to call for objects that may never have been uploaded.
 *
 * @param {string} objectKey
 * @returns {Promise<void>}
 */
async function deleteObject(objectKey) {
  if (!R2_ENABLED) return;
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: objectKey }));
    logger.info(`🗑️  R2 object deleted: ${objectKey}`);
  } catch (error) {
    logger.warn(`[r2] Failed to delete object ${objectKey}: ${error.message}`);
  }
}

// ─── Multipart upload (large files) ─────────────────────────
// For payloads above the client's multipart threshold the browser uploads in
// parts so the transfer is resumable, shows progress, and never holds the whole
// body in a single request. The object that results is a normal R2 object, so
// presignDownload works unchanged on claim.

/**
 * Begin a multipart upload. Returns the uploadId that ties the parts together.
 * @param {string} objectKey
 * @returns {Promise<{ uploadId: string }>}
 */
async function createMultipartUpload(objectKey) {
  const out = await getClient().send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: objectKey })
  );
  return { uploadId: out.UploadId };
}

/**
 * Presign a PUT URL for each requested part number.
 * @param {string} objectKey
 * @param {string} uploadId
 * @param {number[]} partNumbers - 1-based part numbers
 * @returns {Promise<Array<{ partNumber: number, url: string }>>}
 */
async function presignUploadParts(objectKey, uploadId, partNumbers) {
  return Promise.all(
    partNumbers.map(async (partNumber) => {
      const command = new UploadPartCommand({
        Bucket: BUCKET,
        Key: objectKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(getClient(), command, { expiresIn: PUT_EXPIRY_SECONDS });
      return { partNumber, url };
    })
  );
}

/**
 * Finalize a multipart upload from the collected part ETags.
 * @param {string} objectKey
 * @param {string} uploadId
 * @param {Array<{ partNumber: number, etag: string }>} parts
 * @returns {Promise<void>}
 */
async function completeMultipartUpload(objectKey, uploadId, parts) {
  const Parts = parts
    .slice()
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => ({ ETag: p.etag, PartNumber: p.partNumber }));
  await getClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: { Parts },
    })
  );
}

/**
 * Abort an in-progress multipart upload so the parts don't linger (and incur
 * storage). Never throws — abort is best-effort cleanup.
 * @param {string} objectKey
 * @param {string} uploadId
 * @returns {Promise<void>}
 */
async function abortMultipartUpload(objectKey, uploadId) {
  if (!R2_ENABLED) return;
  try {
    await getClient().send(
      new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: objectKey, UploadId: uploadId })
    );
  } catch (error) {
    logger.warn(`[r2] Failed to abort multipart ${objectKey}/${uploadId}: ${error.message}`);
  }
}

module.exports = {
  isR2Enabled,
  getDownloadExpirySeconds,
  generateObjectKey,
  presignUpload,
  presignDownload,
  deleteObject,
  createMultipartUpload,
  presignUploadParts,
  completeMultipartUpload,
  abortMultipartUpload,
};
