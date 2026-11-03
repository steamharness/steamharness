import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import pg from 'pg';
import { AccountRepository } from '../account-db';
import { AuthService } from '../account-auth';
import { configureProjectAuthContext } from '../auth';
import { KnowledgeBaseRepository } from '../knowledge-bases';
import { LocalStorage } from '../local-storage';
import { HttpError } from '../protocol';
import { createKnowledgeBaseRouter } from '../routes/knowledge-bases';
import type { Storage } from '../storage';

const databaseUrl = process.env.STEAMHARNESS_TEST_RELATIONAL_DATABASE_URL;
test('knowledge HTTP uses account identity, registered project access and versioned bindings', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  const schema = `knowledge_http_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`create schema "${schema}"`);
  const connection = new URL(databaseUrl!); connection.searchParams.set('options', `-c search_path=${schema}`);
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-http-'));
  const accounts = new AccountRepository(connection.toString());
  const auth = new AuthService({ databaseUrl: connection.toString(), accountDb: accounts });
  const repository = new KnowledgeBaseRepository(databaseUrl, new LocalStorage({ root, publicBaseUrl: 'http://127.0.0.1/' }), `${schema}_kb`);
  const server = createServer();
  t.after(async () => {
    configureProjectAuthContext({});
    if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await repository.close(); await accounts.close();
    await admin.query(`drop schema if exists "${schema}_kb" cascade; drop schema if exists "${schema}" cascade`); await admin.end();
    await rm(root, { recursive: true, force: true });
  });
  await accounts.init(); await repository.init();
  const owner = (await auth.signInBootstrapAdmin({ email: 'owner@knowledge.test', password: 'isolated-test-password' })).user.userId;
  const invitation = await auth.inviteUser({ email: 'reader@knowledge.test', redirectTo: 'https://knowledge.test' });
  const reader = (await auth.acceptInvitation({ token: new URL(invitation.invitationLink!).pathname.split('/').at(-1)!, password: 'isolated-test-password' })).user.userId;
  const tokens = {
    owner: (await accounts.createApiKey({ userId: owner, name: 'Test', source: 'cli' })).token,
    reader: (await accounts.createApiKey({ userId: reader, name: 'Test', source: 'cli' })).token,
  };
  configureProjectAuthContext({ authService: auth, accountDb: accounts, dataDir: root });
  const base = await repository.create(owner, { name: 'Docs', requestId: randomUUID() });
  const registered = randomUUID(), local = randomUUID(), broken = randomUUID();
  let member = true;
  const storage = {
    knowledgeBases: repository,
    async getProjectSummary(id: string) {
      if (id === broken) throw new HttpError(503, 503, 'Project storage unavailable.');
      if (id !== registered) throw new HttpError(404, 404, 'Not found.');
      return { id };
    },
    async requireProjectCapability(_id: string, actor: { userId: string }, capability: string) {
      if (!member || actor.userId === reader && capability !== 'read') throw new HttpError(403, 403, 'Project capability denied.');
    },
    async entryKnowledgeBaseRequirements(_id: string, entryId: string) { return entryId === 'main' ? [{ alias: 'docs', knowledgeBaseId: base.id }] : []; },
  } as unknown as Storage;
  const app = express();
  // The administrative key is authenticated but has no account identity.
  app.use((req, res, next) => { if (req.headers.authorization === 'Bearer administrative-key') res.locals.principal = { kind: 'admin_key', isSystemAdmin: true }; next(); });
  app.use('/api', createKnowledgeBaseRouter(storage));
  app.use(((error, _req, res, _next) => res.status(error instanceof HttpError ? error.statusCode : 500).json({ errCode: error.statusCode ?? 500, errMessage: error.message })) as ErrorRequestHandler);
  server.on('request', app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/knowledge-bases`;
  const send = async (endpoint: string, body?: unknown, token: string | undefined = tokens.owner, status = 200) => {
    const response = await fetch(origin + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json(); assert.equal(response.status, status, JSON.stringify(payload));
    if (token) assert.equal(response.headers.get('cache-control'), 'no-store'); return payload.data;
  };
  await send('', undefined, '', 401); await send('', undefined, 'administrative-key', 401);
  const identity = { projectId: registered, entryId: 'main', alias: 'docs', knowledgeBaseId: base.id };
  const binding = await send('/bindings', identity);
  const operation = (operation: string, input = {}, token = tokens.owner, status = 200) => send(`/${base.id}/operations`, { ...identity, binding, operation, input }, token, status);
  const doc = await operation('knowledge.createDocument', { title: 'Guide', markdown: 'hello 世界' });
  assert.equal(doc.revision, 1);
  await operation('knowledge.editDocument', { documentId: doc.id, markdown: 'new', expectedRevision: 0 }, tokens.owner, 400);
  await send('/bindings', { ...identity, entryId: 'undeclared' }, tokens.owner, 403);
  await send('/bindings', { ...identity, projectId: broken }, tokens.owner, 503);
  await repository.grant(owner, base.id, reader, 'read');
  await send('/bindings', identity, tokens.reader, 403);
  const readBinding = await repository.bind(reader, { ...identity, mode: 'read' });
  await send(`/${base.id}/operations`, { ...identity, binding: readBinding, operation: 'knowledge.getDocument', input: { documentId: doc.id } }, tokens.reader);
  await send(`/${base.id}/operations`, { ...identity, binding: readBinding, operation: 'knowledge.deleteDocument', input: { documentId: doc.id } }, tokens.reader, 403);
  member = false; await operation('knowledge.getDocument', { documentId: doc.id }, tokens.owner, 403); member = true;
  const file = await operation('files.createFile', { name: 'bytes.bin', base64: 'AP8=' });
  assert.equal((await operation('files.readFile', { fileId: file.id })).base64, 'AP8=');
  await send('/bindings', { ...identity, projectId: local });
  await repository.grant(owner, base.id, reader, 'read', true);
  await send(`/${base.id}/operations`, { ...identity, binding: readBinding, operation: 'files.readFile', input: { fileId: file.id } }, tokens.reader, 403);
  await repository.unbind(owner, registered, 'main', 'docs');
  await operation('knowledge.getDocument', { documentId: doc.id }, tokens.owner, 403);
});
