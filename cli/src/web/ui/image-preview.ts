import { t } from '../localization';
import { iconButton } from './ui';

export function imagePreview(src: string, title: string): { element: HTMLElement; dispose(): void } {
  const element = document.createElement('div'); element.className = 'image-preview-panel';
  const toolbar = document.createElement('div'); toolbar.className = 'image-preview-toolbar';
  toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', t('Image preview'));
  const viewport = document.createElement('div'); viewport.className = 'image-preview-viewport'; viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', t('Image preview'));
  const stage = document.createElement('div'); stage.className = 'image-preview-stage';
  const image = document.createElement('img'); image.className = 'image-preview'; image.alt = title || t('Image'); image.draggable = false;
  stage.append(image); viewport.append(stage);
  const percentage = document.createElement('output'); percentage.className = 'image-preview-scale'; percentage.setAttribute('aria-live', 'polite');
  const events = new AbortController();
  let scale = 1, fit = true;
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
  const fitScale = () => Math.min(1, viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
  const zoomOut = iconButton('zoom-out', t('Zoom out'), () => zoom(scale / 1.25));
  const zoomIn = iconButton('zoom-in', t('Zoom in'), () => zoom(scale * 1.25));
  const fitButton = iconButton('screen-normal', t('Fit image'), () => { fit = true; render(); });
  const actual = document.createElement('button'); actual.type = 'button'; actual.className = 'image-preview-actual'; actual.textContent = '1:1';
  actual.title = actual.ariaLabel = t('Actual size'); actual.addEventListener('click', () => zoom(1));
  toolbar.append(zoomOut, percentage, zoomIn, fitButton, actual); element.append(toolbar, viewport);
  for (const button of [zoomOut, zoomIn, fitButton, actual]) { button.disabled = true; }

  function render(): void {
    if (!image.naturalWidth || !image.naturalHeight || !viewport.clientWidth || !viewport.clientHeight) { return; }
    if (fit) { scale = fitScale(); }
    image.style.width = `${image.naturalWidth * scale}px`; image.style.height = `${image.naturalHeight * scale}px`;
    stage.style.width = `${Math.max(viewport.clientWidth, image.naturalWidth * scale)}px`;
    stage.style.height = `${Math.max(viewport.clientHeight, image.naturalHeight * scale)}px`;
    percentage.value = `${Math.round(scale * 100)}%`;
    zoomOut.disabled = scale <= Math.min(0.1, fitScale()); zoomIn.disabled = scale >= 8;
    fitButton.disabled = actual.disabled = false;
    fitButton.setAttribute('aria-pressed', String(fit));
    viewport.dataset.pannable = String(image.naturalWidth * scale > viewport.clientWidth || image.naturalHeight * scale > viewport.clientHeight);
    if (fit) { viewport.scrollLeft = viewport.scrollTop = 0; }
  }

  function zoom(next: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2): void {
    if (!image.naturalWidth || !image.naturalHeight || !viewport.clientWidth || !viewport.clientHeight) { return; }
    const bounds = viewport.getBoundingClientRect(), before = image.getBoundingClientRect();
    const imageX = (bounds.left + x - before.left) / scale, imageY = (bounds.top + y - before.top) / scale;
    fit = false; scale = Math.max(Math.min(0.1, fitScale()), Math.min(8, next)); render();
    // Keep the image point under the cursor or viewport center while scaling.
    const after = image.getBoundingClientRect();
    viewport.scrollLeft += after.left - bounds.left + imageX * scale - x;
    viewport.scrollTop += after.top - bounds.top + imageY * scale - y;
  }

  viewport.addEventListener('wheel', event => {
    if (!(event.ctrlKey || event.metaKey) || !event.deltaY) { return; }
    event.preventDefault(); event.stopPropagation();
    const bounds = viewport.getBoundingClientRect();
    zoom(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - bounds.left, event.clientY - bounds.top);
  }, { passive: false, signal: events.signal });
  viewport.addEventListener('keydown', event => {
    if (event.altKey || event.isComposing) { return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); event.stopPropagation(); zoom(scale * 1.25); }
    else if (event.key === '-') { event.preventDefault(); event.stopPropagation(); zoom(scale / 1.25); }
    else if (event.key === '0') { event.preventDefault(); event.stopPropagation(); fit = true; render(); }
  }, { signal: events.signal });
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || viewport.dataset.pannable !== 'true') { return; }
    event.preventDefault(); viewport.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.classList.add('panning'); viewport.setPointerCapture(event.pointerId);
  }, { signal: events.signal });
  viewport.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) { return; }
    viewport.scrollLeft = drag.left + drag.x - event.clientX; viewport.scrollTop = drag.top + drag.y - event.clientY;
  }, { signal: events.signal });
  const endDrag = () => {
    if (drag && viewport.hasPointerCapture(drag.id)) { viewport.releasePointerCapture(drag.id); }
    drag = undefined; viewport.classList.remove('panning');
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) { viewport.addEventListener(type, endDrag, { signal: events.signal }); }
  image.addEventListener('load', render, { signal: events.signal });
  image.addEventListener('error', () => {
    image.hidden = true;
    const error = document.createElement('p'); error.className = 'error'; error.textContent = t('Unable to load image.'); stage.append(error);
  }, { once: true, signal: events.signal });
  const resize = new ResizeObserver(render); resize.observe(viewport);
  image.src = src;
  return { element, dispose: () => { events.abort(); resize.disconnect(); endDrag(); } };
}
