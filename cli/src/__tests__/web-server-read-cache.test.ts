import { afterEach, expect, it, vi } from 'vitest';
import { ServerReadCache } from '../web/server-read-cache';
import { loadAgentModelCatalog } from '../web/agent-model-catalog';

afterEach(async () => { await loadAgentModelCatalog(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('coalesces reads, copies snapshots, expires entries and detaches invalidated requests', async () => {
  vi.useFakeTimers();
  const cache = new ServerReadCache(5_000, 2);
  let finish!: (value: { name: string }) => void;
  const load = vi.fn(() => new Promise<{ name: string }>(resolve => { finish = resolve; }));
  const first = cache.read('one', load), second = cache.read('one', load);
  expect(load).toHaveBeenCalledTimes(1); finish({ name: 'first' });
  (await first).name = 'edited'; expect(await second).toEqual({ name: 'first' });
  expect(await cache.read('one', load)).toEqual({ name: 'first' });
  await vi.advanceTimersByTimeAsync(5_001);
  const old = cache.read('one', load); cache.clear();
  expect(await cache.read('one', async () => ({ name: 'new' }))).toEqual({ name: 'new' });
  finish({ name: 'obsolete' }); await old;
  expect(await cache.read('one', load)).toEqual({ name: 'new' });
  const failed = vi.fn(async () => { throw new Error('Denied'); });
  await expect(cache.read('denied', failed)).rejects.toThrow('Denied');
  expect(await cache.read('denied', async () => 'retry')).toBe('retry');
  await cache.read('third', async () => 3);
  expect(await cache.read('one', async () => ({ name: 'evicted' }))).toEqual({ name: 'evicted' });
});

it('caches only parsed AI display metadata, isolates identities and retries rejected refreshes', async () => {
  vi.useFakeTimers();
  let denied = false;
  const fetcher = vi.fn(async () => Response.json(denied ? { errCode: 403, errMessage: 'Denied' } : {
    errCode: 0, data: { credentials: [{ id: 'plan', name: 'Plan', providerType: 'anthropic', models: ['model'], credentialToken: 'secret-proxy-token' }] },
  }, { status: denied ? 403 : 200 }));
  vi.stubGlobal('fetch', fetcher);
  const connection = { serverUrl: 'https://project.test', accessToken: 'project', aiServerUrl: 'https://ai.test', aiAccessToken: 'one' };
  const [first, second] = await Promise.all([loadAgentModelCatalog(connection), loadAgentModelCatalog(connection)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  first.entries.length = 0; expect(second.entries).toHaveLength(1);
  expect(JSON.stringify(second)).not.toContain('secret-proxy-token');
  await loadAgentModelCatalog(connection); expect(fetcher).toHaveBeenCalledTimes(1);
  await loadAgentModelCatalog({ ...connection, aiAccessToken: 'two' }); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_001); denied = true;
  await expect(loadAgentModelCatalog({ ...connection, aiAccessToken: 'two' })).rejects.toThrow('Denied');
  denied = false; await loadAgentModelCatalog({ ...connection, aiAccessToken: 'two' }); expect(fetcher).toHaveBeenCalledTimes(4);
  await loadAgentModelCatalog(); await loadAgentModelCatalog(connection); expect(fetcher).toHaveBeenCalledTimes(5);
});

it('rejects a late model catalogue after account selection changes', async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const connection = { serverUrl: 'https://project.test', accessToken: 'project', aiServerUrl: 'https://ai.test', aiAccessToken: 'old' };
  const pending = loadAgentModelCatalog(connection);
  await loadAgentModelCatalog();
  finish(Response.json({ errCode: 0, data: { credentials: [] } }));
  await expect(pending).rejects.toThrow('Resource access changed');
});
