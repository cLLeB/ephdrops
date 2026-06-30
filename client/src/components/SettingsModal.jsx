import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Sun, Moon, Monitor, Languages, Info, Check, Vibrate, ExternalLink, Shield,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import i18n, { LANGUAGES, applyDocumentDir } from '../i18n/index.js';
import { openExternal } from '../utils/share';
import { hapticLight, hapticSuccess, areHapticsEnabled, setHapticsEnabled } from '../utils/platform';

const APP_VERSION = '1.0.0';
const WEBSITE_URL = 'https://beternow-ephdrops.hf.space';

/**
 * Settings sheet: theme, language, haptics, and an About section.
 *
 * Bottom-sheet on mobile, centered modal on desktop — matching ShareSheet.
 * Everything here persists to localStorage and applies immediately.
 */
const SettingsModal = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [currentLang, setCurrentLang] = useState(i18n.language);
  const [haptics, setHaptics] = useState(areHapticsEnabled());

  if (!isOpen) return null;

  const themeOptions = [
    { value: 'light', label: t('settings.appearance.light', 'Light'), Icon: Sun },
    { value: 'dark', label: t('settings.appearance.dark', 'Dark'), Icon: Moon },
    { value: 'system', label: t('settings.appearance.system', 'System'), Icon: Monitor },
  ];

  const handleThemeChange = (value) => {
    hapticLight();
    setTheme(value);
  };

  const handleLanguageChange = async (code) => {
    hapticSuccess();
    await i18n.changeLanguage(code);
    localStorage.setItem('app_language', code);
    applyDocumentDir(code);
    setCurrentLang(code);
  };

  const handleHapticsToggle = () => {
    const next = !haptics;
    setHaptics(next);
    setHapticsEnabled(next);
    if (next) hapticSuccess();
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center p-0 sm:p-4 z-[70]"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-white dark:bg-gray-800 flex justify-between items-center px-6 py-4 border-b border-gray-100 dark:border-gray-700 z-10">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('settings.title', 'Settings')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="p-1 text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-7">
          {/* ── Appearance ── */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-3">
              {t('settings.appearance.title', 'Appearance')}
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {themeOptions.map(({ value, label, Icon }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    onClick={() => handleThemeChange(value)}
                    className={`flex flex-col items-center gap-2 py-3 rounded-xl border transition-colors ${
                      active
                        ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs font-medium">{label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── Language ── */}
          <section>
            <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-3">
              <Languages className="w-3.5 h-3.5" />
              {t('settings.language.title', 'Language')}
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {LANGUAGES.map((lang) => {
                const active = currentLang === lang.code;
                return (
                  <button
                    key={lang.code}
                    onClick={() => handleLanguageChange(lang.code)}
                    dir={lang.dir}
                    className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                      active
                        ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/30'
                        : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">
                        {lang.nativeName}
                      </span>
                      <span className="block text-[11px] text-gray-500 dark:text-gray-400 truncate">
                        {lang.name}
                      </span>
                    </span>
                    {active && <Check className="w-4 h-4 text-purple-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── Preferences ── */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-3">
              {t('settings.preferences', 'Preferences')}
            </h4>
            <button
              onClick={handleHapticsToggle}
              className="w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
            >
              <span className="flex items-center gap-3">
                <Vibrate className="w-5 h-5 text-purple-500" />
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {t('settings.haptics', 'Haptic feedback')}
                </span>
              </span>
              <span
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  haptics ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    haptics ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </span>
            </button>
          </section>

          {/* ── About ── */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-3">
              {t('settings.about.title', 'About')}
            </h4>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <img src="/logo.svg" alt="" className="w-9 h-9" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">
                    {t('drops.title', 'Ephemeral Drops')}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    v{APP_VERSION}
                  </p>
                </div>
              </div>
              <button
                onClick={() => openExternal(WEBSITE_URL)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                <span className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
                  <ExternalLink className="w-4 h-4 text-purple-500" />
                  {t('settings.about.website', 'Visit website')}
                </span>
              </button>
              <div className="flex items-center gap-3 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
                <Shield className="w-4 h-4 text-purple-500 shrink-0" />
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  {t('drops.tagline', 'Encrypted, self-destructing drops. The server never sees your content.')}
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
