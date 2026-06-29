import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.js';
import es from './locales/es.js';
import fr from './locales/fr.js';
import ar from './locales/ar.js';
import pt from './locales/pt.js';
import zh from './locales/zh.js';
import hi from './locales/hi.js';
import de from './locales/de.js';
import ru from './locales/ru.js';
import ja from './locales/ja.js';

export const LANGUAGES = [
  { code: 'en', name: 'English',    nativeName: 'English',    dir: 'ltr' },
  { code: 'es', name: 'Spanish',    nativeName: 'Español',    dir: 'ltr' },
  { code: 'fr', name: 'French',     nativeName: 'Français',   dir: 'ltr' },
  { code: 'ar', name: 'Arabic',     nativeName: 'العربية',    dir: 'rtl' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português',  dir: 'ltr' },
  { code: 'zh', name: 'Chinese',    nativeName: '中文',        dir: 'ltr' },
  { code: 'hi', name: 'Hindi',      nativeName: 'हिंदी',      dir: 'ltr' },
  { code: 'de', name: 'German',     nativeName: 'Deutsch',    dir: 'ltr' },
  { code: 'ru', name: 'Russian',    nativeName: 'Русский',    dir: 'ltr' },
  { code: 'ja', name: 'Japanese',   nativeName: '日本語',      dir: 'ltr' },
];

function detectLanguage() {
  const stored = localStorage.getItem('app_language');
  if (stored && LANGUAGES.find(l => l.code === stored)) return stored;

  const browserLang = navigator.language?.split('-')[0];
  if (browserLang && LANGUAGES.find(l => l.code === browserLang)) return browserLang;

  return 'en';
}

export function applyDocumentDir(langCode) {
  const lang = LANGUAGES.find(l => l.code === langCode);
  const dir = lang?.dir ?? 'ltr';
  document.documentElement.setAttribute('dir', dir);
  document.documentElement.setAttribute('lang', langCode);
  if (dir === 'rtl') {
    document.documentElement.classList.add('rtl');
  } else {
    document.documentElement.classList.remove('rtl');
  }
}

const detectedLang = detectLanguage();
applyDocumentDir(detectedLang);

i18n
  .use(initReactI18next)
  .init({
    resources: { en, es, fr, ar, pt, zh, hi, de, ru, ja },
    lng: detectedLang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

export default i18n;
