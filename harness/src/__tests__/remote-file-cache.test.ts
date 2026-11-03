import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RemoteProjectFileStore } from '../files/remote';
import { FileReadCache } from '../files/read-cache';

test('managed files coalesce downloads, revalidate every read and discard denied snapshots', async () => {
  const previousFetch = globalThis.fetch;
  let etag = '"one"', content = 'image', denied = false, reads = 0, downloads = 0;
  const conditions: (string | null)[] = [];
  globalThis.fetch = (async (_url, init) => {
    reads++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer account');
    conditions.push(headers.get('if-none-match'));
    if (denied) return Response.json({ errCode: 403, errMessage: 'Revoked' }, { status: 403 });
    if (headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
    downloads++; return new Response(content, { headers: { etag } });
  }) as typeof fetch;
  try {
    const store = new RemoteProjectFileStore({ serverUrl: 'https://files.test', token: 'account', projectName: 'project' });
    const reference = { id: randomUUID(), name: 'map.png', mimeType: 'image/png', kind: 'image' as const, storage: 'server' as const, projectId: 'project', size: 5, createdAt: new Date().toISOString() };
    const first = await store.resolveFile(reference), second = await store.resolveFile(reference);
    const [a, b] = await Promise.all([first.readBuffer(), second.readBuffer()]);
    a.fill(0); assert.equal(b.toString(), 'image'); assert.equal(reads, 1);
    assert.equal((await first.readBuffer()).toString(), 'image'); assert.equal(reads, 2); assert.equal(downloads, 1);
    content = 'new'; etag = '"two"'; assert.equal((await first.readBuffer()).toString(), 'new'); assert.equal(downloads, 2);
    denied = true; await assert.rejects(first.readBuffer(), /Revoked/);
    denied = false; await first.readBuffer(); assert.equal(conditions.at(-1), null); assert.equal(downloads, 3);
    const other = new RemoteProjectFileStore({ serverUrl: 'https://files.test', token: 'account', projectName: 'project' });
    await (await other.resolveFile(reference)).readBuffer(); assert.equal(conditions.at(-1), null);
  } finally { globalThis.fetch = previousFetch; }
});

test('attachment caches bound both bytes and entry count and never retain oversized objects', () => {
  const cache = new FileReadCache<string>(10, 2);
  cache.set('a', 'a', 4); cache.set('b', 'b', 4); cache.set('c', 'c', 4);
  assert.equal(cache.get('a'), undefined); assert.equal(cache.get('c'), 'c');
  cache.set('b', 'updated', 7); assert.equal(cache.get('c'), undefined);
  cache.set('oversized', 'x', 11); assert.equal(cache.get('oversized'), undefined);
  cache.clear(); assert.equal(cache.get('b'), undefined);
});
