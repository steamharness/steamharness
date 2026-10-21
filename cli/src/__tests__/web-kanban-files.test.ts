import { afterEach, expect, it, vi } from 'vitest';
import { createConfigurationState } from '@steamharness/project-configuration';
import { readConfigurationFile } from '../web/configuration-files';

const connection = { serverUrl: 'https://files.test', accessToken: 'account-capability' };
const bytes = Buffer.from([0, 137, 255, 10, 0]);
const file = { id: 'wf_ab12', name: '底图.png', mimeType: 'image/png', size: bytes.length, storage: 'server' as const, projectId: 'map' };
function state() {
  const value = createConfigurationState([{ name: 'image', type: 'file' }], () => 'default');
  value.configurations[0]!.values.image = file;
  return value;
}
afterEach(() => vi.restoreAllMocks());

it('reads exact attachment bytes for the selected version and carries the host cancellation signal', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
  const abort = new AbortController();
  expect(await readConfigurationFile('map', state(), file.id, connection, { target: 'v1/one', signal: abort.signal }))
    .toEqual({ file, base64: bytes.toString('base64') });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://files.test/api/projects/map/configurations/files/wf_ab12?target=v1%2Fone');
  expect(options).toMatchObject({ headers: { Authorization: 'Bearer account-capability' }, redirect: 'error' });
  abort.abort();
  expect(options!.signal!.aborted).toBe(true);
});

it('allows project bridge lookup only when the attachment route or attachment is missing', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('API route not found.', { status: 404 }));
  expect(await readConfigurationFile('map', state(), file.id, connection)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(await readConfigurationFile('map', state(), 'wf_cd34', connection)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([401, 403, 500])('keeps HTTP %s failures terminal and gives the iframe a safe file error code', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private server detail', { status }));
  await expect(readConfigurationFile('map', state(), file.id, connection))
    .rejects.toMatchObject({ code: 'KANBAN_FILE_UNAVAILABLE', message: 'Configuration file is unavailable.' });
});

it('rejects absent login, truncated content and failed transfers without exposing host errors', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await expect(readConfigurationFile('map', state(), file.id, undefined)).rejects.toMatchObject({ code: 'KANBAN_FILE_UNAVAILABLE' });
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(bytes.subarray(1)));
  await expect(readConfigurationFile('map', state(), file.id, connection)).rejects.toMatchObject({ code: 'KANBAN_FILE_UNAVAILABLE' });
  fetcher.mockRejectedValueOnce(new Error('private host details'));
  await expect(readConfigurationFile('map', state(), file.id, connection))
    .rejects.toMatchObject({ code: 'KANBAN_FILE_UNAVAILABLE', message: 'Configuration file is unavailable.' });
});
