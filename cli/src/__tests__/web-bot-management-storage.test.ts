import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createLocalRuntimePersistence } from 'steamharness/runtime-storage';
import { manageBotStorage, type BotStorageScope } from '../web/bot-management-storage';
import { folderBotDataRoot, webProjectDataDirectory } from '../web/project-data-directory';

it('uses persisted Bot deliveries and memory without a project server or executor', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-bot-storage-')));
  const bot = { projectId: randomUUID(), entryId: 'main' };
  const scope = (storage: string): BotStorageScope => ({ bot, root: storage,
    runtimeDirectory: path.join(webProjectDataDirectory(storage, bot.projectId, bot.entryId), 'runtime') });
  const original = scope(path.join(root, 'runs'));
  const copy = scope(folderBotDataRoot(original.root, randomUUID()));
  const persistence = createLocalRuntimePersistence({ directory: copy.runtimeDirectory });
  try {
    const files = persistence.botFiles!(bot)!;
    const source = `${(await files.list(undefined, 0, 10)).artifacts}/report.md`;
    await files.write(source, 'delivered report', false);
    const artifact = await persistence.botArtifacts!(bot)!.publish({ path: source }, {
      conversationId: 'private-source', requestId: 'request', runId: 'run', outputId: 'output',
    }, 'call');
    const deliveries = (target: BotStorageScope, route = '', method = 'GET') => manageBotStorage(target, { kind: 'artifacts', route, method });
    expect(await deliveries(original)).toMatchObject({ status: 200, json: { artifacts: [] } });
    expect(await deliveries(copy)).toEqual({ status: 200, json: { artifacts: [{ id: artifact.id, name: artifact.name,
      title: artifact.title, size: artifact.size, createdAt: artifact.createdAt, preview: 'text' }], nextBefore: undefined } });
    const preview = await deliveries(copy, `/${artifact.id}/content?preview=1`);
    expect('content' in preview && new TextDecoder().decode(preview.content.bytes)).toBe('delivered report');
    expect((await deliveries(copy, `/${artifact.id}`, 'DELETE')).status).toBe(200);
    expect((await deliveries(copy, `/${artifact.id}`)).status).toBe(404);
    expect((await files.read(source, 0)).text).toBe('delivered report');

    const folder = path.join(root, 'project'), subfolder = path.join(folder, 'nested');
    await mkdir(subfolder, { recursive: true });
    copy.directories = { kind: 'folder-context', primary: folder, roots: [folder] };
    const memory = (target: BotStorageScope, input: object) => manageBotStorage(target, { kind: 'memory', input });
    expect((await memory(copy, { action: 'save', projectPath: subfolder, category: 'fixture', key: 'saved', content: 'saved memory' })).status).toBe(200);
    expect(await memory(copy, { action: 'list', projectPath: subfolder })).toMatchObject({ status: 200, json: { memories: [{ key: 'saved' }] } });
    expect(await memory(copy, { action: 'list' })).toMatchObject({ status: 200, json: { memories: [] } });
    expect(await memory(original, { action: 'list' })).toMatchObject({ status: 200, json: { memories: [] } });
    expect(await memory(copy, { action: 'list', projectPath: root })).toEqual({ status: 400, json: { code: 'BOT_MEMORY_DIRECTORY_UNAVAILABLE' } });
  } finally {
    await persistence.close();
    await rm(root, { recursive: true, force: true });
  }
});
