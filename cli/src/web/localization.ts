import { getCurrentLocale, i18n, initI18n, normalizeLocale } from '@steamharness/i18n';
import chinese from './messages.zh-cn.json';

if (typeof document !== 'undefined' && document.documentElement) {
  const requested = new URL(location.href).searchParams.get('projectLocale');
  initI18n({ preference: normalizeLocale(requested || document.documentElement.lang || navigator.language) });
} else if (!i18n.isInitialized) {
  initI18n();
}
i18n.addResourceBundle('zh-CN', 'cliWeb', chinese);
i18n.addResourceBundle('en', 'cliWeb', Object.fromEntries(Object.keys(chinese).map(message => [message, message])));

export const locale = getCurrentLocale;

export function t(message: string, ...args: unknown[]): string {
  const translate = i18n.t as unknown as (key: string, options: Record<string, unknown>) => string;
  const text = translate(message, { ns: 'cliWeb', keySeparator: false, nsSeparator: false, fallbackLng: false, defaultValue: message });
  return text.replace(/\{(\d+)\}/g, (placeholder, index) => Number(index) < args.length ? String(args[Number(index)]) : placeholder);
}
