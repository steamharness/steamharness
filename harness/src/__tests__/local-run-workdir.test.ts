import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLocalProjectWithReport } from '../executor';
import { withPlatformConnections } from '../platform-connections';
import { readEntrypointOutput } from '../workflow';

test('two standalone SDK scripts use independent working directories without changing the host cwd', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sh-run-cwd-'))), original = process.cwd();
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'user'); await mkdir(home);
  const before = [process.env.HOME, process.env.USERPROFILE, process.env.STEAMHARNESS_LOCAL_ACCOUNT_KEY];
  process.env.HOME = process.env.USERPROFILE = home; delete process.env.STEAMHARNESS_LOCAL_ACCOUNT_KEY;
  t.after(() => { for (const [i, key] of ['HOME','USERPROFILE','STEAMHARNESS_LOCAL_ACCOUNT_KEY'].entries()) {
    if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i];
  } });
  const run = async (explicit: boolean) => {
    const id = randomUUID(), source = path.join(root, id), data = path.join(home, '.steamharness/accounts/local/projects', id);
    const workdir = explicit ? path.join(root, 'selected') : undefined;
    if (workdir) await mkdir(workdir);
    await mkdir(source); await writeFile(path.join(source, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(source, 'steamharness.json'), JSON.stringify({ id, version:'1.0.0', name:'Working directory', defaultEntry:'main', entries:[{ entryId:'main', name:'Main', type:'workflow', root:'.', entry:'index.ts' }] }));
    await writeFile(path.join(source, 'index.ts'), `import { writeFile } from 'node:fs/promises';
      const job = steamharness.defineProject({name:'workdir', async run() { await writeFile('plan.md', process.cwd()); return {errCode:0,errMessage:''}; }});
      export const executor = steamharness.defineExecutor({projectType:'workflow',defaultEntrypoint:'main',entrypoints:[steamharness.defineEntrypoint({id:'main',title:'Run',workflow:job,createInput(){return {};}})]});`);
    const report = await runLocalProjectWithReport({ projectDir: source, workdir });
    assert.equal(report.status, 'success', JSON.stringify(report.error));
    assert.equal(await readFile(path.join(workdir ?? data, 'plan.md'), 'utf8'), workdir ?? data);
    await assert.rejects(stat(path.join(source, 'plan.md')), { code:'ENOENT' });
    assert.ok((await stat(path.join(data, 'entries/main/configurations'))).isDirectory());
  };
  await Promise.all([run(false), run(true)]); assert.equal(process.cwd(), original);
});

test('an in-process SDK host keeps concurrent project accounts separate; AI alone uses local', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sh-account-cwd-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  const previous = process.env.STEAMHARNESS_LOCAL_ACCOUNT_KEY;
  delete process.env.STEAMHARNESS_LOCAL_ACCOUNT_KEY;
  t.after(() => { if (previous !== undefined) process.env.STEAMHARNESS_LOCAL_ACCOUNT_KEY = previous; });
  const verified: string[] = [];
  const serverUrl = 'https://example.test';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, `${serverUrl}/api/auth/me`);
    const userId = new Headers(init.headers).get('Authorization')?.slice(7);
    assert.ok(userId); verified.push(userId);
    return Response.json({ errCode: 0, data: { profile: { userId } } });
  });
  const projectId = randomUUID(), source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(source, 'steamharness.json'), JSON.stringify({ id: projectId, version: '1.0.0', name: 'Account cwd', defaultEntry: 'main', entries: [{ entryId: 'main', name: 'Main', type: 'workflow', root: '.', entry: 'index.ts' }] }));
  await writeFile(path.join(source, 'index.ts'), `const job = steamharness.defineProject({name:'account-cwd', async run(input, context) {
      await context.tokenUsage.report({inputTokens:1,outputTokens:1,totalTokens:2}); return {errCode:0,errMessage:'',workdir:context.metadata.executionWorkdir}; }});
    export const executor = steamharness.defineExecutor({projectType:'workflow',defaultEntrypoint:'main',entrypoints:[steamharness.defineEntrypoint({id:'main',title:'Run',workflow:job,tokenUsage:{enabled:true},createInput(){return {};}})]});`);
  await Promise.all(['one', 'two', 'ai-only'].map(async id => {
    const ai = { serverUrl, accessToken: 'model-credential' };
    const account = id === 'ai-only' ? 'local' : createHash('sha256').update(JSON.stringify([serverUrl, id])).digest('hex');
    const expected = path.join(root, '.steamharness', 'accounts', account, 'projects', projectId);
    const report = await withPlatformConnections(id === 'ai-only' ? { ai } : { ai, project: { serverUrl, accessToken: id } }, () =>
      runLocalProjectWithReport({ projectDir: source, onRuntimeEvent() {}, conversationId: 'same' }));
    assert.ok(report.result.ok, JSON.stringify(report.result));
    assert.equal((readEntrypointOutput(report.result.data) as { workdir: string }).workdir, expected);
    for (const directory of ['runtime', 'configurations']) assert.ok((await stat(path.join(expected, 'entries', 'main', directory))).isDirectory());
  }));
  assert.deepEqual(verified.sort(), ['one', 'two']);
});
