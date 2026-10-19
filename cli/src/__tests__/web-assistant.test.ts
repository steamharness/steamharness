import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectWebProject } from '../web/assistant-project';
import { parseHostConfiguration } from '../web/host-config';
import { createWebRuntime } from '../web/runtime';
import { startWebServer } from '../web/server';
import type { Project, Runtime } from '../web/workflow-types';
import { resolveHarnessRoot } from './harness-source';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

it('loads the dedicated assistant declaration instead of the workspace executor', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-assistant-')); temporary.push(directory);
  const workdir = path.join(directory, 'workspace');
  const assistantProjectDir = path.join(directory, 'assistant');
  await mkdir(workdir);
  await mkdir(assistantProjectDir);
  await writeFile(path.join(workdir, 'result.txt'), 'Independent workspace result');
  await writeFile(path.join(assistantProjectDir, 'result.txt'), 'Assistant installation file');
  const assistant = { standalone: true, workdir, roots: [{ uri: 'file:///workspace', folderPath: workdir, name: 'Assistant' }] };
  const host = parseHostConfiguration({ type: 'configure', surface: 'assistant', assistant, assistantProjectDir });
  const descriptor: Project = { id: 'dedicated-assistant', uri: '', folderPath: assistantProjectDir, name: 'Project Assistant', projectType: 'conversation',
    fields: [{ name: 'permissionPolicy', type: 'string', defaultValue: 'auto' }], entrypoints: [],
    tools: [{ name: 'skill' }, { name: 'read' }, { name: 'workflow-memory_global_memory' }, { name: 'workflow-desktop_open_project' },
      { name: 'workflow-studio_studio_state' }, { name: 'workflow-studio_get_diagnostics' }, { name: 'workflow-studio_open_file' },
      { name: 'workflow-studio_set_theme' }, { name: 'workflow-studio_open_terminal' }, { name: 'workflow-studio_show_view' }, { name: 'unregistered_control' }],
  };
  const runtime = { available: true, inspect: vi.fn(async () => ({ projects: [descriptor], errors: [] })), dispose: vi.fn() } as unknown as Runtime;
  const result = await inspectWebProject(runtime, workdir, host);
  expect(runtime.inspect).toHaveBeenCalledWith([assistantProjectDir]);
  expect(result.assistantProtocolVersion).toBe(1);
  expect(result.projects[0]).toMatchObject({ id: 'dedicated-assistant', folderPath: assistantProjectDir, assistant, requiresLogin: true,
    fields: [{ name: 'permissionPolicy', defaultValue: 'auto' }], tools: [{ name: 'skill' }, { name: 'read' }, { name: 'workflow-memory_global_memory' },
      { name: 'workflow-studio_studio_state' }, { name: 'workflow-studio_get_diagnostics' }, { name: 'workflow-studio_open_file' },
      { name: 'workflow-studio_set_theme' }, { name: 'workflow-studio_open_terminal' }, { name: 'workflow-studio_show_view' }],
  });
  expect(() => parseHostConfiguration({ type: 'configure', surface: 'assistant', assistant })).toThrow('dedicated assistant');
  expect(() => parseHostConfiguration({ type: 'configure', surface: 'editor', assistant, assistantProjectDir })).toThrow();
  expect(() => parseHostConfiguration({ type: 'configure', surface: 'assistant', assistant, assistantProjectDir: 'relative' })).toThrow();
  expect(() => parseHostConfiguration({ type: 'configure', surface: 'assistant', assistant: { ...assistant, standalone: 'true' }, assistantProjectDir })).toThrow('Invalid assistant workspace');

  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(directory, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  const dataDir = path.join(directory, 'data');
  const previousKey = createHash('sha256').update(`assistant:${workdir}`).digest('hex').slice(0, 24);
  await mkdir(path.join(dataDir, previousKey), { recursive: true });
  await writeFile(path.join(dataDir, previousKey, 'conversations.json'), JSON.stringify({ activeId: 'old-pi-session', sessions: [{ id: 'old-pi-session', title: 'Old project executor', messages: [], parameterValues: { apiKey: 'old-project-field' } }] }));
  const app = await startWebServer({ projectDir: assistantProjectDir, dataDir, runtime, host });
  try {
    expect(app.project.id).toBe('dedicated-assistant');
    expect(app.controller.activeId).not.toBe('old-pi-session');
    expect(app.controller.current.parameterValues ?? {}).not.toHaveProperty('apiKey');
    app.controller.current.messages.push({ id: 'assistant-file-message', role: 'assistant', content: '', items: [{
      metadata: { kind: 'agent-part', partType: 'tool' },
      content: { status: 'success', tool: 'workflow-ui_present_card', output: { action: 'upsert', cardId: 'assistant-file', kind: 'file', target: { source: 'current', filePath: 'result.txt' } } },
    }] });
    const preview = await fetch(new URL('/api/message', app.url), {
      method: 'POST', headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'resource', messageId: 'assistant-file-message', cardId: 'assistant-file' }),
    });
    expect(preview.ok).toBe(true);
    const result = await preview.json();
    expect(result).toMatchObject({ messages: [{ type: 'resource-preview', card: { kind: 'file' } }] });
    const content = await fetch(new URL('/api/message', app.url), {
      method: 'POST', headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'resource-data', id: result.messages[0].id }),
    });
    expect(await content.json()).toMatchObject({ messages: [{ data: { content: 'Independent workspace result' } }] });
  } finally { await app.close(); }
});

it('executes dedicated assistant skills using its own runtime and independent workspace', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-assistant-runtime-')); temporary.push(directory);
  const workdir = path.join(directory, 'workspace');
  const runtimeProjectDir = path.join(directory, 'assistant-runtime');
  const assistantProjectDir = path.join(directory, 'assistant');
  await mkdir(workdir);
  await mkdir(path.join(runtimeProjectDir, 'node_modules'), { recursive: true });
  await mkdir(path.join(assistantProjectDir, 'skills', 'fixture-skill'), { recursive: true });
  const harnessRoot = await resolveHarnessRoot();
  const harnessVersion = JSON.parse(await readFile(path.join(harnessRoot, 'package.json'), 'utf8')).version;
  await symlink(harnessRoot, path.join(runtimeProjectDir, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = { id: '364764e9-ef0e-4e86-9e56-77d0410e1723', type: 'module', devDependencies: { 'steamharness': harnessVersion }, steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } };
  await writeFile(path.join(runtimeProjectDir, 'package.json'), JSON.stringify({ ...manifest, name: 'Assistant runtime' }));
  await writeFile(path.join(assistantProjectDir, 'package.json'), JSON.stringify({ ...manifest, name: 'Dedicated assistant' }));
  await writeFile(path.join(workdir, 'index.ts'), 'throw new Error("The workspace executor must not run.");');
  await writeFile(path.join(workdir, 'user.txt'), 'Independent workspace contents');
  await writeFile(path.join(assistantProjectDir, 'skills/fixture-skill/SKILL.md'), '---\nname: fixture-skill\ndescription: Assistant skill fixture\n---\nRead the independent workspace.\n');
  await writeFile(path.join(assistantProjectDir, 'index.ts'), `
    import path from 'node:path';
    import { readFile } from 'node:fs/promises';
    const flow = steamharness.defineProject({ name: 'assistant-tools', async run() {
      const tools = await steamharness.createSkillTools({ directories: [path.join(import.meta.dirname, 'skills')] });
      const skill = tools.find(tool => tool.name === 'skill');
      const listed = await skill.execute('list', { action: 'list' });
      const read = await skill.execute('read', { action: 'read', skill: 'fixture-skill' });
      const workdir = process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR;
      const workspace = JSON.parse(await readFile(process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST, 'utf8'));
      return { errCode: 0, errMessage: '', host: process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_HOST,
        listed: JSON.parse(listed.content[0].text), read: JSON.parse(read.content[0].text),
        text: await readFile(path.join(workdir, 'user.txt'), 'utf8'), workspace };
    } });
    export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: flow,
      tools: [{ name: 'skill', enabled: true, autoApprove: true }], createInput() { return {}; } });
  `);
  const runtime = createWebRuntime(runtimeProjectDir, path.join(directory, 'data'), () => undefined);
  try {
    const inspection = await runtime.inspect([assistantProjectDir]);
    expect(inspection.errors).toEqual([]);
    expect((inspection.projects[0] as unknown as { runtime: { harnessPath: string } }).runtime.harnessPath).toBe(path.join(harnessRoot, 'dist', 'index.js'));
    const project: Project = { ...inspection.projects[0], uri: '', assistant: { standalone: true, workdir, roots: [{ uri: 'file:///workspace', folderPath: workdir, name: 'Assistant' }] } };
    const report = await runtime.run({ project, conversationId: 'assistant-test', runId: 'assistant-test', args: [] }, () => {});
    expect(report.status).toBe('success');
    expect(report.output?.items?.[0].content).toMatchObject({ host: 'vscode', text: 'Independent workspace contents',
      listed: { skills: [expect.objectContaining({ name: 'fixture-skill' })] },
      read: { skill: 'fixture-skill', content: expect.stringContaining('Read the independent workspace.') },
      workspace: { primaryTarget: { kind: 'folder', folderId: 'file:///workspace' }, roots: [expect.objectContaining({ rootPath: workdir, role: 'primary' })] },
    });
  } finally { runtime.dispose(); }
}, 30_000);
