import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loginWebAccount } from '../web/account-auth';
import { readCliAuthConfig } from '../auth-config';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const directory of directories.splice(0)) { await rm(directory, { recursive: true, force: true }); } });

async function authDirectory(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'steamharness-web-auth-'));
  directories.push(directory); vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', directory);
}

const envelope = (data: object, headers?: HeadersInit) => new Response(JSON.stringify({ errCode: 0, data }), { headers });
const profile = { userId: 'test-user', email: 'test@example.com', displayName: 'Test User' };

describe('web account authentication', () => {
  it('verifies password login before saving the shared CLI identity and closes the password session', async () => {
    await authDirectory();
    const fetcher = vi.fn().mockResolvedValueOnce(envelope({ authenticated: true, accessToken: 'test-api-key', apiKey: { id: 'key-id' } }, { 'Set-Cookie': 'workflow-session=test-session; HttpOnly' }))
      .mockResolvedValueOnce(envelope({ profile, principal: { expiresAt: '2027-01-01T00:00:00Z' } }))
      .mockResolvedValueOnce(envelope({ loggedOut: true }));
    vi.stubGlobal('fetch', fetcher);
    await loginWebAccount('https://steamharness.test', ' test@example.com ', 'test-password');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ email: 'test@example.com', password: 'test-password', source: 'cli', clientName: 'SteamHarness CLI Web' });
    expect(fetcher.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer test-api-key' });
    expect(fetcher.mock.calls[2]).toEqual(['https://steamharness.test/api/auth/logout', expect.objectContaining({ method: 'POST', headers: { Cookie: 'workflow-session=test-session' } })]);
    expect(await readCliAuthConfig()).toEqual({ serverUrl: 'https://steamharness.test', apiKey: 'test-api-key', user: profile, source: 'password', expiresAt: '2027-01-01T00:00:00Z' });
    expect(JSON.stringify(await readCliAuthConfig())).not.toContain('test-password');
  });

  it('revokes a newly minted key when profile verification fails and never stores the credentials', async () => {
    await authDirectory();
    const fetcher = vi.fn().mockResolvedValueOnce(envelope({ authenticated: true, accessToken: 'test-api-key', apiKey: { id: 'key-id' } }, { 'Set-Cookie': 'workflow-session=test-session; HttpOnly' }))
      .mockResolvedValueOnce(envelope({ profile: null })).mockResolvedValue(envelope({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(loginWebAccount('https://steamharness.test', 'test@example.com', 'test-password')).rejects.toThrow('account profile');
    expect(fetcher.mock.calls[2][0]).toBe('https://steamharness.test/api/auth/api-keys/key-id');
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: 'DELETE', headers: { Cookie: 'workflow-session=test-session' } });
    expect(await readCliAuthConfig()).toEqual({ serverUrl: '', apiKey: '' });
  });

  it('redacts credentials in upstream errors and rejects empty credentials without a request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errCode: 1, errMessage: 'rejected test-password' }), { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(loginWebAccount('https://steamharness.test', 'test@example.com', 'test-password')).rejects.toThrow('rejected [redacted]');
    await expect(loginWebAccount('https://steamharness.test', '', 'test-password')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
