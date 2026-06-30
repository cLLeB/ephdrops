import React, { useState } from 'react';
import { Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isMobile, isCapacitor } from '../utils/platform';

const STORAGE_KEY = 'mobileLargeNoteDismissed';

/**
 * One-time dismissible heads-up shown only on phones, on the claim/receive
 * surface: very large drops can exceed a mobile WebView's memory and fail to
 * open. Informational only — there is no size cap. Dismissal is remembered.
 */
export default function MobileLargeDropNote() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (!(isMobile || isCapacitor) || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore storage errors */
    }
    setDismissed(true);
  };

  return (
    <div className="mb-4 flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
      <Info className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
      <p className="text-xs text-amber-700 dark:text-amber-300 flex-1 leading-relaxed">
        {t(
          'dropx.mobileLargeNote',
          'Very large drops (hundreds of MB) may not open on a phone due to memory limits. Use a computer for big files.'
        )}
      </p>
      <button
        onClick={dismiss}
        aria-label={t('common.close', 'Close')}
        className="p-0.5 text-amber-500 hover:text-amber-700 dark:hover:text-amber-200 shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
