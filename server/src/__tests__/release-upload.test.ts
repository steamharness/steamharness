import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { create as createTar } from 'tar';
import { normalizeProjectCardMetadata } from '@steamharness/project-card-metadata';
import { readProjectReleaseSync, sealProjectRelease } from '@steamharness/project-manifest/release-node';
import type { DatabaseRepository } from '../persistence';
import { Storage } from '../storage';

test('uploading a release preserves integrity after applying stored project metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-upload-'));
  const projectId = '72e34bc3-7bbd-4d45-b38b-f941ff856424';
  const project = path.join(root, 'project');
  const coreVersion = JSON.parse(await readFile(new URL('../../../harness/package.json', import.meta.url), 'utf8')).version;
  const files: Record<string, string> = {
    'steamharness.json': JSON.stringify({ id: projectId, name: 'Uploaded name', version: '1.0.0', defaultEntry: 'main', entries: [{ entryId: 'main', root: 'entries/main' }] }),
    'package.json': JSON.stringify({ name: 'compiled-upload', type: 'module', devDependencies: { steamharness: coreVersion } }),
    'entries/main/steamharness.json': JSON.stringify({ name: 'Main', type: 'workflow', entry: 'index.mjs', databases: [] }),
    'entries/main/index.mjs': 'throw new Error("Server must not execute the project");',
    'entries/main/structure.json': JSON.stringify({ version: 1, report: { projectId, entryId: 'main', projectType: 'workflow', definitions: { nodes: {}, apiCalls: [], variables: {}, registry: {} }, diagnostics: { violations: [], warnings: [] } }, scripts: { definedNodes: [], violations: [] } }),
  };
  let savedFiles: Array<{ path: string; content: string; encoding?: string }> = [];
  const projectCard = normalizeProjectCardMetadata({ icon: 'sparkles', iconColor: '#FFFFFF', iconBackgroundColor: '#0F766E' }, 'workflow');
  const db = {
    connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
    getProject: async () => ({ id: projectId, name: 'Stored name', latest: null, projectCard, projectInfo: {} }),
    listVersions: async () => [],
    withProjectPublishLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    saveDraft: async (input: { files: typeof savedFiles }) => { savedFiles = input.files; },
    close: async () => {},
  } as unknown as DatabaseRepository;
  const storage = new Storage({ serverRoot: root, repoRoot: root, dataRoot: path.join(root, 'server'), db });
  try {
    for (const [filename, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project, filename)), { recursive: true });
      await writeFile(path.join(project, filename), content);
    }
    const release = sealProjectRelease(project, { kind: 'steamharness.project.release', version: 1, projectId, projectVersion: '1.0.0', buildId: '1'.repeat(64), inputHash: '2'.repeat(64), entries: [{ entryId: 'main', root: 'entries/main', entry: 'index.mjs', structure: 'entries/main/structure.json' }] });
    const archive = path.join(root, 'project.tgz');
    await createTar({ gzip: true, cwd: root, file: archive }, ['project']);
    await storage.uploadPackage({ projectName: projectId, archiveName: 'project.tgz', archiveBuffer: await readFile(archive) });
    const downloaded = path.join(root, 'download');
    for (const file of savedFiles) {
      const target = path.join(downloaded, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content);
    }
    assert.equal(readProjectReleaseSync(downloaded)?.buildId, release.buildId);
    const manifest = JSON.parse(await readFile(path.join(downloaded, 'steamharness.json'), 'utf8'));
    assert.equal(manifest.name, 'Stored name');
    assert.deepEqual(manifest.projectCard, JSON.parse(JSON.stringify(projectCard)));
    const originalSaved = savedFiles;
    await writeFile(path.join(project, 'entries/main/index.mjs'), 'throw new Error("tampered");');
    await createTar({ gzip: true, cwd: root, file: archive }, ['project']);
    await assert.rejects(storage.uploadPackage({ projectName: projectId, archiveName: 'project.tgz', archiveBuffer: await readFile(archive) }), /integrity check failed/);
    assert.equal(savedFiles, originalSaved);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
