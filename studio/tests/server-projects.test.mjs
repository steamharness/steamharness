import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { register } from 'tsx/esm/api';
register();
const { WorkflowProjectServerClient } = await import('../extensions/studio-workstation/src/workflow-server-projects.ts');
const { downloadServerProject, uploadServerProject, runWorkspaceTransfer } = await import('../extensions/studio-workstation/src/workflow-server-projects-node.ts');
const { configureLocalization } = await import('../extensions/studio-workstation/src/localization.ts');
const id = '784af2d9-240a-45d1-a659-452a21867934';
const dependencyId = '4c8bed84-e667-446e-860d-663caa5c3587';
const signal = () => new AbortController().signal;

async function fixture(t, configuration = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-transfer-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { name: 'demo', version: '1.2.3', projects: [{ projectId: id, projectName: 'demo', role: 'root', version: '1.2.3' }], ...configuration };
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
  const cliEntry = path.join(directory, 'cli.mjs');
  await fs.writeFile(cliEntry, `
    import * as fs from 'node:fs/promises'; import path from 'node:path';
    const args = process.argv.slice(2), config = JSON.parse(await fs.readFile('config.json', 'utf8'));
    await fs.writeFile('request.json', JSON.stringify({ args, server: process.env.WORKFLOW_SERVER_URL, token: process.env.WORKFLOW_SERVER_ADMIN_KEY, nodeOptions: process.env.NODE_OPTIONS, packs: process.env.WORKFLOW_WORKSPACE_PACKS_DIR }));
    if (config.failure) { console.error(process.env.WORKFLOW_SERVER_ADMIN_KEY + ' denied'); process.exit(1); }
    if (args.includes('upload')) { console.log(JSON.stringify({errCode: 0, data: { jobId: 'job-1' }})); }
    else {
      const root = args[args.indexOf('--path') + 1], projects = [];
      for (const project of config.projects) {
        const destination = project.role === 'root' ? root : path.join(path.dirname(root), 'dependency');
        await fs.mkdir(destination, {recursive: true});
        await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify({ id: config.wrongId || project.projectId, name: project.projectName, version: project.version }));
        await fs.writeFile(path.join(destination, 'index.ts'), "throw new Error('Source must not execute');");
        await fs.writeFile(path.join(destination, 'image.bin'), Buffer.from([0, 1, 255]));
        projects.push({...project, path: destination, alreadyAvailable: false});
      }
      if (config.delay) { await new Promise(resolve => setTimeout(resolve, 10000)); }
      console.log(JSON.stringify({errCode: 0, data: {rootProjectId: '${id}', rootVersion: config.version, complete: config.complete !== false, projects}}));
    }
  `);
  const progress = [];
  return { directory, cliEntry, progress, options: { cliEntry, runtimeDirectory: directory, nodePath: process.execPath,
    connection: { serverUrl: 'https://workflow.test', accessToken: 'host-secret-token' },
    signal: signal(), progress: value => progress.push(value.message), projectId: id, version: '1.2.3', parentDirectory: path.join(directory, 'projects') } };
}

async function server(t, handler) {
  const requests = [];
  const http = createServer(async (request, response) => {
    const body = []; for await (const chunk of request) { body.push(chunk); }
    requests.push({ url: request.url, method: request.method, auth: request.headers.authorization, body: Buffer.concat(body).toString() });
    const result = handler(request);
    response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.payload ?? { errCode: 0, data: result.data }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  return { url: `http://127.0.0.1:${http.address().port}`, requests };
}

test('project API reads use the host account, host language and cancellable requests', async () => {
  const reads = [];
  const client = new WorkflowProjectServerClient({ serverUrl: 'https://workflow.test/', accessToken: 'host-token' }, async (url, options) => {
    reads.push({ url, options }); return Response.json({ errCode: 0, data: [] });
  });
  await client.projects(signal());
  assert.equal(reads[0].url, 'https://workflow.test/api/workflows');
  assert.equal(reads[0].options.headers.Authorization, 'Bearer host-token');
  assert.equal(reads[0].options.redirect, 'error');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(client.versions(id, cancelled.signal), { name: 'AbortError' });
  assert.equal(reads.length, 1);
});

test('API errors redact credentials and retain permission status', async () => {
  const client = new WorkflowProjectServerClient({ serverUrl: 'https://workflow.test', accessToken: 'private-token' }, async () => Response.json({ errCode: 403, errMessage: 'private-token forbidden' }, { status: 403 }));
  await assert.rejects(client.projects(signal()), error => error.status === 403 && error.message === '[redacted] forbidden');
});

test('malformed API envelopes produce a readable error', async () => {
  const client = new WorkflowProjectServerClient({ serverUrl: 'https://workflow.test', accessToken: 'private-token' }, async () => Response.json(null));
  await assert.rejects(client.projects(signal()), /invalid response/);
});

test('cancelling while reading the API body retains cancellation semantics', async () => {
  const controller = new AbortController();
  const client = new WorkflowProjectServerClient({ serverUrl: 'https://workflow.test', accessToken: 'private-token' }, async () => ({
    status: 200, ok: true, json: async () => { controller.abort(); throw controller.signal.reason; },
  }));
  await assert.rejects(client.projects(controller.signal), { name: 'AbortError' });
});

test('downloads preserve bytes and source without executing it, and every repeat gets a new version directory', async t => {
  const f = await fixture(t);
  const first = await downloadServerProject(f.options);
  const second = await downloadServerProject(f.options);
  assert.equal(path.basename(first[0].directory), 'demo-1.2.3');
  assert.equal(path.basename(second[0].directory), 'demo-1.2.3-2');
  assert.deepEqual(await fs.readFile(path.join(first[0].directory, 'image.bin')), Buffer.from([0, 1, 255]));
  assert.match(await fs.readFile(path.join(first[0].directory, 'index.ts'), 'utf8'), /must not execute/);
  assert.deepEqual((await fs.readdir(f.options.parentDirectory)).sort(), ['demo-1.2.3', 'demo-1.2.3-2']);
  const request = JSON.parse(await fs.readFile(path.join(f.directory, 'request.json'), 'utf8'));
  assert.equal(request.token, f.options.connection.accessToken);
  assert.equal(request.server, f.options.connection.serverUrl);
  assert.equal(request.args.includes(f.options.connection.accessToken), false);
  assert.ok(request.args.includes('--target'));
});

test('version downloads reserve directories atomically and do not reuse another version by UUID', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.options.parentDirectory, 'demo-1.2.3'), { recursive: true });
  await fs.writeFile(path.join(f.options.parentDirectory, 'demo-1.2.3', 'keep.txt'), 'keep');
  const results = await Promise.all([downloadServerProject(f.options), downloadServerProject(f.options)]);
  assert.equal(new Set(results.map(result => result[0].directory)).size, 2);
  assert.equal(await fs.readFile(path.join(f.options.parentDirectory, 'demo-1.2.3', 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual((await fs.readdir(f.options.parentDirectory)).sort(), ['demo-1.2.3', 'demo-1.2.3-2', 'demo-1.2.3-3']);
});

test('project groups keep each dependency version in its own portable directory', async t => {
  const f = await fixture(t, { projects: [{ projectId: id, projectName: '@scope/demo', role: 'root', version: '1.2.3' },
    { projectId: dependencyId, projectName: 'knowledge', role: 'dependency', version: '2.0.0' }] });
  const result = await downloadServerProject(f.options);
  assert.deepEqual(result.map(project => path.basename(project.directory)), ['scope-demo-1.2.3', 'knowledge-2.0.0']);
  assert.equal(result[1].version, '2.0.0');
});

for (const configuration of [{ wrongId: dependencyId }, { complete: false }]) {
  test(`invalid or incomplete downloads leave no partial version: ${JSON.stringify(configuration)}`, async t => {
    const f = await fixture(t, configuration);
    await assert.rejects(downloadServerProject(f.options));
    assert.deepEqual(await fs.readdir(f.options.parentDirectory), []);
  });
}

test('cancelling a download stops its CLI and removes temporary files', async t => {
  const f = await fixture(t, { delay: true });
  const controller = new AbortController();
  const downloading = downloadServerProject({ ...f.options, signal: controller.signal });
  const rejection = assert.rejects(downloading, { name: 'AbortError' });
  for (let attempt = 0;; attempt++) {
    try { await fs.access(path.join(f.directory, 'request.json')); break; }
    catch { assert.ok(attempt < 100); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  controller.abort(); await rejection;
  assert.deepEqual(await fs.readdir(f.options.parentDirectory), []);
});

test('CLI failure messages cannot disclose the host token', async t => {
  const f = await fixture(t, { failure: true });
  await assert.rejects(runWorkspaceTransfer(f.options, ['download', id], f.directory), error => error.message.includes('[redacted]') && !error.message.includes(f.options.connection.accessToken));
});

test('upload waits for static preparation and only then publishes release notes', async t => {
  const f = await fixture(t);
  let polls = 0;
  const remote = await server(t, request => request.url.endsWith('/versions') ? { data: { versions: [] } }
    : request.method === 'POST' ? { data: { version: '1.2.3' } }
      : { data: { jobId: 'job-1', workflowId: id, status: ++polls === 1 ? 'preparing' : 'success', stage: 'validating', result: { workflowId: id, sourceHash: 'a'.repeat(64) } } });
  await uploadServerProject({ ...f.options, directory: f.directory, releaseLog: 'New version', connection: { ...f.options.connection, serverUrl: remote.url } });
  assert.equal(remote.requests.at(-1).url, `/api/workflows/${id}/publish`);
  assert.deepEqual(JSON.parse(remote.requests.at(-1).body), { releaseLog: 'New version', expectedVersion: '1.2.3', expectedSourceHash: 'a'.repeat(64) });
  assert.ok(remote.requests.every(request => request.auth === 'Bearer host-secret-token'));
  assert.ok(f.progress.includes('Validating project files'));
  const request = JSON.parse(await fs.readFile(path.join(f.directory, 'request.json'), 'utf8'));
  assert.equal(request.args.includes('--create'), false);
  assert.equal(request.args.includes('--no-wait'), true);
  await assert.rejects(fs.stat(request.packs), { code: 'ENOENT' });
});

test('a new project requests creation and a failed preparation never publishes', async t => {
  const f = await fixture(t);
  const remote = await server(t, request => request.url.endsWith('/versions') ? { status: 404, payload: { errCode: 404 } }
    : { data: { jobId: 'job-1', workflowId: id, status: 'failed', failureReason: 'Invalid source metadata' } });
  await assert.rejects(uploadServerProject({ ...f.options, directory: f.directory, releaseLog: '', connection: { ...f.options.connection, serverUrl: remote.url } }), /Invalid source metadata/);
  assert.ok(remote.requests.every(request => request.method === 'GET'));
  const request = JSON.parse(await fs.readFile(path.join(f.directory, 'request.json'), 'utf8'));
  assert.ok(request.args.includes('--create'));
  await assert.rejects(fs.stat(request.packs), { code: 'ENOENT' });
});

test('a concurrent draft replacement rejects publication without retrying another snapshot', async t => {
  const f = await fixture(t);
  const remote = await server(t, request => request.url.endsWith('/versions') ? { data: { versions: [] } }
    : request.method === 'POST' ? { status: 409, payload: { errCode: 409, errMessage: 'Project draft changed after preparation.' } }
      : { data: { status: 'success', result: { workflowId: id, sourceHash: 'a'.repeat(64) } } });
  await assert.rejects(uploadServerProject({ ...f.options, directory: f.directory, releaseLog: '', connection: { ...f.options.connection, serverUrl: remote.url } }), /draft changed/);
  assert.equal(remote.requests.filter(request => request.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(remote.requests.at(-1).body), { releaseLog: '', expectedVersion: '1.2.3', expectedSourceHash: 'a'.repeat(64) });
});

test('a preparation without matching upload identity cannot publish', async t => {
  const f = await fixture(t);
  const remote = await server(t, request => request.url.endsWith('/versions') ? { data: { versions: [] } }
    : { data: { status: 'success', result: { workflowId: dependencyId, sourceHash: 'a'.repeat(64) } } });
  await assert.rejects(uploadServerProject({ ...f.options, directory: f.directory, releaseLog: '', connection: { ...f.options.connection, serverUrl: remote.url } }), /invalid response/);
  assert.ok(remote.requests.every(request => request.method === 'GET'));
});

test('Chinese transfer progress follows Studio language', async t => {
  const f = await fixture(t);
  const chinese = JSON.parse(await fs.readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8'));
  configureLocalization(chinese, 'zh-cn'); t.after(() => configureLocalization({}, 'en'));
  await downloadServerProject(f.options);
  assert.deepEqual(f.progress, ['正在下载项目版本']);
  const request = JSON.parse(await fs.readFile(path.join(f.directory, 'request.json'), 'utf8'));
  assert.equal(request.args[request.args.indexOf('--locale') + 1], 'zh-CN');
});
