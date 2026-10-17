import { t } from '../localization';
import { element, zoom, rememberScroll, previewWorker, type PreviewRenderer } from './view';

const mimeTypes: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon' };

async function decodeHeif(bytes: Uint8Array, signal: AbortSignal): Promise<Blob> {
  const resource = await previewWorker('./heif-worker.js', signal), worker = resource.worker;
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const abort = (): void => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = event => { signal.removeEventListener('abort', abort); if (event.data.error) {
        reject(new Error(event.data.error === 'HEIF_PIXEL_LIMIT' ? t('HEIC/HEIF preview is limited to 64 million pixels.') : t('Unable to decode image.')));
      } else { resolve(event.data.blob); } };
      worker.onerror = event => { signal.removeEventListener('abort', abort); reject(new Error(event.message)); };
      const data = bytes.slice(); worker.postMessage(data, [data.buffer]);
    });
  } finally { resource.dispose(); }
}

const render: PreviewRenderer = async (bytes, context, signal, name) => {
  const extension = name.split('.').pop()!.toLowerCase();
  const blob = ['heic', 'heif'].includes(extension) ? await decodeHeif(bytes, signal)
    : new Blob([bytes.slice()], { type: mimeTypes[extension] ?? `image/${extension}` });
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob), image = element('img'); image.alt = name;
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { image.src = ''; reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true });
      image.onload = () => { signal.removeEventListener('abort', abort); resolve(); };
      image.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error(t('Unable to decode image.'))); }; image.src = url;
    });
    signal.throwIfAborted();
  } catch (error) { URL.revokeObjectURL(url); throw error; }
  const viewport = element('div', 'preview-scroll'), stage = element('div', 'preview-image'); stage.append(image); viewport.append(stage);
  const update = (): void => {
    const scale = context.state.fit ? Math.min(1, Math.max(1, context.width() - 32) / image.naturalWidth) : context.state.scale;
    image.style.width = `${image.naturalWidth * scale}px`; image.style.height = `${image.naturalHeight * scale}px`;
    stage.style.width = `${Math.max(context.width(), image.naturalWidth * scale + 32)}px`;
  };
  const tools = element('div'); tools.append(zoom(context, update), element('span', 'preview-format', `${image.naturalWidth} x ${image.naturalHeight}`));
  const resize = new ResizeObserver(update);
  let forgetScroll = (): void => {};
  return { element: viewport, tools, activate: () => { update(); forgetScroll = rememberScroll(viewport, context); resize.observe(viewport); },
    dispose: () => { forgetScroll(); resize.disconnect(); URL.revokeObjectURL(url); image.src = ''; } };
};
export default render;
