import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Attachment } from '../src/workflow-types';

export const iconHtml = (name: string): string => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function managedFileForUrl(url: string, files: Attachment[]): Attachment | undefined {
  let value = url;
  try { value = decodeURIComponent(url); } catch { /* Invalid escaping is left to the Markdown sanitizer. */ }
  const id = value.match(/(?:^|[/?#])(wf_[a-f0-9]{32})(?:$|[/?#])/i)?.[1];
  return files.find((file) => file.id === id || value === file.path || value === file.url || value === `file://${file.path}`);
}

export function markdownHtml(text: string, files: Attachment[] = []): string {
  const renderer = new marked.Renderer();
  renderer.image = (token) => {
    const file = managedFileForUrl(token.href, files);
    return `<img src="${escapeHtml(file?.previewUrl ?? token.href)}" alt="${escapeHtml(token.text)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}${file ? ` data-workflow-file="${escapeHtml(file.id)}"` : ''}>`;
  };
  renderer.link = (token) => {
    const file = managedFileForUrl(token.href, files);
    return `<a href="${escapeHtml(file?.previewUrl ?? token.href)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}${file ? ` data-workflow-file="${escapeHtml(file.id)}"` : ''}>${renderer.parser.parseInline(token.tokens)}</a>`;
  };
  const fragment = DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true, renderer }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a', 'img', 'details', 'summary', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'class', 'open', 'data-workflow-file', 'type', 'checked', 'disabled'],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const input of Array.from(fragment.querySelectorAll('input'))) { input.type = 'checkbox'; input.disabled = true; }
  const container = document.createElement('div'); container.append(fragment); return container.innerHTML;
}

export function iconButton(name: string, label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
  button.title = button.ariaLabel = label; button.innerHTML = iconHtml(name); button.addEventListener('click', action); return button;
}
