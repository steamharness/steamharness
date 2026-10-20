import type { ProjectUploadProvider } from './project-upload-types';
export type { ProjectUploadCompletion, ProjectUploadExtension } from './project-upload-types';

let provider: ProjectUploadProvider | undefined;

export function registerProjectUploadProvider(value: ProjectUploadProvider): { dispose(): void } {
  if (provider) { throw new Error('A project upload provider is already registered.'); }
  provider = value;
  return { dispose: () => { if (provider === value) { provider = undefined; } } };
}

export function getProjectUploadProvider(): ProjectUploadProvider | undefined { return provider; }
