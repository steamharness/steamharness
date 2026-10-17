import * as l10n from '@vscode/l10n';

let language = 'en';

export function configureLocalization(bundle: l10n.l10nJsonFormat, locale = 'en'): void {
  language = locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  l10n.config({ contents: bundle });
}

export function locale(): string { return language; }

export function t(message: string, ...args: unknown[]): string {
  return l10n.t(message, ...args.map(value => String(value)));
}
