import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const botCredentialKinds = ['api-key', 'password', 'ssh-private-key'] as const;
export type BotCredentialKind = typeof botCredentialKinds[number];
export type BotCredentialSlot = { name: string; kind: BotCredentialKind };
export type BotCredentialAction = { action: 'capture'; slot: BotCredentialSlot } | { action: 'manage' };
export type BotCredentialResult = 'saved' | 'existing' | 'declined' | 'managed' | 'busy' | 'unavailable';
export const validBotCredentialName = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const validKind = (value: unknown): value is BotCredentialKind => botCredentialKinds.some(kind => kind === value);

export function parseBotCredentialAction(value: Record<string, unknown>): BotCredentialAction | undefined {
  if (Object.keys(value).some(key => !['type', 'id', 'entryId', 'action', 'slot'].includes(key))) return;
  if (value.action === 'manage' && value.slot === undefined) return { action: 'manage' };
  const slot = value.slot as Partial<BotCredentialSlot> | undefined;
  if (value.action !== 'capture' || !slot || typeof slot !== 'object' || Object.keys(slot).some(key => key !== 'name' && key !== 'kind') || !validBotCredentialName(slot.name) || !validKind(slot.kind)) return;
  return { action: 'capture', slot: { name: slot.name, kind: slot.kind } };
}

export function botCredentialNamespace(profile: string, projectId: string, entryId: string, projectPath: string, instanceId?: string, workdir?: string): string {
  return `bot-credentials:v1:${createHash('sha256').update(JSON.stringify([profile, projectId.toLowerCase(), entryId, projectPath, instanceId ?? null, workdir ?? null])).digest('hex')}:`;
}

interface SecretStore {
  keys(): Thenable<string[]>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const MAX_SECRET_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const invalidCredential = () => new Error('Invalid Bot credential.');

export function validBotCredentialText(value: string): boolean {
  return !!value.trim() && !/[\0\r\n]/.test(value) && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
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
    if (!validBotCredentialName(input.name) || !validKind(input.kind)) throw invalidCredential();
    return `${prefix}${input.kind}:${input.name}`;
  };
  const requireStorage = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!await canPersist()) throw new Error('Protected Bot credential storage is unavailable.');
    signal?.throwIfAborted();
  };
  const lock = async <T>(run: () => Promise<T>): Promise<T> => {
    await mkdir(profile, { recursive: true });
    // The lock has no data or credential names. It fences add versus replace across Studio windows.
    const database = new DatabaseSync(path.join(profile, 'bot-credentials-lock.sqlite'));
    try { database.exec('BEGIN IMMEDIATE'); return await run(); }
    finally { database.close(); }
  };
  const exists = async (slot: BotCredentialSlot) => (await store.keys()).includes(keyFor(slot));
  return {
    async exists(slot: BotCredentialSlot, signal?: AbortSignal) { await requireStorage(signal); return exists(slot); },
    async list(signal?: AbortSignal): Promise<BotCredentialSlot[]> {
      await requireStorage(signal);
      return (await store.keys()).flatMap(key => {
        if (!key.startsWith(prefix)) return [];
        const [kind, name, extra] = key.slice(prefix.length).split(':');
        return extra === undefined && validKind(kind) && validBotCredentialName(name) ? [{ name, kind }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
    },
    async write(slot: BotCredentialSlot, value: string, replace: boolean, signal?: AbortSignal) {
      if (slot.kind === 'ssh-private-key' ? Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES || !isPrivateKeyText(value) : !validBotCredentialText(value)) throw invalidCredential();
      return lock(async () => {
        await requireStorage(signal);
        const present = await exists(slot);
        signal?.throwIfAborted();
        if (present && !replace) return 'existing' as const;
        if (!present && replace) throw new Error('The Bot credential no longer exists.');
        await store.store(keyFor(slot), value);
        return 'saved' as const;
      });
    },
    async remove(slot: BotCredentialSlot, signal?: AbortSignal) {
      await lock(async () => { await requireStorage(signal); await store.delete(keyFor(slot)); });
    },
  };
}
