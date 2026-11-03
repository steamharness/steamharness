import { afterEach, expect, it, vi } from 'vitest';
import { ServerApiClient } from '../api';

afterEach(() => vi.restoreAllMocks());

it('reads attachment bytes from the independent knowledge API and preserves cancellation', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    errCode: 0, errMessage: '', data: { file: { mimeType: 'image/png' }, base64: 'AP8=' },
  })));
  const signal = new AbortController().signal;
  const blob = await new ServerApiClient().fetchDatabaseFile('knowledge/base', 'file', signal);
  expect(request).toHaveBeenCalledWith('/api/knowledge-bases/knowledge%2Fbase/manage', expect.objectContaining({
    method: 'POST', credentials: 'include', signal,
    body: JSON.stringify({ operation: 'files.readFile', input: { fileId: 'file' } }),
  }));
  expect(blob.type).toBe('image/png');
  expect(blob.size).toBe(2);
});

it('preserves an authorization error instead of producing a successful attachment', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errCode: 403, errMessage: 'Access revoked' }), { status: 403 }));
  await expect(new ServerApiClient().fetchDatabaseFile('base', 'file')).rejects.toThrow('Access revoked');
});
