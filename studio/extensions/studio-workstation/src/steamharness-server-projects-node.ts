import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { t, locale } from './localization';
import { AuthError, type Connection } from './workflow-auth-client';
import { ProjectServerClient, type DownloadedServerProject, type ProjectPreparation, type ProjectTransferProgress } from './steamharness-server-projects';
import { isProjectUuid } from '../../../../shared/workflow-ids/index';
import type { TemplateProjectRegistration } from '../../../vendor/project-templates/project-templates';
import { nodeRuntimeEnvironment, type NodeRuntime } from './node-runtime';

export async function allocateServerProjectId(options: {
  project: TemplateProjectRegistration; connection: Connection; signal: AbortSignal; assertCurrent: () => void;
}): Promise<string> {
  options.signal.throwIfAborted();
  options.assertCurrent();
  const result = await new ProjectServerClient(options.connection).request<{ projectId: string; entries: import("@steamharness/project-manifest").ProjectEntry[]; defaultEntry: string }>('/api/projects', options.signal, {
    ...options.project, visibility: 'private',
  });
  options.assertCurrent();
  if (typeof result?.projectId !== 'string' || !isProjectUuid(result.projectId) || JSON.stringify(result.entries) !== JSON.stringify(options.project.entries) || result.defaultEntry !== options.project.defaultEntry) {
    throw new Error(t('The server returned an unexpected project. Retry project setup.'));
  }
  return result.projectId;
}

interface TransferOptions {
  cliEntry: string; runtimeDirectory: string; nodePath: string; connection: Connection; runtime?: NodeRuntime;
  signal: AbortSignal; progress: (value: ProjectTransferProgress) => void;
}

export function runWorkspaceTransfer(options: TransferOptions, args: string[], packsDirectory: string): Promise<unknown> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...(options.runtime ? nodeRuntimeEnvironment(options.runtime) : { ...process.env, ELECTRON_RUN_AS_NODE: '1' }),
      STEAMHARNESS_SERVER_URL: options.connection.serverUrl, STEAMHARNESS_SERVER_ADMIN_KEY: options.connection.accessToken,
      STEAMHARNESS_WORKSPACE_PACKS_DIR: packsDirectory };
    for (const key of ['NODE_OPTIONS', 'TSX_TSCONFIG_PATH', 'STEAMHARNESS_LOCAL_HARNESS_ROOT', 'STEAMHARNESS_LOCAL_SHARED_ROOT', 'STEAMHARNESS_LOCAL_SOURCE_MODE']) { delete env[key]; }
    const child = spawn(options.nodePath, [options.cliEntry, '--locale', locale(), 'workspace', ...args], {
      cwd: options.runtimeDirectory, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', failure: Error | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const kill = (hard = false): void => {
      if (!child.pid) { return; }
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      } else { try { process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already closed. */ } }
    };
    const abort = (): void => { kill(); force ??= setTimeout(() => kill(true), 3000); };
    const timeout = setTimeout(() => { failure = new Error(t('Project transfer timed out.')); abort(); }, 10 * 60_000);
    options.signal.addEventListener('abort', abort, { once: true });
    const clean = (): void => { clearTimeout(timeout); clearTimeout(force); options.signal.removeEventListener('abort', abort); };
    const redact = (message: string): string => message.replaceAll(options.connection.accessToken, '[redacted]');
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value: string) => {
      stdout += value;
      if (stdout.length > 8 * 1024 * 1024) { failure = new Error(t('The server returned an invalid response.')); abort(); }
    });
    child.stderr.on('data', (value: string) => { stderr = (stderr + value).slice(-8000); });
    child.once('error', error => { clean(); reject(new Error(redact(error.message))); });
    child.once('close', code => {
      clean();
      if (options.signal.aborted) { reject(new DOMException('Project transfer cancelled.', 'AbortError')); return; }
      if (failure) { reject(failure); return; }
      let result: { errCode?: number; errMessage?: string; data?: unknown };
      try { result = JSON.parse(stdout); }
      catch { reject(new Error(redact(stderr.trim() || t('The server returned an invalid response.')))); return; }
      if (!result || code !== 0 || result.errCode !== 0 || result.data === undefined || result.data === null) {
        reject(new Error(redact(result?.errMessage || stderr.trim() || t('Project transfer failed.')))); return;
      }
      resolve(result.data);
    });
    if (options.signal.aborted) { abort(); }
  });
}

export async function uploadServerProject(options: TransferOptions & { projectId: string; version: string; directory: string; releaseLog: string }): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) { throw new Error(t('Declare a valid project UUID and version in steamharness.json first.')); }
  const temporary = await mkdtemp(path.join(tmpdir(), 'studio-upload-'));
  try {
    const client = new ProjectServerClient(options.connection);
    try { await client.versions(options.projectId, options.signal); }
    catch (error) { if (error instanceof AuthError && error.status === 404) { throw new Error(t('This project ID is not registered. Open the project and apply for a new application ID before uploading.')); } else { throw error; } }
    const manifest = await readProjectManifestFromDirectory(options.directory, {});
    const expectedConfigurationRevisions = Object.fromEntries(await Promise.all(manifest.entries.map(async entry => {
      const state = await client.configurations<{publicationRevision?:number}>(options.projectId, entry.entryId, 'draft', options.signal);
      return [entry.entryId,state.publicationRevision??0];
    })));
    options.progress({ message: t('Packing and uploading project') });
    const job = await runWorkspaceTransfer(options, ['upload', options.projectId, '--path', options.directory, '--no-wait'], temporary) as { jobId: string };
    if (typeof job?.jobId !== 'string') { throw new Error(t('The server returned an invalid response.')); }
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60_000)]);
    const stages: Record<string, string> = { queued: t('Waiting for file processing'), extracting: t('Extracting project files'),
      validating: t('Validating project files'), committing: t('Saving project files') };
    let sourceHash: string;
    for (;;) {
      const preparation = await client.request<ProjectPreparation>(`/api/projects/${encodeURIComponent(options.projectId)}/preparations/${encodeURIComponent(job.jobId)}`, signal);
      if (preparation.status === 'failed') { throw new Error((preparation.failureReason || t('Project transfer failed.')).replaceAll(options.connection.accessToken, '[redacted]')); }
      if (preparation.status === 'success') {
        if (preparation.result?.projectId !== options.projectId || !/^[a-f0-9]{64}$/.test(preparation.result.sourceHash)) { throw new Error(t('The server returned an invalid response.')); }
        sourceHash = preparation.result.sourceHash;
        break;
      }
      options.progress({ message: stages[preparation.stage] || t('Saving project files') });
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 700);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); }
      });
    }
    options.progress({ message: t('Publishing project version') });
    const published = await client.request<{ version: string }>(`/api/projects/${encodeURIComponent(options.projectId)}/publish`, signal,
      { releaseLog: options.releaseLog, expectedVersion: options.version, expectedSourceHash: sourceHash,expectedConfigurationRevisions });
    if (published?.version !== options.version) { throw new Error(t('The server returned an invalid response.')); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function portableDirectoryPart(value: string): string {
  const normalized = value.normalize('NFC').replace(/^@/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100);
  return !normalized || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized) ? `project-${normalized || 'source'}` : normalized;
}

export async function downloadServerProject(options: TransferOptions & { projectId: string; version: string; parentDirectory: string }): Promise<DownloadedServerProject[]> {
  await mkdir(options.parentDirectory, { recursive: true });
  const staging = await mkdtemp(path.join(options.parentDirectory, '.studio-download-'));
  const reserved: string[] = [];
  try {
    options.progress({ message: t('Downloading project version') });
    const result = await runWorkspaceTransfer(options, ['download', options.projectId, '--target', options.version, '--path', path.join(staging, 'root')], path.join(staging, '.packs')) as { projectId: string; path: string };
    if (result.projectId !== options.projectId || path.resolve(result.path) !== path.join(staging,'root')) throw new Error(t('The server returned an invalid response.'));
    const pkg = JSON.parse(await readFile(path.join(result.path,'steamharness.json'),'utf8'));
    const aggregate = await readProjectManifestFromDirectory(result.path, {});
    if (aggregate.projectId !== options.projectId || pkg.version !== options.version) throw new Error(t('The server returned an invalid response.'));
    const projects = [{projectId:result.projectId,projectName:aggregate.name,path:result.path,alreadyAvailable:false}];
    const downloaded: DownloadedServerProject[] = [];
    for (const project of projects) {
      options.signal.throwIfAborted();
      const relative = path.relative(staging, project.path);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || project.alreadyAvailable) { throw new Error(t('The server returned an invalid response.')); }
      const manifest = JSON.parse(await readFile(path.join(project.path, 'steamharness.json'), 'utf8'));
      if (manifest.id !== project.projectId || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)
        || manifest.version !== options.version) { throw new Error(t('The server returned an invalid response.')); }
      const base = `${portableDirectoryPart(project.projectName)}-${manifest.version}`;
      let directory: string;
      for (let index = 0;; index++) {
        directory = path.join(options.parentDirectory, `${base}${index ? `-${index + 1}` : ''}`);
        try { await mkdir(directory); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
      }
      reserved.push(directory);
      for (const entry of await readdir(project.path)) {
        options.signal.throwIfAborted();
        await rename(path.join(project.path, entry), path.join(directory, entry));
      }
      downloaded.push({ id: project.projectId, name: project.projectName, version: manifest.version, directory });
    }
    options.signal.throwIfAborted();
    return downloaded;
  } catch (error) {
    for (const directory of reserved) { await rm(directory, { recursive: true, force: true }); }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
