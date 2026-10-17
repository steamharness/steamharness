import { t } from '../localization';

export interface PreviewState {
  page: number;
  scale: number;
  fit: boolean;
  sheet?: string;
  top: number;
  left: number;
}

export interface PreviewContext {
  state: PreviewState;
  width(): number;
  save(): void;
  copy(text: string): void;
  error(error: unknown): void;
}

export interface PreviewView {
  element: HTMLElement;
  tools?: HTMLElement;
  activate?(): void;
  dispose(): void;
}

export type PreviewRenderer = (bytes: Uint8Array, context: PreviewContext, signal: AbortSignal, name: string) => Promise<PreviewView>;

export async function previewWorker(asset: string, signal: AbortSignal): Promise<{ worker: Worker; dispose(): void }> {
  // VS Code Webviews only support workers loaded from blob/data URLs.
  const response = await fetch(new URL(asset, import.meta.url), { signal });
  if (!response.ok) { throw new Error(t('Unable to load preview resources.')); }
  const script = await response.arrayBuffer(); signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  try {
    const worker = new Worker(url, { type: 'module' });
    return { worker, dispose: () => { worker.terminate(); URL.revokeObjectURL(url); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) { node.textContent = text; }
  return node;
}

export function button(icon: string, label: string, action: () => void): HTMLButtonElement {
  const node = element('button', 'icon-button'); node.type = 'button'; node.title = node.ariaLabel = label;
  node.append(element('span', `codicon codicon-${icon}`)); node.firstElementChild?.setAttribute('aria-hidden', 'true');
  node.addEventListener('click', action); return node;
}

export function pager(context: PreviewContext, count: number, change: (page: number) => void): HTMLElement {
  const bar = element('div', 'preview-pager');
  const input = element('input'); input.type = 'number'; input.min = '1'; input.max = String(count);
  input.value = String(context.state.page); input.ariaLabel = t('Page');
  const previous = button('chevron-left', t('Previous page'), () => update(context.state.page - 1));
  const next = button('chevron-right', t('Next page'), () => update(context.state.page + 1));
  const update = (page: number): void => {
    if (!Number.isInteger(page)) { return; }
    context.state.page = Math.min(count, Math.max(1, page)); context.save(); sync(); change(context.state.page);
  };
  const sync = (): void => {
    input.value = String(context.state.page); previous.disabled = context.state.page <= 1; next.disabled = context.state.page >= count;
  };
  bar.addEventListener('preview-page-change', sync);
  input.addEventListener('change', () => update(Number(input.value)));
  bar.append(previous, input, element('span', '', `/ ${count}`), next); sync(); return bar;
}

export function zoom(context: PreviewContext, change: () => void): HTMLElement {
  const bar = element('div', 'preview-zoom'), label = element('span', 'zoom-label');
  const sync = (): void => { label.textContent = context.state.fit ? t('Fit') : `${Math.round(context.state.scale * 100)}%`; };
  const step = (amount: number): void => {
    context.state.fit = false; context.state.scale = Math.min(4, Math.max(0.25, context.state.scale + amount));
    context.save(); sync(); change();
  };
  bar.append(button('zoom-out', t('Zoom out'), () => step(-0.25)), label, button('zoom-in', t('Zoom in'), () => step(0.25)),
    button('screen-full', t('Fit to width'), () => { context.state.fit = true; context.save(); sync(); change(); }));
  sync(); return bar;
}

export function rememberScroll(viewport: HTMLElement, context: PreviewContext): () => void {
  viewport.scrollTop = context.state.top; viewport.scrollLeft = context.state.left;
  const save = (): void => { context.state.top = viewport.scrollTop; context.state.left = viewport.scrollLeft; context.save(); };
  viewport.addEventListener('scroll', save);
  return () => viewport.removeEventListener('scroll', save);
}
