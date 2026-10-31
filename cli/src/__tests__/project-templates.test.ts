import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProjectFromTemplate, listProjectTemplates, prepareProjectTemplateRuntime, registerTemplateProject, validateProjectName } from '../project-templates';
import { createWebRuntime } from '../web/runtime';
import { resolveHarnessRoot } from './harness-source';
import { defaultProjectCardIcon, getProjectCardColorContrastRatio } from '@steamharness/project-card-metadata';

const folders: string[] = [];
const versions = { harness: '0.2.4-20260929001', cli: '0.2.4-20261013009.codex-studio-integration' };
afterEach(async () => { for (const folder of folders.splice(0)) { await rm(folder, { recursive: true, force: true }); } });
async function parent() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-templates-')));
  folders.push(directory); return directory;
}
async function linkCore(directory: string) {
  const harnessRoot = await resolveHarnessRoot();
  await mkdir(path.join(directory, 'node_modules'));
  await symlink(harnessRoot, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
}

describe('project templates', () => {
  it('ships three minimal starters and four independent bilingual examples', async () => {
    const templates = await listProjectTemplates();
    expect(templates.filter(template => template.kind === 'starter').map(template => template.projectType)).toEqual(['workflow', 'conversation', 'kanban']);
    expect(templates.filter(template => template.kind === 'example').map(template => template.id)).toEqual([
      'workflow-hello', 'conversation-round-output', 'kanban-default', 'kanban-parameters',
    ]);
    expect(templates.every(template => template.name.en && template.name['zh-CN'] && template.description.en && template.description['zh-CN'])).toBe(true);
  });

  it('generates every template with unique identity, portable dependencies and runnable local entrypoints', async () => {
    const parentDirectory = await parent(), ids = new Set<string>();
    for (const template of await listProjectTemplates()) {
      const created = await createProjectFromTemplate({ templateId: template.id, name: template.id, parentDirectory, versions });
      ids.add(created.id);
      const manifest = JSON.parse(await readFile(path.join(created.directory, 'steamharness.json'), 'utf8'));
      const npm = JSON.parse(await readFile(path.join(created.directory, 'package.json'), 'utf8'));
      expect(npm).toMatchObject({private:true, devDependencies:{steamharness:versions.harness,'@steamharness/cli':versions.cli}});
      expect(npm).not.toHaveProperty('id'); expect(npm).not.toHaveProperty('steamHarness');
      expect(npm.scripts.inspect).toBe('steamharness structure .');
      if (template.projectType === 'kanban') expect(npm.scripts).not.toHaveProperty('run:json');
      else expect(npm.scripts['run:json']).toBe('steamharness json .');
      expect(manifest).toMatchObject({ id: created.id,
        version: "0.1.0", defaultEntry:'main',entries:[{entryId:'main',type:template.projectType,databases:[]}] });
      expect(JSON.stringify(manifest)).not.toMatch(/link:|file:|workspace:|\/Users\//);
      const card = manifest.projectCard;
      expect(card.icon).toBe(defaultProjectCardIcon(template.projectType));
      expect(getProjectCardColorContrastRatio(card.iconColor, card.iconBackgroundColor)).toBeGreaterThanOrEqual(4.5);
      for (const filename of template.files) { expect((await readFile(path.join(created.directory, filename))).length).toBeGreaterThan(0); }
      await linkCore(created.directory);
      await prepareProjectTemplateRuntime(created.directory);
      const runtime = createWebRuntime(created.directory, path.join(parentDirectory, 'data'), () => {});
      try {
        const inspected = await runtime.inspect([created.directory]); expect(inspected.errors).toEqual([]);
        const project = { ...inspected.projects[0], uri: pathToFileURL(created.directory).href }; expect(project.projectType).toBe(template.projectType);
        expect(project.aggregateProjectCard).toMatchObject(card);
        if (template.projectType === 'kanban') { continue; }
        const execute = (round: number) => runtime.run({ project, conversationId: 'persistent-chat', runId: `round-${round}`,
          entrypointId: project.defaultEntrypoint, args: template.projectType === 'conversation' ? ['--message', 'Local reply'] : [] }, () => {});
        const first = await execute(1); expect(first.status).toBe('success');
        const output = first.output?.items?.map(item => item.content).join('');
        expect(output).toBe(template.id === 'workflow-starter' ? 'Ready' : template.id === 'workflow-hello' ? 'Hello'
          : template.id === 'conversation-starter' ? 'Local reply' : 'Round 1: Local reply');
        if (template.projectType === 'conversation') {
          expect(first.output?.items?.[0]).toMatchObject({ title: 'Output', collapsed: false });
        }
        if (template.id === 'conversation-round-output') {
          expect((await execute(2)).output?.items?.[0].content).toBe('Round 2: Local reply');
        }
      } finally { runtime.dispose(); }
    }
    expect(ids.size).toBe(7);
  }, 60_000);

  it('preserves authored template sources when preparing the installed runtime', async () => {
    const created = await createProjectFromTemplate({templateId:'workflow-starter',name:'current',parentDirectory:await parent(),versions});
    const filename=path.join(created.directory,'index.ts'),source=await readFile(filename,'utf8');
    await writeFile(filename,source+'\n// User changes\n');
    expect(await prepareProjectTemplateRuntime(created.directory)).toBe(false);
    expect(await readFile(filename,'utf8')).toBe(source+'\n// User changes\n');
  });

  it('retains useful script diagnostics from inspection instead of reporting only the validation summary', async () => {
    const created = await createProjectFromTemplate({ templateId: 'workflow-starter', name: 'invalid', parentDirectory: await parent(), versions });
    await linkCore(created.directory);
    await writeFile(path.join(created.directory, 'index.ts'), 'export const executor = {};');
    const runtime = createWebRuntime(created.directory, path.join(await parent(), 'data'), () => {});
    try {
      const result = await runtime.inspect([created.directory]);
      expect(result.projects).toEqual([]);
      expect(result.errors.join('\n')).toMatch(/script validation failed[\s\S]*Project must export steamharness\.defineExecutor/);
    } finally { runtime.dispose(); }
  });

  it.each(['', '..', '../escape', 'a/b', 'a\\b', 'nul', 'COM1.txt', 'a:b', 'a?', 'trailing.', 'a\u0000b', 'x'.repeat(121)])('rejects unsafe name %j', name => {
    expect(() => validateProjectName(name)).toThrow();
  });

  it('preserves Unicode, spaces, quotes and shell punctuation as data', async () => {
    const name = "\u6211\u7684 project ' $() ` &", parentDirectory = await parent();
    const created = await createProjectFromTemplate({ templateId: 'kanban-default', name, parentDirectory, versions });
    expect(created.directory).toBe(path.join(parentDirectory, name));
    const html = await readFile(path.join(created.directory, 'index.html'), 'utf8');
    expect(html).toContain('&#39;'); expect(html).toContain('&amp;');
    expect(JSON.parse(await readFile(path.join(created.directory, 'steamharness.json'), 'utf8')).projectInfo.localizedNames.en).toBe(name);
  });

  it('reserves the destination once and never overwrites an existing directory', async () => {
    const parentDirectory = await parent(), input = { templateId: 'workflow-starter', name: 'same', parentDirectory, versions };
    const results = await Promise.allSettled([createProjectFromTemplate(input), createProjectFromTemplate(input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'directory-exists' } });
    await writeFile(path.join(parentDirectory, 'same/keep.txt'), 'original');
    await expect(createProjectFromTemplate(input)).rejects.toMatchObject({ code: 'directory-exists' });
    expect(await readFile(path.join(parentDirectory, 'same/keep.txt'), 'utf8')).toBe('original');
  });

  it('rejects paths, versions and cancellation before creating any project files', async () => {
    const parentDirectory = await parent(), input = { templateId: 'workflow-starter', name: 'safe', parentDirectory, versions };
    for (const version of ['latest', '^0.2.4', 'link:../harness', 'file:/private/core', '1.0.0;echo']) {
      await expect(createProjectFromTemplate({ ...input, versions: { ...versions, harness: version } })).rejects.toMatchObject({ code: 'invalid-version' });
    }
    await expect(createProjectFromTemplate({ ...input, parentDirectory: '.' })).rejects.toMatchObject({ code: 'invalid-parent' });
    await expect(createProjectFromTemplate({ ...input, templateId: '../../outside' })).rejects.toMatchObject({ code: 'invalid-template' });
    await expect(createProjectFromTemplate({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(parentDirectory)).toEqual([]);
  });
});

it.each(['workflow', 'conversation', 'kanban'] as const)('creates a complete %s project even when Server ID allocation fails', async projectType => {
  const parentDirectory = await parent(), name = `allocated-${projectType}`, allocatedId = '78648759-bcde-4fd5-b3bd-9a2dd46a7192';
  const input = { templateId: `${projectType}-starter`, name, parentDirectory, versions };
  const created = await createProjectFromTemplate({ ...input, allocateProjectId: async project => {
    expect(project).not.toHaveProperty('projectId'); expect(project).toMatchObject({ name, defaultEntry:'main', entries:[{entryId:'main',type:projectType,databases:[]}]});
    expect(await readdir(path.join(parentDirectory, name))).toEqual([]);
    return allocatedId;
  } });
  expect(created.id).toBe(allocatedId);
  expect(JSON.parse(await readFile(path.join(created.directory, 'steamharness.json'), 'utf8')).id).toBe(allocatedId);
  const failed = await createProjectFromTemplate({ ...input, name: 'failed', allocateProjectId: async () => { throw new Error('allocation denied'); } });
  expect(failed).toMatchObject({ id: '', idAllocationError: 'allocation denied' });
  const invalid = await createProjectFromTemplate({ ...input, name: 'invalid', allocateProjectId: async () => '111' });
  expect(invalid.id).toBe(''); expect(invalid.idAllocationError).toMatch(/invalid project ID/);
  for (const project of [failed, invalid]) {
    expect(JSON.parse(await readFile(path.join(project.directory, 'steamharness.json'), 'utf8')).id).toBe('');
    expect(JSON.parse(await readFile(path.join(project.directory, 'package.json'), 'utf8')).devDependencies.steamharness).toBe(versions.harness);
    expect(await readFile(path.join(project.directory, project.entryFile), 'utf8')).not.toBe('');
    expect(await readFile(path.join(project.directory, 'configuration.json'), 'utf8')).not.toBe('');
  }
  const cancellation = new AbortController();
  await expect(createProjectFromTemplate({ ...input, name: 'cancelled', signal: cancellation.signal, allocateProjectId: async () => { cancellation.abort(); return allocatedId; } })).rejects.toHaveProperty('name', 'AbortError');
  await expect(readFile(path.join(parentDirectory, 'cancelled', 'package.json'))).rejects.toHaveProperty('code', 'ENOENT');
  const rejected = new AbortController();
  await expect(createProjectFromTemplate({ ...input, name: 'aborted', signal: rejected.signal, allocateProjectId: async () => { rejected.abort(); throw rejected.signal.reason; } })).rejects.toHaveProperty('name', 'AbortError');
  await expect(readFile(path.join(parentDirectory, 'aborted', 'package.json'))).rejects.toHaveProperty('code', 'ENOENT');
});

it('retries registration without regenerating an unregistered project or losing edited source', async () => {
  const project = await createProjectFromTemplate({ templateId: 'workflow-starter', name: 'retry', parentDirectory: await parent(), versions,
    allocateProjectId: async () => { throw new Error('offline'); } });
  const filename = path.join(project.directory, 'index.ts');
  await writeFile(filename, '// User source stays intact\n');
  const id = '78648759-bcde-4fd5-b3bd-9a2dd46a7192';
  const before = JSON.parse(await readFile(path.join(project.directory, 'steamharness.json'), 'utf8'));
  expect(await registerTemplateProject({ directory: project.directory, allocateProjectId: async registration => {
    expect(registration.name).toBe('retry'); expect(registration).not.toHaveProperty('projectId'); return id;
  } })).toBe(id);
  expect(JSON.parse(await readFile(path.join(project.directory, 'steamharness.json'), 'utf8'))).toEqual({ ...before, id });
  expect(await readFile(filename, 'utf8')).toBe('// User source stays intact\n');
  await expect(registerTemplateProject({ directory: project.directory, allocateProjectId: async () => { throw new Error('must not allocate twice'); } })).rejects.toThrow('identity changed');
});

it('creates local files immediately when registration is deferred to the destination host', async () => {
  const project = await createProjectFromTemplate({ templateId: 'workflow-starter', name: 'deferred', parentDirectory: await parent(), versions,
    deferProjectId: true, allocateProjectId: async () => { throw new Error('The source host must not request an ID'); } });
  expect(project.id).toBe(''); expect(project).not.toHaveProperty('idAllocationError');
  expect(JSON.parse(await readFile(path.join(project.directory, 'steamharness.json'), 'utf8')).id).toBe('');
  expect(await readFile(path.join(project.directory, 'index.ts'), 'utf8')).not.toBe('');
});

it.each(['edited', 'cancelled', 'invalid'] as const)('preserves an unregistered manifest when registration is %s', async failure => {
  const project = await createProjectFromTemplate({ templateId: 'workflow-starter', name: failure, parentDirectory: await parent(), versions,
    allocateProjectId: async () => { throw new Error('offline'); } });
  const filename = path.join(project.directory, 'steamharness.json'), source = await readFile(filename, 'utf8'), cancellation = new AbortController();
  await expect(registerTemplateProject({ directory: project.directory, signal: cancellation.signal, allocateProjectId: async () => {
    if (failure === 'edited') await writeFile(filename, source.replace(failure, 'Updated name'));
    if (failure === 'cancelled') cancellation.abort();
    return failure === 'invalid' ? '111' : '78648759-bcde-4fd5-b3bd-9a2dd46a7192';
  } })).rejects.toThrow();
  expect(await readFile(filename, 'utf8')).toBe(failure === 'edited' ? source.replace(failure, 'Updated name') : source);
  expect((await readdir(project.directory)).some(name => name.startsWith('.steamharness-identity-'))).toBe(false);
});
