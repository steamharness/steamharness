import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseManagement } from '../web/database-management';
import { databaseManagementRequest } from '../database-management';
import type { WebConnection } from '../web/runtime';
import path from 'node:path';

const { readManifest, generate } = vi.hoisted(() => ({ readManifest: vi.fn(), generate: vi.fn() }));
vi.mock('@steamharness/project-manifest/node', () => ({ readProjectManifestFromDirectory: readManifest }));
vi.mock('../database-management', () => ({ databaseManagementRequest: vi.fn() }));
vi.mock('../database-generation', () => ({ generateDatabases: generate }));
vi.mock('steamharness', () => ({ bindProjectKnowledgeBase: vi.fn() }));
const request = vi.mocked(databaseManagementRequest);
const projectRoot = path.resolve('project-cache-fixture');
const project = () => ({ id: 'project', entryId: 'main', projectType: 'bot', folderPath: projectRoot, entryRoot: projectRoot,
  databases: ['first', 'second'], knowledgeBases: [{ alias: 'docs', knowledgeBaseId: 'docs' }], entries: [] } as any);
const connection = { serverUrl: 'https://server.test', accessToken: 'one' };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  readManifest.mockResolvedValue({ projectId: 'project', entries: [{ entryId: 'main', type: 'bot', root: '.', databases: ['first', 'second'], knowledgeBases: [{ alias: 'docs', knowledgeBaseId: 'docs' }] }] });
  request.mockImplementation(async (_connection, endpoint, _method, _body, kind) => endpoint.startsWith('/bindings?')
    ? (kind === 'databases' ? [{ alias: 'first', databaseId: 'shared' }, { alias: 'second', databaseId: 'shared' }] : [{ alias: 'docs', knowledgeBaseId: 'docs' }]) as any
    : { name: endpoint } as any);
});
afterEach(() => vi.useRealTimers());

it('loads each binding list and resource only once, while execution checks always stay fresh', async () => {
  const management = new DatabaseManagement(project(), () => connection);
  expect((await management.state()).requirements.map(item => item.status)).toEqual(['bound', 'bound', 'bound']);
  expect(request).toHaveBeenCalledTimes(4);
  await management.state(); expect(request).toHaveBeenCalledTimes(4);
  await Promise.all([management.assertBound('first'), management.assertBound('second')]);
  expect(request).toHaveBeenCalledTimes(5);
  await management.assertBound('first'); expect(request).toHaveBeenCalledTimes(6);
  await management.dispatch({ action: 'get', fresh: true }); expect(request).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(5_001); await management.state(); expect(request).toHaveBeenCalledTimes(14);
  expect(request.mock.calls.every(call => call[5] === 15_000)).toBe(true);
});

it('invalidates on writes and account changes and cannot authorize from display cache', async () => {
  let current: WebConnection | undefined = connection;
  const management = new DatabaseManagement(project(), () => current);
  await management.state();
  generate.mockResolvedValue({ databases: [{ alias: 'first', schemaHash: 'hash' }] });
  await management.dispatch({ action: 'bind', kind: 'databases', alias: 'first', databaseId: 'shared' });
  expect(request.mock.calls.some(call => call[2] === 'POST')).toBe(true);
  expect(request).toHaveBeenCalledTimes(9);
  current = { ...connection, accessToken: 'two' }; await management.state(); expect(request).toHaveBeenCalledTimes(13);
  request.mockRejectedValueOnce(new Error('Access revoked'));
  await expect(management.assertBound('first')).rejects.toThrow('Access revoked');
  current = undefined; await expect(management.state()).rejects.toThrow('Sign in');
});

it('discards a response when the selected account changes during a read', async () => {
  let current = connection, finish!: (value: any) => void;
  request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const p = project(); p.databases = []; p.knowledgeBases = [{ alias: 'docs', knowledgeBaseId: 'docs' }];
  readManifest.mockResolvedValue({ projectId: 'project', entries: [{ entryId: 'main', type: 'bot', root: '.', databases: [], knowledgeBases: p.knowledgeBases }] });
  const pending = new DatabaseManagement(p, () => current).state();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  current = { ...connection, accessToken: 'two' }; finish([]);
  await expect(pending).rejects.toThrow('Resource access changed');
});
