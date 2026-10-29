import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { createWebRuntime, type WebConnection } from '../web/runtime';
import { startEntryWebServer } from '../web/server';
import { resolveHarnessRoot } from './harness-source';

const folders: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

it('lists and previews the selected agent through the real worker and authenticated Web bridge without invoking tool factories or tasks', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'web-skills-'))); folders.push(root);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', ''); vi.stubEnv('STEAMHARNESS_SERVER_URL', '');
  await mkdir(path.join(root, 'node_modules'));
  const harness = await resolveHarnessRoot();
  await symlink(harness, path.join(root, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  const version = JSON.parse(await readFile(path.join(harness, 'package.json'), 'utf8')).version;
  await writeProjectFixture(path.join(root, 'package.json'), JSON.stringify({ id: randomUUID(), name: 'Skill catalog', version: '1.0.0', type: 'module',
    devDependencies: { steamharness: version }, defaultEntry: 'main', entries: [
      { entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] },
      { entryId: 'child', name: 'Child', type: 'conversation', root: 'child', entry: 'index.ts', databases: [] },
      { entryId: 'plain', name: 'Plain workflow', type: 'workflow', root: 'plain', entry: 'index.ts', databases: [] },
      { entryId: 'disabled', name: 'Memory disabled', type: 'conversation', root: 'disabled', entry: 'index.ts', databases: [] },
    ] }));
  await mkdir(path.join(root, 'guides', 'large'), { recursive: true });
  const content = '---\nname: large\ndescription: Full project guide\n---\n# Guide\n' + '中文内容😀\n'.repeat(50_000) + '\nEND_OF_GUIDE';
  await writeFile(path.join(root, 'guides/large/SKILL.md'), content);
  await writeFile(path.join(root, 'index.ts'), `
    const agent = steamharness.createAgentConversationProject({ skills: { directories: ['guides'] },
      createTools() { throw new Error('Tool factories must not run during preview'); } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: agent,
      tools: [{ name: 'skill', label: 'List and read skill guides', enabled: true, autoApprove: true }],
      createInput(context) { return steamharness.createAgentProjectInput(context); } });
  `);
  await mkdir(path.join(root, 'child/guides/child'), { recursive: true });
  await writeFile(path.join(root, 'child/guides/child/SKILL.md'), '---\nname: child\n---\nChild entry guide');
  await writeFile(path.join(root, 'child/index.ts'), `
    const agent = steamharness.createAgentConversationProject({ skills: { directories: ['guides'] } });
    const wrapper = steamharness.defineProject({ name: 'wrapper', async run() { throw new Error('Preview must not run the wrapper'); } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: wrapper, coreAgent: agent, createInput() { return {}; } });
  `);
  await writeFile(path.join(root, 'plain/index.ts'), `
    const plain = steamharness.defineProject({ name: 'plain', async run() { throw new Error('Preview must not run a workflow'); } });
    export const executor = steamharness.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'plain', entrypoints: [
      steamharness.defineEntrypoint({ id: 'plain', title: 'Plain', workflow: plain, createInput() { return {}; } }),
    ] });
  `);
  await writeFile(path.join(root, 'disabled/index.ts'), `
    const agent = steamharness.createAgentConversationProject({ memory: false,
      createTools() { throw new Error('Capability inspection must not invoke tools'); } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: agent,
      createInput(context) { return steamharness.createAgentProjectInput(context); } });
  `);
  let connection: WebConnection | undefined;
  const runtime = createWebRuntime(root, path.join(root, 'data'), () => connection);
  const app = await startEntryWebServer({ projectDir: root, dataDir: path.join(root, 'data'), runtime });
  try {
    const token = new URL(app.url).hash.slice('#session='.length);
    const post = async (message: unknown) => {
      const response = await fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      return { status: response.status, body: await response.json() };
    };
    const listed = await post({ type: 'project-skills', requestId: 'catalog' });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const guides = listed.body.messages[0].value;
    expect(guides).toEqual([
      { id: 'project:large', name: 'large', description: 'Full project guide', source: 'project' },
      expect.objectContaining({ id: 'builtin:i-have-adhd', source: 'builtin' }),
      expect.objectContaining({ id: 'builtin:steamharness-memory', source: 'builtin' }),
    ]);
    expect(JSON.stringify(guides)).not.toContain(root);
    const preview = await post({ type: 'project-skills', requestId: 'preview', skillId: 'project:large' });
    expect(preview.status).toBe(200); expect(preview.body.messages[0].value.content).toBe(content);
    const builtin = await post({ type: 'project-skills', requestId: 'builtin', skillId: 'builtin:i-have-adhd' });
    expect(builtin.body.messages[0].value.content).toContain('name: i-have-adhd');
    expect((await post({ type: 'project-skills', requestId: 'escape', skillId: 'project:../../package.json' })).status).toBe(400);
    expect((await post({ type: 'project-skills', requestId: 'entry', entrypointId: 'unknown' })).status).toBe(400);
    const unauthorized = await fetch(`${app.origin}/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'project-skills', requestId: 'unauthorized' }) });
    expect(unauthorized.status).toBe(401);
    const inspection = await runtime.inspect([root]); expect(inspection.errors).toEqual([]);
    const wrapped = { ...inspection.projects.find(project => project.entryId === 'child')!, uri: 'file:///child' };
    expect((await runtime.listSkills!(wrapped)).map(guide => guide.id)).toEqual(['project:child', 'builtin:i-have-adhd', 'builtin:steamharness-memory']);
    expect((await runtime.readSkill!(wrapped, 'project:child')).content).toContain('Child entry guide');
    const workflow = { ...inspection.projects.find(project => project.entryId === 'plain')!, uri: 'file:///plain' };
    expect(await runtime.listSkills!(workflow, 'plain')).toEqual([]);
    await expect(runtime.readSkill!(workflow, 'project:child', 'plain')).rejects.toThrow('does not declare');
    connection = { serverUrl: 'http://127.0.0.1:1', accessToken: 'project-test', memoryToken: 'shma_host-test' };
    const disabled = { ...inspection.projects.find(project => project.entryId === 'disabled')!, uri: 'file:///disabled' };
    await expect(runtime.memoryCapabilities!(disabled)).resolves.toMatchObject({ connected: false, enabled: false });
    await expect(runtime.memoryCapabilities!(workflow)).resolves.toMatchObject({ connected: false, enabled: false });
    // An enabled Agent does contact the host; the closed server above is deliberate.
    await expect(runtime.memoryCapabilities!(wrapped)).rejects.toThrow('Memory authorization is unavailable');
  } finally { await app.close(); runtime.dispose(); }
}, 60_000);
