import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { BOT_CREDENTIAL_MAX_FIELDS, isBotCredentialFieldName, parseBotCredentialSlot,
  type BotCredentialCaptureReceipt, type BotCredentialFieldType, type BotCredentialStructure } from '../../../../harness/src/types/bot-credential';
import { parseBotCredentialUse, type BotCredentialUse, type BotCredentialUseResult } from '../../../../harness/src/types/bot-credential-use';
import { DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';

export const botCredentialKinds = ['api-key', 'password', 'ssh-private-key', 'structured'] as const;
const legacyPairKind = 'access-key-pair';
const legacyPairFields = ['AccessKeyId', 'AccessKeySecret'] as const;
export type BotCredentialKind = typeof botCredentialKinds[number] | typeof legacyPairKind;
export type BotCredentialSummary = { name: string; kind: BotCredentialKind };
export type BotCredentialSlot = BotCredentialSummary & { fields?: readonly string[]; replace?: true };
export interface BotCredentialScope { projectId: string; entryId: string; projectDirectory: string; instanceId?: string; workdir?: string }
type BotCredentialApproval = { scopeId: string; mode: 'prompt' | 'reuse' } | { mode: 'auto' };
export type BotCredentialAction = { action: 'capture'; slot: BotCredentialSlot } | { action: 'manage' }
  | { action: 'use'; use: BotCredentialUse; approval?: BotCredentialApproval };
export type BotCredentialResult = 'declined' | 'managed' | 'busy' | 'unavailable' | 'approval-required' | BotCredentialCaptureReceipt | BotCredentialUseResult;
export const validBotCredentialName = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const validKind = (value: unknown): value is BotCredentialKind => value === legacyPairKind || botCredentialKinds.some(kind => kind === value);

export function parseBotCredentialAction(value: Record<string, unknown>): BotCredentialAction | undefined {
  const actionFields = value.action === 'use' ? ['use', 'approval'] : value.action === 'capture' ? ['slot'] : [];
  if (Object.keys(value).some(key => !['type', 'id', 'entryId', 'action', ...actionFields].includes(key))) return;
  if (value.action === 'use') {
    let approval: BotCredentialApproval | undefined;
    if (value.approval !== undefined) {
      if (!value.approval || typeof value.approval !== 'object' || Array.isArray(value.approval)) return;
      const candidate = value.approval as Record<string, unknown>;
      if (candidate.mode === 'auto' && Object.keys(candidate).every(key => key === 'mode')) approval = { mode: 'auto' };
      else if ((candidate.mode === 'prompt' || candidate.mode === 'reuse') && Object.keys(candidate).every(key => key === 'scopeId' || key === 'mode')
        && typeof candidate.scopeId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(candidate.scopeId)) approval = { scopeId: candidate.scopeId, mode: candidate.mode };
      else return;
    }
    try { return { action: 'use', use: parseBotCredentialUse(value.use), ...(approval && { approval }) }; }
    catch { return; }
  }
  if (value.action === 'manage') return { action: 'manage' };
  if (value.action !== 'capture') return;
  try { return { action: 'capture', slot: parseBotCredentialSlot(value.slot) }; }
  catch { return; }
}

export function botCredentialNamespace(profile: string, projectId: string, entryId: string, projectPath: string, instanceId?: string, workdir?: string): string {
  return `bot-credentials:v1:${createHash('sha256').update(JSON.stringify([profile, projectId.toLowerCase(), entryId, projectPath, instanceId ?? null, workdir ?? null])).digest('hex')}:`;
}

export async function resolveBotCredentialNamespace(profile: string, scope: BotCredentialScope): Promise<string> {
  return botCredentialNamespace(profile, scope.projectId, scope.entryId, await realpath(scope.projectDirectory),
    scope.instanceId, scope.workdir && await realpath(scope.workdir));
}

/** Built-in Assistant code moves between immutable release directories. Its credential scope does not. */
export async function resolveBotCredentialNamespaces(profile: string, scope: BotCredentialScope): Promise<readonly [string, ...string[]]> {
  const [projectDirectory, workdir] = await Promise.all([realpath(scope.projectDirectory), scope.workdir && realpath(scope.workdir)]);
  const legacy = (directory: string, folder: string | undefined) => botCredentialNamespace(profile, scope.projectId, scope.entryId, directory, scope.instanceId, folder);
  const direct = legacy(projectDirectory, workdir);
  if (scope.projectId.toLowerCase() !== DEVELOPER_ASSISTANT_PROJECT_ID) return [direct];
  const profileDirectory = await realpath(profile).catch(() => path.resolve(profile));
  const roots = [path.join(profileDirectory, 'workflow', 'builtin-apps'), path.join(profileDirectory, 'workflow', 'assistant', 'apps')];
  const managed = (directory: string) => roots.some(root => /^[a-f0-9]{24}(?:[\\/]project)?$/.test(path.relative(root, directory)));
  if (!managed(projectDirectory)) return [direct];

  const releases = (await Promise.all(roots.map(async root => {
    if (await realpath(root).catch(() => undefined) !== root) return [];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name)).map(async entry => {
      const base = path.join(root, entry.name);
      for (const directory of [path.join(base, 'project'), base]) {
        try {
          if (await realpath(directory) !== directory) continue;
          const manifest: unknown = JSON.parse(await readFile(path.join(directory, 'steamharness.json'), 'utf8'));
          if (typeof manifest === 'object' && manifest !== null && 'id' in manifest && manifest.id === DEVELOPER_ASSISTANT_PROJECT_ID) {
            return { directory, time: (await stat(directory)).birthtimeMs };
          }
        } catch { /* Ignore incomplete or removed release directories. */ }
      }
    }))).flatMap(entry => entry ? [entry] : []);
  }))).flat().sort((a, b) => b.time - a.time || a.directory.localeCompare(b.directory)).map(entry => entry.directory);
  if (!releases.includes(projectDirectory)) return [direct];

  const standalone = !scope.instanceId && (!workdir || releases.includes(workdir));
  const primary = legacy('builtin:developer-assistant', standalone ? undefined : workdir);
  const previous = new Set([direct]);
  for (const release of releases) {
    if (standalone) {
      previous.add(legacy(release, release));
      previous.add(legacy(release, undefined));
      if (workdir) previous.add(legacy(release, workdir));
    } else previous.add(legacy(release, workdir));
  }
  return [primary, ...previous];
}

interface SecretStore {
  keys(): Thenable<string[]>;
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

type CredentialPrefixes = string | readonly [string, ...string[]];
const credentialPrefixes = (prefixes: CredentialPrefixes) => typeof prefixes === 'string' ? [prefixes] as const : prefixes;

export async function listBotCredentialSummaries(store: Pick<SecretStore, 'keys'>, prefixes: CredentialPrefixes, signal?: AbortSignal): Promise<BotCredentialSummary[]> {
  signal?.throwIfAborted();
  const keys = await store.keys();
  signal?.throwIfAborted();
  const allowed = credentialPrefixes(prefixes);
  const seen = new Set<string>();
  return keys.flatMap(key => {
    const prefix = allowed.find(prefix => key.startsWith(prefix));
    if (!prefix) return [];
    const suffix = key.slice(prefix.length), [kind, name, extra] = suffix.split(':');
    if (seen.has(suffix) || extra !== undefined || !validKind(kind) || !validBotCredentialName(name)) return [];
    seen.add(suffix);
    return [{ name, kind }];
  }).sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

export const MAX_BOT_CREDENTIAL_BYTES = 64 * 1024;
const invalidCredential = () => new Error('Invalid Bot credential.');
const oversizedCredential = () => Object.assign(new Error('Bot credential exceeds the storage limit.'), { code: 'BOT_CREDENTIAL_TOO_LARGE' });
const changedCredential = () => Object.assign(new Error('Bot credential changed during editing.'), { code: 'BOT_CREDENTIAL_CHANGED' });

const usableText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const fitsStorage = (value: string) => Buffer.byteLength(value, 'utf8') <= MAX_BOT_CREDENTIAL_BYTES;

export function structuredCredentialFields(slot: BotCredentialSlot): readonly string[] | undefined {
  return slot.kind === legacyPairKind ? legacyPairFields : slot.fields;
}

function readObject(value: string): Record<string, unknown> | undefined {
  if (!fitsStorage(value)) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Never surface JSON parser errors, which may quote the value. */ }
}

/** Report shape without samples, values, nested content, parser errors, or arbitrary property names. */
export function describeBotCredential(slot: BotCredentialSlot, value: string): BotCredentialStructure {
  const object = slot.kind === 'structured' || slot.kind === legacyPairKind ? readObject(value) : undefined;
  const entries = Object.entries(object ?? {});
  if (!entries.length) return { format: 'hidden' };
  const candidates = entries.filter(([name]) => isBotCredentialFieldName(name)).slice(0, BOT_CREDENTIAL_MAX_FIELDS);
  const names = new Set(candidates.map(([name]) => name));
  // Pasted JSON can nest very deeply. Compare only the bounded display names,
  // without recursion or retaining a second copy of every secret in the input.
  const pending: unknown[] = [object];
  while (pending.length && names.size) {
    const item = pending.pop();
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child);
    } else {
      const text = String(item).trim();
      if (text && text.length <= 64) for (const name of names) {
        if (name === text || text.length >= 4 && name.includes(text)) names.delete(name);
      }
    }
  }
  if (!names.size) return { format: 'hidden' };
  const fields = candidates.filter(([name]) => names.has(name)).map(([name, field]) => ({ name,
    type: (field === null ? 'null' : Array.isArray(field) ? 'array' : typeof field) as BotCredentialFieldType }));
  return { format: 'object', fields, ...(fields.length < entries.length && { partial: true }) };
}

export function parseStructuredCredential(value: string): Record<string, string> | undefined {
  const object = readObject(value);
  if (!object) return;
  const fields = Object.entries(object).filter((entry): entry is [string, string] => isBotCredentialFieldName(entry[0]) && usableText(entry[1]));
  return fields.length ? Object.fromEntries(fields) : undefined;
}

function isPrivateKeyText(value: string): boolean {
  return /^-----BEGIN ((?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY)-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----(?:\r?\n)?$/.test(value);
}

/** Only called with a native file-picker result. No path from the Bot reaches here. */
export async function readPickedSshKey(file: string): Promise<string> {
  const buffer = Buffer.alloc(MAX_BOT_CREDENTIAL_BYTES + 1);
  const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalidCredential();
    if (info.size > MAX_BOT_CREDENTIAL_BYTES) throw oversizedCredential();
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BOT_CREDENTIAL_BYTES) throw oversizedCredential();
    return buffer.toString('utf8', 0, length);
  } finally { buffer.fill(0); await handle.close(); }
}

export function createBotCredentialVault(store: SecretStore, profile: string, prefixes: CredentialPrefixes, canPersist: () => Promise<boolean>) {
  const scope = credentialPrefixes(prefixes);
  const revisionKey = randomBytes(32);
  const revisionOf = (value: string) => createHmac('sha256', revisionKey).update(value, 'utf16le').digest('hex');
  const keysFor = (input: BotCredentialSlot) => {
    if (!validBotCredentialName(input.name) || !validKind(input.kind)) throw invalidCredential();
    return scope.map(prefix => `${prefix}${input.kind}:${input.name}`);
  };
  const getSaved = async (slot: BotCredentialSlot, signal?: AbortSignal) => {
    const candidates = keysFor(slot);
    const available = candidates.length > 1 ? new Set(await store.keys()) : undefined;
    const key = available ? candidates.find(candidate => available.has(candidate)) : candidates[0];
    signal?.throwIfAborted();
    if (key === undefined) return;
    const value = await store.get(key);
    // Some secret stores return undefined for an unreadable record. An add
    // must not overwrite a listed alias just because its material is unavailable.
    if (value === undefined && (available || (await store.keys()).includes(key))) throw new Error('Cannot read the saved Bot credential.');
    return value;
  };
  const requireStorage = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!await canPersist()) throw new Error('Protected Bot credential storage is unavailable.');
    signal?.throwIfAborted();
  };
  const lock = async <T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    await mkdir(profile, { recursive: true });
    // The lock has no data or credential names. It fences add versus replace across Studio windows.
    const database = new DatabaseSync(path.join(profile, 'bot-credentials-lock.sqlite'));
    try {
      database.exec('PRAGMA busy_timeout=0');
      const deadline = performance.now() + 2_000;
      for (;;) {
        signal?.throwIfAborted();
        try { database.exec('BEGIN IMMEDIATE'); break; }
        catch (error) {
          const code = Number((error as { errcode?: number } | null)?.errcode) & 255;
          if ((code !== 5 && code !== 6) || performance.now() >= deadline) throw error;
          await wait(25, undefined, { signal });
        }
      }
      return await run();
    } finally { database.close(); }
  };
  const inspect = async (slot: BotCredentialSlot, signal?: AbortSignal) => {
    const available = new Set(await store.keys());
    signal?.throwIfAborted();
    return keysFor(slot).some(key => available.has(key)) ? 'existing' as const : 'missing' as const;
  };
  return {
    async inspect(slot: BotCredentialSlot, signal?: AbortSignal) { await requireStorage(signal); return inspect(slot, signal); },
    async snapshot(slot: BotCredentialSlot, signal?: AbortSignal) {
      await requireStorage(signal);
      const stored = await getSaved(slot, signal);
      await requireStorage(signal);
      return stored === undefined ? undefined : { revision: revisionOf(stored), structure: describeBotCredential(slot, stored) };
    },
    /** Only native, already authorized operations call this. No IPC exposes raw material. */
    async readForUse(slot: BotCredentialSlot, signal: AbortSignal) {
      await requireStorage(signal);
      const stored = await getSaved(slot, signal);
      await requireStorage(signal);
      if (stored === undefined) return;
      if (!fitsStorage(stored)) return null;
      if (slot.kind === 'structured' || slot.kind === legacyPairKind) return parseStructuredCredential(stored) ?? null;
      if (slot.kind === 'ssh-private-key') return isPrivateKeyText(stored) ? stored : null;
      return usableText(stored) ? stored : null;
    },
    async list(signal?: AbortSignal): Promise<BotCredentialSummary[]> {
      await requireStorage(signal);
      const rows = await listBotCredentialSummaries(store, prefixes, signal);
      await requireStorage(signal);
      return rows;
    },
    async write(slot: BotCredentialSlot, value: string, expectedRevision?: string, signal?: AbortSignal): Promise<BotCredentialCaptureReceipt> {
      if (!fitsStorage(value)) throw oversizedCredential();
      if (slot.kind === legacyPairKind && expectedRevision === undefined) throw invalidCredential();
      return lock(signal, async () => {
        await requireStorage(signal);
        const current = await getSaved(slot, signal);
        await requireStorage(signal);
        if (expectedRevision === undefined && current !== undefined) return { status: 'existing', structure: describeBotCredential(slot, current) };
        if (expectedRevision !== undefined && (current === undefined || revisionOf(current) !== expectedRevision)) throw changedCredential();
        const [primary, ...legacy] = keysFor(slot);
        await store.store(primary, value);
        if (expectedRevision !== undefined && legacy.length) {
          const available = new Set(await store.keys());
          for (const key of legacy) if (available.has(key)) await store.delete(key);
        }
        return { status: 'saved', structure: describeBotCredential(slot, value) };
      });
    },
    async remove(slot: BotCredentialSlot, signal?: AbortSignal, expectedRevision?: string) {
      await lock(signal, async () => {
        await requireStorage(signal);
        if (expectedRevision !== undefined) {
          const current = await getSaved(slot, signal);
          if (current === undefined || revisionOf(current) !== expectedRevision) throw changedCredential();
        }
        const available = new Set(await store.keys());
        await requireStorage(signal);
        for (const key of keysFor(slot)) if (available.has(key)) await store.delete(key);
      });
    },
  };
}
