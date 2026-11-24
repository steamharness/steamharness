import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startEntryWebServer } from '../web/server';
import { readFolderBotProfile } from '../web/folder-bot-profile';
import type { FolderBotProfile } from 'steamharness';

it('snapshots a folder Bot profile per turn and reloads a durable owner before its queued next turn', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'folder-bot-runtime-profile-')));
  const directory = path.join(root, 'source'), dataDir = path.join(root, 'data'), entryId = 'agent';
  const instance = randomUUID(), projectId = randomUUID(), record = path.join(root, `${instance}.json`), release = path.join(root, 'release-held-turn');
  const core = fileURLToPath(new URL('../../../harness/', import.meta.url));
  const folderBot = { id: instance, projectId, directory, background: false, profileRecord: record };
  const save = async (profile: FolderBotProfile) => {
    await writeFile(`${record}.tmp`, JSON.stringify({ id: instance, directory, source: { kind: 'project', projectId, entryId }, profile }));
    await rename(`${record}.tmp`, record);
  };
  let app: Awaited<ReturnType<typeof startEntryWebServer>> | undefined;
  vi.stubEnv('STEAMHARNESS_WEB_HOST', 'studio'); vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  try {
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await symlink(core, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    const version = (await import('node:fs/promises').then(fs => fs.readFile(path.join(core, 'package.json'), 'utf8')));
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: projectId, name: 'profile-fixture', type: 'module',
      devDependencies: { steamharness: JSON.parse(version).version }, defaultEntry: entryId, entries: [{ entryId, name: 'Fixture', root: '.', type: 'bot', entry: 'index.ts', folderContext: true }] }));
    await writeFile(path.join(directory, 'index.ts'), `
      import * as steamharness from 'steamharness';
      import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, Type } from ${JSON.stringify(new URL('../../../harness/node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.url).href)};
      import { existsSync } from 'node:fs';
      const model = fauxProvider({ models: [{ id: 'fixture', contextWindow: 20000, maxTokens: 800 }] });
      const models = createModels(); models.setProvider(model.provider);
      const respond = request => {
        const messages = request.messages;
        const instructions = JSON.stringify(messages.filter(message => message.role === 'system'));
        const user = messages.findLast(message => message.role === 'user');
        const first = JSON.stringify(user).includes('first turn');
        const available = getCurrentTools(messages).some(item => item.name === 'fixture_hold');
        if (first && available && messages.at(-1)?.role === 'user') return fauxAssistantMessage([fauxToolCall('fixture_hold', {})], { stopReason: 'toolUse' });
        const persona = instructions.includes('PROFILE-BETA') ? 'beta' : instructions.includes('PROFILE-ALPHA') ? 'alpha' : 'inherited';
        return fauxAssistantMessage('profile=' + persona + ';hold=' + available + ';source=' + instructions.includes('Source instruction'));
      };
      model.setResponses(Array.from({ length: 30 }, () => respond));
      export const executor = steamharness.defineBot({ engine: 'agent', memory: { enabled: false }, agent: { models, resolvedModel: models.getModel('faux','fixture'), tools: [],
        systemPrompt: 'Source instruction', paramOptions: { fields: { provider: false, model: false } },
        extraTools: [{ name: 'fixture_hold', label: 'Hold fixture', description: 'Wait for a temporary fixture', parameters: Type.Object({}),
          async execute(_id,_args,signal) { while (!existsSync(${JSON.stringify(release)})) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 20)); } return { content: [{ type: 'text', text: 'Released' }], details: {} }; } }],
      }, tools: [{ name: 'fixture_hold', enabled: true, autoApprove: true }] });
      export default executor;`);
    await save({ responsibility: 'PROFILE-ALPHA' });
    expect(() => readFolderBotProfile({ ...folderBot, id: randomUUID() }, entryId)).toThrow('another instance');
    app = await startEntryWebServer({ projectDir: directory, entryId, dataDir,
      host: { surface: 'editor', folderBot, userSettings: { agent: { permissionPolicy: 'workspace' } } } });
    const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session');
    const send = async (text: string) => {
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'send', text, params: {}, attachments: [], requestId: randomUUID() }) });
      expect(response.status, await response.text()).toBe(200);
    };
    const messages = () => app!.controller!.current.messages;
    await send('first turn');
    await expect.poll(() => messages().some(message => message.items?.some(item => item.title === 'fixture_hold')), { timeout: 12_000 }).toBe(true);
    await save({ responsibility: 'PROFILE-BETA', tools: { disabled: ['fixture_hold'] }, skills: 'off' });
    await send('second turn');
    await writeFile(release, 'go');
    await expect.poll(() => messages().map(message => message.content).join('\n'), { timeout: 20_000 }).toContain('profile=beta;hold=false');
    expect(messages().some(message => message.content.includes('profile=alpha;hold=true'))).toBe(true);
    await save({});
    await send('third turn');
    await expect.poll(() => messages().map(message => message.content).join('\n'), { timeout: 12_000 }).toContain('profile=inherited;hold=true;source=true');
  } finally {
    await writeFile(release, 'cleanup').catch(() => undefined);
    await app?.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 55_000);
