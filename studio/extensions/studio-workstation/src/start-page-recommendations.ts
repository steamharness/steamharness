import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { normalizeProjectCardMetadata } from '@steamharness/project-card-metadata';
interface Disposable { dispose(): void }

import type { StartRecommendation, StartRecommendationsProvider } from './start-page-recommendations-types';
export type { StartRecommendation, StartRecommendationsProvider, StartRecommendationsState } from './start-page-recommendations-types';
let provider: StartRecommendationsProvider | undefined;
const listeners = new Set<() => void>();
export function getStartRecommendationsProvider(): StartRecommendationsProvider | undefined { return provider; }
export function onDidChangeStartRecommendations(listener: () => void): Disposable {
  listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
}
export function registerStartRecommendationsProvider(value: StartRecommendationsProvider): Disposable {
  if (provider) throw new Error('A start-page recommendations provider is already registered.');
  provider = value;
  for (const listener of listeners) listener();
  return { dispose: () => {
    if (provider !== value) return;
    provider = undefined;
    for (const listener of listeners) listener();
  } };
}

export function normalizeStartRecommendations(items: StartRecommendation[]): StartRecommendation[] {
  if (!Array.isArray(items)) throw new Error('Invalid recommendations.');
  const seen = new Set<string>();
  return items.filter(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200
    && typeof item.name === 'string' && item.name.trim().length > 0 && !seen.has(item.id) && !!seen.add(item.id)).slice(0, 6).map(item => ({
      id: item.id, name: item.name.slice(0, 160),
      ...(typeof item.description === 'string' ? { description: item.description.slice(0, 500) } : {}),
      ...(typeof item.version === 'string' ? { version: item.version.slice(0, 64) } : {}),
      ...(typeof item.projectType === 'string' ? { projectType: item.projectType.slice(0, 32) } : {}),
      avatarUrl: typeof item.avatarUrl === 'string' && item.avatarUrl.startsWith('data:image/svg+xml,') ? item.avatarUrl : (() => {
        const kind = item.projectType === 'bot' || item.projectType === 'kanban' ? item.projectType : 'workflow';
        return projectAvatarDataUrl({ ...normalizeProjectCardMetadata(item.projectCard, kind), iconUrl: undefined }, kind);
      })(),
    }));
}
