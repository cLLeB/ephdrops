import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Check, Copy, Package, Hash, MessageSquare, Download,
  Share2, Clock, Eye, EyeOff, Shield, ExternalLink
} from 'lucide-react';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';
import ShareSheet from './ShareSheet';
import { hapticSuccess } from '../utils/platform';
import { downloadEphFile, shareEphFile, buildDropUrl, formatTimeRemaining, supportsNativeFileShare } from '../utils/eph-file';
import { downloadEphFileAPI } from '../utils/drops';
import { downloadFileOnDevice } from '../utils/downloadHelper';

const DropCreatedModal = ({ onClose, dropData }) => {
  const { t } = useTranslation();
  const [isCopied, setIsCopied] = useState({
    dropId: false,
    verbalCode: false,
    url: false,
  });
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [isDownloadingEph, setIsDownloadingEph] = useState(false);
  const [ephDownloaded, setEphDownloaded] = useState(false);

  const { dropId, verbalCode, hint, expiresAt, viewOnce, recipientCount, ephPacket } = dropData;

  const dropUrl = useMemo(() => buildDropUrl(dropId), [dropId]);

  // ─── Copy ──────────────────────────────────────────────

  const copyToClipboard = (text, type) => {
    navigator.clipboard.writeText(text).then(() => {
      hapticSuccess();
      setIsCopied(prev => ({ ...prev, [type]: true }));
      setTimeout(() => {
        setIsCopied(prev => ({ ...prev, [type]: false }));
      }, 2000);
    });
  };

  // ─── .eph Download ─────────────────────────────────────

  const handleDownloadEph = async () => {
    setIsDownloadingEph(true);
    try {
      // If we already have the ephPacket from creation response, use it directly
      if (ephPacket) {
        await downloadEphFile(ephPacket);
      } else {
        // Otherwise fetch the .eph file from server as a Blob and trigger download
        const blob = await downloadEphFileAPI(dropId);
        const fileName = `drop-${dropId.substring(0, 8)}.eph`;
        await downloadFileOnDevice(blob, fileName, 'application/x-ephemeral-drop');
      }
      setEphDownloaded(true);
      hapticSuccess();
    } catch (err) {
      console.error('Failed to download .eph file:', err);
    } finally {
      setIsDownloadingEph(false);
    }
  };

  // ─── Share ──────────────────────────────────────────────

  const handleShare = async () => {
    const platform = Capacitor.getPlatform();
    const isMobile = platform === 'ios' || platform === 'android';

    if (isMobile) {
      // On mobile, try to share the .eph file natively (Nearby Share, Bluetooth, etc.)
      if (ephPacket) {
        const shared = await shareEphFile(ephPacket, hint || 'Ephemeral Drop');
        if (shared) return; // Successfully shared as file
      }

      // Fallback to text share
      const shareText = `You have an Ephemeral Drop waiting!\n\n${verbalCode ? `Verbal Code: ${verbalCode}\n` : ''}${hint ? `Hint: ${hint}\n` : ''}\nOpen: ${dropUrl}`;
      try {
        const canShareResult = await Share.canShare();
        if (canShareResult.value) {
          await Share.share({
            title: 'Ephemeral Drop',
            text: shareText,
            url: dropUrl,
            dialogTitle: 'Share Drop'
          });
          return;
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          copyToClipboard(dropUrl, 'url');
        }
      }
    } else {
      // Web/Electron — custom share sheet
      setShowShareSheet(true);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-50">
        <div className="bg-gray-50 dark:bg-gray-800 rounded-2xl w-full max-w-md relative shadow-2xl overflow-hidden border border-gray-300 dark:border-gray-700">
          {/* Header */}
          <div className="p-6 text-center">
            <div className="w-16 h-16 mx-auto bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
              <Package className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-xl font-bold text-green-600 dark:text-green-400">
              {t('drops.created.title')}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t('drops.created.subtitle')}
            </p>
          </div>

          {/* Content */}
          <div className="px-6 pb-6 space-y-4">
            {/* Drop ID */}
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 flex items-center gap-1">
                <Hash className="w-3 h-3" /> {t('drops.created.dropId')}
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 p-2 bg-gray-50 dark:bg-gray-700 rounded-lg text-sm font-mono text-gray-900 dark:text-white truncate border border-gray-200 dark:border-gray-600">
                  {dropId}
                </code>
                <button
                  onClick={() => copyToClipboard(dropId, 'dropId')}
                  className={`p-2 rounded-lg transition-colors ${
                    isCopied.dropId
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-600'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  {isCopied.dropId ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Verbal Code */}
            {verbalCode && (
              <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-100 dark:border-purple-800/50">
                <label className="block text-xs font-medium text-purple-700 dark:text-purple-300 mb-1.5 flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" /> {t('drops.created.verbalCode')}
                </label>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-lg font-bold text-purple-700 dark:text-purple-200 tracking-wide">
                    {verbalCode}
                  </span>
                  <button
                    onClick={() => copyToClipboard(verbalCode, 'verbalCode')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      isCopied.verbalCode
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                        : 'bg-purple-100 dark:bg-purple-800/50 text-purple-700 dark:text-purple-200 hover:bg-purple-200 dark:hover:bg-purple-800'
                    }`}
                  >
                    {isCopied.verbalCode ? t('common.copied') : t('common.copy')}
                  </button>
                </div>
                <p className="text-xs text-purple-600 dark:text-purple-400 mt-1.5">
                  {t('drops.created.verbalCodeDesc')}
                </p>
              </div>
            )}

            {/* .eph Secure File */}
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-100 dark:border-blue-800/50">
              <label className="block text-xs font-medium text-blue-700 dark:text-blue-300 mb-2 flex items-center gap-1">
                <Shield className="w-3 h-3" /> {t('drops.created.authFile')}
              </label>
              <p className="text-xs text-blue-600 dark:text-blue-400 mb-2">
                {t('drops.created.authFileDesc')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleDownloadEph}
                  disabled={isDownloadingEph}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    ephDownloaded
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800'
                      : 'bg-blue-100 dark:bg-blue-800/50 text-blue-700 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800 border border-blue-200 dark:border-blue-700'
                  }`}
                >
                  {ephDownloaded ? (
                    <><Check className="w-4 h-4" /> {t('drops.created.downloaded')}</>
                  ) : (
                    <><Download className="w-4 h-4" /> {t('drops.created.downloadEph')}</>
                  )}
                </button>
                {supportsNativeFileShare() && ephPacket && (
                  <button
                    onClick={() => shareEphFile(ephPacket, hint || 'Ephemeral Drop')}
                    className="px-3 py-2 rounded-lg text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                  >
                    <Share2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Metadata */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                <Clock className="w-4 h-4 text-gray-400 mx-auto mb-1" />
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('drops.created.expires')}</p>
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {formatTimeRemaining(expiresAt)}
                </p>
              </div>
              <div className="p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                {viewOnce ? (
                  <EyeOff className="w-4 h-4 text-gray-400 mx-auto mb-1" />
                ) : (
                  <Eye className="w-4 h-4 text-gray-400 mx-auto mb-1" />
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('drops.created.view')}</p>
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {viewOnce ? t('drops.created.once') : t('drops.created.multiple')}
                </p>
              </div>
              <div className="p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                <Shield className="w-4 h-4 text-gray-400 mx-auto mb-1" />
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('drops.created.for')}</p>
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {recipientCount} user{recipientCount !== 1 ? 's' : ''}
                </p>
              </div>
            </div>

            {/* Share Button */}
            <button
              onClick={handleShare}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-500 hover:bg-purple-600 text-white font-bold rounded-xl transition-colors shadow-lg shadow-purple-500/20"
            >
              <Share2 className="w-5 h-5" />
              {t('drops.created.shareDrop')}
            </button>

            {/* Close */}
            <button
              onClick={onClose}
              className="w-full px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              {t('common.done')}
            </button>
          </div>
        </div>
      </div>

      {/* ShareSheet for Web/Electron */}
      <ShareSheet
        isOpen={showShareSheet}
        onClose={() => setShowShareSheet(false)}
        shareData={{
          title: 'Ephemeral Drop',
          text: verbalCode
            ? `You have an Ephemeral Drop waiting!\n\nVerbal Code: ${verbalCode}${hint ? `\nHint: ${hint}` : ''}`
            : `You have an Ephemeral Drop waiting!${hint ? `\nHint: ${hint}` : ''}`,
          url: dropUrl,
        }}
      />
    </>
  );
};

export default DropCreatedModal;
