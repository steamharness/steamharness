import { afterEach, expect, it, vi } from 'vitest';
import { projectServerBrowserLink } from '../web/project-server-link';

afterEach(() => vi.restoreAllMocks());

it('opens only the current project using a browser handoff without putting the account key in its URL', async () => {
  const code = 'a'.repeat(43);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ errCode: 0, data: { code } }));
  const url = await projectServerBrowserLink({ serverUrl: 'https://server.test', accessToken: 'long-lived-account-key' }, 'current-project');
  expect(url).toBe(`https://server.test/api/auth/browser-session?code=${code}`);
  expect(url).not.toContain('long-lived-account-key');
  expect(fetcher).toHaveBeenCalledWith('https://server.test/api/auth/browser-session', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ returnTo: '/detail/current-project' }), redirect: 'error',
    headers: expect.objectContaining({ Authorization: 'Bearer long-lived-account-key' }),
  }));
});

it.each([401, 500, 200])('rejects a failed or malformed browser handoff (HTTP %s)', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ errCode: status === 200 ? 0 : status, data: { code: 'invalid', url: 'https://untrusted.test/' } }, { status }));
  await expect(projectServerBrowserLink({ serverUrl: 'https://server.test', accessToken: 'private-key' }, 'current')).rejects.toThrow('Could not open the cloud project');
});
