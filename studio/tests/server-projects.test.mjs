import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { register } from 'tsx/esm/api';
register();
const { ProjectServerClient } = await import('../extensions/studio-workstation/src/steamharness-server-projects.ts');
const { downloadServerProject, uploadServerProject, runWorkspaceTransfer, allocateServerProjectId } = await import('../extensions/studio-workstation/src/steamharness-server-projects-node.ts');
const { configureLocalization } = await import('../extensions/studio-workstation/src/localization.ts');
const id = '784af2d9-240a-45d1-a659-452a21867934';
const dependencyId = '4c8bed84-e667-446e-860d-663caa5c3587';
const entriesFor = (type='workflow') => [{entryId:'main',name:'Main',type,root:'.',entry:type==='kanban'?'index.html':'index.ts',databases:[]}];
const signal = () => new AbortController().signal;

async function fixture(t, configuration = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-transfer-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { name: 'demo', version: '1.2.3', entries:entriesFor(), ...configuration };
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({id,name:config.name,version:config.version,steamHarness:{entries:config.entries,defaultEntry:'main'}}));
  const cliEntry = path.join(directory, 'cli.mjs');
  await fs.writeFile(cliEntry, `
    import * as fs from 'node:fs/promises'; import path from 'node:path';
    const args = process.argv.slice(2), config = JSON.parse(await fs.readFile('config.json', 'utf8'));
    await fs.writeFile('request.json', JSON.stringify({ args, server: process.env.STEAMHARNESS_SERVER_URL, token: process.env.STEAMHARNESS_SERVER_ADMIN_KEY, nodeOptions: process.env.NODE_OPTIONS, packs: process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR }));
    if (config.failure) { console.error(process.env.STEAMHARNESS_SERVER_ADMIN_KEY + ' denied'); process.exit(1); }
    if (args.includes('upload')) { console.log(JSON.stringify({errCode: 0, data: { jobId: 'job-1' }})); }
    else {
      const root = args[args.indexOf('--path') + 1];
      await fs.mkdir(root,{recursive:true});
      await fs.writeFile(path.join(root,'package.json'),JSON.stringify({id:config.wrongId||'${id}',name:config.name,version:config.version,steamHarness:{entries:config.entries,defaultEntry:'main'}}));
      await fs.writeFile(path.join(root,'index.ts'),"throw new Error('Source must not execute');");
      await fs.writeFile(path.join(root,'image.bin'),Buffer.from([0,1,255]));
      for(const entry of config.entries){const target=path.join(root,entry.root,entry.entry);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,entry.type==='kanban'?'<html>Board</html>':"throw new Error('Source must not execute');");}
      if (config.delay) { await new Promise(resolve => setTimeout(resolve, 10000)); }
      console.log(JSON.stringify({errCode: 0, data: {projectId:'${id}',path:config.complete===false?undefined:root}}));
    }
  `);
  const progress = [];
  return { directory, cliEntry, progress, options: { cliEntry, runtimeDirectory: directory, nodePath: process.execPath,
    connection: { serverUrl: 'https://steamharness.test', accessToken: 'host-secret-token' },
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
  const client = new ProjectServerClient({ serverUrl: 'https://steamharness.test/', accessToken: 'host-token' }, async (url, options) => {
    reads.push({ url, options }); return Response.json({ errCode: 0, data: {items:[],total:0,page:1,pageSize:100} });
  });
  await client.projects(signal());
  assert.equal(reads[0].url, 'https://steamharness.test/api/projects?page=1&pageSize=100');
  assert.equal(reads[0].options.headers.Authorization, 'Bearer host-token');
  assert.equal(reads[0].options.redirect, 'error');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(client.versions(id, cancelled.signal), { name: 'AbortError' });
  assert.equal(reads.length, 1);
});

for (const projectType of ['workflow', 'conversation', 'kanban']) test(`new ${projectType} projects receive a Server-assigned UUID privately without uploading or publishing source`, async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-register-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const projectInfo = { localizedNames: { en: 'Created' }, declarations: [], platformSupport: { mode: 'agnostic' } };
  const projectCard = { icon: projectType === 'workflow' ? 'workflow' : projectType === 'conversation' ? 'message-circle' : 'boxes', iconColor: '#ffffff', iconBackgroundColor: '#123456' };
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ id, steamHarness:{entries:entriesFor(projectType),defaultEntry:'main',projectInfo,projectCard} }));
  await fs.writeFile(path.join(directory, 'index.ts'), "throw new Error('Registration must not read or execute source');");
  const http = await server(t, () => ({ data: { projectId:id,entries:entriesFor(projectType),defaultEntry:'main' } }));
  let checks = 0;
  const options = { project: {name:'Created',entries:entriesFor(projectType),defaultEntry:'main',projectInfo,projectCard},
    connection: { serverUrl: http.url, accessToken: 'registration-test-token' }, signal: signal(), assertCurrent: () => { checks++; } };
  await allocateServerProjectId(options); await allocateServerProjectId(options);
  assert.equal(checks, 4); assert.equal(http.requests.length, 2);
  for (const request of http.requests) {
    assert.equal(request.url, '/api/projects'); assert.equal(request.method, 'POST');
    assert.equal(request.auth, 'Bearer registration-test-token');
    assert.deepEqual(JSON.parse(request.body), {name:'Created',entries:entriesFor(projectType),defaultEntry:'main',visibility:'private',projectInfo,projectCard});
  }
  await assert.rejects(allocateServerProjectId({ ...options, assertCurrent: () => { throw new Error('account changed'); } }), /account changed/);
  await assert.rejects(allocateServerProjectId({ ...options, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(http.requests.length, 2);
});

test('registration rejects permission errors and an unexpected server identity', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-register-failed-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ id, steamHarness: { entries:entriesFor(),defaultEntry:'main',projectInfo:{platformSupport:{mode:'agnostic'}} } }));
  let forbidden = true;
  const http = await server(t, () => forbidden ? { status: 403, payload: { errCode: 403, errMessage: 'denied' } } : { data: { projectId:'111',entries:entriesFor(),defaultEntry:'main' } });
  const options = { project: { name:'Created',entries:entriesFor(),defaultEntry:'main',projectInfo:{platformSupport:{mode:'agnostic'}} }, connection: { serverUrl: http.url, accessToken: 'test-token' }, signal: signal(), assertCurrent() {} };
  await assert.rejects(allocateServerProjectId(options), error => error.status === 403);
  forbidden = false; await assert.rejects(allocateServerProjectId(options), /unexpected project/);
});

test('API errors redact credentials and retain permission status', async () => {
  const client = new ProjectServerClient({ serverUrl: 'https://steamharness.test', accessToken: 'private-token' }, async () => Response.json({ errCode: 403, errMessage: 'private-token forbidden' }, { status: 403 }));
  await assert.rejects(client.projects(signal()), error => error.status === 403 && error.message === 'Your project or group role does not allow this operation.' && !error.message.includes('private-token'));
});

test('malformed API envelopes produce a readable error', async () => {
  const client = new ProjectServerClient({ serverUrl: 'https://steamharness.test', accessToken: 'private-token' }, async () => Response.json(null));
  await assert.rejects(client.projects(signal()), /invalid response/);
});

test('cancelling while reading the API body retains cancellation semantics', async () => {
  const controller = new AbortController();
  const client = new ProjectServerClient({ serverUrl: 'https://steamharness.test', accessToken: 'private-token' }, async () => ({
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

test('a downloaded aggregate retains all registered entry files in one install directory', async t => {
 const entries=[...entriesFor(),{entryId:'chat',type:'conversation',name:'Chat',root:'chat',entry:'index.ts',databases:[]},{entryId:'board',type:'kanban',name:'Board',root:'board',entry:'dist/index.html',databases:[]}];
 const f=await fixture(t,{entries});const result=await downloadServerProject(f.options);
 assert.equal(result.length,1);const pkg=JSON.parse(await fs.readFile(path.join(result[0].directory,'package.json'),'utf8'));
 assert.deepEqual(pkg.steamHarness.entries,entries);await fs.access(path.join(result[0].directory,'board/dist/index.html'));
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
    : request.url.endsWith('/configurations?target=draft') ? {data:{publicationRevision:4}}
    : request.method === 'POST' ? { data: { version: '1.2.3' } }
      : { data: { jobId: 'job-1', projectId: id, status: ++polls === 1 ? 'preparing' : 'success', stage: 'validating', result: { projectId: id, sourceHash: 'a'.repeat(64) } } });
  await uploadServerProject({ ...f.options, directory: f.directory, releaseLog: 'New version', connection: { ...f.options.connection, serverUrl: remote.url } });
  assert.equal(remote.requests.at(-1).url, `/api/projects/${id}/publish`);
  assert.deepEqual(JSON.parse(remote.requests.at(-1).body), { releaseLog: 'New version', expectedVersion: '1.2.3', expectedSourceHash: 'a'.repeat(64),expectedConfigurationRevisions:{main:4} });
  assert.ok(remote.requests.every(request => request.auth === 'Bearer host-secret-token'));
  assert.ok(f.progress.includes('Validating project files'));
  const request = JSON.parse(await fs.readFile(path.join(f.directory, 'request.json'), 'utf8'));
  assert.equal(request.args.includes('--create'), false);
  assert.equal(request.args.includes('--no-wait'), true);
  await assert.rejects(fs.stat(request.packs), { code: 'ENOENT' });
});

test('uploading an unregistered ID guides reapplication without creating a project or uploading files', async t => {
  const f = await fixture(t);
  const remote = await server(t, () => ({ status: 404, payload: { errCode: 404 } }));
  await assert.rejects(uploadServerProject({ ...f.options, directory: f.directory, releaseLog: '', connection: { ...f.options.connection, serverUrl: remote.url } }), /apply for a new application ID/);
  assert.ok(remote.requests.every(request => request.method === 'GET'));
  await assert.rejects(fs.stat(path.join(f.directory, 'request.json')), { code: 'ENOENT' });
});

test('a failed source preparation never publishes a registered project', async t => {
  const f = await fixture(t);
  const remote = await server(t, request => request.url.endsWith('/versions') ? { data: [] } : { data: { jobId: 'job-1', projectId: id, status: 'failed', failureReason: 'Invalid source metadata' } });
  await assert.rejects(uploadServerProject({ ...f.options, directory: f.directory, releaseLog: '', connection: { ...f.options.connection, serverUrl: remote.url } }), /Invalid source metadata/);
  assert.ok(remote.requests.every(request => request.method === 'GET'));
  const request = JSON.parse(await fs.readFile(path.join(f.directory, 'request.json'), 'utf8'));
  assert.equal(request.args.includes('--create'), false);
  await assert.rejects(fs.stat(request.packs), { code: 'ENOENT' });
});

test('a concurrent draft replacement rejects publication without retrying another snapshot', async t => {
  const f = await fixture(t);
  const remote = await server(t, request => request.url.endsWith('/versions') ? { data: { versions: [] } }
    : request.method === 'POST' ? { status: 409, payload: { errCode: 409, errMessage: 'Project draft changed after preparation.' } }
      : { data: { status: 'success', result: { projectId: id, sourceHash: 'a'.repeat(64) } } });
  await assert.rejects(uploadServerProject({ ...f.options, directory: f.directory, releaseLog: '', connection: { ...f.options.connection, serverUrl: remote.url } }), /draft changed/);
  assert.equal(remote.requests.filter(request => request.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(remote.requests.at(-1).body), { releaseLog: '', expectedVersion: '1.2.3', expectedSourceHash: 'a'.repeat(64),expectedConfigurationRevisions:{main:0} });
});

test('a preparation without matching upload identity cannot publish', async t => {
  const f = await fixture(t);
  const remote = await server(t, request => request.url.endsWith('/versions') ? { data: { versions: [] } }
    : { data: { status: 'success', result: { projectId: dependencyId, sourceHash: 'a'.repeat(64) } } });
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
