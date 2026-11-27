import { fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { localProjectDirectory, prepareLocalDirectory } from '@steamharness/project-manifest/node';
import { currentPlatformConnections } from '../platform-connections';
import { executionAccountDirectory } from '../local-storage-account';
import { getHostUserSettings } from '../user-settings';
import type { RunLocalProjectOptions, runLocalProjectWithReport } from './index';

type Report = Awaited<ReturnType<typeof runLocalProjectWithReport>>;

/** A library cannot change its caller's cwd. Native hosts with callbacks own their execution process. */
export function isolatedLocalRun(options: RunLocalProjectOptions, projectDir: string, projectId: string): Promise<Report> | undefined {
  if (options.runtimeHost || options.storage || options.fileStore || options.userInput || options.providers || options.nodeHooks ||
    options.authorizeEntry || options.entryConversationHost || options.inheritedToolPermissions || options.onRuntimeEvent || options.onDefinedNodes) return;
  if (process.env.STEAMHARNESS_LOCAL_SDK_WORKER === '1' && process.send && options.workdir === process.cwd()) return;
  return spawnLocalRun(options, projectDir, projectId);
}

async function spawnLocalRun(options: RunLocalProjectOptions, projectDir: string, projectId: string): Promise<Report> {
  const platform = currentPlatformConnections();
  const account = executionAccountDirectory();
  const cwd = realpathSync(options.folderContext?.directory ?? options.workdir ?? prepareLocalDirectory(localProjectDirectory(account, projectId)));
  const { abortSignal, ...input } = options;
  abortSignal?.throwIfAborted();
  const source = import.meta.url.endsWith('.ts');
  const worker = new URL(source ? './local-run-worker.ts' : './local-run-worker.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { cwd, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: source ? ['--import', import.meta.resolve('tsx'), '--conditions=development'] : [],
      env: { ...process.env, STEAMHARNESS_LOCAL_ACCOUNT_KEY: path.basename(account), STEAMHARNESS_LOCAL_SDK_WORKER: '1', STEAMHARNESS_PROJECT_WORKDIR: cwd, ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: '1' }) } });
    let timer: ReturnType<typeof setTimeout> | undefined, report: Report | undefined, error: Error | undefined;
    const abort = () => { if (child.connected) child.send({ cancel: true }, () => {}); timer = setTimeout(() => child.kill('SIGKILL'), 3000).unref(); };
    abortSignal?.addEventListener('abort', abort, { once: true });
    child.on('message', (message: { report?: Report; error?: string }) => { report = message.report; if (message.error) error = new Error(message.error); });
    child.once('error', failure => { error = failure; });
    child.once('close', code => {
      abortSignal?.removeEventListener('abort', abort); clearTimeout(timer);
      if (report && code === 0) resolve(report); else reject(error ?? abortSignal?.reason ?? new Error(`Local project worker exited (${code}).`));
    });
    try { child.send({ options: { ...input, projectDir, workdir: cwd }, platform, settings: getHostUserSettings() }, failure => { if (failure) { error = failure; child.kill(); } }); }
    catch (failure) { error = failure as Error; child.kill(); }
  });
}
