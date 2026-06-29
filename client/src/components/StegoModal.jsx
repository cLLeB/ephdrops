import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Lock, Eye, EyeOff, Download, Send, Image as ImageIcon,
  AlertCircle, CheckCircle, FileText, ChevronDown, ChevronUp, File,
} from 'lucide-react';
import { embed, extract, getCapacity } from '../crypto/steganography';

export default function StegoModal({ isOpen, onClose, onSendStego, embedded = false, initialExtractImage = null, onEmbedResult = null, initialCarrierImage = null }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('hide');

  // ── Hide tab state ────────────────────────────────────────────────
  const [carrierFile, setCarrierFile]       = useState(null);
  const [carrierPreview, setCarrierPreview] = useState(null);
  const [capacity, setCapacity]             = useState(null); // { primary, decoy }

  const [secretMode, setSecretMode]         = useState('text'); // 'text' | 'file'
  const [secretText, setSecretText]         = useState('');
  const [secretFile, setSecretFile]         = useState(null);

  const [hidePassphrase, setHidePassphrase] = useState('');
  const [showHidePass, setShowHidePass]     = useState(false);

  const [showDecoy, setShowDecoy]           = useState(false);
  const [decoyMode, setDecoyMode]           = useState('text'); // 'text' | 'file'
  const [decoyText, setDecoyText]           = useState('');
  const [decoyFile, setDecoyFile]           = useState(null);
  const [decoyPassphrase, setDecoyPassphrase] = useState('');
  const [showDecoyPass, setShowDecoyPass]   = useState(false);

  const [isEmbedding, setIsEmbedding]       = useState(false);
  const [embedResult, setEmbedResult]       = useState(null);
  const [embedError, setEmbedError]         = useState(null);

  // ── Extract tab state ─────────────────────────────────────────────
  const [extractFile, setExtractFile]         = useState(null);
  const [extractPreview, setExtractPreview]   = useState(null);
  const [extractPassphrase, setExtractPassphrase] = useState('');
  const [showExtractPass, setShowExtractPass] = useState(false);
  const [isExtracting, setIsExtracting]       = useState(false);
  const [extractResult, setExtractResult]     = useState(null);
  // extractResult: null | 'not-found' | 'error'
  //              | { type: 'text', text: string }
  //              | { type: 'file', name: string, url: string }

  const hideFileRef    = useRef(null);
  const secretFileRef  = useRef(null);
  const decoyFileRef   = useRef(null);
  const extractFileRef = useRef(null);
  const submitTimerRef = useRef(null);

  // Pre-load a carrier image and switch to hide tab
  useEffect(() => {
    if (!initialCarrierImage) return;
    if (carrierPreview) URL.revokeObjectURL(carrierPreview);
    setCarrierFile(initialCarrierImage);
    setCarrierPreview(URL.createObjectURL(initialCarrierImage));
    setEmbedResult(null);
    setEmbedError(null);
    setCapacity(null);
    setTab('hide');
    getCapacity(initialCarrierImage).then(cap => setCapacity(cap)).catch(() => {});
  }, [initialCarrierImage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to extract when a received image is passed in
  useEffect(() => {
    if (!initialExtractImage) return;
    if (extractPreview) URL.revokeObjectURL(extractPreview);
    setExtractFile(initialExtractImage);
    setExtractPreview(URL.createObjectURL(initialExtractImage));
    setExtractResult(null);
    setTab('extract');
  }, [initialExtractImage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke file result URL on unmount / change
  useEffect(() => {
    return () => {
      if (extractResult?.type === 'file' && extractResult.url) {
        URL.revokeObjectURL(extractResult.url);
      }
    };
  }, [extractResult]);

  const reset = () => {
    setTab('hide');
    setCarrierFile(null);
    if (carrierPreview) URL.revokeObjectURL(carrierPreview);
    setCarrierPreview(null);
    setCapacity(null);
    setSecretMode('text');
    setSecretText('');
    setSecretFile(null);
    setHidePassphrase('');
    setShowHidePass(false);
    setShowDecoy(false);
    setDecoyMode('text');
    setDecoyText('');
    setDecoyFile(null);
    setDecoyPassphrase('');
    setShowDecoyPass(false);
    setIsEmbedding(false);
    setEmbedResult(null);
    setEmbedError(null);
    setExtractFile(null);
    if (extractPreview) URL.revokeObjectURL(extractPreview);
    setExtractPreview(null);
    setExtractPassphrase('');
    setShowExtractPass(false);
    setIsExtracting(false);
    if (extractResult?.type === 'file' && extractResult.url) URL.revokeObjectURL(extractResult.url);
    setExtractResult(null);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleCarrierSelect = async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (carrierPreview) URL.revokeObjectURL(carrierPreview);
    setCarrierFile(file);
    setCarrierPreview(URL.createObjectURL(file));
    setEmbedResult(null);
    setEmbedError(null);
    setCapacity(null);
    try {
      const cap = await getCapacity(file);
      setCapacity(cap);
    } catch { /* ignore */ }
  };

  const handleExtractSelect = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (extractPreview) URL.revokeObjectURL(extractPreview);
    setExtractFile(file);
    setExtractPreview(URL.createObjectURL(file));
    if (extractResult?.type === 'file' && extractResult.url) URL.revokeObjectURL(extractResult.url);
    setExtractResult(null);
  };

  const handleEmbed = async () => {
    const secret = secretMode === 'text' ? secretText.trim() : secretFile;
    if (!carrierFile || !secret || !hidePassphrase.trim()) return;
    setIsEmbedding(true);
    setEmbedResult(null);
    setEmbedError(null);
    try {
      const decoySecret = decoyMode === 'text' ? decoyText.trim() : decoyFile;
      const opts = showDecoy && decoySecret && decoyPassphrase.trim()
        ? { decoySecret, decoyPassphrase: decoyPassphrase.trim() }
        : {};
      const blob = await embed(carrierFile, secret, hidePassphrase.trim(), opts);
      setEmbedResult(blob);
    } catch (err) {
      setEmbedError(err.message || 'Embedding failed');
    }
    setIsEmbedding(false);
  };

  const handleExtract = async () => {
    if (!extractFile || !extractPassphrase.trim()) return;
    setIsExtracting(true);
    if (extractResult?.type === 'file' && extractResult.url) URL.revokeObjectURL(extractResult.url);
    setExtractResult(null);
    try {
      const result = await extract(extractFile, extractPassphrase.trim());
      if (result === null) {
        setExtractResult('not-found');
      } else if (result.type === 'file') {
        setExtractResult({ type: 'file', name: result.name, url: URL.createObjectURL(result.blob) });
      } else {
        setExtractResult(result);
      }
    } catch {
      setExtractResult('error');
    }
    setIsExtracting(false);
  };

  const handleDownloadStego = () => {
    if (!embedResult) return;
    const url = URL.createObjectURL(embedResult);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stego_${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSend = () => {
    if (!embedResult || !onSendStego) return;
    onSendStego(embedResult);
    handleClose();
  };

  const formatCapacity = (bytes) => {
    if (bytes <= 0) return '0 chars';
    if (bytes >= 1024) return `~${(bytes / 1024).toFixed(1)} KB`;
    return `~${bytes} chars`;
  };

  const canEmbed = !isEmbedding && carrierFile && hidePassphrase.trim() &&
    (secretMode === 'text' ? secretText.trim() : secretFile);

  if (!isOpen && !embedded) return null;

  return (
    <div
      className={embedded
        ? 'w-full h-full overflow-auto'
        : 'fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4'}
      onClick={embedded ? undefined : e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className={embedded
        ? 'w-full h-full flex flex-col overflow-hidden'
        : 'w-full sm:w-[480px] bg-white dark:bg-gray-900 rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200'}
      >

        {/* Header */}
        {!embedded && (
          <div className="flex items-center gap-3 px-5 pt-5 pb-0">
            <div className="p-2 rounded-xl bg-indigo-100 dark:bg-indigo-900/40">
              <Lock className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-black text-gray-900 dark:text-white">{t('stego.title')}</h2>
              <p className="text-[10px] text-gray-400">{t('stego.subtitle')}</p>
            </div>
            <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className={embedded
          ? 'flex gap-px bg-white/[0.04] flex-shrink-0'
          : 'flex gap-1 mx-5 mt-4 bg-gray-100 dark:bg-gray-800 rounded-xl p-1'}
        >
          {['hide', 'extract'].map(tabKey => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={embedded
                ? `flex-1 py-3 text-xs font-bold tracking-wide transition-colors ${tab === tabKey ? 'text-emerald-300 border-b-2 border-emerald-500' : 'text-gray-500 hover:text-gray-300'}`
                : `flex-1 py-2 rounded-lg text-xs font-bold transition-all ${tab === tabKey ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
            >
              {tabKey === 'hide' ? t('stego.hideTab') : t('stego.extractTab')}
            </button>
          ))}
        </div>

        <div className={embedded ? 'flex-1 overflow-y-auto px-5 py-4 space-y-3' : 'px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto'}>
          {tab === 'hide' ? (
            <>
              {/* Carrier image */}
              <div>
                <label className="block text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                  {t('stego.carrierImageLabel')}
                </label>
                <input ref={hideFileRef} type="file" accept="image/*" className="hidden" onChange={e => handleCarrierSelect(e.target.files?.[0])} />
                {carrierPreview ? (
                  <div
                    className="relative rounded-xl overflow-hidden aspect-video bg-gray-100 dark:bg-gray-800 cursor-pointer group"
                    onClick={() => hideFileRef.current?.click()}
                  >
                    <img src={carrierPreview} alt="Carrier" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="text-white text-xs font-bold">{t('stego.changeImage')}</span>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => hideFileRef.current?.click()}
                    className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl py-6 flex flex-col items-center gap-2 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors group"
                  >
                    <ImageIcon className="w-6 h-6 text-gray-300 dark:text-gray-600 group-hover:text-indigo-400 transition-colors" />
                    <span className="text-xs text-gray-400">{t('stego.tapToPickImage')}</span>
                  </button>
                )}

                {/* Capacity meter */}
                {capacity && (
                  <p className="text-[10px] text-indigo-500 dark:text-indigo-400 mt-1.5 font-medium">
                    {t('stego.capacityInfo', {
                      primary: formatCapacity(capacity.primary),
                      decoy: formatCapacity(capacity.decoy),
                    })}
                  </p>
                )}
              </div>

              {/* Secret type toggle */}
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
                {['text', 'file'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => setSecretMode(mode)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all
                      ${secretMode === mode ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
                  >
                    {mode === 'text' ? <FileText className="w-3 h-3" /> : <File className="w-3 h-3" />}
                    {mode === 'text' ? t('stego.secretTypeText') : t('stego.secretTypeFile')}
                  </button>
                ))}
              </div>

              {/* Secret input */}
              {secretMode === 'text' ? (
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                    {t('stego.secretMessageLabel')}
                  </label>
                  <textarea
                    value={secretText}
                    onChange={e => setSecretText(e.target.value)}
                    placeholder={t('stego.secretPlaceholder')}
                    rows={3}
                    className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 px-3 py-2.5 outline-none focus:ring-2 focus:ring-indigo-400/40 resize-none"
                  />
                  {capacity && secretText.length > 0 && secretText.length > capacity.primary && (
                    <p className="text-[10px] text-amber-500 mt-1">
                      {t('stego.messageTooLong', { max: capacity.primary })}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                    {t('stego.fileLabel')}
                  </label>
                  <input ref={secretFileRef} type="file" className="hidden" onChange={e => setSecretFile(e.target.files?.[0] || null)} />
                  {secretFile ? (
                    <div
                      className="flex items-center gap-2 p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 cursor-pointer hover:border-indigo-400 transition-colors"
                      onClick={() => secretFileRef.current?.click()}
                    >
                      <File className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-gray-800 dark:text-gray-200 truncate">{secretFile.name}</p>
                        <p className="text-[10px] text-gray-400">{(secretFile.size / 1024).toFixed(1)} KB — {t('stego.tapToChange')}</p>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => secretFileRef.current?.click()}
                      className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl py-4 flex flex-col items-center gap-2 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors group"
                    >
                      <File className="w-5 h-5 text-gray-300 dark:text-gray-600 group-hover:text-indigo-400 transition-colors" />
                      <span className="text-xs text-gray-400">{t('stego.tapToPickFile')}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Passphrase */}
              <div>
                <label className="block text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                  {t('stego.passphraseLabel')}
                </label>
                <div className="flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2.5 focus-within:ring-2 focus-within:ring-indigo-400/40">
                  <input
                    type={showHidePass ? 'text' : 'password'}
                    value={hidePassphrase}
                    onChange={e => setHidePassphrase(e.target.value)}
                    placeholder={t('stego.hidePassphrasePlaceholder')}
                    className="flex-1 bg-transparent text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 outline-none"
                  />
                  <button type="button" onClick={() => setShowHidePass(p => !p)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                    {showHidePass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-1">{t('stego.passphraseHint')}</p>
              </div>

              {/* Plausible deniability toggle */}
              <button
                onClick={() => setShowDecoy(p => !p)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 hover:border-indigo-400 dark:hover:border-indigo-600 transition-colors"
              >
                <span className="text-xs font-bold text-gray-500 dark:text-gray-400">
                  {t('stego.decoyToggle')}
                </span>
                {showDecoy
                  ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                  : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
              </button>

              {showDecoy && (
                <div className="space-y-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30">
                  <p className="text-[10px] text-amber-700 dark:text-amber-400 font-medium">
                    {t('stego.decoyHint')}
                  </p>
                  {/* Decoy type toggle */}
                  <div className="flex gap-1 bg-amber-100/60 dark:bg-amber-900/20 rounded-xl p-1">
                    {['text', 'file'].map(mode => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setDecoyMode(mode)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all
                          ${decoyMode === mode ? 'bg-white dark:bg-gray-700 text-amber-700 dark:text-amber-300 shadow-sm' : 'text-amber-500/80 hover:text-amber-700 dark:hover:text-amber-300'}`}
                      >
                        {mode === 'text' ? <FileText className="w-3 h-3" /> : <File className="w-3 h-3" />}
                        {mode === 'text' ? t('stego.secretTypeText') : t('stego.secretTypeFile')}
                      </button>
                    ))}
                  </div>

                  {decoyMode === 'text' ? (
                    <div>
                      <label className="block text-[10px] font-bold text-amber-700 dark:text-amber-500 uppercase tracking-wider mb-1.5">
                        {t('stego.decoyMessageLabel')}
                      </label>
                      <textarea
                        value={decoyText}
                        onChange={e => setDecoyText(e.target.value)}
                        placeholder={t('stego.decoyPlaceholder')}
                        rows={2}
                        className="w-full rounded-xl border border-amber-200 dark:border-amber-700/50 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 px-3 py-2 outline-none focus:ring-2 focus:ring-amber-400/40 resize-none"
                      />
                      {capacity && decoyText.length > 0 && decoyText.length > capacity.decoy && (
                        <p className="text-[10px] text-amber-500 mt-1">
                          {t('stego.messageTooLong', { max: capacity.decoy })}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div>
                      <label className="block text-[10px] font-bold text-amber-700 dark:text-amber-500 uppercase tracking-wider mb-1.5">
                        {t('stego.fileLabel')}
                      </label>
                      <input ref={decoyFileRef} type="file" className="hidden" onChange={e => setDecoyFile(e.target.files?.[0] || null)} />
                      {decoyFile ? (
                        <div
                          className="flex items-center gap-2 p-3 rounded-xl border border-amber-200 dark:border-amber-700/50 bg-white dark:bg-gray-800 cursor-pointer hover:border-amber-400 transition-colors"
                          onClick={() => decoyFileRef.current?.click()}
                        >
                          <File className="w-4 h-4 text-amber-500 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-gray-800 dark:text-gray-200 truncate">{decoyFile.name}</p>
                            <p className="text-[10px] text-gray-400">{(decoyFile.size / 1024).toFixed(1)} KB — {t('stego.tapToChange')}</p>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => decoyFileRef.current?.click()}
                          className="w-full border-2 border-dashed border-amber-200 dark:border-amber-700/50 rounded-xl py-4 flex flex-col items-center gap-2 hover:border-amber-400 dark:hover:border-amber-500 transition-colors group"
                        >
                          <File className="w-5 h-5 text-amber-300 dark:text-amber-600 group-hover:text-amber-400 transition-colors" />
                          <span className="text-xs text-gray-400">{t('stego.tapToPickFile')}</span>
                        </button>
                      )}
                      {capacity && decoyFile && decoyFile.size > capacity.decoy && (
                        <p className="text-[10px] text-amber-500 mt-1">
                          {t('stego.messageTooLong', { max: capacity.decoy })}
                        </p>
                      )}
                    </div>
                  )}
                  <div>
                    <label className="block text-[10px] font-bold text-amber-700 dark:text-amber-500 uppercase tracking-wider mb-1.5">
                      {t('stego.decoyPassphraseLabel')}
                    </label>
                    <div className="flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-700/50 bg-white dark:bg-gray-800 px-3 py-2 focus-within:ring-2 focus-within:ring-amber-400/40">
                      <input
                        type={showDecoyPass ? 'text' : 'password'}
                        value={decoyPassphrase}
                        onChange={e => setDecoyPassphrase(e.target.value)}
                        placeholder={t('stego.decoyPassphrasePlaceholder')}
                        className="flex-1 bg-transparent text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 outline-none"
                      />
                      <button type="button" onClick={() => setShowDecoyPass(p => !p)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                        {showDecoyPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Embed error */}
              {embedError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-xl">
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                  <p className="text-xs text-red-700 dark:text-red-400 font-medium">{embedError}</p>
                </div>
              )}

              {/* Embed / result */}
              {!embedResult ? (
                <button
                  onClick={handleEmbed}
                  disabled={!canEmbed}
                  className="w-full py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold disabled:opacity-40 hover:bg-indigo-700 transition-colors active:scale-95"
                >
                  {isEmbedding ? t('stego.embedding') : t('stego.embedButton')}
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                    <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">{t('stego.embedSuccess')}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDownloadStego}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-bold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {t('stego.savePng')}
                    </button>
                    {onSendStego && (
                      <button
                        onClick={handleSend}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition-colors active:scale-95"
                      >
                        <Send className="w-3.5 h-3.5" />
                        {t('stego.sendButton')}
                      </button>
                    )}
                    {onEmbedResult && (
                      <button
                        onClick={() => { onEmbedResult(embedResult); handleClose(); }}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors active:scale-95"
                      >
                        <CheckCircle className="w-3.5 h-3.5" />
                        {t('stego.useThisImage')}
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => { setEmbedResult(null); setEmbedError(null); }}
                    className="w-full text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors py-1"
                  >
                    {t('stego.startOver')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Extract: image picker */}
              <div>
                <label className="block text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                  {t('stego.stegoImageLabel')}
                </label>
                <input ref={extractFileRef} type="file" accept="image/*" className="hidden" onChange={e => handleExtractSelect(e.target.files?.[0])} />
                {extractPreview ? (
                  <div
                    className="relative rounded-xl overflow-hidden aspect-video bg-gray-100 dark:bg-gray-800 cursor-pointer group"
                    onClick={() => extractFileRef.current?.click()}
                  >
                    <img src={extractPreview} alt="Stego" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="text-white text-xs font-bold">{t('stego.changeImage')}</span>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => extractFileRef.current?.click()}
                    className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl py-6 flex flex-col items-center gap-2 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors group"
                  >
                    <ImageIcon className="w-6 h-6 text-gray-300 dark:text-gray-600 group-hover:text-indigo-400 transition-colors" />
                    <span className="text-xs text-gray-400">{t('stego.tapToPickStego')}</span>
                  </button>
                )}
              </div>

              {/* Passphrase */}
              <div>
                <label className="block text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5">
                  {t('stego.passphraseLabel')}
                </label>
                <div className="flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2.5 focus-within:ring-2 focus-within:ring-indigo-400/40">
                  <input
                    type={showExtractPass ? 'text' : 'password'}
                    value={extractPassphrase}
                    onChange={e => setExtractPassphrase(e.target.value)}
                    placeholder={t('stego.extractPassphrasePlaceholder')}
                    onKeyDown={e => { if (e.key === 'Enter') handleExtract(); }}
                    className="flex-1 bg-transparent text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 outline-none"
                  />
                  <button type="button" onClick={() => setShowExtractPass(p => !p)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                    {showExtractPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                onClick={handleExtract}
                disabled={isExtracting || !extractFile || !extractPassphrase.trim()}
                className="w-full py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold disabled:opacity-40 hover:bg-indigo-700 transition-colors active:scale-95"
              >
                {isExtracting ? t('stego.extracting') : t('stego.extractButton')}
              </button>

              {extractResult !== null && (
                <div className={`p-3 rounded-xl ${extractResult === 'not-found' || extractResult === 'error' ? 'bg-red-50 dark:bg-red-900/20' : 'bg-emerald-50 dark:bg-emerald-900/20'}`}>
                  {extractResult === 'not-found' || extractResult === 'error' ? (
                    <div className="flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                      <p className="text-xs text-red-700 dark:text-red-400 font-medium">
                        {extractResult === 'not-found' ? t('stego.notFound') : t('stego.extractFailed')}
                      </p>
                    </div>
                  ) : extractResult.type === 'text' ? (
                    <div className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide mb-1">{t('stego.hiddenRevealed')}</p>
                        <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">{extractResult.text}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide mb-0.5">{t('stego.hiddenFileRevealed')}</p>
                        <p className="text-xs text-gray-700 dark:text-gray-300 truncate font-medium">{extractResult.name}</p>
                      </div>
                      <a
                        href={extractResult.url}
                        download={extractResult.name}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition-colors flex-shrink-0"
                      >
                        <Download className="w-3 h-3" />
                        {t('stego.downloadFile')}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="pb-safe-area-inset-bottom h-4" />
      </div>
    </div>
  );
}
