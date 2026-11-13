// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { acquireProjectHost } from '../web/ui/host';

const mock = vi.hoisted(() => ({ request: vi.fn(async (_message: unknown) => []), read: vi.fn(), prepare: vi.fn() }));
vi.mock('../web/ui/account', () => ({ AccountPanel: class {} }));
vi.mock('../web/ui/connection', () => ({ BrowserConnection: class { request = mock.request; }, ConnectionError: class extends Error {} }));
vi.mock('../web/ui/clipboard-images', () => ({ ClipboardImages: class { read = mock.read; } }));
vi.mock('../web/ui/image-cropper', () => ({ prepareImageFiles: mock.prepare }));
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function host() {
  document.body.innerHTML = '<div id="project-menu"></div>';
  document.documentElement.dataset.theme = 'dark';
  vi.stubGlobal('acquireVsCodeApi', undefined);
  return acquireProjectHost({ live: false });
}

it('waits for crop confirmation and uploads only the processed bytes and file metadata', async () => {
  const original = new File(['source-pixels'], 'large.png', { type: 'image/png' });
  const cropped = new File(['cropped-pixels'], 'large-cropped.png', { type: 'image/png' });
  mock.read.mockResolvedValue([original]);
  let confirm!: (files: File[]) => void;
  mock.prepare.mockReturnValue(new Promise<File[]>(resolve => { confirm = resolve; }));
  const image = { crop: true, minWidth: 280, maxWidth: 1568 };
  const pending = host().postMessage({ type: 'attach', clipboard: true, paramName: 'photo', entrypointId: 'recognize', accept: ['image/png'], image });
  await vi.waitFor(() => expect(mock.prepare).toHaveBeenCalledWith([original], image, ['image/png']));
  expect(mock.request).not.toHaveBeenCalled();
  confirm([cropped]); await pending;
  expect(mock.request).toHaveBeenCalledOnce();
  const upload = mock.request.mock.calls[0][0] as { type: string; paramName: string; entrypointId: string; files: { name: string; data: string; mimeType: string }[] };
  expect(upload).toMatchObject({ type: 'upload', paramName: 'photo', entrypointId: 'recognize' });
  expect(upload.files).toEqual([{ name: 'large-cropped.png', mimeType: 'image/png', data: btoa('cropped-pixels') }]);
});

it('does not send an upload request when the crop editor is cancelled', async () => {
  mock.read.mockResolvedValue([new File(['source'], 'image.png', { type: 'image/png' })]);
  mock.prepare.mockResolvedValue(undefined);
  await host().postMessage({ type: 'attach', clipboard: true, paramName: 'photo', image: { crop: true } });
  expect(mock.request).not.toHaveBeenCalled();
});
