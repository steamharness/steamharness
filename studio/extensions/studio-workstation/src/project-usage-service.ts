import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROJECT_UUID_PATTERN } from '@steamharness/project-manifest';
import type { ManagedUsageTarget, ProjectUsageSnapshot, UsagePart } from './project-usage-types';
import type { UsageJob } from './project-usage-reader';

interface Task {
  key: string;
  uri: string;
  part: UsagePart;
  managed: boolean;
  expectedProjectId?: string;
  controller: AbortController;
  readers: Map<string, (result: ProjectUsageSnapshot | undefined) => void>;
}

export class ProjectUsageService {
  private readonly cache = new Map<string, ProjectUsageSnapshot>();
  private readonly tasks = new Map<string, Task>();
  private readonly requests = new Map<string, Task>();
  private readonly queued = new Set<Task>();
  private running = 0;
  private disposed = false;

  constructor(private readonly storage: string, private readonly workerFile: string,
    private readonly resolveManaged?: (uri: string) => PromiseLike<ManagedUsageTarget | undefined>) {}

  request(input: unknown): Promise<ProjectUsageSnapshot | undefined> | undefined {
    if (this.disposed || !input || typeof input !== 'object') return;
    const { id, uri, part, managed, refresh, cancel, identity } = input as Record<string, unknown>;
    if (typeof id !== 'string' || !id || id.length > 100) return;
    if (cancel === true) { this.cancel(id); return; }
    if (typeof uri !== 'string' || uri.length > 16_384 || (part !== 'directory' && part !== 'runtime') || this.requests.has(id) || this.requests.size >= 128) return;
    try {
      const url = new URL(uri);
      if (url.protocol !== 'file:' || url.host || url.search || url.hash || !path.isAbsolute(fileURLToPath(url))) return;
    } catch { return; }
    const targetIdentity = typeof identity === 'string' ? identity.slice(0, 128) : '';
    const key = JSON.stringify([uri, part, managed === true, targetIdentity]);
    let task = this.tasks.get(key);
    if (!task) {
      const cached = this.cache.get(key);
      if (managed !== true && refresh !== true && cached && Date.now() - cached.measuredAt < 20_000) return Promise.resolve(cached);
      const projectId = targetIdentity.split(':', 1)[0];
      const expectedProjectId = PROJECT_UUID_PATTERN.test(projectId) ? projectId.toLowerCase() : undefined;
      task = { key, uri, part, managed: managed === true, expectedProjectId, controller: new AbortController(), readers: new Map() };
      this.tasks.set(key, task);
      this.queued.add(task);
    }
    const current = task;
    const result = new Promise<ProjectUsageSnapshot | undefined>(resolve => {
      current.readers.set(id, resolve);
      this.requests.set(id, current);
    });
    this.pump();
    return result;
  }

  private cancel(id: string): void {
    const task = this.requests.get(id);
    if (!task) return;
    this.requests.delete(id);
    task.readers.get(id)?.(undefined);
    task.readers.delete(id);
    if (!task.readers.size) {
      this.tasks.delete(task.key);
      this.queued.delete(task);
      task.controller.abort();
    }
  }

  private pump(): void {
    while (!this.disposed && this.running < 2 && this.queued.size) {
      const task = this.queued.values().next().value!;
      this.queued.delete(task);
      this.running++;
      void this.run(task).catch(() => undefined).then(result => {
        if (this.tasks.get(task.key) !== task) return;
        this.tasks.delete(task.key);
        if (result && !task.managed && result.usage.state === 'ok') {
          this.cache.delete(task.key);
          while (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(task.key, result);
        }
        for (const [id, resolve] of task.readers) { this.requests.delete(id); resolve(result); }
      }).finally(() => { this.running--; this.pump(); });
    }
  }

  private async run(task: Task): Promise<ProjectUsageSnapshot | undefined> {
    const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(32_000)]);
    const resolveManaged = this.resolveManaged;
    const managed = task.managed && resolveManaged ? await new Promise<ManagedUsageTarget | undefined>((resolve, reject) => {
      const abort = () => resolve(undefined);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => signal.aborted ? undefined : resolveManaged(task.uri)).then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    }) : undefined;
    if (signal.aborted || (task.managed && !managed)) return;
    const data: UsageJob = { uri: task.uri, part: task.part, managed, storage: this.storage, expectedProjectId: task.expectedProjectId };
    return new Promise(resolve => {
      const worker = new Worker(this.workerFile, { workerData: data, execArgv: [], name: 'Studio project usage' });
      let finished = false;
      const finish = (result?: ProjectUsageSnapshot) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        // Keep the concurrency slot occupied until the previous worker has stopped.
        void worker.terminate().catch(() => undefined).then(() => resolve(result));
      };
      const abort = () => finish();
      worker.on('error', abort);
      worker.once('exit', abort);
      worker.once('message', result => finish(result));
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.requests.keys()) this.cancel(id);
    this.cache.clear();
  }
}
