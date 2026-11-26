import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseProjectReleaseManifest, PROJECT_RELEASE_FILE } from '@steamharness/project-manifest';
import { assistantDataDirectory, managedProjectDataDirectory } from '../../../../cli/src/web/project-data-directory';

const managedStorageMarker = 'managed-project-storage.json';
const hashDirectory = /^[a-f0-9]{24}$/u;
const durableRoots = ['runtime', 'files', 'conversation-imports'];
const noEntry = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const info = (filename: string) => lstat(filename).catch(error => { if (!noEntry(error)) throw error; });

async function objectFile(filename: string, limit = 64 * 1024): Promise<unknown> {
  const entry = await info(filename);
  if (!entry) return;
  if (!entry.isFile() || entry.size > limit) throw new Error('Invalid managed storage metadata.');
  return JSON.parse(await readFile(filename, 'utf8'));
}

function migratedManagedBuilds(value: unknown, projectId: string): { key: string; stamp: string }[] | undefined {
  if (!value || typeof value !== 'object') return;
  const marker = value as { version?: unknown; projectId?: unknown; builds?: unknown };
  if (marker.version === 1 && marker.projectId === projectId && Array.isArray(marker.builds) &&
    marker.builds.every(build => typeof build?.key === 'string' && hashDirectory.test(build.key) &&
      typeof build.stamp === 'string' && /^[a-f0-9]{64}$/u.test(build.stamp))) return marker.builds;
}

const sqliteJournal = /-(?:wal|shm|journal)$/u;

function busy(error: unknown): boolean {
  const code = Number((error as { errcode?: number } | undefined)?.errcode) & 255;
  return code === 5 || code === 6;
}

async function settleJournal(database: string): Promise<void> {
  if (!(await info(database))?.isFile()) throw new Error('Missing old project database.');
  const sidecars = await Promise.all(['-wal', '-shm', '-journal'].map(suffix => info(database + suffix)));
  if (sidecars.some(sidecar => sidecar && !sidecar.isFile())) throw new Error('Invalid old database journal.');
  const filename = pathToFileURL(database);
  filename.searchParams.set('mode', 'rw');
  const db = new DatabaseSync(filename.href, { timeout: 0 });
  try {
    // SQLite exits WAL mode only after obtaining exclusive access and checkpointing.
    // Recover journals left by a terminated process without dropping committed pages.
    if (db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') throw storageBusy();
  } catch (error) { if (busy(error)) throw storageBusy(); throw error; }
  finally { db.close(); }
}

/** Exclude process leases. Once recovered, the durable files must not change. */
async function stampSource(directory: string, signal?: AbortSignal, recover = false): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (relative: string) => {
    signal?.throwIfAborted();
    const absolute = path.join(directory, relative);
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isDirectory()) {
      let names = await readdir(absolute);
      if (recover) {
        const journals = new Set(names.filter(name => sqliteJournal.test(name) && sqliteKind(path.join(relative, name.replace(sqliteJournal, ''))))
          .map(name => name.replace(sqliteJournal, '')));
        for (const name of journals) await settleJournal(path.join(absolute, name));
        if (journals.size) names = await readdir(absolute);
      }
      for (const name of names.sort()) {
        if (relative === 'runtime' && name === 'owners') continue;
        if (sqliteJournal.test(name) && sqliteKind(path.join(relative, name.replace(sqliteJournal, '')))) {
          throw storageBusy();
        }
        await visit(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
    } else throw new Error('Cannot migrate a linked project runtime file.');
  };
  for (const name of (await readdir(directory)).sort()) {
    if (durableRoots.includes(name)) await visit(name);
    else if (name !== 'activity' && name !== 'project.json' && !/^scope-[a-z0-9]+$/iu.test(name)) {
      throw new Error('Unrecognized data in old project storage.');
    }
  }
  return hash.digest('hex');
}

function storageBusy() {
  return Object.assign(new Error('An older build still has its project data open.'), { code: 'MANAGED_PROJECT_STORAGE_BUSY' });
}

async function checkClosed(directory: string, projectId: string): Promise<void> {
  const activity = path.join(directory, 'activity');
  const state = await info(activity);
  if (!state) return;
  if (!state.isDirectory()) throw new Error('Invalid saved activity directory.');
  for (const file of await readdir(activity)) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(file)) continue;
    const lease = await objectFile(path.join(activity, file), 1024 * 1024) as { pid?: number; version?: number; projectId?: string; updatedAt?: number } | undefined;
    if (lease?.version !== 1 || lease.projectId?.toLowerCase() !== projectId || !Number.isSafeInteger(lease.pid) || lease.pid! <= 0 ||
      typeof lease.updatedAt !== 'number' || Math.abs(Date.now() - lease.updatedAt) > 30_000) continue;
    try { process.kill(lease.pid!, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    throw storageBusy();
  }
}

async function discover(storage: string, builds: string, projectId: string, signal?: AbortSignal): Promise<string[]> {
  const root = await realpath(builds);
  const result = new Set<string>();
  for (const child of await readdir(root, { withFileTypes: true })) {
    signal?.throwIfAborted();
    if (!child.isDirectory() || !hashDirectory.test(child.name)) continue;
    const parent = path.join(root, child.name);
    for (const directory of [path.join(parent, 'project'), parent]) {
      const legacy = assistantDataDirectory(storage, projectId, directory);
      if (!await info(legacy)) continue;
      if (!(await lstat(legacy)).isDirectory() || (await realpath(directory)) !== directory) throw new Error('Invalid old build storage.');
      const filename = path.join(directory, PROJECT_RELEASE_FILE);
      const metadata = await objectFile(filename, 8 * 1024 * 1024);
      if (!metadata || parseProjectReleaseManifest(metadata).projectId.toLowerCase() !== projectId) continue;
      const previous = await objectFile(path.join(legacy, 'project.json')) as { projectId?: string; version?: number } | undefined;
      if (previous && (previous.version !== 1 || previous.projectId?.toLowerCase() !== projectId)) throw new Error('Old build storage identity changed.');
      result.add(legacy);
    }
  }
  return [...result].sort();
}

const historyTables = ['history', 'usage', 'agent_sessions', 'run_output_meta', 'run_output_items', 'run_output_events', 'run_output_files', 'run_output_refs', 'run_output_item_refs'];
const memoryTables = ['bot_memories', 'bot_memory_sequence', 'bot_memory_receipts', 'bot_memory_relations', 'bot_memory_changes'];
const artifactTables = ['bot_artifacts'];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function snapshot(source: string, target: string): Promise<void> {
  const sidecars = await Promise.all(['-wal', '-shm', '-journal'].map(suffix => info(source + suffix)));
  if (sidecars.some(Boolean)) throw storageBusy();
  const filename = pathToFileURL(source);
  filename.searchParams.set('immutable', '1');
  const db = new DatabaseSync(filename.href, { readOnly: true, timeout: 500 });
  try { await backup(db, target); } finally { db.close(); }
  const staged = new DatabaseSync(target);
  try {
    staged.exec('PRAGMA journal_mode=DELETE;');
    if (staged.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new Error('Old project database failed validation.');
  } finally { staged.close(); }
}

function relocate(value: unknown, source: string, target: string, key?: string): unknown {
  if (typeof value === 'string' && (key === 'path' || key === 'absolutePath' || key === 'filePath') && path.isAbsolute(value)) {
    const relative = path.relative(source, value);
    if (['files', 'conversation-imports', path.join('runtime', 'bot-files')].some(directory => relative.startsWith(directory + path.sep))) {
      return path.join(target, relative);
    }
  } else if (Array.isArray(value)) return value.map(item => relocate(item, source, target));
  else if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, relocate(item, source, target, name)]));
  return value;
}

function relocateJson(db: DatabaseSync, table: string, column: string, source: string, destination: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) return;
  const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE rowid=?`);
  for (const row of db.prepare(`SELECT rowid, ${quote(column)} AS value FROM ${quote(table)} WHERE instr(${quote(column)}, ?) > 0`).iterate(JSON.stringify(source).slice(1, -1))) {
    const before = String(row.value), after = JSON.stringify(relocate(JSON.parse(before), source, destination));
    if (before !== after) update.run(after, row.rowid);
  }
}

function normalizeHistory(filename: string, source: string, destination: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec("BEGIN; DELETE FROM history WHERE kind='workflow' AND key='conversation-selection';");
    const write = db.prepare('UPDATE agent_sessions SET file=? WHERE key=?');
    for (const row of db.prepare('SELECT key FROM agent_sessions').all()) {
      const key = String(row.key), name = createHash('sha256').update(key).digest('hex') + '.sqlite';
      write.run(path.join(path.toNamespacedPath(destination), 'runtime', 'agents', name), key);
    }
    for (const table of ['history', 'usage', 'run_output_items', 'run_output_events', 'run_output_files']) relocateJson(db, table, 'record', source, destination);
    db.exec('COMMIT');
  } finally { db.close(); }
}

function normalizeAgent(filename: string, source: string, destination: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('BEGIN');
    for (const table of ['conversations', 'entries', 'tasks', 'submissions', 'documents']) relocateJson(db, table, 'record', source, destination);
    relocateJson(db, 'document_revisions', 'content', source, destination);
    relocateJson(db, 'runtime_commits', 'writes', source, destination);
    db.exec('COMMIT');
  } finally { db.close(); }
}

async function finishHistory(filename: string, stagedRuntime: string) {
  const db = new DatabaseSync(filename);
  try {
    for (const row of db.prepare('SELECT file FROM agent_sessions WHERE deleted=0').iterate()) {
      const name = path.basename(String(row.file));
      if (!/^[a-f0-9]{64}\.sqlite$/u.test(name) || !(await info(path.join(stagedRuntime, 'agents', name)))?.isFile()) {
        throw new Error('A saved agent checkpoint is missing.');
      }
    }
    const row = db.prepare(`SELECT key FROM history WHERE kind='conversation' AND deleted=0 AND json_valid(record)
      ORDER BY coalesce(json_array_length(record, '$.messages'),0)>0 DESC, json_extract(record,'$.state.updatedAt') DESC, key LIMIT 1`).get();
    if (row) db.prepare('INSERT INTO history(kind,key,scope,revision,deleted,record) VALUES (?,?,?,?,0,?)').run(
      'workflow', 'conversation-selection', 'conversation-selection', 1,
      JSON.stringify({ kind: 'workflow', key: 'conversation-selection', scope: 'conversation-selection', revision: 1,
        state: { activeId: row.key }, messages: [], queue: [], events: [], values: [] }));
  } finally { db.close(); }
}

function mergeSqlite(target: string, source: string, tables: readonly string[]) {
  const db = new DatabaseSync(target);
  try {
    db.prepare('ATTACH DATABASE ? AS incoming').run(pathToFileURL(source).href + '?mode=ro');
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON;');
    const schema = (prefix: 'main' | 'incoming') => {
      const entries = db.prepare(`SELECT type, name, sql FROM ${prefix}.sqlite_schema WHERE type IN ('table','trigger','view') AND name NOT LIKE 'sqlite_%'`).all();
      if (entries.some(entry => entry.type !== 'table' || !tables.includes(String(entry.name)))) throw new Error('Unsupported project runtime database schema.');
      return new Map(entries.map(entry => [String(entry.name), String(entry.sql)]));
    };
    const current = schema('main'), incoming = schema('incoming');
    for (const name of tables) {
      const declaration = incoming.get(name);
      if (!declaration) continue;
      const table = quote(name);
      if (!current.has(name)) {
        if (!new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${name}\\s*\\(`, 'iu').test(declaration)) throw new Error('Unsupported runtime table declaration.');
        db.prepare(declaration).run();
      }
      const columns = (prefix: 'main' | 'incoming') => db.prepare(`PRAGMA ${prefix}.table_info(${table})`).all().map(row => String(row.name));
      const from = columns('incoming'), into = columns('main');
      if (!from.length || from.length !== into.length || from.some(column => !into.includes(column))) throw new Error('Incompatible old runtime schema.');
      if (name === 'bot_memory_sequence') {
        db.exec('UPDATE main.bot_memory_sequence SET revision = max(revision, coalesce((SELECT max(revision) FROM incoming.bot_memory_sequence), revision));');
        continue;
      }
      const fields = (name === 'bot_artifacts' ? from.filter(column => column !== 'position') : from).map(quote).join(', ');
      db.exec(`INSERT OR IGNORE INTO main.${table} (${fields}) SELECT ${fields} FROM incoming.${table}${name === 'bot_artifacts' ? ' ORDER BY position' : ''};`);
      // A uniqueness/constraint conflict is safe only when the entire incoming row already exists.
      if (db.prepare(`SELECT 1 FROM (SELECT ${fields} FROM incoming.${table} EXCEPT SELECT ${fields} FROM main.${table}) LIMIT 1`).get()) {
        throw new Error('Old project databases contain conflicting records.');
      }
    }
    if (db.prepare('PRAGMA main.foreign_key_check').get()) throw new Error('Old project database contains invalid references.');
    db.exec('COMMIT;');
  } finally { db.close(); }
}

function sqliteKind(relative: string): 'history' | 'memory' | 'artifact' | 'agent' | undefined {
  const parts = relative.split(path.sep);
  if (relative === path.join('runtime', 'history.sqlite')) return 'history';
  if (parts[0] !== 'runtime' || !/^[a-f0-9]{64}\.sqlite$/u.test(parts.at(-1)!)) return;
  if (parts.length === 3) return parts[1] === 'memories' ? 'memory' : parts[1] === 'bot-deliveries' ? 'artifact' : parts[1] === 'agents' ? 'agent' : undefined;
  if (parts.length === 5 && parts[1] === 'memories-by-directory' && /^[a-f0-9]{64}$/u.test(parts[2]) && parts[3] === 'memories') return 'memory';
}

async function copyRuntime(source: string, staged: string, destination: string, scratch: string, signal?: AbortSignal) {
  const digest = async (file: string) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest('hex');
  };
  const copy = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const from = path.join(source, relative), to = path.join(staged, relative), entry = await info(from);
    if (!entry) return;
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const child of await readdir(from)) {
        if (relative === 'runtime' && child === 'owners') continue;
        if (sqliteJournal.test(child) && sqliteKind(path.join(relative, child.replace(sqliteJournal, '')))) throw storageBusy();
        await copy(path.join(relative, child));
      }
    } else if (entry.isFile()) {
      const kind = sqliteKind(relative);
      if (kind) {
        await snapshot(from, scratch);
        try {
          if (kind === 'history') normalizeHistory(scratch, source, destination);
          if (kind === 'agent') normalizeAgent(scratch, source, destination);
          if (!await info(to)) await rename(scratch, to);
          else if (kind !== 'agent') mergeSqlite(to, scratch, kind === 'history' ? historyTables : kind === 'memory' ? memoryTables : artifactTables);
          else if (await digest(to) !== await digest(scratch)) throw new Error('Old builds contain conflicting agent checkpoints.');
        } finally { await rm(scratch, { force: true }); }
      } else if (/^files[\\/]wf_[a-f0-9]{32}[\\/]metadata\.json$/u.test(relative)) {
        const text = JSON.stringify(relocate(await objectFile(from), source, destination));
        if (!await info(to)) await writeFile(to, text, { flag: 'wx', mode: 0o600 });
        else if (text !== await readFile(to, 'utf8')) throw new Error('Old builds contain conflicting file metadata.');
      } else if (!await info(to)) await copyFile(from, to, constants.COPYFILE_EXCL);
      else if (await digest(to) !== await digest(from)) throw new Error('Old builds contain conflicting runtime files.');
    } else throw new Error('Cannot migrate a linked project runtime file.');
  };
  for (const root of durableRoots) await copy(root);
}

const retiringPath = (storage: string, key: string, stamp: string) => path.join(storage, `migrated-${key}-${stamp.slice(0, 16)}`);

async function removeMigratedSources(storage: string, cache: string, projectId: string, builds: { key: string; stamp: string }[], signal?: AbortSignal) {
  let verified: Set<string> | undefined;
  for (const { key, stamp } of builds) {
    signal?.throwIfAborted();
    const source = path.join(storage, key);
    const retiring = retiringPath(storage, key, stamp);
    const entry = await info(source);
    if (!await info(retiring)) {
      if (!entry) continue;
      if (!entry.isDirectory()) throw new Error('Invalid old project storage.');
      verified ??= new Set(await discover(storage, cache, projectId, signal));
      if (!verified.has(source)) throw new Error('Could not verify the old build before removal.');
      await checkClosed(source, projectId);
      if (await stampSource(source, signal) !== stamp) throw new Error('Old project storage changed after migration.');
      await rename(source, retiring);
    }
    try {
      if (!(await lstat(retiring)).isDirectory()) throw new Error('Invalid retiring project storage.');
      await checkClosed(retiring, projectId);
      if (await stampSource(retiring, signal) !== stamp) throw new Error('Old project storage changed before removal.');
    } catch (error) {
      if (!await info(source)) await rename(retiring, source);
      throw error;
    }
    await rm(retiring, { recursive: true, force: true });
    if (await info(source)) throw new Error('The old build reopened its project storage.');
  }
}

async function withMigrationLock<T>(storage: string, use: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const filename = path.join(storage, 'managed-project-migrations.sqlite');
  const entry = await info(filename);
  if (entry && !entry.isFile()) throw new Error('Invalid managed project migration lock.');
  const lock = new DatabaseSync(filename, { timeout: 0 });
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      signal?.throwIfAborted();
      try { lock.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (!busy(error) || Date.now() >= deadline) throw error;
        await wait(100, undefined, { signal });
      }
    }
    return await use();
  } finally { lock.close(); }
}

/** Publish a verified runtime before removing its pre-upgrade stores. */
export async function prepareManagedProjectStorage(options: { storage: string; builds: string; projectId: string; entryId: string; projectType: string; signal?: AbortSignal }): Promise<string> {
  const { projectId: id, builds, entryId, projectType, signal } = options;
  const projectId = id.toLowerCase();
  const storage = path.resolve(options.storage);
  const destination = managedProjectDataDirectory(storage, projectId);
  await mkdir(storage, { recursive: true, mode: 0o700 });
  if (!(await lstat(storage)).isDirectory()) throw new Error('Invalid managed project storage root.');
  const readReady = async () => {
    const state = await info(destination);
    if (!state) return;
    const migrated = state.isDirectory() && migratedManagedBuilds(await objectFile(path.join(destination, managedStorageMarker)), projectId);
    if (!migrated || migrated.some(build => build.key === path.basename(destination))) throw new Error('Invalid managed project runtime directory.');
    return migrated;
  };
  const known = await readReady();
  if (known && !(await Promise.all(known.flatMap(build => [info(path.join(storage, build.key)), info(retiringPath(storage, build.key, build.stamp))]))).some(Boolean)) return destination;
  return withMigrationLock(storage, async () => {
    const existing = await readReady();
    if (existing) {
      await removeMigratedSources(storage, builds, projectId, existing, signal);
      return destination;
    }
    const legacy = await discover(storage, builds, projectId, signal);
    for (const source of legacy) await checkClosed(source, projectId);
    const staging = await mkdtemp(path.join(storage, 'managed-project-'));
    try {
      const snapshot = path.join(staging, 'data');
      await mkdir(snapshot, { mode: 0o700 });
      const migrated = [];
      for (const source of legacy) {
        const stamp = await stampSource(source, signal, true);
        await copyRuntime(source, snapshot, destination, path.join(staging, 'incoming.sqlite'), signal);
        await checkClosed(source, projectId);
        if (await stampSource(source, signal) !== stamp) throw new Error('Old project storage changed during migration.');
        migrated.push({ key: path.basename(source), stamp });
      }
      const runtime = path.join(snapshot, 'runtime'), history = path.join(runtime, 'history.sqlite');
      if (await info(history)) await finishHistory(history, runtime);
      await writeFile(path.join(snapshot, 'project.json'), JSON.stringify({ version: 1, projectId, entryId, projectType }), { mode: 0o600 });
      await writeFile(path.join(snapshot, managedStorageMarker), JSON.stringify({ version: 1, projectId, builds: migrated }), { mode: 0o600 });
      signal?.throwIfAborted();
      await rename(snapshot, destination);
      await removeMigratedSources(storage, builds, projectId, migrated, signal);
      return destination;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }, signal);
}
