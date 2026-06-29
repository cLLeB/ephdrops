import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Package, Clock, Eye, EyeOff, AlertTriangle,
  FileDown, Type, Image, Mic, FileUp, Shield, Loader2, Lock
} from 'lucide-react';
import { decryptDrop, decryptDropFromBytes, arrayBufferToText, arrayBufferToDataUrl, arrayBufferToObjectUrl, hashUsername, completeDropAPI } from '../utils/drops';
import { formatTimeRemaining } from '../utils/eph-file';
import { downloadDataUrlOnDevice, downloadObjectUrlOnDevice } from '../utils/downloadHelper';
import StegoModal from './StegoModal';

// ─── Component ────────────────────────────────────────────

const DropViewer = ({ onClose, claimData }) => {
  const { t } = useTranslation();
  const {
    dropId,
    username,
    encryptedPayload,
    downloadUrl,
    iv,
    salt,
    wrappedKey,
    contentType: rawContentType,
    fileName,
    mimeType,
    fileSize,
    expiresAt,
    viewOnce,
  } = claimData;

  // Reconstruct contentMeta from flat server response fields
  const contentMeta = useMemo(() => ({
    type: rawContentType || 'text',
    fileName: fileName || null,
    mimeType: mimeType || null,
    size: fileSize || null,
  }), [rawContentType, fileName, mimeType, fileSize]);

  const [decryptedContent, setDecryptedContent] = useState(null);
  const [decryptionError, setDecryptionError] = useState('');
  const [isDecrypting, setIsDecrypting] = useState(true);
  const [timeRemaining, setTimeRemaining] = useState('');
  const [isExpired, setIsExpired] = useState(false);
  const [objectUrl, setObjectUrl] = useState(null);
  const [stegoImage, setStegoImage] = useState(null);
  const [showStego, setShowStego] = useState(false);

  // ─── Decrypt on mount ───────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const doDecrypt = async () => {
      try {
        let plainBuffer;

        if (downloadUrl) {
          // R2-backed drop: pull the ciphertext directly from the bucket via the
          // presigned URL, then decrypt the raw bytes locally. Plain fetch — this
          // is a cross-origin request to Cloudflare, not our API.
          const ctResponse = await fetch(downloadUrl);
          if (!ctResponse.ok) {
            throw new Error(`Failed to download encrypted file (status ${ctResponse.status})`);
          }
          const ciphertextBytes = await ctResponse.arrayBuffer();
          if (cancelled) return;
          plainBuffer = await decryptDropFromBytes(ciphertextBytes, iv, salt, wrappedKey, username);
        } else {
          plainBuffer = await decryptDrop(encryptedPayload, iv, salt, wrappedKey, username);
        }

        if (cancelled) return;

        const type = contentMeta?.type || 'text';

        const getMimeType = (meta, defaultType) => {
          if (meta?.mimeType) return meta.mimeType;
          if (meta?.fileName) {
            const ext = meta.fileName.split('.').pop().toLowerCase();
            const audioTypes = {
              'mp3': 'audio/mpeg',
              'wav': 'audio/wav',
              'ogg': 'audio/ogg',
              'm4a': 'audio/mp4',
              'webm': 'audio/webm',
              'aac': 'audio/aac'
            };
            if (audioTypes[ext]) return audioTypes[ext];
          }
          return defaultType;
        };

        if (type === 'text') {
          const text = arrayBufferToText(plainBuffer);
          setDecryptedContent({ type: 'text', data: text });
        } else if (type === 'image') {
          const dataUrl = arrayBufferToDataUrl(plainBuffer, contentMeta.mimeType || 'image/png');
          setDecryptedContent({ type: 'image', data: dataUrl, meta: contentMeta });
        } else if (type === 'audio') {
          const mType = getMimeType(contentMeta, 'audio/mpeg');
          const url = arrayBufferToObjectUrl(plainBuffer, mType);
          setObjectUrl(url);
          setDecryptedContent({ type: 'audio', data: url, meta: contentMeta });
        } else {
          // Generic file
          const mType = getMimeType(contentMeta, 'application/octet-stream');
          const url = arrayBufferToObjectUrl(plainBuffer, mType);
          setObjectUrl(url);
          setDecryptedContent({ type: 'file', data: url, meta: contentMeta });
        }

        // The content is now safely downloaded and decrypted in the browser.
        // For view-once drops, confirm receipt so the server destroys the
        // source (and the R2 object) immediately instead of waiting for the TTL.
        // Fire-and-forget — never block or fail the view on this.
        if (viewOnce && username && salt) {
          hashUsername(username, salt)
            .then((usernameHash) => completeDropAPI(dropId, usernameHash))
            .catch(() => { /* non-fatal: TTL still cleans up */ });
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Decryption failed:', err);
          setDecryptionError(
            'Failed to decrypt. This usually means the username is incorrect, ' +
            'or the drop data was corrupted.'
          );
        }
      } finally {
        if (!cancelled) setIsDecrypting(false);
      }
    };

    doDecrypt();

    return () => {
      cancelled = true;
    };
  }, [encryptedPayload, downloadUrl, iv, salt, wrappedKey, username, contentMeta]);

  // ─── Cleanup object URLs ────────────────────────────────

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  // ─── Countdown Timer ────────────────────────────────────

  useEffect(() => {
    if (!expiresAt) return;

    const tick = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        setIsExpired(true);
        setTimeRemaining('Expired');
      } else {
        setTimeRemaining(formatTimeRemaining(expiresAt));
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  // ─── File Download ──────────────────────────────────────

  const handleDownload = useCallback(async () => {
    if (!decryptedContent?.data) return;
    const fileName = contentMeta?.fileName || 'drop-file';
    const mimeType = contentMeta?.mimeType || 'application/octet-stream';

    try {
      if (decryptedContent.type === 'image') {
        // data URL (data:image/png;base64,...)
        await downloadDataUrlOnDevice(decryptedContent.data, fileName);
      } else {
        // object URL (blob:http://...) for file/audio
        await downloadObjectUrlOnDevice(decryptedContent.data, fileName, mimeType);
      }
    } catch (e) {
      console.error('[DropViewer] Download failed:', e);
    }
  }, [decryptedContent, contentMeta]);

  // ─── Stego extraction ──────────────────────────────────

  const openStegoExtract = useCallback((dataUrl) => {
    const [header, b64] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    setStegoImage(new Blob([bytes], { type: mime }));
    setShowStego(true);
  }, []);

  // ─── Content Type Icon ──────────────────────────────────

  const ContentIcon = useMemo(() => {
    switch (contentMeta?.type) {
      case 'image': return Image;
      case 'audio': return Mic;
      case 'file': return FileUp;
      default: return Type;
    }
  }, [contentMeta?.type]);

  // ─── Render ─────────────────────────────────────────────

  return (
    <>
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-50">
      <div className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-lg relative shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-purple-500" />
            <h2 className="text-lg font-bold dark:text-white">{t('drops.viewer.title')}</h2>
          </div>
          <div className="flex items-center gap-2">
            {/* Timer */}
            {timeRemaining && (
              <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${isExpired
                ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                : 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
                }`}>
                <Clock className="w-3 h-3" />
                {timeRemaining}
              </div>
            )}
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 max-h-[70vh] overflow-y-auto no-scrollbar">
          {/* Loading */}
          {isDecrypting && (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('drops.viewer.decrypting')}</p>
            </div>
          )}

          {/* Decryption Error */}
          {decryptionError && (
            <div className="py-8 text-center space-y-3">
              <div className="w-16 h-16 mx-auto bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-red-500" />
              </div>
              <h3 className="text-lg font-bold text-red-600 dark:text-red-400">{t('drops.viewer.decryptionFailed')}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
                {t('drops.viewer.decryptionFailedDesc')}
              </p>
              <button
                onClick={onClose}
                className="mt-4 px-4 py-2 text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                {t('common.close')}
              </button>
            </div>
          )}

          {/* Decrypted Content */}
          {decryptedContent && !decryptionError && (
            <div className="space-y-4">
              {/* Meta badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="flex items-center gap-1 px-2 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-full text-xs font-medium">
                  <ContentIcon className="w-3 h-3" />
                  {contentMeta?.type || 'text'}
                </span>
                {viewOnce && (
                  <span className="flex items-center gap-1 px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full text-xs font-medium">
                    <EyeOff className="w-3 h-3" />
                    {t('drops.viewer.viewOnceWarning')}
                  </span>
                )}
                <span className="flex items-center gap-1 px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full text-xs font-medium">
                  <Shield className="w-3 h-3" />
                  {t('drops.viewer.encrypted')}
                </span>
              </div>

              {/* Text Content */}
              {decryptedContent.type === 'text' && (
                <div
                  className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600"
                  data-allow-copy="true"
                >
                  <pre className="whitespace-pre-wrap text-sm text-gray-900 dark:text-white font-sans leading-relaxed break-words">
                    {decryptedContent.data}
                  </pre>
                </div>
              )}

              {/* Image Content */}
              {decryptedContent.type === 'image' && (
                <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-600">
                  <img
                    src={decryptedContent.data}
                    alt="Decrypted drop"
                    className="max-w-full max-h-[50vh] mx-auto object-contain bg-gray-900"
                  />
                  <div className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700/50 gap-2 flex-wrap">
                    {contentMeta?.fileName && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate flex-1">
                        {contentMeta.fileName}
                      </p>
                    )}
                    <div className="flex items-center gap-2 ml-auto">
                      <button
                        onClick={() => openStegoExtract(decryptedContent.data)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-100 dark:bg-indigo-900/30 hover:bg-indigo-200 dark:hover:bg-indigo-800/40 text-indigo-700 dark:text-indigo-400 font-medium rounded-lg transition-colors text-xs"
                      >
                        <Lock className="w-3 h-3" />
                        {t('drops.viewer.decodeStego')}
                      </button>
                      <button
                        onClick={handleDownload}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-500 hover:bg-purple-600 text-white font-medium rounded-lg transition-colors text-xs"
                      >
                        <FileDown className="w-3.5 h-3.5" />
                        {t('drops.viewer.saveImage')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Audio Content */}
              {decryptedContent.type === 'audio' && (
                <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 space-y-2">
                  <audio
                    controls
                    src={decryptedContent.data}
                    className="w-full"
                  />
                  <div className="flex items-center justify-between">
                    {contentMeta?.fileName && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {contentMeta.fileName}
                      </p>
                    )}
                    <button
                      onClick={handleDownload}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-500 hover:bg-purple-600 text-white font-medium rounded-lg transition-colors text-xs ml-auto"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      {t('drops.viewer.saveAudio')}
                    </button>
                  </div>
                </div>
              )}

              {/* File Content */}
              {decryptedContent.type === 'file' && (
                <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 text-center space-y-3">
                  <FileDown className="w-10 h-10 text-gray-400 mx-auto" />
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {contentMeta?.fileName || t('drops.viewer.decryptedFile')}
                  </p>
                  {contentMeta?.size && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {(contentMeta.size / 1024).toFixed(1)} KB
                    </p>
                  )}
                  <button
                    onClick={handleDownload}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white font-medium rounded-lg transition-colors text-sm"
                  >
                    <FileDown className="w-4 h-4" />
                    {t('drops.viewer.downloadFile')}
                  </button>
                </div>
              )}

              {/* View Once Warning */}
              {viewOnce && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800/50 flex items-start gap-2">
                  <EyeOff className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-red-600 dark:text-red-400">
                    {t('drops.viewer.viewOnceNote')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {decryptedContent && !decryptionError && (
          <div className="p-4 border-t border-gray-100 dark:border-gray-700 flex justify-end">
            <button
              onClick={onClose}
              className="px-6 py-2 text-sm font-bold bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors"
            >
              {viewOnce ? t('drops.viewer.closeDestroy') : t('common.close')}
            </button>
          </div>
        )}
      </div>
    </div>
      {showStego && (
        <StegoModal
          isOpen={showStego}
          onClose={() => { setShowStego(false); setStegoImage(null); }}
          initialExtractImage={stegoImage}
        />
      )}
    </>
  );
};

export default DropViewer;
