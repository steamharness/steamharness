import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebRuntime } from '../web/runtime';
import { resolveHarnessRoot } from './harness-source';

it.each(['workflow', 'conversation'] as const)('retains structured remote storage errors through the actual %s worker report', async kind => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'server-guidance-runtime-')), id = crypto.randomUUID();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/auth/me') response.end(JSON.stringify({ errCode: 0, data: { profile: { userId: 'test-user' } } }));
    else { response.writeHead(404); response.end(JSON.stringify({ errCode: 404, errMessage: 'Project or group does not exist.' })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connection = { serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, accessToken: 'fixture-private-token' };
  const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => connection);
  try {
    const coreRoot = await resolveHarnessRoot(), version = JSON.parse(await readFile(path.join(coreRoot, 'package.json'), 'utf8')).version;
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(coreRoot, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ id, name: 'storage-error-fixture', type: 'module', version: '1.0.0', devDependencies: { steamharness: version }, steamHarness: { defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:kind,root:'.',entry:'index.ts',databases:[{alias:'data',databaseId:crypto.randomUUID()}]}],  } }));
    await writeFile(path.join(directory, 'index.ts'), `
      const flow = steamharness.defineProject({ name: 'storage-error', async run(input, context) {
        await context.databases.get('data').kv.getValue('missing-key'); return { errCode: 0, errMessage: '' };
      } });
      export const executor = steamharness.defineExecutor(${kind === 'workflow' ? `{ projectType: 'workflow', defaultEntrypoint: 'main',
        entrypoints: [steamharness.defineEntrypoint({ id: 'main', title: 'Main', workflow: flow, params: [], createInput() { return {}; } })] }`
        : `{ projectType: 'conversation', workflow: flow, params: [], createInput() { return {}; } }`});
    `);
    const inspected = await runtime.inspect([directory]); expect(inspected.errors).toEqual([]);
    const report = await runtime.run({ project: { ...inspected.projects[0], uri: '' }, runId: 'failed-run', conversationId: 'fixture', args: [] }, () => undefined);
    expect(report.status).toBe('failed');
    expect(report.error?.metadata, JSON.stringify(report)).toMatchObject({ code: 'DATABASE_ACCESS_FAILED',entryId:'main',database:'data', serverUrl: connection.serverUrl, projectId: id, status: 404 });
    expect(JSON.stringify(report)).not.toContain('fixture-private-token');
  } finally {
    runtime.dispose(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
