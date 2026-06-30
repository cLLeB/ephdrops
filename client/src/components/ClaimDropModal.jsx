import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Package, KeyRound, Hash, MessageSquare, FileUp,
  Loader2, AlertTriangle, ArrowRight, Shield, Upload
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { hapticSuccess, hapticError } from '../utils/platform';
import {
  getDropInfoAPI, claimDropAPI, resolveVerbalCodeAPI, hashUsername,
  decryptHint, unwrapMasterKey, deriveWrappingKey,
} from '../utils/drops';
import {
  parseEphFile, validateEphFile, handleEphFileInput, EPH_EXTENSION,
} from '../utils/eph-file';

// ─── Component ────────────────────────────────────────────

const ClaimDropModal = ({ onClose, onDropClaimed, initialDropId, initialVerbalCode }) => {
  const { t } = useTranslation();
  const { theme } = useTheme();

  // Input method: 'id' | 'verbal' | 'eph'
  const [inputMethod, setInputMethod] = useState(
    initialDropId ? 'id' : initialVerbalCode ? 'verbal' : 'id'
  );

  // Inputs
  const [dropId, setDropId] = useState(initialDropId || '');
  const [verbalCode, setVerbalCode] = useState(initialVerbalCode || '');
  const [ephFile, setEphFile] = useState(null);
  const [ephPacket, setEphPacket] = useState(null);
  const [username, setUsername] = useState('');
  const ephInputRef = useRef(null);

  // State
  const [step, setStep] = useState(1); // 1: identify drop, 2: enter username
  const [dropInfo, setDropInfo] = useState(null);
  const [resolvedDropId, setResolvedDropId] = useState(initialDropId || '');
  const [isLoading, setIsLoading] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [error, setError] = useState('');

  // Auto-resolve if initialDropId is provided
  useEffect(() => {
    if (initialDropId) {
      lookupDrop(initialDropId);
    }
  }, [initialDropId]);

  // ─── Drop Lookup ────────────────────────────────────────

  const lookupDrop = async (id) => {
    if (!id) return;
    setIsLoading(true);
    setError('');

    try {
      const response = await getDropInfoAPI(id);
      // Server returns { success: true, drop: {...} } — store the full response
      setDropInfo(response);
      setResolvedDropId(id);
      setStep(2);
      hapticSuccess();
    } catch (err) {
      setError(err.message || t('dropx.err.notFoundExpired'));
      hapticError();
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Step 1: Resolve Drop ──────────────────────────────

  const handleResolve = async () => {
    setError('');

    if (inputMethod === 'id') {
      const trimmed = dropId.trim();
      if (!trimmed) {
        setError(t('dropx.err.enterDropId'));
        return;
      }
      await lookupDrop(trimmed);

    } else if (inputMethod === 'verbal') {
      const trimmed = verbalCode.trim().toLowerCase();
      if (!trimmed) {
        setError(t('dropx.err.enterVerbal'));
        return;
      }

      const words = trimmed.split(/\s+/).filter(w => w.length > 0);
      if (words.length !== 4) {
        setError(t('dropx.err.verbal4Words'));
        return;
      }

      setIsLoading(true);
      try {
        const result = await resolveVerbalCodeAPI(trimmed);
        await lookupDrop(result.dropId);
      } catch (err) {
        setError(err.message || t('dropx.err.invalidVerbal'));
        hapticError();
        setIsLoading(false);
      }

    } else if (inputMethod === 'eph') {
      if (!ephPacket) {
        setError(t('dropx.err.validEph'));
        return;
      }

      setIsLoading(true);
      try {
        const validated = await validateEphFile(ephPacket);
        await lookupDrop(validated.dropId);
      } catch (err) {
        setError(err.message || t('dropx.err.invalidEph'));
        hapticError();
        setIsLoading(false);
      }
    }
  };

  // ─── Step 2: Claim ──────────────────────────────────────

  const handleClaim = async () => {
    const trimmedUsername = username.trim().toLowerCase();

    if (!trimmedUsername) {
      setError(t('dropx.err.enterUsername'));
      return;
    }
    if (trimmedUsername.length < 2) {
      setError(t('dropx.err.usernameMin'));
      return;
    }

    setIsClaiming(true);
    setError('');

    try {
      // Get the salt from the drop info to hash the username
      const salt = dropInfo?.drop?.salt || dropInfo?.salt;
      if (!salt) {
        throw new Error('Missing drop salt — cannot authenticate');
      }

      // Hash username with salt (matches how the creator hashed it)
      const usernameHash = await hashUsername(trimmedUsername, salt);

      const result = await claimDropAPI(resolvedDropId, usernameHash);

      // Decrypt hint if present — requires masterKey (unwrapped after auth)
      let decryptedHint = null;
      const encryptedHint = dropInfo?.drop?.encryptedHint || ephPacket?.encryptedHint;
      if (encryptedHint && result.wrappedKey) {
        try {
          const wrappingKey = await deriveWrappingKey(trimmedUsername, salt);
          const masterKey = await unwrapMasterKey(result.wrappedKey, wrappingKey);
          decryptedHint = await decryptHint(encryptedHint, masterKey);
        } catch {
          // Hint decryption failure is non-fatal
        }
      }

      hapticSuccess();
      onDropClaimed({
        dropId: resolvedDropId,
        username: trimmedUsername,
        salt, // pass salt for decryption
        hint: decryptedHint,
        ...result,
      });
    } catch (err) {
      setError(err.message || t('dropx.err.claimFailed'));
      hapticError();
    } finally {
      setIsClaiming(false);
    }
  };

  // ─── .eph File Handling ─────────────────────────────────

  const handleEphFileChange = useCallback(async (e) => {
    setError('');
    setEphPacket(null);

    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(EPH_EXTENSION)) {
      setError(t('dropx.err.validEph'));
      return;
    }

    setEphFile(file);

    try {
      const packet = await parseEphFile(file);
      setEphPacket(packet);
    } catch (err) {
      setError(err.message || t('dropx.err.parseEphFailed'));
      setEphFile(null);
    }
  }, []);

  // ─── Drag & Drop for .eph ──────────────────────────────

  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);
    setError('');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (!file.name.endsWith(EPH_EXTENSION)) {
      setError(t('dropx.err.validEph'));
      return;
    }

    setEphFile(file);
    try {
      const packet = await parseEphFile(file);
      setEphPacket(packet);
    } catch (err) {
      setError(err.message || t('dropx.err.parseEphFailed'));
      setEphFile(null);
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
            <h2 className="text-lg font-bold dark:text-white">{t('drops.claim.title')}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isClaiming}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 max-h-[65vh] overflow-y-auto no-scrollbar">
          {/* ─── Step 1: Identify Drop ────────────── */}
          {step === 1 && (
            <div className="space-y-4">
              {/* Method Tabs */}
              <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                {[
                  { id: 'id', label: 'Drop ID', icon: Hash },
                  { id: 'verbal', label: 'Verbal', icon: MessageSquare },
                  { id: 'eph', label: '.eph File', icon: FileUp },
                ].map(method => {
                  const Icon = method.icon;
                  return (
                    <button
                      key={method.id}
                      type="button"
                      onClick={() => { setInputMethod(method.id); setError(''); }}
                      className={`flex-1 flex items-center justify-center gap-1 py-2.5 text-xs font-medium transition-colors ${
                        inputMethod === method.id
                          ? 'bg-purple-500 text-white'
                          : 'bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {method.label}
                    </button>
                  );
                })}
              </div>

              {/* Drop ID Input */}
              {inputMethod === 'id' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('drops.claim.dropIdLabel')}
                  </label>
                  <input
                    type="text"
                    value={dropId}
                    onChange={(e) => setDropId(e.target.value.trim())}
                    placeholder={t('drops.claim.dropIdPlaceholder')}
                    data-allow-copy="true"
                    className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm font-mono"
                    onKeyDown={(e) => e.key === 'Enter' && handleResolve()}
                  />
                </div>
              )}

              {/* Verbal Code Input */}
              {inputMethod === 'verbal' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('drops.claim.verbalLabel')}
                  </label>
                  <input
                    type="text"
                    value={verbalCode}
                    onChange={(e) => setVerbalCode(e.target.value)}
                    placeholder={t('drops.claim.verbalPlaceholder')}
                    data-allow-copy="true"
                    className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                    onKeyDown={(e) => e.key === 'Enter' && handleResolve()}
                  />
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {t('drops.claim.verbalHint')}
                  </p>
                </div>
              )}

              {/* .eph File Input */}
              {inputMethod === 'eph' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('drops.claim.uploadLabel')}
                  </label>
                  <div
                    onClick={() => ephInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                      isDragOver
                        ? 'border-purple-400 bg-purple-50 dark:bg-purple-900/20'
                        : ephPacket
                          ? 'border-green-300 dark:border-green-600 bg-green-50 dark:bg-green-900/20'
                          : 'border-gray-300 dark:border-gray-600 hover:border-purple-400'
                    }`}
                  >
                    {ephPacket ? (
                      <div className="space-y-1">
                        <Shield className="w-8 h-8 text-green-500 mx-auto" />
                        <p className="text-sm font-medium text-green-700 dark:text-green-300">
                          {ephFile?.name || 'Valid .eph file'}
                        </p>
                        {ephPacket.encryptedHint && (
                          <p className="text-xs text-green-600 dark:text-green-400">
                            {t('drops.claim.hintAfterAuth')}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEphFile(null);
                            setEphPacket(null);
                            if (ephInputRef.current) ephInputRef.current.value = '';
                          }}
                          className="text-xs text-red-500 hover:text-red-600 font-medium"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Upload className="w-8 h-8 text-gray-400 mx-auto" />
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t('drops.claim.tapToSelect')}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          {t('drops.claim.acceptsEph')}
                        </p>
                      </div>
                    )}
                  </div>
                  <input
                    ref={ephInputRef}
                    type="file"
                    accept=".eph,application/x-ephemeral-drop"
                    onChange={handleEphFileChange}
                    className="hidden"
                  />
                </div>
              )}
            </div>
          )}

          {/* ─── Step 2: Enter Username ───────────── */}
          {step === 2 && (
            <div className="space-y-4">
              {/* Drop Info Card */}
              {dropInfo?.drop && (
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-100 dark:border-purple-800/50">
                  <p className="text-xs font-medium text-purple-700 dark:text-purple-300 mb-1">
                    {t('drops.claim.dropFound')}
                  </p>
                  {dropInfo.drop.encryptedHint && (
                    <p className="text-sm text-purple-600 dark:text-purple-400 mb-1">
                      {t('drops.claim.hintAfterAuth')}
                    </p>
                  )}
                  <div className="flex items-center gap-3 text-xs text-purple-600 dark:text-purple-400">
                    <span>Type: {dropInfo.drop.contentType || 'unknown'}</span>
                    <span>•</span>
                    <span>For: {dropInfo.drop.recipientCount} user{dropInfo.drop.recipientCount !== 1 ? 's' : ''}</span>
                    {dropInfo.drop.viewOnce && (
                      <>
                        <span>•</span>
                        <span className="font-medium">{t('drops.claim.viewOnce')}</span>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Username Input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 flex items-center gap-1">
                  <KeyRound className="w-4 h-4" />
                  {t('drops.claim.usernameLabel')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  {t('drops.claim.usernameDesc')}
                </p>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''));
                    setError('');
                  }}
                  placeholder={t('drops.claim.usernamePlaceholder')}
                  data-allow-copy="true"
                  maxLength={30}
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && handleClaim()}
                />
              </div>

              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800/50">
                <div className="flex items-start gap-2">
                  <Shield className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t('drops.claim.usernameNote')}
                  </p>
                </div>
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
            onClick={step === 1 ? onClose : () => { setStep(1); setError(''); setDropInfo(null); }}
            disabled={isClaiming}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            {step === 1 ? t('common.cancel') : t('common.back')}
          </button>

          {step === 1 ? (
            <button
              type="button"
              onClick={handleResolve}
              disabled={isLoading}
              className="px-6 py-2 text-sm font-bold bg-purple-500 hover:bg-purple-600 disabled:bg-purple-300 dark:disabled:bg-purple-800 text-white rounded-lg transition-colors flex items-center gap-2"
            >
              {isLoading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> {t('drops.claim.lookingUp')}</>
              ) : (
                <><ArrowRight className="w-4 h-4" /> {t('drops.claim.findDrop')}</>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleClaim}
              disabled={isClaiming || !username.trim()}
              className="px-6 py-2 text-sm font-bold bg-purple-500 hover:bg-purple-600 disabled:bg-purple-300 dark:disabled:bg-purple-800 text-white rounded-lg transition-colors flex items-center gap-2"
            >
              {isClaiming ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> {t('drops.claim.decrypting')}</>
              ) : (
                <><KeyRound className="w-4 h-4" /> {t('drops.claim.claimDecrypt')}</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ClaimDropModal;
