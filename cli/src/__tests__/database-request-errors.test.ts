import { afterEach, expect, it, vi } from 'vitest';
import { databaseManagementRequest } from '../database-management';

afterEach(() => vi.unstubAllGlobals());
const connection = { server: 'https://server.test', token: 'test-account-token' };

it('preserves HTTP status and resource error codes for startup recovery', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ errCode: 503, errMessage: 'Unavailable', data: { code: 'DATABASE_UNAVAILABLE' } }), { status: 503 })));
  await expect(databaseManagementRequest(connection, '/bindings')).rejects.toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
});

it('marks a transport outage as temporarily unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
  await expect(databaseManagementRequest(connection, '/bindings')).rejects.toMatchObject({ status: 503 });
});

it('retains the HTTP status when a gateway returns a non-JSON error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>Unavailable</h1>', { status: 503 })));
  await expect(databaseManagementRequest(connection, '/bindings')).rejects.toMatchObject({ status: 503 });
});
