import * as vscode from 'vscode';
import { configureLocalization, locale } from './localization';
import chinese from '../l10n/bundle.l10n.zh-cn.json';

const language = vscode.env?.language ?? 'en';
const bundle = vscode.l10n?.bundle ?? (language.toLowerCase().startsWith('zh') ? chinese : {});
configureLocalization(bundle, language);

export function localizationHtml(nonce: string): string {
  const data = JSON.stringify({ bundle, locale: locale() }).replace(/</g, '\\u003c');
  return `<script nonce="${nonce}" id="studio-localization" type="application/json">${data}</script>`;
}
