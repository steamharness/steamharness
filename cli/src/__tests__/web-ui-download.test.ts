import { afterEach, expect, it, vi } from 'vitest';
import { acquireProjectHost } from '../web/ui/host';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../web/ui/account', () => ({ AccountPanel: class {} }));
vi.mock('../web/ui/connection', () => ({ BrowserConnection: class { request = request; }, ConnectionError: class extends Error {} }));

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); request.mockReset(); });

function fixture(embedded = true) {
  vi.useFakeTimers();
  const listeners = new Map<string, (event: any) => void>();
  const parent = { postMessage: vi.fn() }, emitted: unknown[] = [];
  const window = { parent: undefined as unknown, dispatchEvent: (event: MessageEvent) => emitted.push(event.data) };
  window.parent = embedded ? parent : window;
  const link = { click: vi.fn(), href: '', download: '' };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', {
    documentElement: { dataset: { theme: 'dark' } }, body: { dataset: {} },
    querySelector: () => ({ content: 'project' }), createElement: () => link,
  });
  vi.stubGlobal('location', { pathname: '/', search: '' });
  vi.stubGlobal('acquireVsCodeApi', undefined);
  vi.stubGlobal('addEventListener', (type: string, listener: (event: any) => void) => listeners.set(type, listener));
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const host = acquireProjectHost();
  const receive = (source: unknown, extra: Record<string, unknown>) => listeners.get('message')!({ source, data: { type: 'workflow-host', ...extra } });
  const download = async (name = 'conversation-1.json', content = '{"text":"对话内容"}', mimeType?: string) => {
    request.mockResolvedValue([{ type: 'download', name, content, mimeType }, { type: 'exported', messageId: 'message-1' }]);
    await host.postMessage({ type: 'session-action', action: 'export', id: 'conversation-1' });
    await Promise.resolve();
  };
  return { parent, window, receive, download, link, emitted, createObjectURL, revokeObjectURL };
}

it('hands exports to Studio after its capability handshake and preserves other export replies', async () => {
  const f = fixture();
  f.receive(f.parent, { downloadVersion: 1 });
  f.receive(f.parent, { theme: 'light' });
  await f.download();
  expect(f.parent.postMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'workflow-download', version: 1, requestId: expect.any(String),
    name: 'conversation-1.json', content: '{"text":"对话内容"}',
  }, '*');
  expect(f.createObjectURL).not.toHaveBeenCalled(); expect(f.link.click).not.toHaveBeenCalled();
  expect(f.emitted).toEqual([{ type: 'exported', messageId: 'message-1' }]);
  await f.download('run-1.json', '');
  const calls = f.parent.postMessage.mock.calls;
  expect(calls[1][0]).toMatchObject({ name: 'run-1.json', content: '' });
  expect(calls[1][0].requestId).not.toBe(calls[0][0].requestId);
});

it.each(['standalone', 'older host', 'foreign handshake', 'unsupported version', 'disabled capability'])('%s retains browser downloads', async mode => {
  const f = fixture(mode !== 'standalone');
  if (mode === 'standalone') f.receive(f.window, { downloadVersion: 1 });
  if (mode === 'foreign handshake') f.receive({}, { downloadVersion: 1 });
  if (mode === 'unsupported version') f.receive(f.parent, { downloadVersion: 2 });
  if (mode === 'disabled capability') { f.receive(f.parent, { downloadVersion: 1 }); f.receive(f.parent, { downloadVersion: 0 }); }
  await f.download('workflow-1.json', '{"text":"导出\n内容"}', 'application/json;charset=utf-8');
  expect(f.parent.postMessage).not.toHaveBeenCalled();
  expect(f.createObjectURL).toHaveBeenCalledOnce();
  const blob = f.createObjectURL.mock.calls[0][0] as Blob;
  expect(blob.type).toBe('application/json;charset=utf-8');
  expect(await blob.text()).toBe('{"text":"导出\n内容"}');
  expect(f.link.href).toBe('blob:export'); expect(f.link.download).toBe('workflow-1.json');
  expect(f.link.click).toHaveBeenCalledOnce(); expect(f.revokeObjectURL).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:export');
});
