import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProjectFromTemplate, listProjectTemplates, prepareProjectTemplateRuntime, validateProjectName } from '../project-templates';
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
      const manifest = JSON.parse(await readFile(path.join(created.directory, 'package.json'), 'utf8'));
      expect(manifest).toMatchObject({ id: created.id, private: true, devDependencies: { 'steamharness': versions.harness, '@steamharness/cli': versions.cli },
        steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } });
      expect(JSON.stringify(manifest)).not.toMatch(/link:|file:|workspace:|\/Users\//);
      const card = manifest.steamHarness.projectCard;
      expect(card.icon).toBe(defaultProjectCardIcon(template.projectType));
      expect(getProjectCardColorContrastRatio(card.iconColor, card.iconBackgroundColor)).toBeGreaterThanOrEqual(4.5);
      for (const filename of template.files) { expect((await readFile(path.join(created.directory, filename))).length).toBeGreaterThan(0); }
      await linkCore(created.directory);
      await prepareProjectTemplateRuntime(created.directory);
      const runtime = createWebRuntime(created.directory, path.join(parentDirectory, 'data'), () => {});
      try {
        const inspected = await runtime.inspect([created.directory]); expect(inspected.errors).toEqual([]);
        const project = { ...inspected.projects[0], uri: pathToFileURL(created.directory).href }; expect(project.projectType).toBe(template.projectType);
        expect(project.projectCard).toMatchObject(card);
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

  it.each(['workflow-starter', 'workflow-hello', 'conversation-starter', 'conversation-round-output'])('matches untouched %s source to a published SDK and preserves edits', async templateId => {
    const created = await createProjectFromTemplate({ templateId, name: templateId, parentDirectory: await parent(), versions });
    const sdk = path.join(created.directory, 'node_modules/steamharness'); await mkdir(sdk, { recursive: true });
    await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: 'steamharness', type: 'module', exports: { './runtime-api': { import: './runtime-api.js' } } }));
    await writeFile(path.join(sdk, 'runtime-api.js'), 'export const workflowRuntimeApi = { defineWorkflow() {} };');
    expect(await prepareProjectTemplateRuntime(created.directory)).toBe(true);
    const filename = path.join(created.directory, 'index.ts'), source = await readFile(filename, 'utf8');
    expect(source).toContain("import type { WorkflowRuntimeApi } from 'steamharness/runtime-api'");
    expect(source).toContain('workflow.defineWorkflow'); expect(source).toContain('workflow.defineExecutor');
    expect(source).not.toMatch(/steamharness\.define|\.steamharness;/);
    expect(await prepareProjectTemplateRuntime(created.directory)).toBe(false);
    await writeFile(filename, `${source}\n// User changes\n`);
    expect(await prepareProjectTemplateRuntime(created.directory)).toBe(false);
    expect(await readFile(filename, 'utf8')).toBe(`${source}\n// User changes\n`);
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
    expect(JSON.parse(await readFile(path.join(created.directory, 'package.json'), 'utf8')).steamHarness.projectInfo.localizedNames.en).toBe(name);
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
