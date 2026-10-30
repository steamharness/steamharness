import { locale, t } from '../localization';
import './request-error.css';

const rendered = new WeakMap<HTMLElement, string>();
const detailLimit = 16_000;

/** Dismissing an alert changes its visibility, not the validation result. */
export class RequestErrorAlert {
  private readonly content = document.createElement('div');
  private readonly close = document.createElement('button');
  private error?: string;
  constructor(private readonly root: HTMLElement) {
    root.classList.add('request-error-alert');
    this.content.className = 'request-error-content';
    this.close.type = 'button'; this.close.className = 'icon-button request-error-close';
    this.close.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
    this.close.onclick = () => { root.hidden = true; };
    root.replaceChildren(this.content, this.close);
  }
  get hasError(): boolean { return !!this.error; }
  show(error?: string): void {
    this.error = error;
    renderRequestError(this.content, error);
    this.close.title = this.close.ariaLabel = t('Dismiss error');
    this.root.hidden = !error;
  }
}

function responseStatus(message: string, htmlOffset: number): number | undefined {
  const prefix = message.slice(0, htmlOffset);
  const code = prefix.match(/\bAPI\s+error\s*\(([45]\d{2})\)/i)?.[1]
    ?? prefix.match(/\bHTTP(?:\/[\d.]+)?(?:\s+error)?[\s:(]+([45]\d{2})\b/i)?.[1]
    ?? prefix.match(/(?:^|:\s*)([45]\d{2})(?=\s|:|$)/)?.[1]
    ?? message.slice(htmlOffset).match(/<(?:title|h1)\b[^>]*>\s*([45]\d{2})\b/i)?.[1];
  return code ? Number(code) : undefined;
}

function requestHint(status?: number): string {
  if (status === 401 || status === 403) return t('Check the API key and whether it has access to this model.');
  if (status === 404 || status === 405) return t('Check the API URL, API type and model name in your model settings.');
  if (status === 408 || status === 504) return t('The request timed out. Try again later.');
  if (status === 429) return t('Check the service rate limits and available quota, or try again later.');
  if (status && status >= 500) return t('The service is temporarily unavailable. Try again later.');
  return t('Check the service URL and API type, or try again later.');
}

/** Summarize server error pages without rendering their HTML or changing saved diagnostics. */
export function renderRequestError(root: HTMLElement, error?: string): void {
  const message = error ?? '';
  root.hidden = !message;
  const signature = JSON.stringify([message, locale()]);
  if (rendered.get(root) === signature) return;
  rendered.set(root, signature);
  const htmlOffset = message.search(/<(?:!doctype\s+html\b|html\b|head\b|body\b|title\b)[^>]*>/i);
  const status = htmlOffset >= 0 ? responseStatus(message, htmlOffset) : undefined;
  const htmlResponse = htmlOffset >= 0 && (status !== undefined || !message.slice(0, htmlOffset).trim()
    || /\bAPI\s+error\b/i.test(message.slice(0, htmlOffset)) || /<!doctype\s+html\b|<\/(?:html|head|body|title)\s*>/i.test(message));
  root.classList.toggle('request-error', htmlResponse);
  if (!htmlResponse) { root.textContent = message; return; }

  const summary = document.createElement('p'); summary.className = 'request-error-summary';
  summary.textContent = status ? t('Request failed (HTTP {0}).', status) : t('The service returned an unexpected page.');
  const hint = document.createElement('p'); hint.className = 'request-error-hint'; hint.textContent = requestHint(status);
  const details = document.createElement('details'); details.className = 'request-error-details';
  const label = document.createElement('summary'); label.textContent = t('Technical details');
  const body = document.createElement('pre');
  body.textContent = message.length > detailLimit ? `${message.slice(0, detailLimit)}\n${t('The response was shortened.')}` : message;
  details.append(label, body);
  root.replaceChildren(summary, hint, details);
}
