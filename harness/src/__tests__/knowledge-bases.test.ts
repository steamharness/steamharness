import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createKnowledgeBasesContext, createKnowledgeBaseContext, createServerKnowledgeBaseHost, type KnowledgeBaseBinding, type KnowledgeBaseHost } from '../knowledge-bases/index';

const identity = () => ({ projectId: randomUUID(), entryId: 'main', requirements: [{ alias: 'docs', knowledgeBaseId: randomUUID() }] });
test('knowledge aliases require explicit online hosts and never open a local KV store', async () => {
  const options = identity(), bases = createKnowledgeBasesContext(options);
  assert.throws(() => bases.get('missing'), { code: 'KNOWLEDGE_UNBOUND' });
  await assert.rejects(bases.get('docs').listDocuments(), { code: 'KNOWLEDGE_UNAVAILABLE' });
  const returned = bases.list() as any[]; returned[0].knowledgeBaseId = 'modified';
  assert.equal(bases.list()[0]?.knowledgeBaseId, options.requirements[0].knowledgeBaseId);
});
test('retained clients reject binding replacement, access revisions and unexpected resource identities', async () => {
  const options = identity();
  let binding: KnowledgeBaseBinding = { id: randomUUID(), revision: 1, knowledgeBaseId: options.requirements[0].knowledgeBaseId, mode: 'write', accessRevision: 1 };
  const calls: unknown[] = [];
  const host: KnowledgeBaseHost = { async resolve() { return { ...binding }; }, async operation(...args) { calls.push(args); return { items: [], total: 0, hasMore: false } as any; } };
  const base = createKnowledgeBasesContext({ ...options, host }).get('docs');
  await base.listDocuments(); assert.equal(calls.length, 1);
  const previous = binding;
  for (const patch of [{ revision: 2 }, { accessRevision: 2 }, { id: randomUUID() }, { knowledgeBaseId: randomUUID() }, { mode: 'read' as const }]) {
    binding = { ...previous, ...patch };
    await assert.rejects(base.createDocument({ title: 'x', markdown: 'x' }), { code: 'KNOWLEDGE_ACCESS_DENIED' });
  }
  assert.equal(calls.length, 1, 'no rejected mutation reached storage');
});
test('attachment snapshots download once, copy buffers, and authorize every retained read', async () => {
  const file = { id: randomUUID(), name: 'map.png', mimeType: 'image/png', kind: 'image', storage: 'database', spaceId: randomUUID(), createdAt: new Date().toISOString(), size: 5 };
  let downloads = 0, checks = 0, allowed = true;
  const base = createKnowledgeBaseContext(async (operation) => {
    if (operation === 'files.readFile') { downloads++; return { file, base64: Buffer.from('image').toString('base64') } as any; }
    if (operation === 'files.stat') { checks++; if (!allowed) throw new Error('Access revoked'); return file as any; }
    throw new Error('Unexpected operation');
  });
  const retained = await base.files.readFile(file.id);
  (await retained.readBuffer()).fill(0);
  assert.equal((await retained.readBuffer()).toString(), 'image');
  assert.equal(downloads, 1); assert.equal(checks, 2);
  allowed = false; await assert.rejects(retained.readBase64(), /revoked/); assert.equal(downloads, 1);
});
test('HTTP knowledge host uses account authorization, maps errors, and does not replay writes', async t => {
  let status = 200, requests = 0;
  const server = createServer(async (req, res) => {
    requests++; assert.equal(req.headers.authorization, 'Bearer test-only-token');
    const body: Buffer[] = []; for await (const part of req) body.push(part);
    const input = JSON.parse(Buffer.concat(body).toString());
    assert.equal(input.alias, 'docs');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { errCode: 0, data: { id: 'result' } } : { errCode: status, errMessage: 'Denied' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = createServerKnowledgeBaseHost({ serverUrl, token: async () => 'test-only-token' });
  const request = { projectId: randomUUID(), entryId: 'main', alias: 'docs', knowledgeBaseId: randomUUID() };
  assert.deepEqual(await host.resolve(request), { id: 'result' });
  status = 403; await assert.rejects(host.operation(request, {} as any, 'knowledge.createDocument', {}), { code: 'KNOWLEDGE_ACCESS_DENIED' });
  assert.equal(requests, 2);
  assert.throws(() => createServerKnowledgeBaseHost({ serverUrl: 'file:///tmp/local', token: 'x' }), { code: 'KNOWLEDGE_INVALID_REQUEST' });
});

test('knowledge attachments reuse only account-scoped snapshots after an online metadata check', async () => {
  const previousFetch = globalThis.fetch;
  const request = { projectId: randomUUID(), entryId: 'main', alias: 'docs', knowledgeBaseId: randomUUID() };
  const binding: KnowledgeBaseBinding = { id: randomUUID(), revision: 1, knowledgeBaseId: request.knowledgeBaseId, mode: 'write', accessRevision: 1 };
  const file = { id: randomUUID(), name: 'image.png', mimeType: 'image/png', kind: 'image', storage: 'database', spaceId: request.knowledgeBaseId, createdAt: new Date().toISOString(), size: 5 };
  let token = 'one', denied = false, downloads = 0, checks = 0;
  globalThis.fetch = (async (_url, init) => {
    const { operation } = JSON.parse(String(init?.body));
    if (denied) return Response.json({ errCode: 403, errMessage: 'Revoked' }, { status: 403 });
    if (operation === 'files.readFile') { downloads++; return Response.json({ errCode: 0, data: { file, base64: Buffer.from(token).toString('base64') } }); }
    if (operation === 'files.stat') { checks++; return Response.json({ errCode: 0, data: file }); }
    return Response.json({ errCode: 0, data: { deleted: true } });
  }) as typeof fetch;
  const host = createServerKnowledgeBaseHost({ serverUrl: 'https://knowledge.test', token: () => token });
  const read = () => host.operation<{ file: any; base64: string }>(request, binding, 'files.readFile', { fileId: file.id });
  try {
    const [first, second] = await Promise.all([read(), read()]);
    first.file.name = 'edited'; assert.equal(second.file.name, 'image.png'); assert.equal(downloads, 1);
    await read(); assert.equal(downloads, 1); assert.equal(checks, 1);
    await host.operation(request, binding, 'files.deleteFile', { fileId: file.id });
    await read(); assert.equal(downloads, 2);
    token = 'two'; assert.equal(Buffer.from((await read()).base64, 'base64').toString(), 'two'); assert.equal(downloads, 3);
    denied = true; await assert.rejects(read(), { code: 'KNOWLEDGE_ACCESS_DENIED' });
    denied = false; await read(); assert.equal(downloads, 4);
    token = ''; await assert.rejects(read(), { code: 'KNOWLEDGE_ACCESS_DENIED' });
  } finally { globalThis.fetch = previousFetch; }
});
