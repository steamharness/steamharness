// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ClipboardImages } from '../web/ui/clipboard-images';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('imports one image per clipboard item and ignores text and alternative encodings', async () => {
  const getType = vi.fn(async (type: string) => new Blob(['image'], { type }));
  const read = vi.fn(async () => [{ types: ['text/plain'] }, { types: ['image/jpeg', 'image/png'], getType }]);
  vi.stubGlobal('navigator', { clipboard: { read } });
  const send = vi.fn(), files = await new ClipboardImages(send).read();
  expect(files).toHaveLength(1); expect(files[0].type).toBe('image/png'); expect(files[0].size).toBe(5);
  expect(getType).toHaveBeenCalledExactlyOnceWith('image/png'); expect(send).not.toHaveBeenCalled();
});

it('reports missing images, browser support, permission denial and oversized images', async () => {
  const reader = new ClipboardImages(vi.fn());
  vi.stubGlobal('navigator', {}); await expect(reader.read()).rejects.toThrow('unavailable');
  const read = vi.fn(async (): Promise<any[]> => []); vi.stubGlobal('navigator', { clipboard: { read } });
  await expect(reader.read()).rejects.toThrow('No image');
  read.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
  await expect(reader.read()).rejects.toThrow('Allow clipboard access');
  read.mockResolvedValueOnce([{ types: ['image/png'], getType: async () => ({ size: 50 * 1024 * 1024 + 1 }) }]);
  await expect(reader.read()).rejects.toThrow('50 MiB');
});

it('matches native replies to the image request without reading the browser clipboard', async () => {
  const send = vi.fn(), browserRead = vi.fn(); vi.stubGlobal('navigator', { clipboard: { read: browserRead } });
  const reader = new ClipboardImages(send); reader.enable(1);
  const pending = reader.read(), request = send.mock.calls[0][0];
  expect(request).toMatchObject({ type: 'workflow-edit', command: 'paste', version: 1 });
  await expect(reader.read()).rejects.toThrow('already in progress');
  reader.receive({ version: 1, requestId: 'stale', image: new Uint8Array([1]) });
  reader.receive({ version: 1, requestId: request.clipboardImageRequestId, image: new Uint8Array([1, 2, 3]) });
  expect(await pending).toMatchObject([{ name: 'clipboard.png', type: 'image/png', size: 3 }]);
  expect(browserRead).not.toHaveBeenCalled();
  const empty = reader.read(), failure = expect(empty).rejects.toThrow('No image');
  reader.receive({ version: 1, requestId: send.mock.calls[1][0].clipboardImageRequestId, image: new Uint8Array() }); await failure;
});

it('expires or cancels native reads and ignores late replies after disposal', async () => {
  vi.useFakeTimers(); const send = vi.fn(), reader = new ClipboardImages(send); reader.enable(1);
  const expired = expect(reader.read()).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(10_000); await expired;
  const closed = expect(reader.read()).rejects.toThrow('Connection changed'); reader.dispose(); await closed;
  reader.receive({ version: 1, requestId: send.mock.calls[1][0].clipboardImageRequestId, image: new Uint8Array([1]) });
  expect(vi.getTimerCount()).toBe(0);
});
