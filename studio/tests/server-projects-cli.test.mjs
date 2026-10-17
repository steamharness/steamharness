import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { register } from 'tsx/esm/api';
register();
const { uploadServerProject, downloadServerProject } = await import('../extensions/studio-workstation/src/workflow-server-projects-node.ts');
const cliEntry = process.env.STUDIO_WORKSPACE_CLI;
const projectId = '784af2d9-240a-45d1-a659-452a21867934';
const dependencyId = '4c8bed84-e667-446e-860d-663caa5c3587';

function sourceHash(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(file.path); hash.update('\0');
    hash.update(file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content); hash.update('\0');
  }
  return hash.digest('hex');
}

for (const projectType of ['workflow', 'conversation', 'kanban']) {
  test(`real workspace CLI uploads and downloads ${projectType} versions`, { skip: !cliEntry }, async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-real-cli-transfer-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, 'source'); await fs.mkdir(source);
    const relation = (alias, id) => ({ alias, projectId: id, grantToRelatedProject: { read: { mode: 'all' }, write: { mode: 'none' } } });
    const manifest = { id: projectId, name: `${projectType}-sample`, version: '1.2.3',
      scripts: { postinstall: 'node -e "throw new Error(\'Must not install\')"' },
      workflowCode: { projectType, projectInfo: { dataStorage: { mode: 'both' },
        relatedProjects: [relation('data', dependencyId)] } } };
    const files = [{ path: 'package.json', content: JSON.stringify(manifest) },
      { path: 'index.ts', content: "throw new Error('Source must not execute');\n" },
      { path: 'image.bin', content: 'AAH/', encoding: 'base64' }];
    if (projectType === 'kanban') { files.push({ path: 'index.html', content: '<!doctype html><title>Sample</title>' }); }
    for (const file of files) { await fs.writeFile(path.join(source, file.path), file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content); }
    await fs.writeFile(path.join(source, '.workflowignore'), 'node_modules\n');
    const projects = [{ projectId, projectName: manifest.name, role: 'root', version: manifest.version, sourceHash: sourceHash(files), files }];
    const dependencies = [];
    if (projectType === 'kanban') {
      const dependencyFiles = [{ path: 'package.json', content: JSON.stringify({ id: dependencyId, name: 'data', version: '2.0.0',
        workflowCode: { projectType: 'workflow', projectInfo: { dataStorage: { mode: 'both' }, relatedProjects: [relation('board', projectId)] } } }) }];
      const hash = sourceHash(dependencyFiles);
      dependencies.push({ alias: 'data', projectId: dependencyId, delivery: 'included', version: '2.0.0', sourceHash: hash });
      projects.push({ alias: 'data', projectId: dependencyId, projectName: 'data', role: 'dependency', version: '2.0.0', sourceHash: hash, files: dependencyFiles });
    }
    const requests = []; let created = false;
    const http = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) { chunks.push(chunk); }
      requests.push({ url: request.url, method: request.method, auth: request.headers.authorization, body: Buffer.concat(chunks) });
      const url = new URL(request.url, 'http://localhost');
      let data, status = 200;
      if (url.pathname.endsWith('/versions')) { status = created ? 200 : 404; data = { versions: [] }; }
      else if (url.pathname === '/api/workflows' && request.method === 'POST') { created = true; data = { workflowId: projectId }; }
      else if (url.pathname.endsWith('/package')) { data = { jobId: 'job-1' }; }
      else if (url.pathname.endsWith('/preparations/job-1')) { data = { status: 'success', stage: 'committing', result: { workflowId: projectId, sourceHash: projects[0].sourceHash } }; }
      else if (url.pathname.endsWith('/publish')) { data = { version: manifest.version }; }
      else if (url.pathname.endsWith('/project-group-download')) { data = { rootProjectId: projectId, rootVersion: manifest.version, dependencies,
        projects, downloads: projects.map(({ files, ...project }) => project), skippedDependencies: [], complete: true, copyAllowed: true }; }
      else { status = 404; }
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ errCode: status === 200 ? 0 : status, errMessage: '', data }));
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
    const options = { cliEntry: path.resolve(cliEntry), runtimeDirectory: directory, nodePath: process.execPath,
      connection: { serverUrl: `http://127.0.0.1:${http.address().port}`, accessToken: 'local-test-token' },
      signal: new AbortController().signal, progress() {}, projectId, version: manifest.version };
    await uploadServerProject({ ...options, directory: source, releaseLog: 'Version notes' });
    assert.equal(JSON.parse(requests.find(request => request.url === '/api/workflows').body).projectType, projectType);
    const upload = requests.find(request => request.url.includes('/package?'));
    assert.ok(upload.body.length > 0);
    const archive = path.join(directory, 'upload.tgz'); await fs.writeFile(archive, upload.body);
    const packed = await promisify(execFile)('tar', ['-xOf', archive, `./workspace/workflow/${projectId}/package.json`]);
    assert.deepEqual(JSON.parse(packed.stdout), manifest);
    assert.deepEqual(JSON.parse(requests.find(request => request.url.endsWith('/publish')).body),
      { releaseLog: 'Version notes', expectedVersion: manifest.version, expectedSourceHash: projects[0].sourceHash });
    const downloadOptions = { ...options, version: manifest.version, parentDirectory: path.join(directory, 'downloads') };
    const first = await downloadServerProject(downloadOptions), second = await downloadServerProject(downloadOptions);
    assert.equal(path.basename(first[0].directory), `${manifest.name}-${manifest.version}`);
    assert.equal(path.basename(second[0].directory), `${manifest.name}-${manifest.version}-2`);
    assert.deepEqual(await fs.readFile(path.join(first[0].directory, 'image.bin')), Buffer.from([0, 1, 255]));
    assert.equal(await fs.readFile(path.join(first[0].directory, 'index.ts'), 'utf8'), files[1].content);
    assert.equal(first.length, projectType === 'kanban' ? 2 : 1);
    if (projectType === 'kanban') { assert.equal(path.basename(first[1].directory), 'data-2.0.0'); }
    assert.ok(requests.every(request => request.auth === 'Bearer local-test-token'));
    assert.ok(requests.filter(request => request.url.includes('/project-group-download')).every(request => new URL(request.url, 'http://localhost').searchParams.get('target') === manifest.version));
    assert.ok((await fs.readdir(downloadOptions.parentDirectory)).every(name => !name.startsWith('.studio-download-')));
  });
}
