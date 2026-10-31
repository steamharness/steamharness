import { createHash } from 'node:crypto';
import type { ObjectStorage } from './object-storage';
import { HttpError } from './protocol';

export const DATABASE_ATTACHMENT_CHUNK_SIZE = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export interface AttachmentValue { file: { id: string; spaceId: string; storage: string; size: number; mimeType: string; [key: string]: unknown }; base64?: string; blob?: { sha256: string } }

/** Binary objects stay private; a database value only records metadata and a digest. */
export class DatabaseAttachments {
  constructor(private readonly storage: ObjectStorage) {}

  private validate(spaceId: string, key: string, value: AttachmentValue): void {
    if (!value?.file || value.file.id !== key.slice('__knowledge_file:'.length)
      || value.file.spaceId !== spaceId || value.file.storage !== 'database'
      || !Number.isSafeInteger(value.file.size) || value.file.size < 0 || value.file.size > MAX_ATTACHMENT_BYTES
      || !/^[a-f0-9-]{36}$/.test(value.file.id)) {
      throw new HttpError(400, 400, 'Invalid database attachment.');
    }
  }
  private objectPath(spaceId: string, value: AttachmentValue): string {
    if (!/^[a-f0-9]{64}$/.test(value.blob?.sha256 ?? '')) throw new HttpError(400, 400, 'Invalid database attachment digest.');
    return `database-spaces/${spaceId}/attachments/${value.file.id}/${value.blob!.sha256}`;
  }
  async store(spaceId: string, key: string, value: AttachmentValue): Promise<AttachmentValue> {
    this.validate(spaceId, key, value);
    if (typeof value.base64 !== 'string' || value.base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
      throw new HttpError(400, 400, 'Invalid database attachment content.');
    }
    const buffer = Buffer.from(value.base64, 'base64');
    if (buffer.length !== value.file.size) throw new HttpError(400, 400, 'Database attachment size does not match its content.');
    const stored = { file: value.file, blob: { sha256: createHash('sha256').update(buffer).digest('hex') } };
    await this.storage.uploadPrivateBuffer(this.objectPath(spaceId, stored), buffer, value.file.mimeType);
    return stored;
  }
  async read(spaceId: string, key: string, value: AttachmentValue): Promise<string> {
    this.validate(spaceId, key, value);
    const buffer = await this.storage.downloadPrivateBuffer(this.objectPath(spaceId, value));
    if (buffer.length !== value.file.size || createHash('sha256').update(buffer).digest('hex') !== value.blob!.sha256) {
      throw new HttpError(500, 500, 'Database attachment content is damaged.');
    }
    return buffer.toString('base64');
  }
}

export function isDatabaseAttachment(entry?: { storageKind?: unknown; key?: unknown } | null): boolean {
  return entry?.storageKind === 'persistent_value' && typeof entry.key === 'string' && /^__knowledge_file:[a-f0-9-]{36}$/.test(entry.key);
}
