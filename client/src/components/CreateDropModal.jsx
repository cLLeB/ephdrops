import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Package, Type, Image, Mic, FileUp, Plus, Minus,
  Clock, Eye, EyeOff, Users, Shield, Loader2, AlertTriangle, Lock
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { hapticSuccess, hapticError } from '../utils/platform';
import { encryptDrop, createDropAPI, fileToArrayBuffer, getDropConfig } from '../utils/drops';
import { createDropStreaming, STREAM_THRESHOLD } from '../utils/streaming-create';
import { getCreatorId } from '../utils/creator';
import StegoModal from './StegoModal';

// ─── Constants ────────────────────────────────────────────

const MAX_TEXT_LENGTH = 10000;
// Default cap used until the server storage config is fetched. When the server
// is backed by R2, this is raised to the much larger R2 limit (see effect below).
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_RECIPIENTS = 20;

const CONTENT_TYPES = [
  { id: 'text', label: 'Text', icon: Type, description: 'A text message' },
  { id: 'image', label: 'Image', icon: Image, description: 'A photo or image' },
  { id: 'audio', label: 'Audio', icon: Mic, description: 'A voice note or audio' },
  { id: 'file', label: 'File', icon: FileUp, description: 'Any file' },
];

const TTL_OPTIONS = [
  { value: '5min', label: '5 Minutes', short: '5m' },
  { value: '15min', label: '15 Minutes', short: '15m' },
  { value: '30min', label: '30 Minutes', short: '30m' },
  { value: '1hour', label: '1 Hour', short: '1h' },
  { value: '6hour', label: '6 Hours', short: '6h' },
  { value: '24hour', label: '24 Hours', short: '24h' },
];

// ─── Component ────────────────────────────────────────────

const CreateDropModal = ({ onClose, onDropCreated }) => {
  const { t } = useTranslation();
  const { theme } = useTheme();

  // Content
  const [contentType, setContentType] = useState('text');
  const [textContent, setTextContent] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const fileInputRef = useRef(null);

  // Recipients
  const [recipients, setRecipients] = useState(['']);
  const [recipientErrors, setRecipientErrors] = useState({});

  // Settings
  const [ttl, setTtl] = useState('1hour'); // 1 hour default
  const [viewOnce, setViewOnce] = useState(false);
  const [hint, setHint] = useState('');

  // Stego embedding (image drops only)
  const [stegoBlob, setStegoBlob] = useState(null);
  const [showStegoModal, setShowStegoModal] = useState(false);

  // State
  const [isCreating, setIsCreating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // null until a large upload starts
  const [error, setError] = useState('');
  const [step, setStep] = useState(1); // 1: content, 2: recipients, 3: settings

  // Max upload size — raised when the server is R2-backed.
  const [maxFileSize, setMaxFileSize] = useState(MAX_FILE_SIZE);

  useEffect(() => {
    let cancelled = false;
    getDropConfig()
      .then((cfg) => {
        if (cancelled || !cfg?.maxPayloadSize) return;
        // Leave ~1MB headroom: AES-GCM adds a tag and base64/transport overhead.
        const headroom = 1024 * 1024;
        setMaxFileSize(Math.max(MAX_FILE_SIZE, cfg.maxPayloadSize - headroom));
      })
      .catch(() => { /* keep the conservative default */ });
    return () => { cancelled = true; };
  }, []);

  // ─── File Handling ──────────────────────────────────────

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > maxFileSize) {
      setError(t('dropx.err.fileTooLarge', { size: Math.round(maxFileSize / (1024 * 1024)) }));
      return;
    }

    setSelectedFile(file);
    setError('');

    // Generate preview for images
    if (contentType === 'image' && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => setFilePreview(ev.target.result);
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  }, [contentType, maxFileSize]);

  const clearFile = useCallback(() => {
    setSelectedFile(null);
    setFilePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStegoBlob(null);
  }, []);

  // ─── Recipient Management ──────────────────────────────

  const addRecipient = useCallback(() => {
    if (recipients.length >= MAX_RECIPIENTS) return;
    setRecipients(prev => [...prev, '']);
  }, [recipients.length]);

  const removeRecipient = useCallback((index) => {
    if (recipients.length <= 1) return;
    setRecipients(prev => prev.filter((_, i) => i !== index));
    setRecipientErrors(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, [recipients.length]);

  const updateRecipient = useCallback((index, value) => {
    // Normalize: lowercase, trim, only allow alphanumeric, underscore, hyphen, dot
    const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    setRecipients(prev => {
      const next = [...prev];
      next[index] = cleaned;
      return next;
    });

    // Clear error when typing
    setRecipientErrors(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, []);

  // ─── Validation ─────────────────────────────────────────

  const validateStep1 = useCallback(() => {
    if (contentType === 'text') {
      if (!textContent.trim()) {
        setError(t('dropx.err.enterText'));
        return false;
      }
      if (textContent.length > MAX_TEXT_LENGTH) {
        setError(t('dropx.err.textTooLong', { max: MAX_TEXT_LENGTH }));
        return false;
      }
    } else {
      if (!selectedFile) {
        setError(contentType === 'image' ? t('dropx.err.selImage') : contentType === 'audio' ? t('dropx.err.selAudio') : t('dropx.err.selFile'));
        return false;
      }
    }
    setError('');
    return true;
  }, [contentType, textContent, selectedFile]);

  const validateStep2 = useCallback(() => {
    const errors = {};
    const validUsernames = [];

    recipients.forEach((r, i) => {
      const trimmed = r.trim();
      if (!trimmed) {
        errors[i] = t('dropx.err.usernameRequired');
      } else if (trimmed.length < 2) {
        errors[i] = t('dropx.err.min2');
      } else if (trimmed.length > 30) {
        errors[i] = t('dropx.err.max30');
      } else if (validUsernames.includes(trimmed)) {
        errors[i] = t('dropx.err.duplicate');
      } else {
        validUsernames.push(trimmed);
      }
    });

    setRecipientErrors(errors);

    if (Object.keys(errors).length > 0) {
      setError(t('dropx.err.fixRecipients'));
      return false;
    }

    if (validUsernames.length === 0) {
      setError(t('dropx.err.needRecipient'));
      return false;
    }

    setError('');
    return true;
  }, [recipients]);

  // ─── Create Drop ────────────────────────────────────────

  const handleCreate = async () => {
    if (!validateStep2()) return;

    setIsCreating(true);
    setError('');

    try {
      // Recipients, hint, progress callback.
      const usernames = recipients.map(r => r.trim()).filter(Boolean);
      const hintVal = hint.trim() || null;
      const progressCb = (fraction) => setUploadProgress(Math.round(fraction * 100));

      // Helper for the buffered path: encrypt an in-memory buffer and POST.
      const createBuffered = async (contentBuffer, meta) => {
        const encrypted = await encryptDrop(contentBuffer, usernames, hintVal);
        return createDropAPI({
          creatorId: getCreatorId(),
          encryptedBytes: encrypted.encryptedBytes,
          iv: encrypted.iv,
          salt: encrypted.salt,
          wrappedKeys: encrypted.wrappedKeys,
          recipientHashes: encrypted.recipientHashes,
          contentType: meta.contentType,
          fileName: meta.fileName || null,
          mimeType: meta.mimeType || null,
          fileSize: meta.fileSize || null,
          ttl,
          viewOnce,
          encryptedHint: encrypted.encryptedHint || null,
        }, progressCb);
      };

      let result;

      if (contentType !== 'text') {
        // Use the pre-embedded stego blob when present, else the original file.
        const fileToUse = (contentType === 'image' && stegoBlob)
          ? new File([stegoBlob], selectedFile.name.replace(/\.[^.]+$/, '.png'), { type: 'image/png' })
          : selectedFile;
        const meta = {
          contentType,
          fileName: fileToUse.name,
          mimeType: fileToUse.type,
          fileSize: fileToUse.size,
        };

        if (fileToUse.size > STREAM_THRESHOLD) {
          // Streaming: encrypt + upload in parts — the whole file is never in
          // memory, so phones can send far larger files.
          result = await createDropStreaming({
            source: fileToUse,
            usernames,
            hint: hintVal,
            metadata: { ...meta, ttl, viewOnce },
            creatorId: getCreatorId(),
            onProgress: progressCb,
          });
        } else {
          result = await createBuffered(await fileToArrayBuffer(fileToUse), meta);
        }
      } else {
        const contentBuffer = new TextEncoder().encode(textContent).buffer;
        result = await createBuffered(contentBuffer, { contentType: 'text' });
      }

      if (contentType === 'image' && stegoBlob && result.id) {
        try {
          const existing = JSON.parse(localStorage.getItem('stegoDropIds') || '[]');
          if (!existing.includes(result.id)) {
            localStorage.setItem('stegoDropIds', JSON.stringify([...existing, result.id]));
          }
        } catch { /* ignore storage errors */ }
      }

      hapticSuccess();
      onDropCreated({
        ...result,
        viewOnce,
        recipientCount: recipients.filter(r => r.trim()).length,
      });
    } catch (err) {
      console.error('Failed to create drop:', err);
      setError(err.message || t('dropx.err.createFailed'));
      hapticError();
    } finally {
      setIsCreating(false);
      setUploadProgress(null);
    }
  };

  // ─── Step Navigation ────────────────────────────────────

  const nextStep = () => {
    if (step === 1 && validateStep1()) setStep(2);
    else if (step === 2 && validateStep2()) setStep(3);
  };

  const prevStep = () => {
    setError('');
    setStep(prev => Math.max(1, prev - 1));
  };

  // ─── Render Helpers ─────────────────────────────────────

  const getAcceptType = () => {
    switch (contentType) {
      case 'image': return 'image/*';
      case 'audio': return 'audio/*';
      default: return '*/*';
    }
  };

  // ─── Render ─────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-50">
      <div className="bg-gray-50 dark:bg-gray-800 rounded-2xl w-full max-w-md relative shadow-2xl overflow-hidden border border-gray-300 dark:border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-purple-500" />
            <h2 className="text-lg font-bold dark:text-white">{t('drops.create.title')}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isCreating}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center px-4 pt-3 gap-1">
          {[1, 2, 3].map(s => (
            <div
              key={s}
              className={`flex-1 h-1 rounded-full transition-colors ${
                s <= step ? 'bg-purple-500' : 'bg-gray-200 dark:bg-gray-700'
              }`}
            />
          ))}
        </div>
        <p className="px-4 pt-1 text-xs text-gray-500 dark:text-gray-400">
          {step === 1 ? t('drops.create.step1') : step === 2 ? t('drops.create.step2') : t('drops.create.step3')}
        </p>

        {/* Body */}
        <div className="p-4 max-h-[65vh] overflow-y-auto no-scrollbar">
          {/* ─── Step 1: Content ────────────────────── */}
          {step === 1 && (
            <div className="space-y-4">
              {/* Content Type Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('drops.create.whatToDrop')}
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {CONTENT_TYPES.map(ct => {
                    const Icon = ct.icon;
                    return (
                      <button
                        key={ct.id}
                        type="button"
                        onClick={() => {
                          setContentType(ct.id);
                          clearFile();
                          setError('');
                        }}
                        className={`flex flex-col items-center gap-1 p-3 rounded-xl border-2 transition-all ${
                          contentType === ct.id
                            ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'
                            : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                        <span className="text-xs font-medium">{t(`dropx.type.${ct.id}`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Text Input */}
              {contentType === 'text' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('drops.create.message')}
                  </label>
                  <textarea
                    value={textContent}
                    onChange={(e) => setTextContent(e.target.value)}
                    placeholder={t('drops.create.messagePlaceholder')}
                    data-allow-copy="true"
                    rows={5}
                    maxLength={MAX_TEXT_LENGTH}
                    className="w-full p-3 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm resize-none"
                  />
                  <p className="text-xs text-gray-400 dark:text-gray-500 text-right mt-1">
                    {textContent.length}/{MAX_TEXT_LENGTH}
                  </p>
                </div>
              )}

              {/* File Input */}
              {contentType !== 'text' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {contentType === 'image' ? t('drops.create.selectImage') : contentType === 'audio' ? t('drops.create.selectAudio') : t('drops.create.selectFile')}
                  </label>

                  {/* Drop Zone */}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-6 text-center cursor-pointer hover:border-purple-400 dark:hover:border-purple-500 transition-colors"
                  >
                    {selectedFile ? (
                      <div className="space-y-2">
                        {filePreview && (
                          <img
                            src={filePreview}
                            alt="Preview"
                            className="max-h-32 mx-auto rounded-lg object-contain"
                          />
                        )}
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {selectedFile.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {(selectedFile.size / 1024).toFixed(1)} KB
                        </p>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); clearFile(); }}
                          className="text-xs text-red-500 hover:text-red-600 font-medium"
                        >
                          {t('common.remove')}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <FileUp className="w-8 h-8 text-gray-400 mx-auto" />
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t('drops.create.tapToSelect')}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          {t('drops.create.maxSize', { size: Math.round(maxFileSize / (1024 * 1024)) })}
                        </p>
                      </div>
                    )}
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={getAcceptType()}
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </div>
              )}

              {/* Stego section — only for images */}
              {contentType === 'image' && selectedFile && (
                stegoBlob ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-800/30">
                    <Lock className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
                    <span className="flex-1 text-xs font-bold text-indigo-700 dark:text-indigo-400">{t('drops.create.stegoConfigured')}</span>
                    <button type="button" onClick={() => setShowStegoModal(true)} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">{t('drops.create.stegoReconfigure')}</button>
                    <button type="button" onClick={() => setStegoBlob(null)} className="text-xs text-red-400 hover:text-red-600 font-medium">{t('common.remove')}</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowStegoModal(true)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-indigo-200 dark:border-indigo-700/50 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors"
                  >
                    <Lock className="w-3.5 h-3.5 text-indigo-500" />
                    <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">{t('drops.create.stegoToggle')}</span>
                  </button>
                )
              )}
            </div>
          )}

          {/* ─── Step 2: Recipients ─────────────────── */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1">
                    <Users className="w-4 h-4" />
                    {t('drops.create.whoCanOpen')}
                  </label>
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {recipients.filter(r => r.trim()).length}/{MAX_RECIPIENTS}
                  </span>
                </div>

                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  {t('drops.create.recipientsHint')}
                </p>

                <div className="space-y-2">
                  {recipients.map((username, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <div className="flex-1 relative">
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => updateRecipient(index, e.target.value)}
                          placeholder={`username${index + 1}`}
                          data-allow-copy="true"
                          maxLength={30}
                          className={`w-full px-3 py-2 rounded-lg border text-sm bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:border-transparent ${
                            recipientErrors[index]
                              ? 'border-red-300 dark:border-red-500 focus:ring-red-500'
                              : 'border-gray-200 dark:border-gray-600 focus:ring-purple-500'
                          }`}
                        />
                        {recipientErrors[index] && (
                          <p className="text-xs text-red-500 mt-0.5">{recipientErrors[index]}</p>
                        )}
                      </div>
                      {recipients.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeRecipient(index)}
                          className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {recipients.length < MAX_RECIPIENTS && (
                  <button
                    type="button"
                    onClick={addRecipient}
                    className="mt-2 flex items-center gap-1 text-sm text-purple-500 hover:text-purple-600 font-medium"
                  >
                    <Plus className="w-4 h-4" />
                    {t('drops.create.addRecipient')}
                  </button>
                )}
              </div>

              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800/50">
                <div className="flex items-start gap-2">
                  <Shield className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t('drops.create.recipientNote')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ─── Step 3: Settings ──────────────────── */}
          {step === 3 && (
            <div className="space-y-5">
              {/* TTL */}
              <div>
                <div className="flex items-center gap-1 mb-2">
                  <Clock className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('drops.create.selfDestruct')}
                  </label>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {TTL_OPTIONS.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setTtl(option.value)}
                      className={`py-2 px-1 rounded-lg border-2 text-xs font-medium transition-all ${
                        ttl === option.value
                          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'
                          : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300'
                      }`}
                    >
                      {option.short}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {t('drops.create.selfDestructDesc')}
                </p>
              </div>

              {/* View Once */}
              <div className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2">
                  {viewOnce ? (
                    <EyeOff className="w-4 h-4 text-purple-500" />
                  ) : (
                    <Eye className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{t('drops.create.viewOnce')}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {viewOnce ? t('drops.create.viewOnceOn') : t('drops.create.viewOnceOff')}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setViewOnce(prev => !prev)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    viewOnce ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      viewOnce ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Hint */}
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 block">
                  {t('drops.create.hint')}
                </label>
                <input
                  type="text"
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder={t('drops.create.hintPlaceholder')}
                  data-allow-copy="true"
                  maxLength={100}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {t('drops.create.hintNote')}
                </p>
              </div>

              {/* Summary */}
              <div className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg space-y-1.5 text-xs">
                <p className="font-medium text-gray-700 dark:text-gray-300 text-sm">{t('drops.create.summary')}</p>
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>{t('drops.create.type')}</span>
                  <span className="font-medium">{t(`dropx.type.${contentType}`)}</span>
                </div>
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>{t('drops.create.recipients')}</span>
                  <span className="font-medium">{t('dropx.users', { count: recipients.filter(r => r.trim()).length })}</span>
                </div>
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>{t('drops.create.expires')}</span>
                  <span className="font-medium">{t(`dropx.ttl.${ttl}`)}</span>
                </div>
                <div className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>{t('drops.create.viewOnce')}</span>
                  <span className="font-medium">{viewOnce ? t('common.yes') : t('common.no')}</span>
                </div>
                {contentType !== 'text' && selectedFile && (
                  <div className="flex justify-between text-gray-600 dark:text-gray-400">
                    <span>{t('dropx.fileLabel')}</span>
                    <span className="font-medium truncate ml-4">{selectedFile.name}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800/50 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <button
            type="button"
            onClick={step === 1 ? onClose : prevStep}
            disabled={isCreating}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            {step === 1 ? t('common.cancel') : t('common.back')}
          </button>

          {step < 3 ? (
            <button
              type="button"
              onClick={nextStep}
              className="px-6 py-2 text-sm font-bold bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors"
            >
              {t('common.next')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={isCreating}
              className="px-6 py-2 text-sm font-bold bg-purple-500 hover:bg-purple-600 disabled:bg-purple-300 dark:disabled:bg-purple-800 text-white rounded-lg transition-colors flex items-center gap-2"
            >
              {isCreating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {uploadProgress !== null
                    ? t('dropx.uploading', { pct: uploadProgress, defaultValue: 'Uploading… {{pct}}%' })
                    : t('drops.create.encrypting')}
                </>
              ) : (
                <>
                  <Package className="w-4 h-4" />
                  {t('dropx.createButton')}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {showStegoModal && selectedFile && (
        <StegoModal
          isOpen={showStegoModal}
          onClose={() => setShowStegoModal(false)}
          initialCarrierImage={selectedFile}
          onEmbedResult={(blob) => { setStegoBlob(blob); setShowStegoModal(false); }}
        />
      )}
    </div>
  );
};

export default CreateDropModal;
