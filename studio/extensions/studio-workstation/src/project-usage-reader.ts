import { createHash } from 'node:crypto';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Dirent, Stats } from 'node:fs';
import { isProjectEntryId, parseProjectReleaseManifest, PROJECT_MANIFEST_FILE, PROJECT_RELEASE_FILE, PROJECT_UUID_PATTERN, projectEntryFilePath, type ProjectDeclaration, type ProjectEntry } from '@steamharness/project-manifest';
import { readProjectDeclarationFromDirectory } from '@steamharness/project-manifest/node';
import type { DirectoryUsage, EntryUsage, KanbanUsage, ManagedUsageTarget, ProjectUsageSnapshot, RuntimeUsage, UsagePart, UsageSize } from './project-usage-types';

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
  link?(relative: string): void;
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
        } else if (entry.isSymbolicLink()) visitor.link?.(child);
        else if (entry.isFile()) {
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

async function manifest(root: string): Promise<ProjectDeclaration | undefined> {
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
  return { ...declaration, projectId: declaration.projectId.toLowerCase() };
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

async function readDatabase<T>(base: string, file: string, missing: T, query: (db: DatabaseSync) => T, counted?: Set<string>): Promise<T> {
  const info = await beneath(base, file);
  const sidecars = ['-wal', '-shm', '-journal'].map(suffix => file + suffix);
  const [wal, shm, journal] = await Promise.all(sidecars.map(sidecar => beneath(base, sidecar)));
  if (!info && !wal && !shm && !journal) return missing;
  if (!info?.isFile() || !info.size || journal || !!wal !== !!shm || (wal && (!wal.isFile() || !shm?.isFile()))) {
    throw new Error('No consistent history snapshot');
  }
  // Normal SQLite locking sees committed pages in a live WAL. For a closed
  // database, immutable mode avoids creating WAL files just to read it.
  const key = !wal && info.nlink > 1 && info.ino > 0 ? `${info.dev}:${info.ino}` : undefined;
  if (key && counted?.has(key)) return missing;
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
  if (key) counted?.add(key);
  return result;
}

const isIn = (relative: string, directory: string) => relative.startsWith(directory + path.sep);
const baseName = (file: string) => file.replace(/-(?:wal|shm|journal)$/, '');
const history = path.join('runtime', 'history.sqlite');
const agents = path.join('runtime', 'agents');
const memories = path.join('runtime', 'memories');
const scopedMemories = path.join('runtime', 'memories-by-directory');

interface EntryFiles {
  entry: ProjectEntry;
  history: Footprint;
  memory: Footprint;
  memories: Map<string, 'primary' | 'scoped' | undefined>;
  historyDatabases: Set<string>;
  sessions?: number;
  messages?: number;
  runs?: number;
  lastRunAt?: number;
}

const sumCount = (left?: number, right?: number) => left === undefined || right === undefined ? undefined : left + right;

async function visitChildren(storage: string, directory: string, deadline: number, incomplete: () => void,
  visit: (entry: Dirent) => Promise<void>): Promise<void> {
  try {
    const info = await beneath(storage, directory);
    if (!info) return;
    if (!info.isDirectory() || await realpath(directory) !== directory) throw new Error('Not a runtime directory');
    for await (const entry of await opendir(directory, { bufferSize: 32 })) {
      if (performance.now() >= deadline) { incomplete(); return; }
      await visit(entry);
    }
  } catch { incomplete(); }
}

async function storageOwner(storage: string, directory: string): Promise<{ projectId: string; entryId: string; projectType: string } | undefined> {
  const filename = path.join(directory, 'project.json');
  const info = await beneath(storage, filename);
  if (!info) return;
  if (!info.isFile() || info.size > 4096) throw new Error('Invalid runtime identity');
  const value = JSON.parse(await readFile(filename, 'utf8'));
  if (value?.version !== 1 || typeof value.projectId !== 'string' || !PROJECT_UUID_PATTERN.test(value.projectId) || !isProjectEntryId(value.entryId) ||
    !['bot', 'workflow', 'kanban'].includes(value.projectType)) {
    throw new Error('Invalid runtime identity');
  }
  return { projectId: value.projectId.toLowerCase(), entryId: value.entryId, projectType: value.projectType };
}

async function measureHistory(storage: string, directory: string, target: EntryFiles, deadline: number): Promise<boolean> {
  const type = target.entry.type;
  if (type === 'kanban') return false;
  try {
    if (performance.now() >= deadline) throw new Error('Usage time limit');
    const file = path.join(directory, history);
    if (type === 'bot') {
      const counts = await readDatabase(storage, file, { sessions: 0, messages: 0 } as { sessions: number; messages?: number }, db => {
        const row = db.prepare(`SELECT count(*) AS sessions,
          sum(CASE WHEN json_type(record, '$.messages') = 'array' THEN json_array_length(record, '$.messages') END) AS messages,
          count(CASE WHEN json_type(record, '$.messages') = 'array' THEN 1 END) AS valid
          FROM history WHERE kind='conversation' AND deleted=0`).get()!;
        return { sessions: Number(row.sessions), messages: row.valid === row.sessions ? Number(row.messages ?? 0) : undefined };
      }, target.historyDatabases);
      target.sessions = sumCount(target.sessions, counts.sessions);
      target.messages = sumCount(target.messages, counts.messages);
      return counts.sessions > 0;
    }
    const counts = await readDatabase(storage, file, { runs: 0 } as { runs: number; lastRunAt?: number }, db => {
      const row = db.prepare("SELECT count(*) AS runs, max(json_extract(record, '$.state.createdAt')) AS lastRunAt FROM history WHERE kind='run' AND deleted=0").get()!;
      const stamp = row.lastRunAt;
      return { runs: Number(row.runs), ...(typeof stamp === 'number' && stamp > 0 && stamp < 8.64e15 && { lastRunAt: stamp }) };
    }, target.historyDatabases);
    target.runs = sumCount(target.runs, counts.runs);
    if (counts.lastRunAt) target.lastRunAt = Math.max(target.lastRunAt ?? 0, counts.lastRunAt);
    return counts.runs > 0;
  } catch {
    target.sessions = target.messages = target.runs = undefined;
    return false;
  }
}

async function measureRuntime(storage: string, projectId: string, entries: readonly ProjectEntry[], deadline: number, instanceId?: string) {
  if (!PROJECT_UUID_PATTERN.test(projectId) || instanceId && !PROJECT_UUID_PATTERN.test(instanceId)) throw new Error('Invalid usage identity');
  const total = new Footprint(), locations = new Set<string>();
  const targets = new Map(entries.map((entry): [string, EntryFiles] => [entry.entryId, {
    entry, history: new Footprint(), memory: new Footprint(), memories: new Map(), historyDatabases: new Set(), sessions: 0, messages: 0, runs: 0,
  }]));
  const botStores = new Map([...targets.values()].filter(target => target.entry.type === 'bot').map(target => [
    // Core scopes each memory DB by project and entry, even inside a folder Bot.
    `${createHash('sha256').update(JSON.stringify([projectId, target.entry.entryId])).digest('hex')}.sqlite`, target,
  ]));
  const incomplete = () => { total.partial = true; };
  let discoveryIncomplete = false;
  const missingScope = () => { discoveryIncomplete = true; incomplete(); };
  const unknown = (target: EntryFiles) => {
    target.history.partial = target.memory.partial = true;
    target.sessions = target.messages = target.runs = undefined;
    incomplete();
  };
  const missingMemory = () => {
    for (const target of botStores.values()) target.memory.partial = true;
    incomplete();
  };
  const rememberMemory = (target: EntryFiles, filename: string, info: Stats, kind: 'primary' | 'scoped') => {
    const database = baseName(filename);
    target.memory.add(info);
    if (database === filename || !target.memories.has(database)) target.memories.set(database, database === filename ? kind : undefined);
  };
  const measure = async (directory: string, location: string, owner: EntryFiles, shared = false) => {
    const affected = [owner];
    const hasHistory = await measureHistory(storage, directory, owner, deadline);
    let usageOwner = owner;
    // Assistant workdirs can share a DB between the Bot and Studio Control. Count
    // both record kinds if unambiguous, but assign the physical files only once.
    if (shared) for (const type of ['bot', 'workflow']) {
      if (type === owner.entry.type) continue;
      const peers = [...targets.values()].filter(target => target.entry.type === type);
      if (peers.length !== 1) continue;
      const [peer] = peers;
      affected.push(peer);
      if (await measureHistory(storage, directory, peer, deadline) && (!hasHistory || type === 'bot')) usageOwner = peer;
    }
    const memoryOwner = (relative: string) => {
      const database = baseName(relative), parts = database.split(path.sep), target = botStores.get(parts.at(-1)!);
      if (target && (shared || target === owner) && (path.dirname(database) === memories ||
        parts.length === 5 && isIn(database, scopedMemories) && /^[a-f0-9]{64}$/.test(parts[2]) && parts[3] === 'memories')) return target;
    };
    await scan(directory, deadline, {
      file(relative, info) {
        total.add(info); locations.add(location);
        if (baseName(relative) === history || isIn(relative, agents) || isIn(relative, 'files') || isIn(relative, 'conversation-imports')) {
          usageOwner.history.add(info);
        }
        const target = memoryOwner(relative);
        if (target) rememberMemory(target, path.join(directory, relative), info, path.dirname(relative) === memories ? 'primary' : 'scoped');
      },
      link(relative) {
        const target = memoryOwner(relative);
        if (target) { target.memory.partial = true; incomplete(); }
        else if ((shared ? botStores.size > 0 : owner.entry.type === 'bot') &&
          (relative === memories || relative === scopedMemories || isIn(relative, scopedMemories))) {
          for (const item of shared ? botStores.values() : [owner]) item.memory.partial = true;
          incomplete();
        }
      },
      incomplete() {
        for (const target of affected) target.history.partial = target.memory.partial = true;
        if (shared) for (const target of botStores.values()) target.memory.partial = true;
        incomplete();
      },
    });
  };
  const namespace = async (base: string, folderBot: boolean) => {
    // The CLI keeps source and release writes separate; the project view totals both.
    for (const root of [base, path.join(base, 'release')]) {
      const project = path.join(root, 'projects', projectId), parent = path.join(project, 'entries');
      await visitChildren(storage, parent, deadline, missingScope, async child => {
        const owner = targets.get(child.name);
        if (!owner || folderBot && owner.entry.type !== 'bot') return;
        if (!child.isDirectory()) { unknown(owner); return; }
        await measure(path.join(parent, child.name), project, owner);
      });
    }
  };
  const folderBots = path.join(storage, 'folder-bots');
  if (instanceId) await namespace(path.join(folderBots, instanceId.toLowerCase()), true);
  else {
    await namespace(storage, false);
    if (botStores.size) await visitChildren(storage, folderBots, deadline, missingScope, async child => {
      if (child.name === child.name.toLowerCase() && PROJECT_UUID_PATTERN.test(child.name) && child.isDirectory()) {
        await namespace(path.join(folderBots, child.name), true);
      }
    });
    await visitChildren(storage, storage, deadline, missingScope, async child => {
      if (!/^[a-f0-9]{24}$/.test(child.name) || !child.isDirectory()) return;
      const directory = path.join(storage, child.name);
      let identity: Awaited<ReturnType<typeof storageOwner>>;
      try { identity = await storageOwner(storage, directory); } catch { incomplete(); return; }
      if (identity && identity.projectId !== projectId) return;
      const owner = identity && targets.get(identity.entryId);
      if (owner && identity?.projectType === owner.entry.type) {
        await measure(directory, directory, owner, true);
      } else if (botStores.size) {
        // An assistant can write memory for another workspace root without opening a
        // project there. Only the exact project/entry memory store belongs to this project.
        const memoryDirectory = path.join(directory, memories);
        await visitChildren(storage, memoryDirectory, deadline, missingMemory, async child => {
          const target = botStores.get(baseName(child.name));
          if (!target) return;
          try {
            const file = path.join(memoryDirectory, child.name), info = await beneath(storage, file);
            if (!info) return;
            if (!info.isFile()) throw new Error('Invalid memory file');
            total.add(info); locations.add(directory); rememberMemory(target, file, info, 'scoped');
          } catch { target.memory.partial = true; incomplete(); }
        });
      }
    });
  }
  if (discoveryIncomplete) for (const target of targets.values()) unknown(target);
  return { targets, total, location: locations.size === 1 ? locations.values().next().value : undefined };
}

async function memoryUsage(storage: string, projectId: string, target: EntryFiles, deadline: number) {
  const present = [...target.memories].filter(([, kind]) => kind !== undefined);
  const primary = present.filter(([, kind]) => kind === 'primary');
  const location = present.length === 1 ? present[0][0] : primary.length === 1 ? primary[0][0] : undefined;
  const measured = { ...target.memory.size(), ...(location && { location }),
    ...(present.length ? { created: true } : !target.memories.size && !target.memory.partial ? { created: false } : {}) };
  if (target.memory.partial) return measured;
  const counted = new Set<string>();
  let records = 0;
  try {
    for (const file of target.memories.keys()) {
      if (performance.now() >= deadline) return measured;
      records += await readDatabase(storage, file, 0, db => Number(db.prepare(
        'SELECT count(*) AS records FROM bot_memories WHERE project_id=? AND entry_id=?').get(projectId, target.entry.entryId)!.records), counted);
    }
    return { ...measured, records };
  } catch { return measured; }
}

async function runtimeUsage(workdir: string, job: UsageJob, deadline: number): Promise<RuntimeUsage> {
  const target = job.managed;
  const source = target ? target.projectDirectory && await realpath(target.projectDirectory) : workdir;
  const declaration = source ? await manifest(source) : undefined;
  const projectId = declaration?.projectId ?? target?.projectId?.toLowerCase();
  if (!projectId) return { state: 'not-project', size: empty, entries: [] };
  let entries: readonly ProjectEntry[] = declaration?.entries ?? [];
  if (target) {
    if (projectId !== target.projectId.toLowerCase() || !isProjectEntryId(target.entryId) || target.projectDirectory && !declaration) throw new Error('Bot template changed');
    entries = declaration ? entries.filter(entry => entry.entryId === target.entryId && entry.type === 'bot') : [
      { entryId: target.entryId, name: target.name, type: 'bot', root: '.', entry: '' },
    ];
    if (entries.length !== 1) throw new Error('Bot entry changed');
  }
  const storage = await realpath(job.storage).catch(error => { if (absent(error)) return path.resolve(job.storage); throw error; });
  const { targets, total, location } = await measureRuntime(storage, projectId, entries, deadline, target?.instanceId);
  const results: EntryUsage[] = [];
  for (const data of targets.values()) {
    const { entry, sessions, messages, runs, lastRunAt } = data;
    const identity = { entryId: entry.entryId, name: entry.name };
    const size = data.history.size();
    if (entry.type === 'bot') results.push({ ...identity, type: 'bot', conversation: { ...size, sessions, messages },
      memory: await memoryUsage(storage, projectId, data, deadline) });
    else if (entry.type === 'workflow') results.push({ ...identity, type: 'workflow', workflow: { ...size, runs, lastRunAt } });
    else results.push({ ...identity, type: 'kanban', kanban: entry.webApp ? { state: 'hosted' }
      : source && performance.now() < deadline ? await kanbanUsage(source, entry, entries, deadline) : unavailable });
  }
  const incomplete = results.some(entry => entry.type === 'bot' ? entry.conversation.state !== 'ok' || entry.memory.state !== 'ok' ||
    entry.conversation.sessions === undefined || entry.conversation.messages === undefined || entry.memory.records === undefined
    : entry.type === 'workflow' ? entry.workflow.state !== 'ok' || entry.workflow.runs === undefined
      : entry.kanban.state === 'partial' || entry.kanban.state === 'unavailable');
  return { state: total.partial || incomplete ? 'partial' : 'ok', size: total.size(), ...(location && { location }), entries: results };
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
