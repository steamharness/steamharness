import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { register } from 'tsx/esm/api';
import { ROOT, assertRuntime } from '../scripts/distribution.mjs';

register();
await assertRuntime();
const { projectTemplatesRuntime, installProjectDependencies } = await import('../extensions/studio-workstation/src/project-create-node.ts');
const templates = projectTemplatesRuntime(path.join(ROOT, 'extensions/studio-workstation'), 'en');
const directory = await mkdtemp(path.join(tmpdir(), 'studio-create-live-'));
const proof = path.join(ROOT, '.studio/project-create-live'); await mkdir(proof, { recursive: true });
const checks = [], controller = new AbortController(); let log = '';
try {
  for (const template of await templates.templates()) {
    const project = await templates.create({ templateId: template.id, name: template.id, parentDirectory: directory });
    await installProjectDependencies({ directory: project.directory, signal: controller.signal, log: chunk => { log += chunk; } });
    const cli = path.join(project.directory, 'node_modules/@steamharness/cli/dist/index.js');
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'web', project.directory, '--inspect'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const inspected = JSON.parse(stdout.trim());
    assert.deepEqual(inspected.errors, []); assert.equal(inspected.projects[0].id, project.id); assert.equal(inspected.projects[0].projectType, template.projectType);
    const manifest = JSON.parse(await readFile(path.join(project.directory, 'package.json'), 'utf8'));
    for (const [dependency, version] of Object.entries(manifest.devDependencies)) {
      assert.equal(JSON.parse(await readFile(path.join(project.directory, 'node_modules', dependency, 'package.json'), 'utf8')).version, version);
    }
    checks.push(template.id); console.log(`[OK] ${template.id}: actual dependency install and project inspection`);
  }
} finally {
  controller.abort();
  await writeFile(path.join(proof, 'install.log'), log);
  await writeFile(path.join(proof, 'results.json'), JSON.stringify({ checks }, null, 2));
  await rm(directory, { recursive: true, force: true });
}
