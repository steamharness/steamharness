import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import pg from 'pg';
import { createDatabasesContext, createRemoteDatabaseResolver } from 'steamharness';
import { createDefaultProjectInfo } from '@steamharness/project-info';
import { AccountRepository } from '../account-db';
import { AuthService } from '../account-auth';
import { configureProjectAuthContext } from '../auth';
import { DatabaseRepository } from '../persistence';
import { Storage } from '../storage';
import { createApiRouter } from '../routes/api';

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL;
const all = { mode: 'all' as const }, none = { mode: 'none' as const };
const permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };

test('database HTTP authorization binds registered entries before upload and rechecks roles, declarations and grants', {
  skip: !databaseUrl, timeout: 30_000,
}, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `space_http_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema ${schema}`);
  const connection = new URL(databaseUrl!);
  connection.searchParams.set('options', `-c search_path=${schema}`);
  const url = connection.toString();
  const pool = new pg.Pool({ connectionString: url });
  const root = await mkdtemp(path.join(tmpdir(), 'steamharness-space-http-'));
  const accounts = new AccountRepository(url), db = new DatabaseRepository(url);
  const auth = new AuthService({ databaseUrl: url, accountDb: accounts });
  const storage = new Storage({ db, dataRoot: root, serverRoot: process.cwd(), repoRoot: process.cwd() });
  const server = createServer();
  try {
    await accounts.init(); await storage.init();
    const bootstrap = await auth.signInBootstrapAdmin({ email: 'admin@spaces.test', password: 'isolated-test-password' });
    const tokens: Record<string, string> = {}, users: Record<string, string> = { admin: bootstrap.user.userId };
    tokens.admin = (await accounts.createApiKey({ userId: bootstrap.user.userId, name: 'Tests', source: 'cli' })).token;
    for (const name of ['owner', 'consumer', 'guest']) {
      const invitation = await auth.inviteUser({ email: `${name}@spaces.test`, redirectTo: 'https://spaces.test' });
      const session = await auth.acceptInvitation({ token: new URL(invitation.invitationLink!).pathname.split('/').at(-1)!, password: 'isolated-test-password' });
      users[name] = session.user.userId;
      tokens[name] = (await accounts.createApiKey({ userId: session.user.userId, name: 'Tests', source: 'cli' })).token;
    }
    const actor = (name: string) => ({ userId: users[name]!, isSystemAdmin: name === 'admin' });
    const a = randomUUID(), b = randomUUID();
    const entry = (entryId: string, alias = 'data') => ({ entryId, type: 'workflow' as const, name: entryId, root: '.', entry: 'index.ts', databases: [{ alias, host: 'server' as const, permissions }] });
    await storage.createProject({ projectId: a, projectName: 'Owner project', entries: [entry('database'), entry('limited')], defaultEntry: 'database', projectInfo: createDefaultProjectInfo(), ownerUserId: users.owner });
    await storage.createProject({ projectId: b, projectName: 'Consumer project', entries: [entry('agent')], defaultEntry: 'agent', projectInfo: createDefaultProjectInfo(), ownerUserId: users.consumer });
    await db.access.setMember('project', a, users.guest!, 'guest', actor('owner'));
    configureProjectAuthContext({ authService: auth, accountDb: accounts, dataDir: root });
    const app = express(); app.use('/api', createApiRouter(storage)); server.on('request', app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (user: string | undefined, endpoint: string, body?: unknown) => fetch(`${base}/api${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tokens[user]}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const send = async (user: string, endpoint: string, body?: unknown, status = 200) => {
      const response = await request(user, endpoint, body), payload = await response.json();
      assert.equal(response.status, status, JSON.stringify(payload));
      return payload.data;
    };
    assert.equal((await request(undefined, '/database-spaces')).status, 401);
    assert.equal((await request('guest', '/database-spaces/requests', { projectId: a, entryId: 'database', alias: 'data', permissions, target: { kind: 'create', name: 'Denied' } })).status, 403);
    const pending = await send('owner', '/database-spaces/requests', { projectId: a, entryId: 'database', alias: 'data', permissions, target: { kind: 'create', name: 'Shared data' } });
    assert.equal(pending.status, 'pending');
    assert.equal((await send('admin', '/database-spaces')).spaces.length, 0);
    assert.equal((await send('owner', `/database-spaces/consumers/${a}/database`))[0].status, 'unbound');
    assert.equal((await request('owner', '/database-spaces/requests', { projectId: a, entryId: 'database', alias: 'data', permissions, target: { kind: 'create', name: 'Duplicate' } })).status, 400);
    await send('owner', `/database-spaces/requests/${pending.requestId}/review`, { approve: true }, 400);
    const approved = await send('admin', `/database-spaces/requests/${pending.requestId}/review`, { approve: true });
    await send('admin', `/database-spaces/requests/${pending.requestId}/review`, { approve: true }, 400);
    await send('owner', `/database-spaces/bindings/${approved.bindingRef}/bind`, { projectId: a, entryId: 'database', alias: 'data' });
    const binding = await send('owner', `/database-spaces/bindings/${approved.bindingRef}?projectId=${a}&entryId=database`);
    assert.equal(binding.space.ownerId, users.owner);
    const spaceId = binding.space.spaceId;
    const open = (user: string, projectId: string, entryId: string, bindingRef: string) => createDatabasesContext({ projectId, entryId, conversationId: 'thread', requirements: [{ alias: 'data', host: 'server', bindingRef, permissions }], resolver: createRemoteDatabaseResolver({ serverUrl: base, token: tokens[user]! }) }).get('data');
    const x = open('owner', a, 'database', approved.bindingRef);
    await x.kv.setValue('shared', 1);
    await x.kv.setValue('public:a', 1);
    await x.kv.setValue('public:b', 2);
    const narrowedClient = createDatabasesContext({ projectId: a, entryId: 'database', requirements: [{
      alias: 'data', host: 'server', bindingRef: approved.bindingRef,
      permissions: { ...permissions, kv: { read: { mode: 'prefixes', prefixes: ['public:'] }, write: none } },
    }], resolver: createRemoteDatabaseResolver({ serverUrl: base, token: tokens.owner! }) }).get('data');
    const firstPage = await narrowedClient.listValues({ pageSize: 1 });
    assert.equal(firstPage.total, 2);
    assert.deepEqual(firstPage.items.map(item => item.key), ['public:a']);
    assert.deepEqual((await narrowedClient.listValues({ cursor: firstPage.nextCursor })).items.map(item => item.key), ['public:b']);
    assert.equal((await narrowedClient.listValues({ query: 'shared' })).total, 0);
    const list = { projectId: a, entryId: 'database', alias: 'data', bindingRef: approved.bindingRef, credentialVersion: 1, operation: 'list', entry: { spaceId, storageKind: 'kv', scope: 'project', key: '*' } };
    for (const keyPrefixes of [null, 'public:', [1], [''], ['bad\0prefix'], ['x'.repeat(1025)], Array(1025).fill('public:')]) {
      await send('owner', `/database-spaces/${spaceId}/data`, { ...list, keyPrefixes }, 400);
    }
    await send('owner', `/database-spaces/${spaceId}/data`, { ...list, keyPrefixes: [] }, 403);
    const guest = open('guest', a, 'database', approved.bindingRef);
    assert.equal(await guest.kv.getValue('shared'), 1);
    await assert.rejects(guest.kv.setValue('shared', 2), /Permission denied/);
    await assert.rejects(guest.knowledge.createDocument({ id: 'denied', title: 'Denied', markdown: 'Denied' }), /Permission denied/);
    await assert.rejects(open('consumer', a, 'database', approved.bindingRef).kv.getValue('shared'), /Permission denied/);
    await send('owner', `/database-spaces/bindings/${approved.bindingRef}/bind`, { projectId: a, entryId: 'limited', alias: 'data' }, 400);
    const sharing = await send('consumer', '/database-spaces/requests', { projectId: b, entryId: 'agent', alias: 'data', permissions, target: { kind: 'access', spaceId } });
    await send('consumer', `/database-spaces/requests/${sharing.requestId}/review`, { approve: true }, 400);
    const shared = await send('owner', `/database-spaces/requests/${sharing.requestId}/review`, { approve: true });
    await send('consumer', `/database-spaces/bindings/${shared.bindingRef}/bind`, { projectId: b, entryId: 'agent', alias: 'data' });
    const y = open('consumer', b, 'agent', shared.bindingRef);
    assert.equal(await y.kv.getValue('shared'), 1);
    await y.knowledge.createDocument({ id: 'shared-document', title: 'Shared', markdown: 'Shared text' });
    assert.equal((await x.knowledge.getDocument('shared-document'))?.markdown, 'Shared text');
    const revision = await x.getRevision();
    const file = await y.knowledge.files.createFile({ name: 'shared.txt', buffer: Buffer.from('shared bytes') });
    assert.notEqual(await x.getRevision(), revision);
    const retained = await x.knowledge.files.readFile(file.id);
    assert.equal((await retained.readBuffer()).toString(), 'shared bytes');
    // A previously approved grant cannot exceed a later declaration, even through raw HTTP.
    await pool.query('UPDATE projects SET entries=$2::jsonb WHERE id=$1', [b, JSON.stringify([{ ...entry('agent'), databases: [{ alias: 'data', host: 'server', permissions: { ...permissions, kv: { read: { mode: 'prefixes', prefixes: ['public:'] }, write: none } } }] }])]);
    await assert.rejects(y.kv.getValue('shared'), /does not allow/);
    const raw = { projectId: b, entryId: 'agent', alias: 'data', bindingRef: shared.bindingRef, credentialVersion: 1, operation: 'set', entry: { spaceId, storageKind: 'kv', scope: 'project', key: 'shared' }, value: 2 };
    await send('consumer', `/database-spaces/${spaceId}/data`, raw, 403);
    assert.equal((await y.listValues()).total, 2);
    const restrictedList = await send('consumer', `/database-spaces/${spaceId}/data`, { ...raw, operation: 'list', keyPrefixes: ['shared', 'public:'] });
    assert.equal(restrictedList.total, 2);
    assert.deepEqual(restrictedList.items.map((item: { key: string }) => item.key), ['public:a', 'public:b']);
    await pool.query('UPDATE projects SET entries=$2::jsonb WHERE id=$1', [b, JSON.stringify([entry('agent')])]);
    await send('owner', `/database-spaces/grants/${(await y.getBinding()).grant.grantId}/narrow`, { permissions: { ...permissions, kv: { read: all, write: none } } });
    await assert.rejects(y.kv.setValue('shared', 3), /does not allow/);
    await send('owner', `/database-spaces/grants/${(await y.getBinding()).grant.grantId}/rotate`, {});
    await send('consumer', `/database-spaces/${spaceId}/data`, { ...raw, operation: 'get' }, 403);
    await send('owner', `/database-spaces/grants/${(await y.getBinding()).grant.grantId}/revoke`, {});
    await assert.rejects(y.kv.getValue('shared'), /revoked/);
    assert.equal((await send('consumer', `/database-spaces/consumers/${b}/agent`))[0].status, 'invalid');
    const retry = await send('consumer', '/database-spaces/requests', { projectId: b, entryId: 'agent', alias: 'data', permissions, target: { kind: 'access', spaceId } });
    await send('owner', `/database-spaces/requests/${retry.requestId}/review`, { approve: false, reason: 'No longer required' });
    assert.equal((await send('consumer', '/database-spaces')).requests.find((item: { requestId: string }) => item.requestId === retry.requestId).status, 'rejected');
    await storage.deleteProject(a, actor('owner'));
    assert.equal((await send('owner', '/database-spaces')).spaces[0].spaceId, spaceId);
    const management = await storage.databases.managementDatabase(spaceId, actor('owner'));
    assert.equal((await (await management.knowledge.files.readFile(file.id)).readBuffer()).toString(), 'shared bytes');
  } finally {
    configureProjectAuthContext({});
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await storage.close(); await auth.close(); await accounts.close(); await pool.end();
    await admin.query(`drop schema ${schema} cascade`); await admin.end(); await rm(root, { recursive: true, force: true });
  }
});
