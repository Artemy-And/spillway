import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { setFormatLocale } from '../lib/format.ts';
import { de } from './de.ts';
import { en, type Messages } from './en.ts';
import { es } from './es.ts';
import { fr } from './fr.ts';
import { list } from './helpers.ts';
import { ru } from './ru.ts';
import { zh } from './zh.ts';

/** Each language under its own name, so people find theirs whatever language is on screen. */
export const LOCALES = {
  en: 'English',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  zh: '中文',
} as const;

export type Locale = keyof typeof LOCALES;

const MESSAGES: Record<Locale, Messages> = { en, ru, de, fr, es, zh };
const STORAGE_KEY = 'spillway.locale';

const isLocale = (value: unknown): value is Locale => typeof value === 'string' && value in LOCALES;

/** The saved choice, else the first browser language we speak, else English. */
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {}
  for (const language of navigator.languages ?? [navigator.language]) {
    const base = language.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

interface I18n {
  locale: Locale;
  m: Messages;
  setLocale: (locale: Locale) => void;
  /** "a, b and c" in the current language */
  join: (items: string[]) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const first = initialLocale();
    setFormatLocale(first);
    document.documentElement.lang = first;
    return first;
  });

  const value = useMemo<I18n>(
    () => ({
      locale,
      m: MESSAGES[locale],
      join: list(locale),
      setLocale: (next) => {
        setFormatLocale(next);
        document.documentElement.lang = next;
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {}
        setLocaleState(next);
      },
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n needs an I18nProvider');
  return value;
}

export function LanguageSelect({ className }: { className?: string }) {
  const { locale, setLocale, m } = useI18n();
  return (
    <select
      aria-label={m.common.language}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className={className}
    >
      {(Object.keys(LOCALES) as Locale[]).map((code) => (
        <option key={code} value={code}>
          {LOCALES[code]}
        </option>
      ))}
    </select>
  );
}
