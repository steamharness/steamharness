import { createHash } from 'node:crypto';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Stats } from 'node:fs';
import { isProjectEntryId, parseProjectReleaseManifest, PROJECT_MANIFEST_FILE, PROJECT_RELEASE_FILE, PROJECT_UUID_PATTERN, projectEntryFilePath, type ProjectDeclaration, type ProjectEntry } from '@steamharness/project-manifest';
import { readProjectDeclarationFromDirectory } from '@steamharness/project-manifest/node';
import type { DirectoryUsage, EntryUsage, KanbanUsage, ManagedUsageTarget, ProjectUsageSnapshot, RuntimeUsage, UsagePart, UsageSize, UsageState } from './project-usage-types';

export interface UsageJob {
  uri: string;
  part: UsagePart;
  storage: string;
  managed?: ManagedUsageTarget;
}

const unavailable: Readonly<UsageSize> = { state: 'unavailable' };
const empty: Readonly<UsageSize> = { state: 'ok', bytes: 0 };
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (parent: string, target: string) => {
  const relative = path.relative(parent, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Studio owns the base path. Refuse links in each component beneath it. */
async function beneath(base: string, target: string): Promise<Stats | undefined> {
  if (!inside(base, target)) throw new Error('Outside usage root');
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  let current = base;
  try {
    let info = await lstat(current);
    for (const part of parts) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid usage directory');
      current = path.join(current, part);
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) throw new Error('Linked usage path');
    return info;
  } catch (error) { if (!absent(error)) throw error; }
}

class Footprint {
  bytes = 0;
  files = 0;
  directories = 0;
  partial = false;
  private readonly links = new Set<string>();
  add(info: Stats) {
    this.files++;
    if (info.nlink > 1 && info.ino > 0) {
      const key = `${info.dev}:${info.ino}`;
      if (this.links.has(key)) return;
      this.links.add(key);
    }
    this.bytes += info.size;
  }
  size(): UsageSize { return { state: this.partial ? 'partial' : 'ok', bytes: this.bytes }; }
}

interface ScanVisitor {
  directory?(relative: string): void;
  file(relative: string, info: Stats): void;
  incomplete(relative: string): void;
}

// Walk once per scope. Keep at most a bounded batch of stat calls and one open directory.
async function scan(root: string, deadline: number, visitor: ScanVisitor): Promise<void> {
  const pending = [''];
  while (pending.length) {
    if (performance.now() >= deadline) {
      for (const relative of pending) visitor.incomplete(relative);
      return;
    }
    const relative = pending.pop()!, directory = path.join(root, relative);
    const files: Promise<void>[] = [];
    try {
      if (await realpath(directory) !== directory) { visitor.incomplete(relative); continue; }
      const entries = await opendir(directory, { bufferSize: 64 });
      for await (const entry of entries) {
        if (performance.now() >= deadline) { visitor.incomplete(relative); break; }
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) {
          visitor.directory?.(child);
          pending.push(child);
        } else if (entry.isFile()) {
          files.push(lstat(path.join(root, child)).then(info => {
            if (info.isFile()) visitor.file(child, info);
            else visitor.incomplete(child);
          }, () => visitor.incomplete(child)));
          if (files.length === 24) await Promise.all(files.splice(0));
        }
      }
    } catch { visitor.incomplete(relative); }
    finally { await Promise.all(files); }
  }
}

async function directoryUsage(root: string, deadline: number): Promise<DirectoryUsage> {
  const total = new Footprint(), folders = new Map<string, Footprint>();
  const group = (relative: string) => folders.get(relative.split(path.sep, 1)[0]);
  await scan(root, deadline, {
    directory(relative) {
      total.directories++;
      if (!relative.includes(path.sep)) folders.set(relative, new Footprint());
    },
    file(relative, info) { total.add(info); group(relative)?.add(info); },
    incomplete(relative) { total.partial = true; const folder = group(relative); if (folder) folder.partial = true; },
  });
  const ranked = Array.from(folders, ([name, folder]) => ({ name, ...folder.size(), bytes: folder.bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  // Keep the bridge payload bounded for roots containing thousands of immediate folders.
  const limit = 2000;
  return { ...total.size(), path: root, files: total.files, directories: total.directories, folders: ranked.slice(0, limit),
    ...(ranked.length > limit && { omittedFolders: ranked.length - limit }) };
}

async function manifest(root: string): Promise<{ declaration: ProjectDeclaration; release: boolean } | undefined> {
  const file = path.join(root, PROJECT_MANIFEST_FILE);
  const info = await beneath(root, file);
  if (!info) return;
  if (!info.isFile() || info.size > 2_000_000) throw new Error('Project declaration unavailable');
  const [document, declaration] = await Promise.all([
    readFile(file, 'utf8').then(text => JSON.parse(text)),
    readProjectDeclarationFromDirectory(root),
  ]);
  const releaseFile = path.join(root, PROJECT_RELEASE_FILE), release = await beneath(root, releaseFile);
  if (release || document.distribution !== undefined) {
    if (!release?.isFile() || release.size > 8_000_000 || document.distribution?.kind !== 'release' || document.distribution.version !== 1) throw new Error('Release metadata unavailable');
    const sealed = parseProjectReleaseManifest(JSON.parse(await readFile(releaseFile, 'utf8')));
    if (sealed.projectId !== declaration.projectId || sealed.projectVersion !== declaration.version || sealed.entries.length !== declaration.entries.length ||
      declaration.entries.some(entry => !sealed.entries.some(item => item.entryId === entry.entryId && item.entry === entry.entry && item.root === entry.root))) {
      throw new Error('Release metadata does not match this project');
    }
  }
  return { declaration: { ...declaration, projectId: declaration.projectId.toLowerCase() }, release: !!release };
}

function projectStorage(storage: string, projectId: string, release: boolean, instanceId?: string): string {
  // Match CLI project-data-directory.ts (source/download, release, then per-entry).
  if (!PROJECT_UUID_PATTERN.test(projectId) || instanceId && !PROJECT_UUID_PATTERN.test(instanceId)) throw new Error('Invalid usage identity');
  return path.join(storage, ...(instanceId ? ['folder-bots', instanceId.toLowerCase()] : []), ...(release ? ['release'] : []), 'projects', projectId.toLowerCase());
}

async function sized(root: string, deadline: number): Promise<UsageSize> {
  const total = new Footprint();
  await scan(root, deadline, { file: (_, info) => total.add(info), incomplete: () => { total.partial = true; } });
  return total.size();
}

async function kanbanUsage(root: string, entry: ProjectEntry, entries: readonly ProjectEntry[], deadline: number): Promise<KanbanUsage> {
  if (entry.webApp) return { state: 'hosted' };
  const html = path.resolve(root, projectEntryFilePath(entry)), location = path.dirname(html);
  try {
    const file = await beneath(root, html);
    if (!file) return { state: 'unbuilt' };
    if (!file.isFile()) return unavailable;
    const shared = location === root || entries.some(other => {
      if (entry === other || other.webApp) return false;
      const otherPath = path.resolve(root, projectEntryFilePath(other));
      const otherLocation = path.dirname(otherPath);
      return inside(location, otherPath) || other.type === 'kanban' && otherLocation !== root && inside(otherLocation, location);
    });
    return shared ? { state: 'shared' } : { ...await sized(location, deadline), location };
  } catch { return unavailable; }
}

async function readDatabase<T>(base: string, file: string, missing: T, query: (db: DatabaseSync) => T): Promise<T> {
  const info = await beneath(base, file);
  const sidecars = ['-wal', '-shm', '-journal'].map(suffix => file + suffix);
  const [wal, shm, journal] = await Promise.all(sidecars.map(sidecar => beneath(base, sidecar)));
  if (!info && !wal && !shm && !journal) return missing;
  if (!info?.isFile() || !info.size || journal || !!wal !== !!shm || (wal && (!wal.isFile() || !shm?.isFile()))) {
    throw new Error('No consistent history snapshot');
  }
  // Normal SQLite locking sees committed pages in a live WAL. For a closed
  // database, immutable mode avoids creating WAL files just to read it.
  const filename = pathToFileURL(file);
  if (!wal) filename.searchParams.set('immutable', '1');
  const db = new DatabaseSync(filename.href, { readOnly: true, timeout: 150 });
  let result: T;
  try { result = query(db); } finally { db.close(); }
  if (!wal) {
    const [after, ...sidecarsAfter] = await Promise.all([beneath(base, file), ...sidecars.map(sidecar => beneath(base, sidecar))]);
    if (!after || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs || sidecarsAfter.some(Boolean)) throw new Error('History changed while measuring');
  }
  return result;
}

const isDbFile = (relative: string, database: string) => relative === database || ['-wal', '-shm', '-journal'].some(suffix => relative === database + suffix);
const isIn = (relative: string, directory: string) => relative.startsWith(directory + path.sep);
const history = path.join('runtime', 'history.sqlite');
const agents = path.join('runtime', 'agents');
const scopedMemories = path.join('runtime', 'memories-by-directory');

async function entryUsage(storage: string, root: string, source: string | undefined, projectId: string, entry: ProjectEntry, entries: readonly ProjectEntry[], total: Footprint, deadline: number): Promise<EntryUsage> {
  const identity = { entryId: entry.entryId, name: entry.name };
  const usage = new Footprint(), memory = new Footprint();
  // The Core memory store is scoped by the project and entry even in a folder Bot namespace.
  const memoryName = `${createHash('sha256').update(JSON.stringify([projectId.toLowerCase(), entry.entryId])).digest('hex')}.sqlite`;
  const memoryFile = path.join('runtime', 'memories', memoryName);
  const memoryFiles = new Set([memoryFile]), presentMemoryFiles = new Set<string>();
  if (performance.now() >= deadline) {
    total.partial = true;
    if (entry.type === 'bot') return { ...identity, type: 'bot', conversation: unavailable, memory: unavailable };
    if (entry.type === 'workflow') return { ...identity, type: 'workflow', workflow: unavailable };
    return { ...identity, type: 'kanban', kanban: entry.webApp ? { state: 'hosted' } : unavailable };
  }
  let scanState: UsageState = 'ok';
  try {
    const info = await beneath(storage, root);
    if (info) {
      if (!info.isDirectory()) throw new Error('Not an entry data directory');
      await scan(root, deadline, {
        file(relative, info) {
          total.add(info);
          if (entry.type === 'bot' && (isDbFile(relative, memoryFile) || isIn(relative, scopedMemories))) {
            const database = relative.replace(/-(?:wal|shm|journal)$/, '');
            // Match the additional stores written by CLI project-data-directory.ts.
            const parts = database.split(path.sep);
            if (database === memoryFile || parts.length === 5 && parts[0] === 'runtime' && parts[1] === 'memories-by-directory' &&
              /^[a-f0-9]{64}$/.test(parts[2]) && parts[3] === 'memories' && parts[4] === memoryName) {
              memory.add(info); memoryFiles.add(database);
              if (database === relative) presentMemoryFiles.add(database);
            }
          }
          if (isDbFile(relative, history) || isIn(relative, agents) || isIn(relative, 'files') || isIn(relative, 'conversation-imports')) usage.add(info);
        },
        incomplete() { total.partial = usage.partial = memory.partial = true; },
      });
    }
  } catch { scanState = 'unavailable'; total.partial = true; }
  const usageSize = scanState === 'ok' ? usage.size() : unavailable;
  const memorySize = scanState === 'ok' ? memory.size() : unavailable;
  if (entry.type === 'bot') {
    const describe = (files: Set<string>) => {
      const location = files.has(memoryFile) ? memoryFile : files.size === 1 ? [...files][0] : undefined;
      return { created: files.size > 0, ...(location && { location: path.join(root, location) }) };
    };
    const memoryMetadata = presentMemoryFiles.size ? describe(presentMemoryFiles) : {};
    if (performance.now() >= deadline) return { ...identity, type: 'bot', conversation: usageSize, memory: { ...memorySize, ...memoryMetadata } };
    const conversation = await readDatabase(storage, path.join(root, history), { sessions: 0, messages: 0 }, db => {
      const row = db.prepare(`SELECT count(*) AS sessions,
        sum(CASE WHEN json_type(record, '$.messages') = 'array' THEN json_array_length(record, '$.messages') END) AS messages,
        count(CASE WHEN json_type(record, '$.messages') = 'array' THEN 1 END) AS valid
        FROM history WHERE kind='conversation' AND deleted=0`).get()!;
      return { sessions: Number(row.sessions), messages: row.valid === row.sessions ? Number(row.messages ?? 0) : undefined };
    }).then(counts => ({ ...usageSize, ...counts }), () => usageSize);
    const readMemory = async () => {
      const partial = { ...memorySize, ...memoryMetadata };
      if (memorySize.state !== 'ok') return partial;
      let records = 0;
      const countedFiles = new Set<string>();
      try {
        for (const file of memoryFiles) {
          if (performance.now() >= deadline) return partial;
          const count = await readDatabase(storage, path.join(root, file), undefined as number | undefined, db =>
            Number(db.prepare('SELECT count(*) AS records FROM bot_memories WHERE project_id=? AND entry_id=?').get(projectId, entry.entryId)!.records));
          if (count !== undefined) { records += count; countedFiles.add(file); }
        }
        return { ...memorySize, ...describe(countedFiles), records };
      } catch { return partial; }
    };
    return { ...identity, type: 'bot', conversation, memory: await readMemory() };
  }
  if (entry.type === 'workflow') {
    if (performance.now() >= deadline) return { ...identity, type: 'workflow', workflow: usageSize };
    const workflow = await readDatabase(storage, path.join(root, history), { runs: 0 } as { runs: number; lastRunAt?: number }, db => {
      const row = db.prepare("SELECT count(*) AS runs, max(json_extract(record, '$.state.createdAt')) AS lastRunAt FROM history WHERE kind='run' AND deleted=0").get()!;
      const stamp = row.lastRunAt;
      return { runs: Number(row.runs), ...(typeof stamp === 'number' && stamp > 0 && stamp < 8.64e15 && { lastRunAt: stamp }) };
    }).then(counts => ({ ...usageSize, ...counts }), () => usageSize);
    return { ...identity, type: 'workflow', workflow };
  }
  return { ...identity, type: 'kanban', kanban: source ? await kanbanUsage(source, entry, entries, deadline) : unavailable };
}

async function runtimeUsage(workdir: string, job: UsageJob, deadline: number): Promise<RuntimeUsage> {
  const target = job.managed;
  const source = target ? target.projectDirectory && await realpath(target.projectDirectory) : workdir;
  const loaded = source ? await manifest(source) : undefined;
  const projectId = loaded?.declaration.projectId ?? target?.projectId?.toLowerCase();
  if (!projectId) return { state: 'not-project', size: empty, entries: [] };
  let entries: readonly ProjectEntry[] = loaded?.declaration.entries ?? [];
  if (target) {
    if (projectId !== target.projectId.toLowerCase() || !isProjectEntryId(target.entryId) || target.projectDirectory && !loaded) throw new Error('Bot template changed');
    entries = loaded ? entries.filter(entry => entry.entryId === target.entryId && entry.type === 'bot') : [
      { entryId: target.entryId, name: target.name, type: 'bot', root: '.', entry: '' },
    ];
    if (entries.length !== 1) throw new Error('Bot entry changed');
  }
  const storage = await realpath(job.storage).catch(error => { if (absent(error)) return path.resolve(job.storage); throw error; });
  const location = projectStorage(storage, projectId, loaded?.release === true, target?.instanceId);
  const total = new Footprint(), results: EntryUsage[] = [];
  for (const entry of entries) {
    results.push(await entryUsage(storage, path.join(location, 'entries', entry.entryId), source, projectId, entry, entries, total, deadline));
  }
  const incomplete = results.some(entry => entry.type === 'bot' ? entry.conversation.state !== 'ok' || entry.memory.state !== 'ok' ||
    entry.conversation.sessions === undefined || entry.conversation.messages === undefined || entry.memory.records === undefined
    : entry.type === 'workflow' ? entry.workflow.state !== 'ok' || entry.workflow.runs === undefined
      : entry.kanban.state === 'partial' || entry.kanban.state === 'unavailable');
  return { state: total.partial || incomplete ? 'partial' : 'ok', size: total.size(), location, entries: results };
}

export async function readProjectUsage(job: UsageJob, budgetMs = 25_000): Promise<ProjectUsageSnapshot> {
  const deadline = performance.now() + budgetMs;
  const { part } = job;
  try {
    const uri = new URL(job.uri);
    if (uri.protocol !== 'file:' || uri.host || uri.search || uri.hash) throw new Error('Not a local folder');
    const root = await realpath(job.managed?.directory ?? fileURLToPath(uri));
    if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory');
    return part === 'directory' ? { part, usage: await directoryUsage(root, deadline), measuredAt: Date.now() } :
      { part, usage: await runtimeUsage(root, job, deadline), measuredAt: Date.now() };
  } catch {
    return part === 'directory' ? { part, usage: { ...unavailable, folders: [] }, measuredAt: Date.now() } :
      { part, usage: { state: 'unavailable', size: unavailable, entries: [] }, measuredAt: Date.now() };
  }
}
