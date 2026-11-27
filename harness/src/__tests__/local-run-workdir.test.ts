import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLocalProjectWithReport } from '../executor';

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
