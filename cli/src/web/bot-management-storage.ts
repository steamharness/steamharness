import { createLocalRuntimePersistence, type BotMemoryScope } from 'steamharness/runtime-storage';
import { readBotArtifactResult, type BotArtifactResult } from './bot-artifacts';
import type { BotPanelRequest } from './bot-management-protocol';
import { botMemoryDirectoryError, createWebBotMemoryDirectories, type WebBotMemoryDirectoryScope } from './project-data-directory';

export interface BotStorageScope {
  root: string;
  runtimeDirectory: string;
  bot: BotMemoryScope;
  directories?: WebBotMemoryDirectoryScope;
}

/** Use the host's local storage directly, without loading an executor or starting Web. */
export async function manageBotStorage(target: BotStorageScope, request: Exclude<BotPanelRequest, { kind: 'save' }>): Promise<BotArtifactResult> {
  const persistence = createLocalRuntimePersistence({ directory: target.runtimeDirectory });
  try {
    if (request.kind === 'artifacts') {
      return readBotArtifactResult(new URL(`/api/bot-artifacts${request.route}`, 'http://localhost'), request.method,
        persistence.botArtifacts?.(target.bot), undefined, 8 * 1024 * 1024);
    }
    const { projectPath, ...fields } = request.input as Record<string, unknown>;
    if (projectPath !== undefined && (!target.directories || typeof projectPath !== 'string')) throw botMemoryDirectoryError();
    const directories = target.directories && createWebBotMemoryDirectories(target.directories, {
      storageDir: target.root, runtimeDirectory: target.runtimeDirectory, projectId: target.bot.projectId, persistence, createPersistence: createLocalRuntimePersistence,
    });
    const json = directories
      ? await directories.withStore(target.bot, typeof projectPath === 'string' ? projectPath : directories.primary, store => store.manage!(fields, { actor: 'user' }))
      : await persistence.botMemory!(target.bot).manage!(fields, { actor: 'user' });
    return { status: 200, json };
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    return { status: 400, json: { code: typeof code === 'string' && /^BOT_MEMORY_[A-Z_]+$/u.test(code) ? code : 'BOT_MANAGEMENT_UNAVAILABLE' } };
  } finally { await persistence.close(); }
}
