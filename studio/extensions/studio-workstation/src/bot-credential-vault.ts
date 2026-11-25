import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { parseBotCredentialUse, type BotCredentialUse, type BotCredentialUseResult } from '../../../../harness/src/types/bot-credential-use';

export const botCredentialKinds = ['api-key', 'password', 'ssh-private-key', 'structured'] as const;
const legacyPairKind = 'access-key-pair';
const legacyPairFields = ['AccessKeyId', 'AccessKeySecret'] as const;
export type BotCredentialKind = typeof botCredentialKinds[number] | typeof legacyPairKind;
export type BotCredentialSummary = { name: string; kind: BotCredentialKind };
export type BotCredentialSlot = BotCredentialSummary & { fields?: readonly string[] };
export interface BotCredentialScope { projectId: string; entryId: string; projectDirectory: string; instanceId?: string; workdir?: string }
type BotCredentialApproval = { scopeId: string; mode: 'prompt' | 'reuse' } | { mode: 'auto' };
export type BotCredentialAction = { action: 'capture'; slot: BotCredentialSlot } | { action: 'manage' }
  | { action: 'use'; use: BotCredentialUse; approval?: BotCredentialApproval };
export type BotCredentialResult = 'saved' | 'existing' | 'declined' | 'managed' | 'busy' | 'unavailable' | 'approval-required' | BotCredentialUseResult;
export const validBotCredentialName = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const validKind = (value: unknown): value is BotCredentialKind => value === legacyPairKind || botCredentialKinds.some(kind => kind === value);
const MAX_FIELDS = 16;
// Match Core's credential descriptor, validating again at the native boundary.
const fieldPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const reservedFields = new Set(['__proto__', 'constructor', 'prototype']);
const validField = (field: unknown): field is string => typeof field === 'string' && fieldPattern.test(field) && !reservedFields.has(field);
const validFields = (fields: unknown): fields is readonly string[] => Array.isArray(fields) && fields.length > 0 && fields.length <= MAX_FIELDS
  && new Set(fields).size === fields.length && [...fields].every(validField);

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
  const slot = value.slot as Partial<BotCredentialSlot> | undefined;
  if (value.action !== 'capture' || !slot || typeof slot !== 'object' || Array.isArray(slot) || Object.keys(slot).some(key => !['name', 'kind', 'fields'].includes(key))
    || !validBotCredentialName(slot.name) || !validKind(slot.kind) || slot.kind === legacyPairKind) return;
  if (slot.fields === undefined) return { action: 'capture', slot: { name: slot.name, kind: slot.kind } };
  if (slot.kind !== 'structured' || !validFields(slot.fields)) return;
  return { action: 'capture', slot: { name: slot.name, kind: slot.kind, fields: [...slot.fields] } };
}

export function botCredentialNamespace(profile: string, projectId: string, entryId: string, projectPath: string, instanceId?: string, workdir?: string): string {
  return `bot-credentials:v1:${createHash('sha256').update(JSON.stringify([profile, projectId.toLowerCase(), entryId, projectPath, instanceId ?? null, workdir ?? null])).digest('hex')}:`;
}

export async function resolveBotCredentialNamespace(profile: string, scope: BotCredentialScope): Promise<string> {
  return botCredentialNamespace(profile, scope.projectId, scope.entryId, await realpath(scope.projectDirectory),
    scope.instanceId, scope.workdir && await realpath(scope.workdir));
}

interface SecretStore {
  keys(): Thenable<string[]>;
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export async function listBotCredentialSummaries(store: Pick<SecretStore, 'keys'>, prefix: string, signal?: AbortSignal): Promise<BotCredentialSummary[]> {
  signal?.throwIfAborted();
  const keys = await store.keys();
  signal?.throwIfAborted();
  return keys.flatMap(key => {
    if (!key.startsWith(prefix)) return [];
    const [kind, name, extra] = key.slice(prefix.length).split(':');
    return extra === undefined && validKind(kind) && validBotCredentialName(name) ? [{ name, kind }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

const MAX_SECRET_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const invalidCredential = () => new Error('Invalid Bot credential.');

export function validBotCredentialText(value: string): boolean {
  return !!value.trim() && !/[\0\r\n]/.test(value) && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

export function structuredCredentialFields(slot: BotCredentialSlot): readonly string[] | undefined {
  return slot.kind === legacyPairKind ? legacyPairFields : slot.fields;
}

export function parseStructuredCredential(value: string, fields?: readonly string[]): Record<string, string> | undefined {
  if (!validBotCredentialText(value)) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const keys = Object.keys(parsed);
    if (!validFields(keys) || fields && (keys.length !== fields.length || !fields.every(key => Object.hasOwn(parsed, key)))) return;
    if (Object.values(parsed).every(text => typeof text === 'string' && validBotCredentialText(text))) return parsed as Record<string, string>;
  } catch { /* Never surface JSON parser errors, which may quote the value. */ }
}

function isPrivateKeyText(value: string): boolean {
  return /^-----BEGIN ((?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY)-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----(?:\r?\n)?$/.test(value);
}

/** Only called with a native file-picker result. No path from the Bot reaches here. */
export async function readPickedSshKey(file: string): Promise<string> {
  const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
  const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_SECRET_BYTES) throw invalidCredential();
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const value = buffer.toString('utf8', 0, length);
    if (length > MAX_SECRET_BYTES || !isPrivateKeyText(value)) throw invalidCredential();
    return value;
  } finally { buffer.fill(0); await handle.close(); }
}

export function createBotCredentialVault(store: SecretStore, profile: string, prefix: string, canPersist: () => Promise<boolean>) {
  const keyFor = (input: BotCredentialSlot) => {
    if (!validBotCredentialName(input.name) || !validKind(input.kind) ||
      input.fields !== undefined && (input.kind !== 'structured' || !validFields(input.fields))) throw invalidCredential();
    return `${prefix}${input.kind}:${input.name}`;
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
    const key = keyFor(slot);
    if (!(await store.keys()).includes(key)) return 'missing' as const;
    if (slot.kind === 'structured' && slot.fields) {
      const stored = await store.get(key);
      signal?.throwIfAborted();
      if (!stored || !parseStructuredCredential(stored, slot.fields)) return 'different-fields' as const;
    }
    return 'existing' as const;
  };
  return {
    async inspect(slot: BotCredentialSlot, signal?: AbortSignal) { await requireStorage(signal); return inspect(slot, signal); },
    /** Native connector input after confirmation. There is no pipe action for reading a value. */
    async readStructured(name: string, signal: AbortSignal, allowLegacyPair = false) {
      await requireStorage(signal);
      const stored = await store.get(keyFor({ name, kind: 'structured' }));
      signal.throwIfAborted();
      if (stored !== undefined) return parseStructuredCredential(stored) ?? null;
      if (!allowLegacyPair) return;
      const legacy = await store.get(keyFor({ name, kind: legacyPairKind }));
      signal.throwIfAborted();
      return legacy === undefined ? undefined : parseStructuredCredential(legacy, legacyPairFields) ?? null;
    },
    async list(signal?: AbortSignal): Promise<BotCredentialSummary[]> {
      await requireStorage(signal);
      return listBotCredentialSummaries(store, prefix, signal);
    },
    async write(slot: BotCredentialSlot, value: string, replace: boolean, signal?: AbortSignal) {
      if (slot.kind === 'structured' || slot.kind === legacyPairKind) {
        if (slot.kind === legacyPairKind && !replace) throw invalidCredential();
        const record = parseStructuredCredential(value, structuredCredentialFields(slot));
        if (!record) throw invalidCredential();
        value = JSON.stringify(record);
      } else if (slot.kind === 'ssh-private-key' ? Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES || !isPrivateKeyText(value) : !validBotCredentialText(value)) throw invalidCredential();
      return lock(signal, async () => {
        await requireStorage(signal);
        const present = await inspect(slot, signal);
        signal?.throwIfAborted();
        if (present !== 'missing' && !replace) return present;
        if (present === 'missing' && replace) throw new Error('The Bot credential no longer exists.');
        await store.store(keyFor(slot), value);
        return 'saved' as const;
      });
    },
    async remove(slot: BotCredentialSlot, signal?: AbortSignal) {
      await lock(signal, async () => { await requireStorage(signal); await store.delete(keyFor(slot)); });
    },
  };
}
