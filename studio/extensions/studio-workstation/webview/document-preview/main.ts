import { t } from '../localization';
import { samePreviewBytes, type DocumentPreviewKind, type PreviewMessage } from '../../src/document-preview-types';
import { button, element, type PreviewContext, type PreviewRenderer, type PreviewState, type PreviewView } from './view';
import '../scrollbars.css';
import './style.css';
import { installContextMenu } from '../context-menu';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): Partial<PreviewState> | undefined; setState(state: PreviewState): void };
const vscode = acquireVsCodeApi();
const saved = vscode.getState();
const state: PreviewState = { page: Math.max(1, Math.trunc(saved?.page ?? 1)), scale: Math.max(0.25, Math.min(4, saved?.scale ?? 1)),
  fit: saved?.fit ?? true, sheet: saved?.sheet, top: saved?.top ?? 0, left: saved?.left ?? 0 };
const loaders: Record<DocumentPreviewKind, () => Promise<{ default: PreviewRenderer }>> = {
  pdf: () => import('./pdf'), docx: () => import('./docx'), pptx: () => import('./pptx'),
  xlsx: () => import('./spreadsheet'), latex: () => import('./latex'), image: () => import('./image'),
};
const app = document.getElementById('preview-app')!;
const toolbar = element('header', 'preview-toolbar'), format = element('span', 'preview-format');
const tools = element('div', 'preview-tools'); tools.id = 'format-tools';
const readonly = element('span', 'preview-readonly', t('Read-only'));
const refresh = button('refresh', t('Refresh Preview'), () => vscode.postMessage({ type: 'refresh' }));
const status = element('div', 'preview-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
const content = element('main', 'preview-content'); content.id = 'preview-content';
toolbar.append(format, tools, readonly, refresh); app.append(toolbar, status, content);
let generation = 0, controller: AbortController | undefined, view: PreviewView | undefined, bytes: Uint8Array | undefined;
let failed = false, queue = Promise.resolve();
installContextMenu(vscode, () => [{ id: 'refresh', run: () => refresh.click() }], () => generation);
const showError = (error: unknown): void => {
  failed = true; refresh.classList.remove('busy'); status.hidden = false; status.setAttribute('role', 'alert');
  status.replaceChildren(element('strong', '', t('Unable to preview file')), element('span', '', error instanceof Error ? error.message : String(error)));
};
const context: PreviewContext = { state, width: () => content.clientWidth, save: () => vscode.setState(state),
  copy: text => vscode.postMessage({ type: 'copy', text }), error: showError };

window.addEventListener('message', (event: MessageEvent<PreviewMessage>) => {
  const message = event.data;
  if (!message || !Number.isSafeInteger(message.generation) || message.generation < generation) { return; }
  if (message.type === 'loading') {
    generation = message.generation; controller?.abort(); refresh.classList.add('busy');
    status.hidden = !!view; status.setAttribute('role', 'status'); status.textContent = t('Loading preview...'); return;
  }
  if (message.type === 'error') { generation = message.generation; controller?.abort(); showError(message.error); return; }
  if (message.type !== 'document' || !Object.hasOwn(loaders, message.kind)) { return; }
  generation = message.generation;
  const next = new Uint8Array(message.bytes);
  if (!failed && samePreviewBytes(bytes, next)) { app.dataset.generation = String(generation); refresh.classList.remove('busy'); status.hidden = true; return; }
  controller?.abort(); const current = controller = new AbortController();
  const timeout = setTimeout(() => { if (!current.signal.aborted) { current.abort(); showError(t('Preview timed out.')); } }, 30_000);
  queue = queue.catch(() => undefined).then(async () => {
    let result: PreviewView | undefined;
    try {
      current.signal.throwIfAborted();
      const renderer = await loaders[message.kind](); current.signal.throwIfAborted();
      result = await renderer.default(next, context, current.signal, message.name);
      if (current.signal.aborted || message.generation !== generation) { result.dispose(); return; }
      view?.dispose(); view = result; bytes = next; failed = false;
      content.replaceChildren(result.element); tools.replaceChildren(...(result.tools ? [result.tools] : []));
      format.textContent = message.kind === 'latex' ? 'LaTeX' : message.kind === 'image' ? t('Image') : message.kind.toUpperCase();
      app.dataset.kind = message.kind; app.dataset.generation = String(generation); app.dataset.name = message.name;
      content.ariaLabel = message.name; status.hidden = true; refresh.classList.remove('busy'); result.activate?.();
    } catch (error) {
      result?.dispose(); if (!current.signal.aborted && generation === message.generation) { showError(error); }
    } finally { clearTimeout(timeout); if (controller === current) { controller = undefined; } }
  });
});
window.addEventListener('pagehide', () => { controller?.abort(); view?.dispose(); });
vscode.postMessage({ type: 'ready' });
