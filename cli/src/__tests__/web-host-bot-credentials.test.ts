import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

type Reply = { type: string; id?: string; requestId?: string; action?: string; approval?: { mode: string };
  botCredentialProtocolVersion?: number; failed?: boolean; value?: { status?: string; pending?: { id: string }; items?: { content?: string }[] } };

async function checkFiles(directory: string, forbidden: string): Promise<void> {
  for (const row of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, row.name);
    if (row.isDirectory()) await checkFiles(file, forbidden);
    else if (row.isFile()) expect((await readFile(file)).includes(forbidden), `${row.name} must not contain credential material`).toBe(false);
  }
}

it.each([false, true])('carries sequential credential requests over real host stdio and the agent worker (folder Bot: %s)', async folder => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'host-credential-runtime-')));
  const directory = path.join(root, 'source'), workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  const core = await resolveHarnessRoot(), projectId = randomUUID(), entryId = 'main';
  const canary = `fixture-only-${randomUUID()}`;
  const slot = { name: 'fixture-fields', kind: 'structured', fields: ['account', 'token'] };
  const use = { connector: 'host', name: slot.name, operation: 'fixture.read', args: { endpoint: 'example.test', fields: { account: 'account', token: 'token' } } };
  const result = { status: 'ok', data: { account: 'fixture-account' } };
  const hostUse = { name: 'second-fixture', connector: 'host', operation: 'fixture.read', args: { endpoint: 'example.test' } };
  const hostResult = { status: 'ok', data: { username: 'fixture-user' } };
  let shutdown: (() => Promise<void>) | undefined;
  try {
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await mkdir(workspace);
    await symlink(core, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: projectId, name: 'credential-fixture', type: 'module',
      devDependencies: { steamharness: await resolveHarnessVersion() }, defaultEntry: entryId,
      entries: [{ entryId, name: 'Fixture', root: '.', entry: 'index.ts', type: 'bot', folderContext: true }] }));
    await writeFile(path.join(directory, 'index.ts'), `
      import * as steamharness from 'steamharness';
      import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from ${JSON.stringify(pathToFileURL(path.join(core, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href)};
      const fixture = fauxProvider({ models: [{ id: 'fixture', contextWindow: 20000, maxTokens: 600 }] });
      const models = createModels(); models.setProvider(fixture.provider);
      const makeCall = (tool, args) => fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' });
      fixture.setResponses([
        () => makeCall('bot_credentials_request', ${JSON.stringify(slot)}),
        () => makeCall('bot_credentials_request', { name: 'second-fixture', kind: 'api-key' }),
        () => makeCall('bot_credentials_use', ${JSON.stringify(use)}),
        request => {
          const tool = getCurrentTools(request.messages).find(tool => tool.name === 'bot_credentials_use');
          if (!JSON.stringify(tool).includes('fixture.read')) throw Error('The host operation was not advertised to the model');
          return makeCall('bot_credentials_use', ${JSON.stringify(hostUse)});
        },
        request => {
          const results = request.messages.filter(message => message.role === 'toolResult').map(message => JSON.parse(message.content[0].text));
          return fauxAssistantMessage(results.map(receipt => receipt.status).join('/') + ' ' + results.at(-2)?.data?.account + ' ' + results.at(-1)?.data?.username);
        },
      ]);
      export default steamharness.defineBot({ engine: 'agent', memory: { enabled: false }, agent: { models, resolvedModel: models.getModel('faux','fixture'), tools: [],
        paramOptions: { fields: { provider: false, model: false } } } });
    `);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'web', directory, '--entry', entryId,
      '--host-stdio', '--data-dir', dataDir, '--json', '--no-open', ...(folder ? ['--folder-context'] : [])], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: root, USERPROFILE: root, STEAMHARNESS_CLI_AUTH_DIR: path.join(root, 'auth'),
        STEAMHARNESS_WEB_HOST: 'studio', STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' },
    });
    const ended = once(child, 'close');
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => {});
    shutdown = async () => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      try { send({ type: 'close' }); await ended; } finally { clearTimeout(timer); }
    };
    const replies: Reply[] = [];
    let stdout = '', stderr = '';
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { stdout += line + '\n'; if (line.startsWith('{')) replies.push(JSON.parse(line)); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const read = async (match: (message: Reply) => boolean) => {
      await expect.poll(() => replies.some(match), { timeout: 12_000 }).toBe(true);
      return replies.find(match)!;
    };
    send({ type: 'configure', surface: 'editor', backgroundBotCredentials: true, localBotCredentialStructured: true, localBotCredentialUse: true,
      botCredentialUseOperations: [{ id: hostUse.operation, description: 'Read the fixture endpoint. Pass endpoint in args.' }],
      userSettings: { agent: { permissionPolicy: 'workspace' } }, ...(folder && { folderBot: { id: randomUUID(), projectId, directory: workspace, background: true, permissionCeiling: 'workspace' } }) });
    expect(await read(reply => reply.type === 'ready')).toMatchObject({ botCredentialProtocolVersion: 1 });
    const conversationId = randomUUID(), requestId = randomUUID();
    const turn = async (action: string, input: object = {}) => {
      const call = randomUUID();
      send({ type: 'host-turn', requestId: call, entryId, input: { conversationId, requestId, action, ...input } });
      const reply = await read(message => message.type === 'host-turn' && message.requestId === call);
      expect(reply.failed, stderr).not.toBe(true);
      return reply.value!;
    };
    expect(await turn('turn')).toMatchObject({ status: 'missing', credentialMode: 'capture-and-use', backgroundCredentialProtocolVersion: 1 });
    await turn('submit', { text: 'Use the fixture credential flow', allowBotCredentials: true });
    let previous: string | undefined;
    const prompts = () => replies.filter(reply => reply.type === 'bot-credential-request');
    for (const [index, action] of ['capture', 'capture', 'use', 'use'].entries()) {
      let pendingId: string | undefined;
      await expect.poll(async () => {
        pendingId = (await turn('turn')).pending?.id;
        return !!pendingId && pendingId !== previous;
      }, { timeout: 10_000 }).toBe(true);
      previous = pendingId;
      let offset = prompts().length;
      await turn('credential', { pendingId, allowBotCredentials: true });
      if (action === 'use') {
        await expect.poll(() => prompts().length).toBe(offset + 1);
        expect(prompts()[offset]).toMatchObject({ action, approval: { mode: 'reuse' } });
        send({ type: 'bot-credential-result', id: prompts()[offset].id, status: 'approval-required' });
        offset++;
      }
      await expect.poll(() => prompts().length).toBe(offset + 1);
      const prompt = prompts()[offset];
      expect(prompt).toMatchObject({ action, turn: { conversationId, requestId }, ...(action === 'use' && { approval: { mode: 'prompt' } }) });
      if (index === 3) expect(prompt).toMatchObject({ use: hostUse });
      expect((await turn('turn')).pending?.id).toBe(pendingId);
      send({ type: 'bot-credential-result', id: prompt.id, status: 'saved', value: canary });
      send({ type: 'bot-credential-result', id: prompt.id, ...(action === 'use' ? { result: index === 2 ? result : hostResult } : { status: 'saved' }) });
    }
    await expect.poll(async () => (await turn('turn')).status, { timeout: 10_000 }).toBe('success');
    expect((await turn('turn')).items?.map(item => item.content).join(' ')).toContain('saved/saved/ok/ok fixture-account fixture-user');
    await shutdown(); shutdown = undefined;
    expect(stdout.includes(canary) || stderr.includes(canary)).toBe(false);
    await checkFiles(dataDir, canary);
  } finally {
    await shutdown?.();
    await rm(root, { recursive: true, force: true });
  }
}, 55_000);
